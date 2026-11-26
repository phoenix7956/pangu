'use strict';

// 模型配置里有一堆"指向别的 id"的字段:
//   llm.current_model_id   — 主模型
//   llm.fallback_id        — 兜底
//   llm.fallback_chain     — 兜底链
//   llm.role_models{role}  — 子 agent 专属模型 ← 2026-10-17 起是死字段, 直接删
//
// 这些字段全部是**字符串引用**, 池子随时会被前端增删改 (加模型/删模型/改
// provider), 而没有任何一处校验它们还指不指得到东西。
//
// 2026-10-14 现场 (your-mac.json):
//   fallback_id     = google_gemma-4-26b-a4b-qat   ← 池里没有这条
//   fallback_chain  = [google_gemma-4-26b-a4b-qat, qwen_qwen3.6-35b-a3b]  ← 两条都是幽灵
//
// 后果: 主模型一失败, 兜底链指向空气, 整轮直接死; 而且**全程零报错** ——
// 配置看着挺全, 跑起来才发现是空壳。
//
// 2026-10-17: 子 agent 改为**无条件**继承主模型, llm.role_models 和
// agent.role_configs[*].model 两个字段双双变成死字段 (role_model.js 不再读它们)。
// 处理方式跟 llm.provider 一样是**删掉**, 理由也一样: 没有任何东西会跟着
// current_model_id 更新它们, 留着注定再次说谎, 而它们长得像能用的开关。
// 跟"悬空引用"是两回事 —— 就算引用的模型在池里存在, 它也一样是死的,
// 旧逻辑只查"指不指得到", 于是配得好好的 override 会安静地躺在配置里。
//
// 这里在启动时把每一条引用都对着池子核一遍, 该报的报、该修的修。
// 不静默改 current_model_id (那是用户的显式选择, 只能报不能替用户决定),
// 但兜底链/role_models 这种"兜底性质的引用"可以在池里找得到替身时自动修。

function _ids(cfg) {
  const models = (cfg && cfg.llm && Array.isArray(cfg.llm.models)) ? cfg.llm.models : [];
  return new Set(models.filter((m) => m && m.id).map((m) => String(m.id)));
}

function _usable(cfg, id) {
  const models = (cfg && cfg.llm && Array.isArray(cfg.llm.models)) ? cfg.llm.models : [];
  const hit = models.find((m) => m && m.id === id);
  return !!(hit && hit.enabled !== false);
}

// 兜底替身: 池里 enabled 且还没在链上的第一条。优先本地的? 不 ——
// 兜底的语义是"主模型挂了还能出活", 本地端点随时可能没加载, 所以不挑本地。
function _pickReplacement(cfg, exclude) {
  const models = (cfg && cfg.llm && Array.isArray(cfg.llm.models)) ? cfg.llm.models : [];
  const used = new Set((exclude || []).filter(Boolean));
  const ok = models.filter((m) => m && m.id && m.enabled !== false && !used.has(String(m.id)));
  return ok.length ? String(ok[0].id) : null;
}

// ── 端点类型: 本地还是云端 ─────────────────────────────────────────────────
// 真源是**每个模型自己的 endpoint** —— 本地端点走 loopback, 云端走公网域名。
// 老板关心的「盘古现在到底在用本地模型还是云端模型」只能从这里回答, 不许看
// 任何"看起来像 provider"的字段 (见下面第 4 段: 那个字段是死的)。
function _isLocalEndpoint(m) {
  const ep = String((m && (m.endpoint || m.base_url || m.url)) || '');
  if (!ep) return false;
  return /127\.0\.0\.1|localhost|::1|\[::1\]|0\.0\.0\.0|192\.168\.|10\.\d+\.|172\.(1[6-9]|2\d|3[01])\./i.test(ep);
}

// 解析"当前真正在用的模型" —— 必须与 pangu_helpers.getCurrentModel() 同规则,
// 不然这里报的和实际跑的不是一回事, 那比不报更坏。
function _resolveActive(cfg) {
  const llm = (cfg && cfg.llm) || {};
  const models = (Array.isArray(llm.models) ? llm.models : []).filter((m) => m && m.id && m.enabled !== false);
  if (!models.length) return null;
  const id = llm.current_model_id ? String(llm.current_model_id) : null;
  const cur = id ? models.find((m) => String(m.id) === id) : null;
  if (cur) return cur;
  // 兜底: enabled 里 priority 最高的 (getCurrentModel 的同款兜底)
  return models.slice().sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
}

/**
 * @returns {{ok:boolean, dangling:Array, fixed:Array, warnings:string[], repaired:boolean}}
 */
