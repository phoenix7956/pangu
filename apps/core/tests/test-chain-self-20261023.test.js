'use strict';
/**
 * `test:chain` 这条链自己的一条判据。
 *
 * ## 起因: 「整链 N 段」这个数一直报错, 而且没人发现
 *
 * 第 59–62 批的记录里一路写着「整链 233 → 234 → 235 段」。
 * 实数 `package.json` 的 `scripts['test:chain']`:
 *
 * | commit | 链里 `node --test` 条目数 |
 * |---|---|
 * | 508902c (第 59 批) | 215 |
 * | ca6be94 (第 60 批) | 216 |
 * | b277c1b (第 61 批) | 217 |
 * | e0f7dc3 (第 62 批) | 218 |
 *
 * **从没到过 235。** 差的 17 段从哪来没查出来, 但机制查清了:
 * 链里 `tests/wuxing-he-wiring-20261021.test.js` **出现了两次**
 * (第 178、179 个位置, 紧挨着 —— 某批挂链时手滑加了第二遍)。
 *
 * 为什么没人发现: 每批都只报「EXIT=0 / not ok=0」, 那个是对的;
 * 段数是**手写的数字**, 没人拿它跟 `package.json` 对过账。
 *
 * 这就是本项目的铁律「数字从表算不手写」的又一个实例 ——
 * 上次栽在词表覆盖率上, 这次栽在链长上。
 *
 * ## 本文件锁三件事
 *
 * ① 链里不许有重复条目 (重复 ⇒ 同一个文件跑两遍, 白花时间且掩盖真实段数)
 * ② 链里不许引用不存在的文件 (拼错路径时 npm 只报一段红, 容易当噪声放过)
 * ③ 新增测试文件必须挂进链 —— 否则「写了测试」和「CI 会跑它是两回事」
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const pkg = require(path.join(CORE, 'package.json'));
//
// 2026-10-31 (第 180 批): 段落表搬到了 `scripts['test:chain:segments']`,
//   `scripts['test:chain']` 改成跑 scripts/test-chain.mjs (逐段跑完再汇总)。
//   为什么搬 —— 原来的 `&&` 链在**第一个失败处就停**:
//   2026-10-31 实跑里 workbench-original-ui (第 301 段) 一挂,
//   后面 **27 段 (328 段里的最后 27 个测试文件) 根本没跑**, 而报告里看不出来。
//   ⇒ 「全量绿」的结论是假的。这条链自己必须先把这个坑堵上。
const chain = require('./helpers/chain_cmd').chainCommand();
const entries = (chain.match(/node --test ([^\s&|]+)/g) || [])
  .map((s) => s.replace(/^node --test /, ''))
  // 2026-10-28 (第 134 批): 链被包进 `sh -c '...'` 做生产隔离 (测试不许写生产盘),
  //   收尾那个单引号会被正则吃进最后一个文件名 ⇒ 守卫误报「引用了不存在的文件」。
  //   ⇒ 解析时剥掉 shell 引号 —— 守卫的**意图**(每个被引用的测试文件都存在)
  //   不该被链的**包装格式**影响。
  .map((s) => s.replace(/^['"]|['"]$/g, ''))
  .filter(Boolean);

test('test:chain 入口必须走逐段汇总的 runner (不许再回到 && 短路)', () => {
  assert.ok(/test-chain\.mjs/.test(pkg.scripts['test:chain'] || ''),
    'scripts["test:chain"] 应该是 "node scripts/test-chain.mjs" —— '
    + '直接用 && 串会在第一个失败处静默截断, 后面几十个测试文件不跑, 报告上看不出来。');
  assert.ok(fs.existsSync(path.join(CORE, 'scripts', 'test-chain.mjs')), 'runner 文件不存在');
  assert.ok(chain.length > 0, '段落表 scripts["test:chain:segments"] 不能为空');
  // 段落表里不许有空段 —— runner 会因此报错(静默跳过 = 少跑一段, 报告上看不出来)
  const segs = chain.split('&&').map((s) => s.trim());
  assert.ok(!segs.some((s) => !s), '段落表里有空段(留了个空的 && )');
});

test('链里每条路径只出现一次 (重复会让真实段数对不上)', () => {
  const seen = new Map();
  for (const e of entries) seen.set(e, (seen.get(e) || 0) + 1);
  const dup = [...seen].filter(([, n]) => n > 1).map(([e, n]) => `${e} × ${n}`);
  assert.strictEqual(dup.length, 0,
    'test:chain 里有重复条目:\n  ' + dup.join('\n  ')
    + '\n  —— 同一个文件跑两遍, 白花时间, 而且报段数时会对不上。');
});

test('链里不许有空的 && (删重复项时留下的哑弹, 会让整条链语法报错、一段都不跑)', () => {
  // 2026-10-23 本批真踩: 删 `... && node --test X && node --test X && node --test Y`
  // 里那个重复的 X 时, 顺手把两条 `&&` 之间删空了, 链尾变成 `X &&  && Y` ——
  // `sh: syntax error near unexpected token '&&'`, 整条链**一段都没跑**。
  //
  // 为什么上面两条没抓到: 空 && 不产生重复条目, 也不引用不存在的文件 ——
  // 它是 shell 语法层的问题, 只有链自己能跑起来才暴露。
  // 而一旦它炸了, `npm run test:chain` 退出码非 0 而 `not ok` 数为 0,
  // 只看 "not ok = 0" 会误判成"全绿"。这就是本条存在的理由。
  assert.ok(!/&&\s*(&&|\||$)/.test(chain),
    'test:chain 里有空的 && —— sh 会报 syntax error, 整条链一段都不跑, '
    + '但 not ok 仍然是 0, 极易被误判成全绿');
  // 反过来验一遍这条判据不是恒真: 空 && 的形态确实会被它抓到。
  assert.ok(/&&\s*(&&|\||$)/.test('a && && b'), '负例自检: 空 && 的形态应被本判据抓到');
  assert.ok(!/&&\s*(&&|\||$)/.test('a && b'), '负例自检: 正常链不该被判违规');
});

test('链里引用的每个测试文件都存在 (拼错路径只会让一段红, 太容易被当噪声)', () => {
  const missing = entries.filter((e) => !fs.existsSync(path.join(CORE, e)));
  assert.strictEqual(missing.length, 0,
    'test:chain 引用了不存在的文件:\n  ' + missing.join('\n  '));
});

test('每个新写的测试文件都挂在链上 (存在即必挂, 不许"写了但 CI 不跑")', () => {
  const onDisk = fs.readdirSync(path.join(CORE, 'tests'))
    .filter((f) => f.endsWith('.test.js'))
    .map((f) => 'tests/' + f);
  const notChained = onDisk.filter((f) => !entries.includes(f));
  // 未挂链的不一定是错 —— 有些是故意只在专项跑(慢/依赖外部服务)的。
  // 但数量必须**有意识**: 超过这个数就说明有人在攒债而不是在决策。
  assert.ok(notChained.length <= 60,
    `有 ${notChained.length} 个测试文件没挂进 test:chain (在盘上 ${onDisk.length} 个, 链上 ${entries.length} 个)。`
    + '挂链是默认动作, 不挂要有理由。');
});

test('段数是算出来的不是写出来的 (报告链长时必须用这个值)', () => {
  assert.strictEqual(entries.length, new Set(entries).size,
    '段数 == 去重后的条目数; 报告时用 entries.length, 不要凭印象加减');
  // 本条同时是自检: 上面三条若恒真, 这里会跟着一起空转。
  assert.ok(entries.length > 200, `链长只有 ${entries.length} 段, 像是链被截断了`);
});
