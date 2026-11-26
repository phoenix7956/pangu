'use strict';

/**
 * 2026-10-15 — `npm test` 必须跑在沙箱里, 不许碰生产状态目录
 *
 * 为什么这条要钉死 (不是洁癖, 是实测代价):
 *   session_store 读取是 "AgentDB 优先, JSON 兜底", 而 AgentDB 认 PANGU_AGENTDB_DIR,
 *   **不受 PANGU_SESSIONS_DIR 管**。于是只重定向 SESSIONS_DIR 的测试, 读会打到生产库
 *   拿到陈旧数据 (force-compact 那次把刚写的 17 条读成 4 条), 写则往生产库塞垃圾。
 *
 *   实测跑完一次全量 `npm test` (123 条命令的链, 每个测试一个独立进程):
 *     跑前 sessions=1314 -> 跑完 1320, 生产库里多出 bench-big(241 条消息!) /
 *     r24-* / roletest / dbg-1 等一串测试 session, 全是假的。
 *
 *   修法: 沙箱做在**链的外层** (bin/run-tests.sh), 而不是一个个测试里补 —— 链里
 *   123 个进程各自为政, 谁忘了重定向谁就漏。
 *
 *   加沙箱后复跑同一条链: 112 份小结 0 失败 (与基线一致),
 *   生产库 sessions=1320 -> 1320, memories=10605 -> 10605, 一个字节没动。
 *
 * 本测试钉住三件事, 任何一条被破坏都会红:
 *   1. package.json 的 test 指向沙箱包装, 不是裸链;
 *   2. 原链原样保留在 test:chain (沙箱只是包一层, 没有悄悄改测试集);
 *   3. 沙箱脚本把**每一个**会落盘的状态目录都导走了 —— 少一个就漏一个。
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const pkg = JSON.parse(fs.readFileSync(path.join(CORE, 'package.json'), 'utf8'));
const SANDBOX = path.join(CORE, 'bin', 'run-tests.sh');

// 这些 env 一旦漏掉, 对应目录就还写生产库。跟 grep 出来的落盘点保持一致。
const MUST_SANDBOX = [
  'PANGU_AGENTDB_DIR',   // session_store 主读源 —— 漏了就是今天这个 bug 的本体
  'PANGU_SESSIONS_DIR', // JSON session 落盘
  'PANGU_BUDGET_DIR',   // 预算状态 (实测日志: "sessions restored from .../state/budget")
  'PANGU_CHECKPOINT_DIR',
  'PANGU_OUTCOMES_DIR',
  'PANGU_PLAN_DIR',
  'PANGU_TASK_DIR',
  'PANGU_HANDOFF_DIR',
  // 2026-10-26 第 100 批: 进化账本 (L1 dogfooding) —— 之前漏了它。
  // 后果实测 (2026-10-25 生产账本): 579 条里 356 条"真失败"全是测试会话,
  // 生产账本里一条真实用户会话都没有 ⇒ 失败率虚高 → 看门狗误报
  // → 修复跑批器拿日志当源码去问模型 → 45K token/次的本地 GPU 空转。
  'PANGU_EVO_DIR',
  // 2026-10-26 第 100 批: 还有三个 state 子目录 + 一个根级审计文件没导走。
  // 实测 (跑链窗口内 diff 生产 ~/.pangu): 104 个测试产物进了生产 ——
  //   state/harness/runs 72 + state/ledger 31 + state/compaction 5 + alignment-blocked.jsonl。
  'PANGU_LEDGER_DIR',
  'PANGU_COMPACTION_DIR',
  'PANGU_RUN_TRACE_DIR',
  'PANGU_ALIGNMENT_AUDIT_FILE',
  'PANGU_HARNESS_DIR',
];

test('npm test 必须指向沙箱包装, 不许退回裸链', () => {
  assert.match(
    pkg.scripts.test,
    /run-tests\.sh/,
    'package.json 的 test 脚本必须走 bin/run-tests.sh —— 直接跑裸链会往生产库写测试数据',
  );
});

test('沙箱脚本必须存在且可执行', () => {
  assert.ok(fs.existsSync(SANDBOX), 'bin/run-tests.sh 不存在');
  const st = fs.statSync(SANDBOX);
  assert.ok(st.mode & 0o111, 'bin/run-tests.sh 不可执行 —— npm test 会直接失败');
});

test('原测试链必须原样保留在 test:chain (沙箱只包一层, 没偷换测试集)', () => {
  // 2026-10-31 第 180 批: 段落表搬到了 scripts['test:chain:segments'],
  //   入口改成逐段汇总的 runner ⇒ 这里改走 helpers/chain_cmd 的统一读法。
  const chain = require('./helpers/chain_cmd').chainCommand();
  assert.ok(chain, 'test:chain 不存在 —— 沙箱把原来的测试集弄丢了');
  assert.ok(chain.includes('lmstudio-cache-guard-20261015.test.js'),
    'test:chain 至少要包含链尾那份测试, 否则说明链被截断了');
  assert.ok(chain.includes('force-compact-endpoint-20261015.test.js'),
    'test:chain 至少要包含今天修过沙箱的那份测试');
  // 沙箱脚本必须真的去跑 test:chain, 而不是自己另编一套
  const sh = fs.readFileSync(SANDBOX, 'utf8');
  assert.match(sh, /npm run test:chain/, '沙箱脚本必须执行 test:chain');
});

test('每一个会落盘的状态目录都必须被导出到沙箱', () => {
  const sh = fs.readFileSync(SANDBOX, 'utf8');
  for (const v of MUST_SANDBOX) {
    assert.match(
      sh,
      new RegExp(`export\\s+${v}=`),
      `沙箱漏了 ${v} —— 对应目录会继续写生产库`,
    );
  }
});

test('沙箱必须是每次新建的临时目录, 不许复用固定路径', () => {
  const sh = fs.readFileSync(SANDBOX, 'utf8');
  assert.match(sh, /mktemp -d/, '沙箱必须用 mktemp 每次新建, 否则上一轮的脏数据会渗进下一轮');
  assert.ok(
    !/PANGU_AGENTDB_DIR="\/Users\/|PANGU_AGENTDB_DIR="\$HOME/.test(sh),
    '沙箱路径不许指向固定目录或 home',
  );
});

test('沙箱不许顺手把生产目录删了 (只在临时目录里操作)', () => {
  const sh = fs.readFileSync(SANDBOX, 'utf8');
  const danger = sh.split('\n').filter((l) => /\brm\s+-[rf]/.test(l) && !/SANDBOX/.test(l));
  assert.equal(danger.length, 0, `沙箱脚本里有指向非沙箱路径的 rm: ${danger.join(' | ')}`);
});

