'use strict';
/**
 * 第 71 批变异体检 —— 验「tests/local-model-20261023.test.js」的判据真能咬住。
 *
 * ## 铁律: 打空枪的变异比没有变异更坏
 *
 * 它给你「验过了」的假安全感。所以本 harness 的判据是:
 *   **每个变异都必须让目标测试 FAIL。跑完还是 PASS = 空枪 = 本批判据无效, 必须重做。**
 *   空枪不计入成功数, 单独报出来, 退出码非 0。
 *
 * ## 变异从哪来
 *
 * 照着本批**真实可能发生的错**编的 —— 其中 M1 / M2 / M6 **真的发生过**(本批实现时):
 *   · M1: 真源的 provider 名单里把 'custom' 加回去 ⇒ 云端自建端点又被判成本地
 *   · M2: 回环判定退回只认 127.0.0.1 ⇒ 127/8 其余地址漏判(收口前的旧口径)
 *   · M6: 共享层不引用真源, 自己抄一份 ⇒ 两处又算出两个答案(收口前的真状态)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.join(__dirname, '..', '..');
const F = (rel) => path.join(CORE, rel);

const LM = F('modules/local_model.js');
const SHARED = F('modules/j2_loop_shared.js');
const MT = F('modules/model_transport.js');
const MC = F('modules/router/model_cost.js');
const AKR = F('modules/api_key_resolver.js');
const LC = F('modules/llm_caller.js');

const TESTS = [
  path.join('tests', 'local-model-20261023.test.js'),
];

function runTest() {
  for (const t of TESTS) {
    try {
      execFileSync('node', ['--test', t], { cwd: CORE, stdio: 'pipe', timeout: 120000 });
    } catch (e) {
      return { pass: false, out: String(e.stdout || '') + String(e.stderr || '') };
    }
  }
  return { pass: true };
}

function syntaxOk(files) {
  for (const f of files) {
    try {
      execFileSync('node', ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      return {
        ok: false,
        detail: String(e.stderr || e.stdout || e.message).split('\n').slice(0, 3).join(' '),
      };
    }
  }
  return { ok: true };
}

function rep(src, find, to) {
  const re = find instanceof RegExp ? find : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 's');
  const hits = src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  const n = hits ? hits.length : 0;
  if (n !== 1) {
    throw new Error(`锚点命中 ${n} 次 (要 1 次): ${String(find).slice(0, 70)}`);
  }
  return src.replace(re, to);
}

const MUTANTS = [
  {
    name: 'M1 真源: provider 名单加回 custom ⇒ 云端自建端点又被判成本地 (本批真踩过)',
    files: [[LM, (s) => rep(s,
      "  'vllm', 'mlx', 'mlx-serve', 'omlx',\n]);",
      "  'vllm', 'mlx', 'mlx-serve', 'omlx', 'custom',\n]);")]],
  },
  {
    name: 'M2 真源: 回环判定退回只认 127.0.0.1 ⇒ 127/8 其余地址漏判 (本批真踩过)',
    files: [[LM, (s) => rep(s,
      "  return /^127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/.test(host);",
      "  return host === '127.0.0.1';")]],
  },
  {
    name: 'M3 真源: 回环判定漏掉 IPv6 ::1',
    files: [[LM, (s) => rep(s,
      "  if (host === '::1' || host === '0.0.0.0' || host === 'localhost') return true;",
      "  if (host === '0.0.0.0' || host === 'localhost') return true;")]],
  },
  {
    name: 'M4 真源: 内网判定漏掉 192.168 段',
    files: [[LM, (s) => rep(s,
      "  if (/^192\\.168\\.\\d{1,3}\\.\\d{1,3}$/.test(host)) return true;\n",
      "")]],
  },
  {
    name: 'M5 真源: 内网判定 172 段写成只认 16-19 ⇒ 172.20~29 漏判',
    files: [[LM, (s) => rep(s,
      "  if (/^172\\.(?:1[6-9]|2\\d|3[01])\\.\\d{1,3}\\.\\d{1,3}$/.test(host)) return true;",
      "  if (/^172\\.1[6-9]\\.\\d{1,3}\\.\\d{1,3}$/.test(host)) return true;")]],
  },
  {
    name: 'M6 共享层: 不引用真源, 自己抄一份(带 custom) ⇒ 两处又算出两个答案 (本批真踩过)',
    files: [[SHARED, (s) => rep(s,
      "  try { return require('./local_model').isLocalModel(model); } catch (_) { return false; }",
      "  if (!model) return false;\n"
      + "  if (['lmstudio', 'ollama', 'llamacpp', 'vllm', 'custom'].includes(String(model.provider || '').toLowerCase())) return true;\n"
      + "  const ep = String(model.endpoint || model.api_base || model.base_url || '');\n"
      + "  return /^https?:\\/\\/(127\\.0\\.0\\.1|localhost|0\\.0\\.0\\.0|\\[?::1\\]?)/.test(ep);")]],
  },
  {
    name: 'M7 传输层: 用了真源的 isLocalModel(不含内网) ⇒ 内网端点被判云端',
    files: [[MT, (s) => rep(s,
      "require('./local_model').isLocalOrPrivateModel(model)",
      "require('./local_model').isLocalModel(model)")]],
  },
  {
    name: 'M8 免 key 判定: 改成真源的 isLocalEndpoint(含内网) ⇒ 口径被顺手放宽',
    files: [[AKR, (s) => rep(s,
      "require('./local_model').isLoopbackEndpoint(url)",
      "require('./local_model').isLocalEndpoint(url)")]],
  },
  {
    name: 'M9 计费判定: 用了真源的 isLocalModel(不含内网) ⇒ 内网 ollama 被按云端计价',
    files: [[MC, (s) => rep(s,
      "require('../local_model').isLocalOrPrivateModel(m)",
      "require('../local_model').isLocalModel(m)")]],
  },
  {
    name: 'M10 真源: 回环判定改用子串匹配 ⇒ 127.0.0.1.evil.com 被误判本地',
    files: [[LM, (s) => rep(s,
      "  return /^127\\.\\d{1,3}\\.\\d{1,3}\\.\\d{1,3}$/.test(host);",
      "  return host.includes('127.0.0.1');")]],
  },
  {
    name: 'M11 真源: 反过来 require 传输层 ⇒ 循环依赖',
    files: [[LM, (s) => rep(s,
      "function endpointOf(model) {",
      "function endpointOf(model) {\n  require('./model_transport');")]],
  },
  {
    name: 'M12 共享层: 导出的名单手抄一份 ⇒ 跟真源分家',
    files: [[SHARED, (s) => rep(s,
      "const _LOCAL_PROVIDERS = Array.from(require('./local_model').LOCAL_PROVIDERS);",
      "const _LOCAL_PROVIDERS = ['lmstudio', 'ollama', 'llamacpp', 'vllm', 'custom'];")]],
  },
  {
    name: 'M13 模型调用层: 不引用真源, 自己抄一份名单',
    files: [[LC, (s) => rep(s,
      "  try { return require('./local_model').isLocalModel(useModel); } catch (_) { return false; }",
      "  const provider = String(useModel && useModel.provider || '').toLowerCase();\n"
      + "  if (['lmstudio', 'ollama', 'vllm', 'llamacpp'].includes(provider)) return true;\n"
      + "  const endpoint = String(useModel && (useModel.endpoint || useModel.api_base) || '');\n"
      + "  if (!endpoint) return false;\n"
      + "  try { return require('./api_key_resolver').isLocalEndpoint(endpoint); } catch (_) { return false; }")]],
  },
  {
    name: 'M14 真源: 端点只认 endpoint 不认 api_base ⇒ 池子里那种写法漏判',
    files: [[LM, (s) => rep(s,
      "  return String(model.endpoint || model.api_base || model.base_url || '').trim();",
      "  return String(model.endpoint || model.base_url || '').trim();")]],
  },
];

const BACKUP = new Map();
function snapshot(files) {
  for (const f of files) BACKUP.set(f, fs.readFileSync(f, 'utf8'));
}
function restore() {
  for (const [f, s] of BACKUP) fs.writeFileSync(f, s);
  BACKUP.clear();
}

let killed = 0;
const empty = [];
const crashed = [];

console.log(`第 71 批变异体检: ${MUTANTS.length} 发, 目标测试 ${TESTS.join(', ')}\n`);

for (const mut of MUTANTS) {
  snapshot(mut.files.map((x) => x[0]));
  try {
    for (const [file, fn] of mut.files) {
      const src = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, fn(src));
    }
    const syn = syntaxOk(mut.files.map((x) => x[0]).filter((f) => f.endsWith('.js')));
    if (!syn.ok) {
      crashed.push(mut.name + ' :: 语法坏了: ' + syn.detail);
      console.log(`✘ 语法坏  ${mut.name}`);
      restore();
      continue;
    }
    const r = runTest();
    if (!r.pass) {
      killed++;
      console.log(`✔ 咬住    ${mut.name}`);
    } else {
      empty.push(mut.name);
      console.log(`✘ 空枪!!  ${mut.name}   ← 判据没咬住, 必须重做`);
    }
  } catch (e) {
    crashed.push(mut.name + ' :: ' + String(e.message).slice(0, 80));
    console.log(`✘ 变异器错 ${mut.name} :: ${String(e.message).slice(0, 80)}`);
  }
  restore();
}

console.log(`\n变异 ${MUTANTS.length} 发: 咬住 ${killed}, 空枪 ${empty.length}, 变异器错 ${crashed.length}`);
if (empty.length) {
  console.log('\n空枪清单(每一条都说明判据有洞):');
  empty.forEach((n) => console.log('  · ' + n));
}
if (crashed.length) {
  console.log('\n变异器错清单:');
  crashed.forEach((n) => console.log('  · ' + n));
}
process.exit(empty.length || crashed.length ? 1 : 0);
