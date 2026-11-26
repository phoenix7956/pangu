// apps/core/modules/llm_capabilities_cn.js — 国产模型规则库 (2026-08-22)
// 老板拍: 以后基本都是国产模型 — models.dev 覆盖弱, 必须自己维护一份离线规则库
// 不依赖网络, 启动加载, 加池时按 (provider, model id) 同步命中
// 规则优先级 (按命中顺序, 第一个匹配即返): ① 显式 EXACT_PATTERNS ② 命名规则 PATTERNS
// 用户手动 config vision:true/false 永远优先 (调用方负责)

const CN_PROVIDERS = [
  { id: 'minimax',   match: /minimax|minimaxi|abab/i,                    ctx_default: 128000 },
  { id: 'moonshotai',match: /kimi|moonshot|k3\b|kimi-coding/i,          ctx_default: 256000 },
  { id: 'qwen',      match: /qwen|qwq|qvq|dashscope|aliyun|tongyi/i,     ctx_default: 128000 },
  { id: 'zhipu',     match: /glm|zhipu|bigmodel/i,                       ctx_default: 128000 },
  { id: 'doubao',    match: /doubao|seed-|bytedance|volcengine|ark\./i,  ctx_default: 128000 },
  { id: 'deepseek',  match: /deepseek/i,                                 ctx_default: 64000 },
  { id: 'baichuan',  match: /baichuan/i,                                 ctx_default: 32000 },
  { id: 'hunyuan',   match: /hunyuan|tencent/i,                          ctx_default: 32000 },
  { id: 'ernie',     match: /ernie|wenxin|qianfan|baidu/i,               ctx_default: 8000 },
  { id: 'spark',     match: /spark|iflytek|xunfei/i,                     ctx_default: 8000 },
  { id: 'pangu',     match: /盘古|pangu/i,                              ctx_default: 8000 },
];

