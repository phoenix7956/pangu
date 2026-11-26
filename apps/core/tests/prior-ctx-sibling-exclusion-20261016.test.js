// 2026-10-16 兄弟子 agent 的原始 prompt 被当"上文"整份灌进彼此的系统提示
//
// 老板原话: "乾就应该把任务拆了, 分下去, 子 agent 只做自己相关的"。
// 拆了, 但这一刀照样去读兄弟的文件 —— 实测 sub-2 被派 checkpoint.js, 读了三个文件。
//
// 实测取证 (子会话落盘 ~/.pangu-data/sessions/e2e-scope-20261016_sub-2-analyzer.json):
//
//   系统块 [0] = 12639 字, 而同一代码路径上一轮是 9889 字。切段后多出来的约 7.3k 字
//   是**三份几乎逐字重复**的兄弟刀 prompt:
//     【卦·损䷨ 六四动→睽】…再执行子任务: …只做这一项: <某文件>
//     【主人原话里的路径 — 直接照抄, 禁止用你自己的 cwd 顶替】<主人的**三个**路径>
//     【只做你被分派的这一个子任务】… 【收口纪律】…
//   那三个路径就是它去读兄弟文件的直接原因 —— 工具结果 35.8k 字, 而它只被派了一个。
//
// 机制 (j2_agent_loop._priorCtx):
//   loadRecentSessionContext({ excludeSessionId: _sessionId, limit: 3 })
// 子 agent 的 sid 恒为 `父会话#sub-N-role` (session_store 的固有约定), 所以
// excludeSessionId 挡得住**自己**, 挡不住**兄弟**。而这里挑的偏偏是"最近 3 个
// 会话" —— 同一轮派出去的兄弟子 agent 正好是最最近的三个 checkpoint。
//
// 兄弟产出本来有正规通道: _ctxForSubagent 的 findingsBlock, 按相关性筛过、摘要过。
// _priorCtx 要的是"上一手真实对话", 不该要同一轮兄弟的原始 prompt —— 那份转录里
// 带着**主人的全量路径清单**, 于是每一刀都在替兄弟干活。
//
// 修: 子 agent 额外按父会话前缀排除整个兄弟家族; 主 agent (sid 无 #sub-) 行为不变。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// 建一个假 checkpoint 目录, 然后在**子进程**里加载模块 —— CHECKPOINT_DIR 在 require
// 时就从环境变量读死了, 同进程里改 env 已经太晚。
const withFakeCheckpoints = (files, fn) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-ckpt-'));
  const now = Date.now();
  for (const [name, body] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), JSON.stringify(Object.assign({ ts: now }, body)));
  }
  const script = `
    const ps = require(${JSON.stringify(path.join(ROOT, 'modules', 'prior_session.js'))});
    const out = ps.loadRecentSessionContext(${JSON.stringify(fn.opts)});
    process.stdout.write(JSON.stringify(out.map(x => x.session_id)));
  `;
  const res = require('child_process').spawnSync(process.execPath, ['-e', script], {
    env: Object.assign({}, process.env, { PANGU_CHECKPOINT_DIR: dir }),
    encoding: 'utf8',
  });
  try { fs.rmSync(dir, { recursive: true, force: true }); } catch (_) { /* 清理失败无所谓 */ }
  assert.strictEqual(res.status, 0, '子进程加载失败: ' + (res.stderr || '').slice(0, 300));
  return JSON.parse(res.stdout);
};

const PARENT = 'e2e-scope-20261016';
const ck = (sid) => ({ session_id: sid, task_input: sid + ' 的任务', messages: [] });

test('T1 老行为: 只排除自己时, 三个兄弟全都被当成"最近会话"捞进来', () => {
  // 这是现场形状 —— 兄弟三个恰好是最最近的三个 checkpoint。
  const got = withFakeCheckpoints({
    'older-session_r0.json': ck('older-session'),
    [PARENT + '#sub-0-analyzer_r0.json']: ck(PARENT + '#sub-0-analyzer'),
    [PARENT + '#sub-1-analyzer_r0.json']: ck(PARENT + '#sub-1-analyzer'),
    [PARENT + '#sub-2-analyzer_r0.json']: ck(PARENT + '#sub-2-analyzer'),
  }, { opts: { excludeSessionId: PARENT + '#sub-2-analyzer', limit: 3 } });
  assert.ok(got.includes(PARENT + '#sub-0-analyzer'),
    '前提确认: 老行为确实把兄弟捞进来了 —— 这是要修的那个洞');
  assert.ok(got.includes(PARENT + '#sub-1-analyzer'));
});

