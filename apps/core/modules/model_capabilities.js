// model_capabilities.js — 模型能力自动识别 (2026-08-02 老板拍: 多模态模型, 盘古加载的时候要自己识别)
// 2026-08-22 增强: 加 arch 维度 (LM Studio model.yaml 真源喂的 architectures 字段)
// 判定优先级: config 显式 > arch 维度 (LM Studio 真源喂的) > model id 正则兜底
// 判定结果在 daemon 启动时打印, 让盘古"自知"每个模型能不能看图。

// 已知多模态 (能看图) 特征 — 命中即 vision
// 2026-08-22 老板实证: qwen3.6-35b-a3b / qwen3.8-27b / k3-256k 都内置 VL 模块 (千问/通义/阿里 Qwen3.X 系列 + Moonshot Kimi K3 全部多模态)
// 但 qwen3-coder / qwen3-235b-a22b / qwen3-30b-a3b / qwen3-32b 等 base/instruct 仍是纯文本 — 见下方 TEXT_ONLY_PATTERNS
const VISION_PATTERNS = [
  /minimax/i,                          // MiniMax M 系列 (M2/M3 均多模态)
  /doubao[-_]?seed/i,                  // 豆包 Seed 1.6/2.0 全系多模态
  /gpt-4o|gpt-4\.1|gpt-4v|gpt-4-turbo|chatgpt-4o|\bo4[-_]?mini|\bo4\b/i,
  /claude[-_]?(3|4|sonnet|opus|haiku)/i, // Claude 3 起全系视觉
  /gemini/i,                           // Gemini 1.5+ 全系多模态
  /qwen\d*[-_.]?vl|qvq/i,              // Qwen-VL / QvQ (显式 VL 后缀)
  /qwen[-_]?3[._-]?(6|7|8|9|x)/i,     // Qwen3.6 / 3.7 / 3.8 / 3.9 / 3.x (小数点新版都内置 VL, 老板 15:47 实证)
  /qwen[-_]?3[-_]?max/i,               // Qwen3-Max
  /qwen3[._-]?thinking/i,              // Qwen3-Thinking (视觉推理)
  /kimi[-_]?(k\d|thinking|latest|moonshot)/i, // Kimi K2/K3/K3 系列 + thinking/latest 变体
  /\bk3\b/i,                          // Kimi K3 (256k / coding 等)
  /gemma[-_]?[34]/i,                   // Gemma 3/4 多模态 (1/2 纯文本)
  /llava|pixtral|minicpm[-_]?v|internvl|janus/i,
  /glm[-_]?4v|step[-_]?[12]v|hunyuan[-_]?vision|ui[-_]?tars|deepseek[-_]?vl/i,
  /llama[-_]?3\.2[-_]?vision|llama[-_]?4/i,
  /moonshot.*vision|kimi[-_]?latest/i,
  /seed[-_]?2\.0/i
];

// 已知纯文本特征 — 即使上面误命中也以这里为准 (放后面覆盖)
// 2026-08-22 修正: 之前 /^qwen3(?!.*vl)/i 把整个 qwen3 系列打成纯文本, 错 (老板实证 qwen3.6-35b-a3b / qwen3.8-27b 都是 VL 多模态)
// 改为只列明确已知的纯文本 qwen3 模型 (coder / 235b / 30b / 32b / 14b / 8b 等 base / instruct)
const TEXT_ONLY_PATTERNS = [
  /deepseek[-_]?r1|deepseek[-_]?v3/i,
  /qwen3[-_]?coder/i,                  // Qwen3-Coder 纯代码文本
  /qwen3[-_]?(235b|30b|32b|14b|8b|4b|1\.7b|0\.6b)/i,  // qwen3 base/instruct dense (无 VL)
  /qwen[-_]?(coder|turbo|instruct|2\.5-7b|2\.5-coder)/i  // qwen2.5 老文本系 + coder/turbo
];

