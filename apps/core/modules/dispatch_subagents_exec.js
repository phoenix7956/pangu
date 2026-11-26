// ============================================================================
// dispatch_subagents 执行器 — 主循环侧
// ============================================================================
//
// 放在这里而不是 tools/index.js 的原因 (已核实, 别重新推导):
// tools 的执行 ctx 只有 { user, sessionId } —— **没有** res / model / configPath,
// 而派发要的三样全都在这儿: res (SSE 建卡 + 活性) / model (子 agent 继承) /
// configPath (角色档位)。塞进 tools 就得把这一整套从闭包里掏出来传进去, 反而更乱。
//
// 递归派发为什么不做: 没有深度闸门时这是 token 黑洞 —— 一个 executor 可以自己再拆
// 三个 executor, 子会话的 abort 域和账本都会失控。这里硬锁: 只有 main 角色能派,
// 子 agent 的白名单里根本没有这个工具名 (见 tools_schema MAIN_GENERAL_TOOLS_FOR_LLM
// 只给 main 加, 而角色白名单由 sub-agent.js ROLES.tools 独立给)。

const { createSubagentRunner } = require('./subagent_runner');
const { renderDispatchResult } = require('./dispatch_subagents_schema');

/**
 * 这一刀是不是**主 agent 自己干不了**的活?
 *
 * 2026-10-24 (第 79 批实测): 原来的单刀硬拦 (那个错码) 是个**代理判据** ——
 * 它拿"刀数"去代理"该不该派", 而这两样只在一种情况下相等: 主 agent 手上工具齐全。
 * 主 agent 一旦自己缺工具, 这个代理就判错了:
 *
 *   ① MCP 工具: 第 79 批刚定下「MCP 只给 worker, 不给 main」(main 一次拿到 44 个
 *      MCP 工具会造成选择噪声, 实测 82 个工具那版模型**一个工具都没调**, success=false)。
 *      于是「派一刀去查 MCP」**天生就是单刀** —— 这道闸等于把 MCP 派活堵死了。
 *   ② 将灵专属工具: web_fetch / weather_check / stock_quote / github_api / http_check …
 *      都不在 main 的 38 个里 (真源: MAIN_GENERAL_TOOLS_FOR_LLM)。
 *      「派 li 去查这一个网页」也是单刀。
 *
 * 实测代价 (probe79-mcp): 主 agent 派了一个**合法**的一刀 (kun 用 MCP 的 filesystem
 * 工具读 IDENTITY.md), 撞上 DISPATCH_SINGLE ⇒ 白烧一轮本地推理 ⇒ 拿回一句
 * 「这不该派活」⇒ 主 agent 改用 exec_command 自己干了。
 * 闸门省下的往返并不存在 —— 它自己**多造了一轮**。
 *
 * 所以判据换成真的那件事: **主 agent 自己调得到这个工具吗?**
 *   · 任务里点名了主 agent 调不到的工具 (MCP 工具 / 别的将灵白名单里的工具)
 *     ⇒ 这一刀必须外包 ⇒ 放行 (1 刀也派)。
 *   · 点名的工具主 agent 也有, 或者根本没点名 ⇒ 原来的纪律照旧: 自己干, 别派。
 *
 * 判据落在**真源表**上 (MAIN_GENERAL_TOOLS_FOR_LLM / sub-agent.js 的 ROLES.tools),
 * 不是提示词里的一句承诺。
 */
function _mainCallableTools() {
  try {
    const { MAIN_GENERAL_TOOLS_FOR_LLM } = require('./tools_schema');
    return new Set(Array.isArray(MAIN_GENERAL_TOOLS_FOR_LLM) ? MAIN_GENERAL_TOOLS_FOR_LLM : []);
  } catch (_) { return new Set(); }
}

// 别的将灵能调、主 agent 调不到的那些工具 (MCP 工具不在白名单里, 单独处理)
function _toolsMainCannotCall() {
  const mainSet = _mainCallableTools();
  const out = new Set();
  try {
    const roles = require('../agents/sub-agent.js').ROLES || {};
    for (const k of Object.keys(roles)) {
      for (const t of (roles[k].tools || [])) {
        if (t && !mainSet.has(t)) out.add(t);
      }
    }
  } catch (_) {}
  return out;
}

