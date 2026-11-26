'use strict';
// 2026-10-13 子 agent 的会话**一条都落不了盘** —— 长工作做不了的根因
//
// 现场 (探针 objw-live-1791849643, 218.4s, 15 次压缩全部发生在子 agent 里):
//   - ~/.pangu-data/sessions/ 有父会话文件, **零个** `#sub-*` 文件
//   - ~/.pangu/state/tasks/ 有 objw-live-1791849643_sub-1-executor.json,
//     顶层只有 messages_count=106 而没有 messages —— checkpoint 把 sid 消毒成 `_`,
//     所以 checkpoint 落盘成功; 而 session_store 原样校验, 于是每条都抛 INVALID_SESSION_ID
//   - 父会话 messages 共 10 条 = 8 条 system 样板 (28385 字符) + 1 user + 1 assistant,
//     **工具消息 0 条**。活全是子 agent 干的, 而子 agent 的现场一条不剩。
//
// 根因: j2_dispatcher 给子 agent 的 sid 恒为 `parentId + '#sub-' + n + '-' + role`,
// 而 session_store.validateSessionId 只放行 /^[A-Za-z0-9_-]+$/ —— `#` 不在其中。
// sessionSave / sessionLoad / sessionDelete / sessionFilePath 全走这一个校验, 于是恒抛;
// 抛错又被 _persistSession 的 catch 吃掉, 只剩一行 console.warn。
// 既不报错也没有计数器, 所以现场看起来就是"子 agent 干完就忘了",
// 而父会话最后只能照抄子 agent 的自述 (见 commit 219f69c)。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const store = require('../modules/session_store');
const originalSessions = process.env.PANGU_SESSIONS_DIR;
const originalAgentDb = process.env.PANGU_AGENTDB_DIR;
const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'pangu-sub-session-'));
process.env.PANGU_SESSIONS_DIR = path.join(tmp, 'sessions');
process.env.PANGU_AGENTDB_DIR = path.join(tmp, 'agentdb');

const SUB_SID = 'objw-live-1791849643#sub-1-executor';

test.after(() => {
  if (originalSessions === undefined) delete process.env.PANGU_SESSIONS_DIR;
  else process.env.PANGU_SESSIONS_DIR = originalSessions;
  if (originalAgentDb === undefined) delete process.env.PANGU_AGENTDB_DIR;
  else process.env.PANGU_AGENTDB_DIR = originalAgentDb;
  fs.rmSync(tmp, { recursive: true, force: true });
});

test('子 agent 的会话必须能落盘 (修前: 每一条都返回 INVALID_SESSION_ID)', async () => {
  const saved = await store.sessionSave({
    session_id: SUB_SID,
    messages: [
      { role: 'system', content: '你是 executor' },
      { role: 'user', content: '写 b1.txt b2.txt b3.txt' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'write_file', arguments: '{}' } }] },
      { role: 'tool', content: '{"ok":true}', tool_call_id: 'c1' },
    ],
    compaction_summary: '已完成 alpha, 待办 beta',
  });
  assert.equal(saved.ok, true, '子 agent 会话落盘必须成功, 否则干的活一条不剩: '
    + JSON.stringify(saved && saved.error));
  // 文件名要和 checkpoint.js 的消毒规则对齐 (那边是把非法字符全换成 _),
  // 这样 ~/.pangu/state/tasks/ 的文件名和 ~/.pangu-data/sessions/ 的能对上号。
  const files = fs.readdirSync(path.join(tmp, 'sessions'));
  assert.equal(files.length, 1, '应该正好落一个文件, 实际: ' + JSON.stringify(files));
  assert.equal(files[0].includes('#'), false, '落盘文件名不该含 #: ' + files[0]);
  assert.equal(files[0], 'objw-live-1791849643_sub-1-executor.json',
    '落盘文件名应与 checkpoint 的消毒结果同名, 实际: ' + files[0]);
});

test('子 agent 会话要能用原始带 # 的 id 读回来 (拿消毒后的名字当 id 不算修好)', async () => {
  const loaded = await store.sessionLoad({ session_id: SUB_SID });
  assert.equal(loaded.ok, true, '读回必须成功: ' + JSON.stringify(loaded && loaded.error));
  assert.equal(loaded.result.session_id, SUB_SID, '读回的 session_id 必须是原始 id');
  assert.equal(loaded.result.messages.length, 4, '消息一条都不能少');
  assert.equal(loaded.result.compaction_summary, '已完成 alpha, 待办 beta',
    '子 agent 的压缩摘要也要能落盘 (接 bef5405: 15 次压缩全发生在子 agent 里)');
});

test('子 agent 会话要能按原始 id 删掉', async () => {
  const del = await store.sessionDelete({ session_id: SUB_SID });
  assert.equal(del.ok, true, '删除必须成功: ' + JSON.stringify(del && del.error));
  assert.equal(fs.readdirSync(path.join(tmp, 'sessions')).length, 0, '删完应该不剩文件');
});

test('父会话 id 不受影响', async () => {
  const id = 'objw-live-1791849643';
  const saved = await store.sessionSave({ session_id: id, messages: [{ role: 'user', content: 'x' }] });
  assert.equal(saved.ok, true);
  assert.equal(fs.existsSync(path.join(tmp, 'sessions', id + '.json')), true,
    '不带 # 的 id 文件名不能被消毒规则改动');
  await store.sessionDelete({ session_id: id });
});

test('路径穿越仍然必须被拒 (放宽校验不能把安全闸门一起拆了)', async () => {
  for (const bad of ['../evil', 'a/b', '..', '', null, 'x.y']) {
    const r = await store.sessionSave({ session_id: bad, messages: [{ role: 'user', content: 'x' }] });
    assert.equal(r.ok, false, '这个 id 必须被拒: ' + JSON.stringify(bad));
  }
});
