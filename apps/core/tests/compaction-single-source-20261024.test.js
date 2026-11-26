// 2026-10-24 (第 80 批): 压缩收成唯一真源。
//
// 现场: 仓库里有两套压缩实现 ——
//   (1) modules/compaction.js (旧影子, 9KB)  被 llm_caller._maybeCompactMessages + scheduler 用
//   (2) modules/session_compaction.js (41KB)  被 j2_agent_loop 用
// 影子那份自己算 token (chars x 0.35)、自己调 LLM 摘要、自己拼 summary system 消息,
// **没过工具配对清洗**。而 (1) 算出的 token 比 (2) 大 1.4 倍 => (1) 先触发 =>
// 两套摘要格式进同一个上下文, 且可能留下孤儿 tool result => MiniMax 400
// "tool result's tool id not found" => 整轮降级 legacy 重跑。
//
// 修法: (1) 收成 (2) 的薄适配层。本测试钉住「只有一条路」这件事本身。
'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SHADOW_PATH = path.join(__dirname, '../modules/compaction.js');
const LIVE_PATH = path.join(__dirname, '../modules/session_compaction.js');
const shadowSrc = fs.readFileSync(SHADOW_PATH, 'utf8');

// 「注释 ≠ 隔离」这条铁律的反面也要用上: 源码级判据只判**代码**, 不判注释。
// 注释里提一句「旧实现用过 estimateMessagesTokens」是历史说明, 不是违规;
// 违规的是**代码里又调用了它**。所以先把注释剥掉再查。
//
// 剥法用词法扫描而不是正则: 正则分不清 `//` 是在注释里还是在字符串里
// (源码里有 'http://...' 这种字面量, 正则会把后面全吃掉)。
function stripComments(src) {
  const s = String(src);
  let out = '';
  let i = 0;
  const n = s.length;
  while (i < n) {
    const c = s[i];
    const c2 = s[i + 1];
    // 行注释
    if (c === '/' && c2 === '/') {
      while (i < n && s[i] !== '\n') i++;
      continue;
    }
    // 块注释
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(s[i] === '*' && s[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    // 单引号 / 双引号 / 模板字面量 —— 原样保留, 里面的 // 不算注释
    if (c === "'" || c === '"' || c === '`') {
      const q = c;
      out += c; i++;
      while (i < n) {
        if (s[i] === '\\') { out += s[i] + (s[i + 1] || ''); i += 2; continue; }
        if (s[i] === q) { out += q; i++; break; }
        out += s[i]; i++;
      }
      continue;
    }
    out += c; i++;
  }
  return out;
}
const shadowCode = stripComments(shadowSrc);

// ==== 一、影子那份不许再自己实现摘要 (唯一的路 = session_compaction) ====

test('影子不再自己拼 summary 消息 (不许出现自己的摘要格式函数)', () => {
  assert.ok(!shadowCode.includes('_buildSummarizePrompt'),
    '影子不许自己写摘要 prompt —— 摘要怎么生成由 session_compaction 一家定');
  assert.ok(!shadowCode.includes('_formatSummaryMsg'),
    '影子不许自己拼 summary system 消息 —— 那正是两套格式并存的根因');
  assert.ok(!shadowCode.includes('_parseSummary'),
    '影子不许自己解析摘要 JSON —— 摘要格式由 session_compaction 一家定');
  assert.ok(!shadowCode.includes('_extractFirstJson'),
    '影子不许自己抽 JSON —— 那是它自己那套格式的配套件');
});

test('影子不许自己算 token (口径必须来自 session_compaction)', () => {
  assert.ok(!shadowCode.includes('estimateMessagesTokens'),
    '影子不许用 pangu_helpers.estimateMessagesTokens (chars x 0.35) —— '
    + '它比 session_compaction 的 chars/4 大 1.4 倍, 会先触发');
});

test('影子必须真的下沉到 session_compaction (有 require + 有调用)', () => {
  assert.ok(shadowSrc.includes("require('./session_compaction')"),
    '影子必须 require session_compaction —— 产物唯一真源');
  assert.ok(shadowSrc.includes('createCompactor'),
    '影子必须用 createCompactor 造压缩器');
});

// ==== 二、产物格式统一 = session_compaction 的【会话摘要】 ====

test('压缩产物是 session_compaction 的【会话摘要】格式 (不是影子那套)', () => {
  assert.ok(!shadowCode.includes('对话历史压缩'),
    '影子不许再出现它自己那套「对话历史压缩」标题 —— 那就是第二套摘要格式');
  assert.ok(!shadowCode.includes('运用规则'),
    '影子不许再出现它自己那套「运用规则」尾注 —— 同上');
});

test('影子产出的摘要能落进 session_store.compaction_summary (isCompactionSummary 标记)', () => {
  // j2_loop_shared._persistSession 取的是**最后一条** isCompactionSummary 的 content,
  // 去掉「【会话摘要】」前缀存进 session_store.compaction_summary。
  // 影子产物必须带这个标记, 否则摘要算出来仍然没人认。
  assert.ok(shadowSrc.includes('isCompactionSummary'),
    '影子必须认 isCompactionSummary 标记 —— 否则摘要算出来落不了盘');
  assert.ok(shadowSrc.includes('【会话摘要】'),
    '影子必须按【会话摘要】口径取摘要正文');
});

test('快照里存的是活的那份产出的摘要正文 (不是别的 system 消息)', async () => {
  // M4 的判据: 只判源码里有没有 'isCompactionSummary' 字样太弱 ——
  // 改「提取哪一条」照样能过。这里改成**行为**判据:
  // 快照的 summary 字段必须等于产物里那条 isCompactionSummary 消息的正文。
  const { compact } = require('../modules/compaction');
  const r = await compact(mkLongSession(30), { sessionId: 'unit-compact-summary-body' });
  assert.ok(r && r.ok, '压缩必须成功');
  const cs = r.messages.filter(m => m && m.isCompactionSummary);
  assert.ok(cs.length >= 1, '产物必须带 isCompactionSummary 标记');
  const body = String(cs[cs.length - 1].content || '').replace(/^【会话摘要】/, '').trim();
  assert.ok(body.length > 0, '摘要正文不许为空');
  assert.strictEqual(String(r.snapshot.summary || '').trim(), body,
    '快照 summary 必须就是那条 isCompactionSummary 的正文 —— '
    + '取错消息(比如随便一条 system)快照里就存了别的内容');
});

// ==== 三、token 口径跟活的那份一致 (chars/4) ====

test('影子 needsCompaction 的 token 口径 = chars/4 (跟 session_compaction 同一把尺)', () => {
  const { needsCompaction } = require('../modules/compaction');
  const { SessionCompaction } = require('../modules/session_compaction');
  const sc = new SessionCompaction();

  const mk = (n, len) => {
    const out = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < n; i++) out.push({ role: 'user', content: 'x'.repeat(len) });
    return out;
  };
  const msgs = mk(12, 1000);
  // chars = 3 (system 'sys') + 12*1000 = 12003
  //   chars/4        = 3001 token  (session_compaction 的口径)
  //   chars * 0.35   = 4202 token  (旧影子 estimateMessagesTokens 的口径)
  // ctx = 4000: 3001/4000 = 0.75 (不触发) vs 4202/4000 = 1.05 (触发)
  // ⇒ 这个 ctx 下**两种算法的结论正好相反**, 本条判据就分得开谁在用。
  assert.strictEqual(sc._estimateTokens(msgs), 3001,
    '前提: session_compaction 自己算的就是 3001 (chars/4)');

  const model = { id: '__test_ctx_4000__' };
  const registry = require('../modules/model_registry');
  const orig = registry.getContextLength;
  registry.getContextLength = (id) => (id === model.id ? 4000 : orig(id));
  try {
    assert.strictEqual(needsCompaction(msgs, model), false,
      '3001/4000 = 0.75 < 0.8 => 不触发; 旧口径会算成 1.05 => 会触发 (所以本条能分得开)');
  } finally {
    registry.getContextLength = orig;
  }
});

test('影子 needsCompaction 在跨过 ratio 时才触发 (真触发)', () => {
  const { needsCompaction } = require('../modules/compaction');
  const registry = require('../modules/model_registry');
  const model = { id: '__test_ctx_1000__' };
  const orig = registry.getContextLength;
  registry.getContextLength = (id) => (id === model.id ? 1000 : orig(id));
  try {
    const msgs = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 12; i++) msgs.push({ role: 'user', content: 'x'.repeat(1000) });
    // 12000 chars / 4 = 3000 token / 1000 ctx = 3.0 > 0.8 => 触发
    assert.strictEqual(needsCompaction(msgs, model), true, '3000/1000 远超 ratio, 必须触发');
  } finally {
    registry.getContextLength = orig;
  }
});

