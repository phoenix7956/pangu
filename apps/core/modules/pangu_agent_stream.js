// modules/pangu_agent_stream.js — N5 refactor batch B6
// _handlePanguAgentStream — 547 行, 从 pangu-single.js 拆出
// 依赖: 通过 init(deps) 注入

const fs = require('fs');
const path = require('path');
const os = require('os');
const http = require('http');
const https = require('https');
const safeGuard = require('../pangu-single/safe-guard/global');
const panguHelpers = require('./pangu_helpers');
const { resolveTaskInput, ensureCurrentUserMessage } = require('./answer_alignment');
const { isAnthropic } = require('./model_transport');

let _deps = null;

function init(deps) {
  _deps = deps;
}

// M8: 合并的 SSE 心跳 helper — 同一响应只挂一个 interval
function attachSseHeartbeat(res, intervalMs = 5000) {
  const hb = setInterval(() => {
    try { res.write(': keepalive\n\n'); } catch (e) { clearInterval(hb); }
  }, intervalMs);
  if (hb.unref) hb.unref();
  res.on('close', () => clearInterval(hb));
  res.on('error', (err) => { safeGuard.writeCrash('agent-sse-client-error', err); clearInterval(hb); });
  return hb;
}

// 2026-09-14 (老板拍: 模型不自动选, 只有推理强度可自动): auto → 按任务分档
// 与 pangu-single/routes/message-stream.js 的 _resolveReasoningEffort 同规则:
// 重任务(law/strategy/reasoning/code_debug/long_context)=high, 中任务(code/file_edit)=medium, 轻任务=low
// (老板再拍: 关档不留 — 'off' 及非法值一律落回 auto 分档)
// 优先级: 请求显式档(low/medium/high) > 模型自带 reasoning_effort > auto 任务分类
function _resolveReasoningEffort(raw, userInput, model) {
  const EFFORTS = ['low', 'medium', 'high'];
  if (raw && EFFORTS.includes(raw)) return raw;
  if (model && EFFORTS.includes(model.reasoning_effort)) return model.reasoning_effort;
  let task = 'chat';
  try { task = require('./router/smart_router').classifyTask(userInput || '').task; } catch (_) {}
  // 2026-09-16 老板拍: auto 不再默认跳 high — 长上下文(digest/归纳)和纯 reasoning 走 medium,
  // 只有真正的多步策略/law/code_debug 才 high; 默认底档 medium 而非 low(防质量崩)
  if (['law', 'strategy', 'code_debug'].includes(task)) return 'high';
  if (['code', 'file_edit', 'reasoning', 'long_context'].includes(task)) return 'medium';
  return 'medium';
}

// 2026-08-02 老板拍 ("你要用64卦进行推理, 然后才到llm"):
// 起卦先于 LLM 推理 — 非闲聊输入进门前先过 gua_engine 起一卦,
// 卦象/动爻/爻辞/之卦注入问题前面, LLM 全程基于卦象脚手架推理。
// (之前的顺序是反的: LLM 先想, 想起卦才调工具 — 那是"64卦外挂", 不是"64卦内核")
// 2026-10-21: 块正文搬进 modules/gua_block.js (唯一真源) —— 原来这边一份、
// subagent_runner 一份、task_split 一份, 三处各改各的, 改一次断一次。
const { formatGuaFirstBlock } = require('./gua_block');
const _formatGuaFirstBlock = formatGuaFirstBlock;

