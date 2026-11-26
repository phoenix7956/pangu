// 成本字段的**单一真源** (2026-10-16 立)
//
// 起因是老板那句「关键是盘古的模型配置项, 选本地连模型还是云端的」, 顺着查出来的事实:
// 池里 8 个模型的 cost_per_1k_input / cost_per_1k_output **全是 0** ——
// 包括 minimax-m3 / k3 / agnes 这些真按量收钱的云端模型。
// 而这个 0 在全仓被 5 处各自解释, 解释还互相矛盾:
//
//   longctx_fallback._pickCheapest   当「最便宜」→ 排序全是平局, 落到 context_length 倒序
//                                    → 本地 qwen3.8-27b-mlx 一失败就切 minimax-m3
//                                      (付费云端, 1M 窗口) —— 函数名和实际行为正好相反
//   smart_router.pickByTask cost 策略 同样当「最便宜」→ 预算吃紧时按配置顺序选 = 挑最贵
//   smart_router._scoreModelForTask  当 0 成本加分 → 本地云端一起 0, 本地偏好这条完全失效
//   cost_guard.recordSpend          当真·免费 → spent_usd 恒为 0, 预算墙永远不响
//
// 真正的问题是: **0 无法区分「真免费」和「没配」**。
// 本地模型该是 0; 云端模型也填 0, 那就是漏配, 不是免费。
// 所以这里一律带 known 标志返回, 由每个调用点自己决定"不知道"时怎么办 ——
// 不再由 4 份各自猜的默认值替所有人做决定。
'use strict';

// 本地端点的判定。集中在这里是因为它被 router 排序、fallback 选路、
// 以及 SSE 事件里的 is_local 三处各自算过一遍, 早晚会算出不一样的结果。
// 判定口径: provider 明确是本地运行时, 或地址落在环回 / 内网。
// 2026-10-23 第 71 批: provider 名单收进 local_model 唯一真源 (这里原来自己抄了一份,
// 少 'lm-studio' / 'llama.cpp' / 'lmstudio_local' 等)。全仓没有别处 mutate 这个 Set,
// 所以直接引用真源那一份, 不再拷。
const LOCAL_PROVIDERS = require('../local_model').LOCAL_PROVIDERS;

function _endpointOf(m) {
  if (!m || typeof m !== 'object') return '';
  // 池子里两种写法都出现过: smart_router 读 api_base, 而 llm_caller/model_probe
  // 那侧用 endpoint。两个都看, 漏一个就等于把本地模型判成云端。
  return String(m.api_base || m.endpoint || '');
}

function isLocalModel(m) {
  // 2026-10-23 第 71 批: 判定收进 local_model 唯一真源。
  // 旧实现用**子串匹配**判端点 (ep.includes('10.') 之类) —— 那会把
  // "http://foo10.bar/v1" 也判成内网; 现在改成解析 hostname 后按段判。
  // 口径不变: provider 是本地运行时, 或端点在回环/内网段 → 不按云端 token 计费。
  try { return require('../local_model').isLocalOrPrivateModel(m); } catch (_) { return false; }
}

/**
 * 这个模型的调用成本。
 * @returns {{known: boolean, per1k: number|null, reason: string}}
 *   known=false 表示"配置里没有可信的成本" —— 调用方必须自己决定怎么办,
 *   不要再用 `|| 0` 把它当成免费 (那正是本文件要消灭的错法)。
 */