test('非 system 太少不触发 (少于此数压了反而丢上下文)', () => {
  const { needsCompaction } = require('../modules/compaction');
  const registry = require('../modules/model_registry');
  const model = { id: '__test_ctx_1000__' };
  const orig = registry.getContextLength;
  registry.getContextLength = (id) => (id === model.id ? 1000 : orig(id));
  try {
    const msgs = [{ role: 'system', content: 'sys' }];
    for (let i = 0; i < 4; i++) msgs.push({ role: 'user', content: 'x'.repeat(2000) });
    assert.strictEqual(needsCompaction(msgs, model), false, '4 条非 system 不够格压');
  } finally {
    registry.getContextLength = orig;
  }
});

test('ctx 拿不到时不猜 (registry miss => 不压)', () => {
  const { needsCompaction } = require('../modules/compaction');
  const msgs = [{ role: 'system', content: 'sys' }];
  for (let i = 0; i < 20; i++) msgs.push({ role: 'user', content: 'x'.repeat(2000) });
  assert.strictEqual(needsCompaction(msgs, { id: '__no_such_model_xyz__' }), false,
    '模型 ctx 探不到 => 不猜, 不压 (旧行为靠异常控制流, 现在显式)');
});

// ==== 四、产物必须过工具配对清洗 (影子老实现的致命伤) ====