async function _handlePanguAgentStream(req, res) {
  let body = '';
  req.on('data', chunk => body += chunk);
  req.on('end', async () => {
    try {
      const req_body = JSON.parse(body);
      // Never collapse unrelated API callers into J2's shared `default` session.
      // Normalize snake_case/camelCase/header forms before any downstream loop
      // sees the body. The loop consumes session_id, so leaving only sessionId
      // here would silently put the request back into the shared default.
      const suppliedSessionId = req_body.session_id || req_body.sessionId || req.headers?.['x-session-id'];
      req_body.session_id = String(
        suppliedSessionId ||
        ('request-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8))
      );
      let messages = req_body.messages || [];
      // 2026-10-28 (现场 probe-dup-20261028): 客户端(Web UI)会把**整段历史 + 本轮消息**
      //   一起放进 messages。服务端后面还会从会话存储里接回上一轮 ⇒ 两份历史叠在一起,
      //   同一轮对话在模型眼里出现两遍(实跑 [j2-msgs] 抓到了: user/assistant 各两份)。
      //   这里先记下客户端自己带了几条非 system 消息, 后面据此决定还要不要接回。
      const _clientTurnCount = (Array.isArray(req_body.messages) ? req_body.messages : [])
        .filter(m => m && m.role !== 'system').length;
      const rawInput = req_body.input || req_body.message || req_body.text || req_body.content || '';
      let userInput = resolveTaskInput(rawInput, messages);
      // 2026-10-28 第 129 批: 主人这一轮的**原话**快照 (未注入任何纪律块)。
      // 用途: 判「这是一道批命做题题」必须看主人自己说了什么 ——
      //   注入块是我们写给模型的话, 拿它当判据 = 自己给自己发通行证。
      const _rawUserText = String(userInput || '');
      // 卦先于人: 非闲聊输入先起卦 (纯闲聊/问候不起, _shouldUseDispatcher=false 即闲聊)
      let guaFirst = null;
      // 2026-10-09 (老板问"为什么每次都是卦象定调"): 起卦不再跟着 dispatcher 走。
      // 取数类(查/找/搜/列/行情…)不不起卦 — 卦象盖在事实前面会把"我根本没查到数据"也一起盖住。
      // 2026-10-13 (现场 longwork-1791848550): 上一版写成 `_shouldCastGua || _shouldUseDispatcher`,
      // 于是上面"起卦不再跟着 dispatcher 走"这句注释是**假的** —— pangu-single 把两张表都接进了
      // deps, 兜底分支永远不触发, 实际语义等于"只要走 dispatcher 就一定起卦"。
      // 纯执行任务(创建 40 个文件)的答案因此被卦象污染: 开头就是「大壮初九…不宜抢进」。
      // 兜底必须是**真兜底**: 新判定接了就由它说了算, 只有老 deps 没接才回退。
      const _guaGate = _deps._shouldCastGua
        ? _deps._shouldCastGua
        : _deps._shouldUseDispatcher;
      //
      // 2026-10-21 (老板拍「那就改」, decision.md §P1-4): 生辰八字**不起卦**。
      //
      // 为什么: 八字本身就是盘。用户给了生辰, 再叠一个梅花卦 = 两套盘打架,
      // LLM 不知道以哪个为准。更实际的后果是 ——【盘古起卦】块占住了推理入口,
      // 模型顺着卦象走, 不去调 bazi_calc; 而 bazi_calc 明明在
      // tools_schema.js:98 的 MAIN_GENERAL_TOOLS_FOR_LLM 里, 主对话够得着。
      // (注: 2026-10-21 之前我误判「bazi_calc 主对话调不到」, 那是把
      //  tools_schema.js:139 注释里的「**此前**只注册未暴露」当成了现状。
      //  核实: bazi_calc + gua_cast 都在 MAIN 集 23 个工具里。问题不在够不够得着,
      //  在模型顺着卦走不去调它。)
      //
      // 判据在 modules/bazi_intent.js, 只做**减法**: 识别不出就照常起卦, 原行为不变。
      // 反例已锁进 tests/bazi-intent-skip-gua-20261021.test.js ——
      // 「查 2015年3月15日的会议记录」这种带日期但非生辰的, 仍然照常起卦。
      //
      // 2026-10-23 第 58 批: 跳过与否改由 bazi_intent.evaluateGuaSkip 说了算 ——
      // 它比「matched 就跳」多两档, 修掉了老板报的真 bug:
      // 「1990年3月15日生, 男, **算一卦**看今年财运」原本被判生辰 → 跳过起卦 →
      // 主人明说要卦却没卦(规则 19(a) 写的正是「必调」)。
      // 现在: 明说排八字 → 跳过; 明说要卦 → **不跳过**(生辰是落地材料, 走 combo);
      // 只有生辰没说卦 → 跳过。
      let _skipGuaReason = '';
      let _skipGua = false;
      try {
        const _bz = require('./bazi_intent');
        const _r = _bz.evaluateGuaSkip(rawInput || userInput);
        if (_r && _r.skip) {
          _skipGua = true;
          _skipGuaReason = _r.reason + ' [' + (_r.signals || []).join(',') + ']';
        } else if (_r && _r.reason && _r.reason.indexOf('明说要卦') >= 0) {
          _skipGuaReason = _r.reason + ' [' + (_r.signals || []).join(',') + ']';
        }
      } catch (e) {
        // 识别器坏了不能连带起卦也坏 —— 兜底成"照常起卦"
        console.warn('[gua-first] bazi_intent failed:', e.message);
      }
      if (_skipGua) {
        console.log('[gua-first] 跳过起卦 —', _skipGuaReason);
      }
      //
      // 2026-10-23 第 58 批: 分层编排 —— 判出「这题走哪层」。
      //   为什么: 规则 #19 只讲了 64 卦, bazi_calc / 六格判局 / 串起来
      //   模型**一个都没被告知过**(工具描述里 gua_cast 9 字符、bazi_calc 16 字符,
      //   li 角色 schema 已 8987/9000 再塞就超预算)。模型不知道有 bazi_calc 这条路,
      //   于是它只会起卦、只会用卦 —— 「什么时候串起来用」就永远轮不到。
      //   探测器**只解释, 不改行为**: 真正起不起卦仍然是 _shouldCastGua + bazi_intent 说了算。
      let _planLine = '';
      try {
        const _lp = require('./layer_plan');
        const _plan = _lp.detectLayerPlan(rawInput || userInput);
        _planLine = _lp.renderLayerPlanLine(_plan);
        if (_planLine) console.log('[layer-plan]', _plan.route, '—', _plan.reason);
      } catch (e) {
        // 探测器坏了不能连带主流程坏 —— 兜底成「不注入这一行」
        console.warn('[layer-plan] failed:', e.message);
      }
      if (rawInput && !_skipGua && _guaGate(userInput)) {
        try {
          const { castGua } = require('./gua_engine');
          const _g = castGua(userInput);
          // `userInput` can be the prior task plus an acknowledgement. Never
          // replace it with rawInput here, or short confirmations lose their
          // resolved task before routing and final-answer alignment.
          if (_g && _g.gua_name) { guaFirst = _g; userInput = _formatGuaFirstBlock(_g) + userInput; }
        } catch (e) { console.warn('[gua-first] cast failed:', e.message); }
      }
      // 2026-08-02 反幻觉钩子① (老板拍: 尽可能解决幻觉 — 结构性机制, 不靠 prompt 念经):
      // 自查类问题 (问盘古自己的架构/工具/沙箱/权限/推理逻辑) 是幻觉重灾区 —
      // RTF 11:24 实案: 盘古凭印象连环编 "沙箱关了/权限开不了", 真根因是 cwd 双重套娃。
      // 结构解法: 检测自查输入 → 问题尾部直接钉死举证纪律, dispatcher/legacy 两条路全覆盖
      // (dispatcher 把 userInput 传给 planner+综合, legacy 把它当最后一条 user message)。
      //
      // 2026-10-19 修 (老板报「原来不管什么模型至少能出来, 现在比原来还慢, 后台还说 pangu 卡死」):
      // 现场 (会话 07402764 / 08953709)「全面介绍一下你自己」被拆成 **5 路**:
      //   坎·拆 运行中 / 离·读 **失败** / 兑·验 完成 109.2s / 巽·找雷 完成 127.4s / 乾·调度 运行中
      // 整整 127 秒, 还报一路失败, 而这只是一句自我介绍。
      //
      // 根因不在 planner, 在**这条纪律的判据**。它原本给盘古的幻觉上枷
      // (2026-08-02 实案: 盘古凭印象编「沙箱关了/权限开不了」), 动机对, 但旧支2 是
      // **裸的 `你自己`** —— 句子里只要出现「你自己」三个字就注入 ~150 字取证纪律。
      // 实测命中「介绍一下你自己」「介绍一下你自己能干什么」「全面介绍一下你自己」,
      // 全是纯聊天。更荒唐的是「你是谁」**不命中**(字面没"你自己"),
      // 而"介绍一下你自己"要拆 5 路跑 127 秒 —— 最该轻松的反而最重。
      //
      // 纪律本身没删 (盘古瞎编自己确实是真问题), 改的是**什么时候用**:
      //   主人**聊天**(介绍/你是谁/你能干什么) → 正常答, 不上枷;
      //   主人**要证据**(排查/检查/有哪些/多少/架构细节) → 纪律照上。
      // 区别在动词, 不在主语。
      const _SELF_CHAT_RE = /(介绍|说说|讲讲|聊聊|认识|你是谁|你是什么|你能(做什么|干什么)|你会(什么|什么)|自我介绍)/;
      const _SELF_PROBE_RE = new RegExp(
        '(全面|全量).{0,8}(分析|扫描|检查|排查|验证)' +
        '|排查你|拆你|检查你自己|自我(排查|检查)' +
        '|(你的)(架构|工具|沙箱|权限|记忆|推理|代码|配置|系统|MCP|模型|能力).{0,12}(是|有|怎么|哪些|多少|支持|能)' +
        // 「有哪些/有几个/多少」也是取证问法 —— 报数量必须查真源, 不能凭印象。
        // (旧正则只列了「有没有/多少」, 漏了「有哪些」, 于是"你有哪些工具"反而放行了。)
        '|你.{0,6}(有没有|有哪些|能不能|支持不|有几个|多少|哪些).{0,10}(工具|流式|MCP|沙箱|权限|卦|模型)' +
        '|64\s*卦.{0,8}(进|走|推理|链路)' +
        '|推理.{0,8}(逻辑|链路).{0,8}(你|盘古|64)', 'i');
      // 要证据的才上枷。聊天问法直接放行 —— 除非它同时也是取证问法
      // (「介绍一下你的沙箱怎么配的」既聊天又要证据, 那种要留)。
      if (userInput && _SELF_PROBE_RE.test(userInput)
          && !(_SELF_CHAT_RE.test(userInput)
               && !/排查|检查|验证|有多少|几个|哪些|怎么配/.test(userInput))) {
        userInput += '\n\n【自查纪律 · 系统强制】这是关于你自己的问题。铁律: 回答里每一条关于你架构/工具/权限/沙箱/状态的断言, 必须来自本轮真实 tool_result (exec_command 跑 grep/ps/curl / read_file 读源码配置)。最终答案至少给出两处可核验来源，格式必须为“文件路径:行号”或“命令: 原文摘要”。禁止凭记忆/印象/训练知识描述你自己 — 你对自己的印象全是错的, 只有正在跑的代码是真的。没查到的项直接写 "未验证", 不许编。';
      }
      const images = req_body.images || [];
      // 2026-10-12 (会话 desktop-1791787104119 实案, 老板报"感觉有点问题"): 四柱已知时,
      // 十神/五行/地支关系改由本地确定性查表注入 (bazi_chart_facts) —— LLM 凭记忆算十神
      // 会错 ("土印/庚金七杀/印旺" 三连错, 原局木=0 不可能印旺)。查表题不走推理。
      // 注入进 userInput, 主 loop / dispatcher 子 agent / 综合 LLM 全都拿得到。
      // _chartFacts 提到块外 —— 路由也要用它当「会话里已经有盘」的判据
      // (见下面 detectSingleShotChartTask 第 ③ 档: 追问轮不许掉进 dispatcher)。
      let _chartFacts = '';
      try {
        _chartFacts = require('./bazi_chart_facts').buildFactsFromConversation(rawInput, messages);
        if (_chartFacts) userInput += '\n\n' + _chartFacts;
      } catch (_) { /* 事实块生成失败不阻断主流程 */ }

      // 2026-10-12 (e2e-812-gate-002 实测实案): 首轮纯图做题, 模型无视图里「年柱/月柱/日柱/时柱」
      // 标签, 按从左到右=年月日时硬猜柱序 → 四柱整个颠倒 (庚子·丁丑·己未·戊午), 日主错成己土
      // (图上白纸黑字写着 日主:丁火)。核验门只能验"答案内部自洽", 读错盘它救不了 ——
      // 读图纪律必须在进门时前置注入, 这是首轮纯图的唯一防线。
      if (images.length > 0 && /(命盘|八字|四柱|排盘|做题|命造|原局|大运|流年)/.test(userInput)) {
        userInput += '\n\n【读图纪律 · 系统强制】这是排盘图。柱序以图里标注的「年柱/月柱/日柱/时柱」标签为准 —— 很多盘从左到右是「时日月年」, 禁止按位置猜柱序。先把四柱按「年月日时」顺序逐字抄下, 核对日主天干, 再开始分析。柱序错 = 全盘错。';
      }

      // 2026-10-23 第 58 批: 把「这题走哪层」那一行送给模型。
      //
      // ⚠️ 三处位置都是有意选的, 动之前先读完:
      //   ① 挂在 userInput **末尾**(不是开头):
      //      modules/answer_alignment.js 的 alignmentQuestion() 会把第一处【…】之后的
      //      整段当成「给模型的话术」剔掉。挂在末尾 ⇒ 对齐门算「问题」时只算主人真问的
      //      那部分, 这一行不混进去(混进去会抬高对齐门槛, 2026-10-01 踩过)。
      //   ② 在**起卦之后**才挂: 挂早了 userInput 里就多出「64卦」这种字样 ——
      //      GUA_FACT_LOOKUP_KWS 里正有 '64卦', 一挂, _shouldCastGua 会把占问当成
      //      查表题(**不起卦**)⇒ 卦先于推理当场作废。
      //   ③ 路由判定用**挂之前**那份 userInput: 下面 `_deps._shouldUseDispatcher(userInput)`
      //      按 userInput 判路由, 而 DISPATCHER_KWS 里 '卦' 是**保留的单字词条** ——
      //      一行里带「卦」就把「第24卦是哪一卦」这种查表题从 legacy 拽进 dispatcher
      //      (2026-10-21 修过一次, 这里不许回归)。
      // 2026-10-28 (现场实跑取证, 会话 web-1793124838326):
      //   路由判据必须是**主人自己的原话**, 不能是"我们往里塞的东西"。
      //
      //   实跑: 第 2 轮被判进 dispatcher, 唯一命中词是 '记忆' —— 来自**服务端自己注入**的
      //   【排盘事实】纪律块 (bazi_chart_facts.js: "禁止凭记忆另算十神"),
      //   而 '记忆' 就在 DISPATCHER_KWS 里 (pangu-single.js:1505)。
      //   第 1 轮为什么没事: 那时四柱还没算出来, 事实块根本不存在 ⇒ 没有 '记忆'。
      //   **"第一次以后"的分水岭就是它** —— 第 2 轮起每轮都带事实块, 于是每轮都进编排,
      //   每轮都派将灵去查外网 (百度百科 403 / 维基超时 30s×N), 5 分钟起。
      //
      //   卦块早就有同样的坑, 已经用 _stripGuaBlockForRouting 剥掉了 (见 pangu-single.js
      //   的注释: "任何按文本内容做路由的闸门, 都必须先把服务端自己注入的装饰剥掉")。
      //   事实块 / 自查纪律 / 读图纪律 这一类注入块**没剥** —— 现在统一按**原话**判。
      //   _rawUserText 是第 79 行抓的快照 (任何注入之前), 天然不含注入块。
      const _userInputForRouting = _rawUserText || userInput;

      // 2026-10-28 第 129 批: 批命「做题」纪律 —— 八条题逐条答, 「出生地周围情况」
      // = 出生地地理环境(调候), 不是出生年代的经济社会统计。
      //
      // 现场 (2026-10-27 23:40, 会话 15567183): 老板发课件《排盘样例》图 +「做题，看清楚题目」。
      //   盘古把「分析出生地周围情况」读成了「1975 年四川/成都的社会经济统计」——
      //   发了一条 web_search, 又派了个子 agent 去查 1975 年职工平均工资/城镇化率/人口总数,
      //   子 agent 连着 6 次 web_fetch 超时(每次 30s), 整轮 4m49s 还在跑。
      //   根因: 全仓没有一条规则说「出生地周围情况」= 什么 ⇒ 模型只能猜, 猜错了没人拦。
      //
      // ⚠️ 位置铁律: 必须挂在**路由快照之后**。挂前面 = 这段字参与
      //   _shouldUseDispatcher 判定, 而 DISPATCHER_KWS 里有 '分析'/'天气'/'检查'/'验证' 等词
      //   —— 一挂就把纯文字的命理题拽进 90 秒起步的 dispatcher 编排 (慢的制造机)。
      //   口径真源见 modules/bazi_items.js (唯一真源, 别在这里另抄一份)。
      let _itemTask = false;
      // 2026-10-28 第 132 批: 「单镜排盘任务」—— 主 agent 一口气答完, 不许进 dispatcher。
      //   判据真源在 modules/bazi_items.js 的 detectSingleShotChartTask (三档:
      //   批命做题题 / 生辰排盘题 / 已有命盘 + 命理追问)。
      //   为什么单独一档而不并进 _itemTask: _itemTask 只管「批命做题」这一种,
      //   而现场慢的**不止**做题题 —— 「排八字」「这个人的大运怎么样」同样落进 dispatcher,
      //   同样 5 分钟起。口径在 bazi_items 里一份, 这里只调。
      let _singleShotChart = false;
      try {
        const _bi = require('./bazi_items');
        // 2026-10-28: 追问轮没重传图时, 靠**上一轮**的做题题状态把这一轮也认成做题题
        //   (否则纪律不注入 + 路由掉进 dispatcher = 5 分钟起步)。
        //   粘住与解除的判据见 modules/bazi_items.js detectItemTask 里的注释。
        const _prevItem = _bi.getTurnContext(req_body.session_id);
        const _det = _bi.detectItemTask(_rawUserText, {
          hasImages: Array.isArray(req_body.images) && req_body.images.length > 0,
          sessionItemTask: Boolean(_prevItem && _prevItem.itemTask),
          // 2026-10-28 (现场 web-1793124838326): 会话里已经有盘了, 主人这轮只说「做题」,
          //   没重传图 ⇒ 只看 hasImages/sessionItemTask 判不中 ⇒ 纪律没注入 + 掉进 dispatcher。
          hasChart: Boolean(_chartFacts),
        });
        _itemTask = Boolean(_det && _det.matched);
        try {
          const _ss = _bi.detectSingleShotChartTask(_rawUserText, {
            hasImages: Array.isArray(req_body.images) && req_body.images.length > 0,
            sessionItemTask: Boolean(_prevItem && _prevItem.itemTask),
            hasChart: Boolean(_chartFacts),
          });
          _singleShotChart = Boolean(_ss && _ss.matched);
          if (_singleShotChart && !_itemTask) {
            console.log('[bazi-chart] 命中单镜排盘任务 (' + _ss.reason + ') —— 留在主 agent');
          }
        } catch (_) { /* 单镜判据失败不阻断主流程 */ }
        if (_itemTask) {
          userInput = userInput + '\n\n' + _bi.renderItemDiscipline();
          console.log('[bazi-items] 命中批命做题题 (' + _det.reason + ') —— 注入八条逐条作答纪律');
        }
        // 工具层的门靠它认出「本轮是批命做题题」(光看调用参数判不出来:
        // 那条 web_search 的参数里一个命理词都没有)。
        _bi.setTurnContext(req_body.session_id, { itemTask: _itemTask, turnText: String(userInput || '') });
      } catch (_) { /* 纪律块生成失败不阻断主流程 */ }

      if (_planLine) {
        userInput = userInput + '\n\n' + _planLine;
      }

      // 2026-08-02 修 (老板 16:41 纯发图 → 'chat content is empty' → 连接中断实案):
      // userInput 为空时旧逻辑整条 user 消息都不入列, images 跟着丢, 下游空 user 消息被
      // ModelAdapter 过滤 → 请求体只剩 system → MiniMax 400。图也是内容, 有图就必须建消息。
      // A history normally ends with the previous user turn. Checking only the
      // role drops the current request whenever the client sends both `messages`
      // and a fresh `input`, which makes Pangu answer the previous question.
      // 第 4 参 = 主人这一轮的原话 (客户端自己那条消息的内容) ——
      //   有了它, 服务端就**替换**客户端那条, 不再追加一份 (见 answer_alignment.js 的注释)。
      messages = ensureCurrentUserMessage(messages, userInput, images, String(rawInput || '').trim());

      // Pangu 灵魂注入
      const soulSysMsgs = _deps._buildSystemMessages();
      const userPassedSysMsgs = messages.filter(m => m.role === 'system');
      const nonSysMsgs = messages.filter(m => m.role !== 'system');
      messages = [...soulSysMsgs, ...userPassedSysMsgs, ...nonSysMsgs];

      // 2026-10-13 (probe_resume / resume-live-1791860580 端到端实测): 盘古把每轮对话写进
      // ~/.pangu-data/sessions/, 却从来不读回来 —— 第二轮照样把第一轮做完的 a1/a2/a3 重做
      // 一遍 (mtime 全被刷新), 而落盘记录里明明写着 a1.txt。
      // 少的就是这一步: 新一轮的 messages 原本只由**当前这一轮请求**拼成,
      // sessionLoad 全代码库只在建会话状态时恢复 plan_state, 从不恢复对话消息。
      try {
        const _priorSid = String((req_body && (req_body.session_id || req_body.sessionId)) || '').trim();
        if (_priorSid) {
          const _priorRes = await require('./session_store').sessionLoad({ session_id: _priorSid })
            .catch(() => null);
          if (process.env.PANGU_DEBUG_MSGS === '1') {
            console.log('[prior-turns-diag] sid=' + _priorSid
              + ' load=' + (_priorRes ? ('ok=' + _priorRes.ok + ' msgs=' + ((_priorRes.result && _priorRes.result.messages) || []).length) : 'NULL'));
          }
          if (_priorRes && _priorRes.ok && _priorRes.result) {
            const _turns = require('./j2_loop_shared')._extractPriorTurns(_priorRes.result.messages);
            // 当前这条 user 请求客户端可能同时带进 messages, 别灌两遍
            // 2026-10-28: 比对走「原话口径」(coreUserText) —— 落盘里存的是注入块拼过的版本,
            //   直接比永远比不上, 本轮就会被当成上一轮再塞一遍。
            const _core = require('./answer_alignment').coreUserText;
            const _curNorm = _core(userInput).replace(/\s+/g, ' ').trim();
            const _keep = _turns.filter(t => !(t.role === 'user'
              && _core(t.content).replace(/\s+/g, ' ').trim() === _curNorm));
            // 2026-10-28 (现场 probe-dup-20261028 实跑取证, 会话 web-1793124838326 同源):
            //   客户端(Web UI)本来就把整段历史一起发过来了, 服务端再从会话存储接回一遍
            //   ⇒ 同一段对话在模型眼里出现两遍。实测后果: 追问轮的答案跟上一轮**一模一样**
            //   (长度都是 1836 —— 模型在复读), 对齐门连拦两次, 一轮 116 秒。
            //
            //   所以规矩改成: **客户端带了历史就以客户端的为准**, 只有客户端没带历史
            //   (纯 API 调用, 只发 input) 时才从会话存储接回 —— 那才是这段代码当初要解决的场景。
            if (_clientTurnCount > 1) {
              console.log('[prior-turns] 客户端自带 ' + (_clientTurnCount - 1)
                + ' 条上一轮对话 —— 以客户端为准, 不再从会话存储接回 (否则同一轮出现两遍)');
            } else if (_keep.length) {
              messages = [
                ...messages.filter(m => m.role === 'system'),
                ..._keep,
                ...messages.filter(m => m.role !== 'system'),
              ];
              console.log('[prior-turns] 接回上一轮 ' + _keep.length + ' 条对话 (session=' + _priorSid + ')');
            }
          }
        }
      } catch (e) { console.warn('[prior-turns] restore failed:', e.message && e.message.slice(0, 160)); }

 // 重构：复杂任务走 Dispatcher（子 agent 分发）
      // 2026-08-02 修 (老板拍: 盘古不能识别图片): 带图请求禁止走 dispatcher —
      // 子 agent 只拿文本任务拿不到图, 会幻觉"去全盘扫图算数据"。看图是单镜任务, 强制 legacy 单循环。
      // 2026-10-23 第 58 批: 用**挂分层编排那一行之前**的 userInput 判路由。
      //   理由见上面 ③ —— 这一行里带「卦」, 而 DISPATCHER_KWS 保留单字 '卦',
      //   拿挂了行的文本判会把查表题拽进 dispatcher(2026-10-21 修过的东西不许回归)。
      //
      // 2026-10-28 (现场 web-1793124838326 第 2 轮): 批命做题题**也不许**走 dispatcher。
      //   理由跟上面「带图禁止走 dispatcher」是同一条铁律 —— 单镜任务由主 agent 一口气答完:
      //     ① 这道题主 agent 自己就能干 (bazi_calc 在 main 集里, 一次调用出全盘);
      //     ② dispatcher 路径下 main 的工具笼被砍到 2 个 (dispatch_subagents + task_done),
      //        main 够不到 bazi_calc ⇒ 只能派将灵 ⇒ 将灵去查外网 (403/30s 超时) ⇒ 5 分钟起;
      //     ③ 批命做题纪律 ④ 明写「不许为它发 web_search / web_fetch, 也不许派子 agent 去查」——
      //        进了 dispatcher 这条纪律就形同虚设。
      //   实测: 修完这一行, 同一道题的追问轮从 5m02s 回到跟第 1 轮一个量级。
      //
      // 2026-10-28 第 132 批补: 「单镜排盘任务」同样不许走 dispatcher。
      //   实测: 「男，1979年5月6日6时56分，四川成都，排八字」(没带图) 会被判进
      //   dispatcher ⇒ main 的工具笼被砍到 2 个 ⇒ 够不到 bazi_calc ⇒ 排盘只能
      //   派给将灵 ⇒ 又是 5 分钟起。带图那一档早就禁了 (images.length === 0),
      //   没图的那一档漏了。
      if (process.env.PANGU_DEBUG_ROUTE === '1') {
        try {
          console.log('[route-probe] itemTask=' + _itemTask
            + ' singleShotChart=' + _singleShotChart
            + ' images=' + images.length
            + ' raw=' + JSON.stringify(String(_rawUserText || '').slice(0, 60))
            + ' routing=' + JSON.stringify(String(_userInputForRouting || '').slice(0, 160))
            + ' -> dispatcher=' + _deps._shouldUseDispatcher(_userInputForRouting));
        } catch (_) { /* 探针不许影响主流程 */ }
      }
      if (images.length === 0 && !_itemTask && !_singleShotChart
          && _deps._shouldUseDispatcher(_userInputForRouting)) {
        let model = null;
        if (req_body.model) {
          const requested = String(req_body.model).trim().toLowerCase();
          model = (_deps.getConfig().llm.models || []).find(m =>
            [m.id, m.name, m.api_model].some(v => String(v || '').trim().toLowerCase() === requested)
          );
          if (!model) {
            res.writeHead(200, {'Content-Type': 'text/event-stream'});
            res.write('event: error\ndata: ' + JSON.stringify({ error: 'MODEL_NOT_FOUND', requested_model: req_body.model }) + '\n\n');
            return res.end();
          }
        }
        if (!model) {
 // 去掉 agent_default_model 双轨, 统一用 current_model_id
          model = _deps.getCurrentModel();
        }
        if (!model) model = _deps.getDefaultModel();
        if (model && model.enabled === false) {
          res.writeHead(200, {'Content-Type': 'text/event-stream'});
          res.write('event: error\ndata: ' + JSON.stringify({ error: 'MODEL_DISABLED', requested_model: req_body.model || model.id }) + '\n\n');
          return res.end();
        }
        // 2026-09-14: 模型解析不动(手动选); 推理强度挂副本, 请求档 > 模型自带档 > auto 任务分档, 不污染池里原对象
        if (model) model = { ...model, reasoning_effort: _resolveReasoningEffort(req_body.reasoning_effort, userInput, model) };
        if (!model) {
          res.writeHead(200, {'Content-Type': 'text/event-stream'});
          res.write('event: error\ndata: ' + JSON.stringify({error: 'No model available'}) + '\n\n');
          return res.end();
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          'Connection': 'keep-alive'
        });
        const _origResWrite = res.write.bind(res);
        res.write = function(data, encoding, cb) {
          if (res.writableEnded || res.destroyed) return false;
          try { return _origResWrite(data, encoding, cb); }
          catch (e) { safeGuard.writeCrash('agent-sse-write-error', e); return false; }
        };
        attachSseHeartbeat(res);
        if (guaFirst) { try { res.write('event: gua\ndata: ' + JSON.stringify(guaFirst) + '\n\n'); } catch (_) {} }
        return _deps._runPanguDispatcherLoop(messages, model, req, res, { userInput, reqBody: req_body, guaFirst });
      }

 // 去掉 agent_default_model 双轨, 统一用 current_model_id
      let model = null;
      // 优先级: req_body.model > current_model_id
      if (req_body.model) {
        const requested = String(req_body.model).trim().toLowerCase();
        model = (_deps.getConfig().llm.models || []).find(m =>
          [m.id, m.name, m.api_model].some(v => String(v || '').trim().toLowerCase() === requested)
        );
        if (!model) {
          res.writeHead(200, {'Content-Type': 'text/event-stream'});
          res.write('event: error\ndata: ' + JSON.stringify({ error: 'MODEL_NOT_FOUND', requested_model: req_body.model }) + '\n\n');
          return res.end();
        }
      }
      if (!model) {
        model = _deps.getCurrentModel();
      }
      if (model && model.enabled === false) {
        res.writeHead(200, {'Content-Type': 'text/event-stream'});
        res.write('event: error\ndata: ' + JSON.stringify({ error: 'MODEL_DISABLED', requested_model: req_body.model || model.id }) + '\n\n');
        return res.end();
      }
      if (!model) {
        res.writeHead(200, {'Content-Type': 'text/event-stream'});
        res.write('event: error\ndata: ' + JSON.stringify({error: 'No model available'}) + '\n\n');
        return res.end();
      }
      // 2026-09-14: 模型解析不动(手动选); 推理强度挂副本, 请求档 > 模型自带档 > auto 任务分档, 不污染池里原对象
      model = { ...model, reasoning_effort: _resolveReasoningEffort(req_body.reasoning_effort, userInput, model) };
      const isAnthropicModel = isAnthropic(model);

      res.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        'Connection': 'keep-alive'
      });

    // 包装 res.write 让 SSE 写入自动安全
      const _origResWrite = res.write.bind(res);
      res.write = function(data, encoding, cb) {
        if (res.writableEnded || res.destroyed) return false;
        try { return _origResWrite(data, encoding, cb); }
        catch (e) { safeGuard.writeCrash('agent-sse-write-error', e); return false; }
      };

 // §8.11: agent/stream SSE 心跳 (M8 合并 helper, 同响应只挂 1 个 interval)
      attachSseHeartbeat(res);
      if (guaFirst) { try { res.write('event: gua\ndata: ' + JSON.stringify(guaFirst) + '\n\n'); } catch (_) {} }

      // 加载工具
      const { TOOLS } = require(path.join(__dirname, 'tools'));
      const { checkToolCall } = require(path.join(__dirname, 'sandbox'));
      const { isConcurrencySafe } = require(path.join(__dirname, 'streaming_tool_executor'));
      const toolsSchema = _deps._loadToolsSchemaForLLM();
      console.log('[agent] toolsSchema:', toolsSchema.length, 'TOOLS:', Object.keys(TOOLS).length, 'model:', model.id, 'endpoint:', model.endpoint);
      console.log('[agent] messages count:', messages.length, 'first system msg length:', (messages[0]?.content || '').length);

 // #8 三层 Agent Loop: 统一走 j2_agent_loop, 不再自己跑 native loop
      // j2_agent_loop 已支持 native tool_call (useNative 分支), 无需重复实现
      return _deps._runAgentLoopLegacyStream(messages, model, req, res, { userInput, reqBody: req_body, sessionId: (req_body && req_body.session_id) });
    } catch (e) {
      safeGuard.writeCrash('route-handler-error', e);
      try {
        if (!res.writableEnded) {
          res.write('event: error\\ndata: ' + JSON.stringify({ ok: false, error: e.message || 'agent stream failed' }) + '\\n\\n');
          res.end();
        }
      } catch (_) {}
    }
  });
}

