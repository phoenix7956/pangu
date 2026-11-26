// 2026-10-28 第 133 批 —— 同一轮对话被塞进模型两遍的回归锁。
//
// 现场 (会话 web-1793124838326, 探针 probe-dup-20261028 / probe-bazi-t133):
//   客户端把「整段历史 + 本轮消息」一起发, 服务端 (a) 按注入后的 userInput 再追加一条本轮
//   (b) 从会话存储接回上一轮 (c) 连续性容器按注入版比对又把上一轮塞回来 ——
//   三处叠加, 同一个 user 消息进了模型两三遍。
//   后果实测: 追问轮的答案长度跟上一轮**一模一样** (1836) —— 模型在复读;
//   对齐门连拦两次 (ALIGNMENT_RETRY #1 #2), 一轮 116 秒。
//
// 本文件锁死三条口径:
//   ① 本轮 user 消息**替换**而不是追加 (客户端已经带了)
//   ② 原话口径唯一 (coreUserText) —— 注入块前缀版/后缀版都要能还原成原话
//   ③ 接回上一轮时图片不能丢 (课件图丢了, 后面每轮只能靠 OCR 文本猜)
const assert = require('assert');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  ensureCurrentUserMessage, coreUserText,
} = require('../modules/answer_alignment');
const { _extractPriorTurns } = require('../modules/j2_loop_shared');

test('本轮 user 消息: 客户端已经带了 ⇒ 替换成注入版, 不追加', () => {
  const raw = '排查一下 apps/core 里有没有硬编码的密钥';
  const injected = raw + '\n\n【排盘事实 · 本地确定性计算】\n四柱: 乙卯';
  const before = [
    { role: 'user', content: '上一轮问题' },
    { role: 'assistant', content: '上一轮答案' },
    { role: 'user', content: raw },
  ];
  const after = ensureCurrentUserMessage(before, injected, [], raw);
  assert.strictEqual(after.length, before.length, '不许多出一条 user 消息');
  assert.strictEqual(after[after.length - 1].content, injected, '本轮要用注入后的版本');
  assert.strictEqual(after[after.length - 1].raw, raw, '原话要留着 (落盘/UI 显示用)');
  assert.strictEqual(after.filter(m => m.role === 'user' && m.content === injected).length, 1);
});

test('本轮 user 消息: 客户端没带 ⇒ 照旧追加一条', () => {
  const after = ensureCurrentUserMessage(
    [{ role: 'user', content: '上一轮问题' }],
    '这一轮的问题', [], '这一轮的问题');
  assert.strictEqual(after.length, 2);
  assert.strictEqual(after[1].content, '这一轮的问题');
});

test('本轮 user 消息: 纯图片轮 (没带 input) 也要替换, 不追加', () => {
  const after = ensureCurrentUserMessage(
    [{ role: 'user', content: '看图', images: ['/tmp/a.png'] }],
    '【盘古起卦…】看图', ['/tmp/a.png'], '');
  assert.strictEqual(after.length, 1, '图片轮也不能多一条');
  assert.deepStrictEqual(after[0].images, ['/tmp/a.png'], '图片不能丢');
});

test('原话口径: 注入块前缀版/后缀版都要能还原成原话', () => {
  const raw = '男，1975年2月8日10时05分，四川成都，排八字';
  assert.strictEqual(
    coreUserText('【盘古起卦 · 先于推理 (梅花易数)】\n本卦: 睽\n主人问题: ' + raw),
    raw);
  assert.strictEqual(coreUserText(raw + ' 【分层编排】这题走「生辰命理」'), raw);
  assert.strictEqual(coreUserText(raw + '\n\n【排盘事实 · 本地确定性计算】\n四柱: 乙卯\n纪律: xx'), raw);
  assert.strictEqual(coreUserText('做题'), '做题');
});

test('接回上一轮: user 消息用原话, 图片必须一起接回', () => {
  const prior = [
    { role: 'user', content: '【盘古起卦…】主人问题: 看这张课件图', raw: '看这张课件图', images: ['/tmp/ke.png'] },
    { role: 'assistant', content: '答案' },
  ];
  const turns = _extractPriorTurns(prior);
  assert.strictEqual(turns.length, 2);
  assert.strictEqual(turns[0].content, '看这张课件图', '要原话, 不是注入块拼过的版本');
  assert.deepStrictEqual(turns[0].images, ['/tmp/ke.png'], '课件图丢了, 后面每轮只能靠 OCR 文本猜');
});

// ─────────────────────────────────────────────────────────────
// 第 134 批: **读**的时候也要剥成原话 —— 老会话没有 `raw` 字段
// ─────────────────────────────────────────────────────────────
//
// 现场 (会话 web-1793124838326, 老板「头部重复」「全乱了」):
//   第 133 批之前存的老会话, user 消息存的是给模型看的脚手架版本:
//   「【盘古起卦 …】<卦块> 主人问题: <原话>【排盘事实 …】」
//   落盘时没有 `raw`, 所以**写的时候剥不掉, 读的时候也得剥** ——
//   否则 UI 永远显示卦块和排盘事实 (而 133 批之后新写的会话是干净的, 造成「有的会话乱有的不乱」)。
//   口径必须同一个函数 (coreUserText) —— 前端不许再抄一份。
test('读出来的 user 消息: 老会话 (无 raw) 也要剥成主人原话, 注入版另存 injected', () => {
  const raw = '是原主出生地附近的情况，不是四川盆地的情况';
  const scaffold = '【盘古起卦 · 先于推理 (梅花易数, 64i 真卦辞爻辞)】\n本卦: 鼎 ䷱ (离上巽下)\n'
    + '主人问题: ' + raw + '\n\n【排盘事实 · 本地确定性计算】\n四柱: 乙卯 / 戊寅 / 乙酉 / 辛巳\n纪律: 禁止凭记忆另算十神';
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-load-clean-'));
  const prevSess = process.env.PANGU_SESSIONS_DIR;
  const prevDb = process.env.PANGU_AGENTDB_DIR;
  process.env.PANGU_SESSIONS_DIR = path.join(dir, 'sessions');
  process.env.PANGU_AGENTDB_DIR = path.join(dir, 'agentdb');
  fs.mkdirSync(process.env.PANGU_SESSIONS_DIR, { recursive: true });
  fs.writeFileSync(path.join(process.env.PANGU_SESSIONS_DIR, 'old-sess-134.json'), JSON.stringify({
    session_id: 'old-sess-134', state: 'completed', message_count: 2, last_updated: Date.now(),
    messages: [
      { role: 'user', content: scaffold },
      { role: 'assistant', content: '答复' },
    ],
  }));
  delete require.cache[require.resolve('../modules/session_store')];
  const ss = require('../modules/session_store');
  return ss.sessionLoad({ session_id: 'old-sess-134' }).then(r => {
    const u = (r.result.messages || []).find(m => m.role === 'user');
    assert.strictEqual(u.content, raw, '读出来必须是主人原话 (UI 要显示的)');
    assert.strictEqual(u.raw, raw, 'raw 要补上 (前端按 raw 显示)');
    assert.ok(u.injected && u.injected.includes('【排盘事实'), '注入版不许丢 (四柱事实只在注入块里)');
    if (prevSess === undefined) delete process.env.PANGU_SESSIONS_DIR;
    else process.env.PANGU_SESSIONS_DIR = prevSess;
    if (prevDb === undefined) delete process.env.PANGU_AGENTDB_DIR;
    else process.env.PANGU_AGENTDB_DIR = prevDb;
    delete require.cache[require.resolve('../modules/session_store')];
  });
});
