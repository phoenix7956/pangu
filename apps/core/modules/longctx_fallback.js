// modules/longctx_fallback.js — 2026-09-16 长上下文调用降级 (配置驱动, 不绑供应商)
//
// 老板拍: 开源不能写死"切某家云厂商" → 默认关, 老板自己配了才生效。
// 烧钱大头在 "msgs>=80 的长历史全量重发" (实测 62% 输入)。用便宜/小窗口模型扛这最贵场景:
//   - 老板本地配 long_ctx_fallback_model = agnes-3.0-flash (128K 窗口, 便宜) → 长历史调用自动走它
//   - 开源默认 empty = 不降级, 走原模型; 配了用自己池里最小的模型, 零供应商绑定
//
// 触发: PANGU_LONGCTX_FALLBACK_MSGS (默认 0=关) > 0 且 msgs >= 该阈值 且当前模型 != fallback 模型。
// 只降级"当前这一轮 LLM 调用", 不切全局 current_model — 答完/工具完下一轮若仍超长再降, 否则回正。
'use strict';

// 成本/本地判定走单一真源, 不要再在本文件里另写一套 `|| 0` 的猜法 (2026-10-16)
const _modelCost = require('./router/model_cost');

function _getFallbackModelId(cfg) {
  return (cfg && cfg.llm && (cfg.llm.long_ctx_fallback_model || cfg.llm.long_ctx_fallback)) || null;
}

// 返回应使用的 model 对象 (可能是 fallback 模型副本, 或原 model)
// @param {object} cfg  配置 (含 llm.models)
// @param {object} model 当前请求模型
// @param {number} msgCount 当前会话消息数
// @returns {{model:object, downgraded:boolean, reason:string}}
// 2026-09-16 开源默认=省钱: 任何人 clone 下来, msgs>=80 的长历史重发自动切"池里最便宜/最小窗口"的模型扛住,
// 不用配。fallback 解析顺序:
//   1) 老板显式配的 llm.long_ctx_fallback_model (最高优先, 尊重手动选择)
//   2) 池里 context_length 最小的 enabled 模型 (开源默认: 自动挑最省的, 同分优先本地端点=零成本)
// 已是该模型 → 不重复降 (防循环)。
// 2026-09-16 老板拍 "本地模型不是优先, 所有模型公平": fallback 选择只按【能力+成本】, 不分本地/云。
// 规则 (公平, 任何模型都可能被选中):
//   1) 窗口装得下当前长历史 (context_length >= 估算 input token) — 装不下的不选 (防 400)
//   2) 装得下的里面, 按真实 cost 字段 (cost_per_1k_input) 升序 = 最便宜优先
//      (本地模型 cost 字段=0 自然最便宜, 但靠的是 cost 字段, 不靠"本地端点"标签 — 公平)
//   3) 都不装得下 → 返 null (不降级, 回原模型, 避免小窗口硬扛大历史 400)
// @param models  池
// @param excludeId 当前模型 (不选自己)
// @param excludeIds 已降级过的 (防横跳)
// @param estTokens 当前历史估算 input token (用来判断"装不装得下")
function _pickCheapestModel(models, excludeId, excludeIds, estTokens) {
  const _excl = new Set([excludeId].concat(Array.isArray(excludeIds) ? excludeIds : []));
  // available === false 的模型也要排除。
  // 2026-10-16: 原来只排 enabled, 而 pickByTask (router 那条选路) 排的是 available ——
  // 同一个"这个模型能不能用"的判断, 两处口径不一样。于是用户标了 available:false 的模型
  // (现场是 qwen_qwen3.6-27b, LM Studio 认不出来那个) 在降级路径里照样是候选,
  // 切过去再失败一次, 白烧一轮。
  const cand = models.filter(m => m && m.enabled !== false && m.available !== false && !_excl.has(m.id));
  if (!cand.length) return null;
  // 1) 装得下: context_length >= estTokens (未填 context_length 视为能装, 交给 cost 排序)
  const fits = cand.filter(m => !Number.isFinite(m.context_length) || m.context_length >= (estTokens || 0));
  const pool = (fits.length ? fits : cand).slice();
  // 2) 按真实 cost 升序 (最便宜优先)。
  //
  // 2026-10-16: 原来这里只有一句 `cost_per_1k_input` 升序, 没有"字段可能不存在"这回事。
  // 实测池里 8 个模型的 cost 字段**全是 0** → 排序全是平局 → 落到下一行的 context_length
  // 倒序 → 本地 qwen3.8-27b-mlx (免费, 65536 窗口) 一失败就切 minimax-m3
  // (付费云端, 1M 窗口)。函数叫 pickCheapest, 实际挑的是"窗口最大的", 正好和名字相反。
  //
  // 现在成本判定统一走 model_cost (单一真源), 并把"一个价都没配"当成一件**要说出来的事**:
  // 那种情况下明确退回"本地优先 + 配置顺序", 而不是假装在按成本排。
  const _ordered = _modelCost.orderByCost(pool);
  if (!_ordered.priced) {
    if (!_pickCheapestModel._warned) {
      _pickCheapestModel._warned = true;
      console.warn('[longctx] 池里没有任何模型配了 cost_per_1k_input/output —— '
        + '"按成本挑最便宜"不成立, 退回「本地优先 + 配置顺序」。'
        + '给云端模型补上成本字段, 这个降级路径才会真的按成本选。'
        + ' (未知价云端模型: ' + _ordered.status.cloudMissing + ' 个)');
    }
  }
  const _pick = _ordered.sorted[0] || null;
  // 跨本地→云端要出声 (两条分支共用, 不只未配价那条)。
  // 2026-10-16: 原来这里只有 j2_agent_loop 一行 "公平切 X 重跑" —— 看不出那是从免费本地
  // 换成了按量计费的云端。静默切过去就是"本地一抖, 额度就没了"。
  if (_pick) {
    const _from = (models || []).find(m => m && m.id === excludeId);
    if (_from && _modelCost.isLocalModel(_from) && !_modelCost.isLocalModel(_pick)) {
      // 2026-10-16: 别把"跨到云端"一律说成"按量计费" —— 老板确认 agnes-3.0-flash 免费,
      // 这条 warn 若照旧说"按量计费", 等于每次都报一个不存在的花钱风险, 报着报着
      // 就没人看了 (真出事那天也一样没人看)。按实际价格说话。
      const _c = _modelCost.modelCost(_pick);
      // 刊例价是 /1k 量级的极小数 (0.00005 + 0.00015), 直接拼字符串会拖出
      // "0.00019999999999999998" 这种浮点尾巴 —— 这行是主人看"钱花哪了"的
      // 唯一线索, 显示成那样等于没人看。显示层收拾干净, 计算层一分不动。
      const _fmt = (n) => String(Number(n.toPrecision(6)));
      const _price = _c.known
        ? (_c.per1k > 0
          ? ('按量计费 ' + _fmt(_c.per1k) + '/1k')
          // 2026-10-16: 临时的免费要说出来。"免费"两个字在磁盘上躺久了就变成
          // 一句没人复查过的承诺 —— 官方优惠结束那天, 这行日志还在替它背书说免费。
          : (_c.list_per1k ? ('免费 (优惠结束按 ' + _fmt(_c.list_per1k) + '/1k 计)') : '免费'))
        : '价格未配 (按配置顺序挑的, 不代表挑了最便宜)';
      console.warn('[longctx] 本地模型 ' + _from.id + ' 不可用 → 降级到**云端** ' + _pick.id
        + ' (' + _price + ')。池里已无可用本地模型 ('
        + cand.filter(m => _modelCost.isLocalModel(m)).length + ' 个)。'
        + '要避免这次切换: 挂一个备用本地模型, 或给按量计费的模型补 cost 字段让选择可控。');
    }
  }
  return _pick;
}

