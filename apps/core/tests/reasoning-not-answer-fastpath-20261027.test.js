'use strict';

// 2026-10-27 (第 112 批): 「思考」不许当答案 + 推理模型的输出预算下限
//
// ─────────────────────────────────────────────────────────────────────────
// 现场 (2026-10-26 老板贴的八字排盘 AI 解读, 生产 :18901 实测复现):
//
//   POST /api/chat  {messages:[{role:'user',content:<九节八字解读提示>}],
//                    max_tokens: 6500}
//   → {"ok":true,"choices":[{"message":{"content":<13754 字的英文自说自话>}}]}
//
//   页面表现: 「AI 解读」区里全是模型的英文思考草稿, 九节只认出四个标题
//   (命盘总解 / 大运流年总览 / 父母 / 事业), **学业、财运、婚姻感情、健康、
//   调理建议 五节全缺** —— 老板原话: 「不光是链路漏进正文, 还有很多没有显示出来」。
//
// ─────────────────────────────────────────────────────────────────────────
// 两条根因 (都是**事实**, 不是文本形态猜测):
//
//   ① `llm_caller.extractParts` 有一条 2026-07-28 加的兜底:
//      content 空 ⇒ fallback 到 `reasoning_content` 当答案。
//      输出预算被思考吃光时, content 正是空的 ⇒ 思考原样上屏。
//      ⇒ 思考是**事实**, 不是答案: 空正文 + 有思考 = 「这轮没答上来」。
//   ② 客户端按「只要 3000 字汉字」给 6500 token 预算, 推理模型 (MiniMax-M3.1-Flash)
//      实测把 6500 / 16384 **全部**用来思考, 正文一个字都没剩下。
//      ⇒ 推理模型的输出预算有下限 (实测 32768 ⇒ 九节全齐, 3396 字)。
//
// 修法: ① `extractAnswer` 一次拿齐「正文 / 只回思考 / 上游说截断」三个事实;
//        ② `chat_answer_policy.resolveOutputBudget` 给推理模型抬预算下限。

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const https = require('node:https');

const ROOT = path.join(__dirname, '..');
const llmCaller = require(path.join(ROOT, 'modules', 'llm_caller.js'));
const policy = require(path.join(ROOT, 'modules', 'chat_answer_policy.js'));

llmCaller.init({
  _config: { llm: { models: [], openai_base_url: '', temperature: 0.3 } },
  fs, path, os, https, http,
  PRESETS: {}, PANGU_SYSTEM_PROMPT: '你是测试用的最小身份。',
});

/** MiniMax-M3.1-Flash 的真实返回形状 (2026-10-26/27 实测) */
function reasoningOnlyResp() {
  return {
    choices: [{
      finish_reason: 'length',
      message: {
        role: 'assistant',
        content: '',
        reasoning_content: 'Need construct detailed 2200-3000 Chinese chars. Let\'s draft...\nWait in user prompt above...',
      },
    }],
  };
}

