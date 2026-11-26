'use strict';
// 2026-10-12 回归: 老板拍「根本性解决问题才是」— 会话 80922578 的两个根因, 机制级修复。
//
// 根因 A: 图在子 agent 链路里整段丢失。
//   UI 附图只挂在 messages 的 user 消息上, 主 agent 经 llm_caller._adaptImagesForModel 看得见;
//   但 dispatcher 派生的子 agent 只拿到纯文字 task + "[附图 N 张]" 一行字 ——
//   analyzer 看不到盘面, 只能 list_directory "/" 满世界找图 (实案, 9/18 起共 7 次),
//   或者被主人一纠正就跟着翻面 (没有独立证据源, 主人的话成了唯一信号 → 身强身弱翻 4 次)。
//   修: ①dispatcher 收集本会话的图 (_collectDialogImages) 透传给 fixed_flow/planner/兜底
//       三条链路的子 agent 和综合 LLM; ②sub-agent.callLLM 原来把 messages 原样 JSON 序列化,
//       images 字段被上游忽略 —— 新增 _prepareMessagesForModel 按模型视觉能力落地
//       (vision → 多模态块 / 非 vision → "图未发送"诚实说明 / Anthropic → source 块)。
//
// 根因 B: 纠错纪律只有提示词, 没有机制 —— 模型照样可以零核验翻面。
//   修: answer_alignment 新增 isCorrectionTurn/isBareFlip 机制判定; dispatcher 在纠错轮
//   对子 agent 答复做事后核验, "顺从措辞 + 0 工具 + 无可核验来源"的答复不许进综合,
//   强制复核一轮; 复核仍空翻面 → "维持待定"的诚实文案顶替。
const assert = require('assert');
const fs = require('fs');
const path = require('path');

const { isCorrectionTurn, isBareFlip } = require('../modules/answer_alignment');
const { _collectDialogImages } = require('../modules/j2_dispatcher');
const { _prepareMessagesForModel } = require('../agents/sub-agent');

const SRC = (rel) => fs.readFileSync(path.join(__dirname, '..', rel), 'utf8');

// ─────────────────────────────────────────────────────────────────────────────
// ① 图像透传: dispatcher 必须把本会话的图收出来 (子 agent 的独立证据源)
// ─────────────────────────────────────────────────────────────────────────────
const _imgs = _collectDialogImages([
  { role: 'user', content: '做题，要看清楚图', images: ['data:image/png;base64,AAA'] },
  { role: 'assistant', content: '运势偏弱, 宜守不宜攻…' },
  { role: 'user', content: '为什么偏强? 肯定偏弱啊?' },  // 追问轮不附图, 图要能从历史轮捞到
]);
assert.deepStrictEqual(_imgs, ['data:image/png;base64,AAA'],
  '① 追问轮必须能从历史 user 消息捞到图 — 捞不到 = 子 agent 永远没有盘面这个证据源');

// 上限 3 张, 最近的优先且保持时间顺序
const _many = _collectDialogImages([
  { role: 'user', content: 'q1', images: ['i1', 'i2'] },
  { role: 'user', content: 'q2', images: ['i3', 'i4'] },
]);
assert.deepStrictEqual(_many, ['i2', 'i3', 'i4'],
  '①b 图超过 3 张时取最近的 3 张 (防上下文爆炸), 保持时间顺序');

// 无图会话行为不变
assert.deepStrictEqual(_collectDialogImages([{ role: 'user', content: 'q' }]), [],
  '①c 无图会话返回空数组, 行为不变');

// dispatcher 三条链路都必须把图传下去 (源码级契约, 防回退)
const _dispSrc = SRC('modules/j2_dispatcher.js');
assert.ok((_dispSrc.match(/images: _dialogImages,/g) || []).length >= 3,
  '①d fixed_flow / 纠错复核 / 关键词兜底三处 subAgent.run 都要传 images: _dialogImages');