function checkModelConfig(cfg, opts = {}) {
  const apply = opts.apply !== false;
  const warnings = [];
  const dangling = [];
  const fixed = [];
  const llm = (cfg && cfg.llm) || {};
  const ids = _ids(cfg);

  if (!llm.models || !Array.isArray(llm.models)) {
    return { ok: false, dangling: [], fixed: [], warnings: ['llm.models 缺失或不是数组'], active: null, repaired: false };
  }

  // ── 1. current_model_id: 用户显式选择, 只报不修 ──────────────────────
  const cur = llm.current_model_id;
  if (cur && !ids.has(String(cur))) {
    dangling.push({ field: 'llm.current_model_id', value: cur, why: '池里没有这个 id' });
    warnings.push('current_model_id=' + cur + ' 指向不存在的模型 —— 请求会落到"enabled 第一个"而不是你选的那个');
  } else if (cur && !_usable(cfg, cur)) {
    warnings.push('current_model_id=' + cur + ' 存在但 enabled=false, 不会被选中');
  }

  // ── 2. fallback_id / fallback_chain: 兜底性质, 可以修 ────────────────
  const chain = Array.isArray(llm.fallback_chain) ? llm.fallback_chain.map(String) : [];
  const fbId = llm.fallback_id ? String(llm.fallback_id) : null;

  if (fbId && !ids.has(fbId)) {
    dangling.push({ field: 'llm.fallback_id', value: fbId, why: '池里没有这个 id' });
  }
  for (const c of chain) {
    if (!ids.has(c)) dangling.push({ field: 'llm.fallback_chain[]', value: c, why: '池里没有这个 id' });
  }

  // 兜底链全空 / 全是幽灵 → 主模型一失败就没得救, 这是最危险的一种
  const liveChain = chain.filter((c) => ids.has(c));
  if (!liveChain.length) {
    const rep = _pickReplacement(cfg, [cur]);
    if (apply && rep) {
      llm.fallback_chain = [rep];
      llm.fallback_id = rep;
      fixed.push({ field: 'llm.fallback_chain', from: chain, to: [rep] });
      warnings.push('兜底链全是幽灵, 已重指向池里真实存在的 ' + rep);
    } else {
      warnings.push('兜底链里没有一条指向真实模型 —— 主模型一失败就是整轮死');
    }
  } else if (apply && liveChain.length !== chain.length) {
    // 只留真实存在的, 再补一条替补
    const next = liveChain.slice();
    const rep = _pickReplacement(cfg, [cur, ...next]);
    if (rep) next.push(rep);
    llm.fallback_chain = next;
    if (!next.includes(llm.fallback_id)) llm.fallback_id = next[0] || null;
    fixed.push({ field: 'llm.fallback_chain', from: chain, to: next });
    warnings.push('兜底链剔掉了 ' + (chain.length - liveChain.length) + ' 条幽灵引用');
  }

  // ── 3. role_models / role_configs[*].model: 2026-10-17 起是**死字段** ──
  //
  // 老板拍板: 子 agent **完全继承主模型**, 单独配模型这条路去掉。
  // 改完之后 role_model.js 里没有任何一条分支读这两个字段, 所以它们跟
  // 上一段那个 llm.provider 是同一类东西 —— 留着就注定说谎, 而且是最坏的
  // 那种: 它长得像个能用的开关, 界面上还曾经有过下拉框 (设置·将灵页),
  // 主人改了它却发现子 agent 照跑主模型, 只会以为盘古坏了。
  // 所以处理方式和 llm.provider 一致: **删掉**, 不是留着"这次恰好是对的"。
  //
  // 注意这跟"悬空引用"是两回事: 就算引用的模型**在池里存在**, 它也一样是死的。
  // 旧逻辑只查"指不指得到", 于是配得好好的 override 会安静地躺在配置里
  // —— 那才是最坏的情况, 因为连告警都不会有。
  const roleModels = (llm && typeof llm.role_models === 'object') ? llm.role_models : null;
  if (roleModels && Object.keys(roleModels).length) {
    const from = Object.entries(roleModels).map(([r, v]) => 'llm.role_models.' + r + '=' + v);
    if (apply) {
      delete llm.role_models;
      fixed.push({ field: 'llm.role_models', from, to: '(已删除 — 子 agent 已改为无条件继承主模型)' });
      warnings.push(
        'llm.role_models (' + from.join(', ') + ') 已删除: 子 agent 现在无条件继承主模型, '
        + '这个字段没有任何代码再读它。留着它只会让人以为改了能生效'
      );
    } else {
      warnings.push(
        'llm.role_models (' + from.join(', ') + ') 已失效: 子 agent 现在无条件继承主模型, '
        + 'role_model.js 不再读它 (配置里留着不影响运行, 但它是误导)'
      );
    }
  }
  const rcAll = (cfg.agent && cfg.agent.role_configs && typeof cfg.agent.role_configs === 'object')
    ? cfg.agent.role_configs : null;
  if (rcAll) {
    const hit = Object.entries(rcAll)
      .filter(([, v]) => v && typeof v === 'object' && v.model)
      .map(([k, v]) => 'agent.role_configs.' + k + '.model=' + v.model);
    if (hit.length) {
      if (apply) {
        for (const [, v] of Object.entries(rcAll)) if (v && typeof v === 'object') delete v.model;
        fixed.push({ field: 'agent.role_configs[*].model', from: hit, to: '(已删除 — 同上)' });
        warnings.push(
          'agent.role_configs[*].model (' + hit.join(', ') + ') 已删除: 设置·将灵页的 per-role 模型'
          + '选择器已下线, 子 agent 现在无条件继承主模型 (推理强度/步数/沙箱那些照旧)'
        );
      } else {
        warnings.push(
          'agent.role_configs[*].model (' + hit.join(', ') + ') 已失效: 设置·将灵页的 per-role 模型'
          + '选择器已下线, 子 agent 现在无条件继承主模型'
        );
      }
    }
  }

  // ── 4. llm.provider: 死字段, 而且它说谎 ────────────────────────────────
  //
  // 现场 (2026-10-17): your-mac.json 里
  //     llm.provider         = 'lmstudio'                     ← 本地
  //     llm.current_model_id = 'minimax_m3.1-flash-preview'   ← 云端
  // 两行字面矛盾。而它之所以能一直躺着, 是因为**没有任何代码读它**:
  //   · Pangu 自己的默认配置形状就是 { llm: { models, current_model_id } },
  //     压根没有 provider 这一项 (pangu-single.js 的 _config 兜底形状)
  //   · 全仓库 grep `llm.provider` = 0 命中 (含前端/路由/测试)
  // 路由只认 current_model_id → 命中模型自己的 endpoint。
  //
  // 代价不是"多一行脏数据", 是**盘古自己的子 agent 会把它当矛盾反复上报**:
  // 现场 checker 抓到这行判 FAIL, 触发两轮补救 (executor 重推同一张表),
  // 每轮都在追一个改配置也解决不了的幻影 —— 白烧 token。
  //
  // 修法是删掉它, 不是把它改成"这次恰好对"的值。理由: 没有任何东西会跟着
  // current_model_id 一起更新这个字段 (换模型/删模型/改 endpoint 都不经过它),
  // 所以只要留着就注定会再次说谎。留着"这次恰好是对的"更危险 —— 它看着像个
  // 可信字段, 下次换模型就又错了。删掉之后真源只剩一个, 说谎的可能性归零。
  if (Object.prototype.hasOwnProperty.call(llm, 'provider')) {
    const claimed = String(llm.provider);
    const active = _resolveActive(cfg);
    const kindOf = (m) => (_isLocalEndpoint(m) ? '本地端点' : '云端端点');
    const nameOf = (m) => (m.provider || '(未标 provider)');
    if (apply) {
      delete llm.provider;
      fixed.push({ field: 'llm.provider', from: claimed, to: '(已删除 — 死字段, 路由不读它)' });
      warnings.push(
        'llm.provider=' + claimed + ' 是个死字段 (全仓库没有任何代码读它, 路由只认 '
        + 'current_model_id → 模型自己的 endpoint), 却和实际选择对不上。已删除: '
        + (active ? '当前在用 ' + active.id + ' (' + nameOf(active) + ', ' + kindOf(active) + ')' : '当前解析不出可用模型')
      );
    } else if (active && claimed !== nameOf(active)) {
      warnings.push(
        'llm.provider=' + claimed + ' 与实际选择矛盾 —— 当前在用的是 ' + active.id
        + ' (' + nameOf(active) + ', ' + kindOf(active) + '); 这个字段没有代码读它, 换模型时也不会跟着更新'
      );
    }
  }

  // ── 5. 当前在用模型 (本地还是云端) —— 老板唯一关心的那个口径 ──────────────
  //
  // 以前要回答"盘古现在跑的是本地还是云端", 只能翻配置自己猜。现在算出来。
  //
  // **刻意不放进 warnings**: warnings 的语义是"你的配置有问题", 而
 // 2026-10-14 的 S4/S5 两条护栏钉死了「健康配置零误报」—— 每开机念叨一遍
// "当前在用的是 X" 就是新噪音, 正是这个模块要消灭的东西。
  // 所以它是**状态**, 单开一个 active 字段返回, 由调用方按 info 口径打印。
  // (current_model_id 没选中这件事本身**已经**由第 1 段报成 warning 了, 不重复。)
  let active = null;
  const _active = _resolveActive(cfg);
  if (_active) {
    const _curId = llm.current_model_id ? String(llm.current_model_id) : null;
    const _hit = !!(_curId && (Array.isArray(llm.models) ? llm.models : [])
      .some((m) => m && m.id && String(m.id) === _curId && m.enabled !== false));
    active = {
      id: _active.id,
      provider: _active.provider || null,
      kind: _isLocalEndpoint(_active) ? 'local' : 'cloud',
      via: _hit ? 'current_model_id' : 'fallback',
      requested_model_id: _curId,
      as_requested: _hit,
    };
  }

  return {
    ok: dangling.length === 0,
    dangling,
    fixed,
    warnings,
    active,
    repaired: apply && fixed.length > 0,
  };
}

module.exports = { checkModelConfig };
