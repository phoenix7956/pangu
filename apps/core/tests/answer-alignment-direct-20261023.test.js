'use strict';

// 2026-10-23 第 72 批 —— 「索要短答案」的识别补全
//
// 起因 (实跑 + 日账本逮到的):
//   跑一轮真对话, 问「只回两个字：收到」, 模型答「收到」, 盘古回:
//     「本轮未形成与原问题匹配的可核验答案，请重试。」
//   复现: 短答案豁免的动词表只认「只+回复/回答/答/返回/给出/说」,
//   **「只回」「只给」这两个最自然的说法全漏** ⇒ 豁免不触发 ⇒ 落到词法对齐
//   ⇒ 「收到」被判跑题。
//   日账本 ~/.pangu/alignment-blocked.jsonl 里 10-03 那条一模一样:
//     问「最终仅回答一个字：好」答「OK」→ 被拦。
//
// 这批做的事: 把「只要一个短答案」这个信号的识别补全, 同时**不许放松**跑题检测。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const A = require(path.join(CORE, 'modules', 'answer_alignment.js'));
const SRC = fs.readFileSync(path.join(CORE, 'modules', 'answer_alignment.js'), 'utf8');

const blocked = (q, a, ev = '') => !!(A.guardAnswer(q, a, '', ev).blocked);

// ---------- A 组: 索要短答案的说法必须放行 ----------

test('A1 「只回两个字」这类说法要放行 (本批真跑复现的那一条)', () => {
  assert.strictEqual(blocked('只回两个字：收到', '收到'), false);
  assert.strictEqual(blocked('只回两个字：收到', '好的，收到'), false);
  assert.strictEqual(blocked('只给我两个字：收到', '收到'), false);
  assert.strictEqual(blocked('最终仅回答一个字：好', 'OK'), false);
  // ⚠️ 下面两条只被**动词表**覆盖(「只+回」/「直接+回」), 不带「N个字/句话/个数」——
  //   那条信号删掉时它们必须红, 否则动词表是白加的。
  // ⚠️ 问句长度必须 ≥6: isAligned 第 202 行 `q.length < 6 → 直接放行`,
  //   短问句压根不进词法路径, 拿它当判据是自欺。
  assert.strictEqual(blocked('只回我一句就行', '收到'), false);
  assert.strictEqual(blocked('直接回我一行字', '收到'), false);
});

test('A2 2026-10-14 修过的那些形状不许回退', () => {
  assert.strictEqual(blocked('请只回复:收到', '收到'), false);
  assert.strictEqual(blocked('请只回复：收到', '已收到，谢谢'), false);
  // ⚠️ 这条是**点名答案**那条分支的锁: 答案 12 字以上, 短答案豁免(length<12)救不了它,
 //   只有「问题点名了要『收到』→ 答案里带上它就算对齐」这条能放行。删掉它 ⇒ 这条红。
  // ⚠️ 答案里**不许**再出现「回复」二字 —— terms() 会切 2-gram, 「回复」「收到」两个锚点
  //   一凑齐, 词法路径自己就放行了, 这条判据就测不出「点名答案」分支的价值。
  assert.strictEqual(blocked('请只回复:收到', '收到，已经按你的要求处理完毕。'), false);
  assert.strictEqual(blocked('1+1等于几？直接回答数字。', '2'), false);
  assert.strictEqual(blocked('只回答两个字', '收到'), false);
  assert.strictEqual(blocked('只说一句', '好'), false);
});

test('A3 「N个字」这个独立信号要认 (不管动词是什么)', () => {
  assert.strictEqual(blocked('回两个字就好', '收到'), false);
  assert.strictEqual(blocked('给我三个字', '已处理'), false);
});

test('A4 「N个字：X」这个形状, 答案在冒号后面 —— 要认出来', () => {
  // 长答案也认: 主人点名了要「收到」, 答案里带着它就算对齐
  // ⚠️ 同上: 答案里不许再出现「两个字」, 否则词法路径(2-gram 锚点)会兜住, 测不出这条分支
  assert.strictEqual(blocked('只回两个字：收到', '收到，已经按你的要求处理完毕。'), false);
});

test('A5 「只要一个数」是索要直接答案, 要放行', () => {
  assert.strictEqual(blocked('只要一个数', '42'), false);
});

// ---------- B 组: 跑题必须仍然拦 (既有回归锁不许放松) ----------

test('B1 「检查路由 bug」答「天气不错」仍然要拦', () => {
  assert.strictEqual(blocked('检查一下路由 bug', '天气不错'), true);
});

test('B2 长问题 + 无共同词 + 短答案, 仍然要拦', () => {
  assert.strictEqual(blocked('把三个文件各自解决什么问题说清楚', '天气不错'), true);
});

test('B3 不是索要短答案的问题, 短跑题答案不许被放行', () => {
  assert.strictEqual(blocked('读一下 role_model.js 里的 ROLE_TIER 有几个角色', '不知道'), true);
});

// ---------- C 组: 信号不许过度 (防"为了修一个误杀, 造出另一个误放") ----------

test('C1 「第N字段」不是「N个字」 —— 字段数不许被当成要短答案', () => {
  assert.strictEqual(blocked('第三字段怎么填?', '随便写点什么都行'), true);
  assert.strictEqual(blocked('3个字段怎么填?', '随便写点什么都行'), true);
});

test('C2 「这几个数字对不对」是核对请求, 不是要一个数 —— 「不太确定」这种非答案要拦', () => {
  assert.strictEqual(blocked('这几个数字对不对?', '不太确定'), true);
});

test('C3 「说三句话总结」要的是总结(可以很长), 不是短答案 —— 糊弄答案要拦', () => {
  assert.strictEqual(blocked('说三句话总结这次改动', '一二三'), true);
});

// ---------- D 组: 源码形状 ----------

test('D1 短答案豁免那行的形状不许变 (2026-10-14 的回归锁)', () => {
  assert.match(SRC, /_wantsDirect && a\.length < 12\) return true;/,
    '豁免的长度上界那行必须原样保留 —— 改了它就等于把短答案全部放行');
});

test('D2 信号必须收在具名常量里, 不许再内联一份', () => {
  assert.match(SRC, /const _WANTS_DIRECT_RE = \//,
    '「索要短答案」的正则必须只有一处定义');
  assert.ok(!/const _wantsDirect = \/\(/.test(SRC),
    '不许又内联一份正则 —— 那就回到"同一件事两份实现"');
  assert.match(SRC, /const _wantsDirect = _WANTS_DIRECT_RE\.test\(_qRaw\);/);
});

test('D3 「N个字」后面不许跟「段」, 否则「3个字段」会被当成要三个字', () => {
  assert.match(SRC, /个字\(\?!段\)/,
    '必须在正则里挡住「个字+段」这个组合');
});