// 2026-10-18 修正 (这条断言**卡死了整条测试链**, 害得链在它这儿 exit=1 直接断,
//   后面排着的几十个测试包括当轮新加的一个都没跑到 —— "写得对但没人跑"是最贵的坏):
//   ①e 原来断言 `_subUserMsg.images = _dialogImages` 出现在 **j2_dispatcher.js** 里,
//   但 5612cb1 (派发机制抽成 subagent_runner) 之后 `_subUserMsg` 这个符号在
//   j2_dispatcher.js 里**已经不存在了** —— 它连同挂图那行搬去了 subagent_runner.js:563。
//   **行为本身没坏**: dispatcher 三处 `images: _dialogImages` (①d) 和三处 summaryMessages
//   挂图 (①f) 都还在, 跑挂图的功能是正常的; 坏的只是这条断言钉在了搬家前的位置上。
//   所以不是"实现回退了要修代码", 是"断言过期了要改断言" —— 改成查新家。
const _runnerSrc = SRC('modules/subagent_runner.js');
assert.ok(_runnerSrc.includes('_subUserMsg.images = _dialogImages'),
  '①e planner 路径的子 agent 消息也要挂图 (5612cb1 起这行在 subagent_runner.js, 不在 j2_dispatcher.js)');
// 2026-10-23(第 65 批): 关键词兜底那两条路**共用**了一个收口(原来是一字不差的两份抄本),
//   于是「内联 summaryMessages 挂图」的地方从 3 处变 2 处 —— 少的那一处**不是漏了**,
//   是两条路合成了一条(两条路仍都由同一份 summaryMessages 出品, 所以还是都挂图)。
//   意图一个字没变: 每条综合链路都得把图传下去。
//
// 2026-10-25(第 87 批): 主路与 fixed_flow 的图传递也收进了 `_buildSynthesisMessages(..., images)`
//   一个入口 —— 「内联 summaryMessages 挂图」从 2 处变 1 处 (关键词兜底仍自己拼: 它与主路有意不同,
//   汇报在前、工具证据在后, 且不跑排盘守卫)。
//   ⚠ 少的那一处**不是漏了**: 两条路现在都经 `_buildSynthesisMessages` 把图交进去,
//   而且**主路以前根本没挂图** (只有 fixed_flow 和关键词兜底有) —— 这一批把它补上了。
//   ⇒ 断言跟着搬家, 并且改成**逐条点名**: 内联挂图 ≥1 处 (关键词兜底)
//   + 经共享 builder 挂图 ≥2 处 (主路 + fixed_flow) = 三条综合路一条都不许少。
const _imgInline = (_dispSrc.match(/images: _dialogImages \}/g) || []).length;
const _imgViaBuilder = (_dispSrc.match(/_buildSynthesisMessages\([^)]*_dialogImages\)/g) || []).length;
assert.ok(_imgInline >= 1 && _imgViaBuilder >= 2,
  '①f 综合 LLM 的 summaryMessages 都要挂图 (追问轮综合只能凭转述定稿的旧行为不许回来) —— '
  + '内联 ' + _imgInline + ' 处 + 经 _buildSynthesisMessages ' + _imgViaBuilder + ' 处, 三条路一条都不能少');
// 反向钉住: 关键词兜底仍是**两条**路, 两条都得走那个挂图的收口(不然就是漏了一条路)
assert.ok((_dispSrc.match(/await _keywordFallbackCloseOut\(results\);/g) || []).length === 2,
  '①f 关键词兜底仍是两条路, 都得走那个挂图的收口');

// ─────────────────────────────────────────────────────────────────────────────
// ② 序列化落地: 子 agent 的 callLLM 必须先过 _prepareMessagesForModel
//    (旧行为: messages 原样 JSON 序列化, images 字段被上游忽略 = 图发不出去)
// ─────────────────────────────────────────────────────────────────────────────
const _saSrc = SRC('agents/sub-agent.js');
assert.ok(_saSrc.includes('messages = _prepareMessagesForModel(messages, modelConfig, useAnthropic);'),
  '② callLLM 序列化前必须过 _prepareMessagesForModel — 删掉这行 = 图又发不出去');

// vision 模型 → 多模态 content blocks
const _vision = _prepareMessagesForModel(
  [{ role: 'user', content: '看图做题', images: ['data:image/png;base64,AAA'] }],
  { id: 'minimax_m3.1-flash-preview', vision: true }, false);
