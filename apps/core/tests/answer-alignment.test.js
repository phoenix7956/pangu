const assert = require('assert');
const { isAligned, guardAnswer, resolveTaskInput, stripGuaPrefix, ensureCurrentUserMessage, isSelfInspection, hasSelfInspectionEvidence } = require('../modules/answer_alignment');

assert.match(resolveTaskInput('ok，去干吧', [
  { role: 'user', content: '把排盘页面补上出生地、分钟、藏干和大运流年' },
  { role: 'assistant', content: '我已摸清现状' },
]), /把排盘页面补上出生地、分钟、藏干和大运流年/);
assert.strictEqual(resolveTaskInput('什么情况', [{ role: 'user', content: '上一条任务' }]), '什么情况');
assert.match(resolveTaskInput('直接做好，中间不用问我', [
  { role: 'user', content: '把排盘页面补全，后端跑通后前端也要做完' },
  { role: 'assistant', content: '我会处理' },
]), /把排盘页面补全/);
assert.match(resolveTaskInput('你继续别再问我', [
  { role: 'user', content: '修复 bazi_calc.py 的 cnlurar API 并端到端验证' },
]), /修复 bazi_calc.py/);
assert.match(resolveTaskInput('继续', [
  { role: 'user', content: '深入分析你自己，排查 bug' },
  { role: 'assistant', content: '我已读到部分文件' },
]), /【续跑约束】/);
assert.match(resolveTaskInput('直接干#1 + #2', [
  { role: 'user', content: '深入分析你自己，排查 bug' },
  { role: 'assistant', content: '已定位 P0 #1 和 P0 #2' },
]), /深入分析你自己，排查 bug/);
assert.match(resolveTaskInput('继续', [
  { role: 'user', content: '验证 j2_agent_loop 完整路径' },
  { role: 'assistant', content: '验证完成。可继续拍 B4-B7：拉黑 dead 模型、补 memory 索引。' },
]), /上轮待办.*可继续拍 B4-B7/);
assert.strictEqual(stripGuaPrefix('【盘古起卦 · 先于推理】\n主人问题: 直接做好，中间不用问我'), '直接做好，中间不用问我');
const priorHistory = [
  { role: 'user', content: '要全部中国城市才可以' },
  { role: 'assistant', content: '请选一个方案' },
  { role: 'user', content: 'B. 调本地数据库 / 网络 API' },
];
const withCurrentInput = ensureCurrentUserMessage(priorHistory, '排盘出生地应该加上，分钟也应该加上去');
assert.strictEqual(withCurrentInput.length, priorHistory.length + 1);
assert.strictEqual(withCurrentInput.at(-1).content, '排盘出生地应该加上，分钟也应该加上去');
assert.strictEqual(priorHistory.length, 3, 'must not mutate caller history');
assert.strictEqual(ensureCurrentUserMessage(withCurrentInput, withCurrentInput.at(-1).content).length, withCurrentInput.length);

