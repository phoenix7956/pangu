// ============================================================================
// subagent_runner — 盘古派发机制的**唯一真源** (2026-10-17 立)
// ============================================================================
//
// 老板原话 (2026-10-17): 「乾就应该把任务拆了, 分下去, 子 agent 只做自己相关的,
// 做好汇报, 这个跟你应该是一样的」。
//
// 立这个模块的起因: 原来派发实现 (_runOneSubTaskInner + DAG 调度 + 并发闸门 +
// 路径收窄 + 连续上下文继承 + REPORT_CONTRACT + sub_agent_start/done SSE + 账本)
// 全部长在 j2_dispatcher 的**闭包**里, 只有 dispatcher 那条路够得着。要让主 agent
// (乾) 自己拆活自己派, 就得再调这份派发逻辑 —— 而照着抄第二份是踩坑日志里明写
// 过的死路:「同一份东西抄四遍 = 迟早只改其中一份」。
//
// 所以这里的动作是**搬**, 不是抄: 下面每一行都从 j2_dispatcher 原样搬过来
// (含全部现场取证注释), 唯一的语义改动是配额快速失败那一处 —— 它从"直接
// resDone 收口"改成回调 ctx.onQuotaFastFail, 因为**收口政策属于调用方**,
// 派发机制不该替它决定怎么跟主人交代。
//
// 调用方:
//   1) j2_dispatcher (坎·planner 路径 + fixed_flow + 关键词兜底)
//   2) j2_agent_loop  (乾·主 agent 自派 dispatch_subagents)
// 两条路共用同一份实现, 改一处两边同时生效。
// ============================================================================
const fs = require('fs');
const subAgent = require('../agents/sub-agent.js');
const subAgentRuns = require('./subagent_runs'); // 2026-09-17 工作体现落盘
// 2026-10-19: "这一刀其实死了"的判定。叶子模块 —— j2_dispatcher 反过来 require
// 本文件, 所以判定表不能住在它那边 (循环依赖), 详见 modules/slice_death.js 头部。
const _sliceDeath = require('./slice_death');

// 2026-09-14 (老板拍: 将灵配角色专属模型): 按角色档位解析模型, 失败/无档 → 请求原模型兜底
function _roleModelFor(configPath, role, fallbackModel) {
  try {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
const m = require('./role_model').resolveRoleModel(cfg, role, fallbackModel);
    if (m) return m;
  } catch (_) {}
  return fallbackModel;
}

// 2026-09-14 (老板问: 需要批准的操作怎么做): sink res 审批卡穿透 —
// 将灵要权时 permission_required 直达主人并带将灵归属, 其他事件照吞 (防子 loop 掐断主流)
// 2026-10-17 (现场 lt2-1792170606432 实测, 102s 一次长任务):
//   服务端发了 49 条 sub_agent_progress, 前端 **一条都没显示**。
//   根因不在传输, 在**键对不上**:
//     - 前端用 `agent + '::' + task` 做卡片匹配键 (ChatRoom.jsx sub_agent_progress 分支),
//       且拿不到卡片时**故意不新建** ("免得抢跑"), 于是匹配不上 = 静默丢。
//     - 但这里构造的 progress 事件**只有 agent, 没有 task** → 键恒等于 `analyzer::`,
//       而卡片的键是 `analyzer::"请分别分析这三个文件..."` → **永远不可能相等**。
//   于是那条"卡还没建出来就不新建"的守卫, 实际不是竞态守卫, 是**永久性失配**:
//   活性信号全在发, 全在前端被扔掉, 主人看到的就是一张静止的"运行中" ——
//   正是老板原话"跟死了一样"。
//
// 修法: 把 task 串进来, 让事件键与卡片键同源。task 拿不到时 (兜底路径) 传空串,
// 前端会退回按 agent 匹配 —— 那条路本来就只能有一个将灵。
function _makeSinkRes(realRes, agent, task) {
  // 出口归一 (2026-10-18): 这一层的产物**直接进前端将灵卡片**, 前端只认拼音。
  // 名字不归一的后果是空卡片 —— 事件到了, 但界面上那一格查不到对应卦, 看着像
  // "没派活"。在出口收一次, 里面任何一处漏归一都伤不到界面。
  const _canonAgent = require('../agents/gua-identity').resolveRole(agent) || agent;
  // 2026-10-16: 活性节流。thinking 每 250ms 一帧、stream_delta 每个 token 一帧,
  // 全部穿透能把主人那边刷成瀑布 (一次 300s 的思考 ≈ 1200 帧)。1.5s 一帧够看出
  // "字数还在长", 又不会淹掉真正的事件。收尾帧 (phase=off) 不节流 —— 那是"想完了"。
  let _lastTick = 0;
  return {
    write: (d) => {
      try {
        if (typeof d === 'string' && d.startsWith('event: permission_required') && realRes && !realRes.writableEnded) {
          const di = d.indexOf('data: ');
          if (di !== -1) {
            const payload = JSON.parse(d.slice(di + 6).trim());
            payload.agent = _canonAgent;
            payload.message = '将灵[' + _canonAgent + '] 请求批准: ' + payload.tool;
            return realRes.write('event: permission_required\ndata: ' + JSON.stringify(payload) + '\n\n');
          }
          return realRes.write(d);
        }
        // 2026-09-18 (老板点名: 子 agent 调度体验): 子任务收口的 sub_agent_done / sub_agent_error
        // 之前全被吞 — checker 的「对账拦截」(编造落盘) 警告永远到不了前端, 老板只见虚报 PASS。
        // 穿透收口事件 (含 summary, 里面带拦截结论); permission_required 在上方先处理。
        // 2026-09-18: sub_agent_done/error 事件在 dispatcher 里是它自己发的 SSE 标签 (见 _runOneSubTask),
        // 不是子 loop 写出来的 — 子 loop 收口走的是 task_done/LIP 的 event: warning/... 。
        // 真正需要穿透的是带拦截结论的 warning/plan/done/status 收口事件。
        if (typeof d === 'string' && realRes && !realRes.writableEnded &&
            (d.startsWith('event: warning') || d.startsWith('event: task_done') ||
             d.startsWith('event: partial_done') || d.startsWith('event: sub_task_rejected'))) {
          return realRes.write(d);
        }
        // 2026-10-16 (现场 fastpath-234507 实测: 子 agent 阶段 SSE 活性事件 **0 条**,
        // 600s 里主人只看到 heartbeat —— 正是老板说的"跟死了一样"):
        //   j2 loop **本来就是流式的** (onText/onReasoning 都在推 delta), 但它写的是
        //   `event: thinking` / `event: stream_delta`, 而上面那张穿透白名单只有五类收口事件,
        //   于是子 agent 逐 token 吐出来的东西**一个都没到界面**。
        //
        //   白名单当年是对的: stream_delta 会进 ChatRoom 气泡, 直接放行等于让编排旁白
        //   混进正文。但"不显示正文"和"不报活性"是两件事 —— 主人要的不是看子 agent 写
        //   什么, 是知道它**还在动**。所以这里把思考/增量转成 sub_agent_progress 穿透:
        //   只带计数和耗时, 不带内容 (内容仍由 final 事件统一给), 既不污染气泡也不沉默。
        //
        //   带 agent 归属 —— 否则界面上分不清是哪个将灵在动。
        if (typeof d === 'string' && realRes && !realRes.writableEnded &&
            (d.startsWith('event: thinking') || d.startsWith('event: stream_delta'))) {
          const di = d.indexOf('data: ');
          if (di !== -1) {
            try {
              const payload = JSON.parse(d.slice(di + 6).trim());
              // 两种事件形状不同 (照实读 j2_agent_loop._emitReason / j2_loop_shared._emitStreamDelta):
              //   thinking      → { phase, chars, ts }              chars = 思考字数
              //   stream_delta  → { type, delta, accumulated, token_count, ts }
              //                                  accumulated 长度 = 正文累计字数
              // 注意 chars 在 thinking 里是**思考**字数, 别记成 content —— 那样界面会显示
              // "正在写正文" 而模型其实在思考, 比不报更误导。
              const _c = (!d.startsWith('event: thinking') && typeof payload.accumulated === 'string')
                ? payload.accumulated.length : null;
              const _t = payload && payload.chars != null ? Number(payload.chars) : null;
              // 内容增量在长 → 报 content_chars; 思考在长 → 报 thinking_chars。
              // 两个都没有 (纯心跳帧) 就不报, 免得刷屏。
              // phase=off 是"思考结束"那一帧, 只带一个终值 —— 照样报, 那是"想完了"的信号。
              if (_c != null || _t != null) {
                const _now = Date.now();
                const _isClose = payload.phase === 'off';
                if (!_isClose && _now - _lastTick < 1500) return true;
                _lastTick = _now;
                const out = { agent: _canonAgent, task: task || '', stage: 'sub_progress', content_chars: _c || 0, thinking_chars: _t || 0 };
                if (payload && payload.ms != null) out.ms = payload.ms;
                if (payload && payload.phase) out.phase = payload.phase;
                // 2026-10-16 (现场 e2e-full-20261016 实测): 这条事件**没有 ts** ——
                // 而同一条流里 gua/plan/sub_agent_start/sub_agent_done 全都带 ts。
                // 于是"最后活动是什么时候"根本读不出来, 主人只能看到一张写着
                // "运行中"的卡, 分不清它在想、在调工具、还是已经卡死 —— 这正是
                // 老板说的"跟死了一样"里最要命的一半 (另一半是整轮 0 张卡, 已修)。
                // 探针也是瞎的: 我按 ts 切时间线, 91 条 progress 全被过滤掉, 量不出
                // 思考曲线。活性事件必须自带时间戳, 否则它证明不了自己活着。
                out.ts = _now;
                return realRes.write('event: sub_agent_progress\ndata: ' + JSON.stringify(out) + '\n\n');
              }
            } catch (_) {
              // 解析不了就照旧吞掉 —— 活性上报是增量价值, 不值得为它冒险泄漏半截内容。
            }
          }
        }
        // 2026-10-16 (现场 card-1792148760918 实测): 子 agent **确实调了工具** ——
        // 服务端 `[j2-batch] tool_start: read_file` ×3 且全部 ok=true,
        // 但整轮 365 条 sub_agent_progress 里带 tools 的 = **0 条**。
        //
        // 因为 DAG 派发的子 agent 走的是 j2_agent_loop (不是 sub-agent.js 那条 loop),
        // 它的工具活动落在 `event: batch_complete` (带 tool_names) 里, 而上面那张
        // 穿透白名单没放行它 → 主人看到的卡片只有"运行中", 一个工具名都没有。
        // 这就是老板原话"调用有没有用工具完全不知道"的**最后一环**。
        //
        // 放行 batch_complete, 转成带 agent 归属的 sub_agent_progress(stage=tool_executed):
        // 面板据此把工具名显示成小标签。工具结果是业务数据 (可能含文件内容),
        // 所以只透工具**名**, 不透结果。
        if (typeof d === 'string' && realRes && !realRes.writableEnded &&
            d.startsWith('event: batch_complete')) {
          const di = d.indexOf('data: ');
          if (di !== -1) {
            try {
              const payload = JSON.parse(d.slice(di + 6).trim());
              const names = Array.isArray(payload.tool_names) ? payload.tool_names.filter(Boolean).map(String) : [];
              if (names.length) {
                const _nowT = Date.now();
                return realRes.write('event: sub_agent_progress\ndata: ' + JSON.stringify({
                  agent: _canonAgent, task: task || '', stage: 'tool_executed',
                  tools: names,
                  tool_calls: names.length,
                  round: payload.round,
                  batch: payload.batch,
                  ms: _nowT,
                  ts: _nowT,
                }) + '\n\n');
              }
            } catch (_) { /* 解析不了就照旧吞掉 */ }
          }
        }
        // 2026-10-28 (现场 /api/pangu/agent/stream 抓原始 SSE 抓到):
        //   子 agent 的 tool_call / tool_result 原来**整条被吞** ——
        //   穿透白名单里没有这两类, 落到最后 `return true` 就没了。
        //   后果: 主气泡里一张工具卡都没有 (老板原话「调用子agent和工具都不显示」),
        //   而工具名又只活在被吞掉的子 agent 面板里 ⇒ 全程零工具可见性。
        //
        //   现在穿透, 但**重写成带将灵归属的单条形状**:
        //     tool_call   → { id, name, params, agent, session_id, ts }
        //     tool_result → { id, name, agent, ok, blocked, error, ts }
        //   跟 agents/sub-agent.js 的 emitSubAgentToolEvent 同构 ⇒ 前端两处
        //   (tool_call / tool_result) 都能直接建卡 + 回填状态。
        //
        //   **不传 result 原文**: 子 agent 的工具结果常是整文件内容,
        //   原样转发会把 SSE 撑爆(前端卡片只需要 ok/blocked/ts)。
        if (typeof d === 'string' && realRes && !realRes.writableEnded &&
            (d.startsWith('event: tool_call') || d.startsWith('event: tool_result'))) {
          const di = d.indexOf('data: ');
          if (di !== -1) {
            try {
              const payload = JSON.parse(d.slice(di + 6).trim());
              const _nowT = Date.now();
              const _agent = _canonAgent;
              if (d.startsWith('event: tool_call')) {
                const _calls = Array.isArray(payload && payload.calls)
                  ? payload.calls
                  : (payload && payload.id && payload.name ? [payload] : []);
                for (const _c of _calls) {
                  if (!_c || !_c.name) continue;
                  realRes.write('event: tool_call\ndata: ' + JSON.stringify({
                    id: _c.id || (_c.name + '#' + Math.random().toString(36).slice(2, 8)),
                    name: _c.name,
                    params: _c.params || {},
                    agent: _agent,
                    ts: _nowT,
                  }) + '\n\n');
                }
              } else {
                realRes.write('event: tool_result\ndata: ' + JSON.stringify({
                  id: payload && payload.id,
                  name: payload && payload.name,
                  agent: _agent,
                  ok: payload && payload.ok !== false,
                  blocked: !!(payload && payload.blocked),
                  error: payload && payload.error ? String(payload.error).slice(0, 200) : undefined,
                  ts: _nowT,
                }) + '\n\n');
              }
            } catch (_) { /* 解析不了就照旧吞掉 */ }
          }
        }
      } catch (_) {}
      return true;
    },
    end: () => {}, writableEnded: false, destroyed: false,
    on: () => {}, once: () => {}, removeListener: () => {}
  };
}

