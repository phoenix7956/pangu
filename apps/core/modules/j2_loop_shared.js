// modules/j2_loop_shared.js — L2 拆分 (2026-08-23)
// j2_agent_loop 的公共件, 从 1921 行主文件抽出:
//   fountain 守卫常量 / 空计划检测 / 危险工具名单 / TOOL_SELECTION_GUIDE /
//   round 超时 (本地/云端) / 配额+infra 错误文案 / session 状态 Map /
//   记忆·SONA·GOAP 注入 / SSE emit / fountain detect / stableStringify
// 不依赖 _deps (依赖注入留在主文件); 只被 j2_agent_loop.js 引用
'use strict';

// 2026-08-16 P0-1: 断点续跑 checkpoint (_persistSession 用)
const { saveCheckpoint } = require('./checkpoint');
// 2026-10-23 (第 64 批): 超时这一族错误的分类真源。
//   原来这里内联了一份正则, **只认连接类瞬断, 6 种预算类超时一种都不认** ——
//   于是超时在 native 路径上落不进「基础设施错误」, 掉进 catch 末尾那句
//   「fallback to legacy J2 XML path」(而 useNative 是 const, 那条路根本不存在)。
//   现场: b63-guagate3 一轮烧 390s 什么都不交, 外层续跑再原样烧一轮。
//   详见 modules/timeout_policy.js 的立库注释。
const _timeout_policy = require('./timeout_policy');
// 2026-10-24 (第 75 批 b): 内部标记剥除 —— 单一真源在 modules/internal_markers.js。
//   两处用它: ① _emitStreamDelta (流式层, 扣住含标记的增量)
//             ② sanitizeRecalledContent (回忆层, 断掉「泄漏进记忆 → 被 recall 回来 → 再抄一遍」的自循环)
const { stripInternalMarkerLines, stripInternalMarkers } = require('./internal_markers');

// TL-2 §4: Status fountain 检测 (LLM 重复 round 打断, 防 §0.31)
const FOUNTAIN_REPEAT_THRESHOLD = 5;
// 2026-08-22: WITHIN_TURN_DELTA_REPEAT — 同 delta 连续重复 (老板 16:01 实证: qwen3.6-35b-a3b 单回合吐 30+ 段重复文本, ROUND-LEVEL fountain 检测不到)
// 双层守卫: (a) 同一 delta 字符串连发 N 次; (b) 累积尾部长串重复 (substring 出现在更早位置)
const WITHIN_TURN_DELTA_REPEAT = 8;       // 同 delta 连发 8 次 → 截断
const WITHIN_TURN_DELTA_MIN_LEN = 4;       // 太短 (1-3 字符) 容易误杀 (eg "。" "the ")
const WITHIN_TURN_TAIL_LOOP_LEN = 80;      // tail 取最近 80 字
const WITHIN_TURN_TAIL_LOOP_HITS = 2;      // tail 在历史里出现 ≥2 次 (含当前位置) → 截断
const WITHIN_TURN_TAIL_MIN_TOTAL = 200;    // 总文本至少 200 字再开 tail-loop 检测 (避免短文误杀)
// R80 修 (BUG #1 死循环空承诺): 检测 "第一步/第二步..." 空计划模板
// 老板 7/30 00:40-01:36 实证: 老板说"动手/修吧/自动修正" → 模型复读 5 步模板 6+ 轮, 0 工具调用
// 修: 计划模板 + 0 工具调用 = 不收为 finalText, 强 nudge 重试; nudge 用完 → 诚实失败 (不假装在做)
const EMPTY_PLAN_MAX_NUDGES = 2;

// 2026-10-23 (第 67 批): 判据从「词表」改成「结构」。
//
// 旧判据 (词表版): 数字清单 ≥3 行 + **正文任意位置**出现 (读取|确认|检查|分析|查看|梳理)
// 现场 (b66-bridge-live-1792743482848, 2026-10-23): 一份**正常的卦象断语**被判成空计划 ——
//   它有 4 条编号断语 (1. **九三…** … 4. **互卦未济**), 正文末尾还有一句
//   「…要细看的话得确认」。「≥3 行编号」和「确认」这两个条件**在正文不同位置**各自命中,
//   于是整份好答案被当成空计划模板。
// 后果不是判错一次那么简单: 它触发 summary 重写 ⇒ 白烧一次 74 秒的 LLM 调用,
//   而且盘上留旧版、屏上是新版 (第 67 批另一半要修的正是这个)。
//
// 新判据 (结构版): 问的是「**是不是只有步骤没有结论**」, 不是「有没有出现某个词」。
//   ① 抽出所有**步骤行**: 「第X步: …」/「1. …」
//   ② 每一步都必须是**待办动作**: 去掉行首标记后, **头词是动作动词**, 且行内**没有完成体/结果体**
//   ③ 只要有**任何一步不是待办动作** ⇒ 这份文本里有结论 ⇒ 不是空计划
//
// 为什么这样才咬得住: 空计划模板的每一步都是「我要去做 X」, 头词是动作动词;
// 而真答案的每一步是「我查出来是 Y」, 头词根本不是动作动词。
// 判据钉的是**结构**, 措辞怎么变都不影响。

// 步骤行的**头词**表: 只有「要去做」的动作动词才算一步待办。
// 故意**不收**「先/再/然后/继续」这类连接词 ——「先退一步」是结论的一部分, 不是待办。
// 也**不收**单字动词(看/读/写/改): 「看东北方位」这类正文行会被误当待办。
const _PLAN_ACTION_VERBS = [
  '重新启动', '重启', '读取', '确认', '检查', '分析', '查看', '梳理', '获取', '取得',
  '调用', '检索', '搜索', '查询', '运行', '执行', '修改', '编写', '整理', '收集',
  '打开', '定位', '排查', '修复', '输出', '汇报', '总结', '盘点', '核对', '测试',
  '验证', '部署', '安装', '抓取', '下载', '上传', '清理', '配置', '加载', '载入',
  '导入', '导出', '截图', '复制', '保存', '记录', '标注', '备份', '同步', '解决',
];
const _PLAN_ACTION_HEAD_RE = new RegExp('^(?:' + _PLAN_ACTION_VERBS.join('|') + ')');

// 步骤行里出现这些 ⇒ 这一步**已经做完了 / 已经有结果了**, 不是待办:
//   · 完成体: 动词 + 了/过/完
//   · 结果体: 已经/完成/找到/发现/得到/结果显示/表明/意味着/成功/失败/通过
// 「证明」**不算**结果体 ——「读取 X 证明 Y」是目的不是结果 (R80 正例里就有这句)。
// 「失败」算结果体: 「执行失败」是结果;「失败时重试」这种条件句是少数, 认了。
const _PLAN_DONE_VERBS = _PLAN_ACTION_VERBS.concat([
  '做', '干', '查', '看', '读', '写', '跑', '装', '发', '取', '建', '删', '改',
  '调', '试', '测', '验', '核', '审', '录', '存', '传', '下', '上', '完成',
]);
const _PLAN_COMPLETED_RE = new RegExp(
  '(?:' + _PLAN_DONE_VERBS.join('|') + ')[了过完]'
  + '|已经|已完成|完成了|做完|搞定'
  + '|找到|发现|得到|结果[是为:：]|显示|表明|意味着'
  + '|成功|失败|通过'
);

/**
 * 抽出文本里所有「步骤行」的内容 (去掉行首编号/标记)。
 * ① 中文步数: 「第一步: 读取X」/「第2步 读取X」—— 按标记切开, 每段取第一行
 * ② 编号清单: 行首的「1.」「2)」「3、」
 * @returns {string[]}
 */
function _planStepBodies(t) {
  const out = [];
  const cnParts = String(t).split(/第\s*[一二三四五六七八九十\d]+\s*步\s*[:：、.]?/).slice(1);
  for (const part of cnParts) {
    const body = String(part).split('\n')[0].trim();
    if (body) out.push(body);
  }
  for (const line of String(t).split('\n')) {
    const m = line.trim().match(/^(?:\*\*)?\s*\d{1,2}[\.、\)]\s*(.*)$/);
    if (m) {
      const body = String(m[1]).trim();
      if (body) out.push(body);
    }
  }
  return out;
}

/**
 * 这一步是不是**待办动作** (还没做, 只是说要做)。
 * @param {string} body 步骤行去掉行首标记后的内容
 * @returns {boolean}
 */