assert.strictEqual(isAligned('帮我检查 router 为什么会问非所答', '问题对齐层缺少最终回复守门，所以 router 会把跑题结果直接发出'), true);
assert.strictEqual(isAligned('帮我检查 router 为什么会问非所答', '今天北京天气晴，适合出门'), false);
assert.strictEqual(guardAnswer('检查路由 bug', '天气不错', '路由 bug 在分类后没有守门').recovered, true);
assert.strictEqual(guardAnswer('检查路由 bug', '天气不错').blocked, true);
assert.strictEqual(isAligned('现在全量扫描你自身', '主人说先 B 还是先 C？这是个具体事实题，立即动手。'), false);
assert.strictEqual(guardAnswer('现在全量扫描你自身', '✅ 两件都查清。汇报：A. Pangu 进程 env 真生效了。B. 重启按钮没有。').blocked, true);
assert.strictEqual(isAligned('检查路由 bug', '路由分类后缺少守门，bug 会把跑题结果直接发出'), true);
assert.strictEqual(guardAnswer('现在全量扫描你自身', '⚠️ 模型额度已耗尽，请切换其他模型。').blocked, true);
assert.strictEqual(guardAnswer('现在全量扫描你自身', '主人说先 B 还是先 C？这是个具体事实题，立即动手。', '当前模型未返回与原问题对齐的答案。').blocked, true);
assert.strictEqual(isSelfInspection('全面分析下你自己'), true);
assert.strictEqual(isSelfInspection('/Users/you/Desktop/course-source，你自己排查，对比你自己确认下消化吸收了多少'), false);
assert.strictEqual(hasSelfInspectionEvidence('当前模型是 k3。'), false);
// 2026-10-25 (第 97 批): 样本里的引用行号改成**现在真的存在**的那一行 ——
//   tools_schema.js 拆成门面 + 十三个家族文件后从 2379 行变成 154 行,
//   原来的 :1564 指向的行不存在了 ⇒ 「引用的行必须真实存在」这条判据把这条样本判成了 false。
//   判据本身**一个字没动**, 只是样本行号跟着真源走 (工具数现在在门面的合并行上)。
assert.strictEqual(isAligned('全面分析下你自己', '当前模型是 minimax-m3。真源：apps/core/config/nodes/example-node.json:12。工具数来自 apps/core/modules/tools_schema.js:35。'), true);
// 同一条判据的**边界**, 原来只是隐含在实现里, 现在明写出来:
//   文件存在、但行号超出文件长度 ⇒ 不算证据 (只有一个有效引用 ⇒ 不足 2 个 ⇒ false)。
assert.strictEqual(hasSelfInspectionEvidence('apps/core/modules/tools_schema.js:9999；apps/core/modules/j2_agent_loop.js:1'), false);
assert.strictEqual(guardAnswer('全面分析下你自己', '当前模型是 k3，工具有很多。').blocked, true);
assert.strictEqual(hasSelfInspectionEvidence('apps/core/不存在.js:12；apps/core/也不存在.js:3'), false);
assert.strictEqual(hasSelfInspectionEvidence('apps/core/modules/tools_schema.js:1；apps/core/modules/j2_agent_loop.js:1'), true);
assert.strictEqual(hasSelfInspectionEvidence('提交 8d9b3dc；apps/core/modules/tools_schema.js:1；apps/core/modules/j2_agent_loop.js:1'), false);
assert.strictEqual(hasSelfInspectionEvidence('工具结果显示已检查源码。', 'apps/core/modules/tools_schema.js:1\napps/core/modules/j2_agent_loop.js:1'), true);
assert.strictEqual(isAligned('排盘页面为什么没有详情', '好，直接出。先确认现状，再一把写完。侧栏入口已加。'), false);
assert.strictEqual(isAligned('排盘页面为什么没有详情', '待办清单：拉 vite 日志，确认接口，明天你醒来再看。'), false);
assert.strictEqual(isAligned('排盘页面为什么没有详情', '盘古 (Pangu) 全面自画像\n1. 身份与底座\n2. 工具矩阵\n3. 三层记忆'), false);
assert.strictEqual(isAligned('排盘页面为什么没有详情', '排盘页的详情区没有渲染：提交后接口返回错误，结果组件没有拿到四柱数据。应先检查请求响应和错误提示。'), true);
assert.strictEqual(isAligned('先完成阶段1排盘页面', '主人新要求：加出生地、阳历农历、分钟、藏干、大运。方案：先查真源，下一步直接干，等你拍。'), false);
assert.strictEqual(isAligned('先完成阶段1排盘页面', '阶段1目前只完成四柱和五行；藏干、纳音、神煞尚未实现。'), true);
assert.strictEqual(isAligned(
  '那你把桌面易经文件夹排查一下，没有消化吸收的消化吸收了',
  '工具结果：资料清点完。汇总：<course-source> 17 个；<course-source> 3 个；<course-source> 3 个；<course-source> 5 个。',
  '文件目录统计：桌面易经 digest extracted learned'
), true);
assert.strictEqual(isAligned(
  '/Users/you/Desktop/course-source，你自己排查，对比你自己确认下消化吸收了多少',
  '已对比完成：易经目录共有 7 个主题，digest 已有 3 份总结，learned 仍为空；盘古当前只覆盖易经本体和少量八字体用，其他主题未形成可用能力。',
  '工具结果：/Users/you/Desktop/course-source digest learned 7 3 0'
), true);
assert.strictEqual(isAligned(
  '查看 /Users/you/Desktop/course-source 最近修改的 1 个文件，只返回文件名。',
  '_MASTER_INDEX_跨八类总索引_v6.md',
  'tool_result stdout: 1790931106 /Users/you/Desktop/course-source/digest/_MASTER_INDEX_跨八类总索引_v6.md'
), true);
console.log('answer-alignment tests: ok');