test('T2 修好: 子 agent 按父会话前缀排除后, 一个兄弟都不剩', () => {
  const got = withFakeCheckpoints({
    'older-session_r0.json': ck('older-session'),
    [PARENT + '#sub-0-analyzer_r0.json']: ck(PARENT + '#sub-0-analyzer'),
    [PARENT + '#sub-1-analyzer_r0.json']: ck(PARENT + '#sub-1-analyzer'),
    [PARENT + '#sub-2-analyzer_r0.json']: ck(PARENT + '#sub-2-analyzer'),
  }, {
    opts: {
      excludeSessionId: PARENT + '#sub-2-analyzer',
      excludeSessionPrefix: PARENT,
      limit: 3,
    },
  });
  assert.deepStrictEqual(got, ['older-session'],
    '同一轮兄弟必须一个都不许进 —— 它们的原始 prompt 里带着主人的全量路径清单');
});

test('T3 前缀不能误伤别的会话 —— 跨会话连续性是这个模块存在的理由', () => {
  const got = withFakeCheckpoints({
    'older-session_r0.json': ck('older-session'),
    [PARENT + '#sub-0-analyzer_r0.json']: ck(PARENT + '#sub-0-analyzer'),
    // 同前缀但**不是**兄弟的另一个会话: 前缀相同, 排在前面, limit 够大时也该留下
    [PARENT + '2-other_r0.json']: ck(PARENT + '2-other'),
  }, { opts: { excludeSessionPrefix: PARENT + '#sub-', limit: 5 } });
  assert.ok(got.includes('older-session'), '别的会话不该被前缀误伤');
});

test('T4 主 agent 不传前缀 → 跨会话连续性照旧, 这次改动不许削它', () => {
  const got = withFakeCheckpoints({
    'older-session_r0.json': ck('older-session'),
    'brand-new_r0.json': ck('brand-new'),
  }, { opts: { excludeSessionId: 'brand-new', limit: 3 } });
  assert.deepStrictEqual(got, ['older-session'],
    '主 agent (sid 里没有 #sub-) 必须照样捞到上一手会话 —— ' +
    '这模块治的就是"盘古新会话完全失忆", 削了它就是拆另一个台');
});

test('T5 接线: 子 agent 真的把父会话前缀算出来传下去了', () => {
  const src = read('modules/j2_agent_loop.js');
  // 2026-10-25 (第 82 批): 判据从 `indexOf('#sub-')` 放宽成 `indexOf('#')`。
  //   原因: **拆解轮 (#main-plan) 也必须排除兄弟**。
  //   原来只认 '#sub-' ⇒ 拆解轮 (sid = `父会话#main-plan`) 的 familyPrefix 是 null,
  //   它把同一轮兄弟刀的 checkpoint 当"最近 3 个会话"整份灌了进来。
  //   现场 39268686 实测: 拆解轮 msg0 里那段「跨会话上下文」2390 字,
  //   三条全是兄弟会话 (desktop-1792838641545 / #sub-0-li r21 / #sub-0-li r20),
  //   而那个父 id 在整段里出现 7 次 —— 那是**别的会话**的兄弟刀 prompt,
  //   带着主人全量路径清单。
  //   判据改成"取第一个 '#' 之前那段" ⇒ '#sub-' 和 '#main-plan' 一视同仁。
  assert.ok(/indexOf\('#'\)/.test(src),
    '必须按 session_store 的固有约定 (# 开头是派生会话) 认出家族前缀 —— '
    + "只认 '#sub-' 会漏掉拆解轮 (#main-plan)");
  assert.ok(/excludeSessionPrefix: _familyPrefix/.test(src),
    '前缀要真的传进 loadRecentSessionContext —— 算出来不传等于没改');
  assert.ok(/indexOf\('#'\)[\s\S]{0,200}_familyPrefix = /.test(src),
    '前缀取的是 # 之前那段父会话 id, 别取错');
});

test('T6 拆解轮 (#main-plan) 同样排除兄弟 checkpoint', () => {
  // 场景: 父会话 P 派了 3 刀 (P#sub-0/1/2), 同时 dispatcher 开了一条拆解轮
  // (P#main-plan)。拆解轮启动时, 那 3 刀的 checkpoint 恰好是"最近的会话"。
  // 拆解轮必须一个兄弟都不许捞 —— 它的活是**切小**, 喂它兄弟的原始 prompt
  // (带主人全量路径清单) 只会让它照抄上一轮的切法。
  const got = withFakeCheckpoints({
    'older-session_r0.json': ck('older-session'),
    [PARENT + '#sub-0-analyzer_r0.json']: ck(PARENT + '#sub-0-analyzer'),
    [PARENT + '#sub-1-analyzer_r0.json']: ck(PARENT + '#sub-1-analyzer'),
    [PARENT + '#sub-2-analyzer_r0.json']: ck(PARENT + '#sub-2-analyzer'),
  }, {
    opts: {
      excludeSessionId: PARENT + '#main-plan',
      excludeSessionPrefix: PARENT,
      limit: 3,
    },
  });
  assert.deepStrictEqual(got, ['older-session'],
    '拆解轮必须一个兄弟都不许进 —— 兄弟的原始 prompt 带着主人的全量路径清单');
});