function _knifeNeedsToolMainLacks(taskText) {
  const text = String(taskText || '');
  if (!text.trim()) return false;
  // MCP: 主 agent 一个 MCP 工具都没有 (第 79 批的规矩), 任务里提到 MCP 就是"我调不到"
  if (/mcp/i.test(text)) return true;
  for (const t of _toolsMainCannotCall()) {
    if (text.indexOf(t) >= 0) return true;
  }
  return false;
}

function normalizeTasks(params) {
  // 模型的 JSON 常有三种歪法: 包在 raw 字符串里 / 直接给对象 / 给 {tasks:[...]} 外壳。
  // 这里全接住 —— 接不住的表现是"主 agent 调了工具但一把都没派出去", 而那正是
  // 这条链路最初要解决的问题, 不能自己再犯一次。
  let p = params;
  for (let i = 0; i < 2 && p && typeof p.raw === 'string'; i++) {
    try {
      const parsed = JSON.parse(p.raw.trim());
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) break;
      p = { ...parsed, ...Object.fromEntries(Object.entries(p).filter(([k]) => k !== 'raw')) };
    } catch (_) { break; }
  }
  if (!p || typeof p !== 'object') return [];
  let list = Array.isArray(p) ? p : (Array.isArray(p.tasks) ? p.tasks
    : (Array.isArray(p.subtasks) ? p.subtasks
      : (Array.isArray(p.sub_tasks) ? p.sub_tasks : null)));
  if (!list) return [];
  return list
    .map((t) => ({
      // agent 在**这里**归一成规范名 (拼音), 下游整条链路拿到的都是它。
      //
      // 2026-10-18 (拼音迁移) 实测: 不归一时, 模型吐 `{"agent":"离"}` 或 `Analyzer`
      // 这类写法, 下游 subagent_runner.js:537 的 `ROLES[subTask.agent]` 查不到 →
      // 走"未知角色"分支 → **降级成无白名单全量工具**。只读角色就此拿到写盘权,
      // 边界静默失效且日志只有一行 warn。归一放在这里 = 一次修好所有下游。
      //
      // 认不出来的名字原样留着: 交给 validateTasks 报错, 不在这里猜成 executor ——
      // 猜错的话一把错刀会以合法身份真跑起来, 比报错糟得多。
      agent: (() => {
        const rawName = String((t && (t.agent || t.role)) || 'kun').trim().toLowerCase();
        return require('../agents/gua-identity').resolveRole(rawName) || rawName;
      })(),
      task: String((t && (t.task || t.prompt || t.description)) || '').trim(),
      depends_on: Array.isArray(t && t.depends_on)
        // 2026-10-17: 不能写 `Number(n)` —— Number(null) 和 Number('') 都等于 **0**,
        // 于是模型给一个 depends_on: [null] 会被悄悄接成"依赖第 0 刀",
        // DAG 等一个它根本没提过的上游。空值必须直接丢掉, 一个字面 0 才是下标 0。
        ? t.depends_on
          .filter((n) => typeof n === 'number' || (typeof n === 'string' && /^\d+$/.test(n.trim())))
          .map((n) => Number(n))
          .filter((n) => Number.isInteger(n) && n >= 0)
        : [],
    }))
    // 空 task 的刀派下去就是白烧一轮 —— 丢掉, 并在结果里告诉主 agent 少了哪几刀
    .filter((t) => t.task.length > 0);
}