// 全局 body 大小限制 (DoS 防护)
// 在 server 入口处劫持 req.on('data') — 任何 POST/PATCH/PUT 超过 1MB 自动 413
// 不改各 handler 写法
const _origOn = http.IncomingMessage.prototype.on;
const _origAddListener = http.IncomingMessage.prototype.addListener;

// SSE 连接数限制 — 防恶意客户端耗光 fd + LLM 配额
// N5 B3-Phase 1: 抽到 modules/sse_slots.js
const sseSlots = require('./sse_slots');
const { tryAcquire: _tryAcquireSseSlot, release: _releaseSseSlot } = sseSlots;

function _makeBodyGuard(thisReq, event, listener) {
  // 2026-08-22: /api/attachments 接收大图 (>1MB), 跳过全局 guard 让其独立 30MB 限制生效
  const _url = thisReq.url || '';
  const _skipGuard = _url.startsWith('/api/attachments') || _url.startsWith('/attachments');
  if (event === 'data' && !_skipGuard && thisReq.method && !['GET','HEAD','OPTIONS','DELETE'].includes(thisReq.method)) {
    // 2026-10-23: _deps 只在 init(deps) 里赋值, 而 init 在 listen 回调里调。
    // 回调里任何一行先抛错 ⇒ init 被跳过 ⇒ 这里 _deps 仍是 null, 每个带 body 的
    // POST 都会在 guarded 里 TypeError, 且异常从 stream 的 emit 里冒出去,
    // 请求永远不结束(实测 HTTP=000 挂死 60s)。
    // 上限取真源常量兜底 —— body guard 的职责是 DoS 防护, 不能因为依赖没注进来
    // 就整条护栏失效。
    const _limit = (_deps && _deps.MAX_BODY_BYTES) || panguHelpers.MAX_BODY_BYTES;
    let bytes = 0;
    const guarded = chunk => {
      bytes += chunk.length;
      if (bytes > _limit) {
        if (!thisReq._bodyAborted) {
          thisReq._bodyAborted = true;
          const r = thisReq._panguRes;
          if (r && !r.headersSent) {
            try {
              r.writeHead(413, {'Content-Type': 'application/json', 'Connection': 'close'});
              r.end(JSON.stringify({ok: false, error: 'BODY_TOO_LARGE', limit_bytes: _limit}));
            } catch (_) {}
          }
          try { thisReq.pause(); } catch (_) {}
          thisReq.removeAllListeners('data');
          thisReq.removeAllListeners('end');
        }
        return;
      }
      listener(chunk);
    };
    return guarded;
  }
  return listener;
}