// 卦块是固定模板, 结构恒为:
//   【盘古起卦 · 先于推理 …】<正文行> —— 回答顺序 …
//   (+ 一行"若工具没拿到数据…"反幻觉提示) (+ 可选的"主人问题: "标记)
//
// 收尾标记**不在这里写** —— 唯一真源是 modules/gua_block.js。
// 2026-10-21 教训 (**两份同义文本各改各的, 改一次就漂一次**):
//   这里原来把收尾**句子**「不要复述本块原文。」抄了一份当收尾标记,
//   而块正文在 pangu_agent_stream.js —— 那边 2026-10-21 改了这句措辞,
//   这边的标记就失效了: 认不出收尾 → 整块卦象留在路由输入里 →
//   卦象里的"推理/分析"替主人投票 → 任务被派给写不了盘的 analyzer。
//   (routing-gua-strip-20261012.test.js 当场逮住, 3 条红。)
//   task_split.js 里还有第三份。现在三处都从 gua_block.js 取, 抄不动了。
const { findGuaBlockEnd } = require('./gua_block');
function _stripGuaBlockForRouting(text) {
  const s = String(text || '');
  const start = s.indexOf('【盘古起卦');
  if (start < 0) return s.trim();
  const end = findGuaBlockEnd(s, start);       // 块尾之后的下标
  if (end < 0) return s.trim();                // 认不出收尾就不猜, 退回旧行为
  let tail = s.slice(end);
  const marker = tail.match(/主人问题:\s*/);
  if (marker && marker.index <= 60) {
    tail = tail.slice(marker.index + marker[0].length);
  } else {
    tail = tail.replace(/^\s*若工具没拿到数据[^\n]*\n?/, '');
  }
  return tail.trim();
}

