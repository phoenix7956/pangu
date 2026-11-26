// guard_e2e_scenarios.test.js — 环路级守卫场景 e2e (2026-09-14 老板拍 "按顺序解决" #3)
// guard_audit.js 是 42 用例静态矩阵, 盖不到有状态守卫 (跨轮状态 + plan/checkpoint 落盘联动)。
// 本文件用剧本化假 LLM 驱动真实 _runAgentLoopLegacyStream 主循环, 真执行 tools/index.js 注册表,
// 验证三个有状态守卫的端到端行为:
//   S1  TASK_DONE_GATE × plan 骨架: plan 有 pending 时 task_done 必须被拒, 补完后才放行
//   S2  auto-resume 进展制: 预算耗尽但有实质进展 → 预算重置续跑; 无进展 → 收口 (#1 修复的回归锁)
//   S3  静默失败: 全程 0 工具光说不做 → 不许以 success 收场
// 运行: node --test apps/core/tests/guard_e2e_scenarios.test.js
'use strict';

// ══ 隔离必须先于任何 require (plan_state/task_checkpoint/task_ledger 加载即锁目录) ══
const fs = require('fs');
const path = require('path');
const os = require('os');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-guard-e2e-'));
process.env.PANGU_HOME = path.join(TMP, 'home');
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/state_paths.js),
// 解析顺序 PANGU_LEDGER_DIR > PANGU_HOME/state/ledger > 生产默认。
// 只设 PANGU_HOME 会被链沙箱里的 PANGU_LEDGER_DIR 抢在前面 ⇒ 账本落到共享沙箱目录,
// 本测试的隔离意图 (自己的 TMP) 就没了。
process.env.PANGU_LEDGER_DIR = path.join(TMP, 'home', 'state', 'ledger');
process.env.PANGU_PLAN_DIR = path.join(TMP, 'plans');
process.env.PANGU_TASK_DIR = path.join(TMP, 'tasks');
// j2_loop_shared persists every round through session_store. Keep both the
// JSON sessions and AgentDB inside the same disposable sandbox; PANGU_HOME
// alone does not control those paths.
process.env.PANGU_SESSIONS_DIR = path.join(TMP, 'sessions');
process.env.PANGU_AGENTDB_DIR = path.join(TMP, 'agentdb');
fs.mkdirSync(process.env.PANGU_HOME, { recursive: true });

const { test } = require('node:test');
const assert = require('node:assert');

const loop = require('../modules/j2_agent_loop');
const planState = require('../modules/plan_state');
const taskCp = require('../modules/task_checkpoint');

const MODEL = { id: 'minimax-m3', context_length: 1000000000 };

// ── 剧本化假 LLM: 每轮弹一个剧本步, 返回 OpenAI native tool_calls 形状 ──
function makeScriptedLLM(script, calls) {
  return async (messages, model, toolsSchema, opts) => {
    const idx = calls.n++;
    const step = script[Math.min(idx, script.length - 1)];
    calls.seen.push({ round: idx, msgs: messages.length, tools: (step.tools || []).map(t => t.name) });
    if (opts && typeof opts.onText === 'function' && step.text) opts.onText(step.text);
    return {
      choices: [{
        message: {
          content: step.text || '',
          tool_calls: (step.tools || []).map((t, i) => ({
            id: 'call_' + idx + '_' + i,
            type: 'function',
            function: { name: t.name, arguments: JSON.stringify(t.params || {}) },
          })),
        },
      }],
      usage: { prompt_tokens: 100, completion_tokens: 50, total_tokens: 150 },
    };
  };
}

function makeRes() {
  const chunks = [];
  return {
    chunks,
    writableEnded: false,
    write(s) { chunks.push(String(s)); return true; },
    end() { this.writableEnded = true; },
    text() { return chunks.join(''); },
    hasEvent(name, substr) {
      const t = this.text();
      return t.includes('event: ' + name) && (!substr || t.includes(substr));
    },
  };
}