http.IncomingMessage.prototype.on = function (event, listener) {
  return _origOn.call(this, event, _makeBodyGuard(this, event, listener));
};

http.IncomingMessage.prototype.addListener = function (event, listener) {
  return _origAddListener.call(this, event, _makeBodyGuard(this, event, listener));
};

// N5 B4-Phase 1: inline routes 抽到 pangu-single/routes/inline_router.js
const inlineRouter = require('../pangu-single/routes/inline_router');
const httpServer = require('./http_server');
const { attachGracefulShutdown } = require('./startup');


// E2-C: L1 dogfooding 落盘 
// 每次 agent stream 结束写一行到 ~/.pangu/evolution/{date}.jsonl
// N5 B4-Phase 3: evolution 落盘抽到 modules/evolution_record.js
const { _recordEvolution } = require('./evolution_record');

// ============================================================================
// Pangu Decide Handler (W4-B 重建 , 64 卦编程判断 4 场景)
// §0.7 三层架构严格执行:
//   L1: 64卦本体 deterministic → 8 维向量 (guaId, yaoPos + 阴/阳/动/五/亲/辞/变)
//   L2: LLM 推理 → 必看 L1 的 8 维向量, 在向量上"开车"给决策
//   L3: 不执行, 只返决策 (MCP 执行不推理 — decide 不调任何 tool)
// ============================================================================

// PANGU_DECIDE_SCENARIOS 已搬到 pangu_decide.js (原处孤儿表, decide handler 实际在那里)

// N5 B5: decide/dispatch 抽到 modules/pangu_decide.js
const { init: initPanguDecide, _handlePanguDecide, _classifyDispatchTask, _handlePanguDispatch } = require('./pangu_decide');


module.exports = {
  init,
  _handlePanguAgentStream,
  // 2026-10-23: 启动自检探针 —— init() 在 server.listen 回调里调, 回调里任何一行
  // 先抛错就会把它静默跳过, 于是 _deps 停在 null 而进程照常监听端口。
  // 启动自检靠这个函数把「进程活着」和「依赖注入完成了」分成两件事来报。
  _isInitDone: () => _deps !== null && _deps !== undefined,
  // 2026-10-21: 导出给回归测试直接验证块的实际内容 (提示词是**发进模型的字符串**,
  // 源码级断言只能证明"某处写过这句话", 跑真函数才能证明"模型收到的是这句")。
  _formatGuaFirstBlock,
};