// 2026-10-16 (现场 v3-034204 的时间账, 同一个"建 2 个文件"总共 398 秒):
//   planner 115s / executor 95s / checker 119s / synthesis 68s —— 四刀**串行**,
//   每刀都是一次大上下文的 27B 推理调用 (这个模型单刀 ~58s 是底价, Codex 同样一道题
//   只用 1 刀)。所以省时间只有两条路: 少几刀, 或者单刀少想。
//
//   planner 那 115s 里 **113s 在思考**: 6034 字 thinking, 最后 8s 才吐出 416 字的
//   JSON 计划 (72 个采样点逐段可查)。它要输出的只是一个拆解, 思考不是在提高质量,
//   是在烧钱 —— 而且本地模型这档"烧"极不稳定, 正是主人说的"有时 40s 有时 123s"。
//
//   本地模型的 reasoning_effort 字段是空转的 (llm_caller 里有 N=5 实测: 字段发出去
//   模型侧收不到), 盘古早已改走提示词层预算指令。同题实测挂 [推理预算: 中]:
//   24.2s → 17.0s, 思考 973 字 → 491 字, 而且方差消掉。
//
//   所以给 planner 一个默认档。三条边界, 一条都不能松:
//     ① 主人显式指定了档位 → 以主人的为准, 这里绝不覆盖
//     ② 只对**本地**模型生效 —— 云端的 reasoning_effort 是真字段, 各家默认值本来就不是 high
//     ③ 用 medium 不用 low —— 拆解质量是盘古的命根子, 不拿它换速度
// 2026-10-16 (现场 longtask-234507, 5 步长任务 1200s 只跑完 1 刀):
// executor 干的活是确定性的 (往文件写 3 行), 实测正文 **70 字**、思考 **2434 字** = 34:1。
// decode 20 tok/s 下这就是 ~120s/轮, 每刀 3-4 个工具往返, 5 刀 ≈ 30 分钟。
// 时间全烧在思考上 —— 那是"长任务无法执行"的真正账单。
//
// 只给 executor, **不给 checker**, 这是有原则的分界:
//   executor 的活是确定性的, 思考不产生额外判断, 纯浪费;
//   checker 的价值就是"别相信上一刀的自述", 它要多想才敢判 PASS/FAIL。
//   削 checker 的预算 = 削长任务的验收环节, 而那正是 longtask-01-20261012
//   「明明做对了却报 partial」的根因类别。宁可慢, 不拆验收。
//
// 2026-10-16 (现场 lt5, 还是同一道 5 步题, executor 拿 medium): 单轮 thinking
// **9694 字**, 直接把流式调用顶到 STREAM_TOTAL_TIMEOUT_300s —— 而它那一刀干的是
// 「往 u1.txt 写 3 行 alpha/beta/gamma」。日志里 297 条「推理预算: 中」说明指令
// 确实发到了, 不是没生效, 是 medium 对 executor 根本不够低。
//
// 上面那三行写的原则是「executor 的活是确定性的, 思考不产生额外判断, 纯浪费」,
// 但这行档位当初是从 planner 抄的 medium。抄过来的是 planner 那条理由
// (「拆解质量是命根子, 不拿它换速度」) —— 那条只对 planner 成立。executor 不做
// 拆解, 它照着规格执行, 用不着权衡。
// low 的指令是「先判断需不需要工具, 需要就直接调」—— 对一个正在建文件/写文件的
// executor 正好对症: 别推演, 直接调工具。
// 2026-10-16 (现场直连实测, MiniMax-M3.1-Flash-Preview, 云端):
//   同一道题 (读一个 125 行文件出报告), 只改**一个**请求字段:
//     不发字段            14.23s   思考 6360 字符  正文 551
//     reasoning_effort=low  3.67s   思考  179 字符  正文 476   ← 3.9x
//     reasoning_effort=minimal 4.05s 思考 383 字符  正文 631
//     reasoning_effort=none  HTTP 400 —— 该模型强制 adaptive thinking, 不给关
//   正文体量没掉 (476 vs 551), 砍掉的是思考。**云端认这个字段, 而且认得很实。**
//
// 之前的代码 (下头那段注释的推理) 只对**本地**成立: LM Studio 不收这个字段,
// 所以本地改走提示词层预算指令 (llm_caller `_reasoningBudgetInstruction`, 实测
// 2.9s→2.2s 且方差归零)。但 `if (!isLocalModel) return undefined;` 把这条**本地**
// 结论推广成了全局规则 —— 于是云端模型**永远不发**这个字段, 每刀白烧 6360 字符思考,
// 9 轮一道活。这就是"同样的模型 Codex 比盘古快"的物理原因: 不是盘古刀多,
// 是每刀都在过度思考。
//
// 判据来自哪一端就只对哪一端生效 —— 本地那次 N=5 实测没有资格否决云端。
const _ROLE_REASONING_DEFAULT = {
  // 键跟角色真源一样是拼音。这张表以前用英文键 (planner/executor/analyzer),
  // 而角色已经改叫 kan/kun/li —— 键一错, `_ROLE_REASONING_DEFAULT[role]` 恒为
  // undefined, 于是**每一刀都拿不到推理预算档**: 实测就是 29.27s/刀、思考 16847 字
  // (那个"云端不发字段"的原始故障)。不报错、不告警, 只是慢了一倍 —— 这种错
  // 只有在键跟真源对齐后才不会再发生。
  kan: 'medium',    // 拆解质量是盘古的命根子, 不拿它换速度 (原判, 不动)
  kun: 'low',       // 确定性执行, 思考不产生额外判断 (原判, 不动)
  li: 'low',        // 取证型活: 证据在工具结果里, 不在推演里
};

function _effortForRole(role, modelCfg, reqBody) {
  const explicit = reqBody && reqBody.reasoning_effort;
  if (explicit) return explicit;
  // 模型配置里主人自己分过档的, 压过角色默认表 —— 它才是**逐家校准**的地方。
  // (run() 里 `model = { ...model, reasoning_effort: reasoningEffort }` 是覆盖式赋值,
  //  顺序错了会把这里配好的值悄悄改掉。)
  // 这一条同时决定了上一段那个取舍: 角色表只补**没配过**的模型,
  // 配过的 (MiniMax 实测 medium 最优, 因为它正文最多) 一律照配置走。
  const modelSet = modelCfg && String(modelCfg.reasoning_effort || '').trim();
  if (modelSet && modelSet !== 'auto' && modelSet !== '') return modelSet;
  // 归一: role 从模型、日志、旧 checkpoint 流进来, 用哪种写法不由这张表决定。
  const _canon = require('../agents/gua-identity').resolveRole(role);
  const def = _canon ? _ROLE_REASONING_DEFAULT[_canon] : _ROLE_REASONING_DEFAULT[role];
  if (!def) return undefined;
  // 本地/云端一视同仁地给默认值, 但**通道各自不同** (这一句是全部要害):
  //   云端 → 请求字段, 上游真收 (实测 3.9x)
  //   本地 → 字段空转, 但设上去会激活 llm_caller 的提示词层预算指令 (实测 2.9→2.2s)
  // 所以不存在"给错了地方"—— 两端各走各的生效通道, 都有实测支撑。
  return def;
}