// 角色名校验。**拼音和英文都认** (2026-10-18 迁移)。
//
// 为什么必须两种都认: 规范名已经改成拼音, 但模型的先验里全是 analyzer/executor 这类
// 英文名 (提示词历史、checkpoint、别的项目经验)。这里只放行拼音的话, 模型吐一个
// `{"agent":"analyzer"}` 就被判"未知角色" —— **一刀都没跑, 整轮直接废掉**。
// 那不是容错, 那是自己给自己造一个新的线上故障。归一在 resolveRole 里做。
//
// 认不出来的角色按通用 loop 跑 (无白名单 = 全量工具) —— 派发器里已有这条降级路径,
// 不在这里硬拦, 否则一个错字就整轮废掉。
function validateTasks(tasks) {
  const errors = [];
  // 可派角色 = 8 将灵里真正有工具、能独立干活的 6 个 (qian/kan 无工具, 由主循环直接做)
  const _g = require('../agents/gua-identity');
  const DISPATCHABLE = new Set(['li', 'kun', 'dui', 'xun', 'zhen', 'gen']);
  // 报错文案里只列拼音 —— 列两套名字只会让模型更乱, 而它写英文本来就会被接受。
  const KNOWN = _g.GUA_ROLES.filter(r => DISPATCHABLE.has(r.code)).map(r => r.code);
  const list = Array.isArray(tasks) ? tasks : [];
  for (const t of list) {
    // resolveRole (不是 resolveRole): 必须和上面 normalizeTasks 用**同一个**解析器。
    // 两处不一致 = 校验放行、归一落空, 模型写的名字会一路带着英文往下走。
    const canonical = _g.resolveRole(t.agent);
    if (!canonical || !DISPATCHABLE.has(canonical)) {
      errors.push('未知角色 "' + t.agent + '" (可用: ' + KNOWN.join('/') + ')');
    }
  }
  // depends_on 越界 = DAG 永远等不到上游, 会在 dagGuard 里被降级全放出, 白等一圈
  // (depends_on 可能压根不是数组 —— 模型给成字符串/数字是常事, 所以这里不假设形状)
  for (const t of list) {
    for (const d of (Array.isArray(t.depends_on) ? t.depends_on : [])) {
      if (d >= list.length) errors.push('depends_on 下标 ' + d + ' 越界 (只有 ' + list.length + ' 刀)');
    }
  }
  return errors;
}

/**
 * 跑一次主 agent 自派。返回 tool result 形状 { name, ok, content }。
 *
 * 不传配额快速失败钩子 —— 那是 dispatcher 的**收口政策**, 主循环这边不同:
 * 一刀全挂了就如实告诉主 agent (工具结果里写明白), 由主 agent 自己决定怎么跟主人说。
 * 这也是 createSubagentRunner 里钩子可选的意义。
 */
