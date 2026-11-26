'use strict';
// 2026-10-13 逆向 Codex CLI 0.144.4 的 compact 链路时对照出来的缺口:
//
// session_compaction.compact() **确实返回了 summary**, 调用方(j2_agent_loop 的
// _tryAutoResume)也确实把摘要当 system 消息塞进了 messages —— 但只取 compactedMessages,
// summary 就被扔了。sessionStore 的 compaction_summary 字段于是**全部 265 个真实会话里
// 都是长度 2 的空串**, 而压缩明明发生过(实测日志里 `102 -> 105 msgs`)。
//
// 后果很实际: 长任务最常见的死法是"压缩之后忘了", 而压缩现场一条证据都没留下 ——
// 这条路一堵, 后面所有"压缩把什么压没了 / 压完模型还知道什么"都只能靠猜。
//
// 修法: 数据本来就在 messages 里(compact() 用 isCompactionSummary 标记塞进来的),
// 只是没人取出来。在 _persistSession 里提取, 落进本来就存在却一直为空的字段。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SHARED = path.join(__dirname, '../modules/j2_loop_shared.js');
const SESS_STORE = require.resolve('../modules/session_store');
const COMPACTION = path.join(__dirname, '../modules/session_compaction.js');

// 拦下 sessionSave, 看 _persistSession 到底传了什么下去
let captured = null;
const origSave = require(SESS_STORE).sessionSave;
require.cache[SESS_STORE].exports.sessionSave = async (args) => { captured = args; };

const shared = require(SHARED);
const COMPACT_SRC = fs.readFileSync(COMPACTION, 'utf8');

function summaryMsg(obj) {
  // 与 session_compaction.buildCompactedMessages 的产出形状保持一致
  return {
    role: 'system',
    content: '【会话摘要】' + JSON.stringify(obj, null, 2),
    timestamp: Date.now(),
    isCompactionSummary: true,
  };
}

test.after(() => { require.cache[SESS_STORE].exports.sessionSave = origSave; });

test('压缩摘要必须落盘 (修前: 全部 265 个会话该字段都是空串)', async () => {
  captured = null;
  const sum = { type: 'fold', summary: '已完成 alpha 三个文件; 待办 beta', folded_count: 42 };
  await shared._persistSession('cs-1', [
    { role: 'system', content: '你是盘古' },
    summaryMsg(sum),
    { role: 'user', content: '当前问题' },
  ]);
  assert.ok(captured, 'sessionSave 没被调用');
  assert.equal(typeof captured.compaction_summary, 'string', 'compaction_summary 必须被传下去');
  assert.ok(captured.compaction_summary.length > 20,
    '摘要不能是空串: ' + JSON.stringify(captured.compaction_summary));
  assert.match(captured.compaction_summary, /alpha 三个文件/,
    '摘要正文必须真的落盘, 不是只传个占位');
  assert.doesNotMatch(captured.compaction_summary, /^【会话摘要】/,
    '前缀要在落盘前剥掉, 否则下游按 JSON 解析会失败');
});

test('没有压缩摘要时保持空串 (不许编一个)', async () => {
  captured = null;
  await shared._persistSession('cs-2', [
    { role: 'system', content: '你是盘古' },
    { role: 'user', content: '你好' },
  ]);
  assert.equal(captured.compaction_summary, '');
});

test('多次压缩取最后一次 (越新的越接近当前状态)', async () => {
  captured = null;
  await shared._persistSession('cs-3', [
    summaryMsg({ summary: '第一次压缩: 早期状态' }),
    { role: 'user', content: '继续' },
    summaryMsg({ summary: '第二次压缩: 当前状态' }),
  ]);
  assert.match(captured.compaction_summary, /第二次压缩/);
  assert.doesNotMatch(captured.compaction_summary, /第一次压缩/);
});

test('空 assistant 占位被过滤掉, 但摘要仍要落盘', async () => {
  captured = null;
  await shared._persistSession('cs-4', [
    summaryMsg({ summary: '要保住的事实' }),
    { role: 'assistant', content: '   ' },   // UI 空占位, 会被过滤
    { role: 'user', content: '在吗' },
  ]);
  assert.match(captured.compaction_summary, /要保住的事实/);
  assert.ok(!captured.messages.some(m => m.role === 'assistant' && String(m.content).trim() === ''),
    '空占位仍然要被过滤 (这条是老行为, 别被新逻辑碰坏)');
});

test('调用方显式传入的 compaction_summary 优先 (不许被提取值覆盖)', async () => {
  captured = null;
  await shared._persistSession('cs-5', [summaryMsg({ summary: '从 messages 提取的' })],
    { compaction_summary: '调用方显式给的' });
  assert.equal(captured.compaction_summary, '调用方显式给的');
});

// 这条是整个修复的前提: compact() 产出的摘要消息**必须**带 isCompactionSummary 标记,
// 否则提取永远拿不到, 修复等于没做。
test('前提: compact() 造的摘要消息带 isCompactionSummary 标记', () => {
  assert.match(COMPACT_SRC, /isCompactionSummary:\s*true/,
    'buildCompactedMessages 必须给摘要消息打标记, 否则 _persistSession 提取不到');
  assert.match(COMPACT_SRC, /【会话摘要】/,
    '摘要前缀要和 _persistSession 的剥离逻辑对得上');
});

// 反向断言: 防止将来有人"优化"成只认前缀不认标记, 或两者都不认。
test('标记与前缀必须成对使用 (别只认其中一个)', () => {
  const sharedSrc = fs.readFileSync(SHARED, 'utf8');
  assert.match(sharedSrc, /\.filter\(m => m && m\.isCompactionSummary\)/,
    '提取必须靠 isCompactionSummary 标记, 不能靠内容猜测');
  assert.match(sharedSrc, /replace\(\/\^【会话摘要】\//,
    '前缀剥离逻辑必须在');
});
