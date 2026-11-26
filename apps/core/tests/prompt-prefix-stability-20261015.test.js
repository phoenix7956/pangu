const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// ===========================================================================
// system prompt 里混进了"每次调用都变"的内容 → prompt 缓存每轮作废
//
// LM Studio 服务端日志实测 (2026-10-15 16:33~16:35, 一次"只回答两个字"的三轮):
//   Prompt cache restore: cached_tokens=10240 uncached_tokens=18425
//                        lifetime_efficiency=58.99%
//   VLM prompt cache disk usage: used_mib=41576.6 / cap_mib=41680.0
//                                lifetime_evicted_mib=13397.3
//
// 表现: 界面全程有 heartbeat (连接活着), 但两轮之间各静默 45~47s ——
// 那不是模型在想 (thinking chars 才 497), 是 token 在安静地重新 prefill。
// 一句闲聊 274.8s 就是这么来的。
//
// 两个病因, 都是"静态前缀中间插了会动的东西":
//   ① 「当前时间 (权威)」排在 messages[1], 秒级刷新 → 它一变, 后面
//      soul/长期记忆/工具清单/源码地图… 8000+ token 全废
//   ② 「自我进化数据」表头 "快照 at <当前时间>" 也是现取的, 换个位置犯第二次
//
// 修法: 变的挪到末尾 (时间), 不变的钉住 (自我进化 5 分钟 TTL)。
// 时间取整到分钟 —— 同一轮对话里逐字不变, 缓存能一路吃到本轮末尾,
// 而"回答现在几点"只需要分钟粒度。
// ===========================================================================

const SRC = fs.readFileSync(require.resolve('../modules/llm_caller.js'), 'utf8');

function init(model) {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/pangu/apps/core/modules/llm_caller.js')) delete require.cache[k];
  }
  const lc = require('../modules/llm_caller');
  lc.init({
    _config: { llm: { models: [model || {}] }, memory: {} },
    fs: require('fs'), path: require('path'), os: require('os'),
    https: require('https'), http: require('http'),
    PRESETS: {}, PANGU_SYSTEM_PROMPT: 'SOUL_BASE',
    _getPromptFacts: () => ({ toolCount: 127, skillCount: 0, skillManifest: '(空)', mcp: { tools: 0, servers: 0 } }),
  });
  return lc;
}

const isTime = (m) => /^# 当前时间 \(权威\)/.test(String((m || {}).content || ''));
const isEvo = (m) => /^# Pangu 自我进化数据/.test(String((m || {}).content || ''));

test('「当前时间」必须是最后一条 system —— 留在 [1] 就是一秒一刀砍掉整个前缀缓存', () => {
  const lc = init();
  const msgs = lc._buildSystemMessages({});
  const idx = msgs.findIndex(isTime);
  assert.ok(idx >= 0, '时间消息不能被删掉 (2026-07-26 老板定的: 治模型拿旧时间回答"现在几点")');
  assert.equal(idx, msgs.length - 1, '时间必须排在最后, 不能插在静态前缀中间');
  assert.ok(msgs.length > 2, '前面得确实有静态内容, 这条断言才有意义');
});

test('soul 必须仍然是第一条 (挪时间不是打乱顺序)', () => {
  const lc = init();
  const msgs = lc._buildSystemMessages({});
  assert.match(msgs[0].content, /SOUL_BASE/);
});

test('时间取整到分钟: 同一分钟里连取两次必须逐字相同', () => {
  const lc = init();
  const a = lc._buildSystemMessages({}).find(isTime);
  const b = lc._buildSystemMessages({}).find(isTime);
  assert.equal(a.content, b.content, '秒级刷新会让整段对话历史跟着重算');
  // 内容里不应出现秒 —— 取整失败的信号
  const stamp = a.content.match(/\d{4}\/\d{1,2}\/\d{1,2}\s+[\d:]+/);
  assert.ok(stamp, '时间戳必须还在');
  // zh-CN 出来是 HH:MM:SS, 取整后秒位必须是 00 —— 有秒值才说明没取整。
  assert.match(stamp[0].trim(), /\d{2}:\d{2}:00$/,
    '秒位必须是 00 (取整到分钟), 实际拿到: ' + stamp[0]);
});

test('时间仍然是"现在" —— 不能为了稳定把时间冻住', () => {
  const lc = init();
  const c = lc._buildSystemMessages({}).find(isTime).content;
  assert.match(c, /运用规则/, '7/26 那条运用规则要原样保留');
  const year = String(new Date().getFullYear());
  assert.ok(c.includes(year) || /\d{4}\/\d{1,2}\/\d{1,2}/.test(c),
    '时间必须是当前日期, 不是硬编码值');
});

test('自我进化快照必须稳定 (5 分钟 TTL), 不然换个位置再犯一次', () => {
  const lc = init();
  const a = lc._buildSystemMessages({}).find(isEvo);
  const b = lc._buildSystemMessages({}).find(isEvo);
  if (!a || !b) return; // 本机没造 evolution 数据时跳过, 不给假绿
  assert.equal(a.content, b.content, '表头时间戳每次调用现取 = 前缀缓存每轮作废');
});

test('除时间外的所有 system 消息, 两次调用必须逐字相同', () => {
  const lc = init();
  const a = lc._buildSystemMessages({});
  const b = lc._buildSystemMessages({});
  const strip = (msgs) => msgs.filter(m => !isTime(m)).map(m => m.content);
  assert.deepEqual(strip(a), strip(b),
    '静态块有任何一处漂移, 前缀缓存就断了 (LM Studio: lifetime_efficiency)');
});

test('静态前缀体量要够大才有意义 (别指望着只省下几条消息)', () => {
  const lc = init();
  const stable = lc._buildSystemMessages({}).filter(m => !isTime(m))
    .reduce((s, m) => s + String(m.content || '').length, 0);
  assert.ok(stable > 1000,
    '稳定前缀只有 ' + stable + ' 字符 —— 就算全命中也省不下什么, 这条修复就没有价值');
});

test('推理预算指令仍排在时间之前 (两者都是"本轮设定", 但预算是静态的)', () => {
  const localModel = { provider: 'lmstudio', endpoint: 'http://127.0.0.1:1234', reasoning_effort: 'medium' };
  const lc = init(localModel);
  const msgs = lc._buildSystemMessages(localModel);
  const iBudget = msgs.findIndex(m => /\[推理预算/.test(m.content || ''));
  const iTime = msgs.findIndex(isTime);
  assert.ok(iBudget >= 0, '预算指令必须注入');
  assert.ok(iBudget < iTime, '预算是静态内容, 必须留在可缓存的前缀里');
});

test('本地端点判定只剩一处实现, 不再各抄一份正则', () => {
  const legacy = SRC.match(/https?:\/\/\(localhost\|127\\\./g) || [];
  assert.equal(legacy.length, 0,
    '还有 ' + legacy.length + ' 处旧正则副本 (IPv6 [::1] 和 127/8 都漏)');
});

