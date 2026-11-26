#!/usr/bin/env node
// 2026-10-31 (第 180 批): 把 `test:chain` 从「&& 短路」改成「跑完所有段再汇总」
//
// ## 起因 —— 这条链以前会在第一个失败处**静默截断**
//
// 2026-10-31 实跑: `npm run test:chain` 报 EXIT=1, 失败的是
// `workbench-original-ui-20261027` 的 116-1 / 116-2。我当时汇报「只有两个 fail, 其余全绿」。
// —— **那句话是错的**。
//
// 链是 `node --test A && node --test B && ...` 串起来的, `&&` 的语义是
// 「前一段非零就停」。`workbench-original-ui` 在**第 301 段**, 它一挂,
// **后面 27 段 (328 段里的最后 27 个测试文件) 根本没跑**。
//
// 为什么没人发现:
//   - 每批都只报「EXIT=1 / not ok=2」, 看不出后面还有多少段没执行;
//   - 「not ok 计数」天然只统计**跑过**的段, 少跑的段不会报「没跑」;
//   - 而「跑过 301/328 段」这个事实, 没人去看。
// ⇒ **测试覆盖看起来是全的, 实际上是缺的**。这跟 §12.3「修一层 ≠ 修好了」同形:
//   表面上「链绿了」, 实际上一大批断言从没执行。
//
// ## 改法
//
// 段落表仍在 `package.json` 的 `scripts['test:chain:segments']` (单一真源, 不抄第二遍),
// 本脚本只负责**逐段执行 + 汇总**:
//   - 每段都跑, 前一段失败**不拦**后面;
//   - 每段打印 一行 结果 (段号 / 段落 / pass / fail / 退出码);
//   - 结尾打印失败清单, 有失败就 exit 1。
//
// 「失败就停」在 CI 里也有价值, 所以留了个开关:
//   `CHAIN_FAIL_FAST=1 npm run test:chain` ⇒ 遇到第一个失败立刻停(旧行为)。
//
// ## 环境隔离
//
// 原链是 `PANGU_SESSIONS_DIR=/tmp/pangu-test-runtime-$$/... sh -c '...'`。
// `$$` 是**外层 shell** 的 pid —— 整条链共用一个隔离目录。
// 本脚本逐段执行, 若每段各自 `sh -c`, `$$` 会变成**每段各自的 pid** ⇒ 目录不共享,
// 测试之间互相看不见, 反而更脏。
// ⇒ 环境变量里的 `$$` 统一替换成本脚本的 pid, 由本脚本**固定一个 pid** 传下去,
//   整链共用一个隔离目录, 跟原行为一致。

import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';

const CORE = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pkg = JSON.parse(fs.readFileSync(path.join(CORE, 'package.json'), 'utf8'));
const RAW_SEGMENTS = (pkg.scripts['test:chain:segments'] || '').split('&&');
const SEGMENTS = RAW_SEGMENTS.map((s) => s.trim()).filter(Boolean);
const ENV_RAW = pkg.scripts['test:chain:env'] || '';
const FAIL_FAST = process.env.CHAIN_FAIL_FAST === '1';
const CHAIN_PID = process.pid;

if (!SEGMENTS.length) {
  console.error('test-chain: package.json 的 scripts["test:chain:segments"] 是空的');
  process.exit(1);
}
// ⚠ 空段必须**报错**, 不许静默跳过 ——
//   删重复项时手滑留个空 `&&` (第 134 批真踩过), 静默跳过 = 少跑一段,
//   而「少跑」在报告里看不出任何区别。
if (SEGMENTS.length !== RAW_SEGMENTS.filter((s) => s.trim()).length
  || RAW_SEGMENTS.some((s) => !s.trim())) {
  console.error('test-chain: 段落表里有**空段**(某处留了个空的 && ) —— 报错, 不许静默跳过。');
  console.error(RAW_SEGMENTS.map((s, i) => `${i + 1}: ${JSON.stringify(s)}`).join('\n'));
  process.exit(1);
}

// 环境变量里的 $$ 要在这里展开(外层 shell 不会帮我们展开,
// 因为整条链现在是 node 起的, 不是 sh 起的)。
const ENV = {};
for (const part of ENV_RAW.split(/\s+/).filter(Boolean)) {
  const i = part.indexOf('=');
  if (i < 0) continue;
  ENV[part.slice(0, i)] = part.slice(i + 1)
    .replace(/\$\{CHAIN_PID\}/g, String(CHAIN_PID))
    .replace(/\$\$/g, String(CHAIN_PID));
}

const LOG = path.join(os.tmpdir(), `pangu-chain-${CHAIN_PID}.log`);
const logStream = fs.createWriteStream(LOG);

function parseCounts(out) {
  const pass = [...out.matchAll(/^# pass (\d+)/gm)].map((m) => Number(m[1]));
  const fail = [...out.matchAll(/^# fail (\d+)/gm)].map((m) => Number(m[1]));
  return {
    pass: pass.length ? pass[pass.length - 1] : null,
    fail: fail.length ? fail[fail.length - 1] : null,
  };
}

function run(seg) {
  return new Promise((resolve) => {
    const child = spawn('sh', ['-c', seg], {
      cwd: CORE,
      env: { ...process.env, ...ENV },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { out += d; });
    child.on('close', (code) => resolve({ code, out }));
    child.on('error', (e) => resolve({ code: 127, out: String(e) }));
  });
}

const failures = [];
const started = Date.now();
console.log(`── test-chain: ${SEGMENTS.length} 段, fail-fast=${FAIL_FAST ? 'on' : 'off'} ──`);

for (let i = 0; i < SEGMENTS.length; i++) {
  const seg = SEGMENTS[i];
  const { code, out } = await run(seg);
  logStream.write(`\n===== [${i + 1}/${SEGMENTS.length}] ${seg} (exit=${code}) =====\n${out}\n`);
  const { pass, fail } = parseCounts(out);
  const label = seg.replace(/^node --test /, '').replace(/^node /, '');
  const stat = code === 0 ? '✓' : '✗';
  console.log(
    `${stat} [${String(i + 1).padStart(3)}/${SEGMENTS.length}] ${label}`
    + `  pass=${pass ?? '-'} fail=${fail ?? '-'}`);
  if (code !== 0) {
    failures.push({ seg, code, out });
    if (FAIL_FAST) {
      console.log(`\n✗ fail-fast: 第 ${i + 1} 段失败, 停。后面 ${SEGMENTS.length - i - 1} 段**没跑**。`);
      break;
    }
  }
}

logStream.end();
const secs = ((Date.now() - started) / 1000).toFixed(1);

if (failures.length) {
  console.log(`\n── 失败 ${failures.length} 段 ──`);
  for (const f of failures) {
    console.log(`  ✗ ${f.seg.replace(/^node --test /, '').replace(/^node /, '')}  (exit=${f.code})`);
    const tail = f.out.split('\n').filter((l) => /^not ok/.test(l) || /Error|error:/.test(l)).slice(0, 6);
    for (const l of tail) console.log(`      ${l}`);
  }
  console.log(`\n完整日志: ${LOG}`);
  console.log(`链跑了 ${SEGMENTS.length - failures.length + failures.length}/${SEGMENTS.length} 段(失败段也跑了), 用时 ${secs}s`);
  process.exit(1);
}

console.log(`\n✅ ${SEGMENTS.length} 段全绿, 用时 ${secs}s  (日志: ${LOG})`);
process.exit(0);