function resolveModel(cfg, model, msgCount, alreadyDowngraded, estTokens) {
  // 开源默认阈值 80 (任何人零配置也省); 设 PANGU_LONGCTX_FALLBACK_MSGS=0 可强制关
  const threshold = parseInt(process.env.PANGU_LONGCTX_FALLBACK_MSGS === undefined ? '0' : process.env.PANGU_LONGCTX_FALLBACK_MSGS, 10);
  if (threshold <= 0) return { model, downgraded: false, reason: 'disabled' };
  if (typeof msgCount !== 'number' || msgCount < threshold) return { model, downgraded: false, reason: 'below-threshold' };
  const models = (cfg && cfg.llm && Array.isArray(cfg.llm.models)) ? cfg.llm.models : [];
  // 显式配置优先; 没配 → 自动挑池里最省 (开源默认行为)
  const explicit = _getFallbackModelId(cfg);
  let fb = null;
  if (explicit) fb = models.find(m => m.id === explicit && m.enabled !== false);
  if (!fb) fb = _pickCheapestModel(models, model && model.id, alreadyDowngraded, estTokens);
  if (!fb) return { model, downgraded: false, reason: 'no-cheaper-model' };
  // alreadyDowngraded: 本会话已降级过的模型集合, 防止在 2 个模型间反复横跳
  // 当前模型已在降级序列里 (或所有更省模型都试过) → 不再降, 防横跳
  if (Array.isArray(alreadyDowngraded) && (alreadyDowngraded.includes(model && model.id) || alreadyDowngraded.includes(fb.id))) {
    return { model, downgraded: false, reason: 'all-cheaper-tried' };
  }
  if (model && model.id === fb.id) return { model, downgraded: false, reason: 'already-cheapest' };
  console.log('[longctx-fallback] msgs=' + msgCount + ' >= ' + threshold + ' → 本轮降级 ' + (model && model.id) + ' → ' + fb.id + ((explicit ? ' (显式配置)' : ' (自动选最省)')));
  return { model: fb, downgraded: true, reason: 'long-ctx-fallback' };
}

// 2026-09-16 老板拍 "本地模型不是优先, 所有模型公平": _pickLocalModel 已删, 端点瞬断一律走 _pickCheapestModel (cost 公平选)
module.exports = { resolveModel, _getFallbackModelId, _pickCheapestModel };