async function runDispatchSubagents({
  params, model, req, res, sessionId, opts, userInput, configPath,
  // planOnly: 只收方案, 一刀都不跑 —— dispatcher 用它把"拆解决定权"交给主 agent,
  // 而派发和收口仍留在 dispatcher 那条成熟路径上 (合成/对账/验收全不动)。
  // 不这么做就得连 synthesis + 验收闭环一起重写, 那是拿高风险换一个抽象上的整齐。
  planOnly, onPlanned,
}) {
  const name = 'dispatch_subagents';
  const tasks = normalizeTasks(params);
  if (!tasks.length) {
    return {
      name, ok: false,
      content: 'DISPATCH_NO_TASKS: 没解析出任何可派的刀。参数形状应该是 '
        + '{"tasks":[{"agent":"li","task":"...","depends_on":[]}]}。'
        // 示例必须是拼音 —— 这条文本会原样回给模型当它自己写的形状的样板。
        // 之前这里示范 "analyzer", 而 schema 的 enum 是拼音: 两份样板摆在一起,
        // 模型照着哪个写都不算错, 但只有一边接得住。
        + '(角色只能用拼音: ' + require('../agents/gua-identity').GUA_CODES.join('/') + ')。'
        // 这条必须自带"怎么办", 不能靠下一条错误码的字顺带被扫到:
        // 以前它只说了形状对不对, 主 agent 收到"没解析出刀"却不知道该改什么,
        // 于是原样重发一遍或者干脆自己编个结论。测试 T6 之前是**蒙对**的 ——
        // 它在 500 字窗口里扫到了紧挨着的 DISPATCH_SINGLE 的"或者别派"。
        + '该怎么办: 每个刀对象必须有非空 task; 确认 JSON 键名是 tasks/task/agent/depends_on;'
        + '若这活本来就该自己动手做, 就别派活。',
    };
  }
  // 2026-10-28 第 129 批: 派活闸门 —— 拦「把命理题派成史实调研」。
  //
  // 现场 (2026-10-27 23:40, 会话 15567183): 主 agent 派的这一刀原文是
  //   「查证「1975年(尤其中四川省/成都)居民家庭周边的实际生活环境」, 为一份1975年2月8日
  //     出生四川者的**八字命理报告**提供「出生地周围情况」一节的事实底座」——
  //   命理 + 时代统计, 两样齐了 ⇒ 这刀从一开始就不该派。
  //   派出去之后: 子 agent 4 条 web_search + 若干 web_fetch(每次 30s 超时) ⇒ 10 分钟没完。
  //
  // 「分析出生地周围情况」在子平法里 = 出生地的地理环境(地形/山水/水土/气候寒暖燥湿),
  // 用来判调候; 不是出生年代的经济社会统计。口径真源 = modules/bazi_items.js。
  try {
    const _bi = require('./bazi_items');
    const _tc = _bi.getTurnContext(sessionId);
    const _turnText = String(userInput || '');
    const _itemTask = Boolean(_tc && _tc.itemTask) || _turnText.indexOf(_bi.ITEM_MARKER) >= 0;
    const _v = _bi.inspectDispatchTasks(tasks, { turnText: _turnText, itemTask: _itemTask });
    if (_v && _v.blocked) {
      console.warn('[bazi-items] 拦下派活 (' + _v.why + '): ' + String(_v.task || '').slice(0, 80));
      return {
        name, ok: false,
        content: 'DISPATCH_ITEM_SCOPE: 这一刀不该派 —— ' + _v.why + '。'
          + '接下来该做的事: 用 bazi_calc 的确定性盘面, 按题目八条逐条作答。'
          + '「分析出生地周围情况」= 出生地的地理环境(地形/山水/水土/气候寒暖燥湿), 用来判调候; '
          + '不是出生年代的经济社会统计(GDP/人均收入/平均工资/城镇化率/人口总数/统计公报), 不需要外网调研。',
      };
    }
  } catch (_) { /* 闸门异常不阻断派活 */ }
  if (tasks.length === 1) {
    // 一件事该不该派活, 取决于**主 agent 自己能不能干** (见 _knifeNeedsToolMainLacks 的注释)。
    // 能干 ⇒ 拿并行机制干一件自己能干的活 = 多一轮往返, 拦下;
    // 不能干 (MCP 工具 / 将灵专属工具) ⇒ 这一刀天生就是外包, 放行。
    if (!_knifeNeedsToolMainLacks(tasks[0].task)) {
      return {
        name, ok: false,
        content: 'DISPATCH_SINGLE: 只解析出 1 刀, 而这一刀做的事**你也能做** —— '
          + '别拿并行机制干一件自己能干的活 (白多一轮往返)。'
          + '该怎么办: 自己直接做; 要真派就把 ≥2 刀一次给全; '
          + '只有将灵才有工具的活 (MCP 工具 / web_fetch / weather_check 这类), '
          + '在任务里点名那个工具, 这次就放行。',
      };
    }
    console.log('[dispatch] 单刀放行: 这一刀点名的工具主 agent 自己调不到 '
      + '(MCP / 将灵专属) ⇒ 这一刀值得外包');
  }
  const errs = validateTasks(tasks);
  if (errs.length) {
    return {
      name, ok: false,
      content: 'DISPATCH_INVALID: 派活参数有问题, 这次一刀都没跑 (别重发同样的参数):\n- '
        + errs.join('\n- '),
    };
  }

  if (planOnly) {
    try { if (typeof onPlanned === 'function') onPlanned(tasks); } catch (_) {}
    return {
      name, ok: true,
      content: 'PLAN_ONLY: 已记录 ' + tasks.length + ' 刀 ('
        + tasks.map((t) => t.agent).join('/')
        + ')。本轮**不执行** —— 执行方接手。这一轮到此结束, 不要输出文字分析, 不要自己动手做。',
    };
  }

  const results = [];
  let runner;
  try {
    runner = createSubagentRunner({
      // req 必须往下传: 子 loop 靠它接"主人关掉页面", 不传就是关页面后
      // 子 agent 继续烧 token 烧到跑完 (从 dispatcher 闭包搬到共享模块时最容易丢的一根线)。
      req: req || null,
      res,
      sessionId,
      userInput: userInput || '',
      model,
      configPath,
      opts: opts || {},
      subTasks: tasks,
      results,
      guaLine: '',
      dialogImages: (opts && opts.dialogImages) || [],
      // 子 agent 跑的就是**这个** loop —— 同一个实现, 不另起一条路径。
      // 递归锁: runner 里传 role = 子 agent 名, 而 dispatch_subagents 只在 main 集里,
      // 所以孙子那一层根本看不到这个工具名。
      runSubAgentLoop: (msgs, mdl, rq, rs, op) => _runSubAgentLoop(msgs, mdl, rq, rs, op),
      // 2026-10-28 (现场 /api/pangu/agent/stream 实跑抓原始 SSE 抓到):
      //   这里原来传的是 `_safeResWrite(res)` —— 一个 **2 参** 闭包 `(ev, data)`;
      //   而 subagent_runner.js 里是按 **3 参** 约定 `safeResWrite(res, event, data)` 调的。
      //   两边对不上 ⇒ 第一个实参 res 被当成事件名, 第二个实参 'status'/'sub_agent_start'
      //   被当成载荷, 于是线上真实收到的是:
      //       event: [object Object]
      //       data: "sub_agent_start"
      //   前端 switch(eventName) 认不出 ⇒ **一张子 agent 卡都建不起来** (老板现场:
      //   "第一次以后调用子agent和工具都不显示")。
      //   修法: 签名跟 pangu_helpers.safeResWrite / j2_dispatcher 注入的那份**同构**,
      //   3 参 (res, event, data), 调用方直接传函数本身, 不再闭包 res。
      safeResWrite: _safeResWrite,
      ctxForSubagent: (mode, taskText, excludePaths) =>
        _ctxForSubagentForTask(sessionId, taskText, excludePaths),
    });
    await runner.runAll();
  } catch (e) {
    try {
      res.write('event: error\ndata: ' + JSON.stringify(
        { error: 'dispatch_subagents failed: ' + e.message, ts: Date.now() }) + '\n\n');
    } catch (_) {}
    return {
      name, ok: false,
      content: 'DISPATCH_ERROR: 派发机制抛错, 一刀都没跑成: ' + String(e.message).slice(0, 300)
        + '\n【怎么办】别把这当成"子 agent 没产出", 如实告诉主人派发本身失败了。',
    };
  }

  const rendered = renderDispatchResult(results, { perAgentChars: 1200 });
  try {
    res.write('event: sub_agent_dispatch_done\ndata: ' + JSON.stringify({
      count: results.length,
      agents: results.map((r) => r.agent),
      failed: results.filter((r) => r.error).length,
      ts: Date.now(),
    }) + '\n\n');
  } catch (_) {}
  return { name, ok: rendered.ok, content: rendered.content };
}