// 主人原话里出现的绝对路径 —— 注入原话的唯一正当理由就是把路径钉住。
// 用这一份替代原来"整句原话"的注入, 三个注入点共用, 行为一致。
function _extractOwnerPaths(userInput) {
  const s = String(userInput || '');
  if (!s) return [];
  const out = [];
  const seen = new Set();
  const re = /\/(?:Users|Volumes|tmp|private|var|etc|home|opt)\/(?:[^\s,，;；。"'）\]!？]+)/g;
  let m;
  while ((m = re.exec(s)) !== null) {
    const p = m[0].replace(/[。！？、，;,，)）]+$/, '');
    if (p.length > 3 && !seen.has(p)) { seen.add(p); out.push(p); }
  }
  return out;
}

// 一个子 agent 就无所谓串味 (原话就是它自己的任务); 多个才必须收窄。
// 子任务里出现这些说法 = 它要拿主人原文当规格用 (逐字内容/数值/文件名/命令)。
// 现场 (soak-live-1791878006): executor 的交代写着「必须严格使用主人给出的内容」,
// checker 写着「与主人给定的 8 份原始内容比对」—— 原文一个都没传下去, 于是 8 份文件
// 写成「文件名当内容」的占位串, checker 手上没有比对对象却报「PASS 8/8 字节级核验」。
const _SUBTASK_NEEDS_OWNER_SPEC = /原文|原话|主人给|主人提供|主人指定|主人要求|按上面|按上述|按前面|按前述|给定|逐字|照抄|原样|严格(?:按|照|使用)|(?:必须|要)(?:完全)?一致|同上|如上所(?:述|写)/;

// 2026-10-17: 把"这一刀自己的路径 / 兄弟路径"这个判定抽成**一处**, 两个调用方共用。
// 抽之前它只在 _ownerScopeBlock 里内联算一遍, 现在继承上下文那边也要同一份答案 ——
// 两处各写一遍判据, 迟早漂成两个口径 (路径锚说"这是你这一刀", 继承过滤说"那是你的",
// 模型两头都听, 又去读兄弟文件)。所以判据只能有一份。
function _ownerPathScope(userInput, subTaskText) {
  const all = _extractOwnerPaths(_stripGuaBlockForRouting(userInput));
  const _stText = String(subTaskText || '');
  // 收窄条件 (**只有编号并列清单那种刀才收窄**): 子任务带 task_split 自己拼的
  // 「只做这一项: <X>」标记, 且 X 确实是主人原话里的路径。顺序/步骤型任务永远没有
  // 这个标记 —— 它要的路径就是主人的**全量**路径 (见 owner-spec-to-subagent-20261013)。
  const _isEnumeratedKnife = /只做这一项[:：]/.test(_stText);
  const _ownPaths = _isEnumeratedKnife ? _extractOwnerPaths(_stText) : [];
  const _ownInOwner = _ownPaths.filter((p) => all.includes(p));
  const scoped = !!(_isEnumeratedKnife && _ownPaths.length && _ownInOwner.length === _ownPaths.length);
  const own = scoped ? _ownPaths : all;
  return { all, own, scoped, siblings: all.filter((p) => !own.includes(p)) };
}

function _ownerScopeBlock(userInput, subTaskCount, subTaskText) {
  // 2026-10-12: 卦块里也可能有路径 (卦辞/盘名), 混进"主人要操作的路径"会把子 agent 带偏。
  const _ownerOnly = _stripGuaBlockForRouting(userInput);
  const paths = _extractOwnerPaths(_ownerOnly);
  // 2026-10-16 (现场 e2e-tsmeas-20261016, 子会话落盘逐条核对出来的):
  // 上面这个 pathBlock 原话是「主人原话里的路径 — **直接照抄**, 禁止用你自己的 cwd 顶替」,
  // 然后把主人原话里的路径**全部**列进去。主人问
  //   "请分别分析这三个文件…: 1) j2_loop_shared.js 2) model_cost.js 3) checkpoint.js"
  // 拆成三刀之后, 每一刀的 pathBlock 里都是**三个路径 + "直接照抄"** ——
  // 等于在命令子 agent 把兄弟刀的活也做掉。实测两个 analyzer 的真实 tool_calls:
  //   sub-1 被派 model_cost.js → read_file ×3 (j2_loop_shared / model_cost / checkpoint)
  //   sub-2 被派 checkpoint.js  → read_file ×3 (同样三个)
  // 代价是实打实的: 文件内容 3 份 ≈ 16k 字进上下文, 而它本该只要 1 份 ≈ 5k 字。
  // 之后**每一轮**都要为这 3 份内容重新 prefill —— 这就是"同样模型, 盘古比 codex 慢"
  // 的一大半, 也是老板说的"子 agent 只做自己相关的"在工具层根本没做到。
  //
  // 这块 2026-09-18 加它是对的 (治"扫了 pangu 仓库没扫易经", 子 agent 拿自己 cwd 顶替),
  // 只是范围给宽了: 钉路径要钉**这一刀自己的**那条, 不是把主人的整份清单抄一遍。
  // 收窄条件 (**只有编号并列清单那种刀才收窄**): 子任务带 task_split 自己拼的
  // 「只做这一项: <X>」标记, 且 X 确实是主人原话里的路径。
  //
  // 2026-10-16 被 owner-spec-to-subagent-20261013 的反向不变量打回来一次: 我第一版
  // 写的是"子任务里出现了路径就收窄", 结果步骤型子任务也踩了 —— 「真实写入
  // /tmp/longtask_report_20261012.md」里那个路径是它**要写的**, 而它要**读**的是主人
  // 说的 apps/core/modules。收窄后路径锚没了, 那条防线
  // 恰好是治 longtask-01「5 个 executor 抢同一个汇总文件」的。
  //
  // 所以判据从"有没有路径"换成"是不是编号并列清单那一刀": 那个标记是
  // _splitEnumeratedParallel 服务端自己拼上去的, 只有真并列清单才有, 顺序/步骤型
  // 任务永远没有 —— 正好就是"项与项被分给了不同子 agent"这个唯一的收窄理由。
  const _scope = _ownerPathScope(userInput, subTaskText);
  const _scoped = _scope.scoped;
  const scopedPaths = _scope.own;
  const pathBlock = paths.length
    ? '\n\n【' + (_scoped
      ? '这一刀自己的路径'
      : '主人原话里的路径') + ' — 直接照抄, 禁止用你自己的 cwd 顶替】' + scopedPaths.slice(0, 8).join('  ')
    : '';
  if (subTaskCount <= 1) {
    // 单子任务: 原话本身就是它的任务, 全量注入无害且有增益 (锚路径 + 锚意图)
    // 2026-10-12: 同上, 先剥卦块再截断, 否则卦块模板把主人诉求顶掉。
    return '\n\n【主人原话 — 路径/目标一律以此为准, 禁止用你自己的 cwd 顶替】'
      + _stripGuaBlockForRouting(userInput).slice(0, 400) + pathBlock;
  }
  // 步骤型任务 (2026-10-12 longtask-01 实案): 原文里 5 步都在, 全给会让 3 个 executor
  // 都以为要写那个汇总报告 → 抢同一个文件互相覆盖。维持原样: 只给路径锚 + 边界。
  if (!_SUBTASK_NEEDS_OWNER_SPEC.test(String(subTaskText || ''))) {
    return pathBlock
      + '\n\n【只做你被分派的这一个子任务】上面任务描述之外的步骤一律不做; '
      + '禁止替别的步骤产出文件 (会和其他子 agent 抢同一个文件互相覆盖); 禁止替别的步骤收口。'
      + '【收口纪律】task_done 是**你这一个子任务**的收口信号 (调了这轮就结束, 早调等于交白卷): 你这步的活真做完、证据齐了才调; 没做完继续调工具, 没干完不许调 task_done。';
  }
  // 规格型任务 (2026-10-13 soak-live-1791878006 现场, 长工作第 1 轮就翻): 子任务点名要
  // 「主人给的原文/逐字内容」, 而原文没传下去 —— executor 只能写「文件名当内容」的占位串
  // 还逐项报 ✅, checker 没有比对对象却报「PASS 8/8 字节级核验 (xxd hexdump)」,
  // 补救轮 executor 自己编一份内容写「全部完成, 无差异」。
  // 这种任务原文就是需求真源, 必须给; 「只做你这一步」的边界一句不动。
  const _raw = _stripGuaBlockForRouting(userInput);
  const _cap = 8000;
  const _spec = _raw.length > _cap
    ? _raw.slice(0, _cap) + '\n…【主人原话超长, 上面已截断到 ' + _cap + ' 字。你这一步要的规格若落在截断之后, '
      + '用 read_file / exec_command 去原始出处取; 取不到就如实说缺什么, 不许编】'
    : _raw;
  return pathBlock
    + '\n\n【主人原话 — 需求真源, 只读】' + _spec
    + '\n【铁律】① 上面是需求原文, **只当规格真源查**, 不是让你重做全部步骤 —— 原文里其他步骤由别的子 agent 负责, 你抢做会互相覆盖。'
    + '② 你的步骤里凡出现「按主人给的原文/内容/数值/文件名」, 一律回上面逐字取 —— 不许拿占位串 (把文件名当正文、"示例"、"待补充") 顶替, 不许自己编合理值。'
    + '③ 上面原文里真的没有你要的规格 → 如实说「原文未给出 X」, 不许编, 更不许在核对表里给它打 ✅。'
    + '\n【只做你被分派的这一个子任务】上面任务描述之外的步骤一律不做; '
    + '禁止替别的步骤产出文件 (会和其他子 agent 抢同一个文件互相覆盖); 禁止替别的步骤收口。'
      + '【收口纪律】task_done 是**你这一个子任务**的收口信号 (调了这轮就结束, 早调等于交白卷): 你这步的活真做完、证据齐了才调; 没做完继续调工具, 没干完不许调 task_done。';
}

// ============================================================================
// createSubagentRunner — 一轮派发 (DAG 分层 + 并发闸门 + 单刀执行)
// ============================================================================
//
// ctx 契约 (调用方必须给):
//   res            真实 SSE (子 agent 全写 sink, 建卡/收口事件穿透到这里)
//   sessionId      父会话 id (子会话派生 #sub-N-role, 隔离 abort 域)
//   userInput      主人原话 (路径收窄 + 规格真源都从它抽)
//   model          本轮主模型 (子 agent 无条件继承)
//   configPath     节点配置 (角色档位解析)
//   opts           { reqBody } —— 主人显式指定的推理档从这里透传
//   subTasks       [{ agent, task, depends_on? }] 本轮要跑的刀
//   results        往这个**数组**里累积 (调用方后续综合/对账要用, 必须同一引用)
//   guaLine        起卦定调句 (无卦传空串)
//   dialogImages   对话里的图 (盘面/截图)
//   runSubAgentLoop  (messages, model, req, res, opts) => Promise —— 跑一刀的 loop
//   safeResWrite   注入的 SSE 安全写
//   ctxForSubagent (mode, taskText, excludeScopePaths) => { turns, findingsBlock, rootId }
//   sc             session_container (findings 回写; 不传就现取)
//   shouldFastFail(layerResults, allResults) / onQuotaFastFail(layerResults, kind)
//     配额快速失败, **可选**。不传 = 调用方不知道配额政策 = 一律不判死。
//     主 agent 自派那条路走的就是"不传": 它拿到 results 自己判断要不要继续。
function createSubagentRunner(ctx) {
  const res = ctx.res;
  const sessionId = ctx.sessionId;
  const userInput = ctx.userInput;
  const model = ctx.model;
  const configPath = ctx.configPath;
  const opts = ctx.opts || {};
  const subTasks = ctx.subTasks || [];
  const results = ctx.results || [];
  const _guaLine = ctx.guaLine || '';
  const _dialogImages = ctx.dialogImages || [];
  const safeResWrite = ctx.safeResWrite;
  const _sc = ctx.sc || require('./session_container').getContainer();
  // 2026-10-14 连续上下文的唯一入口。不传就退化成"子 agent 从零理解主人"
  // —— 那正是老板说的每个都在重建世界认知。
  const _ctxForSubagent = ctx.ctxForSubagent || (() => undefined);
  const _runSubAgentLoop = ctx.runSubAgentLoop;
  if (typeof _runSubAgentLoop !== 'function') {
    throw new Error('subagent_runner: 调用方必须给 runSubAgentLoop');
  }
  // 父 HTTP 请求。子 loop 只用它接客户端断开 (主人关页面 → 中止这一刀)。
  // 可传可空: 空的话子 loop 就不接断开信号, 其余行为一模一样。
  const req = ctx.req || null;
  // 没给配额钩子就一律当作"不失败" —— 调用方不知道配额政策, 派发机制不该替它猜。
  const _shouldFastFail = ctx.shouldFastFail || (() => false);
  const _onQuotaFastFail = ctx.onQuotaFastFail || (() => {});
  // "这一层是不是整层死于端点/超时" —— 只用于**降级提示**(别把上游已落盘的产出也丢),
  // 不参与任何收口裁决。调用方不传就当没死, 提示少一行而已。
  const _sliceIsDead = ctx.isSliceDead || (() => false);

  // ===== 原 dispatcher 的 DAG 引擎 (含并发闸门), 原封不动搬过来 =====
  // __RUNPLAN__
  const _taskResults = new Array(subTasks.length).fill(null);
  // 2026-10-13 (KIMI 逆向: maxConcurrent=2): 子 agent 并发闸门
  //
  // 2026-10-18 (老板原话: «那问题就应该盘古判断几个agent并发, 不是人为控制agent并发»):
  // 原来这个闸门是**人拨的全局旋钮** ——
  //   Math.max(1, parseInt(process.env.PANGU_MAX_CONCURRENT_SUBAGENTS || '3', 10))
  // 两个毛病, 都是"人"在替盘古做并发决定:
  //   ① 它只看**主模型**。可闸门是整个 runner 共享的一个标量, 而每一刀实际跑在哪个
  //      端点上, 要等 `_runOneSubTaskInner` 进去之后 `_roleModelFor` 才解析得出来 ——
  //      **闸门在它本该依赖的那个信息出来之前就定好了**。
  //   ② 本地和云端共用一个值。本地单卡 (lmstudio/omlx/mlx) 物理上就是同时解一路,
  //      塞 3 路进去不是更快, 是每路都慢到撞 ZERO_CONTENT_TIMEOUT_300s
  //      (实机 session 80004976: 并发体检 → 2 条 633.2s / 300.0s, 整轮 15 分半)。
  //      云端吃得下并发, 本地吃不消 —— 同一个数字套两边, 必然错一边。
  //
  // 现在每刀**按自己那个端点的真实容量**取额度:
  //   本地 (model_cost.isLocalModel, 单一真源) = 单卡串行解码 → 1 路, 宁慢不挂
  //   云端 = 3 路
  // 环境变量仍能显式覆盖 (留逃生舱), 但默认值不再是"人拨的数"。
  // 额度按**端点分组**计数: 本地那把闸门只数本地的刀, 云端那把只数云端的刀。
  const _explicitCap = parseInt(process.env.PANGU_MAX_CONCURRENT_SUBAGENTS || '', 10);
  const _MAX_CONCURRENT_CLOUD = Math.max(1, _explicitCap || 3);
  const _MAX_CONCURRENT_LOCAL = Math.max(1, _explicitCap || 1);
  const _gateActive = new Map();
  const _gateWait = new Map();
  const _acquireSlot = (key, cap) => new Promise(r => {
    const active = _gateActive.get(key) || 0;
    if (active < cap) { _gateActive.set(key, active + 1); r(); return; }
    const q = _gateWait.get(key) || [];
    q.push(r);
    _gateWait.set(key, q);
    // 排队时说一句话 —— 主人等的是闸门后面那把队, 不该看到一片死寂。
    // 这也是"跟死了一样"的第二处来源: 刀已经在跑, 只是没抢到槽位。
    try {
      safeResWrite(res, 'status', {
        stage: 'sub_agent_queue',
        message: q.length + ' 个子 agent 排队等槽位 (本端点同时 ' + cap + ' 路)',
      });
    } catch (_) { /* 活性事件不许影响派发 */ }
  });
  const _releaseSlot = (key) => {
    _gateActive.set(key, Math.max(0, (_gateActive.get(key) || 1) - 1));
    const q = _gateWait.get(key) || [];
    const next = q.shift();
    if (q.length) _gateWait.set(key, q);
    if (next) { _gateActive.set(key, (_gateActive.get(key) || 0) + 1); next(); }
  };
  // 这一刀跑在哪个端点上 → 就按那个端点的容量取闸门。
  // 提前解析只是为了让闸门**在它该依赖的信息之后才定**, 不改变选谁跑 ——
  // 里面调的是同一个 _roleModelFor, 与 _runOneSubTaskInner 里那份逐字一致。
  const _gateFor = (subTask) => {
    let m = null;
    try { m = _roleModelFor(configPath, subTask && subTask.agent, model); } catch (_) { m = model; }
    if (!m) m = model;
    let local = false;
    try { local = !!require('./router/model_cost').isLocalModel(m); } catch (_) { local = false; }
    return {
      key: String((m && (m.id || m.name)) || 'model') + '|' + (local ? 'local' : 'cloud'),
      cap: local ? _MAX_CONCURRENT_LOCAL : _MAX_CONCURRENT_CLOUD,
    };
  };
  const _runOneSubTask = async (subTask, taskIndex) => {
    const _gate = _gateFor(subTask);
    await _acquireSlot(_gate.key, _gate.cap);
    try {
      const _result = await _runOneSubTaskInner(subTask, taskIndex);
      _releaseSlot(_gate.key);
      return _result;
    } catch (e) { _releaseSlot(_gate.key); throw e; }
  };
  const _runOneSubTaskInner = async (subTask, taskIndex) => {
    const deps = Array.isArray(subTask.depends_on) ? subTask.depends_on : [];
    //
    // 2026-10-22: 派活前核一遍简报里的排盘断言 (老板 10-21 现场: planner 编了张盘还标"已核实")
    //
    // 现场原句一字不差: planner 在**任何工具都没跑之前**就写下
    //   「丁卯/己亥/丁酉/甲辰，日主丁火」+「前一刀已核实，直接采信，不得另算、不得改动四柱与大运」
    // 喂给综合 agent。真值是 丁卯/辛亥/癸酉/丙辰, 日主癸水 (bazi_calc 实跑确认)。
    // > 把编的盘标成"已核实"，比答错更坏 —— 答错模型自己会怀疑, 标成已核实连怀疑的机会都没了。
    //
    // 为什么现有的 chart_verify_guard 拦不住: 它的边界写死是「只在**本轮已经成功调过**
    // 确定性排盘工具时才生效」, 防的是**事后**自己重算; 编造发生在**事前**,
    // 在 planner 写简报这一侧, 是另一个子系统。
    //
    // 真源从哪来: ① 本刀**依赖**的前序刀跑完后的 toolHistory (DAG 顺序保证已就绪)
    //             ② 本轮父级/兄弟刀已经跑过的 toolHistory (本刀可能在它们之后跑)
    //             两者都空 = 没人算过盘 = 简报里的四柱只能是编的。
    //
    // 处置: **抹掉编造的断言 + 换一句"自己去算"**, 不整刀否掉 ——
    // 整刀否掉会误伤(这一刀可能只是在做别的活, 顺带引用了四柱)。
    // 抹掉的是**值**, 连"直接采信/不得另算"这类**指示语**一起抹 ——
    // 只抹值不抹令 = 下游还在被指示采信一个已被抹掉的盘。
    const _chartGuard = (() => {
      try { return require('./chart_claim_guard'); } catch (_) { return null; }
    })();
    if (_chartGuard) {
      try {
        const _evidence = [];
        // ① 前序刀 (依赖) 的 toolHistory
        for (const d of deps) {
          const up = _taskResults[d];
          const h = up && up.result && up.result.data && up.result.data.toolHistory;
          if (Array.isArray(h)) _evidence.push(...h);
        }
        // ② 本轮已跑完的刀 (含兄弟) —— _taskResults 里非空的都算
        for (const r of _taskResults) {
          if (!r) continue;
          const h = r.result && r.result.data && r.result.data.toolHistory;
          if (Array.isArray(h)) _evidence.push(...h);
        }
        // ③ 父级主 agent 这一轮调过的工具 (主 agent 自己也能调排盘)
        const parentTools = ctx.parentToolHistory || ctx.toolResults || [];
        if (Array.isArray(parentTools)) _evidence.push(...parentTools);

        const _res = _chartGuard.check(subTask.task, _evidence, sessionId);
        if (_res.applicable && _res.violations.length) {
          console.warn('[runner] ⚠️ 简报里有未核实的排盘断言 (刀 ' + (taskIndex + 1) + ', ' + subTask.agent + '): '
            + _chartGuard.describe(_res));
          subTask.task = _chartGuard.sanitizeTaskText(subTask.task, _res);
        }
      } catch (e) {
        // 守卫自己不许影响派发 —— 但要留痕, 静默失败是盘古这一族的老毛病
        console.warn('[runner] 排盘断言守卫异常 (不影响派发): ' + e.message);
      }
    }
    // 2026-09-16 上下文传递层: 上游给"引用块"(谁干的/干了哪/产出了什么 artifact), 正文摘要压到 400 字 —
    // 下游要细节自己 read_file 按引用取, 不把上游全文灌进来 (同一份数据不再被重读第二遍塞 prompt)
    const _upstreamRefs = deps.map(d => _taskResults[d]).filter(Boolean);
    const upstream = _upstreamRefs.map((r, k) => {
      const artifacts = Array.isArray(r.result && r.result.artifacts) ? r.result.artifacts : [];
      const refLines = [
        '上游[' + (k + 1) + '] agent=' + r.agent + ' | 任务: ' + String(r.task).slice(0, 120),
        '状态: ' + (r.error ? '失败 (' + r.error.slice(0, 120) + ')' : '完成'),
        artifacts.length ? '产出 artifacts: ' + artifacts.map(a => a.path || a).join(', ') : '',
        '结论摘要: ' + ((r.result && r.result.summary) || '').slice(0, 400)
      ].filter(Boolean).join('\n');
      return refLines;
    }).join('\n---\n');
    // 2026-09-18 (实案: 扫了 pangu 仓库没扫易经): 固定任务模板里 "目标路径" 没有锚定主人原话,
    // MiniMax-M3 就用自己的 cwd 顶替。子任务 task 文本强制挂上主人原话, 路径以原话为准。
    const _baseTask = (_guaLine ? _guaLine : '') + subTask.task + _ownerScopeBlock(userInput, subTasks.length, subTask.task);
    const taskText = upstream ? _baseTask + '\n\n【上游引用 — 基于引用继续, 不要重复上游已完成的工作; 需要细节用 read_file 按 artifacts 路径取】\n' + upstream : _baseTask;
    // 2026-09-14 (老板拍: 分派接通 — 八将灵真上场): 子任务注入角色专属 system prompt
    // 旧逻辑只跑通用 j2 loop, agent 名只是 SSE 标签, 角色职责/纪律从未进 prompt = 将灵从未真上场
    // 注: 剥掉角色 prompt 里的 <tool> 文本格式指令 — j2 loop 有自己的工具协议(native/XML), 混用会幻觉格式
    // 身份归一的**兜底**。dispatch_subagents_exec.normalizeTasks 已把 agent 归成拼音,
    // 但这个 runner 也有别的入口 (team_dispatch 等) 直接塞原始字符串进来。
    // 归一查不到 → 下面走"未知角色"分支 → 无白名单全量工具 —— 那等于把写盘权
    // 发给只读角色。所以这里再兜一次, 且**失败不猜**。
    const _canonRole = require('../agents/gua-identity').resolveRole(subTask.agent);
    if (_canonRole) subTask.agent = _canonRole;
    const _role = (subAgent.ROLES && subAgent.ROLES[subTask.agent]) || null;
    const _roleSys = _role
      ? _role.system.replace(/[^\n]*工具调用格式[^\n]*\n?/g, '') +
        '\n工具调用以本轮系统注入的格式为准 (function calling 或系统级 XML 协议), 禁止自创 <tool> 标签。'
      : '';
    // 2026-09-18: 未知角色退化为通用 loop — 不给全量工具 (旧行为让 planner/bug_hunter 幻觉出来,
    // 拿全量工具集瞎跑)。无白名单 = 通用 minimal 集, 由 j2 loop 按角色 null 走 default。
    if (_role) console.log('[runner] 将灵上场: ' + subTask.agent + ' (role prompt 注入, ' + _roleSys.length + '字)');
    else console.warn('[runner] 未知角色 ' + subTask.agent + ' — planner 幻觉/拼写错误, 按通用 loop 跑 (无角色白名单, 全量工具)');
    // 2026-09-14 (将灵专属模型): 按角色档位选模型 (planner/checker→fast, executor→smart), 温度钉 0
    const _subModel = _roleModelFor(configPath, subTask.agent, model);
    // 2026-10-16: 这里原来只取**主人的显式指定**, 没给默认档 —— 于是主派发路径上的
    // 子 agent 一个预算指令都收不到 (soul 块里的 _reasoningBudgetInstruction 要
    // model.reasoning_effort 才有内容)。实测 5 步长任务 executor 每轮想 2434 字。
    // 改走 _effortForRole: 主人显式指定 > 角色默认档 > 云端/无档不加指令。
    const _requestedEffort = _effortForRole(subTask.agent, _subModel, opts.reqBody);
    const _subModelForRequest = ['off', 'low', 'medium', 'high'].includes(_requestedEffort)
      ? { ..._subModel, reasoning_effort: _requestedEffort }
      : _subModel;
    if (_subModel !== model) console.log('[runner] 将灵 ' + subTask.agent + ' → ' + _subModel.id + ' (tier=' + (_subModel.tier || '?') + ', temp=' + (_subModel.temperature ?? '继承') + ')');
    safeResWrite(res, 'status', { stage: 'sub_agent_start', agent: subTask.agent, task: subTask.task, role_prompt: !!_role, model: _subModelForRequest.id });
    // 2026-10-16 (现场 live-1792146810934 / live-1792146487916 两轮实跑取证):
    // 这条 DAG 路径**只**发了 status{stage:'sub_agent_start'}, 没发真正的 sub_agent_start 事件,
    // 而前端的建卡逻辑挂在 eventName === 'sub_agent_start' 上 (ChatRoom.jsx:1384)。
    // 后果不是"少一行日志", 是**整轮一张子 agent 卡都没建起来**:
    //   - sub_agent_done 只做 prev.map(...) 更新既有卡片, 不建卡 → 三刀跑完仍然 0 张卡
    //   - 顶栏"将灵状态"从 subAgents 里筛 running → 一直筛不到 → 整个长任务期间显示"静候"
    // 也就是老板说的"跟死了一样": 三个子 agent 各自磨 200~550s, 屏幕上连"在跑"都看不到。
    // 实测那两轮: status{stage:sub_agent_start} 各 3 条, 真正的 sub_agent_start 事件 0 条。
    //
    // 补齐成真事件。fixed_flow 路径 (1420 行) 一直是对的, 唯独这条漏了 —— 两处现在同构。
    try {
      const _gua = (subAgentRuns.CODE_TO_GUA || {})[subTask.agent];
      safeResWrite(res, 'sub_agent_start', {
        agent: subTask.agent, gua: _gua || null, task: subTask.task,
        model: _subModelForRequest.id, session_id: sessionId, ts: Date.now(),
      });
    } catch (_) { /* 建卡事件不许影响派发 */ }
    try { subAgentRuns.record({ kind: 'start', code: subTask.agent, task: subTask.task, model: _subModelForRequest.id, sessionId }); } catch (_) {}
    try {
      // 2026-08-02 修 (老板实证): 子任务 loop 写真 res 会直接 event:final + res.end() 把 SSE 掐断 —
      // 老板只收到子任务 #1 的垃圾 final, 真综合答案永远到不了前端
      // 修: 子任务 loop 用 sink res (吞写不死连), 只有 dispatcher 的综合结果写真 res
      // 2026-09-18 (实案: 子 agent 扫了 pangu cwd 没扫主人给的路径): _baseTask 里已挂【主人原话】,
      // 这里再兜一层 — 若 taskText 没出现原话里的路径特征 (含绝对路径/目录词), 直接把主人原话追加。
      // 2026-09-18 强化: 从主人原话里直接抽绝对路径, 显式写进 taskText (LLM 不用再自己找)
      // 2026-10-12: 这层兜底原来会在没抽到路径时把整句主人原话灌回去 —— 那是串味的第二条路。
      // 现在只补路径, 且只在路径确实没出现过时补。
      const _quotePaths = _extractOwnerPaths(userInput);
      // 2026-10-16 (现场 e2e-scope-20261016 实测): 这层兜底原话是
      //   const _hasAllPaths = _quotePaths.every(p => taskText.includes(p));
      //   if (!_hasAllPaths && _quotePaths.length) _taskTextFinal += '【要操作的路径…】' + 全部;
      // 判据是"任务里有没有主人的**全部**路径"。而 _ownerScopeBlock 刚刚把路径收窄成
      // 这一刀自己那一条 —— 于是 every 必然为 false, 兜底立刻把**三个路径全补回去**,
      // 原话还写着"直接照抄"。实测 sub-2-analyzer 的最终任务文本里两个块并存:
      //   【这一刀自己的路径 — 直接照抄…】…/checkpoint.js
      //   【要操作的路径 (直接照抄, 别用你的 cwd)】…/j2_loop_shared.js …/model_cost.js …/checkpoint.js
      // 前面刚收窄, 后面立刻补回来, 等于没改 —— 它照读了两个兄弟的文件 (35.8k 字)。
      // 收窄之后这层兜底也必须只认**这一刀自己**的路径, 两处判据保持一致。
      // 判据与 _ownerScopeBlock 保持一致: 只有带「只做这一项」标记的编号并列清单刀
      // 才只认自己那一条。步骤型子任务哪怕点名了某个路径 (那多半是它要**写**的),
      // 它要**读**的仍然是主人原话里那些 —— 收窄了就等于把路径锚抽走。
      const _isEnumKnife = /只做这一项[:：]/.test(String(subTask.task || ''));
      const _knifePaths = _isEnumKnife
        ? _extractOwnerPaths(subTask.task) : [];
      const _knifeInOwner = _knifePaths.filter((p) => _quotePaths.includes(p));
      const _needPaths = (_isEnumKnife && _knifePaths.length
        && _knifeInOwner.length === _knifePaths.length) ? _knifeInOwner : _quotePaths;
      const _hasAllPaths = _needPaths.every(p => taskText.includes(p));
      let _taskTextFinal = taskText;
      if (!_hasAllPaths && _needPaths.length) {
        _taskTextFinal += '\n\n【要操作的路径 (直接照抄, 别用你的 cwd)】' + _needPaths.slice(0, 8).join('  ');
        console.warn('[runner] 子任务兜底补路径 ' + _needPaths.length + ' 个');
      }
      // task 必须跟上面 sub_agent_start 用的是**同一个值** (subTask.task 原值, 不是
      // _taskTextFinal 那个加过路径兜底的版本) —— 前端建卡和认领都用它做键,
      // 两处一旦不一致, 活性事件又会全部落空 (2026-10-17 现场根因)。
      const _sinkRes = _makeSinkRes(res, subTask.agent, subTask.task);
      // 2026-10-12 (会话 80922578 根修): planner 路径的子 agent 也挂本会话的图 —
      // 走 j2 legacy loop → llm_caller._adaptImagesForModel 按模型视觉能力落地。
      const _subUserMsg = { role: 'user', content: _taskTextFinal };
      if (_dialogImages.length) _subUserMsg.images = _dialogImages;
      // 2026-10-14 连续上下文 (这是 planner 最常走的一条路径, 优先级最高):
      // 旧码 _subMessages 只有 [角色 system, 这一句 task] —— 子 agent 完全不知道
      // 主人在同一会话里前面问过什么、兄弟将灵查到了什么, 每个都在重建世界认知。
      // 现在把真实对话轮次接在角色 system 之后 (同一条对话往下走),
      // 再把已完成的兄弟产出接一条 system (工作记忆, 混进 user/assistant 会让模型
      // 误判成主人在说话)。上游引用块 (upstream) 仍保留 —— 那是 DAG 的依赖语义。
      // 2026-10-16: 汇报契约只加给**模型看的那份**, 判定上下文相关性的仍是原始 taskText。
      // 契约里全是"完成/证据/未做/交接"这种通用词, 混进判定键会让任何历史都显得相关,
      // 筛选等于白做 —— 典型"为了加一句话把整件事改坏"。
      // 兄弟路径进继承过滤: 编号并列清单那一刀, 主人原话整份(三个路径)已经在
      // 上文里等着了, 再叠一份收窄 taskText 打不过它 —— 模型照上文那份把三件都干了。
      // 这里把兄弟路径交给 buildScopedContext, 让点名兄弟的轮次无条件砍掉
      // (不吃 CONTEXT_FLOOR_TURNS 的底线豁免)。判据与路径锚共用 _ownerPathScope,
      // 两边不会漂成两个口径。
      const _siblingPaths = _ownerPathScope(userInput, subTask.task).siblings;
      const _subCtx = _ctxForSubagent('task', taskText, _siblingPaths) || { turns: [], findingsBlock: '' };
      const _subMessages = [];
      if (_roleSys) _subMessages.push({ role: 'system', content: _roleSys });
      for (const _t of (_subCtx.turns || [])) {
        if (_t && (_t.role === 'user' || _t.role === 'assistant') && _t.content) {
          _subMessages.push({ role: _t.role, content: _t.content });
        }
      }
      if (_subCtx.findingsBlock) {
        _subMessages.push({ role: 'system', content: _subCtx.findingsBlock
          + '\n【继承纪律】上面是同一任务里兄弟将灵的产出, **视为已完成的真实工作**: '
          + '①它查过的东西别再查一遍 (除非结论可疑, 那就带具体疑点去查); '
          + '②你的产出要接住整条任务, 不是只答派给你的这一句; '
          + '③冲突时以你自己的工具证据为准并当场说明冲突。' });
      }
      _subUserMsg.content = _taskTextFinal + require('./session_container').REPORT_CONTRACT;
      _subMessages.push(_subUserMsg);
      // 2026-09-14 (#13, sanming3 实测): 并行子 agent 共用父 sessionId → j2-boundary §0.57
      // 把同 sid 的新 loop 当"主人发新请求"互相 abort (4 连杀, 子任务全灭 0 产出)。
      // 子 agent 是独立 worker, 给派生 sub-session 隔离 abort 域; 父 session 的账本/plan 不受污染。
      const _subSid = sessionId + '#sub-' + taskIndex + '-' + String(subTask.agent || 'agent');
      const r = await _runSubAgentLoop(
        _subMessages,
        _subModelForRequest, req, _sinkRes,
        { userInput: _taskTextFinal, reqBody: opts.reqBody || {}, sessionId: _subSid, suppressOutcomeRecord: true,
          // 2026-10-14: 把继承情况告诉 j2 主循环, 它据此开将灵级 trace。
          // 不传的话主循环不知道这一轮继承了什么, harness 里就只有"跑了 8 秒"，
          // 没法回答"将灵到底看没看到上文"这个最关键的问题。
          continuityRoot: _subCtx.rootId || sessionId,
          continuityInfo: { turns: (_subCtx.turns || []).length, has_findings: !!_subCtx.findingsBlock },
          // 2026-09-16 老板拍: 子 agent 按职能拿工具 — 角色工具白名单进 LLM 候选集
          role: subTask.agent,
          toolsAllowed: (_role && Array.isArray(_role.tools)) ? _role.tools : null,
          reasoning_effort: opts.reqBody && opts.reqBody.reasoning_effort,
        }
      );
      const _subSummary = (r && r.finalText) || '';
      // 2026-10-12: 删掉一段死代码 —— 它试图从 toolsUsed (纯工具名数组) 里"提取写盘路径",
      // 只能 map 出索引 [0,1..], 而且算完从未被使用 (r.artifacts 才是真来源)。
      // 真路径由 j2_agent_loop 从 task_ledger.facts.files_written 提取后随返回值带回 (已核实有效)。
      const _subResult = { summary: _subSummary, artifacts: (Array.isArray(r && r.artifacts) ? r.artifacts : []), data: {}, toolsUsed: Array.isArray(r && r.toolsUsed) ? r.toolsUsed : [], runtimeStatus: r && r.runtimeStatus };
      // 2026-10-14 连续上下文回写: DAG 子任务走的是 j2 legacy loop (不经过 sub-agent.js),
      // 所以产出写回得在 dispatcher 侧补。少了这一步, 只有 fixed_flow 路径的产出能继承,
      // planner 正常路径的产出照样蒸发 —— 那是最常见的一种, 等于白做。
      try {
        if (sessionId && _subSummary) {
          _sc.appendFinding(sessionId, {
            agent: subTask.agent || 'agent',
            task: subTask.task,
            summary: _subSummary,
            tools: _subResult.toolsUsed,
            toolEvidence: (Array.isArray(_subResult.artifacts) && _subResult.artifacts.length)
              ? 'artifacts: ' + _subResult.artifacts.map(a => (a && a.path) || a).join(', ')
              : '',
            // 2026-10-19 修: 原来写的是 `(_subResult.runtimeStatus || 'done') === 'done'` ——
            //   runtimeStatus 的取值是 completed / partial / failed, **永远不等于 'done'**,
            //   所以每一刀记进 findings 的 ok 都是 false, 成功刀失败刀根本分不开。
            ok: _sliceDeath.isRealDelivery(_subSummary, _subResult.runtimeStatus),
          });
        }
      } catch (_) {}
      // 2026-09-16 一期③: 子任务完成 → plan_state 对应 step 标 done (拆解状态机真推进, 验收有分母)
      //
      // 2026-10-19 修 (现场 desktop-1792368769981): 原来**只要 _subSummary 非空**就标 done。
      // 而 j2 调用失败时把报错文案塞进了 finalText ——
      //   "⚠️ 模型 qwen_qwen3.8-27b 端点连不上: read ECONNRESET — 已重试 2 次仍失败"
      // 那是个非空字符串, 于是 s1 被标成 done, evidence 里存的就是那句报错。
      // 后果: 计划卡把它计进「nDone」, 将灵卡显示「完成 90.5s」——
      //   **一刀 ECONNRESET 在界面上看起来是干完了**。
      //   主人盯的正是这件事: «盘古是不是活着, 是不是能交付»。
      const _stepStatus = _sliceDeath.stepStatusFor(_subSummary, _subResult.runtimeStatus);
      if (taskIndex >= 0 && taskIndex < subTasks.length) {
        try { require('./plan_state').updateStep(sessionId, 's' + (taskIndex + 1), { status: _stepStatus, evidence: _subSummary.slice(0, 200) }); } catch (_) {}
      }
      // 2026-10-19 修: 原来**无条件**发 sub_agent_done —— 于是 ECONNRESET 那一刀
      // 也发 done, 前端 SubAgentPanel 就把它显示成「完成 90.5s」(现场
      // desktop-1792368769981)。计划和将灵卡两个面板同时把失败说成完成。
      // 现在跟着 _stepStatus 走: 真没干成就走 error 事件, 让界面说实话。
      const _doneEvt = _stepStatus === 'done' ? 'sub_agent_done' : 'sub_agent_error';
      safeResWrite(res, _doneEvt, {
        agent: subTask.agent, task: subTask.task,
        summary: _subSummary.slice(0, 500), artifacts: _subResult.artifacts,
        ...(_stepStatus === 'done' ? {} : {
          error: _subSummary.slice(0, 300),
          step_status: _stepStatus,
          runtime_status: _subResult.runtimeStatus,
        }),
      });
      try { subAgentRuns.record({ kind: 'done', code: subTask.agent, task: subTask.task, model: _subModel.id, sessionId: _subSid, summary: _subSummary }); } catch (_) {}
      return { agent: subTask.agent, task: subTask.task, result: _subResult };
    } catch (e) {
      safeResWrite(res, 'sub_agent_error', { agent: subTask.agent, task: subTask.task, error: e.message });
      // 2026-09-16 一期③: 子任务失败 → step 标 failed (状态机不收口僵尸 pending)
      if (taskIndex >= 0 && taskIndex < subTasks.length) {
        try { require('./plan_state').updateStep(sessionId, 's' + (taskIndex + 1), { status: 'failed', evidence: String(e.message).slice(0, 200) }); } catch (_) {}
      }
      return { agent: subTask.agent, task: subTask.task, error: e.message };
    }
  };
// ===== DAG 分层调度: 有 depends_on 拓扑分层, 无则全并行 =====
  async function runPlan() {
    const _hasDeps = subTasks.some(st => Array.isArray(st.depends_on) && st.depends_on.length > 0);
    if (_hasDeps) {
      // DAG 模式: 拓扑分层执行
      const doneSet = new Set();
      const remaining = new Set(subTasks.map((_, i) => i));
      let _dagGuard = 0;
      while (remaining.size > 0 && _dagGuard++ < subTasks.length + 2) {
        const ready = [...remaining].filter(i => {
          const deps = Array.isArray(subTasks[i].depends_on) ? subTasks[i].depends_on : [];
          return deps.every(d => doneSet.has(d));
        });
        if (ready.length === 0) ready.push(...remaining);  // 有环 → 全放出, 降级并行
        const layerResults = await Promise.all(ready.map(i => _runOneSubTask(subTasks[i], i)));
        ready.forEach((i, k) => {
          _taskResults[i] = layerResults[k];
          doneSet.add(i);
          remaining.delete(i);
          results.push(layerResults[k]);
        });
        // 2026-08-02: 配额快速失败 — 首层全部死于 429 时不再烧后续子任务和综合 LLM
        if (_shouldFastFail(layerResults, results)) {
          // 配额快速失败 = 别再烧后面的刀。**怎么跟主人收口是调用方的政策**, 
          // 派发机制只负责停 —— 所以这里是回调, 不是 resDone。
          _onQuotaFastFail(layerResults, "dag");
          return;
        }
        // 2026-10-16 (lt3 现场): 上游刀已经把产出写进盘了, 这一层只是验收时端点抖了一下
        // —— 不中止, 交给综合照账本如实说"哪几步成了、哪一步没验成"。
        if (layerResults.length && layerResults.every(_sliceIsDead)) {
          console.warn('[runner] DAG 第 ' + _dagGuard + ' 层全挂, 但上游已有产出落盘 → 降级如实汇报 (不再整轮判死)');
        }
      }
    } else {
    // 2026-08-02 修 (老板实证: 5 个不同角色子任务串行 = 8 分钟等不到 final):
    // 无 depends_on = 全部独立 → 全并行 (DAG 语义的第 0 层), 不再按角色分组串行
    // 旧逻辑: 同角色并行/跨角色串行 — 5 角色链 5×90s, 老板等死
    {
      const batchResults = await Promise.all(subTasks.map((subTask, i) => _runOneSubTask(subTask, i)));
      // 2026-08-02: 配额快速失败 — 首批全部死于 429 时不再烧后续子任务和综合 LLM
      // 2026-10-16: 这一分支里 results 要到下面 dedup 循环才收 batchResults, 所以"已投入"的
      // 判据只能看 batchResults 自己 —— 存在这种刀: 活干完了 (artifacts 在盘上), 只是**交汇报
      // 那一次调用**撞上 ECONNRESET。它属于"已完成", 不属于"什么都没做"。
      const _parallelDead = batchResults.length > 0 && batchResults.every(_sliceIsDead);
      const _parallelFail = _shouldFastFail(batchResults, batchResults);
      if (_parallelDead && !_parallelFail) {
        console.warn('[runner] 并行批次全挂, 但批内已有产出落盘 (干完了只是汇报那次调用死了) → 降级如实汇报');
      }
      if (_parallelFail) {
        _onQuotaFastFail(batchResults, "parallel");
        return;
      }
   // 内容哈希 dedup Set 提到 batch loop 外, 跨 batch 也去重
      // P1: dedup 之前只在一个 batch 内有效, 跨 batch 重复结果不会去
      const seenHashes = new Set();
      for (const r of batchResults) {
        const hash = JSON.stringify({ a: r.agent, t: r.task, s: r.result?.summary || r.error || '' }).slice(0, 200);
        if (!seenHashes.has(hash)) {
          seenHashes.add(hash);
          results.push(r);
        }
      }
    }
    }  // end else (无 depends_on 全并行)
  }

  return {
    // 一刀一把梭 —— 补救轮/复验轮用这个 (自己给 depends_on: [], 不排 DAG)
    runOne: _runOneSubTask,
    // 整轮排 DAG: 分层并行 + 闸门 + 配额快失败。结果写进 ctx.results。
    runAll: async () => {
      await runPlan();
      return results;
    },
    results,
    subTasks,
  };
}

module.exports = {
  createSubagentRunner,
  // 这些原本是 j2_dispatcher 的内部函数, 现在两处调用方共用一份。
  // j2_dispatcher 继续从本模块 re-export, 对外 API 不变 (回归测试直接引用它们)。
  _makeSinkRes,
  _extractOwnerPaths,
  _ownerPathScope,
  _ownerScopeBlock,
  _roleModelFor,
  _effortForRole,
  _ROLE_REASONING_DEFAULT,
  _stripGuaBlockForRouting,
};