// 2026-08-22 §arch-trust: LM Studio model.yaml 真源喂的 architectures 字段
// 这是 LM Studio 自己存的 (UI 也读这个), 命中即 vision — 比正则更权威
// 来源: ~/.lmstudio/hub/models/<owner>/<name>/model.yaml 的 metadataOverrides.architectures
const VISION_ARCHES = [
  /^qwen35/, /^qwen3_5/, /^qwen3[._-]?5/,        // Qwen3.5/3.6/3.7/3.8 dense (qwen35/qwen35moe/qwen35vl ...)
  /^qwen3_vl/, /^qwen[-_]?vl/, /^qwen[-_]?2_5[-_]?vl/,  // 显式 VL
  /^gemma3/, /^gemma4/,                          // Gemma 3/4
  /^llama3_2_vision/, /^llama4/,                 // Llama 3.2 Vision / Llama 4
  /^glm[-_]?4v/, /^step[-_]?[12]v/, /^hunyuan[-_]?vision/, /^deepseek[-_]?vl/,
  /^llava/, /^pixtral/, /^minicpm[-_]?v/, /^internvl/, /^janus/, /^cogvlm/, /^molmo/, /^florence/,
  /^ui[-_]?tars/, /^xvlm/, /^xcomposer/,
];

const TEXT_ONLY_ARCHES = [
  /^qwen2(?!.*vl)/, /^qwen2_5(?!.*vl)/,          // qwen2 / 2.5 (非 vl)
  /^qwen3(?!.*vl).*coder/,                       // qwen3-coder arch
  /^qwen3(?!.*vl).*(235b|30b|32b|14b|8b|4b)/,   // qwen3 base/instruct dense (e.g. qwen3_30b_a3b)
  /^glm4(?!.*v)/, /^glm4_moe/,                   // glm4 (非 v) 全文本
  /^lfm2/, /^lfm_?moe/,                          // Liquid LFM2
  /^llama3(?!.*vision)/, /^llama3_[123](?!.*vision)/, // llama3/3.1/3.2 非 vision
  /^mistral/, /^mixtral/, /^phi[12345](?!.*vision)/,
  /^deepseek_v[23](?!.*vl)/, /^deepseek_r1(?!.*vl)/,
  /^qwen3_max(?!.*vl)/,                          // qwen3-max text-only arch (没实测过, 保守)
];

function detectVision(model) {
  const sig = `${model.id || ''} ${model.name || ''}`.toLowerCase();
  for (const re of TEXT_ONLY_PATTERNS) if (re.test(sig)) return false;
  for (const re of VISION_PATTERNS) if (re.test(sig)) return true;
  // 2026-08-22 §arch-trust: arch 维度兜底 — LM Studio 真源喂的 architectures 字段最权威
  const arch = (model.arch || model.architectures || []);
  const archList = Array.isArray(arch) ? arch : [arch];
  const archSig = archList.filter(Boolean).map(String).join(' ').toLowerCase();
  if (archSig) {
    for (const re of TEXT_ONLY_ARCHES) if (re.test(archSig)) return false;
    for (const re of VISION_ARCHES) if (re.test(archSig)) return true;
  }
  return false; // 未知模型保守默认: 无视觉 (config 可显式 vision:true 覆盖)
}

// 启动时调用: 给每个模型补 vision 能力 (显式标注优先), 返回每模型的判定来源说明
function enrichModels(models) {
  if (!Array.isArray(models)) return [];
  const report = [];
  for (const m of models) {
    if (m.vision === true || m.vision === false) {
      report.push(`${m.id}: vision=${m.vision} (config 显式)`);
    } else {
      m.vision = detectVision(m);
      m._vision_auto = true;
      // 标记 arch 来源
      if (m.arch && Array.isArray(m.arch) && m.arch.length && !m._vision_source) {
        m._vision_source = 'arch-pattern';
      }
      report.push(`${m.id}: vision=${m.vision} (自动识别${m.arch ? ' arch=' + JSON.stringify(m.arch) : ''})`);
    }
  }
  return report;
}

module.exports = { detectVision, enrichModels };