function normalResp() {
  return {
    choices: [{
      finish_reason: 'stop',
      message: {
        role: 'assistant',
        content: '## 一、命盘总解\n日主癸水, 中和。\n',
        reasoning_content: '先想一下格局…',
      },
    }],
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// A. 思考不许冒充正文
// ═══════════════════════════════════════════════════════════════════════════

test('112-A1: content 空 + 有 reasoning ⇒ 正文空, 且把「只回思考」这个事实报出来', () => {
  const ans = llmCaller.extractAnswer(reasoningOnlyResp());
  assert.equal(ans.text, '', '只回思考时正文必须是空');
  assert.equal(ans.reasoningOnly, true, '必须报出 reasoningOnly 这个事实');
  assert.ok(ans.reasoningChars > 0, '思考字数要报出来 (给上层做判断用)');
});

test('112-A2: extractContent 不再拿思考顶上去 (2026-07-28 那条兜底不许复活)', () => {
  const text = llmCaller.extractContent(reasoningOnlyResp());
  assert.equal(text, '', '思考不是答案 —— extractContent 不许返回它');
  assert.ok(!/Need construct detailed/.test(text), '思考原文一个字都不许上屏');
});

test('112-A3: 有正文时正文就是正文 (思考只在旁边, 不影响正文)', () => {
  const ans = llmCaller.extractAnswer(normalResp());
  assert.ok(ans.text.includes('命盘总解'), '正文必须原样给出来');
  assert.equal(ans.reasoningOnly, false);
  assert.equal(ans.truncated, false);
});

test('112-A4: finish_reason=length ⇒ 报「被截断」 (半截答案不许长得跟完整的一样)', () => {
  const ans = llmCaller.extractAnswer(reasoningOnlyResp());
  assert.equal(ans.truncated, true, '上游说没写完, 这个事实必须传出去');
  assert.equal(ans.finishReason, 'length');
});

test('112-A5: llm_caller.js 源码里不许再有「拿 reasoning_content 当答案」的兜底', () => {
  const src = fs.readFileSync(path.join(ROOT, 'modules', 'llm_caller.js'), 'utf8');
  assert.ok(!/return \{ text: m\.reasoning_content/.test(src),
    '思考当答案的兜底不许复活 (2026-07-28 加的, 2026-10-27 现场证伪)');
  assert.ok(/reasoningOnly: true/.test(src), '「只回思考」这个事实要有出口');
});

// ═══════════════════════════════════════════════════════════════════════════
// B. 推理模型的输出预算下限
// ═══════════════════════════════════════════════════════════════════════════

test('112-B1: 推理模型 + 客户端只要 6500 ⇒ 预算抬到下限 (实测 6500 正文必空)', () => {
  const b = policy.resolveOutputBudget({ requested: 6500, hardCap: 32768, reasoningCapable: true });
  assert.equal(b, 32768, '推理模型的预算下限就是「思考 + 正文」一起算');
});

test('112-B2: 非推理模型不受这条规则影响 (客户端说多少就是多少)', () => {
  const b = policy.resolveOutputBudget({ requested: 6500, hardCap: 32768, reasoningCapable: false });
  assert.equal(b, 6500);
});

test('112-B3: 本地/自建端点 (没有厂商硬上限) ⇒ 不抬, 不碰 batch 101 定的软默认', () => {
  const b = policy.resolveOutputBudget({ requested: 6500, hardCap: null, reasoningCapable: true });
  assert.equal(b, 6500, '本地 8192 软默认是另一条口径, 这条规则不许掀它 (原样保留)');
});

test('112-B4: 客户端要的比端点能收的多 ⇒ 听端点的 (不许发出去就 400)', () => {
  const b = policy.resolveOutputBudget({ requested: 99999, hardCap: 32768, reasoningCapable: true });
  assert.equal(b, 32768);
});

test('112-B5: 厂商档案里的 minimax 上限是实测值, 不是拍脑袋的数', () => {
  const mc = require(path.join(ROOT, 'modules', 'model_capability.js'));
  const cap = mc.hardOutputCap({ id: 'MiniMax-M3.1-Flash', provider: 'minimax' });
  assert.ok(cap >= 32768,
    '16384 是 2026-09-10 的旧数据; 2026-10-27 实测 131072 都收 (见 model_capability 注释)');
});

// ═══════════════════════════════════════════════════════════════════════════
// B2. 请求级推理强度 (2026-10-27 实测: 思考 25300 → 2472 token, 171s → 42s)
// ═══════════════════════════════════════════════════════════════════════════

test('112-B6: 客户端显式指定推理强度 ⇒ 预算按客户端说的来 (不再抬)', () => {
  const b = policy.resolveOutputBudget({ requested: 6500, hardCap: 32768, reasoningCapable: true, effortSpecified: true });
  assert.equal(b, 6500, 'effort=low 时思考只有 2472 token, 6500 够写正文 —— 不该再抬到 32768');
});

test('112-B7: 客户端指定的档位必须是 OpenAI 规范里的值', () => {
  const src = fs.readFileSync(path.join(ROOT, 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
  assert.ok(/'minimal', 'low', 'medium', 'high', 'xhigh'/.test(src),
    '只认规范里的档位');
  const wl = src.match(/\[([^\]]*'minimal'[^\]]*)\]\s*\.includes\(_effortRaw\)/);
  assert.ok(wl, '要找得到档位白名单');
  assert.ok(!/'none'|'off'/.test(wl[1]),
    '「关掉思考」不收 (云端网关常收 ⇒ 整轮 400)');
  assert.ok(/effortSpecified/.test(src), '指定了强度 ⇒ 预算下限这条规则要知道自己');
});

// ═══════════════════════════════════════════════════════════════════════════
// C. 端点层不许把思考/半截答案直接交出去
// ═══════════════════════════════════════════════════════════════════════════

test('112-C1: 快路径用的是 extractAnswer (事实), 不是光看字符串', () => {
  const src = fs.readFileSync(path.join(ROOT, 'pangu-single', 'routes', 'inline_router.js'), 'utf8');
  assert.ok(/extractAnswer\(result\)/.test(src), '快路径必须走 extractAnswer');
  assert.ok(/answer_truncated/.test(src), '截断要如实报给客户端');
});

test('112-C2: 只回思考 ⇒ 正文空 ⇒ 升级阶梯接管 (不许空泡, 更不许思考上屏)', () => {
  assert.equal(policy.needsEscalation({ guardedText: '', guardedBlocked: false, wasToolDraft: false }), true);
  const decided = policy.decideChatAnswer({ guardedText: '', guardedBlocked: false, escalatedText: '' });
  assert.ok(decided.content.length > 0, '答复永不为空');
  assert.ok(!/Need construct detailed/.test(decided.content), '兜底文案里也不许有思考');
});

test('112-C3: 流式出口 (message-stream) 也不许把空气泡当答复', () => {
  const src = fs.readFileSync(path.join(ROOT, 'pangu-single', 'routes', 'message-stream.js'), 'utf8');
  assert.ok(/extractAnswer/.test(src), '流式出口也要拿事实');
  assert.ok(/本轮模型只回思考没有给出正文/.test(src), '只回思考要有话说, 不能什么都不说');
});