async function runScenario(sid, input, script, env) {
  process.env.PANGU_MAX_ROUNDS = String(env.maxRounds);
  process.env.PANGU_AUTO_RESUME_MAX = String(env.autoResumeMax);
  const calls = { n: 0, seen: [] };
  loop.init({
    _callLLMForAgent: makeScriptedLLM(script, calls),
    _callLLMForAgentStream: async function* () { throw new Error('stream not scripted'); },
    _detectToolCallSupport: async () => true, // 强制 native 路径
    getModelContextLength: () => 1000000000,
    getCurrentModel: () => MODEL,
    _recordSessionToMemory: async () => {},
    _sessionRecall: async () => [],
    _recordEvolution: () => {},
    safeResWrite: (res, s) => res.write(s),
    _j2ExecuteToolCalls: async () => [],
    _j2AppendToolResults: () => {},
    _hasUnclosedToolBlock: () => false,
    path,
    MAX_BODY_BYTES: 10 * 1024 * 1024,
  });
  const res = makeRes();
  const req = { on() {}, aborted: false };
  const messages = [{ role: 'user', content: input }];
  await loop._runAgentLoopLegacyStream(messages, MODEL, req, res, {
    sessionId: sid, userInput: input, reqBody: { session_id: sid },
  });
  return { res, calls };
}

// ═══ S1: TASK_DONE_GATE × plan 骨架 ═══
test('S1: plan 有 pending 时 task_done 被拒, 补齐证据后才放行', async () => {
  const sid = 'e2e-s1-' + Date.now();
  const script = [
    { text: '先建计划。', tools: [{ name: 'plan_create', params: { goal: '两步测试任务', steps: [
      { id: 's1', title: '第一步', dod: '产出A' },
      { id: 's2', title: '第二步', dod: '产出B' },
    ] } }] },
    // 过早交验 — plan 还有 2 步 pending, 必须被拒
    { text: '做完了。', tools: [{ name: 'task_done', params: { summary: '两步测试任务已执行完成。', status: 'completed' } }] },
    { text: '补第一步。', tools: [{ name: 'plan_step_done', params: { step_id: 's1', evidence: '产出A已落盘' } }] },
    // 对齐/终局守卫可能触发一次额外模型重答；第一次 s1 可能被重答消费，
    // 所以重复同一个幂等步骤，再进入 s2，避免把“模型调用次数”误当主循环轮数。
    { text: '补第一步。', tools: [{ name: 'plan_step_done', params: { step_id: 's1', evidence: '产出A已落盘' } }] },
    { text: '补第二步。', tools: [{ name: 'plan_step_done', params: { step_id: 's2', evidence: '产出B已落盘' } }] },
    // 全部 done 后再交验 — 必须放行
    { text: '交付。', tools: [{ name: 'task_done', params: { summary: '两步测试任务结果: 第一步产出A已落盘, 第二步产出B已落盘, 任务完成。', status: 'completed' } }] },
  ];
  const { res, calls } = await runScenario(sid, '执行两步测试任务并报告结果', script, { maxRounds: 8, autoResumeMax: 0 });
  const sse = res.text();
  assert.ok(sse.includes('task_done 被拒'), 'S1: plan pending 时 task_done 必须被拒 (SSE warning)\n--- SSE ---\n' + sse.slice(-3000));
  assert.ok(sse.includes('event: done'), 'S1: 必须有 done 事件');
  assert.ok(calls.seen.some(c => c.tools.includes('plan_step_done')), 'S1: 模型应有机会补做 plan_step_done');
  assert.ok(/"success":true|"success": true/.test(sse), 'S1: 补齐后最终必须 success');
  const p = planState.loadPlan(sid);
  assert.ok(p && p.steps.every(s => s.status === 'done'), 'S1: plan 两步都应 done');
});

// ═══ S2: auto-resume 进展制 (#1 回归锁) ═══
test('S2: 续跑预算耗尽但有实质进展 → 预算重置继续跑到真完成', async () => {
  const sid = 'e2e-s2-' + Date.now();
  const script = [
    { text: '建三步计划。', tools: [{ name: 'plan_create', params: { goal: '三步长任务', steps: [
      { id: 's1', title: '一', dod: 'A' }, { id: 's2', title: '二', dod: 'B' }, { id: 's3', title: '三', dod: 'C' },
    ] } }] },
    { text: '做第一步。', tools: [{ name: 'plan_step_done', params: { step_id: 's1', evidence: 'A' } }] },
    // ↑ maxRounds=2 到此耗尽, auto-resume #1 (1/1), done_at_last_resume=1
    { text: '做第二步。', tools: [{ name: 'plan_step_done', params: { step_id: 's2', evidence: 'B' } }] },
    { text: '做第三步。', tools: [{ name: 'plan_step_done', params: { step_id: 's3', evidence: 'C' } }] },
    // ↑ 再次耗尽: 旧逻辑到此收口等主人; 新逻辑 done 1→3 有进展 → 预算重置续跑
    { text: '交付。', tools: [{ name: 'task_done', params: { summary: '三步长任务完成: A/B/C 全部落盘并附证据。', status: 'completed' } }] },
  ];
  const { res, calls } = await runScenario(sid, '执行三步长任务并报告', script, { maxRounds: 2, autoResumeMax: 1 });
  const sse = res.text();
  const resumeCount = (sse.match(/event: auto_resume/g) || []).length;
  assert.ok(resumeCount >= 2, 'S2: 有进展时长任务应续跑 ≥2 次 (实际 ' + resumeCount + ') — 旧逻辑 1 次就收口等主人');
  assert.ok(/"success":true|"success": true/.test(sse), 'S2: 最终必须 success, 不等主人说继续\n--- SSE tail ---\n' + sse.slice(-2000));
  const p = planState.loadPlan(sid);
  assert.ok(p && p.steps.every(s => s.status === 'done'), 'S2: 三步全 done');
});