function modelCost(m) {
  if (!m || typeof m !== 'object') return { known: false, per1k: null, reason: 'no-model' };
  const ci = Number(m.cost_per_1k_input);
  const co = Number(m.cost_per_1k_output);
  const hasIn = Number.isFinite(ci) && ci > 0;
  const hasOut = Number.isFinite(co) && co > 0;
  if (!hasIn && !hasOut) {
    // 2026-10-16 (老板: "agnes现在3.0-flash免费"): 免费是一个**要写下来的事实**,
    // 不是"价格字段恰好是 0" —— 后者分不清「真免费」和「忘了配价」, 而这个仓库
    // 踩过的坑正是把这两件事混成一件 (见文件头)。
    // 显式 free: true 的模型 known=true/per1k=0, 于是 orderByCost 会把它排在
    // 所有按量计费的云端模型**前面** —— 本地端点一抖, 自动降级挑它, 不烧钱。
    // 老板说"现在免费"是带时效的判断, 所以这是一行配置, 涨价时改回去即可。
    if (m.free === true) {
      // 2026-10-16 (官方定价页 https://www.agnes-ai.com/zh-Hans/docs/pricing):
      //   agnes-3.0-flash 现价全 $0/M, 但刊例价是 输入缓存命中 $0.005/M、
      //   输入 $0.05/M、输出 $0.15/M, 页面明写「阶段性优惠的结束时间以平台公告
      //   和账户账单为准」—— 没给日期。
      //   只记 free:true 的后果: 哪天优惠结束, 这个模型**仍然**被当成 0 成本,
      //   排序照样把它排第一, 而且没有任何人收到提醒。把刊例价一起记下来,
      //   优惠结束时把 free 删掉, 系统立刻按真实价格算 —— 不用重新查一遍。
      const li = Number(m.list_cost_per_1k_input);
      const lo = Number(m.list_cost_per_1k_output);
      const listPer1k = (Number.isFinite(li) && li > 0 ? li : 0)
        + (Number.isFinite(lo) && lo > 0 ? lo : 0);
      return {
        known: true,
        per1k: 0,
        reason: 'explicit-free',
        // list_per1k > 0 = 这个"免费"是**临时的**。调用方可以据此提醒主人,
        // 而不是一个"现在免费"就永远免费的承诺。
        list_per1k: listPer1k > 0 ? listPer1k : null,
      };
    }
    return {
      known: false,
      per1k: null,
      reason: isLocalModel(m) ? 'local-unpriced-ok' : 'cloud-price-missing',
    };
  }
  return {
    known: true,
    per1k: (hasIn ? ci : 0) + (hasOut ? co : 0),
    reason: 'configured',
  };
}

/**
 * 一整个池子的成本数据体检。用来在"排序依据不成立"时把话说出来,
 * 而不是安静地按别的字段排序、让人以为那是按成本挑的。
 */
function costDataStatus(models) {
  const list = Array.isArray(models) ? models.filter(Boolean) : [];
  let known = 0, localUnpriced = 0, cloudMissing = 0;
  for (const m of list) {
    const c = modelCost(m);
    if (c.known) known += 1;
    else if (c.reason === 'local-unpriced-ok') localUnpriced += 1;
    else cloudMissing += 1;
  }
  const cloudTotal = known + cloudMissing;
  return {
    total: list.length,
    known,
    localUnpriced,
    cloudMissing,
    cloudTotal,
    // 云端模型里一个都没配价 → 任何"按成本排序"都是假的
    cloudPriced: cloudTotal > 0 && cloudMissing === 0,
  };
}

/**
 * 按成本升序排 —— "成本策略"和"预算吃紧自动降级"两处共用的**唯一**实现。
 *
 * 为什么不写在各自文件里 (2026-10-16): 这两处原本各有一份 `(cost_in||0)+(cost_out||0)`,
 * 两份都在"全 0"时静默退化成 no-op sort → 预算越吃紧越按配置顺序挑 =
 * 恰好挑最贵的那个。抄两遍的判据, 一定会只改一遍。
 *
 * 排序规则:
 *   池里至少一个模型配了价 → 已配价的升序, 没配价的排最后, 同价挑窗口大的
 *   一个都没配价         → 明确退回「本地优先 + 配置顺序」(稳定排序保证同组保序)
 * @returns {{sorted: object[], priced: boolean, status: object}}
 */
function orderByCost(models) {
  const list = (Array.isArray(models) ? models : []).slice();
  const status = costDataStatus(list);
  if (status.known === 0) {
    const localFirst = (a, b) => (isLocalModel(a) ? 0 : 1) - (isLocalModel(b) ? 0 : 1);
    return { sorted: list.sort(localFirst), priced: false, status };
  }
  const costOf = (m) => {
    const c = modelCost(m);
    return c.known ? c.per1k : Number.POSITIVE_INFINITY;
  };
  const sorted = list.sort((a, b) => {
    const ca = costOf(a);
    const cb = costOf(b);
    if (ca !== cb) return ca - cb;
    const aa = Number.isFinite(a.context_length) ? a.context_length : 1e9;
    const bb = Number.isFinite(b.context_length) ? b.context_length : 1e9;
    return bb - aa;
  });
  return { sorted, priced: true, status };
}

module.exports = { modelCost, isLocalModel, costDataStatus, orderByCost, LOCAL_PROVIDERS };
