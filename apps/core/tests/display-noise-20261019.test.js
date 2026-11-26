'use strict';

// 2026-10-19 老板: 「我说的是什么? 显示太复杂, 大面积, 谁会看?」
//
// 现场 (会话 42351696, 浏览器实拍) 一屏四张卡, **没有一句是答案**:
//   ① 「已完成: 0 (无) / 怎么继续」  ② 「计划 0/3 完成」空卡 (只有时间戳)
//   ③ 「将 ⏳ 排队 1 个子 agent 排队等槽位」  ④ 193px 的
//      「⚠️ [Silent Failure / 本轮未收口] 我跑了 0 轮没调 task_done」
// 用户问「全面介绍一下你自己」, 屏幕上找不到盘古的回答。
//
// ── 2026-10-26 第 107 批 (桌面端下线) ──
// 这个文件原来六条, 这批拆成两半:
//
//   **删掉的四条是纯前端渲染层** (D1 计划卡单一判据 / D2 useMemo 依赖 /
//   D3 error 降级成提示行 / D6 humanizeStreamError 翻译) —— 它们守的是
//   "界面长什么样", 而界面已随 apps/desktop 一起下线。
//
//   **留下的两条是服务端真不变量**, 与界面无关:
//     D4 —— /message 退化路径必须剥工具草稿
//            (ok:true 但文件根本没读, 是最坏的交付 —— 这是**服务端**把
//             模型吐的伪工具标记当正文发出去, 任何客户端都会中招)
//     D5 —— reasoning_effort 白名单 ('auto' 是占位符, 原样下发 = 整轮 400)
//            (界面虽然没了, 但下游任何客户端都可能传 'auto' 进来)
//
// D4/D5 的意图一条没放松, 只是不再靠"某个 React 组件长什么样"来证明。
// 全部静态断言源码, **不发任何真实请求** (不烧额度、不碰 ~/.pangu 生产数据)。

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const ROOT = path.join(__dirname, '..');
const ROUTER_SRC = fs.readFileSync(
  path.join(ROOT, 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
const CALLER_SRC = fs.readFileSync(path.join(ROOT, 'modules', 'llm_caller.js'), 'utf8');

// 剥掉行注释和块注释。**任何**扫源码正文的断言都必须先过这一道 ——
// 修复说明里引用的原文会把自己判死 (2026-10-19 E5 第一版)。
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
}

test('D4 /message 退化路径必须剥工具草稿 —— ok:true 但文件根本没读是最坏的交付', () => {
  // 现场 (2026-10-19 11:47): 「读一下 …/llm_caller.js 里的 _isLocalModel」5 秒返回
  // "<tool_call><function=read_file><parameter=path>…/llm_caller.js</parameter>…"
  // 裸 callLLM 没给工具, 模型只能把调用写进正文; guardAnswer 只判对不对题, 不管是不是草稿。
  //
  // 这里**不**用 stripComments(整文件): inline_router.js 里有一处没闭合的
  // `/* 直接从 GitHub raw 拉真实 SKILL.md` (行 ~173k, 实测), 正则会拿它跟后面某个
  // `*/` 配对, 把中间两万行代码全删掉 —— 于是断言会报"找不到收口块",
  // 而代码好好的。这就是"注释会骗过文本断言"的升级版: **坏注释会吃掉真代码**。
  // 所以只取锚点附近那一小段, 局部剥注释。
  const anchor = ROUTER_SRC.indexOf('const result = await callLLM(messages, _chatModel)');
  assert.ok(anchor > 0, '必须能找到 /message 退化路径的 callLLM 调用点');
  const block = stripComments(ROUTER_SRC.slice(anchor, anchor + 3000));
  assert.ok(/_stripPseudoToolMarkup/.test(block),
    '退化路径必须剥伪工具标记');
  assert.ok(/\\u200b/.test(block),
    '必须先剥零宽字符 —— 零宽能让伪标记伪装成正文逃过正则');
  assert.ok(/test\(_raw\)|<tool_call\|/.test(block),
    '剥完还剩 tool_call 特征 = 只吐了草稿没答 → 必须拦截');
  assert.ok(!/guardAnswer\(userInput,\s*extractContent\(result\)/.test(block),
    '不许再把原始 extractContent 直接喂 guardAnswer');
});

test('D5 reasoning_effort 白名单 —— \'auto\' 是占位符, 上线就是 400', () => {
  // 现场: 界面选择器把「自动」写成 'auto' 并原样下发,
  // llm_caller 原样当 API 字段发出去, LM Studio 直接
  // 400 "Invalid 'reasoning_effort' value: 'auto'. Supported values: none, minimal, low, medium, high, xhigh."
  // —— 整轮死掉。源码: dispatcher's _planEffort 与 llm_caller 的 _wireReasoningEffort。
  //
  // 2026-10-26: 那个界面选择器没了, 但**任何客户端**都可能传 'auto' 进来 ——
  // 白名单是服务端的责任, 跟有没有界面无关。
  assert.ok(/_VALID_REASONING_EFFORTS/.test(CALLER_SRC),
    'llm_caller 必须有一份合法档位白名单');
  assert.ok(/if\s*\(!_VALID_REASONING_EFFORTS\.has\(effort\)\)\s*return\s+null/.test(CALLER_SRC),
    '认不出的档位宁可不下发 —— 少一个字段只是回默认, 多一个错值整轮死');
  assert.ok(/\['none',\s*'minimal',\s*'low',\s*'medium',\s*'high',\s*'xhigh'\]\s*\.includes\(_planEffortRaw\)/.test(
    stripComments(fs.readFileSync(path.join(ROOT, 'modules', 'j2_dispatcher.js'), 'utf8'))),
    '拆解刀也必须过滤 \'auto\'');
});