test('S2b: 续跑预算耗尽且无实质进展 → 收口 (防原地打转烧 token)', async () => {
  const sid = 'e2e-s2b-' + Date.now();
  const script = [
    { text: '建两步计划。', tools: [{ name: 'plan_create', params: { goal: '打转任务', steps: [
      { id: 's1', title: '一', dod: 'A' }, { id: 's2', title: '二', dod: 'B' },
    ] } }] },
    // 之后永远只有嘴炮文本, 不做任何 step → 续跑 1 次后必须收口
    { text: '我还在推进中, 马上继续做。' },
    { text: '我还在推进中, 马上继续做。' },
    { text: '我还在推进中, 马上继续做。' },
    { text: '我还在推进中, 马上继续做。' },
    { text: '我还在推进中, 马上继续做。' },
    { text: '我还在推进中, 马上继续做。' },
  ];
  const { res } = await runScenario(sid, '执行打转任务', script, { maxRounds: 2, autoResumeMax: 1 });
  const sse = res.text();
  const resumeCount = (sse.match(/event: auto_resume/g) || []).length;
  assert.ok(resumeCount <= 1, 'S2b: 无进展时最多续跑 1 次就收口 (实际 ' + resumeCount + ') — 防无限打转');
  const cp = taskCp.loadTaskCheckpoint(sid);
  assert.ok(cp && (cp.auto_resumes || 0) >= 1, 'S2b: 收口时 checkpoint 应记录预算耗尽');
});

// ═══ S4: 文件产出也算进展 (#1b 回归锁 — 三命通会实战: 模型写 3 份 digest 但不调 plan_step_done,
//        旧单信号 (只看 plan done 步数) 误判"无进展"收口死) ═══
test('S4: plan 步数没动但每轮真写文件 → 文件产出信号重置预算, 持续续跑到完成', async () => {
  const sid = 'e2e-s4-' + Date.now();
  // 直接写 TMP 根 (write_file 不自动建父目录, 写不存在的子目录会 WRITE_ERROR;
  // 且 self_correct 判 incorrect 的调用不进 toolsUsed — 失败写盘本来就不该算进展)
  const wf = (n) => ({ name: 'write_file', params: { path: path.join(TMP, 's4_digest_' + n + '.md'), content: '# 消化 ' + n + '\n正文' } });
  const script = [
    { text: '建两步计划。', tools: [{ name: 'plan_create', params: { goal: '消化大部头分块落盘', steps: [
      { id: 's1', title: '消化上半', dod: 'digest 落盘' }, { id: 's2', title: '消化下半', dod: 'digest 落盘' },
    ] } }] },
    // 之后每轮只写文件, 从不调 plan_step_done (plan pending=2 全程不动) — 旧逻辑续跑 1 次即收口
    { text: '消化第 1 块。', tools: [wf(1)] },
    // ↑ maxRounds=2 耗尽, resume #1 (1/1), files_at_last_resume=1
    { text: '消化第 2 块。', tools: [wf(2)] },
    { text: '消化第 3 块。', tools: [wf(3)] },
    // ↑ 再次耗尽: files 1→3 有产出 → 预算重置 resume #2 (旧逻辑: done 0→0 无进展, 收口死)
    { text: '消化第 4 块。', tools: [wf(4)] },
    { text: '消化第 5 块。', tools: [wf(5)] },
    // ↑ files 3→5 又有产出 → resume #3
    { text: '补记上半完成。', tools: [{ name: 'plan_step_done', params: { step_id: 's1', evidence: 'digest 1-3 已落盘' } }] },
    { text: '补记下半完成。', tools: [{ name: 'plan_step_done', params: { step_id: 's2', evidence: 'digest 4-5 已落盘' } }] },
    { text: '交付。', tools: [{ name: 'task_done', params: { summary: '消化完成: 5 份 digest 全部落盘, 两步计划补记 done。', status: 'completed' } }] },
  ];
  const { res } = await runScenario(sid, '消化大部头并分块落盘', script, { maxRounds: 2, autoResumeMax: 1 });
  const sse = res.text();
  const resumeCount = (sse.match(/event: auto_resume/g) || []).length;
  assert.ok(resumeCount >= 3, 'S4: 每轮有文件产出应反复重置预算续跑 ≥3 次 (实际 ' + resumeCount + ') — 旧单信号逻辑 1 次就收口');
  assert.ok(/"success":true|"success": true/.test(sse), 'S4: 最终必须 success\n--- SSE tail ---\n' + sse.slice(-2000));
  for (const n of [1, 2, 3, 4, 5]) {
    assert.ok(fs.existsSync(path.join(TMP, 's4_digest_' + n + '.md')), 'S4: s4_digest_' + n + '.md 应真落盘');
  }
});