function mkLongSession(n) {
  const msgs = [{ role: 'system', content: 'sys prompt' }];
  for (let i = 0; i < n; i++) {
    msgs.push({ role: 'user', content: '第 ' + i + ' 轮问题 ' + 'x'.repeat(200) });
    msgs.push({ role: 'assistant', content: '第 ' + i + ' 轮答复 ' + 'y'.repeat(200) });
  }
  msgs.push({ role: 'user', content: '最后一个问题' });
  return msgs;
}

test('影子 compact 的产物过工具配对清洗 (不产孤儿 tool result)', async () => {
  const { compact } = require('../modules/compaction');
  const msgs = mkLongSession(30);
  // 一条孤儿 tool result (父 assistant 不在数组里)
  msgs.splice(1, 0, { role: 'tool', tool_call_id: 'call_orphan', content: '{"ok":true}' });

  const r = await compact(msgs, { sessionId: 'unit-compact-pairing' });
  assert.ok(r && r.ok, '压缩必须成功, 否则这条测试测不到东西: ' + JSON.stringify(r && r.reason));
  const out = r.messages;
  const orphan = out.filter(m => m && m.role === 'tool' && m.tool_call_id === 'call_orphan');
  assert.strictEqual(orphan.length, 0, '孤儿 tool result 不许进产物 (会 MiniMax 400)');
  const callIds = new Set();
  for (const m of out) {
    if (m && m.role === 'assistant' && Array.isArray(m.tool_calls)) {
      for (const tc of m.tool_calls) if (tc && tc.id) callIds.add(tc.id);
    }
  }
  for (const m of out) {
    if (m && m.role === 'tool') {
      assert.ok(callIds.has(m.tool_call_id),
        'tool result ' + m.tool_call_id + ' 没有配对的 assistant tool_calls');
    }
  }
});

test('影子 compact 的产物 = session_compaction 的形状 (带 isCompactionSummary)', async () => {
  const { compact } = require('../modules/compaction');
  const r = await compact(mkLongSession(30), { sessionId: 'unit-compact-shape' });
  assert.ok(r && r.ok, '压缩必须成功');
  const cs = r.messages.filter(m => m && m.isCompactionSummary);
  assert.ok(cs.length >= 1, '产物必须带 isCompactionSummary 标记的摘要消息');
  assert.ok(/^【会话摘要】/.test(String(cs[cs.length - 1].content || '')),
    '摘要消息必须以【会话摘要】开头 (session_compaction 的格式)');
});

test('影子 compact 必须真的压短 (不许压完更长)', async () => {
  const { compact } = require('../modules/compaction');
  const msgs = mkLongSession(30);
  const r = await compact(msgs, { sessionId: 'unit-compact-shrink' });
  assert.ok(r && r.ok, '压缩必须成功');
  assert.ok(r.messages.length < msgs.length,
    '压完必须更短 (' + msgs.length + ' -> ' + r.messages.length + ')');
});