// 这个 loop 自己不能 require 自己 (循环依赖), 由 j2_agent_loop 注入。
let _loopRef = null;
function registerLoop(loopRef) { _loopRef = loopRef; }
function _runSubAgentLoop(messages, model, req, res, opts) {
  if (!_loopRef || typeof _loopRef._runAgentLoopLegacyStream !== 'function') {
    throw new Error('dispatch_subagents_exec 还没注册主循环 (registerLoop 未调用)');
  }
  return _loopRef._runAgentLoopLegacyStream(messages, model, req, res, opts);
}

// 2026-10-28: 签名改成 3 参 (res, event, data) —— 跟 modules/pangu_helpers.js 的
// safeResWrite、以及 j2_dispatcher 注入给 subagent_runner 的那一份**逐字同构**。
// 原来这里是 2 参闭包, 而调用方 (subagent_runner.js) 传的是 (res, event, data),
// 于是 res 变成事件名 → "event: [object Object]" → 前端认不出 → 子 agent 卡建不起来。
// 详见上面 createSubagentRunner 里 safeResWrite 那一处的现场取证注释。
function _safeResWrite(res, ev, data) {
  try { res.write('event: ' + ev + '\ndata: ' + JSON.stringify(data || {}) + '\n\n'); }
  catch (_) {}
}

// 按本次作业文本挑相关上下文 (与 dispatcher 同一个 buildScopedContext, 同一套判据)
function _ctxForSubagentForTask(sessionId, taskText, excludeScopePaths) {
  try {
    const sc = require('./session_container').getContainer();
    const live = sc.buildScopedContext(sessionId, {
      taskText: String(taskText || ''),
      includeFindings: true,
      upToTurns: 12,
      excludeScopePaths: excludeScopePaths || [],
    });
    if (!live) return undefined;
    return { turns: live.turns || [], findingsBlock: live.findingsBlock || '', rootId: live.rootId };
  } catch (_) { return undefined; }
}

module.exports = {
  runDispatchSubagents,
  registerLoop,
  normalizeTasks,
  validateTasks,
  // 2026-10-24 (第 79 批): 单刀放行的判据, 导出给测试直接打 (别让测试去数源码字符)。
  _knifeNeedsToolMainLacks,
  DISPATCH_TOOL_NAME: 'dispatch_subagents',
};