function _isPendingPlanStep(body) {
  const s = String(body || '').trim().replace(/^[*#>\s]+/, '').trim();
  if (!s) return false;                             // 空行不算一步待办
  if (_PLAN_COMPLETED_RE.test(s)) return false;     // 已完成 / 有结果 ⇒ 不是待办
  return _PLAN_ACTION_HEAD_RE.test(s);              // 头词是动作动词 ⇒ 待办
}

function _looksLikeEmptyPlan(text) {
  if (!text || typeof text !== 'string') return false;
  const t = text.trim();
  if (t.length < 30) return false;
  const steps = _planStepBodies(t);
  if (!steps.length) return false;
  // 核心判据: **每一步都必须是待办动作**。
  // 有任何一步不是 ⇒ 这份文本里有结论 ⇒ 不是空计划 (第 67 批修掉的就是这个误判)。
  if (!steps.every(_isPendingPlanStep)) return false;
  // 阈值沿用旧判据: 中文步数 ≥2 处, 或编号清单 ≥3 行。
  const cnSteps = (t.match(/第\s*[一二三四五六七八九十\d]+\s*步/g) || []).length;
  const numbered = (t.match(/^\s*(?:\*\*)?\d+[\.、\)]/gm) || []).length;
  if (cnSteps >= 2) return true;
  if (numbered >= 3) return true;
  return false;
}
// P0-#1 修 (verify-2026-07-25): risk 分级 helper (从 permission.js 同步白名单)
const _DANGEROUS_TOOL_NAMES = ['kill', 'pkill', 'rm', 'sudo', 'chmod', 'chown', 'dd', 'mkfs',
                                'run_installer', 'full_deployment', 'send_wechat'];
function _isDangerousTool(name) {
  return _DANGEROUS_TOOL_NAMES.includes(name);
}
// R18 修 (老板 7/25 13:27 截图 + v3 原则): 顶部添 HARD RULE + 跟 file_find / list_directory 切割
// 老板场景复现: "我是原告,被上诉方,怎么应对" → gemma-4-26b 弱模型选了 file_find ×2
// 根因: R15 强制版写但 LLM 不读 prompt 末端, gemma-4-26b 4-bit 不看末尾规则
// 修: HARD RULE 放 prompt 顶部 (j2_agent_loop.js nativeHint) + TOOL_SELECTION_GUIDE 重写强制版
const TOOL_SELECTION_GUIDE = `
[!!! R18 强制 守则 — 老板场景复现后果]
老板问下面这些场景 → 走下面必选工具 → **禁止**走其他路径:

1. **法律 / 诉讼 / 原被告 / 上诉 / 答辩 / 应诉 / 法律策略 / 法务** → **禁止**调 \`file_find\` / \`list_directory\` / \`exec_command\` / \`read_file\`
   → **必须**调 \`risk_assessment\` (风险评估) + \`critical_point_analysis\` (关键点分析) 至少一个
   → 你**不能**"扫文件夹找材料", 法律问题不会从扫文件夹获得策略答案

2. **商业分析 / 趋势 / 市场 / 增长 / 竞争** → \`trend_judgment\` / \`momentum_assessment\` / \`situation_check\`

3. **怎么应对 / 怎么打 / 策略 / 方案** → \`critical_point_analysis\` (策略类)
   → 老板问"怎么应对"**不是**"扫文件夹", 是**调用 analyzer 工具分析**

4. **读文件 / 看内容** → \`read_file\` (单文件) → **不是** \`file_find\` / \`list_directory\` (扫目录)

5. **查状态 / 验证** → \`http_check\` / \`web_search\`

6. **记忆 vs 缓存 (R80 BUG #2 工具误调)** → 老板问 "你记得吗 / 我说过 / 我之前 / 历史 / 偏好 / 你有没有记忆" → **必须**调 \`memory_search\` (持久记忆库 ~/.pangu/memory/main.sqlite)
   → **禁止**调 \`cache_get\` 然后答 "我没有持久化记忆" — cache 是进程内临时缓存, 重启即丢, **不是**记忆
   → \`cache_get\` 返回空 ≠ 没有记忆; 查记忆只走 \`memory_search\` / \`memory_read\`

**老板明确禁词 (R18 截图实证)**:
- LLM 在老板问"我是原告,被上诉方,怎么应对"后调 \`file_find\` × 2 → Pangu UI 提示 \`(no tool) LOW\` 假象
- 这是老板拍桌子问题: **你不调 \`risk_assessment\` 老板就让你调出进程**

**完成判断**: 老板问"怎么应对" → 你的回答必须包含 \`risk_assessment\` 工具的输出 → 才能 \`task_done\`.
禁止用 \`file_find\` / \`list_directory\` / \`exec_command\` 完成"法律策略"任务 — 那是软件文档任务, 不是法律分析任务.
`;
// R13 修 (plan-mode-tool-selection spec): LLM round 超时熔断 (默认 30s, PANGU_ROUND_TIMEOUT_MS 可覆盖)
// R80 修 (BUG #3 响应慢/断流): 本地模型 (lmstudio/ollama 等, 30+ tok/s) 一刀切不可用 30s —
//   本地 35b 生成一轮常 >30s → 超时 → 重试 → 耗时翻倍 (老板 7/30 00:51-00:53 两分钟"断流"实证)
// 修法: 无 env 覆盖时, 本地 provider 默认 120s, 云端保持 30s; PANGU_ROUND_TIMEOUT_MS 仍可强制覆盖
// 2026-08-02 修: 云端 30s 太短 — MiniMax-M3 最终长答复 (能力审计/排查总结) 常 30-60s,
// 旧逻辑 30s 熔断 → final summary failed → Silent Failure 冤案 (老板 01:55 实证: 10 次工具全对, 总结轮被切)
// 老板标准: 防御越狠出事越大 — 云端本地统一 120s, PANGU_ROUND_TIMEOUT_MS 仍可强制覆盖
const _DEFAULT_ROUND_TIMEOUT_MS = 120000;
const _LOCAL_ROUND_TIMEOUT_MS = 300000; // 2026-08-02: 本地 35B 整轮 (含工具 schema 大 prompt + 生成) 120s 不够, 提到 300s
// 2026-10-23 第 71 批: 名单收进 local_model 唯一真源。
// ⚠️ 这一份原来**多一个 'custom'**, 而 'custom' 只说明「自建端点」——
//    生产池里 agnes-3.0-flash 就是 provider=custom + https://api.agnes-ai.cn/v1 (云端),
//    按老名单它被当成本地 ⇒ 轮次超时 300s、idle 超时 300s;
//    而 model_transport 判它是云端 ⇒ 60s。同一模型两个答案, 挂住时一个等 5 分钟一个等 1 分钟。
//    custom 的本地性只看端点, 真源里就是这么判的。
const _LOCAL_PROVIDERS = Array.from(require('./local_model').LOCAL_PROVIDERS);
function _isLocalModel(model) {
  // 2026-10-23 第 71 批: 判定收进 local_model 唯一真源。
  // 这份旧实现只认 127.0.0.1 —— 127/8 其余地址和 IPv6 回环全漏判,
  // 跟 api_key_resolver 早就修好的那份不是一个口径。
  try { return require('./local_model').isLocalModel(model); } catch (_) { return false; }
}
// 2026-10-26 第 102 批收尾 (交叉审 P1-1): 整轮墙跟「输出软默认 / 请求超时」对齐到**自建**口径。
//
// 为什么必须改 (交叉审实测的三行, 修复前):
//   场景                      softOutputCap   请求超时    整轮墙(修复前)
//   内网 / provider=custom        8192        300000      120000  ✗ 长输出被墙掐掉
//   公网 / provider=vllm          null        120000      300000  ✗ 墙比请求超时还长 5 倍
//   内网 / provider=vllm          8192        300000      300000  ✓
// 老板的口径是「输出软默认与超时**同口径**, 宁可少给默认值也不制造两口径」。
// 只改 model_capability 那一处 = 话只说了一半: 整轮墙还在用第 71 批的旧口径
// (provider 名单 or 回环), 于是同一个模型「输出按自建、整轮墙按云端」——
// 正是 101 批刚修掉的病, 换个文件名复发。
//
// 判据取 model_capability.isSelfHostedByEndpoint (自建 = 回环 + 内网 + 显式声明),
// 和 softOutputCap / model_capability.timeoutMs **同一份**, 不再各判各的。
// 「免 API key」的口径仍然只认回环 (api_key_resolver) —— 那条不属于超时, 故意不同。
function _isSelfHosted(model) {
  try { return require('./model_capability').isSelfHostedByEndpoint(model); } catch (_) { return false; }
}
function _resolveRoundTimeoutMs(model) {
  if (process.env.PANGU_ROUND_TIMEOUT_MS) return parseInt(process.env.PANGU_ROUND_TIMEOUT_MS, 10);
  return _isSelfHosted(model) ? _LOCAL_ROUND_TIMEOUT_MS : _DEFAULT_ROUND_TIMEOUT_MS;
}
// 2026-08-02 修 (老板 04:53 实证): 云端 429 额度耗尽时旧逻辑每轮秒败还烧 6 轮,
// 最后甩 "任务太复杂/上下文不足" 的 Silent Failure — 原因全错
// 修: 配额错误识别 + 快速失败 + 把真实原因 (含重置时间) 说给老板
function _isQuotaError(msg) {
  return /HTTP 429|AccountQuotaExceeded|rate_limit_error|Token Plan 用量上限|usage quota|quota exceeded/i.test(String(msg || ''));
}
// 2026-08-02 修 (老板 04:53 实证续): DNS/网络瞬断 (ENOTFOUND/ECONNREFUSED) 也会烧 6 轮甩 Silent Failure
// — 基础设施错误 (配额/网络) 都不是"任务太复杂", 一律快速失败说真话; 瞬断已有 2 次 attempt 重试兜底
// 2026-10-13 现场: 上游 5xx (含包在 SSE 里的错误信封) 原来落不进基础设施失败分类,
// 于是不切模型、不快速失败, 直接掉进 "fallback to legacy J2 XML path",
// 而那条分支带 nativeToolCallSupported = false ——
// **一次瞬时 500 让本次请求的后续所有轮次降级成 legacy XML 工具调用** (实测链路:
// 500 → 解析失败 → legacy → 验收 FAIL 补救轮 → 收口 partial)。
// 4xx 不算: 那是请求本身有问题, 混进基础设断错误会指错方向。
function _isUpstreamServerError(msg) {
  const re = /上游 SSE 错误事件|server_error|http_code=5\d\d|HTTP 5\d\d/i;
  return re.test(String(msg || ''));
}
function _isInfraError(msg) {
  return _isQuotaError(msg) || _isUpstreamServerError(msg)
    || _timeout_policy.isTimeoutError(msg) || _timeout_policy.isConnectionError(msg);
}

// 2026-10-16 (现场 clean-base2-20261016, 3 刀 analyzer 全部没交出总结):
// 本地端点上的 ECONNRESET 绝大多数**不是"端点挂了"**, 是我们自己掐的上一条请求的余波 ——
// 超时 → destroy → 端点还在把剩余 token 往已关的 socket 里写, 而我们同时又并发打了
// 3 条新请求, 端点忙着收尾就把新连接 RST 掉。端点本身好好的:
// 同一时段 LM Studio 日志 20:54:29 还在正常 "Finished streaming response", 零 ERROR。
//
// 但原逻辑只认字符串里有 ECONNRESET → _isInfraError → _pickCheapestModel →
// 池里本地模型只剩一个不够分 → 公平切**云端** k3-256k 按量计费。
// 一次**纯本地**的请求, 被自己引发的超时带着烧了云端的钱。
// —— 这就是"调用预算墙"的真实来历: 不是配额设的, 是**自动降级**在偷偷烧。
//
// 本地端点原地重试是**免费**的 (127.0.0.1, 不烧 token 配额), 切云端才烧钱。
// 所以规矩: 同一个本地模型还没原地重试过之前, 不许去问"切哪个模型"。
// 返回 true = 先原地重试这一轮, 别切。
function _preferSameLocalRetry(model, state, modelCost) {
  const _mc = modelCost || require('./router/model_cost');
  if (!model || !_mc.isLocalModel(model)) return false;
  if (state && state.localRetryTried) return false;   // 已经原地重试过 → 才轮到切模型
  if (state) state.localRetryTried = true;
  return true;
}

// 2026-10-19 修 (会话 59740796 现场):
//   报错文案里"请切换到其他模型 (如本地 qwen3.6-35b)"是**手抄的模型名**。
// 主人照着去「设置」里找, 那个模型**不存在** —— 真实 fallback_chain 是
// ['agnes-3.0-flash', 'minimax-m3'], enabled 池里 7 个模型没有 qwen3.6-35b。
// 于是模型挂掉时, 报错把主人指到一个查无此模型的设置页 —— 比不提示还坏。
//
// 跟 dispatch_rules/tool_role_map 同源: **提示词/文案里手抄的名字,
// 一定会跟真源漂**。所以这里从配置真源读, 一个字都不手写。
function _suggestModels() {
  try {
    const fs = require('fs'), path = require('path');
    const cfgPath = require('../config/node_config').resolveNodeConfigPathOrEmpty();
    if (!cfgPath) return '见「设置」里已启用的模型';
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const llm = (cfg && cfg.llm) || {};
    // 优先报 fallback_chain —— 那才是这一轮**真的**会去试的模型
    const chain = (llm.fallback_chain || []).filter(Boolean);
    if (chain.length > 0) return chain.join(' / ');
    const enabled = (llm.models || []).filter((m) => m && m.enabled !== false && m.id).map((m) => m.id);
    if (enabled.length > 0) return enabled.slice(0, 3).join(' / ');
  } catch (_) { /* 配置读不到就说不出建议, 下面兜底 */ }
  return '见「设置」里已启用的模型';
}

function _infraFailText(msg, model) {
  if (_isQuotaError(msg)) return _quotaFailText(msg, model);
  // 2026-10-16 (现场 clean-base2-20261016): 超时**不是网络故障**。端点通不通跟
  // "它还在慢慢算" 在协议上完全一样, 而原来的兜底文案对所有连接类错误一律喊
  // 「请检查网络/DNS」—— 现场端点好好的 (LM Studio 日志同一分钟还在正常
  // Finished streaming response), 这一句把排查方向直接指到了 DNS 和代理上。
  if (_timeout_policy.isTimeoutError(msg)) {
    // 2026-10-23 (第 64 批): 超时措辞收成**一处** —— timeout_policy.timeoutNoticeText。
    //   原来这里另写了一份, 而 timeout_policy 又写了一份; 两份同义文案迟早漂。
    //   「超时收口」这个标签也统一走那边。
    return _timeout_policy.timeoutNoticeText({
      kind: '模型 ' + ((model && model.id) || '?'),
      seconds: _timeout_policy.timeoutSeconds(msg),
      hint: '端点是通的, 只是算得比预算慢 (本地大 prompt 首字节就要 45~90s)。'
        + '要调预算设 PANGU_PREFILL_MS / PANGU_STREAM_TOTAL_MS, 或换更快的模型。'
        + ' (' + String(msg || '').slice(0, 120) + ')',
    });
  }
  // 2026-10-18 (现场 LM Studio 日志 12:49:57~12:51:32 连报 19 次):
  // 真实错误是 'The number of tokens to keep from the initial prompt is greater than
  // the context length' —— **prompt 超出模型上下文**。它既不是超时也不是 5xx, 于是掉进
  // 下面那条通用分支, 对着用户喊「请检查网络/DNS」, 把排查方向指到完全无关的地方。
  // 同一分钟 LM Studio 还在正常 Finished streaming response, 端点好得很。
  if (/context length|context_length_exceeded|maximum context|too many tokens|n_tokens_to_keep|prompt is too long/i.test(String(msg || ''))) {
    return '⚠️ 模型 ' + ((model && model.id) || '?') + ' **上下文超了** (不是网络问题): '
      + String(msg || '').slice(0, 120)
      + ' — 这一轮的 prompt 长度超过了该模型当前加载的 context。端点是通的。'
      + '先开新会话 / 压缩上文; 若同一模型反复超, 说明它在 LM Studio 里被换成了'
      + 'context 更小的量化档 (如 6bit→4bit), 需要给该档位重新配够 context_length。';
  }
  // 上游 5xx: 端点是**通的**, 只是它那边挂了 —— 让用户去查 DNS 是指错方向
  if (_isUpstreamServerError(msg)) return '⚠️ 模型 ' + ((model && model.id) || '?')
    + ' 上游返回服务端错误: ' + String(msg || '').slice(0, 160)
    + ' — 端点本身是通的, 这是上游侧的问题。已重试并切换过模型仍失败, 稍后重试即可。';
  return '⚠️ 模型 ' + ((model && model.id) || '?') + ' 端点连不上: ' + String(msg || '').slice(0, 120) +
    ' — 已重试 2 次仍失败。请检查网络/DNS, 或在「设置」切换到其他模型 ('
    + _suggestModels() + ')。';
}
function _quotaFailText(msg, model) {
  const m = String(msg || '').match(/reset at ([0-9\-: +]+(?:CST|UTC|GMT)?[0-9:+]*)/i);
  const reset = m ? ('配额重置时间: ' + m[1].trim() + '。') : '';
  return '⚠️ 模型 ' + ((model && model.id) || '?') + ' 额度已耗尽 (HTTP 429)。' + reset +
    '恢复前该模型所有请求都会失败 — 请在「设置」切换到其他模型 ('
    + _suggestModels() + '), 或等配额重置后再试。';
}

// §0.56 修 (B 路线): 跨 session state 污染 — 全局 fallback 仍在, 但 session-scoped _state 是首选
// 原因: 老 session pendingPlan 卡死 → "(no tool) LOW" 假象, 状态喷泉计数器跨 session 污染
// 修法: _j2SessionStates Map, key=sessionId, value={lastRoundText, batchCounter, fountainRepeat, planState, rejectedAtRound}
const _j2SessionStates = new Map();
function _getOrCreateSessionState(sessionId) {
  if (!sessionId) sessionId = 'default';
  if (!_j2SessionStates.has(sessionId)) {
    // M18: 长跑 daemon 防 Map 无限增长 — 超上限淘汰最老 entry (Map 保持插入序)
    if (_j2SessionStates.size >= 500) {
      const oldest = _j2SessionStates.keys().next().value;
      _j2SessionStates.delete(oldest);
    }
    _j2SessionStates.set(sessionId, {
      lastRoundText: '',
      batchCounter: 0,
      fountainRepeat: 0,
      planState: null,
      rejectedAtRound: null,
      inputTokensAccum: 0,  // 2026-09-16 一期②: 本 session 累计输入 token (交接触发用)
      handoffNotified: false,
    });
    // R16 修 (Bug O): 启动时尝试从 session_store 恢复 planState (老板 7/25 13:00 拍'全部修')
    // daemon 重启后老 session 的 planState 从 ~/.pangu-data/sessions/<id>.json 加载
    try {
      const { sessionLoad } = require('./session_store');
      sessionLoad({ session_id: sessionId }).then(r => {
        if (r && r.ok && r.result && r.result.plan_state && r.result.plan_state.pendingPlan) {
          // 2026-08-02 修: 恢复前先查过期 — 18 分钟前的 plan_failed 老 plan 被带进新对话,
          // 第一轮就把模型的 3 个工具 gate 跳过 (老板实证: 新问题开局工具被无故拦一轮)
          if (Date.now() - (r.result.plan_state.startedAt || 0) > 30 * 60 * 1000) {
            console.log('[j2] R16 skip stale planState restore for', sessionId, '( older than 30min )');
            return;
          }
          const state = _j2SessionStates.get(sessionId);
          if (state) {
            state.planState = r.result.plan_state;
            console.log('[j2] R16 restored planState from session_store for', sessionId, 'pending_plan=', r.result.plan_state.pendingPlan.plan_id);
          }
        }
      }).catch(() => {});
    } catch (_) {}
  }
  return _j2SessionStates.get(sessionId);
}
// Plan state 30 分钟过期 (跟 SessionCompaction 对齐, 防老 pendingPlan 卡死)
const PLAN_STATE_TTL_MS = 30 * 60 * 1000;
function _planStateIsStale(state) {
  if (!state || !state.planState) return true;
  if (!state.planState.startedAt) return true;
  return Date.now() - state.planState.startedAt > PLAN_STATE_TTL_MS;
}
// 兼容顶层全局变量 (14d8fec 仍用, 保留作 fallback)
let _j2LastRoundText = '';
let _j2BatchCounter = 0;
let _planState = null;
let _j2FountainRepeat = 0;

function sanitizeRecalledContent(text) {
  if (typeof text !== 'string') return '';
  // Never replay an unsupported "tools are locked" claim. It was generated by
  // the model, then stored as session memory and repeatedly reintroduced as
  // apparent context for the next similar task.
  if (/(?:工具|tool).{0,10}(?:锁(?:了|死)?|被禁|不可用|不能调)|(?:system|系统).{0,16}(?:禁止|不让).{0,16}(?:调|调用).{0,10}(?:工具|tool)/i.test(text)) return '';
  // 2026-10-24 (第 75 批 b): **先剥内部标记, 再压行**。
  //   为什么顺序不能反: 下面最后一步 `.replace(/\s+/g, ' ')` 会把多行压成一行,
  //   一压完「行首」就没了 (行首变行中) ⇒ 判据直接失效。
  //   为什么必须剥: 泄漏的 [CONTINUITY] 标记会落进 session 文件 + AgentDB,
  //   被 recall 回上下文 ⇒ 模型再抄一遍 ⇒ **自循环** (现场 2026-10-23 实证:
  //   sessions/2026-10-23.md:711 + main.sqlite 各 1 处)。
  //   判据 (行首 + 完整 token) 见 modules/internal_markers.js。
  const _noMarkers = stripInternalMarkers(text);
  return _noMarkers
    .replace(/<\|[^|]*\|>/g, ' ')        // strip <|system|>, <|user|>, <|assistant|> etc
    .replace(/\bsystem\s*:/gi, ' ')      // strip "system: " at word boundary
    .replace(/\bignore (?:all )?previous\b[^.\n]*/gi, ' ')  // strip "ignore previous" phrases (句号可选)
    .replace(/\n{3,}/g, '\n\n')         // collapse 3+ newlines
    .replace(/\s+/g, ' ').trim()          // normalize whitespace (existing)
    .slice(0, 600);                        // hard cap per-line (防超长 hijack)
}

function _formatRelevantMemories(memories, maxItems = 3, maxChars = 1800) {
  if (!Array.isArray(memories)) return '';
  const lines = [];
  let used = 0;
  for (const memory of memories.slice(0, maxItems)) {
    const content = sanitizeRecalledContent(memory && memory.content);
    if (!content) continue;
    const line = `[${memory.session_id || 'unknown'}] ${content}`;
    if (used + line.length > maxChars) break;
    lines.push(line);
    used += line.length;
  }
  return lines.join('\n');
}

async function _logSonaTrajectory(sessionId, input, messages, opts = {}) {
  try {
    const { logTrajectory } = require('./sona/logger');
    const { AgentDatabase } = require('./agentdb/db');
    const db = new AgentDatabase();
    const id = await logTrajectory(db, sessionId, input, messages, opts);
    if (id) db.close();
  } catch (e) {
    console.warn('[j2-sona] log failed:', e.message && e.message.slice(0, 200));
  }
}

async function _persistSession(sessionId, messages, opts = {}) {
  // A request can be interrupted while the model is between rounds. Do not
  // persist the UI's empty assistant placeholder as if it were a real reply;
  // it makes resumed sessions look like they contain blank assistant turns.
  const safeMessages = Array.isArray(messages)
    ? messages.filter((m) => {
        if (!m || m.role !== 'assistant') return true;
        const text = typeof m.content === 'string' ? m.content.trim() : m.content;
        return Boolean(text) || Array.isArray(m.tool_calls) || m.type || m.name;
      })
    : messages;
  // 2026-10-13 (逆向 Codex CLI 0.144.4 的 compact 链路时对照出来的):
  // 压缩摘要是**算出来但从不落盘**的 —— session_compaction.compact() 明明返回了 summary,
  // 调用方只取 compactedMessages 就把 summary 扔了, 结果 sessionStore 的 compaction_summary
  // 字段在**全部 265 个真实会话里都是长度 2 的空串**。
  // 后果很实际: 长任务最常见的死法就是"压缩之后忘了", 而压缩现场**一条证据都没留下** ——
  // 这条路一堵, 后面所有"压缩把什么压没了 / 压完之后模型还知道什么"的判断都只能靠猜。
  // 数据本来就在 messages 里(compact() 用 isCompactionSummary 标记塞进来的 system 消息),
  // 只是没人把它取出来。取**最后**一条 = 最近一次压缩的摘要。
  const _csMsgs = (Array.isArray(safeMessages) ? safeMessages : [])
    .filter(m => m && m.isCompactionSummary);
  const _compactionSummary = _csMsgs.length
    ? String(_csMsgs[_csMsgs.length - 1].content || '').replace(/^【会话摘要】/, '').trim()
    : '';
  try {
    const { sessionSave } = require('./session_store');
    await sessionSave({
      session_id: sessionId,
      messages: safeMessages,
      ts: Date.now(),
      // 放 ...opts 之前: 调用方显式传了就听调用方的, 没传才用这里从 messages 提取的。
      compaction_summary: _compactionSummary,
      ...opts,
    });
  } catch (e) {
    console.warn('[j2-persist] sessionSave failed:', e.message && e.message.slice(0, 200));
  }
  // 2026-08-16 P0-1: 同步落 checkpoint (fire-and-forget, 不阻塞)
  try {
    saveCheckpoint(sessionId, {
      round: opts && opts.round || 0,
      messages: safeMessages,
      lastToolCall: opts && opts.lastToolCall || null,
      planId: opts && opts.plan_id || null,
      planState: opts && opts.plan_state || null,
      taskInput: opts && opts.task_input || null,
    });
  } catch (e) { /* swallow */ }
}

async function _injectSonaPatterns(messages, input) {
  try {
    const { injectSonaPatterns } = require('./sona/router');
    const { AgentDatabase } = require('./agentdb/db');
    const db = new AgentDatabase();
    await injectSonaPatterns(messages, input, db);
    db.close();
  } catch (e) {
    console.warn('[j2-sona] inject failed:', e.message && e.message.slice(0, 200));
  }
  return messages;
}

async function _injectGoapPlan(messages, userInput) {
  // R44 接入 R41 GOAP: 老板新指令 → formatGoal → planAStar → 渲染成 plan markdown → 注入 system msg
  // GOAP 在 ~/.pangu/lib/goap 独立 lib, lazy require + 绝对路径 (跟 R41 formatter.js 模式一致)
  // 失败兜底: GOAP 不可用 / plan 找不到 / 输入太短, 都 skip 不阻塞
  if (!userInput || String(userInput).length < 5) return messages;
  // 2026-08-02 老板 RTF 实证: GOAP 实测只产 MAX_ITER_REACHED / EMPTY_GOAL,
  // 但每个请求都白烧一次 formatGoal LLM 调用, 注入的 "no plan" 消息还误导盘古
  // ("这条才是真正驱动我别规划直接干的信号" — 幻觉放大器)。默认关, PANGU_GOAP_ENABLED=1 才开。
  if (process.env.PANGU_GOAP_ENABLED !== '1') return messages;
  const GOAP_MAX_CHARS = 800; // 单独预算, 跟 SONA 1200 + Recall 1800 共存总 ≤ 3800 (LLM 接受)
    // 2026-08-16 P0-2 fix: GOAP 迁到 ~/.pangu/lib/goap (原外部路径已废除, Pangu 自治)
  // 留 PANGU_GOAP_PATH 兜底: 想挂老路径或别的 fork 仍可
  const DEFAULT_PANGU_HOME = process.env.PANGU_HOME || require('path').join(require('os').homedir(), '.pangu');
  const goapPath = process.env.PANGU_GOAP_PATH || require('path').join(DEFAULT_PANGU_HOME, 'lib', 'goap');
  let goap;
  try {
    goap = require(goapPath);
  } catch (e) {
    console.warn('[j2-goap] require failed:', e.message && e.message.slice(0, 200));
    return messages;
  }
  try {
    // 1) 格式化目标 (LLM 抽 success_criteria + 兜底)
    const goal = await goap.formatGoal(String(userInput).slice(0, 500), { sessionId: 'j2-round0' }, {});
    // 2) A* 规划 — 初始 state 假设 problem_understood=true (老板发指令就是理解了)
    const plan = goap.planAStar({ problem_understood: true }, goal.success_criteria, {});
    // 3) 渲染 markdown
    const md = goap.planToMarkdown(plan, goal, { maxLines: 25 });
    // 4) 截断 + 注入
    const trimmed = md.length > GOAP_MAX_CHARS ? md.slice(0, GOAP_MAX_CHARS) + '\n_(truncated)_' : md;
    if (plan.success && plan.plan && plan.plan.length > 0) {
      messages.push({
        role: 'system',
        content: `${trimmed}\n\n参考这个自动规划; 但以当前用户输入 + 相关记忆 + 学习到的模式为准.`,
      });
    } else {
      // 没 plan 也注入失败原因, 让 LLM 知道 GOAP 跑过了 (避免重复规划)
      messages.push({
        role: 'system',
        content: `## 🧭 GOAP (no plan)\ngoal: ${goal.goal || 'unknown'}\nerror: ${plan.error || 'unknown'}\n请直接处理老板指令, 不要重复规划.`,
      });
    }
  } catch (e) {
    console.warn('[j2-goap] plan failed:', e.message && e.message.slice(0, 200));
  }
  return messages;
}

async function _injectRelevantMemories(messages, query, recall = null) {
  if (!Array.isArray(messages) || !String(query || '').trim()) return messages;
  try {
    const recallFn = recall || require('./session_store').sessionRecall;
    const response = await recallFn({ query: String(query).slice(0, 2000), k: 3 });
    const memories = response && response.ok && response.result && response.result.memories;
    const formatted = _formatRelevantMemories(memories);
    if (!formatted) return messages;
    const content = `## 相关记忆 (AgentDB)\n${formatted}\n\n只把这些作为参考；如果与当前用户输入冲突，以当前输入为准。`;
    const existingIndex = messages.findIndex(message => message && message.role === 'system' && typeof message.content === 'string' && message.content.includes('## 相关记忆 (AgentDB)'));
    if (existingIndex >= 0) messages[existingIndex] = { ...messages[existingIndex], content };
    else messages.unshift({ role: 'system', content });
  } catch (error) {
    console.warn('[j2-memory] recall failed; continuing without semantic context:', error.message);
  }
  return messages;
}

// P0-#28: stream_delta helper
// 2026-07-26 修: 删 chunk 双 emit — 双路同样文本逼前端做 hash 窗口去重,
// token 级小 delta (1-3 字符) 在 80 窗口内大量撞 hash → 重复字被吞 ("110"→"10" 乱码)
// 现在 stream_delta 是唯一文本通道, 前端零去重
// 计数 token: 中文 1 token ≈ 1.5 char (粗估, 实际 LLM 不同); 简单按 char 数估算
// 2026-09-03 R80 BUG #13 修 (老板截图'又断流了' 实案): LLM 把 <think>...</think> 内联进 stream,
// 原 emit 直传 delta/accumulated → 前端收到 raw thinking → UI 气泡全是 thinking 文本
// 老板 §7-26 拍'思考过程全部折叠不需要显示出来' 已经处理了 m.thinking 折叠, 但 stream 层漏
// 修: emit 前 strip thinking 标签, token_count 重新估算
function _stripThink(s) {
  if (typeof s !== 'string') return s;
  // 闭合 <think>...</think> 剥掉
  s = s.replace(/<think>[\s\S]*?<\/think>\s*/g, '');
  // R80 BUG #15 修 (老板 22:20 截图 '继续读文件 2/3'): MiniMax-M3 漏 raw token IDs 到 stream,
  // '<]minimax[>[<path>...<]minimax[>[</invoke>' 这种乱码出现在用户气泡里, 触发截断幻觉
  s = s.replace(/<\][^\s\[\]<]*\[>/g, '').replace(/<\][^\s\[\]<]*\[>[\s\S]*?<\][^\s\[\]<]*\[>/g, '');
  return s;
}
// 2026-10-24 (第 75 批 b): 这一层再叠一道**内部标记剥除** —— 盘古自己往上下文里塞过的
//   标记 ([CONTINUITY] / [SYSTEM WARNING] / [LIP_SERVICE_BLOCKED] / [会话续跑] 等),
//   模型有时候会**原样抄进答复**, 用户气泡尾巴上就挂着一段「[CONTINUITY] 上一条 assistant 消息是…」。
//
//   为什么必须在**流式层**堵 (不能只在 final 层洗):
//     · 屏上先流出来的是**带标记的原文**, 用户先看见脏的;
//     · final 洗完之后比流式**短**, 而前端有一条「流式更长就不换」的规则 (ChatRoom.jsx)
//       => 只洗 final 的话, 洗干净的稿会被丢掉, 脏的留着 —— 修了反而更糟。
//
//   为什么扣住增量还能不丢字:
//     标记是**逐字**吐出来的 ('CONT' -> 'INU' -> 'ITY' -> ']'), 看到 'CONT' 时根本认不出
//     它是不是标记 => 把「还在写、可能是标记」的那一行**扣住不发**, 写完再判;
//     判完不是标记, 再补发 (一个字都不丢)。
//     扣得住的前提是「剥完的文本仍是原文的前缀」: 标记行整行变空、换行结构保留,
//     所以 __panguVisibleLen 仍然是「已发出的可见长度」, 游标语义一点没变。
//
//     判据与白名单的**单一真源**在 modules/internal_markers.js —— 流式层 / final 层 /
//     回忆层 / checkpoint 层四处共用同一份清单 (两处各留一份, 早晚有一份漏更新)。
function _emitStreamDelta(res, delta, accumulated, tokenCount) {
  if (!res || !delta) return;
  // 估算 token: 英文 4 chars ≈ 1 token, 中文 1.5 char ≈ 1 token (混合)
  // Thinking tags frequently arrive split across deltas. Derive the visible
  // stream from the full raw accumulation, then emit only the newly visible
  // suffix; this prevents a first `<think>` fragment from leaking.
  const rawAccumulated = String(accumulated || '');
  // 2026-10-15: 游标 (__panguVisibleLen) 必须在**同一个坐标系**里比, 否则会多发尾巴。
  //
  // 实测 (qwen3.8-27b-mlx, 7/7 次全中): 这个模型返回的 content 恒带前导 '\n\n',
  // 于是同一段正文有两种起点 ——
  //   流式累积 (j2:1501): '<think>思考</think>' + 正文, 第一个可见字符就是正文字,
  //                      __panguVisibleLen = 28
  //   轮末回灌 (j2:1704): textContent = _msg0.content = '\n\n' + 正文 = 30 字
  // 拿 30 去 slice(28) → 凭空多吐 3 个字符。
  //
  // 实测复现: 多发出来的是 '）。', 最终气泡变成
  //   '2026年10月15日 22:22（北京时间，周四夜）。）。'
  // 而 final 事件里的稿子是干净的 28 字 —— 但前端 ChatRoom.jsx:1234 是
  // `if (last.content.length >= text.length) return prev` (流式更长就保留流式),
  // 所以**用户看到的恰恰是这个多一个尾巴的版本**, 7 次全中, 不是偶发。
  //
  // 修: stateful 路径统一剥掉前导空白再比游标。前导空白本来也从没 emit 过
  // (第一个 delta 就是正文首字), 剥掉不改变可见内容, 只是把两个来源对齐到同一坐标系。
  // 非 stateful 路径 (计划提示/换模型提示, accumulated='') 保持原样 —— 那些 '\n\n' 前缀是故意要的。
  // 第 75 批 b: 下面再叠一层内部标记剥除 —— 见本函数上方那段注释。
  const _accumulatedStripped = stripInternalMarkerLines(_stripThink(rawAccumulated)
    .replace(/<think>[\s\S]*$/gi, '')
    .replace(/^\s+/, '')).text;
  const stateful = rawAccumulated.length > 0;
  const previousVisible = stateful ? Number(res.__panguVisibleLen || 0) : 0;
  const _deltaStripped = stateful ? _accumulatedStripped.slice(previousVisible) : _stripThink(delta);
  if (stateful) res.__panguVisibleLen = _accumulatedStripped.length;
  if (!_deltaStripped) return;  // 整段是 thinking, 不 emit (客户端不会显示 thinking)
  const _tokenCount = Math.ceil(_accumulatedStripped.length / 1.5);
  const payload = { type: 'stream_delta', delta: _deltaStripped, accumulated: _accumulatedStripped, token_count: _tokenCount, ts: Date.now() };
  try { res.write('event: stream_delta\ndata: ' + JSON.stringify(payload) + '\n\n'); } catch (e) { console.warn('[j2-stream] res.write stream_delta error:', e.message); }
}
// 2026-10-16 现场实测 (qwen3.8-27b-mlx @ lmstudio :1234, 用户只问了一句「1+1等于几」):
//   HTTP 响应头 20ms 到达, 但**第一个 SSE 字节在 41,081ms** —— 41 秒纯死寂, 用户原话「跟死了一样」。
//
// 根因不是解析器 (那一轮确实走的是流式路径, 上游也确实在吐 SSE), 是**本地 prefill 期间
// 上游一个字节都不给**: 本地 27B prefill ~285 tok/s, 11,000 token 输入 = 38.6s, 和实测的
// 41s 对得上。对照实验: 同前缀第二次请求 TTFB 只有 892ms (35,722 → 892, 快 40 倍), 改一个字
// 仍然 894ms —— 前缀缓存本身是好的, 所以「死寂」= 缓存未命中那一轮的代价。
//
// 为什么已有的心跳救不了场: pangu_agent_stream 的 attachSseHeartbeat 发的是 SSE **注释行**
// (`: keepalive`), 它只保 TCP 连接, 前端一个字符都渲染不出来, 界面照样全黑。
// 这一层补的是**用户可见的进度**: 等首个 delta 之前, 周期报「在读多少 token、已等多久」,
// 让 prefill 从"看不出是在跑还是在死"变成"看得见在跑"。
function _prefillProgressMs() {
  const n = parseInt(process.env.PANGU_PREFILL_PROGRESS_MS || '', 10);
  return (Number.isFinite(n) && n > 0) ? n : 3000;
}
// 返回幂等的 stop 函数。幂等是硬要求: 首个 chunk / 正常收流 / 抛错 / 客户端断连
// 四条路径都会调它, 漏掉任何一条都会留下一个每 3 秒往已关闭响应上写的定时器。
function _startPrefillProgress(res, info) {
  let stopped = false;
  let timer = null;
  // 2026-10-18 实机 (本地 qwen3.8-27b-mlx, LM Studio :1234):
  //   SSE 一秒没静默 (每 3s 一条), 流式和 tool_call 都正常 —— 问题不在"有没有进度"。
  //   真问题是 **elapsed_ms 每轮归零**: 一轮多 round 任务里, 第二轮的计时器从 57s
  //   突然跳回 0s 再往上走, 用户以为计时器坏了。
  //   实测 (deciding-verify-1018): elapsed 序列 0/3001/6002/9003 → 0/3395/6395 →
  //   0/17570/3429 一路归零, 而 total_ms 0→3001→…→11144→16313→19742 一路连续。
  //   界面显示 total_ms, elapsed_ms 保留成"本轮等了多久"供日志诊断。
  // res 判空必须**在**挂会话级状态之前 —— 2026-10-16 的 P7 钉的是
  // "没有 res / res 不支持 write 时返回可调用的 stop, 不能抛"。把累计状态挂到 res 上
  // 之后, res=null 会在这里先炸, 契约就破了。
  const _canWrite = !!(res && typeof res.write === 'function');
  // 会话级累计, 挂在 res 上 —— 每轮 _startPrefillProgress 都是新闭包, 挂闭包外等于每轮归零,
  // 正是要修的毛病。
  //
  // 这里是**积分器**, 不是"基准时间 + 当前轮时长"的算法。两个版本都在实机踩过:
  //
  //   ① 共享 started_at (2026-10-18 session timer-verify-final): stop() 常**晚于**下一轮的
  //      _pfStart 才到 (轮末兜底收口 / res close 都可能晚), 迟到的 stop() 把新一轮正在用的
  //      started_at 清零 → total_ms 从那一刻**冻住**: 实测 total 卡在 15096 而 elapsed 一路
  //      涨到 42163, 界面计时器直接停摆。
  //
  //   ② 改成按轮持有 (session multiround-verify): 多轮**并发**时各自 emit 会交错, 晚起的轮
  //      从更晚的起点算, 于是 total_ms 出现**倒退** (实测 52715 → 49366 → 52368)。
  //
  // 积分器两个坑都没有: 每个闭包只在**自己两次 emit 之间**那一段累加, 只增不减,
  // 与轮次并发/交错/迟到 stop 全部无关。
  const acc = _canWrite
    ? (res._prefillAccum || (res._prefillAccum = { total_ms: 0 }))
    : { total_ms: 0 };
  const mine = { lastAt: Date.now() };
  const _integrate = () => {
    const now = Date.now();
    const delta = now - mine.lastAt;
    if (delta > 0) { acc.total_ms += delta; mine.lastAt = now; }
    return acc.total_ms;
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    _integrate();   // 把最后一段并进去, 否则最后一小段等待永远不计入
    if (timer) { clearInterval(timer); timer = null; }
  };
  if (!_canWrite) return stop;
  const t0 = Date.now();
  const emit = () => {
    if (stopped) return;
    const payload = {
      type: 'agent_progress',
      phase: 'prefill',
      elapsed_ms: Date.now() - t0,
      // 跨轮累计 (界面主显示用这个, elapsed_ms 保留成"本轮等了多久"供诊断)
      total_ms: _integrate(),
      input_tokens: Number(info && info.input_tokens) || 0,
      model: (info && info.model) || null,
      note: '正在读取上下文并等待模型首个 token',
      ts: Date.now(),
    };
    try { res.write('event: agent_progress\ndata: ' + JSON.stringify(payload) + '\n\n'); } catch (e) { stop(); }
  };
  emit();  // t=0 立刻发一条 —— 等 3 秒才出现第一行, 等于没解决"像死了"
  timer = setInterval(emit, _prefillProgressMs());
  if (timer.unref) timer.unref();
  if (typeof res.on === 'function') {
    res.on('close', stop);
    res.on('error', stop);
  }
  return stop;
}
// 2026-07-26 老板拍: "思考过程流式, 完毕后直接从思考变成输出"
// 旁白(调工具前的自然语言) = thinking; task_done summary = 最终输出, 前端整体替换气泡
function _emitThinkingEnd(res) {
  if (!res) return;
  try { res.write('event: thinking_end\ndata: {}\n\n'); } catch (e) {}
}
// 2026-10-24 (第 75 批): opts.replace = 「这是处理后的权威稿, 覆盖你看到的流式原文」。
//   前端有一条"流式更长就不换"的经验规则; 当服务端做过后处理 (答复还原/剥除) 时,
//   处理结果常常**比流式更短**, 不带这个位就会被前端整个丢掉。
//   不传 opts 时行为与旧版逐字一致 (payload 里不会出现 replace 字段)。
function _emitFinal(res, text, opts) {
  if (!res || !text) return;
  const payload = { text, ts: Date.now() };
  if (opts && opts.replace === true) payload.replace = true;
  try { res.write('event: final\ndata: ' + JSON.stringify(payload) + '\n\n'); } catch (e) { console.warn('[j2-stream] res.write final error:', e.message); }
}
function _j2DetectFountain(currentText, _state) {
  if (!currentText) return { repeat: false, count: 0 };
  // §0.56 修: _state 可选 — 传 _state 用 session-scoped, 不传用顶层全局 fallback
  const _lr = _state ? _state.lastRoundText : _j2LastRoundText;
  const _fr0 = _state ? _state.fountainRepeat : _j2FountainRepeat;
  if (currentText === _lr) {
    if (_state) _state.fountainRepeat++;
    else _j2FountainRepeat++;
  } else {
    if (_state) { _state.fountainRepeat = 0; _state.lastRoundText = currentText; }
    else { _j2FountainRepeat = 0; _j2LastRoundText = currentText; }
  }
  const _fcount = _state ? _state.fountainRepeat : _j2FountainRepeat;
  if (_fcount >= FOUNTAIN_REPEAT_THRESHOLD) {
    return { repeat: true, count: _fcount, code: 'FOUNTAIN_DETECTED', message: 'You are repeating. Try a different approach.' };
  }
  return { repeat: false, count: _fcount };
}

// 2026-07-27 P0 修: 稳定 JSON 序列化 (key 排序), 用于跨 round tool+args 去重
function _stableStringify(obj) {
  try {
    if (obj === null || typeof obj !== 'object') return JSON.stringify(obj);
    if (Array.isArray(obj)) return '[' + obj.map(_stableStringify).join(',') + ']';
    const _keys = Object.keys(obj).sort();
    return '{' + _keys.map(k => JSON.stringify(k) + ':' + _stableStringify(obj[k])).join(',') + '}';
  } catch (_) { return JSON.stringify(obj || {}); }
}

// 2026-10-12 (老板现场证据 probe-ctx-20261012-1): 主人明说"只回答这两个, 不要调用任何工具",
// 盘古照样调 system_info ×2 —— native 路径无条件注入"≥1 工具"的硬规则, 压过了主人的话。
// 这里只负责判定"主人是否显式要求直答"; 注入哪套提示由调用方决定。
// 2026-10-13 修否定辖域 (现场 ar-0006): 旧式里的 只(回答|答|输出|说) 会命中
// "不许只说" / "不要只说明" —— 但这两句意思是"别光说, 去干活", 与直答**相反**。
// 现场后果: "创建 5 个文件并逐个读回确认, 要求真读真写, 不许只说" 被判成直答,
// 盘古直接不干活。修复前这只是白烧编排; b8864a7 的直答短路把它变成真灾难。
// 办法: 只X 前面有否定词(不许/不要/别/禁止/不能/不得/无需强调)时不判直答 ——
// 否定辖域优先。其余分支(别调用工具/直接答/不用查)语义明确, 保持不变。
const _NEG_BEFORE_ONLY = '(?<!不许)(?<!不要)(?<!别)(?<!禁止)(?<!不能)(?<!不得)(?<!严禁)(?<!切勿)';
const DIRECT_ANSWER_RE = new RegExp(
  '(不用|不要|别|无需|不必|不需要)\\s*(再)?\\s*(调用|使用|用|跑)?\\s*(任何)?\\s*(工具|tool)'
  + '|' + _NEG_BEFORE_ONLY + '只(回答|答|输出|说)'
  + '|直接(回答|答|说|输出)'
  + '|不用(查|看|搜)|无需(查|看|搜)',
  'i');
function wantsDirectAnswer(userInput) {
  return DIRECT_ANSWER_RE.test(String(userInput || ''));
}

// 2026-10-17 (现场 q-1792180668162: 「北京今天天气怎么样？需要真实数据，不要猜。」→ 103.4s):
//   planner **自己**把这一刀拆成了两步 ——
//     s1 analyzer: 查询北京天气, 取可追溯数据
//     s2 checker:  「依据 analyzer 的汇报进行独立核验, 不重复开展天气搜索」
//   时间账 (日志 llm-cost 行相加): planner 2.1s + analyzer 48.9s + checker 40.3s = 91.3s,
//   占全场 103.4s 的 88%。**checker 那 40.3s 花在"核验一次公开 API 查询"上** ——
//   同一个模型对同一份数据的第二意见, 不是独立证据。而 weather_check 这个专用工具
//   只在 checker 白名单里, 执行取数的 analyzer 反而没有, 于是它用 exec_command
//   curl 了 6 次 wttr.in / open-meteo, 还对同一个输出文件换了 4 种 grep 反复扒
//   (每扒一次 = 一整轮 4~12s 推理)。
//
// 这就是"同样的模型 Codex 比盘古快"的物理原因: 不是单刀慢, 是**为一件小事买了整场编排**。
// Codex 同题 1 刀。盘古 3 刀 + 综合。
//
// 所以这里补一条**单刀直查**通道。但边界必须极窄, 因为老板明确要过拆刀能力
// ("乾就应该把任务拆了, 分下去, 子agent只做自己相关的")。判据按**否定优先**设计 ——
// 认不准就老实走编排, 宁可慢, 不给错答案:
//   ① 剥掉卦块/【】块后仍要短 (长的一律给 planner, 那里拆解质量才值钱)
//   ② 命中任一"要动手"标记就不走 (动词表**故意列宽** —— 漏一个只损失速度,
//      误放一个会让真任务没人拆, 那才是事故)
//   ③ 不含多步/并列/清单痕迹
//   ④ 不含文件、路径、代码、项目自指
//   ⑤ 必须像个**查东西**的短问句 (正向信号, 列宽)
// 注意这里**不判主题** ("天气/股价"各算不算简单) —— 那是按想象写词表,
// 今天的教训 (出 6 张没命中任何写类动词 / 股票工具名猜错) 就是这么栽的。
// 判据只看**句法**: 有没有活要干、有没有几件事、有没有落点。
const _SINGLE_SHOT_MAX_CHARS = 50;
// ② "要动手"标记。宁可多拦。
const _WORK_VERB_RE = /(修|改|写|创建|新建|增删|删除|删|重构|重写|重命名|编译|安装|部署|启动|运行|跑|执行|统计|扫描|遍历|搜索|查找|找出|列出|读取|读一?读|分析|总结|对比|比较|审计|调试|排查|修复|优化|迁移|打包|提交|推送|克隆|生成|导出|导入|转换|整理|归档|备份|配置|更新|移动|复制|打开|保存|截图|录音|翻译|发|推送邮件|下单|买|卖|翻译|画|出图|生成图)/;
// ③ 多步 / 并列 / 清单
const _MULTISTEP_RE = /(然后|接着|之后|再|并且|以及|同时|最后|首先|其次|分别|各自|每个|逐个|所有|全部|依次|逐步|一步步|一轮|第[一二三四五六七八九十\d]+[步个项]|1[).、]|2[).、]|3[).、]|[一二三四五六七八九十]+[、.])/;
// ④ 文件 / 代码 / 项目自指
const _FILE_OR_PROJECT_RE = /(\/|\\|\.js\b|\.py\b|\.md\b|\.json\b|\.ts\b|\.jsx\b|\.txt\b|\.sh\b|目录|文件|路径|代码|仓库|函数|模块|类|接口|盘古|这个项目|本项目|你自己|你的配置|apps\/|modules\/|tests\/)/i;
// ⑤ 查东西的正向信号
const _LOOKUP_RE = /(查|看看|看一下|查询|搜一下|多少|怎么样|咋样|是什么|几度|几度|多少度|当前|现在|今天|今日|明天|价格|股价|汇率|天气|气温|温度|新闻|消息|时间|日期|行情|报价|涨跌|是不是|有没有|能不能|多少点)/;