// ═══ S5: 抓假必须纠假 (#14 回归锁 — 老板 13:42 实案 "这才是问题": 编交付被对账拦截
//        就收口报死, 主人必须重发指令激活 = 长任务干不了的最后一环) ═══
test('S5: 编交付被对账拦截 → 回灌纠假逼真做, 不直接收口死', async () => {
  const sid = 'e2e-s5-' + Date.now();
  const fakePath = path.join(TMP, 's5_fake_claim.md');
  const script = [
    // 编的: 0 工具, 文本声称落盘 (避开 UNVERIFIED_RE 的"已X"前缀词, 专测对账纠假这条线)
    { text: '本轮消化完成, 成果落盘到 ' + fakePath + ', 共 120 行 5.6KB, 核心要点三条: 其一五行生克链路, 其二十神意象对照, 其三调候用神优先级表, 全在文件里。' },
    // 纠假回灌后真做
    { text: '真写盘。', tools: [{ name: 'write_file', params: { path: fakePath, content: '# 真消化\n正文' } }] },
    { text: '交付。', tools: [{ name: 'task_done', params: { summary: '消化总结真落盘: ' + fakePath, status: 'completed' } }] },
  ];
  const { res } = await runScenario(sid, '消化资料并落盘总结', script, { maxRounds: 6, autoResumeMax: 0 });
  const sse = res.text();
  assert.ok(sse.includes('纠假'), 'S5: 编交付必须触发纠假回灌而不是直接收口死 (SSE warning)\n--- SSE tail ---\n' + sse.slice(-3000));
  assert.ok(fs.existsSync(fakePath), 'S5: 纠假后文件应真落盘');
  assert.ok(/"success":true|"success": true/.test(sse), 'S5: 真做后必须 success\n--- SSE tail ---\n' + sse.slice(-2000));
});

// ═══ S3: 静默失败守卫 ═══
test('S3: 全程 0 工具光说不做 → 不许以 success 收场', async () => {
  const sid = 'e2e-s3-' + Date.now();
  const script = [
    { text: '收到，我这就开盘: 先列出清单再逐个读, 接下来读完再消化。' },
    { text: '收到，我这就开盘: 先列出清单再逐个读, 接下来读完再消化。' },
    { text: '收到，我这就开盘: 先列出清单再逐个读, 接下来读完再消化。' },
    { text: '收到，我这就开盘: 先列出清单再逐个读, 接下来读完再消化。' },
  ];
  const { res, calls } = await runScenario(sid, '消化测试资料并写总结', script, { maxRounds: 4, autoResumeMax: 0 });
  const sse = res.text();
  assert.ok(sse.includes('event: done'), 'S3: 必须有 done 事件 (不许无声死)');
  assert.ok(!/"success":true|"success": true/.test(sse), 'S3: 0 工具光说不做不许报 success\n--- SSE tail ---\n' + sse.slice(-2000));
  assert.ok(calls.n >= 2, 'S3: 至少跑了 2 轮 (nudge 后给过机会)');
});

// 清理
process.on('exit', () => { try { fs.rmSync(TMP, { recursive: true, force: true }); } catch (_) {} });