// 国产厂商: 命名规则 → capabilities (vision/reasoning/tool)
// 注: vision=多模态 (图/视频/音频), reasoning=思考, tool=工具调用
// 老板实操经验 + 公开文档整合 (2026-08-22)
const CN_RULES = {
  minimax: [
    // minimax 老系列: 纯文本 (vision: false)
    { test: /\babab[-_.]?[567]\b/i,             vision: false, reasoning: false, tool: true,  ctx: 32000,  note: 'abab5/6/7 纯文本' },
    { test: /minimax[-_.]?m1\b/,                vision: false, reasoning: true,  tool: true,  ctx: 64000,  note: 'minimax-m1 (reasoning: true)' },
    { test: /minimax[-_.]?m2[-_.]?(her|5)\b/,   vision: false, reasoning: true,  tool: true,  ctx: 128000, note: 'minimax-m2 / m2-her' },
    { test: /minimax[-_.]?m2(\.1|\.5|\.7|)\b/,  vision: false, reasoning: true,  tool: true,  ctx: 128000, note: 'minimax-m2.x 系列纯文本' },
    { test: /minimax[-_.]?m3\b/,                vision: true,  reasoning: true,  tool: true,  ctx: 1048576,note: 'minimax-M3 全模态 (老板实测)' },
    { test: /minimax[-_.]?m4\b/,                vision: true,  reasoning: true,  tool: true,  ctx: 1048576,note: 'minimax-M4+ 全模态 (推测, 待实测)' },
    { test: /minimax[-_.]?01\b/,                vision: true,  reasoning: false, tool: false, ctx: 32000,  note: 'minimax-01 视觉但无 reasoning/tool' },
  ],
  moonshotai: [
    // Kimi K2 / 老版本: 纯文本
    { test: /kimi[-_.]?k2[-_.]?(thinking|0905|coder|highspeed)\b/i, vision: false, reasoning: true, tool: true, ctx: 256000, note: 'Kimi K2 变体纯文本' },
    { test: /kimi[-_.]?k2\b/,                  vision: false, reasoning: true,  tool: true,  ctx: 256000, note: 'Kimi K2 纯文本' },
    // Kimi K3 / K2.5+: 全模态
    { test: /\bk3[-_.]?(256k|coding|highspeed)?\b/i, vision: true, reasoning: true, tool: true, ctx: 262144, note: 'Kimi K3 全模态 (老板实证 K3-256K)' },
    { test: /kimi[-_.]?k2\.[5-9]/,             vision: true,  reasoning: true,  tool: true,  ctx: 262144, note: 'Kimi K2.5+ 全模态' },
    { test: /kimi[-_.]?latest/,                vision: true,  reasoning: true,  tool: true,  ctx: 262144, note: 'Kimi latest 全模态' },
    { test: /kimi[-_.]?(thinking|moonshot)/i,  vision: true,  reasoning: true,  tool: true,  ctx: 262144, note: 'Kimi thinking/moonshot 变体' },
    // moonshot v1 老系列
    { test: /moonshot[-_.]?v1[-_.]?(8k|32k|128k|auto|32k-v1|8k-v1)/i, vision: false, reasoning: false, tool: false, ctx: 32000, note: 'moonshot v1 老版本纯文本' },
  ],
  qwen: [
    // Qwen VL 系列 (显式 vision)
    { test: /qwen[-_.]?vl[-_.]?(max|plus|pro)/i, vision: true, reasoning: false, tool: true,  ctx: 32768,  note: 'Qwen-VL Max/Plus/Pro' },
    { test: /qwen[-_.]?2[-_.]?5[-_.]?vl|qwen2[-_.]?vl/i, vision: true, reasoning: false, tool: false, ctx: 32768, note: 'Qwen2.5-VL / Qwen2-VL' },
    { test: /qwen[-_.]?3[-_.]?vl/i,            vision: true,  reasoning: true,  tool: true,  ctx: 32768,  note: 'Qwen3-VL' },
    { test: /qvq|qwq[-_.]?preview/i,           vision: true,  reasoning: true,  tool: true,  ctx: 32768,  note: 'QVQ / QwQ 视觉推理' },
    // Qwen3 旧 dense: 纯文本
    { test: /qwen3[-_.]?(coder|235b|30b|32b|14b|8b|4b|1\.7b|0\.6b)/i, vision: false, reasoning: false, tool: false, ctx: 32768, note: 'Qwen3 旧 dense + coder 纯文本' },
    // Qwen3.5+ / Qwen3.6+ / 3.7+ / 3.8+ / 3.9+ / qwen3-max: 全模态 (老板实证)
    { test: /qwen3[._-]?(5|6|7|8|9|x|1[0-9])/i, vision: true, reasoning: true, tool: true, ctx: 262144, note: 'Qwen3.5+/3.6/3.7/3.8 全模态 (老板实测)' },
    { test: /qwen3[-_.]?max/i,                 vision: true,  reasoning: true,  tool: true,  ctx: 262144, note: 'Qwen3-Max' },
    { test: /qwen3[-_.]?(thinking|vl|omni)/i,  vision: true,  reasoning: true,  tool: true,  ctx: 262144, note: 'Qwen3 变体' },
    // Qwen2 / 2.5 base/instruct: 纯文本
    { test: /qwen[-_.]?2(\.5)?[-_.]?(7b|14b|32b|72b)|qwen[-_.]?(2|2\.5)/i, vision: false, reasoning: false, tool: true, ctx: 32768, note: 'Qwen2/2.5 base/instruct' },
    // Qwen 商业版本 (DashScope)
    { test: /qwen[-_.]?(turbo|plus|max|long)/i, vision: false, reasoning: false, tool: true,  ctx: 1000000,note: 'Qwen 商业 (DashScope)' },
  ],
  zhipu: [
    // GLM-4V 系列: vision
    { test: /glm[-_.]?4[-_.]?v/i,              vision: true,  reasoning: false, tool: false, ctx: 8192,   note: 'GLM-4V' },
    // GLM-4 老系列: 文本 (部分有 tool)
    { test: /glm[-_.]?4[-_.]?(air|plus|9b|long)/i, vision: false, reasoning: false, tool: true, ctx: 128000,note: 'GLM-4 Air/Plus/9B/Long' },
    { test: /glm[-_.]?4\b/,                    vision: false, reasoning: false, tool: true,  ctx: 128000,note: 'GLM-4 base' },
    // GLM-4.5 / 4.6 / 4.7: reasoning + tool
    { test: /glm[-_.]?4\.[5-9]\b/i,            vision: true,  reasoning: true,  tool: true,  ctx: 131072,note: 'GLM-4.5/4.6/4.7 系列 (推测含 vision, 待实测)' },
    // GLM-Z1 (reasoning 系列)
    { test: /glm[-_.]?z1/i,                    vision: false, reasoning: true,  tool: true,  ctx: 128000,note: 'GLM-Z1 推理' },
    // CogViewX (图像生成, 不是 LLM)
  ],
  doubao: [
    // Doubao Seed 1.6+ / 2.0+: 全模态
    { test: /doubao[-_.]?seed[-_.]?(1\.[5-9]|2\.|2[0-9])/i, vision: true, reasoning: true, tool: true, ctx: 256000, note: '豆包 Seed 1.6+/2.0 全模态' },
    // Doubao Lite/Pro/1.5
    { test: /doubao[-_.]?(lite|pro|1\.5)/i,    vision: false, reasoning: false, tool: true,  ctx: 32000,  note: '豆包 Lite/Pro/1.5' },
    // Doubao 1.0 老版
    { test: /doubao[-_.]?lite|1\.0/i,          vision: false, reasoning: false, tool: false, ctx: 4096,   note: '豆包 1.0 老版' },
  ],
  deepseek: [
    // 2026-10-25 第 99 批: R1 系 (r1 / reasoner) 是**推理模型**。
    // 之前笼统归在下面的 "全系列纯文本" 里 ⇒ reasoning:false ⇒
    // router 把 deepseek-r1 当普通模型用。而旧 router 的 /deepseek-r/ 正则判的是
    // **true** ⇒ 换真源反而把行为改了 (这是收编档案最容易丢的一档)。
    // ⇒ 规则库补回真实能力, 而不是把守卫钉死在旧错值上。
    { test: /deepseek[-_.]?(r1|reasoner)/i,   vision: false, reasoning: true,  tool: true, ctx: 64000, note: 'DeepSeek-R1 / reasoner 推理模型' },
    // DeepSeek 全系列目前纯文本 (vision 模型待出)
    { test: /deepseek[-_.]?(chat|coder|v[12]|v3)/i, vision: false, reasoning: false, tool: true, ctx: 64000, note: 'DeepSeek 全系列纯文本 (待 vision)' },
    { test: /deepseek[-_.]?vl/i,               vision: true,  reasoning: false, tool: false, ctx: 32768,  note: 'DeepSeek-VL 视觉' },
  ],
  baichuan: [
    { test: /baichuan[-_.]?[34]/i,             vision: false, reasoning: false, tool: false, ctx: 32000, note: 'Baichuan 3/4 纯文本' },
    { test: /baichuan[-_.]?2/i,                vision: false, reasoning: false, tool: false, ctx: 32000, note: 'Baichuan 2 老版本' },
  ],
  hunyuan: [
    // 混元 Turbo / Standard / Pro: 文本
    { test: /hunyuan[-_.]?(turbo|standard|pro|lite)/i, vision: false, reasoning: false, tool: true, ctx: 32000, note: '混元 Turbo/Standard' },
    // 混元 Vision
    { test: /hunyuan[-_.]?vision/i,            vision: true,  reasoning: false, tool: false, ctx: 8192,  note: '混元 Vision' },
    // 混元 DiT (图像生成, 非 LLM)
  ],
  ernie: [
    // 文心 4.0 / 4.5 / 4 Turbo
    { test: /ernie[-_.]?4\.?[0-9]?[-_.]?(turbo|plus|8k|128k)?\b/i, vision: false, reasoning: false, tool: true, ctx: 8000, note: '文心 4.x 纯文本' },
    // 文心 -vl / -vision
    { test: /ernie[-_.]?(vl|vision)/i,         vision: true,  reasoning: false, tool: false, ctx: 8000,  note: '文心 VL/Vision' },
    // 文心 -lite / -speed
    { test: /ernie[-_.]?(lite|speed|nano|tiny)/i, vision: false, reasoning: false, tool: false, ctx: 8000, note: '文心 Lite/Speed 轻量' },
  ],
  spark: [
    // 讯飞星火 V3 / V4 / Pro / Max / Ultra
    { test: /spark[-_.]?v[1-4]\.?[05]?/i,      vision: false, reasoning: false, tool: false, ctx: 8000,  note: 'Spark V1-V4 纯文本' },
    { test: /spark[-_.]?(pro|max|ultra|3\.5|4\.0|4\.0[-_]?ultra)/i, vision: false, reasoning: false, tool: true, ctx: 32000, note: 'Spark Pro/Max/Ultra' },
  ],
  pangu: [
    // 华为盘古 (企业内部, 但盘古本身就是盘古, 自指)
    { test: /盘古[-_.]?(大模型|chat|nlp|自然语言)|pangu[-_.]?(chat|nlp)/i, vision: false, reasoning: false, tool: true, ctx: 8192, note: '盘古 基础对话' },
  ],
};