assert.ok(Array.isArray(_vision[0].content)
  && _vision[0].content.some(b => b.type === 'image_url' && b.image_url.url === 'data:image/png;base64,AAA')
  && !_vision[0].images,
  '②b vision 模型 (会话 80922578 的 minimax_m3.1-flash-preview) 必须拿到 image_url 块, images 字段抹掉');

// 非 vision 模型 → 诚实说明, 不许幻觉声称看到了图
const _novision = _prepareMessagesForModel(
  [{ role: 'user', content: '看图做题', images: ['data:image/png;base64,AAA'] }],
  { id: 'deepseek-r1', vision: false }, false);
assert.ok(typeof _novision[0].content === 'string' && _novision[0].content.includes('未开启视觉')
  && _novision[0].content.includes('不要声称看到了图片内容'),
  '②c 非 vision 模型必须附"图未发送"说明, 防幻觉声称看到了图');

// Anthropic 协议 → source base64 块
const _anth = _prepareMessagesForModel(
  [{ role: 'user', content: '看图做题', images: ['data:image/png;base64,AAA'] }],
  { id: 'claude-sonnet-4', vision: true }, true);
assert.ok(Array.isArray(_anth[0].content)
  && _anth[0].content.some(b => b.type === 'image' && b.source && b.source.type === 'base64' && b.source.media_type === 'image/png'),
  '②d Anthropic 协议必须把 image_url 转成 source base64 块');

// 无图消息原样通过
const _plain = _prepareMessagesForModel([{ role: 'user', content: '纯文字' }], { id: 'x' }, false);
assert.deepStrictEqual(_plain, [{ role: 'user', content: '纯文字' }], '②e 无图消息不受影响');

// ─────────────────────────────────────────────────────────────────────────────
// ③ 纠错轮机制判定: isCorrectionTurn / isBareFlip
// ─────────────────────────────────────────────────────────────────────────────
const _answered = [{ role: 'assistant', content: '丁火日主生未月, 火土燥旺, 判偏弱宜守不宜攻。'.repeat(3) }];
assert.ok(isCorrectionTurn('为什么偏强? 肯定偏弱啊?', _answered), '③ 真实纠正句必须命中 (会话 80922578 原话)');
assert.ok(!isCorrectionTurn('为什么偏强? 肯定偏弱啊?', []), '③b 本会话没有实质答复时不算纠错轮');
assert.ok(!isCorrectionTurn('2027 年的流年运势如何?', _answered), '③c 普通追问不误伤');

// 实案翻面原话 → 必须判 bare flip
assert.ok(isBareFlip('你说得对, 更应判偏弱。', []),
  '③d "你说得对, 更应判偏弱" (0 工具, 无来源) = 无依据改口, 必须拦');
// 有可核验来源 → 放行
assert.ok(!isBareFlip('你说得对, 我重新排盘后确认: 丁火生未月虽得余气, 但两土泄火, 应判偏弱。', []),
  '③e 引用了重算/核验的改口放行');
// 调过工具 → 放行 (工具结果就是证据)
assert.ok(!isBareFlip('你说得对。', ['bazi_calc']), '③f 本轮真调过工具的答复放行');
// 无顺从措辞的正常答复 → 放行 (verify-002 实测答复形态)
assert.ok(!isBareFlip('你说"偏弱"是有依据的: 丁火生未月, 虽得午未余气, 但戊己耗身, 不宜判偏强。', []),
  '③g 有推理无顺从措辞的答复不误伤');

// dispatcher 里必须有强制复核的机制接线 (源码级契约)
assert.ok(_dispSrc.includes('correction_recheck') && _dispSrc.includes('isBareFlip(r.summary, r.toolsUsed)'),
  '③h fixed_flow 纠错轮必须接 isBareFlip 强制复核 — 光注提示词是软约束, 拦不住零核验翻面');
assert.ok(_dispSrc.includes('结论维持待定'),
  '③i 复核仍空翻面时必须有"维持待定"的诚实顶替文案');

console.log('image-passthrough-correction-20261012 tests: ok (①②③)');
