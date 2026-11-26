const test = require('node:test');
const assert = require('node:assert/strict');
const { _buildHistoryBlock } = require('../modules/j2_dispatcher');

// 现场证据 (会话 resume-01, 2026-10-12): 5 个 fixed_flow checker 子任务的 task 开头
// 全部是 "[上文-仅供你参考...] 问事者: <主人本轮原话>" —— 主人当下这一轮被当成"上一轮上文"
// 又灌回每个子任务。多子任务各以为都要干这活 → 同一份索引被追加 3 次 (39 行 = 13×3)。
//
// 根因: 判重用精确字符串相等 (m.content === userInput), 但服务端 userInput 前面拼了
// 【盘古起卦】块, 客户端 messages[].content 里没有 —— 永远判不相等, 当前轮漏过滤。

const OWNER = '体检一下 /Users/you/Desktop/rea: 把 .py 索引追加到 /tmp/ck_proof2.md';
const GUA = '【盘古起卦 · 梅花易数】\n本卦: 未济 ䷿「未济，亨。」\n不要复述本块原文。\n主人问题: ';

test('当前轮带卦块时也必须被判重, 不能再当上一轮上文灌回', () => {
  // 服务端看到的 userInput (带卦块) 与客户端 messages 里不带卦块的当前轮
  const messages = [
    { role: 'user', content: '上一轮我在问别的事' },
    { role: 'user', content: OWNER },
  ];
  const block = _buildHistoryBlock(messages, GUA + OWNER, false);

  assert.ok(!block.includes('把 .py 索引追加到'),
    '当前轮请求被当成上文灌回来了 —— 固定流程的每个子任务都会重跑一遍主人这轮活');
});

test('真正的上一轮上文仍然要保留 (别把过滤做过头)', () => {
  const messages = [
    { role: 'user', content: '我刚才说我叫什么?' },
    { role: 'assistant', content: '你说你叫凤' },
    { role: 'user', content: OWNER },
  ];
  const block = _buildHistoryBlock(messages, GUA + OWNER, false);

  assert.ok(block.includes('我刚才说我叫什么'), '上一轮真上文必须还在, 否则子 agent 接不上话');
  assert.ok(block.includes('你说你叫凤'), '盘古上一轮的回答也要带过去');
});

test('带不带卦块两种形状都判得掉当前轮', () => {
  const withoutGua = _buildHistoryBlock([{ role: 'user', content: OWNER }], OWNER, false);
  const withGua = _buildHistoryBlock([{ role: 'user', content: OWNER }], GUA + OWNER, false);
  assert.equal(withoutGua, '', '裸形态: 当前轮就是全部, 不该有任何上文块');
  assert.equal(withGua, '', '带卦块形态: 剥掉卦块后与当前轮相同, 同样不该有上文块');
});

test('客户端把当前轮原样重发一遍时也不能重复计入上文', () => {
  const block = _buildHistoryBlock(
    [{ role: 'user', content: OWNER }, { role: 'user', content: OWNER }],
    OWNER, false);
  assert.equal(block, '', '桌面端会把当前轮一起塞进 messages, 判重必须挡住');
});