// 入参约定: 传**剥掉卦块之后**的 routingInput (dispatcher 里现成的 _routingInput),
// 不要传原始 userInput。卦块是服务端拼的 ~200 字上下文, 不是主人的工作量 ——
// 自己在这里剥会剥不干净 (【】只包住第一行, 后面还跟着卦辞/爻辞/五行/六亲正文),
// 剥不掉就会把主人 8 字的问句顶成 160 字, 闸门第一道直接拦掉, 这条通道永不触发。
// 唯一真源是 j2_dispatcher._stripGuaBlockForRouting。
function wantsSingleShotLookup(routingInput) {
  try {
    const s = String(routingInput || '')
      // 只做防御性清理 (残留的零散【】块), 不指望它剥得掉卦块主体
      .replace(/【[^】]*】/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!s || s.length > _SINGLE_SHOT_MAX_CHARS) return false;
    if (_WORK_VERB_RE.test(s)) return false;
    if (_MULTISTEP_RE.test(s)) return false;
    if (_FILE_OR_PROJECT_RE.test(s)) return false;
    return _LOOKUP_RE.test(s);
  } catch (_) { return false; }
}

// 2026-10-19: 单目标阅读/分析 —— 「读这一个文件, 回答我一个问题」这种**一件活**的题,
// 不必先买一整场编排。
//
// 现场 (四次同一个任务, ~/.pangu/state/harness/runs/*main-pl*.jsonl):
//   「读 apps/core/modules/pangu_dogfood.js, 这个文件实际串联了几个将灵? 逐个列出 code」
//   probe-1792371312 → 拆解刀 106s / ~6030 token / 产出 0 刀
//   probe-1792370699 → 拆解刀 377s / ~9690 token / 产出 0 刀
//   probe-1792370454 → 拆解刀 120s / ~8828 token / 产出 0 刀
// 8 次 main-pl 累计 308 小时 / ~10 万 token, 平均 139 秒一刀, 而其中多数是**为了回答
// 「拆不拆」**。拆不动之后还得再买一次坎·planner, 然后才是执行那一刀。
//
// 为什么这条通道是对的而不是"偷懒": 主 agent 要的输出是一个**是/否** ——
// 主人已经把活写成一句自足的话了, 没有依赖要排, 没有几刀要切。而这一刀自己花掉
// 100~380 秒才得出「拆不动」。省下来的不是思考质量, 是**一个不必问的问题**。
//
// 判据按**否定优先**设计, 和 wantsSingleShotLookup 同一套哲学: 认不准就老实走编排。
// 漏判一个句子只损失速度; 误放行一个真任务会让它没人拆, 那才是事故。
const _SINGLE_TARGET_MAX_CHARS = 220;
// 绝对路径, 或带已知扩展名的文件名。两条都收 —— 主人写全路径和写相对路径一样常见。
const _SINGLE_TARGET_PATH_RE = /(?:\/(?:Users|Volumes|tmp|private|var|etc|home|opt)\/[^\s,，;；。"'）\]!？]+)|(?:[\w.\-/]+\.(?:js|mjs|cjs|py|md|json|ts|tsx|jsx|txt|sh|yml|yaml|toml|log|env|ini|cfg))/g;
// 会**改变磁盘或系统状态**的动词。这条通道只做只读阅读, 出现任何一个就不许放行。
const _WRITE_VERB_RE = /(修|修改|改写|改成|改为|重写|重构|重命名|写一个|写个|写进|写入|创建|新建|新增|添加|加上|插入|删除|删掉|删了|覆盖|替换|实现|开发|搭建|编译|安装|部署|启动|重启|运行一下|打包|提交|推送|迁移|生成文件|导出|清理|格式化|补一个|加一个)/;
// 明确要求**多份产出 / 有先后依赖**的措辞。这类题拆解质量确实值钱, 老老实实给 planner。
const _MULTI_DELIVER_RE = /(分别|各自|每个文件|所有文件|全部文件|每一个|依次|逐步|一步步|然后|接着|之后|再把|再改|再查|再读|另外|以及|并且|同时|先.{1,12}再)/;
// 只读意图的正向信号。**必须有**, 否则一句含糊的话会被当成单目标放行。
const _READ_INTENT_RE = /(读一下|读读|读一读|读取|读\b|看看|看一下|看一下|查一下|查查|查\b|解释|说明|列出|罗列|梳理|总结|概括|分析|对比|比较|是什么|什么意思|干什么|做什么|怎么理解|为什么|有哪些|有几个|几个|哪几个|多少)/;

// 否定/免责从句必须**先剥掉**再判动词, 否则「不许改文件」「不要写」会被当成写操作,
// 而那恰恰是主人最常说的一句 —— 「不许改任何文件」。带否定的一刀是**更该**走只读快路,
// 不是更不该。所以这里只剥否定, 不剥别的。
function _stripNegatedWrites(s) {
  return String(s || '')
    // 「不许改 / 不要动 / 别写 / 禁止修改 / 不能新增 / 不得删」+ 后面最多 6 个字的动作宾语
    .replace(/(不许|不要|别|无需|不用|禁止|不能|不得|无需再|不要再)[^，。；、]{0,6}?(修改|改|动|写|删除|删|创建|新增|添加|覆盖|替换|执行|运行)/g, ' ')
    // 整句式的只读声明
    .replace(/(只读|仅读|只看不改|不改文件|不修改文件|不用改|别动文件|不要动文件)/g, ' ');
}

// 判「这是一件活, 落点只有一个」。真源同 wantsSingleShotLookup:
// 入参必须是**剥掉卦块之后**的 routingInput, 唯一真源 j2_dispatcher._stripGuaBlockForRouting。
function wantsSingleTargetRead(routingInput) {
  try {
    const raw = String(routingInput || '')
      .replace(/【[^】]*】/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    if (!raw || raw.length > _SINGLE_TARGET_MAX_CHARS) return false;

    // 落点必须**恰好一个**。这一条是整道闸门的支点:
    //   「读 A 文件」            → 1 个 → 放行
    //   「读 A、B、C 三个文件」  → 3 个 → 拦下 (真的是三刀, 该拆)
    //   「逐个检查这三个文件」   → 3 个 → 拦下
    // 主人写「逐个」「分别」的时候, 清单本身已经摆在句子里了 —— 用**数落点**来判断,
    // 比用「逐个/分别」这些词判断可靠: 前者数错了就拦下, 后者漏一个词就误放行。
    const paths = raw.match(_SINGLE_TARGET_PATH_RE) || [];
    if (paths.length !== 1) return false;

    // 否定剥完再判动词 (见 _stripNegatedWrites 的理由)
    const s = _stripNegatedWrites(raw);
    if (_WRITE_VERB_RE.test(s)) return false;
    if (_MULTI_DELIVER_RE.test(s)) return false;
    return _READ_INTENT_RE.test(s);
  } catch (_) { return false; }
}

// 2026-10-13 (probe_resume / resume-live-1791860580 端到端实测): 盘古把每轮对话写进
// ~/.pangu-data/sessions/, 却从来不读回来 —— 第二轮照样把第一轮做完的 a1/a2/a3 重做一遍
// (mtime 全被刷新), 而落盘记录里明明写着 a1.txt。
// 根因: 新一轮的 messages 是从**当前这一轮请求**现拼的; sessionLoad 全代码库只在建会话
// 状态时恢复 plan_state, 从不恢复对话消息。
//
// 只取 user / assistant 的**纯文本**: system 每轮本来就会重新注入 (灌进来只是白烧 token),
// 而 tool 和带 tool_calls 的 assistant 单独灌进去就是孤儿 tool result → 上游 400
// (session_compaction._sanitizeToolPairing 一直在防的同一件事)。
const _PRIOR_TURN_CAP = 10;

function _extractPriorTurns(priorMessages, cap) {
  if (!Array.isArray(priorMessages)) return [];
  const limit = Math.max(1, Number(cap) || _PRIOR_TURN_CAP);
  // 2026-10-28: user 消息要还原成**主人原话** —— 落盘里存的是注入块拼过的版本,
//   拿它去跟请求里的原话比, 永远比不上 ⇒ 同一轮被当成两条。
  // 新写入的消息带 `raw` 字段直接用; 老消息没有 raw 就按 coreUserText 剥一遍。
  let _core = (t) => String(t || '');
  try { _core = require('./answer_alignment').coreUserText; } catch (_) { /* 模块不在就退回原样 */ }
  const out = [];
  for (const m of priorMessages) {
    if (!m || typeof m !== 'object') continue;
    if (m.role !== 'user' && m.role !== 'assistant') continue;
    if (m.type || m.tool_calls) continue;
    const text = (m.role === 'user'
      ? String(m.raw || _core(m.content) || '').trim()
      : String(m.content == null ? '' : m.content).trim());
    if (!text) continue;
    // 2026-10-28 (现场 web-1793124838326): 图片必须一起接回。
    //   原来这里只留 role+content ⇒ 上一轮的课件图丢了 ⇒ 后面每一轮模型都看不见那张图,
    //   只能靠 OCR 文本硬猜 (老板报「漏进正文 + 很多没显示出来」的同源问题)。
    const _turn = { role: m.role, content: text };
    if (m.role === 'user' && Array.isArray(m.images) && m.images.length > 0) _turn.images = m.images;
    out.push(_turn);
  }
  return out.slice(-limit); // 留最近的 —— 最近才接得上
}

// 2026-10-28 (现场会话 web-1793124838326 + 探针 probe-dup3-20261028):
//   连续性容器 / 落盘会话记的都是「主人原话」, 不是注入块拼过的版本。
//   理由: 容器跟请求比对时按原话比 —— 脚手架版本跟客户端的原话比不上,
//   每一轮都判成「请求里没有这一轮」, 把上一轮又塞一遍进 messages。
//   (实跑 [j2-msgs] 抓到过 user/assistant 各两份, 模型随后复读上一轮。)
let _coreUserText = (t) => String(t || '');
try { _coreUserText = require('./answer_alignment').coreUserText; } catch (_) { /* 模块不在就存原样 */ }

// 一条消息在容器/落盘里该记成什么 —— user 记原话, assistant 记正文。
function turnText(m) {
  if (!m) return '';
  if (m.role !== 'user') return String(m.content || '');
  return String(m.raw || _coreUserText(m.content) || '').trim();
}

// 一批消息里最后一条 user 消息的原话。
function lastUserRaw(turns) {
  const arr = Array.isArray(turns) ? turns : [];
  for (let i = arr.length - 1; i >= 0; i--) {
    const m = arr[i];
    if (m && m.role === 'user') return turnText(m);
  }
  return '';
}

// 2026-10-13 (soak-live-1791878818 现场): 非 main 角色的工具过滤, 一律补上 task_done。
//
// 现场三条契约互相打架, 逐条对得上:
//   ① 角色白名单 (sub-agent.js ROLES.tools, 2026-09-16 定的) 里没有 task_done
//      —— 线上 `[j2-role-tools] role=executor toolsAllowed=16` 与 ROLES.executor.tools 分毫不差;
//   ② j2 原生循环的完成判据就是 taskDoneCalled;
//   ③ 自动续跑提示还催它「全部完成时调 task_done」。
// 结果: 子 agent 干完了也调不到那个工具, 只能一遍遍重写/重读同一批文件把 3 次续跑烧完,
// 退出时 taskDoneCalled:false, 整轮被判 partial (现场答案: 「无法实际调用 task_done」)。
//
// task_done 是**收口信号**不是角色职能工具 (sandbox 也把它列在 safe 里), 所以不该指望各角色
// 名单自觉带上 —— 在这里强制补, 角色名单怎么演进都不会再漏。
function buildRoleToolFilter(roleForLoop, toolsAllowed, enforce) {
  // 2026-10-17 (老板拍: 「乾就应该把任务拆了, 分下去」):
  // main 默认**仍然**全量工具 (它有自己的交付语义, 这是老契约, 不动)。
  // 但"默认"不等于"永远": dispatcher 让主 agent 拆解时需要把它**关进一个工具笼**
  // (只准调 dispatch_subagents), 否则那一轮它会顺手 read_file/exec_command 自己去干活 ——
  // 我们要的是它的拆分判断, 不是让它把活干完。
  //
  // 现场 (首次实跑 q-1792248439788): enforce 没生效, 那一轮调的是 read_file ×3 +
  // task_done, 一刀都没派, 然后坎照旧拆。而**没有任何报错** —— 白名单"给了但没生效"
  // 是最安静的一种失败, 所以这里只认显式的 enforce, 不猜调用方的意图。
  if (roleForLoop === 'main' && !enforce) return null;
  if (roleForLoop === 'main' && !(Array.isArray(toolsAllowed) && toolsAllowed.length > 0)) return null;
  let filter = null;
  if (Array.isArray(toolsAllowed) && toolsAllowed.length > 0) {
    filter = new Set(toolsAllowed);
  } else {
    // 没传 toolsAllowed → 按角色从 sub-agent.js ROLES 拉名单 (单一真源, 不重复维护)
    try {
      const roles = require('../agents/sub-agent.js').ROLES || {};
      // 2026-10-18 拼音统一: roleForLoop 可能来自历史数据 / 旧 checkpoint。
      // 以前这里查完拿不到就**放着** —— filter 保持 null → 上游
      // `_effectiveTools = filter || (role==='main' ? _mainTools : null)`
      // 于是 worker 拿到**全量工具**, 而且不报错。白名单"静默失效"是最安静的一种失败。
      //
      // 英文身份删掉之后「拿不到」变得更容易 (旧 checkpoint 里的英文名一律认不出),
      // 所以失败方向必须拧过来: 认不出角色 → 退回最严的只读将灵 (兑) 的名单。
      // 宁可这个角色少干点活 (owner 一看就知道, 报得出来), 也不能给它一整套写盘工具
      // —— 那才是"注释 ≠ 隔离"那个坑, 而且日志里一个字都没有。
      const { resolveRole } = require('../agents/gua-identity');
      const key = resolveRole(roleForLoop);
      const role = (key && roles[key]) || roles.dui;
      if (role && Array.isArray(role.tools) && role.tools.length > 0) filter = new Set(role.tools);
    } catch (_) {}
  }
  if (filter && !filter.has('task_done')) filter.add('task_done');
  return filter;
}

module.exports = {
  _extractPriorTurns,
  // 2026-10-28: 容器/落盘记原话的两个口径 (见函数上的注释)
  turnText,
  lastUserRaw,
  buildRoleToolFilter,
  wantsDirectAnswer,
  wantsSingleShotLookup,
  wantsSingleTargetRead,
  FOUNTAIN_REPEAT_THRESHOLD,
  WITHIN_TURN_DELTA_REPEAT,
  WITHIN_TURN_DELTA_MIN_LEN,
  WITHIN_TURN_TAIL_LOOP_LEN,
  WITHIN_TURN_TAIL_LOOP_HITS,
  WITHIN_TURN_TAIL_MIN_TOTAL,
  EMPTY_PLAN_MAX_NUDGES,
  _looksLikeEmptyPlan,
  _DANGEROUS_TOOL_NAMES,
  _isDangerousTool,
  TOOL_SELECTION_GUIDE,
  _DEFAULT_ROUND_TIMEOUT_MS,
  _LOCAL_ROUND_TIMEOUT_MS,
  _LOCAL_PROVIDERS,
  _isLocalModel,
  _resolveRoundTimeoutMs,
  _isQuotaError,
  _isInfraError,
  // 2026-10-23 (第 64 批): 超时与瞬断必须**分开判**。
  //   超时 = 「这一轮算不完」→ 原样重试必然再撞同一堵墙, 且切云端未必更快 (还烧钱)。
  //   瞬断 = 「连接断了」→ 原地重试有意义 (本地端点, 免费)。
  isTimeoutError: _timeout_policy.isTimeoutError,
  isConnectionError: _timeout_policy.isConnectionError,
  _preferSameLocalRetry,
  _isUpstreamServerError,
  _infraFailText,
  _quotaFailText,
  _j2SessionStates,
  _getOrCreateSessionState,
  PLAN_STATE_TTL_MS,
  _planStateIsStale,
  sanitizeRecalledContent,
  _formatRelevantMemories,
  _logSonaTrajectory,
  _persistSession,
  _injectSonaPatterns,
  _injectGoapPlan,
  _injectRelevantMemories,
  _emitStreamDelta,
  _startPrefillProgress,
  _prefillProgressMs,
  _emitThinkingEnd,
  _emitFinal,
  _j2DetectFountain,
  _stableStringify,
};