test('影子 compact 压不短时必须报失败 (不许把没压的产物交出去)', async () => {
  // M5 的判据: 只喂「本来就压得短」的会话, 删掉 not_shrunk 守卫照样过 ——
  // 因为底层压缩本来就短了, 行为没变。这里造一个**压不短**的场景:
  // 消息本来就少 (只有 2 条), session_compaction 的 clamp 会把产物留到 >= 原长。
  const { compact } = require('../modules/compaction');
  const msgs = [
    { role: 'system', content: 'sys' },
    { role: 'user', content: '问题' },
  ];
  const r = await compact(msgs, { sessionId: 'unit-compact-notshrink' });
  assert.strictEqual(r.ok, false,
    '没压短还不报失败 = 上层以为压过了, 下轮又触发 = 活锁');
  assert.strictEqual(r.reason, 'not_shrunk', '失败原因必须说清是没压短');
  assert.strictEqual(r.messages, msgs, '失败时必须把原 messages 原样退回');
});

test('影子 compact 保留最后一条 user (当前问题不许被压掉)', async () => {
  const { compact } = require('../modules/compaction');
  const msgs = mkLongSession(30);
  msgs[msgs.length - 1] = { role: 'user', content: '最后一个问题-不许丢' };
  const r = await compact(msgs, { sessionId: 'unit-compact-lastuser' });
  assert.ok(r && r.ok, '压缩必须成功');
  assert.ok(r.messages.some(m => m && m.role === 'user' && m.content === '最后一个问题-不许丢'),
    '当前问题必须留在产物里 (压掉 => 模型只剩摘要自由发挥)');
});

// ==== 五、快照落档保留 (session_compaction 不做这件事) ====

test('影子 compact 仍写快照 (回档证据依赖它)', async () => {
  const { compact, listSnapshots } = require('../modules/compaction');
  // M6 的判据: 快照目录跨运行累积, 上一轮跑剩的旧文件会让「落盘了」这条永远绿 ——
  // 空枪过一次。这里用**本轮唯一**的 sessionId, 旧的匹配不上。
  const sid = 'unit-compact-snap-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8);
  const r = await compact(mkLongSession(30), { sessionId: sid });
  assert.ok(r && r.ok, '压缩必须成功');
  assert.ok(r.snapshot && r.snapshot.id, '返回值必须带 snapshot 元');
  const snaps = listSnapshots(sid, 10);
  assert.ok(snaps.length >= 1,
    '快照必须落盘 (listSnapshots 依赖它); 本轮 sid=' + sid);
  assert.strictEqual(snaps[0].session_id, sid, '快照必须属于本轮这个 session');
  // 收尾: 把本轮自己的快照删掉 (别让下一轮的判据被上一轮的残留喂绿)
  try {
    const fs2 = require('node:fs');
    const p2 = require('node:path');
    // 2026-10-26 第 100 批: 压缩快照目录走唯一真源 (modules/state_paths.js)
    //   原来这里从 PANGU_HOME 算 ⇒ 链里 PANGU_HOME 没设 ⇒ 去**生产** ~/.pangu/state/compaction
    //   找本轮快照 (找不到 ⇒ 清理静默失败 ⇒ 快照在沙箱里越积越多)。
    const dir = require('../modules/state_paths').compactionDir();
    for (const f of fs2.readdirSync(dir)) {
      if (f.startsWith(sid)) fs2.unlinkSync(p2.join(dir, f));
    }
  } catch (_) { /* 清不干净不算失败, 下一轮用唯一 sid 兜着 */ }
});

// ==== 六、活的那份不许被改坏 (回归护栏) ====

test('session_compaction 自己仍过工具配对清洗 (没被本批改坏)', () => {
  const liveSrc = fs.readFileSync(LIVE_PATH, 'utf8');
  assert.ok(liveSrc.includes('_sanitizeToolPairing(compacted)'),
    'buildCompactedMessages 必须仍过 _sanitizeToolPairing');
});

test('影子只读活的那份的摘要, 不自己拼一个 (源码级)', () => {
  assert.ok(!shadowCode.includes('【会话摘要】{'),
    '影子不许自己拼一个【会话摘要】 —— 那又是第二套格式');
});