// 给定一个 model 对象, 返回 { provider, capabilities, hit_rule }
// 或者 null
function lookupCnCapabilities(model) {
  if (!model || !model.id) return null;
  const id = String(model.id).toLowerCase().trim();
  const ep = String(model.endpoint || '').toLowerCase();
  const prov = String(model.provider || '').toLowerCase();

  // 1. 找 provider
  let provider = null;
  // 显式 provider 字段优先
  for (const p of CN_PROVIDERS) {
    if (prov === p.id || prov.includes(p.id)) { provider = p.id; break; }
  }
  if (!provider) {
    // endpoint 域名匹配
    for (const p of CN_PROVIDERS) {
      if (p.match.test(ep)) { provider = p.id; break; }
    }
  }
  if (!provider) {
    // id 匹配 (兜底)
    for (const p of CN_PROVIDERS) {
      if (p.match.test(id)) { provider = p.id; break; }
    }
  }
  if (!provider) return null;

  // 2. 查该 provider 的规则
  const rules = CN_RULES[provider];
  if (!rules) return null;

  for (const rule of rules) {
    if (rule.test.test(id)) {
      return {
        provider,
        key: id,
        vision: rule.vision,
        reasoning: rule.reasoning,
        tool: rule.tool,
        ctx: rule.ctx,
        modality: rule.vision ? 'text+image->text' : 'text->text',
        input_modalities: rule.vision ? ['text', 'image', 'file'] : ['text'],
        source: 'cn-rules',
        note: rule.note,
      };
    }
  }
  return null;
}

module.exports = {
  lookupCnCapabilities,
  CN_PROVIDERS,
  CN_RULES,
};
