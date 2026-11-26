/**
 * agents/sub-agent.js
 * 子 Agent 运行器 — LLM 驱动、可调工具
 * 重构：让子 agent 真正用 LLM 推理 + 调用工具，不再是硬编码规则
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const {
  endpointOf,
  canonicalModelName,
  normalizeProtocol,
  normalizeEndpoint,
  isAnthropic,
  authHeaders,
  outputTokenCap,
  resolveRequestTimeoutMs,
} = require('../modules/model_transport');

// 延迟加载，避免循环依赖
function _tools() {
  return require('../modules/tools').TOOLS;
}
function _toolsSchema() {
  return require('../modules/tools_schema').TOOLS_SCHEMA;
}
// 2026-10-12 (会话 80922578 根修): 图像适配复用主链路 llm_caller 的同一份实现 —
// vision 模型 → 多模态 content blocks; 非 vision → 附加"未发图"文字说明 (防幻觉声称看到了图)。
function _adaptImagesForModel(out, m, useModel) {
  return require('../modules/llm_caller')._adaptImagesForModel(out, m, useModel);
}

// 子 agent 链路的消息序列化前置处理: 把 messages 里的 images 字段按模型能力落地。
// 根因 (会话 80922578): 子 agent 的 callLLM 原来把 messages 原样 JSON 序列化, images 字段
// 被上游忽略/拒收 —— 即使把图挂到消息上也到不了模型。这里统一过 _adaptImagesForModel,
// 并抹掉 images 字段; Anthropic 协议再把 OpenAI image_url 块转成 source base64 块。
function _prepareMessagesForModel(messages, modelConfig, useAnthropic) {
  return (Array.isArray(messages) ? messages : []).map(m => {
    if (!m || !Array.isArray(m.images) || m.images.length === 0) return m;
    let out;
    try { out = _adaptImagesForModel({ ...m }, m, modelConfig || {}); }
    catch (_) { out = { ...m }; }
    delete out.images;
    if (useAnthropic && Array.isArray(out.content)) {
      out.content = out.content.map(b => {
        if (b && b.type === 'image_url' && b.image_url && typeof b.image_url.url === 'string') {
          const mm = String(b.image_url.url).match(/^data:([^;]+);base64,([\s\S]*)$/);
          if (mm) return { type: 'image', source: { type: 'base64', media_type: mm[1], data: mm[2] } };
          return { type: 'text', text: '[图片无法内联: 非 base64 来源]' };
        }
        return b;
      });
    }
    return out;
  });
}

// 角色定义：每个子 agent 有专属 system prompt 和可用工具
// 2026-09-18 (老板拍: 装了 skill 调用不了 = 白装): 工具箱意识进将灵 prompt
// skill_use 工具直读 ~/.pangu/skills/ 装机盘 — 任务匹配领域先查再干, 别从零硬做
const _SKILL_AWARE = `
【工具箱意识】主人的 工具箱 (marketplace) 装过的 skill 都在本地盘, 任务涉及 PDF/文档/PPT/Excel/出图/代码套路等领域时:
先调 skill_use 工具 (query 参数查清单, name 参数读全文), 有现成 skill 就照它执行, 没有再自己硬做。`;

// 2026-10-17 (现场 lt2-1792170606432 实测, 三文件分析 102s, 24 次 LLM 调用):
//   **每一轮 tool_calls 都是 1**, 7 次工具跑成 7 轮串行。工具本身只花 1ms,
//   轮与轮之间的模型推理各 2.5~5s —— 时间不是花在干活上, 是花在**轮次**上。
//   同一把刀实测 5 轮才收口, 而其中至少两轮是"先摸一下、再读、再确认"。
//
//   执行层**早就能并行**: j2_agent_loop._j2BatchSize = 5, 一轮里的多个 tool_call
//   走 Promise.all 真并发 (j2_agent_loop.js:2831/2846), 一轮最多 5 个。
//   所以这不是能力问题 —— 是没人告诉模型"你可以一次调多个"。
//   平台默认 parallel_tool_calls=true, 全仓没有任何一处显式关掉它。
//
// 写法上刻意只说"没有依赖就一起发", 不列具体工具: 列工具名等于把工具表
// 再抄一遍进提示词 (那 19 个 schema 已经 6.8k 字符), 而且模型会照着名字
// 硬凑, 把互有依赖的调用也并行发出去。
const _BATCH_AWARE = `
【一轮多发几个工具 — 这条直接决定你有多快】
互不依赖的取证调用, **同一轮里一次全发出来**, 不要一次只发一个。
例: 要"读一个文件并统计行数/看关键函数", 读完、wc、grep 三件事没有先后关系, 就一轮发三个。
每多一轮就多付一次完整推理 (实测 2.5~5s), 工具本身只要 1ms —— 一轮一个是最亏的用法。
但**有依赖的必须分开**: 前一次的结果决定后一次的参数 (例如先列目录才知道读哪个文件), 那种就老实分轮。
收尾(交 task_done / task_summary)之前, 先把这一刀要用的证据一次发齐, 别发一个等一个。`;

// 2026-10-17 (现场 tl-1792193377047, 老板那道「查清楚模型池」题):
//   sub-0-analyzer 为了"输出结构化报告并明确给出该报告的**实际产出文件路径**"
//   跑了 **20 次工具调用 / 14 轮 / 75 秒** —— 而"把配置文件里的模型池列成一张表"
//   真正需要的只有 4 次 (读 models.json / 读 config / 读 registry / 汇总)。
//
//   根因是一个**死结**, 两头都在逼它:
//     ① 任务文本 (planner 写的) 要求"给出产出文件路径" —— planner 读的是主 agent 版
//        全局铁律, 其中 #24「产出 > 报告…核验只认『写了哪个文件 + 路径』」;
//     ② analyzer 是只读角色, 写不了文件 (ROLE_READ_ONLY 由执行层强制拦)。
//   提示词原来只说了「被拒时交给 executor 去写」, **没说"你的交付物就是这条回复本身"** ——
//   于是它既交不了差又不敢直接答, 只能一轮轮换命令去摸文件, 直到撞满轮数上限,
//   最后报"部分交付" → 系统判 partial → 触发自动续跑 (本轮 4 次, 71s~210s)。
//
//   修法: 把这一句**钉进只读角色的系统提示**。不能只写在注释里 ——
//   模型只读得到 system prompt, 注释对它不存在 (「注释 ≠ 隔离」同一族)。
//   共享常量而不是给 4 个角色各抄一遍 (抄四遍迟早只改其中一份)。
const READONLY_DELIVERABLE_NOTE = `
- **你的交付物就是这条回复本身** —— 带工具证据的分析/判断/结论本身就算完成, 不需要写文件。
  哪怕任务文本里写了"输出报告""给出产出文件路径""落盘", 你也**不要**去试着写 (你是只读角色, 写了会被
  ROLE_READ_ONLY 直接拒): 那是坎把主 agent 的「产出 > 报告」铁律误搬到了你身上。
  正确做法 = 取到证据 → 在回复里按四行契约交结论 (①完成 ②证据 ③未做 ④交接), 一次交完。
  **不要为了"交差"去反复摸文件**: 证据够回答就答, 证据不够就在「③未做」里写明缺哪一项。`;

// ============================================================================
// 8 将灵 · 卦象身份 —— **真源搬去了 agents/gua-identity.js** (2026-10-18)
//
// 为什么又搬了一次: 上一版收在本文件里, 但 action_policy 也需要这张表
// (只读角色名单就是"哪几个将灵不许写盘")。action_policy require sub-agent 就是
// 循环依赖 —— Node 里这种环有一半是 undefined, require 顺序一变就炸, 而且炸的时候
// 表现是"守卫静默失效"而不是报错。所以身份表必须是零依赖的叶子模块。
//
// 老板定的规范名 = **拼音, 且只有拼音** (老板原话: 「英文 code 要换成拼音」
// 「不要别名, 越多越乱」)。
// 拼音本来就已经是 config.agent.role_configs 的键, 只有 ROLES 和日志用英文,
// 于是同一个角色有两个"真名"。现在砍到一个。
// 英文只在 resolveRole() 这个**输入解析器**里被读进来 (模型先验), 读完即丢;
// 存/显示/配置/落盘任何地方都只有拼音 —— 没有第二列名字。
//
// 之前这里抄过一份, 和另外 6 处在"乾是谁"上互相矛盾 (synthesizer vs dispatcher):
// 实跑 3289 次 → dispatcher **0 次**, synthesizer **1 次**, 而 synthesizer
// 在后端根本不是注册角色。数据在 gua-identity.js 里, 注释不会漂。
const {GUA_ROLES, GUA_BY_CODE, resolveRole, isReadOnlyRole} = require('./gua-identity');

const ROLES = {
  kan: {
    name: 'kan',
    system: `你是盘古八将灵中的坎（坎 · 拆）。职责：把主人的目标拆解成子任务，并指定将灵。
可用将灵 (拼音即角色名, 派活时原样填这个字符串)：
- li 离（分析/搜索/读文件）
- kun 坤（写文件/运行命令/生成 artifact）
- dui 兑（验证/测试/检查）
- xun 巽（扫描 bug/安全隐患）
- zhen 震（复盘）
- gen 艮（学习记忆）
**只写上面这 6 个拼音。** 写英文名会被判未知角色, 那一轮一刀都不会跑。

**依赖不看你怎么措辞 —— 兑·dui 和乾·qian 按定义就排在全部前置之后。**
(2026-10-18 改: 以前盘古是从 task 文字里扒角色名反推依赖的, 于是你写 li 还是
写离都会改变调度结果。那是盘古的设计缺陷, 已经改成按角色语义排队。)
所以你**不需要**在 task 里写「仅依据上游 li 的汇报结论」这种话来保命 ——
但 depends_on 你还是要填: 它管的是**非验刀之间**的先后 (例如巽扫完坤再动)。

【自查任务固定流程 — 必读】
当主人输入包含"排查/自查/体检/诊断/检查自己"时，**你要自己判断拆几刀、每刀查什么**。
没有固定清单可抄 —— 主人问的是"这个项目有什么问题", 就按这个项目**实际需要查的维度**拆;
他问的是"服务器还活着吗", 就只查活着这件事, 一刀够。

  2026-10-18 (老板原话: «那问题就应该盘古判断几个agent并发, 不是人为控制agent并发»):
  这里原来有一份写死的 5 刀清单 (环境/架构/运行状态/工具清单 + "综合输出: 状态报告"),
  前面四刀全是兑, 且措辞一字不差。后果不是"多派了几个", 是**派出去的全是兑**:
  实机 session 80004976 主人说「做个全面体检」→ 4 个一模一样的兑并发抢本地端点
  → 2 条 ZERO_CONTENT_TIMEOUT_300s (633.2s / 300.0s), 整轮 15 分半, 主人截图问
  «5个将灵, 全是兑, 那意义在哪?» —— 一针见血, 那 5 个就是这份清单照抄出来的。
  **"派几个、派谁"是盘古的判断, 不是人写死在 prompt 里的数字。** 所以这里删掉清单本身。

  但要拆对, 只讲"你自己判断"没用 —— 留下**形状**示范 (不是内容示范):
  互不相关的取证刀**并行**, 最后一把吃所有结论的验收刀**串在后面**, 且必须声明
  depends_on。下面【通用规则】里有一份可直接照抄的形状示例, 那份是活的、该优先照它拆。

  2026-10-17 旧账 (改这块时别踩回去): 原来那份模板里"综合输出"那刀**没写 depends_on**,
  而它明摆着要吃前面四份检查结论 —— 模板自己就在教"汇总刀不用声明依赖"。坎照着
  这个形状抄, 于是**每一次**带兑的拆解都倾向把验收刀当成独立刀并发放出去。
  实测代价 (tl-1792196710892): 验收刀与被验收的刀相隔 17ms 并发, 41 秒就收工
  判 FAIL, 而它要验的离 99 秒后才交付 → 白触发一整轮补救。

【易经纲领 — 老板拍的推理内核】
- 任务文本开头若有【盘古起卦】块：拆任务必须以卦为纲 — 动爻指示事态阶段与攻守 (初爻=蓄势/五爻=鼎盛/上爻=转衰), 子任务围绕"按卦断方向 → 验证 → 执行"组织, 不是随便拆
- 8 角色对应八卦职能 —— **以 GUA_ROLES 那张表为准 (代码里的数据, 不是注释)**:
  乾·qian / 坎·kan / 艮·gen / 震·zhen / 巽·xun / 离·li / 坤·kun / 兑·dui

【通用规则】
- 其他任务正常拆解
- 只输出规划，不执行工具
- 输出必须是 JSON：{"subTasks": [{"agent": "角色", "task": "具体任务描述", "depends_on": [0]}]}
- **depends_on 不是可选项, 是"这一刀吃谁的结论"的声明**。凡是 task 里出现"依据/基于/综合/验收/交叉核对/前述/以上/前N个 + 汇报结论"这类措辞, **必须**声明它依赖谁; 拿不到上游结论它就只能对着空气下裁决。
  判据一句话: **这刀的 task 里如果提到了"上游/前面几刀的结论", 就必须写 depends_on**; 没提到就别写。
  典型形状 (照这个抄): 先并行取证, 最后一把验收刀串在后面
    {"agent":"li","task":"读配置查模型清单"},
    {"agent":"dui","task":"查运行时实际状态"},
    {"agent":"dui","task":"验收：仅依据前两个子任务的汇报结论交叉核对…","depends_on":[0,1]}
  2026-10-17 实测: 上面这个形状连撞四次措辞没被认出来 —— 「仅依据上游离的汇报结论」
  /「仅依据离的汇报结论」/「离与坤的汇报结论」/「前两个子任务的汇报结论」,
  下游正则每次都得补一种新说法才勉强认出 (还漏了口语的"两")。每次漏 = 验收刀与被验收的刀
  并发开审 → 审了个空 → 判 FAIL → 白触发补救循环重推同一张表, 现场一次 200 秒。
  **你在源头写对了 depends_on, 这 200 秒就不会发生** —— 下游推断只是兜底, 不是让你替它擦屁股。
  别把"互不相关"的刀也串起来 (那会把并发清零), 只串真正吃上游结论的那几刀。
- 子任务数量不超过 5 个
- 每个子任务必须明确、可执行
- 若子任务的上游会产出文件, 下游任务描述里直接引用上游的产出文件路径, 并声明 depends_on — 让下游按路径按需读, 不要让它"重新分析上游读过的文件"
- **上游只是"读文件得结论"时, 下游(综合/验收/复盘)严禁把上游读过的源文件再读一遍** — 只许读上游的汇报结论 (①完成 ②证据 ③未做 ④交接 四行)。2026-10-16 现场 (lt-p2-220303, 云端 minimax-m3.1-flash): 主人点三个文件各要一份分析, 你拆成 3×离 + 1×兑「综合复核三个独立报告**及三个源码文件**」, 兑真去把三个文件各重读了 4 遍 —— 12 次读取里 9 次是重复劳动, 烧掉 102s = 全程 250.6s 的 41%, 最后还因为"清单没走完"报 partial/失败。盘古的分工是**一个文件一个刀**, 读过就是读过了, 兄弟的汇报就是证据。
  唯一例外: 主人的逐字规格必须字节级核对, 或上游汇报里"未做/存疑"非"无" —— 这两种情况才准重读, 且只准重读被点名的那一个文件, 不许顺手扩到兄弟的文件。
- **排了兑就必须让它下裁决, 不许只让它"汇总"** —— 验收刀的 task 里要写明"最后单独一行给出 **验收结论: PASS** 或 **验收结论: FAIL**, 并附一句依据"。只汇总不裁决 = 没验收。2026-10-16 现场 (lt-after-221727): 兑被上面那条"只读汇报"带成了纯总结, 通篇没有一句 PASS/FAIL, 收口判成 unknown → 整轮仍报 partial。少写这一句, 主人就还是看到"跑了两分半钟, 失败了"。
- **主人给了逐字规格 (正文/数值/文件名/命令/表格) 时, 必须把该规格原文抄进对应子任务的 task 里**, 不许只写"按主人给的内容""按原文"这类转述。2026-10-13 实案 (soak-live-1791878006): 转述派下去, 坤手上没有原文, 8 份文件全写成"文件名当内容"的占位串还逐项报核对通过, 兑没原文可比却报"8/8 字节级核验一致"。
- 预估耗时 > 30 分钟或跨多文件的长任务, 必须拆成 ≥2 个子任务 (每个子任务 ≤ 单轮可完成), 不许一个子任务吞整个长任务 (拆了才落盘成 plan 状态机驱动验收 + 断点续跑)
- **只读角色 (li 离 / dui 兑 / xun 巽 / zhen 震) 的子任务不许要求写盘** —— 不许出现"落盘""产出文件路径""输出报告文件""写入 X.md"这类要求。它们写不了 (执行层 ROLE_READ_ONLY 强制拦, 你读的主 agent 铁律 #24「产出 > 报告」不适用于它们), 而它们的交付物**就是那条带证据的回复**。
  2026-10-17 实案 (tl-1792193377047): 你把"查清模型池"拆给离的 task 里写了"输出结构化报告, 并明确给出该报告的**实际产出文件路径**", 离为了凑这个路径跑了 **20 次工具调用 / 14 轮 / 75 秒** (真正需要的只有 4 次), 最后报"部分交付"又触发 4 次自动续跑, 全程 293 秒。
  **要写盘的刀派给坤**, 并在离那刀的 task 里写明"结论直接写在回复里, 不要写文件"。`,
    tools: []
  },
  li: {
    name: 'li',
    system: `你是盘古八将灵中的离（离 · 读）。职责：分析需求、读取文件、搜索代码、研判局势。
规则：
- 只分析，不执行写/改操作 (exec_command 只许只读命令: ls/find/cat/head/grep/wc/curl -s; 禁止写盘/安装/删除)
  **这条现在由执行层强制, 不是靠自觉**: 只读角色跑写命令会被直接拒 (ROLE_READ_ONLY), 不弹审批也没有例外。
  被拒时不要换个写法再试 —— 把"要写什么、依据是什么"讲清楚, 交给坤去写, 你只负责分析和举证。
- 每次回复必须调用至少一个工具收集证据
- 工具调用格式：<tool name="工具名">{"参数":"值"}</tool>
- 基于真实数据得出结论，不凭空编造
- **八字排盘必须调 bazi_calc, 绝不凭记忆排**: 主人给出生年月日时(或有命盘要核对)时, 先调 bazi_calc 拿 sxtwl 万年历的真实四柱/大运/流年, 再基于返回结果分析。历史事故: 白名单漏了 bazi_calc, 排盘题路由到将灵后无工具可用, 模型直接把整张盘编出来(甲午/乙未/丁丑/庚子 + 壬申癸酉大运), 全是假的。
- **股票代码绝不凭记忆猜**: 主人只给公司名(如 内蒙新华)时, 必须先调 stock_resolve 拿真实代码, 再用 stock_quote / stock_history。历史事故: 内蒙新华=603230, 模型先后猜成 600295(鄂尔多斯) / 600311, 然后拿错票的数据当目标票汇报。
- **64 卦资料必须调 hexagram_lookup 取 64i 真源, 绝不凭记忆、绝不搜网**: 问"第N卦是哪一卦 / 某卦卦辞爻辞 / 卦序编号 / 上下卦 / 纳甲八宫" → 第一个动作就是调 hexagram_lookup (本地真源, 一次调用就够), 不许 web_search, 也不许 exec_command 去 grep 源文件。
  历史事故 (2026-10-21 实跑, 主人问"帮我看看第24卦"): 白名单里没有 hexagram_lookup, 模型够不着真源 → 去 web_search、想用 python 列表核对卦序 (被只读守卫拦)、web_fetch 又 404, 最后一字不差地写出**错的**卦序: "第24卦: 贲卦"。64i 真值是 **24=复、贲=22**, 而它自己在证据说明里写了"卦序 24=贲 为记忆结论, 未获机器校验"。**工具够不着 = 卦序全靠记忆 = 必错。**
  基数记住: 对主人说话用**卦序 1..64** (文王卦序 乾=1 坤=2 屯=3 蒙=4 … 既济=63 未济=64)。本工具**不收** 0 基二进制索引 (乾=63 坤=0 那套), 传进去会明确报错, 不是悄悄返回另一卦。
- **判断题走 wuxing_judge, 不许自己编一套**: 主人问「这个项目该继续还是该停 / 优先级怎么排 / 卡在哪 / 值不值得投」这类**判断题** → 第一个动作调 wuxing_judge, 把手上的东西列进去 (助力/已产出/阻力/要啃的/平级), 照它给的六格分档和停点结论答。
  这套「生彼泻克耗」内核原来只有 bazi_calc 排完盘顺带能算, 跟项目无关; wuxing_judge 是它对「一件事」出判断的唯一入口。**你只列条目, 判据由内核算 —— 不许自己下结论。** 条目要具体 (「缺 X 权限」算,「资源不足」不算)。
- **长任务里走一步判断一步, 别攒到最后才判** (2026-10-22): 派给你的活要很多轮才干完时, 每做完一段就调一次 wuxing_judge 判六格 —— 这不是多此一举, 盘古的自动续跑闸门**接的就是这个判局**: 你判「停」, 它就不会替你往下冲, 而是带着停点收口交回给主人 (主人说「继续」照样能接着跑); 判「换向」就先解阻力别再堆料; 判「续」就接着走, 下一步再判一次。
  **判「停」是有代价的选择**: 真没料、也没得啃了才停; 有料就如实列出来判「续」。把条目列空来骗一个「停」= 自己给自己下路障, 主人还得再推你一把 —— 那比不停更糟。
- **如果任务涉及"将灵数量 / 将灵分工 / 将灵能力"，优先调用 list_pangu_agents 工具获取权威清单，不要读 registry.js / agents.json / agents.yaml 文件去猜。**`,
    tools: ['read_file', 'file_grep', 'search_files', 'system_info', 'process_list', 'network_check', 'list_directory', 'exec_command', 'web_search', 'web_fetch', 'github_api', 'currency_check', 'crypto_price', 'stock_resolve', 'stock_quote', 'stock_history', 'bazi_calc', 'hexagram_lookup', 'wuxing_judge', 'list_pangu_agents']
  },
  kun: {
    name: 'kun',
    system: `你是盘古八将灵中的坤（坤 · 做）。职责：写文件、改文件、运行命令、生成 artifact。
规则：
- 只执行，不分析、不验证
- 每次回复必须调用至少一个工具
- 工具调用格式：<tool name="工具名">{"参数":"值"}</tool>
- 完成工具调用后，基于工具结果给出简洁总结
- **严禁只说不做：如果用户要求创建/修改/删除文件或运行命令，你必须直接调用工具执行，不能先输出“我这就去做”之类的空话。**
- **如果任务涉及"将灵数量 / 将灵分工 / 将灵能力"，优先调用 list_pangu_agents 工具获取权威清单，不要读文件去猜。**
- **八字排盘必须调 bazi_calc, 绝不凭记忆排**: 主人给出生年月日时(或有命盘要核对)时, 先调 bazi_calc 拿 sxtwl 万年历的真实四柱/大运/流年, 再基于返回结果分析。历史事故: 白名单漏了 bazi_calc, 排盘题路由到将灵后无工具可用, 模型直接把整张盘编出来(甲午/乙未/丁丑/庚子 + 壬申癸酉大运), 全是假的。`,
    tools: ['exec_command', 'write_file', 'file_edit', 'read_file', 'list_directory', 'archive_create', 'batch_execute', 'get_lan_ip', 'set_env_path', 'run_installer', 'clipboard_read', 'clipboard_write', 'code_execute', 'bazi_calc', 'hexagram_lookup', 'list_pangu_agents', 'system_info']  // 2026-10-13: code_execute 挪到写盘工具之后, 批量写文件任务模型不再被顺序带偏
  },
  dui: {
    name: 'dui',
    system: `你是盘古八将灵中的兑（兑 · 验）。职责：验证结果、检查安全、跑测试。
规则：
- 只验证，不改代码
- 每次回复必须调用至少一个工具验证
- **汇报的最后必须单独一行给裁决, 格式就是「验收结论: PASS」或「验收结论: FAIL」**, 后面跟一句依据。2026-10-16 现场 (lt-after-221727): 你只交了一份漂亮的三文件汇总, 通篇没有一句 PASS/FAIL, 收口判成"没给出结论 (unknown)" → 主人看到的是"跑了两分半钟, 失败了"。汇总写得再好, 没下裁决就等于没验收。
- **验收兄弟的活时, 默认不许重读兄弟读过的源文件** —— 证据是兄弟的汇报 (①完成 ②证据 ③未做 ④交接), 你的活是"挑这份汇报的毛病", 不是"把人家的活重做一遍"。2026-10-16 现场 (lt-p2-220303): 3 个离各读完一个文件并交汇报, 兑的验收却把三个文件各重读了 4 遍, 102s = 全程 41%, 最后还反手报 partial。只有两种情况准重读: ① 主人的逐字规格要字节级核对 ② 某份汇报的"未做/存疑"不是"无" —— 且只准重读被点名的那一个文件。
- 工具调用格式：<tool name="工具名">{"参数":"值"}</tool>
- 最后给出明确的 pass/fail 结论和证据
- **手上没有主人给的原文/规格时, 不许判 pass** —— 如实说"缺少原文, 无法逐字核对", 并把缺的原文列出来。2026-10-13 实案: 兑手上只有"与主人给定的原始内容比对"这句话、原文没传下来, 却报 "**PASS — 8/8 完全一致, 字节级核验 (xxd 全文 hexdump)**" —— 比对对象根本不存在, 这种 PASS 是纯编的。
- 核对表里每一行都要有**这一行自己的**证据 (读到的实际内容 + 与规格的差异点); 没读到内容的行一律 fail, 不许打 ✅
- **八字排盘必须调 bazi_calc, 绝不凭记忆排**: 主人给出生年月日时(或有命盘要核对)时, 先调 bazi_calc 拿 sxtwl 万年历的真实四柱/大运/流年, 再基于返回结果分析。历史事故: 白名单漏了 bazi_calc, 排盘题路由到将灵后无工具可用, 模型直接把整张盘编出来(甲午/乙未/丁丑/庚子 + 壬申癸酉大运), 全是假的。
- **股票代码绝不凭记忆猜**: 主人只给公司名(如 内蒙新华)时, 必须先调 stock_resolve 拿真实代码, 再用 stock_quote / stock_history。历史事故: 内蒙新华=603230, 模型先后猜成 600295(鄂尔多斯) / 600311, 然后拿错票的数据当目标票汇报。
- **如果任务涉及"将灵数量 / 将灵分工 / 将灵能力"，优先调用 list_pangu_agents 工具获取权威清单，不要读文件去猜。**`,
    tools: ['read_file', 'file_grep', 'search_files', 'exec_command', 'system_info', 'process_list', 'network_check', 'http_check', 'weather_check', 'news_digest', 'currency_check', 'crypto_price', 'stock_resolve', 'stock_quote', 'stock_history', 'bazi_calc', 'hexagram_lookup', 'list_pangu_agents']
  },
  xun: {
    name: 'xun',
    system: `你是盘古八将灵中的巽（巽 · 找雷）。职责：扫描代码、找 bug、找安全隐患。
规则：
- 只找 bug，不修复
- 每次回复必须调用至少一个工具扫描
- 工具调用格式：<tool name="工具名">{"参数":"值"}</tool>
- 列出每个问题的位置、严重度、建议修复方向`,
    tools: ['search_files', 'file_grep', 'file_find', 'read_file', 'system_info', 'process_list', 'list_directory', 'exec_command', 'hexagram_lookup', 'wuxing_judge']
  },
  gen: {
    name: 'gen',
    system: `你是盘古八将灵中的艮（艮 · 记）。职责：从任务结果中提取经验，写入记忆。
规则：
- 可以调用 memory 工具
- 工具调用格式：<tool name="工具名">{"参数":"值"}</tool>
- 总结学到的模式和经验`,
    tools: ['memory_write', 'memory_read', 'memory_search', 'cache_get', 'cache_put', 'cache_preheat', 'cache_evict', 'cache_stats']
  },
  zhen: {
    name: 'zhen',
    system: `你是盘古八将灵中的震（震 · 复盘）。职责：复盘任务过程、提炼经验教训、指出改进点。
规则：
- 可以调用 memory 工具读取历史经验
- 工具调用格式：<tool name="工具名">{"参数":"值"}</tool>
- 输出结构：1. 做得好 2. 做得差 3. 改进点`,
    tools: ['memory_read', 'memory_search', 'cache_get', 'cache_stats']
  },
  qian: {
    name: 'qian',
    system: `你是盘古八将灵中的乾（乾 · 调度）。职责：协调多个将灵完成复杂任务。
规则：
- 先规划，再分派
- 输出 JSON：{"subTasks": [{"agent": "角色", "task": "具体任务"}]}
- 不直接执行工具`,
    tools: []
  }
};

// 2026-10-18 (身份统一): ROLES 里的 name 原本是英文 (Planner/Analyzer/Executor/...),
// 而 name 不是装饰 —— 它直接进子 agent 的提示词 (sub-agent.js:1506
// 「你作为 ${role.name} 必须调用工具...」)。于是 8 个将灵互相传话时用的还是
// 上一代的英文名, 而运行时索引全是拼音: **同一个角色, 提示词里叫 Executor、
// 账本里记 kun**。这就是「8 个是什么」在五个地方给五个答案的又一处来源。
//
// 字面量已改成拼音 (守卫读源码, 光在运行时覆写它照样转红), 这里再从身份真源
// 取中文名覆写。取不到就保留拼音 —— 宁可显示 kun, 也不显示一个运行时根本不认的名字。
for (const _code of Object.keys(ROLES)) {
  const _g = GUA_BY_CODE[_code];
  if (_g && _g.zh) ROLES[_code].name = _g.zh;
}

// 2026-10-17: 把「交付物就是这条回复本身」追加到**每个**只读角色的 system prompt。
// 角色清单直接取 gua-identity.READ_ONLY_CODES —— 那是执行层真正拦权的那个集合 (唯一真源)。
// 在这里手写 ['li','dui','xun','zhen'] 的话, 将来加一个只读角色就会漏掉它,
// 于是那个角色重演现场这 20 次工具调用 / 14 轮的老剧本。

try {
  const _roRoles = require('./gua-identity').READ_ONLY_CODES;
  for (const _ro of _roRoles) {
    const _role = ROLES[_ro];
    if (!_role || typeof _role.system !== 'string') continue;
    // 幂等: 已经拼过就跳过, 避免重复 require 时叠加两遍
    if (_role.system.includes('你的交付物就是这条回复本身')) continue;
    _role.system += READONLY_DELIVERABLE_NOTE;
  }
} catch (_) {
  // 取不到只读角色清单就不追加 —— 静默退回旧行为, 不能因此把整个模块加载搞崩
}

function loadConfig(configPath) {
  try {
    return JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch (e) {
    console.error('[sub-agent] config load failed:', e.message);
    return null;
  }
}

function getEnabledModel(cfg) {
  if (!cfg || !cfg.llm || !Array.isArray(cfg.llm.models)) return null;
  const enabled = cfg.llm.models.filter(m => m.enabled !== false);
  if (enabled.length === 0) return null;
  // M12 fix: model.default 字段已废弃 (pangu_helpers 单一真源 = llm.current_model_id)
  const id = cfg.llm.current_model_id;
  if (id) {
    const cur = enabled.find(m => m.id === id);
    if (cur) return cur;
  }
  // 兜底: enabled 中 priority 最高者
  return enabled.sort((a, b) => (b.priority || 0) - (a.priority || 0))[0];
}

function getModelContextLength(model) {
  if (!model) return 4096;
  if (model.context_length) return model.context_length;
  if (model.contextLength) return model.contextLength;
  if (model.max_context_length) return model.max_context_length;
  return 4096;
}

function estimateTokens(messages) {
  if (!Array.isArray(messages)) return 0;
  let chars = 0;
  for (const m of messages) {
    const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
    chars += content.length + 20;
  }
  return Math.ceil(chars * 0.35);
}

// 2026-10-13 (现场: 子 agent 接上原生工具后, 截断切出来的是「孤儿 tool result」——
// 父 assistant.tool_calls 被切掉, 只剩 role:'tool' 悬在消息里) → 上游 400
// "tool result's tool id not found" → 子 agent 整个死, 长任务当场腰斩。
// session_compaction 2026-09-12 就在防同一件事 (压缩产物过 _sanitizeToolPairing),
// 子 agent 这条链漏了 —— 现在统一走 modules/tool_pairing.js 唯一真源。
function _sanitizePairs(list) {
  try { return require('../modules/tool_pairing').sanitizeToolPairing(list).messages; }
  catch (_) { return Array.isArray(list) ? list : []; }
}

function truncateMessages(messages, contextLength, reservedOutputTokens = 2048) {
  const list = Array.isArray(messages) ? messages : [];
  const available = Math.max(1024, contextLength - reservedOutputTokens);
  if (estimateTokens(list) <= available) return _sanitizePairs(list);
  const system = list.filter(m => m.role === 'system');
  const rest = list.filter(m => m.role !== 'system');
  let keep = Math.max(2, rest.length);
  while (keep > 2) {
    const candidate = _sanitizePairs([...system, ...rest.slice(-keep)]);
    if (estimateTokens(candidate) <= available) return candidate;
    keep--;
  }
  // 预算连尾巴都装不下 (常见: 角色 prompt + 工具说明本身就超 available, 例如模型配置
  // 没带 context_length 而默认 4096)。这时宁可选「协议合法 + 保住工具证据」的尾巴:
  // 软估超一点上游通常照收, 而证据没了子 agent 会以为工具从没跑过 → 重复调用 /
  // 凭空总结 —— 那才是「长工作做不完 / 子 agent 一直有问题」的真凶。
  const withEvidence = _sanitizePairs([...system, ...rest.slice(-3)]);
  if (withEvidence.length > system.length) {
    console.warn('[sub-agent] \u4e0a\u4e0b\u6587\u9884\u7b97\u88c5\u4e0d\u4e0b\u5de5\u5177\u7ed3\u679c (' + estimateTokens(withEvidence)
      + '>' + available + '), \u4fdd\u5de5\u5177\u8bc1\u636e\u4f18\u5148');
    return withEvidence;
  }
  return _sanitizePairs([...system, ...rest.slice(-2)]);
}

function buildToolPrompt(allowedTools) {
  if (!allowedTools || allowedTools.length === 0) return '';
  const schema = _toolsSchema();
  let s = '\n\n[可用工具]\n';
  for (const name of allowedTools) {
    const tool = schema[name];
    if (!tool || !tool.function) continue;
    s += `\n工具名: ${tool.function.name}\n描述: ${tool.function.description}\n参数: ${JSON.stringify(tool.function.parameters)}\n`;
  }
  s += '\n调用格式：<tool name="工具名">{"参数名":"值"}</tool>\n';
  s += '\n注意：参数必须是合法 JSON。\n';
  s += '\n重要：执行完工具后，必须基于工具返回结果给出一段最终总结文字（不要只写\"工具已执行\"）。如果工具结果为空或失败，也要说明情况。\n';
  s += '总结 ≤ 200 字硬约束：只写"做成了什么/哪步失败+ERROR原文一句"，禁止过程叙述（"让我先/我现在"）、禁止自我检讨长段、禁止重复任务描述。\n';
  return s;
}

// 2026-10-13 现场 (resume-live-1791876482, 子 agent 诚实回答「当前会话没有可调用的工具」):
//   [sub-agent-tools] minimax_m3.1-flash-preview role whitelist=18 [read_file, file_grep, ...]
//   [agent-llm] ... tools: 0 msgs: 10
// 白名单算出来了、日志也打了, 但**请求体里一个工具都没带** —— callLLM 只在 260/262 行
// 提到过 allowedTools, 从来没写进 body。子 agent 于是只能靠 buildToolPrompt 的文本协议
// 让模型手写 <tool> 标记; 而 MiniMax 这类模型 j2-detect 已探到 probeOk=true (原生支持),
// 让它手写标记既慢又不可靠 —— 于是「子 agent 调用一直有问题」。
//
// 修法: 按角色白名单把 TOOLS_SCHEMA 翻译成原生 tools 挂进请求, 并解析响应里的原生
// tool_calls 喂进既有的执行循环。模型不吐原生调用时**原样走旧的文本协议**, 零回归。
function _nativeTools(allowedTools) {
  let schema = null;
  try { schema = _toolsSchema(); } catch (_) { return []; }
  if (!schema || typeof schema !== 'object') return [];
  // 注意语义: [] = **明确不给工具** (总结轮只读轮就是这么调的), null/undefined = 全部。
  // 写成 `(allowedTools.length)` 会把 [] 判成「全部」, 总结轮突然又能调工具了。
  const allow = Array.isArray(allowedTools) ? new Set(allowedTools) : null;
  const out = [];
  for (const name of Object.keys(schema)) {
    if (allow && !allow.has(name)) continue;
    const entry = schema[name];
    if (!entry) continue;
    // TOOLS_SCHEMA 已经是 OpenAI 形态 {type:'function', function:{name, description, parameters}}
    if (entry.type === 'function' && entry.function && entry.function.name) {
      out.push({ type: 'function', function: {
        name: entry.function.name,
        description: String(entry.function.description || ''),
        parameters: entry.function.parameters || { type: 'object', properties: {} },
      }});
      continue;
    }
    // 兜底: 裸 {description, parameters} 形态
    out.push({ type: 'function', function: {
      name,
      description: String(entry.description || entry.desc || ''),
      parameters: entry.parameters || entry.input_schema || { type: 'object', properties: {} },
    }});
  }
  return out;
}

// 2026-10-13: assistant 的空 content + tool_calls 会被上游拒收 —— modules/llm_caller.js
// 的 R26b 早实测过 minimax 报 400 'tool call and result not match (2013)'。子 agent 以前只走
// 文本协议, 从来没发过这种形状; 接上原生工具后**第一轮必然出现**(模型只吐 tool_calls 时
// content 就是空的)。沿用同一句占位约定, 不自己发明。
function _fixAssistantToolMessages(messages) {
  return (Array.isArray(messages) ? messages : []).map(m => {
    if (!m || m.role !== 'assistant') return m;
    const calls = Array.isArray(m.tool_calls)
      ? m.tool_calls.filter(tc => tc && tc.function && tc.function.name) : [];
    if (calls.length === 0) {
      if (!Array.isArray(m.tool_calls)) return m;
      const out = { ...m };
      delete out.tool_calls;   // 空数组 tool_calls 多数上游也拒 (llm_caller 同款处理)
      return out;
    }
    if (typeof m.content === 'string' && m.content) return m;
    return { ...m, content: '(调用工具: ' + calls.map(tc => tc.function.name).join(', ') + ')' };
  });
}

// 响应里的原生 tool_calls → 执行循环认识的 {name, args, id} 形态
function _nativeCallsFrom(result, useAnthropic) {
  const calls = [];
  if (!result) return calls;
  if (useAnthropic) {
    for (const c of (result.content || [])) {
      if (c && c.type === 'tool_use') calls.push({ name: c.name, args: c.input || {}, id: c.id || null });
    }
    return calls;
  }
  const msg = (result.choices && result.choices[0] && result.choices[0].message) || null;
  for (const tc of (msg && msg.tool_calls) || []) {
    const fn = tc && tc.function;
    if (!fn || !fn.name) continue;
    let args = {};
    try { args = fn.arguments ? JSON.parse(fn.arguments) : {}; } catch (_) { args = {}; }
    calls.push({ name: fn.name, args, id: tc.id || null });
  }
  return calls;
}

// 2026-10-16 (老板: "调用有没有用工具, 完全不知道, 跟死了一样"):
// 旧码是**非流式阻塞** —— http.request 攒完整个响应才 resolve。代价有两层:
//   ① 观感: 模型在思考/生成的那几分钟里, 主人只看到 heartbeat, 分不清"在干活"和"卡死"
//   ② 实害: req.setTimeout 是**空闲超时**(每收到一块就重置), 但不流式时中间没有任何
//      数据回来 —— 本地 27B 思考 300 秒不吐一个字, 于是必被墙砍掉。这就是
//      "Planner failed: LLM timeout" 的机制层原因。
// 流式同时解掉两层: 空闲超时被 token 流不断重置, 而且每一步都有活可报。
//
// llmOpts: { onTick(evt), mode, stream=true }
//   onTick 收到活性事件 (sub_first_byte / sub_thinking / sub_progress),
//   形如 {stage, ms, content_chars, thinking_chars, tools} —— 上层原样转成 SSE 给前端。
//   刻意只做"活性计", 不在这里装配响应: 装配一律走 llm_caller._parseSSEBody
//   (唯一真源, 已加固不完整 data 行 / 未闭合 tool 块 / 上游 error 事件)。
//   两套装配逻辑迟早分叉, 分叉出来的那个就是静默返回空的那种。
async function callLLM(messages, modelConfig, allowedTools, llmOpts = {}) {
  if (!modelConfig) throw new Error('No model available');
  const _onTick = typeof llmOpts.onTick === 'function' ? llmOpts.onTick : null;
  const _wantStream = llmOpts.stream !== false;
  // 归一成拼音 (2026-10-18): _modeLabel 同时是**活性事件里的 agent 字段**、
  // 日志标签和熔断提示里的角色名 —— 前端拿它去对将灵卡片, 英文名查不到就空一格。
  // run() 入口已经归一过, 这里再收一次是因为 callLLM 有直接调用方 (绕开 run),
  // 那个入口没有归一 —— 漏一次就够在界面上留一个空卡片。
  const _modeLabel = (() => {
    const raw = String(llmOpts.mode || modelConfig.id || 'agent');
    return resolveRole(raw) || raw;
  })();
  // 2026-09-14 修 (分派接通实案: planner 死于 minimax "login fail 1004"):
  // ① api_key 直读 config 字段 — 前端不持久化 key 的模型拿不到, 统一走共享解析链 (config > credentials > 环境变量)
  // ② baseUrl.includes('minimaxi') → isAnthropic 是错的: MiniMax 是 OpenAI 兼容,
  //    被误判后发 x-api-key 头(无 Authorization) + Anthropic 身体 → 1004, planner 永远失败 → 永远 fallback → 将灵 0 次上场
  let apiKey = '';
  try { apiKey = require('../modules/api_key_resolver').resolveApiKey(modelConfig) || ''; } catch (_) { apiKey = modelConfig.api_key || ''; }
  const baseUrl = normalizeEndpoint(endpointOf(modelConfig), normalizeProtocol(modelConfig));
  const useAnthropic = isAnthropic(modelConfig);

  // 2026-09-16 老板拍: 子 agent 按职能配工具 — allowedTools (role.tools) 是硬约束, 打日志可观测
  if (Array.isArray(allowedTools) && allowedTools.length > 0) {
    console.log('[sub-agent-tools] ' + (modelConfig.id || '?') + ' role whitelist=' + allowedTools.length + ' [' + allowedTools.slice(0, 6).join(', ') + (allowedTools.length > 6 ? ', ...' : '') + ']');
  }
  messages = truncateMessages(messages, getModelContextLength(modelConfig), 2048);
  // 2026-10-12 (会话 80922578 根修): images 字段必须先按模型能力落地成协议块/文字说明,
  // 否则原样序列化 = 图根本发不出去 (旧行为: 子 agent 永远拿不到图)。
  messages = _prepareMessagesForModel(messages, modelConfig, useAnthropic);
  const inputTokens = estimateTokens(messages);
  const ctxLen = getModelContextLength(modelConfig);
  let maxTokens = Math.min(outputTokenCap(modelConfig), Math.max(1024, ctxLen - inputTokens));
  maxTokens = Math.min(maxTokens, Math.floor(ctxLen / 2));

  // 2026-10-15: 子 agent 走自己的 callLLM (不走 llm_caller), 所以主链路那条
  // [prompt-profile] 量不到它 —— 实测子 agent 的 inputTokens 均值 1.2 万、最大 3.96 万,
  // 比主 agent 还大, 而今天有 83/130 次子 agent 调用跑在**本地**模型上
  // (本地 27B prefill ~285 tok/s, 3 万 token ≈ 105s)。
  // 超过 12k 才打, 避免刷屏。跟主链路同一个口径: 每条占多少 + 内容开头 28 字。
  if (inputTokens > 12000) {
    try {
      const _parts = messages.map((m, i) => {
        const _c = typeof m.content === 'string' ? m.content : JSON.stringify(m.content || '');
        return i + ':' + (m.role || '?') + '=' + Math.ceil((_c.length + 20) * 0.35) + ' ' + _c.replace(/\s+/g, ' ').slice(0, 28);
      });
      console.log('[sub-prompt-profile] ' + (modelConfig.id || '?') + ' total=' + inputTokens + ' | ' + _parts.join('\n'));
    } catch (_) { /* 纯诊断, 挂了不能影响发请求 */ }
  }

  // 2026-10-17 时间账: 子 agent 走**自己**的 callLLM (不走 llm_caller), 所以主链路那条
  // [llm-cost] 埋点量不到它 —— 而长任务里 3 个 analyzer 并行那 270~300s 恰恰全在子 agent 上。
  // 不在这儿补一个结算, 子 agent 的秒数就永远是账上最大的一个黑洞。
  // 口径跟主链路一致: 耗时 + 角色 + 模型 + 工具数 + 输入 token。
  const _perfT0 = Date.now();
  const _perfTag = String(llmOpts.perfTag || ('sub-raw:' + _modeLabel)).slice(0, 40);
  const _perfDone = (kind, extra) => {
    try {
      console.log('[llm-cost] ' + (Date.now() - _perfT0) + 'ms ' + _perfTag + ' ' + kind
        + ' model=' + (modelConfig.id || '?') + ' tools=' + (allowedTools ? allowedTools.length : 0)
        + ' in=' + inputTokens + (extra ? ' ' + extra : ''));
    } catch (_) { /* 结算日志挂了也不能影响主流程 */ }
  };
  return new Promise((resolve, reject) => {
    const url = new URL(baseUrl);
    let body, headers = authHeaders(modelConfig, apiKey);
    // `id` is Pangu's internal key. Providers need their canonical model name
    // (for example MiniMax-M3.1-Flash-Preview), which is stored as api_model
    // or name. Sending the internal underscored key makes Planner fail with
    // "unknown model" before any sub-agent can be spawned.
    // Keep the legacy expression readable for older integrations/tests, then
    // honor the explicit model_name alias used by some proxy configs.
    const apiModel = modelConfig.api_model || modelConfig.name || modelConfig.id;
    const providerModel = modelConfig.model_name || apiModel || canonicalModelName(modelConfig);

    // 2026-10-13: 按角色白名单把工具挂进请求 (原来只打日志, 从不发) —— 见 _nativeTools 注释
    //
    // 只在 OpenAI 兼容路径发: Anthropic 分支把 messages 压成 {role, content} (见下), 根本
    // 带不走 tool_calls / tool_result 块, 发了就是「宣告支持原生工具但发不出合法形状」。
    // 那条路上原生工具保持关闭, 文本协议照旧 (现有 7 个模型全是 protocol=openai, 这是防呆)。
    const _native = useAnthropic ? [] : _nativeTools(allowedTools);
    if (_native.length) {
      console.log('[sub-agent-tools] → 发给上游 ' + _native.length + ' 个原生工具 (白名单=' +
        (Array.isArray(allowedTools) ? allowedTools.length : '全部') + ')');
    }
    if (useAnthropic) {
      const mergedSystem = messages.filter(m => m.role === 'system').map(m => m.content).join('\n\n---\n\n');
      const userMessages = messages.filter(m => m.role !== 'system');
      body = JSON.stringify({
        model: providerModel,
        max_tokens: maxTokens,
        system: mergedSystem || undefined,
        messages: userMessages.map(m => ({ role: m.role, content: m.content })),
        // 没开原生工具 (见上面 useAnthropic 那段) 时连 tools 字段都别带 —— 发一个空数组
        // 等于告诉上游"支持工具但一个都没有", 白白多一条被拒的分支
        tools: _native.length ? _native.map(t => ({
          name: t.function.name,
          description: t.function.description,
          input_schema: t.function.parameters,
        })) : undefined
      });
    } else {
      body = JSON.stringify({
        model: providerModel,
        max_tokens: maxTokens,
        messages: _fixAssistantToolMessages(messages),
        tools: _native.length ? _native : undefined,
        tool_choice: _native.length ? 'auto' : undefined
      });
      // 2026-10-16: 开流式 (Anthropic 分支不开 —— 它的 SSE 事件格式是另一套,
      // 这里只处理 OpenAI 兼容的 data: 行, 硬套会装配不出来)。
      // include_usage 拿真实 usage, 没有它 token 账本只能估算。
      if (_wantStream) {
        const _p = JSON.parse(body);
        _p.stream = true;
        _p.stream_options = { include_usage: true };
        body = JSON.stringify(_p);
      }
      // Preserve the request-level reasoning choice for planner calls too.
      // LM Studio/Qwen names the disabled mode `none`, while Pangu's UI uses `off`.
      const _provider = String(modelConfig.provider || '').toLowerCase();
      const _endpoint = String(modelConfig.endpoint || modelConfig.api_base || '').toLowerCase();
      const _isLocal = ['lmstudio', 'ollama', 'vllm', 'llamacpp'].includes(_provider)
        || /^https?:\/\/(localhost|127\.0\.0\.1|0\.0\.0\.0)(:\d+)?(?:\/|$)/.test(_endpoint);
      const _effort = modelConfig.reasoning_effort === 'off' && _isLocal ? 'none' : modelConfig.reasoning_effort;
      if (_effort && (_effort !== 'off' || _isLocal)) {
        const _payload = JSON.parse(body);
        _payload.reasoning_effort = _effort;
        body = JSON.stringify(_payload);
      }
    }

    const _path = (() => {
      const p = url.pathname + url.search;
      if (useAnthropic) return p;
      if (p.includes('/chat/completions') || p.includes('/completions')) return p;
      return (p.endsWith('/') ? p.slice(0, -1) : p) + '/chat/completions';
    })();

    // 上游不认 stream / stream_options 时按非流式重试**一次**。
    // 只一次: 4xx 是"请求形状不被接受", 再发一遍同样的东西只是白烧一轮。
    let _retriedPlain = false;
    const _tick = (stage, extra) => {
      if (!_onTick) return;
      try { _onTick(Object.assign({ stage, agent: _modeLabel }, extra || {})); } catch (_) {}
    };

    const _send = (streamOn) => new Promise((resolve, reject) => {
      let payloadBody = body;
      if (!streamOn) {
        try {
          const p = JSON.parse(body);
          if (p.stream !== undefined) delete p.stream;
          if (p.stream_options !== undefined) delete p.stream_options;
          payloadBody = JSON.stringify(p);
        } catch (_) { /* 原样发, 交给下面报错 */ }
      }
      const headers2 = Object.assign({}, headers);
      // 2026-10-14: 不带 Content-Length → Node 走 chunked, mlx-serve 读到空 body 报 400 invalid JSON
      headers2['Content-Length'] = Buffer.byteLength(payloadBody);
      const options = {
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: _path,
        method: 'POST',
        headers: headers2,
        // 2026-08-02: 本地模型 (lmstudio 35B) 首 token 慢, 60s 必超时;
        // 2026-10-14: 旧判定 provider==='lmstudio' 漏判本地 mlx-serve(custom+127.0.0.1) -> 120s
        // 熔断打挂长任务(LLM timeout 120.1s)后盘古降级云端。现按端点判本地: 本地 300s / 云端 120s,
        // model.timeout_ms 可显式覆盖。
        // 2026-10-16: 这是**空闲**超时不是总时长 —— 流式下每收一块就重置,
        // 所以正在生成的本地模型不会被砍, 只有真卡死才熔断。
        timeout: resolveRequestTimeoutMs(modelConfig, 120000, 300000),
      };
      const t0 = Date.now();
      let data = '';
      let meterBuf = '';
      let gotFirst = false;
      let cChars = 0, tChars = 0;
      const toolNames = [];
      let lastEmit = 0;
      let reportedThinking = false;

      // 2026-10-16 (现场 lt2-1792137648743, "跟死了一样"的机制):
      // 上面那个 timeout 是**空闲**超时 —— 流式下每收一块就重置, 所以"正在生成"
      // 的模型永远不会被砍。那条取舍本身是对的, 但它漏了一类情况: **持续吐字节、
      // 却一个字都没产出**的 runaway 长考。实测 planner 有一次想满 500s, thinking
      // 涨到 11280 字, 正文恒为 0, 屏幕上什么都没有; 而 socket 因为每秒都有 delta
      // 所以永远不超时 —— 请求就这么挂着, 主人等到天荒地老。
      //
      // 为什么按"零产出时长"判, 不按 thinking 字符数判: 实测四轮里
      //   正常那轮  峰值 thinking 11567, 73.3s 出正文, planner 118s 出计划
      //   runaway   峰值 thinking 11280, 500s+ 仍是 0
      // 量级几乎一样, 字符数根本区分不出来; 能区分的只有"多久没吐过正文"。
      // 正常最晚的一轮 182.4s 出正文, 这里给 300s (沿用本地端点既有的一档),
      // 对最坏健康样本还有 1.6 倍余量。
      //
      // 一旦吐出正文或调了工具, 闸门立刻撤掉 —— 之后由空闲超时接管,
      // 那才是"正在生成"的正常长跑 (实测单刀 724~855s 仍在正常产出, 不该被砍)。
      const zeroContentMs = Math.max(
        1000,
        parseInt(process.env.PANGU_SUBAGENT_ZERO_CONTENT_MS || '', 10)
          || resolveRequestTimeoutMs(modelConfig, 120000, 300000));
      let zeroContentTimer = null;
      let sawUsefulOutput = false;
      const stopZeroContent = () => {
        if (zeroContentTimer) { try { clearTimeout(zeroContentTimer); } catch (_) {} zeroContentTimer = null; }
      };
      const clearZeroContent = () => {
        stopZeroContent();
        sawUsefulOutput = true;
      };

      // 活性计: 只数"有没有在动", **不做装配**。装配以 llm_caller._parseSSEBody 为准。
      const _meterLine = (line) => {
        const m = /^\s*data:\s?(.*)$/.exec(line);
        if (!m) return;
        const s = m[1].trim();
        if (!s || s === '[DONE]') return;
        let j; try { j = JSON.parse(s); } catch (_) { return; }
        const ch = j.choices && j.choices[0];
        if (!ch) return;
        const d = ch.delta || {};
        if (typeof d.content === 'string') cChars += d.content.length;
        if (typeof d.reasoning_content === 'string') tChars += d.reasoning_content.length;
        for (const t of (d.tool_calls || [])) {
          if (t && t.function && t.function.name) toolNames.push(t.function.name);
        }
        // 有正文或有工具调用 = 这一刀真的在干活, 零产出闸门撤掉。
        // 只有 thinking 不算 —— runaway 的形状恰恰就是"thinking 一直涨、正文永远是 0"。
        if (!sawUsefulOutput && (cChars > 0 || toolNames.length)) clearZeroContent();
        // 思考期是主人最没底的那一段 (屏幕上什么都没有) —— 单独报一次
        if (!reportedThinking && tChars > 0 && cChars === 0) {
          reportedThinking = true;
          _tick('sub_thinking', { ms: Date.now() - t0, thinking_chars: tChars });
        }
      };

      // 零产出闸门起跑。req 在回调里才被赋值, 但定时器是异步触发的, 那时早已赋值。
      zeroContentTimer = setTimeout(() => {
        try { req.destroy(); } catch (_) {}
        reject(new Error('ZERO_CONTENT_TIMEOUT_' + Math.round(zeroContentMs / 1000)
          + 's (' + _modeLabel + ': 有流量但零正文/零工具, 已熔断)'));
      }, zeroContentMs);
      const req = (url.protocol === 'https:' ? https : http).request(options, (res) => {
        if (res.statusCode && res.statusCode >= 400 && streamOn && !_retriedPlain) {
          _retriedPlain = true;
          // 这一路已经放弃了, 零产出闸门必须撤 —— 否则它会一直挂到阈值才到期,
          // 而这期间它 reject 的是一个早已 settle 的 promise (无害), 计时器本身
          // 却把事件循环吊住。实测: T8 那条 4xx→非流式重试的用例因此多挂了整整 300s,
          // 测试体 2ms 跑完, 进程退不出来。
          stopZeroContent();
          res.resume();                       // 必须消费掉, 否则 socket 不释放
          console.warn('[sub-agent-stream] 上游 ' + res.statusCode + ' 不接受流式, 退回非流式重试一次 (' + _modeLabel + ')');
          _send(false).then(resolve, reject);
          return;
        }
        res.on('data', (chunk) => {
          data += chunk;
          // 活性计**无条件**跑 (原来被 `if (!_onTick) return` 挡着):
          // 它现在还负责撤零产出闸门 —— 一旦没有 tick 消费者就整段跳过,
          // 闸门永远看不到"已经出正文了", 于是把一次正常的慢生成当成 runaway 砍掉。
          // 上报仍然由 _tick 自己判空, 不刷屏。
          meterBuf += chunk.toString('utf8');
          const lines = meterBuf.split('\n');
          meterBuf = lines.pop() || '';       // 半行留到下一个 chunk
          for (const line of lines) _meterLine(line);
          if (!_onTick) return;
          if (!gotFirst) {
            gotFirst = true;
            _tick('sub_first_byte', { ms: Date.now() - t0, bytes: chunk.length });
          }
          // 只在"内容或工具在长"的时候节流上报, 免得空 chunk 刷屏
          const now = Date.now();
          if (now - lastEmit >= 1500) {
            lastEmit = now;
            if (cChars || tChars || toolNames.length) {
              _tick('sub_progress', {
                ms: now - t0,
                content_chars: cChars,
                thinking_chars: tChars,
                tools: toolNames.slice(0, 8),
              });
            }
          }
        });
        // 连接异常/被销毁时也要撤闸门。req.destroy() 与 socket 提前关闭都会走到这里,
        // 漏掉的话计时器会一直吊着事件循环直到阈值到期。
        res.on('close', stopZeroContent);
        res.on('error', stopZeroContent);
        res.on('end', () => {
          stopZeroContent();
          try {
            if (meterBuf) { _meterLine(meterBuf); meterBuf = ''; }
            let result;
            const isSSE = /(^|\n)\s*data:/.test(data);
            if (isSSE) {
              // 装配走唯一真源。不复用它就等于维护第二套, 而第二套静默返回空的概率极高。
              let sse = null;
              try { sse = require('../modules/llm_caller')._parseSSEBody(data, { source: 'streaming' }); } catch (_) {}
              result = sse || JSON.parse(data.replace(/^\s*data:\s*/, '').trim());
            } else {
              // 2026-10-25 (第 90 批): 上游回了一整页 HTML (本地端点没起来 / 路径不对 /
              //   被网关拦了) 时, 裸 JSON.parse 抛的是语法错 —— 报出去是
              //   「Unexpected token '<'」, 指向的是解析器, 真因在上游那一侧。
              //   ⇒ 判据跟主传输层共用一份 (llm_caller._upstreamBodyDiagnosis),
              //     两处不各写一份 —— 各写一份迟早漂。
              try {
                result = JSON.parse(data);
              } catch (_jsonErr) {
                const _diag = require('../modules/llm_caller')._upstreamBodyDiagnosis(res.statusCode, data);
                throw _diag || _jsonErr;
              }
            }
            if (result.error) return reject(new Error(result.error.message || result.error));
            let text = '';
            if (useAnthropic) {
              text = result.content && result.content.map(c => c.text || '').join('') || '';
            } else {
              text = result.choices && result.choices[0] && result.choices[0].message && result.choices[0].message.content || '';
            }
            const nativeCalls = _nativeCallsFrom(result, useAnthropic);
            // 2026-10-14 (现场审计抓到): usage 在这一层被丢了 —— llm_caller 明明返回了
            // `usage`, 但 resolve 时只带 text/nativeCalls/raw, 于是上层 token 账本永远读到
            // undefined, 100% 落进估算分支。而那条估算分支是"整条 messages 的体积",
            // 长任务里前缀被重复计 N 次 (O(n²)) —— 等于用一个会在正常长任务上误触发的墙,
            // 去替换 max_tool_iterations 那道墙。修: 把 usage 原样带出去。
            if (_onTick) {
              _tick('sub_done', {
                ms: Date.now() - t0, content_chars: text.length,
                tool_calls: nativeCalls.length, tools: nativeCalls.map(c => c.name).slice(0, 8),
                streamed: !!isSSE,
              });
            }
            resolve({ text, nativeCalls, raw: result, usage: (result && result.usage) || undefined });
          } catch (e) {
            reject(e);
          }
        });
      });
      req.on('error', (e) => { stopZeroContent(); reject(e); });
      req.on('timeout', () => { req.destroy(); reject(new Error('LLM timeout')); });
      req.write(payloadBody);
      req.end();
    });

    _send(_wantStream && !useAnthropic).then(resolve, reject);
  }).then((_r) => { _perfDone('ok'); return _r; },
         (e) => { _perfDone('ERR', String((e && e.message) || e).slice(0, 80)); throw e; });
}

function extractToolCalls(text, knownTools) {
  const calls = [];
  // 2026-10-12: MiniMax-M3.1-Flash 还有一种混合形态 ——
  //   <tool_call>tool name="bazi_calc">{...}</tool_call>
  // 外层是 tool_call 信封, 内层又塞了 name 形态的开标签, 收尾多一个 </tool_call>。
  // 下面两条正则都不认它(信封要 JSON、named 要 <tool 开标签), 于是这一轮工具直接不执行。
  // 实测同一道排盘题, 模型在三种形态间摇摆, 撞上这个形态就整轮空转。
  // 归一化成标准 <tool name="x">…</tool>, 走同一条解析路径。
  let src = String(text || '');
  // 模型会往标签里塞零宽空格(U+200B)来拆 token 防复读 ——
  // 实测同一道题, <tool_call> 和 <tool_call> 两种都出现过, 只认没 ZWSP 的那个正则
  // 就会时灵时不灵。ZWSP 在工具标记里永远是噪音, 解析前统一剔掉。
  src = src.replace(/[\u200b\u200c\u200d\ufeff]/g, '');
  // 2026-10-12 (会话 desktop-1791787104119 实案): MiniMax 原生哨兵 token 泄进正文 ——
  //   <tool name="web_search">{"q":"...关系]<]minimax[>[</q>]<]minimax[>[</invoke>兆
  // <]minimax[> 是工具段的终止/分隔噪声, [</q>]/[</invoke>] 是反括号标签残片。
  // 不剔掉的话: named 正则找不到 </tool> → 工具不执行 + 整段原始标记漏进 summary 上屏。
  src = src.replace(/<\]minimax\[>/g, '\n');
  src = src.replace(/\[<\/?[a-zA-Z_]+>\]/g, '');
  src = src.replace(/<tool_call>\s*tool\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool_call>/gi,
    (all, name, body) => '<tool name="' + name + '">' + body + '</tool>');
  const parseArgs = (raw) => {
    let args = {};
    raw = String(raw || '').trim();
    if (raw) {
      try {
        args = JSON.parse(raw);
      } catch (e) {
        // 尝试修复：可能外层有引号或换行
        try {
          args = JSON.parse(raw.replace(/^['"]|['"]$/g, ''));
        } catch (_) {
          args = { raw };
        }
      }
    }
    return args;
  };

  // MiniMax/Kimi variants use both </tool> and </tool_call> for the named
  // block format. Accept both; otherwise a perfectly valid call is treated as
  // plain prose and the sub-agent returns without executing any tool.
  const named = /<tool\s+name="([^"]+)"\s*>([\s\S]*?)<\/tool(?:_call)?>/gi;
  let m;
  while ((m = named.exec(src)) !== null) {
    calls.push({ name: m[1].trim(), args: parseArgs(m[2]) });
  }

  // Some providers emit a JSON envelope: <tool_call>{"name":...,"arguments":...}</tool_call>.
  const envelope = /<tool_call\s*>([\s\S]*?)<\/tool_call>/gi;
  while ((m = envelope.exec(src)) !== null) {
    let payload;
    try { payload = JSON.parse(m[1].trim()); } catch (_) { continue; }
    const entries = Array.isArray(payload) ? payload : [payload];
    for (const item of entries) {
      if (!item || typeof item.name !== 'string') continue;
      calls.push({ name: item.name.trim(), args: normalizeToolArgs(item.arguments ?? item.params ?? item.args ?? {}) });
    }
  }
  // MiniMax-M3.1-Flash 实测第三种形态: 直接用工具名当标签 ——
  //   <bazi_calc>{"year":1978,...}</bazi_calc>
  // 上面两种正则都不认, 于是这个**完全合法**的调用被当成正文, 工具一次没执行,
  // sub-agent 直接把这段 XML 当 summary 返回 (会话 78325678 复测时抓到的)。
  // 标签名先跟白名单对一遍, 免得把正文里 <div> 之类的 HTML 当工具调用。
  const bare = /<([a-z][a-z0-9_]{2,40})>([\s\S]*?)<\/\1>/gi;
  while ((m = bare.exec(src)) !== null) {
    const name = m[1].trim();
    if (!name.includes('_')) continue;              // bazi_calc / stock_quote 这类才有意义
    // 2026-10-12 (tests/long-task-subagent-regressions 第 14 条抓到): tool_call 这类信封标签
    // 长得跟工具名一样 (含下划线), 会被下面的裸标签分支当成工具再解析一次 ——
    // 不带 knownTools 调用时凭空多出一条 {name:'tool_call', args:{name:'read_file',...}},
    // 执行层会拿它去调一个叫 tool_call 的工具, 必然 "Tool not found"。
    // 信封标签不是工具名, 名字本身就是标记语法, 直接跳过。
    if (/^(tool_call|tool_calls|function_call|function_calls)$/i.test(name)) continue;
    if (knownTools && !knownTools.has(name)) continue;
    if (calls.some(c => c.name === name)) continue;  // 上面两种已解析过
    calls.push({ name, args: normalizeToolArgs(parseArgs(m[2])) });
  }
  // 2026-10-12 (会话 desktop-1791787104119 实案) 无收尾标签的 named 块兜底:
  // MiniMax 把 </tool> 泄漏成哨兵残片后, 开标签 + JSON 身体其实还在 ——
  // 用平衡括号扫描把第一个 JSON 对象捞出来, 该执行的工具照样执行。
  const openM = /<tool\s+name="([^"]+)"\s*>/i.exec(src);
  if (openM && !/<\/tool(?:_call)?>/i.test(src.slice(openM.index))) {
    const name = openM[1].trim();
    if (!calls.some(c => c.name === name) && (!knownTools || knownTools.has(name))) {
      const body = src.slice(openM.index + openM[0].length);
      let json = _extractFirstJsonObject(body);
      if (json == null) {
        // 哨兵把 JSON 尾巴也吃掉的实案: {"q":"...关系]<]minimax[>… —
        // 截到第一个换行 (哨兵已归一为 \n), 缺引号补引号, 缺右括号补右括号, 再试一次。
        const head = body.split('\n')[0].trim();
        if (head.startsWith('{')) {
          const oddQuotes = ((head.match(/"/g) || []).length % 2) === 1;
          const openBraces = (head.match(/\{/g) || []).length - (head.match(/\}/g) || []).length;
          const cand = head + (oddQuotes ? '"' : '') + '}'.repeat(Math.max(0, openBraces));
          try { JSON.parse(cand); json = cand; } catch (_) { /* 救不回就放弃, 不硬编 */ }
        }
      }
      if (json != null) calls.push({ name, args: normalizeToolArgs(parseArgs(json)) });
    }
  }
  return calls;
}

// 从乱码尾巴里捞第一个平衡 JSON 对象 (字符串内的引号/括号不误计)
function _extractFirstJsonObject(s) {
  const start = String(s || '').indexOf('{');
  if (start < 0) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return s.slice(start, i + 1);
    }
  }
  return null;
}

// 收口前剥工具标记 (加强版): 闭合块 + 无收尾残段 + MiniMax 哨兵残片 + ZWSP。
// 旧版只剥闭合 </tool> 块, 哨兵泄漏场景下整段原始标记会漏进 summary 上屏。
// S3 辅助: 熔断收场时正文可能还带着工具标记, 先剥干净再交给上层。
function cleanTextPreview(text) {
  const s = String(text || '').trim();
  return s || '';
}

function stripToolMarkup(text) {
  let s = String(text || '');
  s = s.replace(/[​‌‍﻿]/g, '');
  s = s.replace(/<\]minimax\[>/g, '\n');
  s = s.replace(/\[<\/?[a-zA-Z_]+>\]/g, '');
  s = s.replace(/<tool_call>[\s\S]*?<\/tool_call>/gi, '');
  s = s.replace(/<tool[\s\S]*?<\/tool>/gi, '');
  s = s.replace(/<tool\s+name="[^"]*"\s*>[\s\S]*$/i, '');
  return s.replace(/\n{3,}/g, '\n\n').trim();
}

// Models do not agree on the wrapper used for textual tool arguments.  Keep
// the execution boundary tolerant of `params`, `arguments`, `args`, `input`,
// and JSON-string arguments so a valid tool call is not turned into NO_PATH or
// INVALID_ARGS merely because the provider added one transport envelope.
// S3 辅助: 参数对象的稳定序列化 —— 键序不同也要算"同一参数", 否则熔断会被 {"a":1,"b":2}
// 和 {"b":2,"a":1} 绕过。
function _stableArgs(args) {
  try {
    if (args === null || args === undefined) return '';
    if (typeof args !== 'object') return String(args);
    const walk = (v) => {
      if (Array.isArray(v)) return v.map(walk);
      if (v && typeof v === 'object') {
        const out = {};
        for (const k of Object.keys(v).sort()) out[k] = walk(v[k]);
        return out;
      }
      return v;
    };
    return JSON.stringify(walk(args));
  } catch (_) {
    return String(args);
  }
}

function normalizeToolArgs(args) {
  let value = args;
  if (value == null) return {};
  if (typeof value === 'string') {
    try { value = JSON.parse(value); } catch (_) { return { raw: value }; }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) return { raw: value };

  for (let depth = 0; depth < 2; depth++) {
    const keys = Object.keys(value);
    const visibleKeys = keys.filter(k => !k.startsWith('_'));
    const wrapper = visibleKeys.find(k => ['params', 'arguments', 'args', 'input', 'payload'].includes(k));
    if (!wrapper || visibleKeys.length !== 1) break;
    let nested = value[wrapper];
    if (typeof nested === 'string') {
      try { nested = JSON.parse(nested); } catch (_) { break; }
    }
    if (!nested || typeof nested !== 'object' || Array.isArray(nested)) break;
    value = nested;
  }
  return value;
}

// The fixed-flow runner uses this module directly instead of j2_agent_loop.
// Emit the same tool card pair that the main loop emits so the desktop can
// show real child-agent work, while keeping direct/CLI callers unaffected.
function emitSubAgentToolEvent(res, event, payload) {
  if (!res || typeof res.write !== 'function') return;
  try {
    res.write('event: ' + event + '\ndata: ' + JSON.stringify(payload) + '\n\n');
  } catch (_) { /* disconnected SSE client: execution must still finish */ }
}

async function executeTool(name, args, configPath, permCtx) {
  const TOOLS = _tools();
  const normalizedArgs = normalizeToolArgs(args);
  const toolCallId = 'subtc_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8);
  const stream = permCtx && permCtx.res;
  emitSubAgentToolEvent(stream, 'tool_call', {
    id: toolCallId,
    name,
    params: normalizedArgs,
    agent: permCtx && permCtx.agent,
    session_id: permCtx && permCtx.sessionId,
    ts: Date.now(),
  });
  const finish = (result) => {
    emitSubAgentToolEvent(stream, 'tool_result', {
      id: toolCallId,
      name,
      agent: permCtx && permCtx.agent,
      session_id: permCtx && permCtx.sessionId,
      ok: !!(result && result.ok),
      result: result && result.ok ? result.result : undefined,
      error: result && !result.ok ? result.error : undefined,
      blocked: !!(result && (result.sandbox_blocked || result.permission_denied)),
      ts: Date.now(),
    });
    return result;
  };
  if (!TOOLS[name]) return finish({ ok: false, error: `Tool not found: ${name}` });
  // 2026-10-14 按动作裁权限: 只读角色 (li/xun/dui/zhen) 的
  // 不可逾越边界。放在沙箱**之前**且**不受沙箱开关影响** ——
  //   老板 8/1 关掉全局 sandbox 是信任主循环, 不是授权将灵删文件。
  // 以前这层只存在于 prompt 里 ("exec_command 只许只读命令"), 那是一句注释不是隔离;
  // 而 shouldAsk 只看 tool name, 'rm' 从来就不是一个 tool, 所以那层拦截一次都没生效过。
  try {
    const ap = require('../modules/action_policy');
    const role = (permCtx && permCtx.agent) || '';
    const v = ap.checkRoleAction(role, name, normalizedArgs);
    if (v && !v.ok) {
      console.warn('[action_policy] BLOCK ' + role + ' → ' + name + ': ' + v.reason);
      // 留痕: 越界拒绝本身就是最该复盘的事之一。
      try {
        const rt = require('../modules/run_trace');
        rt.appendGuard({
          guard: 'action_policy', action: 'block',
          reason: v.code + ': ' + v.reason,
          userInput: (permCtx && permCtx.sessionId) || role,
        });
      } catch (_) { /* 留痕失败不许影响拦截 */ }
      return finish({
        ok: false,
        error: 'ROLE_READ_ONLY: ' + v.reason,
        permission_denied: true,
      });
    }
  } catch (_) { /* action_policy 异常不阻断 */ }
  // 2026-10-28 (第 136 批 P3): 权限**档位**的执行层闸门 (只读档真禁写禁网)。
  //   与主循环 (j2_agent_loop._execToolWithPermission) 同一道门、同一份判据 ——
  //   两边各写一份 = 下次改判据漏一边, 然后"只读档在主循环禁住了、在将灵这边没禁"。
  //   角色边界 (action_policy) 管"这个将灵能不能干", 档位管"这个会话能不能干", 不重叠。
  try {
    const pg = require('../modules/permission_guard');
    const g = pg.checkToolPermission(name, normalizedArgs, {
      sessionId: (permCtx && permCtx.sessionId) || undefined,
      agentLevel: (permCtx && permCtx.agentLevel) || undefined,
    });
    if (g && g.allowed === false) {
      console.warn('[permission_guard] BLOCK sub-agent ' + (permCtx && permCtx.agent) + ' → ' + name + ': ' + g.reason);
      try {
        require('../modules/run_trace').appendGuard({
          guard: 'permission_guard', action: 'block',
          reason: 'PERMISSION_LEVEL_BLOCKED: ' + g.reason,
          userInput: (permCtx && permCtx.sessionId) || (permCtx && permCtx.agent) || 'sub-agent',
        });
      } catch (_) { /* 留痕失败不许影响拦截 */ }
      return finish({
        ok: false,
        error: 'PERMISSION_LEVEL_BLOCKED: ' + g.reason,
        permission_denied: true,
      });
    }
  } catch (_) { /* permission_guard 异常不阻断 (主循环那边才是 fail-closed) */ }
  // 2026-09-14 (老板问: 需要批准/沙箱外操作怎么做): 将灵与主循环同纪律 — 先沙箱后审批, 不裸奔
  // 沙箱: 默认全放 (老板 8/1 拍), PANGU_SANDBOX=on 才真查
  try {
    const { checkToolCall } = require('../modules/sandbox');
    const sc = checkToolCall(name, normalizedArgs);
    if (sc && !sc.ok) return finish({ ok: false, error: 'SANDBOX_BLOCKED: ' + (sc.reason || 'sandbox denied'), sandbox_blocked: true });
  } catch (_) { /* sandbox 模块异常不阻断 */ }
  // 审批: 高危操作 shouldAsk → 审批卡直达主人 (res 必须是真的, sink 会吞卡干等 60s 超时拒)
  try {
    const perm = require('../modules/permission');
    if (perm.shouldAsk && permCtx && permCtx.res) {
      // 2026-09-14: agentLevel = 将灵页 auto_approve 的级别 override, 进 shouldAsk 统一裁决
      const ask = perm.shouldAsk(name, normalizedArgs, { sessionId: permCtx.sessionId, agentLevel: permCtx.agentLevel });
      if (ask && ask.ask) {
        if (permCtx.onProgress) permCtx.onProgress({ stage: 'approval_needed', tool: name, agent: permCtx.agent });
        const r = await perm.requirePermission(name, normalizedArgs, { sessionId: permCtx.sessionId, res: permCtx.res, timeoutMs: 60000 });
        if (!r || !r.approved) return finish({ ok: false, error: 'PERMISSION_DENIED: ' + ((r && r.reason) || '主人拒绝'), permission_denied: true });
      }
    }
  } catch (_) { /* permission 模块异常放行, 不阻断 */ }
  try {
    const result = await TOOLS[name]({ context: { user: 'feng', configPath }, params: normalizedArgs });
    return finish({ ok: true, result });
  } catch (e) {
    return finish({ ok: false, error: e.message });
  }
}

// 2026-10-17 (现场 q-1792191820440, 855fa63 的**兄弟病灶**):
//   主 agent 那条循环 855fa63 修完 400 归零, 但子 agent 这条循环原样抄了一份, 于是
//   拆刀一上场 400 又回来, 且是**两条不同的 400**:
//     [j2-native] LLM call failed: HTTP 400: invalid params, tool call and result not match (2013)
//     [j2-native] LLM call failed: HTTP 400: invalid params,
//                     tool result's tool id(call_3dbc2000c5e74ebb9f6ffc76) not found (2013)
//
// 一段代码里叠了三个缺陷, 互相掩盖:
//
//  ① **铸 id 用了两套公式**。同一个工具调用, assistant 侧铸 `call_<name>_<轮内序号>`,
//    tool 侧铸 `call_<name>_<轮数>_<序号>` —— round 一起就分岔, 上游按哪个都找不到。
//    只在 `_nativeCallsFrom` 拿到 null id 时才发作 (上游不发 id 的模型), 所以平时看不出来,
//    一换模型/一换端点就整轮 400。
//
//  ② **配对按 toolResults 下标**: `const _tc = toolCalls[_i]`。这是 855fa63 修掉的
//    "驱动源选错"的原始形态 —— 契约长在 assistant.tool_calls 上, 不在 toolResults 上。
//
//  ③ **toolResults 被重排过**, 按下标配必然错位。执行段把工具拆成 safe/unsafe 两组,
//    先跑完 safe 再跑 unsafe, 所以 toolResults 的顺序是 [safe..., unsafe...],
//    而 toolCalls 是**模型的调用顺序**。模型先 exec_command(unsafe) 再 read_file(safe),
//    结果数组就变成 [read_file, exec_command] —— 每个结果发给了错的 tool_call。
//    这一条比 400 更阴: 上游收到的是**合法 id**, 校验过得去, 于是不报错,
//    但模型看到的是"读文件返回了执行命令的结果", 静默把证据用错地方。
//
// 修法: ① id 只在一个地方铸 (原地补齐, 幂等), ②③ 配对靠结果**自带的那个
// tool call 对象**, 不靠下标 —— 执行时就把 tc 挂到结果上, 顺序怎么排都不影响。

// 全文件**唯一**的 tool_call id 公式。原地补齐, 幂等: 已铸好的不碰, 重复调用结果一致。
// 因此 assistant 侧和 tool 侧拿到的一定是同一个 id, 不存在两套公式分岔。
function _ensureToolCallIds(toolCalls) {
  const list = Array.isArray(toolCalls) ? toolCalls : [];
  list.forEach((tc, i) => {
    if (tc && !tc.id) tc.id = 'call_' + tc.name + '_' + i;
  });
  return list;
}

// 原生协议下 assistant 消息的形状 (tool_calls 与后续 role:'tool' 靠 id 配对)
function _assistantMessage(text, toolCalls, useNative) {
  if (!useNative) return { role: 'assistant', content: text };
  _ensureToolCallIds(toolCalls);
  return {
    role: 'assistant',
    content: text || null,
    tool_calls: (toolCalls || []).map((tc) => ({
      id: tc.id,
      type: 'function',
      function: { name: tc.name, arguments: JSON.stringify(tc.args || {}) },
    })),
  };
}

async function runAgentLoop({ taskText, mode, model, cfg, configPath, onProgress, roleCfg, res, sessionId, toolsAllowed, images, callLLMFn, directAnswer, anchorTime, contextSeed, parentSessionId }) {
  // 测试注入点: 生产走模块内 callLLM, 单测塞假模型驱动整条循环。
  const _callLLM = typeof callLLMFn === 'function' ? callLLMFn : callLLM;
  const role = ROLES[mode] || ROLES.kun;
  const _tools = Array.isArray(toolsAllowed) && toolsAllowed.length > 0 ? toolsAllowed : role.tools;
  // 2026-09-16 老板拍: 子 agent 按职能配工具 — toolsAllowed (dispatcher 注入) 优先, 否则 role.tools
  // 2026-09-14: 审批上下文 — 将灵要权时审批卡直达主人 (带将灵归属)
  const _permCtx = { res, sessionId, agent: mode, onProgress };
  // 子 agent 自己的 sessionId 是 dispatcher 合成的 `#sub-fixed-N-agent` (权限/abort 域必须独立,
  // 否则父会话一中断就把兄弟 worker 一起掐了), 但**上下文必须继承父会话** ——
  // 这两件事以前被混为一谈: 为了隔离把上下文也隔没了。2026-10-14 拆开:
  // 隔离只用于 abort/权限, 连续性走 parentSessionId。
  const _parentSessionId = parentSessionId || null;
  // 2026-09-14 (老板拍: 配置按将灵特性分配 + 接到运行时): 读设置·将灵页 role_configs
  // max_tool_iterations = 工具调用预算 (超了强制收尾); parallel_tools=false = 全串行; memory_enabled=false = 禁自动记忆
  const _rc = roleCfg || {};
  // 2026-10-14 (老板: "盘古长任务无法执行"): _maxToolCalls 原本是 const 硬墙, 而轮次预算
  // 是可续跑的 —— 两道闸门一套语义, 长任务先撞上不可续跑的那道。现在 _maxToolCalls 是
  // "单个预算窗口", auto-resume 证明有实质进展后会再给一份 (见 _extendToolBudget),
  // 无进展/没开续跑时行为与旧码逐字一致。_baseToolCalls 保留原始配置值, 重置幅度按它算。
  const _baseToolCalls = (typeof _rc.max_tool_iterations === 'number' && _rc.max_tool_iterations > 0) ? _rc.max_tool_iterations : 0;
  let _maxToolCalls = _baseToolCalls;
  const _parallel = _rc.parallel_tools !== false;
  const _memoryOn = _rc.memory_enabled !== false;
  // 2026-09-14 (老板拍: 将灵 auto_approve 收口进全局权限体系): true → 该将灵按「替我审批」档裁决,
  // 全局/会话级别仍是天花板 (全局只读时 toggle 不能偷越权); false → 完全跟随全局 (现状)
  if (_rc.auto_approve === true) {
    try { _permCtx.agentLevel = require('../modules/permission').AGENT_AUTO_APPROVE_LEVEL; } catch (_) {}
  }
  const messages = [];
  // 2026-10-14 (老板: "盘古一样需要连续上下文" — 盘古不该例外):
  // 旧码 messages 从空数组起步, 每个将灵都在重建世界认知 —— planner 查过的文件
  // executor 不知道, 上一轮主人问过什么这一轮没人知道。sessionId 一直在参数里,
  // 但只喂给了 _permCtx 判权限, 从没读过历史。这就是同一个模型下盘古比 codex
  // 慢一大截的根因: token 花在重建, 不是干活。
  // codex 没有这个问题是因为它是单一长对话, 连续性是结构自带的; 盘古有 8 个将灵,
  // 连续性必须显式接上, 否则 8 将灵 = 8 次盲猜。
  // contextSeed 由 dispatcher 从 session 容器取: {turns, findingsBlock, rootId}
  const _seed = contextSeed || {};
  const _ctxTurns = Array.isArray(_seed.turns) ? _seed.turns : [];
  const _ctxFindings = String(_seed.findingsBlock || '');
  // 追踪一次子 agent 运行: 工具结果字节/截断/耗时/token 全部落账 (codex 式)
  let _trace = null;
  try {
    const _rt = require('../modules/run_trace');
    _trace = _rt.createTrace({
      sessionId, agent: mode, kind: 'subagent',
      root: _seed.rootId || sessionId, parent: _seed.parentTraceId || null,
    });
    // 把继承情况记进 trace: 这是"将灵有没有接上上下文"的唯一现场证据。
    // 以前只能靠翻 messages 猜, 现在 start 事件后紧跟一条 context_inherited, 直接有数。
    if (_trace && typeof _trace.event === 'function') {
      _trace.event('context_inherited', {
        turns: _ctxTurns.length,
        has_findings: !!_ctxFindings,
        findings_chars: _ctxFindings.length,
        parent_session: _parentSessionId || null,
        own_session: sessionId || null,
      });
    }
  } catch (_) { _trace = null; }
  // token 预算 —— codex 范式: 没有任何工具调用次数墙, 预算全是 token 导向
  // (limit_tokens + reminder_at_remaining_tokens + model_auto_compact_token_limit),
  // 另加 job_max_runtime_seconds 管墙钟。盘古旧码用 max_tool_iterations 当主闸门
  // (planner 5 / synthesizer 10 / ... / executor 80), 那道墙跟 codex 的设计是反的。
  // 现在 token 预算当主闸门, 工具次数降级成兜底防跑飞, 墙钟兜最后一层。
  const _tokenBudget = (typeof _rc.token_budget === 'number' && _rc.token_budget > 0)
    ? _rc.token_budget
    : parseInt(process.env.PANGU_SUBAGENT_TOKEN_BUDGET || '', 10) || 0;  // 0 = 不设 token 墙
  const _wallClockLimitS = (typeof _rc.wall_clock_seconds === 'number' && _rc.wall_clock_seconds > 0)
    ? _rc.wall_clock_seconds
    : parseInt(process.env.PANGU_SUBAGENT_WALLCLOCK_S || '', 10) || 0;
  const _t_start = Date.now();
  let _tokenUsed = 0;
  let _tokenOutReason = null;
  let _lastMsgChars = 0;   // 估算增量用: 上一轮 messages 的序列化长度
  // 预算闸门状态提升到函数作用域 —— 它要被 _lastRoundText() 和函数末尾的 metrics 读到,
  // 而判定发生在 while 循环体内。用 let 声明在循环里的话, 那两处直接 ReferenceError。
  let _budgetOut = false;
  let _budgetKind = null;
  // 末轮提示 —— 撞的是哪道墙就如实说哪道, 不许笼统说"预算用完"。
  // (旧码只认工具次数, 所以永远报"工具调用预算(N次)", token 墙加进来后这句话会撒谎。)
  const _lastRoundText = () => {
    if (_budgetOut && _budgetKind === 'token') {
      return 'Token 预算(' + _tokenUsed + '/' + _tokenBudget + ')已用完, 请基于已有证据直接输出最终总结, 不要再调用工具。';
    }
    if (_budgetOut && _budgetKind === 'wallclock') {
      return '墙钟预算(' + Math.round((Date.now() - _t_start) / 1000) + '/' + _wallClockLimitS + '秒)已用完, 请基于已有证据直接输出最终总结, 不要再调用工具。';
    }
    if (_budgetOut) return '工具调用预算(' + toolHistory.length + '/' + _maxToolCalls + '次)已用完, 请直接输出最终总结, 不要再调用工具。';
    return '这是最后一轮, 请直接输出最终总结, 不要再调用工具。';
  };
  // 2026-10-12 (现场 probe-direct-after-2134): 直答轮单 agent 模式下, 角色提示里的
  // "每次回复必须调用至少一个工具"(executor/analyzer 等) 与主人"直接答"的意图直接冲突 ——
  // 模型明明已经答对("王铁柱"), 却被 round 0 的强制催工具推去调 clipboard_write。
  // 直答时: ① 明确"能答就答, 不必调工具"; ② 剥掉强制调工具那几条硬规则。
  let _sysRole = role.system;
  if (directAnswer) {
    _sysRole = _sysRole
      .replace(/\n-\s*每次回复必须调用至少一个工具/g, '')
      .replace(/\n-\s*工具调用格式：[^\n]*/g, '')
      .replace(/\*\*严禁只说不做[^*]*\*\*/g, '')
      .replace(/\n-\s*每次回复必须调用至少一个工具。/g, '')
      + '\n\n【直答模式】主人明确要求直接回答。**能在已有上下文里答出来就直接答, 优先不调工具**, ' +
        '不要写占位或空话。但如果答案确实需要实时数据/系统信息才能给, ' +
        '那就正常调用工具取真实数据再答 —— 绝不允许编造, 也不允许因为"直答"就拒绝取数。' +
        '调完工具后, 必须基于工具返回结果用自然语言给出最终答复, 不要输出 <tool_call>/<tool_result> 等标记。';
  }
  // 2026-10-12 (现场 probe-art3-2143): 所有子 agent 都注入真实时间锚点 —— 不只是 planner。
  // executor 才是真正写盘的角色; planner 编的错日期会写进 task 传下来,
  // executor 若没有真值可比对, 就会把错值当权威写进文件并伪造证据自证。
  let _anchor = '';
  try { _anchor = require('../modules/factual_anchor').timeAnchorBlock(); } catch (_) {}
  // 2026-10-16 (现场 longtask-234507, 5 步长任务实测 1200s 只跑完 1 刀):
  // executor 干的活是确定性的 ("往 s1.txt 写 3 行"), 实测正文只吐 **70 字**,
  // 思考却烧了 **2434 字** —— 34:1。decode 20 tok/s 下这就是 120s/轮,
  // 而每刀 3-4 个工具往返, 5 刀 ≈ 30 分钟。这才是"长任务无法执行"的真正账单,
  // 不是拆解错、也不是依赖错。
  //
  // 提示词层预算指令在本地模型上是唯一收得到的通道 (`reasoning_effort` **字段**
  // 空转, 模型侧 "No valid custom reasoning fields found", 见 llm_caller 里 N=5 实测),
  // 而它此前只挂在主链路的 soul 块 —— 子 agent 这条路**一条都没有**。
  //
  // 只给 executor, 不给 checker —— 这是有原则的分界, 不是图省事:
  //   executor: 活是确定性的 (写文件/跑命令), 思考不产生额外判断, 纯浪费
  //   checker:  价值就是"别相信上一刀的自述", 它要多想才敢判 PASS/FAIL。
  //             削它的预算等于削长任务的验收环节 —— 那正是 longtask-01-20261012
  //             「交付状态 partial」的根因类别。宁可慢, 不拆验收。
  // 主人显式指定的档位永远优先 (和 planner 同一套判定)。
  let _subBudget = '';
  try {
    if (mode === 'kun' && model && model.reasoning_effort) {
      _subBudget = require('../modules/llm_caller')._reasoningBudgetInstruction(model) || '';
    }
  } catch (_) {}
  messages.push({ role: 'system', content: _sysRole
    + (anchorTime === false ? '' : '\n\n' + _anchor)
    + '\n\n【事实铁律】凡涉及"今天/现在/当前"的时间判断, 一律以【当前真实时间】为准。'
    + '若 task 里给出的时间与真实时间冲突, **以真实时间为准并如实说明冲突** —— '
    + '绝不照抄 task 里的错值, 更不许编造或伪造证据。'
    + buildToolPrompt(role.tools)
    // 钉在最后 —— 越靠近后面的 user/task 消息越压得住 (同 llm_caller 的易变块垫底思路)
    + (_subBudget ? '\n\n' + _subBudget : '') });
  // 2026-10-14 连续上下文落地 (接上面 contextSeed):
  // ① 真实对话轮次按 user/assistant 原样插在 system 之后 —— 模型看到的是"同一条对话
  //    继续往下走", 而不是一段被压缩的摘要。这与 codex 单一长对话的语义一致,
  //    也是"盘古一样需要连续上下文"的正解: 不靠事后文本检查, 靠结构上不断链。
  // ② 将灵产出走单独一条 system —— 它是工作记忆不是对话, 混进 user/assistant 会让
  //    模型误判成主人在说话 (实测过: 混进去模型会把结论当新指令执行)。
  for (let _ci = 0; _ci < _ctxTurns.length; _ci++) {
    const _t = _ctxTurns[_ci];
    if (_t && (_t.role === 'user' || _t.role === 'assistant') && _t.content) {
      messages.push({ role: _t.role, content: _t.content });
    }
  }
  if (_ctxFindings) {
    messages.push({ role: 'system', content: _ctxFindings
      + '\n【继承纪律】上面是同一任务里兄弟将灵的产出, **视为已完成的真实工作**: '
      + '①它已经查过的东西你不要再查一遍 (除非结论可疑, 那就带具体疑点去查); '
      + '②你的答复要接住整条任务, 不是只答派给你的这一句; '
      + '③兄弟的结论与你的工具证据冲突时, 以证据为准并当场说明冲突。' });
  }
  // 2026-10-12 (会话 80922578 根修): 主人随对话发过的图 (卦盘/命盘截图等) 透传给子 agent —
  // 旧链路图只到主 agent, 子 agent 只拿到 "[附图 N 张]" 一行字, 看不到图就只能去翻目录找
  // 或跟着主人的话翻面。vision 模型直接看图, 非 vision 模型由 _prepareMessagesForModel
  // 附加"图未发送"说明 (防幻觉声称看到了图)。
  const _taskMsg = { role: 'user', content: taskText };
  if (Array.isArray(images) && images.length > 0) _taskMsg.images = images;
  messages.push(_taskMsg);

  // 2026-10-12 (老板拍"子 agent 不能做长工作"): 轮次预算不再硬编码 5。
  // 旧值 5 是 2026-08 的临时值, 5 轮跑不完任何"读→改→验"的多步任务, 长任务必被腰斩。
  // Codex 的做法不是"给个更大的固定轮数", 而是 token 预算 + 进展判断; 这里先给可配的硬上限,
  // 真正的总量控制交给 max_tool_iterations (工具调用预算) —— 轮次只是兜底。
  const _envMaxRounds = parseInt(process.env.PANGU_SUBAGENT_MAX_ROUNDS || '', 10);
  const _cfgMaxRounds = (typeof _rc.max_rounds === 'number' && _rc.max_rounds > 0) ? Math.floor(_rc.max_rounds) : 0;
  const maxRounds = _envMaxRounds > 0 ? _envMaxRounds : (_cfgMaxRounds > 0 ? _cfgMaxRounds : 12);
  // 2026-10-12 (老板: 子 agent 干不了长工作): 主循环 j2_agent_loop 有 auto_resume,
  // 子 agent 这条链一个都没有 —— 轮次跑满就直接 "这是最后一轮, 输出总结别再调工具", 长任务被腰斩。
  // 移植主循环同一套语义: 压缩 + 注入 [自动续跑] + 有进展就重置预算。
  // 预算默认跟主循环走 (PANGU_AUTO_RESUME_MAX), 可用 PANGU_SUBAGENT_AUTO_RESUME_MAX 单独覆盖。
  const _autoResumeMax = parseInt(
    process.env.PANGU_SUBAGENT_AUTO_RESUME_MAX || process.env.PANGU_AUTO_RESUME_MAX || '0', 10);
  // 绝对硬顶: 预算可以因为"有进展"反复重置, 但不能无限续跑 —— 给一个兜底天花板。
  const _hardMaxRounds = parseInt(process.env.PANGU_SUBAGENT_HARD_MAX_ROUNDS || '', 10) || (maxRounds * 8);
  let _resumes = 0;
  let _roundLimit = maxRounds;
  let _toolsAtLastResume = 0;
  // S3 (2026-10-12): 同 (工具, 参数) 重复到这次就不再执行 —— 主循环早就有 [HARD-LOOP] 熔断,
  // 子 agent 却没有, 于是模型能拿同一个失败参数空转满整轮预算, 老板看到的就是"子 agent 一直有问题"。
  const SUBAGENT_REPEAT_LIMIT = 3;
  const _argSeen = new Map();
  // 2026-10-21: 排盘自查被拦的累计次数 (跨轮)。只用来决定回灌文案的口气:
  // 第 1 次指路, 第 2 次起收口逼答 —— 喊三声就够, 不做无限循环。
  let _verifyBlocks = 0;
  // S2 (2026-10-12): 末轮工具结果必须先被模型看见, 才允许出总结。
  let _needsSummaryPass = false;
  let finalText = '';
  const toolHistory = [];

  // 工具预算续窗 —— 与轮次续跑同一套语义: 有实质进展才给新的完整预算窗口。
  // 调不到 (max_tool_iterations=0, 即不设预算) 时是空操作。
  const _extendToolBudget = () => {
    if (_baseToolCalls <= 0) return;
    _maxToolCalls = toolHistory.length + _baseToolCalls;
  };

  let round = -1;
  while (true) {
    round += 1;
    if (round >= _roundLimit) {
      // 轮次预算耗尽 —— 先看还有没有实质进展, 再决定续跑还是收场。
      // 进展判据 = 真实工具调用数比上次续跑时多 (主循环用的是 plan done 步数 + 写盘文件数,
      // 子 agent 没有自己的 plan, 工具调用数是它唯一能自证的推进信号)。
      const _realNow = toolHistory.filter(t => t && !String(t.name || '').startsWith('_')).length;
      const _progressed = _realNow > _toolsAtLastResume;
      if (_autoResumeMax > 0 && round < _hardMaxRounds && (_resumes < _autoResumeMax || _progressed)) {
        if (_resumes >= _autoResumeMax) _resumes = 0; // 有实质进展 → 预算重置, 与主循环一致
        _resumes += 1;
        _toolsAtLastResume = _realNow;
        // 钳到 _hardMaxRounds: 不然续跑能把 _roundLimit 一路推过绝对天花板,
        // 天花板只挡住了"续", 没挡住循环本身 —— 于是空转到推出来的那个上限才停。
        _roundLimit = Math.min(round + maxRounds, _hardMaxRounds);
        _needsSummaryPass = false; // 还没收场, 不该留总结轮欠条
        if (_progressed) _extendToolBudget(); // 进展够 → 工具预算跟着续, 否则续的只是轮次, 长任务照样撞墙
        // 压缩: 只保留最近 4 组对话, 更早的 <tool_result> 折叠成一行 —— 续跑后再不压会继续膨胀。
        // system 与任务原文永远保留, 否则子 agent 续跑后不知道自己该干什么。
        const _KEEP_TAIL = 4;
        const _tailStart = Math.max(0, messages.length - _KEEP_TAIL * 2);
        const _kept = [];
        let _folded = 0;
        for (let _i = 0; _i < messages.length; _i++) {
          const _m = messages[_i];
          if (_i < _tailStart && _m && _m.role === 'user' && typeof _m.content === 'string'
              && _m.content.indexOf('<tool_result') >= 0) {
            _folded += 1;
            continue;
          }
          _kept.push(_m);
        }
        if (_folded > 0) _kept.splice(_kept.length, 0,
          { role: 'user', content: '[已压缩的早期工具结果] ' + _folded + ' 组早期工具结果已折叠, 需要细节时重新读取目标文件。' });
        messages.length = 0;
        messages.push.apply(messages, _kept);
        messages.push({ role: 'system', content:
          '[自动续跑] 轮次预算(' + maxRounds + ' 轮)已用尽, 已自动压缩上下文并续跑 (第 '
          + _resumes + '/' + _autoResumeMax + ' 次)。任务还没做完: ' + String(taskText).slice(0, 300)
          + '\n继续推进剩余工作 —— 已完成的部分不要重复做; 需要更多证据就继续调用工具 (你还有 ' + maxRounds
          + ' 轮); 全部做完后给出最终总结, 没拿到证据的事不要写成已完成。' });
        if (onProgress) onProgress({ stage: 'sub_auto_resume', round, mode, resume: _resumes, max_resumes: _autoResumeMax, folded: _folded });
        continue;
      }
      if (onProgress) onProgress({ stage: 'rounds_exhausted', round, mode, resumes: _resumes, hard_max: _hardMaxRounds });
      break;
    }
    const _llmT0 = Date.now();
    const response = await _callLLM(messages, model, _tools, {
      mode,
      // 2026-10-16: 把"还在动"这件事一路报上去。
      // 原先这条路整段阻塞, 主人只看到 heartbeat —— 分不清在思考、在生成、还是在卡死。
      // onTick 抛错绝不能影响本轮 (它在 _tick 内部已 try), 这里也不加额外处理。
      onTick: (e) => { if (onProgress) onProgress(e); },
      // 2026-10-17 时间账: 让 [llm-cost] 能按角色分开记账 (sub:analyzer / sub:executor…)。
      // 现场 3 个 analyzer 并行阶段占 270~300s, 但每一秒是谁的, 此前完全查不出来 ——
      // 只知道"总时长很长", 于是所有修改都在猜。
      //
      // 放在 onTick **之后** 是有原因的, 不是随手排的: subagent-streaming-20261016 的
      // W2 用 `\{[\s\S]{0,200}onTick` 钉"onTick 传进了 opts"。这条护栏的意图是对的
      // (onTick 确实必须接), 但它的窗口只有 200 字符 —— 2026-10-17 第一次把这段注释
      // 插在 { 和 onTick 之间就直接把它顶爆了, 全链红。
      // 护栏不会因为"我改的是别的地方"而通融, 那就把自己挪到窗口外面去,
      // 而不是去改宽它的窗口 (那等于自己给自己松绑)。
      perfTag: 'sub:' + String(mode || 'unknown'),
    });
    // 2026-10-14: token 记账 —— codex 的预算完全建立在 token 上 (limit_tokens /
    // reminder_at_remaining_tokens / model_auto_compact_token_limit), 盘古以前一次
    // token 都没记过, 所以只能用"调了几次工具"这种粗糙代理当闸门, 于是长任务必然
    // 被 max_tool_iterations 腰斩。现在先把每次调用的真实用量记全, token 墙才有意义。
    if (response && response.usage) {
      const _in = Number(response.usage.prompt_tokens || response.usage.input_tokens || 0) || 0;
      const _out = Number(response.usage.completion_tokens || response.usage.output_tokens || 0) || 0;
      _tokenUsed += _in + _out;
      if (_trace) _trace.tokens(response.usage, 'round' + round);
    } else {
      // 上游没回 usage 时才估算, 而且**只计增量**:
      // 整条 messages 的体积每轮都含全部历史前缀, 累加起来是 O(n²) —— 30 轮任务会
      // 把同一段前缀算 30 遍, token 墙会在完全正常的任务上误触发 (比被替换掉的那道
      // 次数墙更糟, 因为它看起来更"科学")。只算上轮之后新增的部分。
      let _cur = 0; try { _cur = JSON.stringify(messages).length; } catch (_) { _cur = 0; }
      const _deltaChars = Math.max(0, _cur - _lastMsgChars);
      _lastMsgChars = _cur;
      const _est = Math.ceil(_deltaChars / 3.2) + Math.ceil(String((response.text || '')).length / 3.2);
      _tokenUsed += _est;
      if (_trace) _trace.estimated(_est, 'round' + round, { round, delta_chars: _deltaChars });
    }
    if (_trace && round === 0) _trace.ttft(Date.now() - _llmT0);
    // 注: 硬约束白名单走 callLLM 的 allowedTools, system prompt 仍按 role.tools 描述 (保持稳定)
    const text = response.text;
    // 2026-10-13: 原生 tool_calls 优先; 模型没吐原生调用时原样走旧的文本协议 (零回归)。
    const _nativeCalls = Array.isArray(response.nativeCalls) ? response.nativeCalls : [];
    const _useNative = _nativeCalls.length > 0;
    const _parsedCalls = _useNative ? _nativeCalls : extractToolCalls(text, new Set(_tools));
    // S3: 同参重复熔断 —— 第 SUBAGENT_REPEAT_LIMIT 次起不再执行, 换成一句必须改路的硬指令。
    const _fused = [];
    const toolCalls = [];
    for (const _tc of _parsedCalls) {
      const _key = _tc.name + '|' + _stableArgs(_tc.args);
      const _n = (_argSeen.get(_key) || 0) + 1;
      _argSeen.set(_key, _n);
      if (_n >= SUBAGENT_REPEAT_LIMIT) _fused.push(_tc.name + ' ×' + _n);
      else toolCalls.push(_tc);
    }
    if (_fused.length > 0) {
      messages.push(_assistantMessage(text, toolCalls, _useNative));
      messages.push({ role: 'user', content: '[SYSTEM: 同参熔断] ' + _fused.join(', ') + ' 已被拒绝执行 —— 同样的工具配同样的参数重复调用不会有新结果 (同一次失败不会因为你再调一次就变成功)。必须换参数、换工具, 或直接给出结论说明卡在哪一步。' });
      if (onProgress) onProgress({ stage: 'arg_fuse', round, mode, fused: _fused });
    }
    if (toolCalls.length === 0 && _fused.length > 0) {
      finalText = cleanTextPreview(stripToolMarkup(text));
      break;
    }

    // 2026-10-21 排盘自查闸门 (E2E 实跑 r5/r7/r8):
    //   bazi_calc 已经把整张盘给出来了, 模型却跑去自己重算 ——
    //   `python3 -c "import sxtwl; ..."`、web_search 查干支、web_fetch 抓黄历站、
    //   甚至拿编的日期(1949-10-01)再调两次 bazi_calc。
    //   r7/r8 两轮 180 秒超时, **连 final 都没出来**。
    //
    // 这里只**换掉结果**, 不删 tool_call:
    //   原生协议要求每个 assistant.tool_calls 都有配对的 tool result,
    //   把调用从消息里删掉会留下孤儿 (同参熔断那条老路就是这么绕的, 这里不跟)。
    //   ok:true + blocked:true 是刻意的 —— 拦住不是失败,
    //   不该触发 _failWarn 那套"禁止声称已完成"的说教。
    const _verifyBlocked = new Map();
    try {
      const _cvg = require('../modules/chart_verify_guard');
      const _chartTools = _cvg.succeededChartTools(toolHistory);
      if (_chartTools.length) {
        for (const _tc of toolCalls) {
          const _v = _cvg.inspect(_tc.name, _tc.args);
          if (!_v.blocked) continue;
          _verifyBlocked.set(_tc, {
            name: _tc.name, args: _tc.args,
            ok: true, blocked: true,
            result: {
              ok: false, blocked: true,
              reason: _v.why,
              message: _cvg.message(_chartTools, _verifyBlocks, _v.why),
            },
            _tc,
          });
          _verifyBlocks++;
        }
        if (_verifyBlocked.size) {
          console.warn('[sub-agent] CHART_VERIFY_GUARD: 拦下 ' + _verifyBlocked.size
            + ' 次对已算出之盘的重复核算 (盘来自 ' + _chartTools.join('/') + ')');
          if (onProgress) {
            onProgress({
              stage: 'chart_verify_guard', round, mode,
              blocked: Array.from(_verifyBlocked.values()).map(b => b.name + '(' + b.result.reason + ')'),
            });
          }
        }
      }
    } catch (_) { /* 闸门异常不阻断主流程 —— 闸门本身不能成为新的故障源 */ }

    // 2026-10-28 第 129 批: 批命「做题」口径闸门 —— 子 agent 不许去查"出生年代的社会统计"。
    //
    // 现场 (2026-10-27 23:40, 会话 15567183): 主 agent 把「分析出生地周围情况」派成了
    // 「查证 1975 年四川/成都居民家庭周边的实际生活环境, 为八字命理报告提供事实底座」,
    // 子 agent 拿到这个任务后又自己发了 4 条 web_search + 若干 web_fetch,
    // web_fetch 每次 30 秒超时 —— 这一刀烧了 10 分钟, 整轮 4m49s 还在跑。
    //
    // 这里用的是**这一刀自己的任务文本** (taskText), 不是主 agent 那轮的上下文 ——
    // 子 agent 的工具调用拿不到主会话的 sessionId, 但任务原文就在手边,
    // 而任务原文本身就写着"为八字命理报告提供事实底座" ⇒ 错口径判据齐了。
    //
    // 口径真源 = modules/bazi_items.js (唯一真源)。
    const _itemBlocked = new Map();
    try {
      const _bi = require('../modules/bazi_items');
      const _itemCtx = { turnText: String(taskText || ''), assignment: true };
      for (const _tc of toolCalls) {
        const _v = _bi.inspectToolCall(_tc.name, _tc.args, _itemCtx);
        if (!_v.blocked) continue;
        _itemBlocked.set(_tc, {
          name: _tc.name, args: _tc.args,
          ok: true, blocked: true,
          result: {
            ok: false, blocked: true,
            reason: _v.why,
            message: _bi.scopeMessage(),
          },
          _tc,
        });
      }
      if (_itemBlocked.size) {
        console.warn('[sub-agent] ITEM_SCOPE_GUARD: 拦下 ' + _itemBlocked.size
          + ' 次错口径调研 (任务: ' + String(taskText || '').slice(0, 60) + '…)');
      }
    } catch (_) { /* 闸门异常不阻断主流程 */ }

    // 提取非工具文本 (2026-10-12 加强: stripToolMarkup 连无收尾残段/哨兵残片一起剥)
    let cleanText = stripToolMarkup(text);

    if (toolCalls.length === 0) {
      if (round === 0 && directAnswer) {
        // 直答模式: 主人要的就是"直接答", 没调工具正是所求 —— 直接收, 不催。
        finalText = cleanTextPreview(stripToolMarkup(text));
        if (finalText) break;
      }
      if (round === 0) {
        // 第一轮必须调用工具；如果 LLM 只说了空话，强制提醒并重试
        messages.push(_assistantMessage(text, toolCalls, _useNative));
        messages.push({ role: 'user', content: `[系统: 你作为 ${role.name} 必须调用工具来完成任务，不能只说空话。请立即调用合适的工具执行：${taskText}]` });
        if (onProgress) {
          onProgress({ stage: 'no_tool_warning', round, mode, text: cleanText });
        }
        continue;
      }
 // #2 执行幻觉: 第二轮还没 tool call, 不假装成功, 返回失败让上层处理
      if (round === 1 && cleanText.length > 0 && !cleanText.includes('无法') && !cleanText.includes('失败')) {
        // LLM 写了总结但没调工具, 可能是幻觉. 标记为可疑, 让上层知道没真执行.
        finalText = cleanText || text;
        toolHistory.push({ name: '_no_tool_executed', ok: false, error: 'LLM 未调用任何工具, 结果可能为幻觉' });
        break;
      }
      finalText = cleanText || text;
      break;
    }

 // 自动 memory_write — 当 LLM 回复含"记住/以后/优先"时, 自动提取关键信息写 memory
    // 2026-09-14: memory_enabled=false 的将灵 (执行/检查) 跳过 — 干完就走, 不写记忆
    if (_memoryOn && round === 1 && toolHistory.length > 0 && cleanText.length > 0) {
      const autoMemoryKeywords = ['记住', '以后', '优先', '习惯', '偏好', '规则', '设置'];
      const hasKeyword = autoMemoryKeywords.some(k => cleanText.includes(k));
      if (hasKeyword) {
        try {
          const mem = require('../memory').getInstance();
          if (mem) {
            const key = 'auto_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
            await mem.write(key, { task: taskText, summary: cleanText.slice(0, 500), tools: toolHistory.map(t => t.name) }, { tags: ['auto'] });
            console.log('[sub-agent] auto memory_write:', key);
          }
        } catch (e) { console.warn('[sub-agent] auto memory_write failed:', e.message); }
      }
    }

    // 保存当前轮 assistant 回复
    // 原生协议: assistant 必须带 tool_calls, 后面每条 role:'tool' 用 tool_call_id 对应,
    // 否则上游报 "tool result's tool id not found"。文本协议则只留 content。
    messages.push(_assistantMessage(text, toolCalls, _useNative));

    // 执行工具（安全工具并行，其余串行）
    // 2026-09-14: parallel_tools=false 的将灵 (调度/规划/执行/反思/学习) 全串行 — 写盘/memory 有顺序依赖
    const toolResults = [];
    const safeTools = ['read_file', 'file_grep', 'search_files', 'list_directory', 'system_info', 'process_list', 'network_check', 'memory_read', 'memory_search', 'cache_get', 'cache_stats', 'web_search', 'web_fetch', 'github_api', 'http_check', 'weather_check', 'news_digest', 'currency_check', 'crypto_price', 'stock_quote', 'stock_history', 'file_find', 'get_lan_ip'];
    const safe = toolCalls.filter(tc => safeTools.includes(tc.name));
    const unsafe = toolCalls.filter(tc => !safeTools.includes(tc.name));

    if (_parallel) {
      const safeResults = await Promise.all(safe.map(async tc => {
        // 2026-10-21 排盘自查闸门: 命中就不执行, 直接回一句"盘已经有了"。
        // 并行分支也要查 —— web_search/web_fetch 正是走并行这条路的。
        if (_verifyBlocked.has(tc)) return _verifyBlocked.get(tc);
        // 2026-10-28 批命做题口径闸门: 同样并行分支也要查 (web_search/web_fetch 走并行)。
        if (_itemBlocked.has(tc)) return _itemBlocked.get(tc);
        const r = await executeTool(tc.name, tc.args, configPath, _permCtx);
        return { ...r, name: tc.name, args: tc.args, _tc: tc };
      }));
      toolResults.push(...safeResults);
    } else {
      for (const tc of safe) {
        if (_verifyBlocked.has(tc)) { toolResults.push(_verifyBlocked.get(tc)); continue; }
        if (_itemBlocked.has(tc)) { toolResults.push(_itemBlocked.get(tc)); continue; }
        const r = await executeTool(tc.name, tc.args, configPath, _permCtx);
        toolResults.push({ ...r, name: tc.name, args: tc.args, _tc: tc });
      }
    }

    for (const tc of unsafe) {
      if (_verifyBlocked.has(tc)) { toolResults.push(_verifyBlocked.get(tc)); continue; }
      if (_itemBlocked.has(tc)) { toolResults.push(_itemBlocked.get(tc)); continue; }
      const r = await executeTool(tc.name, tc.args, configPath, _permCtx);
      toolResults.push({ ...r, name: tc.name, args: tc.args, _tc: tc });
    }

    toolHistory.push(...toolResults);

    if (onProgress) {
      // _tc 只是回灌配对用的内部引用, 不进 SSE —— 它跟 name/args 全是重复内容
      onProgress({
        stage: 'tool_executed', round, mode,
        toolCalls: toolCalls.map(tc => tc.name),
        toolResults: toolResults.map(({ _tc, ...rest }) => rest),
      });
    }

    // 把结果追加进 messages
    // 2026-10-14: 原来这里是 `.slice(0, 3000)` —— 静默截断, 模型不知道自己拿的是半截,
    // 会拿残缺数据下结论 ("共 N 个"/"全部都是")。codex 对治手段是给每个 tool_result
    // 记 tool_result_source / original_bytes / max_bytes / omitted_calls / 截断标记,
    // 并且**把截断事实明说给模型**。现在走 run_trace.toolResult(), 同源同语义。
    const _traced = toolResults.map(tr => {
      if (_trace) return _trace.toolResult(tr.name, tr, { round, source: 'tool_exec' });
      const raw = tr.ok ? JSON.stringify(tr.result) : `ERROR: ${tr.error}`;
      // 无 trace 时的兜底也走同一份额度 (2026-10-21):
      //   原来这里硬编码 3000, 于是"有没有开 trace"决定了模型能看见多少数据 ——
      //   同一张盘, 开 trace 看到 3,000 字节, 不开 trace 看到 24,000 字符。
      //   开不开 trace 是观测开关, 不该改变答案本身。
      const _rt = require('../modules/run_trace');
      const _cap = _rt.DEFAULT_MAX_BYTES;
      const _bytes = Buffer.byteLength(raw, 'utf8');
      if (_bytes <= _cap) return { content: raw, toolResultId: null, truncated: false };
      const content = Buffer.from(raw, 'utf8').slice(0, _cap).toString('utf8').replace(/�+$/, '')
        + '\n\n[TRUNCATED] 本结果原始 ' + _bytes + ' 字节, 只给了前 ' + _cap
        + ' 字节。以上**不是完整结果**, 禁止据缺失部分下结论。';
      return { content, toolResultId: null, truncated: true, originalBytes: _bytes, keptBytes: _cap };
    });
    const resultsText = _traced.map((tr, _ti) => {
      const content = tr.content;
      const _name = toolResults[_ti] ? toolResults[_ti].name : 'unknown';
      return `<tool_result name="${_name}"${tr.toolResultId ? ` id="${tr.toolResultId}"` : ''}>\n${content}\n</tool_result>`;
    }).join('\n\n');
    // 2026-08-02 反幻觉钩子 (老板实证: 子 agent cp 失败照样报"10 个文件全在" — 主 loop 有同款钩子②, 子 agent 漏了):
    // 有失败/空结果 → 钉死: 总结里禁止声称成功, 分析原因只许引用原始 error 文本
    const _failed = toolResults.filter(tr => !tr.ok || tr.name === '_no_tool_executed');
    const _failWarn = _failed.length > 0
      ? `\n\n[SYSTEM WARNING] 本批 ${_failed.length} 个工具失败 (${_failed.map(t => t.name).join(', ')})。铁律: ①总结里禁止声称"已完成/已复制/成功" — 工具失败 = 事没办成, 必须明说哪步失败; ②分析原因只许引用 ERROR 原文, 禁止推测"沙箱/权限/路径/不存在"等原因 — 原文没说 = 原因未知, 换方法继续查证, 不许编。`
      : '';
    // 2026-09-14: 工具调用预算 (将灵页 max_tool_iterations) — 超预算视同最后一轮, 强制收尾
    // 2026-10-14 (老板: "盘古长任务无法执行" 的真凶): 这行原本是 const, 撞满就判死 ——
    // executor 配 80 次工具调用, 长任务 (读几百个文件那种) 必然撞满; 撞满之后剩下的轮次
    // 全耗在"别再调工具, 直接总结"的空转上, [自动续跑] 根本没机会注入。轮次那道墙有进展
    // 能续, 工具这道墙不能 —— 长任务就先死在一道看不见的墙上。
    // 现在工具预算纳入同一套进展制: 有实质进展就给新的预算窗口 (并同步放宽轮次窗口,
    // 免得新预算没轮次可用); 无进展、没开 auto_resume、或已到绝对天花板, 一律照旧收场。
    // 2026-10-14: token 墙 + 墙钟墙当主闸门, 工具次数降级成兜底。
    // codex 里根本没有 max_tool_iterations/tool_budget/max_tool_calls 这种东西 (逆向确认),
    // 只有 limit_tokens + reminder_at_remaining_tokens + model_auto_compact_token_limit 和
    // job_max_runtime_seconds。盘古把"次数"当主闸门, 长任务必然被腰斩 —— 这次把量纲换对。
    _budgetOut = _maxToolCalls > 0 && toolHistory.length >= _maxToolCalls;
    _budgetKind = _budgetOut ? 'tool_calls' : null;
    if (_tokenBudget > 0 && _tokenUsed >= _tokenBudget && !_budgetOut) {
      _budgetOut = true; _budgetKind = 'token';
    }
    if (_wallClockLimitS > 0 && (Date.now() - _t_start) / 1000 >= _wallClockLimitS && !_budgetOut) {
      _budgetOut = true; _budgetKind = 'wallclock';
    }
    if (_budgetKind && _trace) {
      _trace.budget({ kind: _budgetKind, used: _budgetKind === 'token' ? _tokenUsed : toolHistory.length, limit: _budgetKind === 'token' ? _tokenBudget : (_budgetKind === 'wallclock' ? _wallClockLimitS : _maxToolCalls), progress: toolHistory.filter(t => t && !String(t.name || '').startsWith('_')).length });
    }
    if (_budgetOut && _autoResumeMax > 0 && round < _hardMaxRounds) {
      const _toolsNowB = toolHistory.filter(t => t && !String(t.name || '').startsWith('_')).length;
      // token 墙 / 墙钟墙不续跑: codex 撞 limit_tokens 是靠 compact + 提醒省 token,
      // 不是靠再给一份预算无限续。给一次机会但只对"工具次数墙"续, 否则 token 墙形同虚设。
      if (_toolsNowB > _toolsAtLastResume && _budgetKind === 'tool_calls') {
        _toolsAtLastResume = _toolsNowB;
        _extendToolBudget();
        _budgetOut = false;
        _roundLimit = Math.min(round + maxRounds, _hardMaxRounds);
        _resumes = _resumes >= _autoResumeMax ? 0 : _resumes;
        _resumes += 1;
        if (onProgress) onProgress({ stage: 'sub_budget_resume', round, mode, tool_calls: toolHistory.length, resume: _resumes, max_resumes: _autoResumeMax });
      }
    }
    const isLastRound = round === _roundLimit - 1 || _budgetOut;
    if (_useNative) {
      // 原生协议: 每条结果一条 role:'tool' 消息, tool_call_id 指回上面 assistant.tool_calls。
      // 同时补一条 user 说明 (失败告警 + 末轮收尾指令) —— 工具结果本身走 tool 通道。
      //
      // 2026-10-17: 配对改用**结果自带的 _tc**, 不再用 toolCalls[_i]。
      // 理由见 _ensureToolCallIds 上方那段 ②③: toolResults 是按 safe/unsafe 分组
      // 重排过的, 与模型调用顺序不一致, 按下标配会把结果发给错的 tool_call ——
      // 上游收得到合法 id 不报错, 但模型拿到的证据是错位的, 属静默损坏。
      _ensureToolCallIds(toolCalls);   // 幂等: 确保与 assistant.tool_calls 是同一批 id
      for (let _i = 0; _i < toolResults.length; _i++) {
        const tr = toolResults[_i];
        const _tc = tr._tc || toolCalls[_i] || {};
        messages.push({
          role: 'tool',
          // 兜底仍走同一个 _ensureToolCallIds (见上), 保持全文件只有一套 id 公式
          tool_call_id: (_tc.id || _ensureToolCallIds([_tc])[0].id),
          name: tr.name,
          content: _traced[_i] ? _traced[_i].content : (tr.ok ? JSON.stringify(tr.result) : `ERROR: ${tr.error}`),
        });
      }
      messages.push({ role: 'user', content: `[系统: 以上是工具执行结果, 请基于结果继续组织答案。${isLastRound ? _lastRoundText() : ''}]${_failWarn}` });
    } else {
      messages.push({ role: 'user', content: `[系统: 以下是工具执行结果, 请基于结果继续组织答案。${isLastRound ? _lastRoundText() : ''}]\n\n` + resultsText + _failWarn });
    }

    if (isLastRound) {
      // S2: 末轮刚跑完工具, 这批结果模型还没看见 —— 此时用末轮的"工具执行前文本"当总结,
      // 等于让子 agent 在拿到证据之前就下结论 (老板看到的就是"总结跟工具结果对不上")。
      // 改成: 记一笔, 循环外再跑一次只读的总结轮。
      _needsSummaryPass = true;
    }
  }

  // S2: 证据优先的总结轮 —— 只读, 不给工具, 明确要求基于已收到的工具结果作答。
  if (_needsSummaryPass) {
    try {
      messages.push({ role: 'user', content: '[系统: 轮次/工具预算已用尽, 接下来不要再调用任何工具。请只依据上面已经收到的工具结果输出最终总结: 做成了什么、哪一步失败(附 ERROR 原文一句)。没拿到证据的事不要写成已完成。]' });
      const _sum = await _callLLM(messages, model, []);
      const _sumText = cleanTextPreview(stripToolMarkup((_sum && _sum.text) || ''));
      if (_sumText) finalText = _sumText;
      if (onProgress) onProgress({ stage: 'summary_pass', mode, chars: finalText.length });
    } catch (e) {
      console.warn('[sub-agent] summary pass failed:', e.message);
    }
  }

  // 2026-10-12 (S5 实测): 收场轮模型仍在吐工具标记时, stripToolMarkup 之后什么都不剩 →
  // finalText 是空串, dispatcher 拿空 summary 没法综合 (盘古表现 = 答复空洞 / 自报失败)。
  // 兜底只按 toolHistory 如实交代调了什么、成没成, 不做任何推断。
  if (!finalText && !directAnswer) {
    const _realAll = toolHistory.filter(t => t && !String(t.name || '').startsWith('_'));
    const _okAll = _realAll.filter(t => t.ok === true).length;
    const _badAll = _realAll.filter(t => t.ok !== true);
    finalText = '[子 agent 未产出文字总结] 本轮共调用工具 ' + _realAll.length + ' 次, 成功 ' + _okAll
      + ' 次, 失败 ' + _badAll.length + ' 次。'
      + (_badAll.length ? '失败原文: ' + _badAll.slice(0, 3).map(t => t.name + ' → ' + String(t.error || '').slice(0, 120)).join('; ') + '。' : '')
      + '以上为工具执行实况, 未做推断。';
    if (onProgress) onProgress({ stage: 'summary_fallback', mode, chars: finalText.length });
  }

  if (!finalText && directAnswer) {
    finalText = '（直答轮未能产出实质答复, 已如实拦截, 未编造。）';
    if (onProgress) onProgress({ stage: 'direct_answer_empty', mode, chars: 0 });
  }

  // A child that never executed a real tool must not look successful merely
  // because it emitted a final sentence. This is the evidence boundary used
  // by Dispatcher resDone and prevents malformed tool markup from becoming a
  // false `sub_agent_done`.
  const realToolResults = toolHistory.filter(t => t && !String(t.name || '').startsWith('_'));
  // 2026-10-12 (现场 probe-direct-fix3-2135): 直答轮 0 工具是**预期行为** ——
  // 主人明说"直接答", 模型答出"王铁柱"正是所求。但 runtimeStatus 只看工具成功,
  // 于是 0 工具一律 failed → resDone 把正确答复判成 failed (答对了反而被拦)。
  // 直答且有实质答复 → done; 直答且确实没答出东西 → 仍 failed (不许拿空串冒充成功)。
  const _directRealText = String(finalText || '').trim();
  // 占位/兜底文案不算实质答复 —— 拿它们冒充 done 就是把失败伪装成成功
  const _daPlaceholder = /未能产出实质答复|未产出文字总结/.test(_directRealText);
  const runtimeStatus = realToolResults.some(t => t.ok === true) ? 'done'
    : (directAnswer && _directRealText.length > 0 && !_daPlaceholder ? 'done' : 'failed');
  // 2026-10-12 (会话 78325678): 返回里**没有 toolsUsed**, 而 dispatcher 两处都读
  // r.result.toolsUsed 统计工具数 (resDone 的 tools_used / real_tool_calls_total)。
  // 于是子 agent 真跑了 bazi_calc, 账上仍是 tool_calls_total: 0 ——
  // ~/.pangu/state/outcomes 里每个 fixed_flow 会话都是 0 工具的假账,
  // runtime verdict 也据此把真跑通的对话判成 partial。
  // 修: 把真调过的工具名带出去(失败/被拦的也算调用过, 名字统一走实际调用的)。
  const toolsUsed = realToolResults.map(t => t.name).filter(Boolean);
  // 2026-10-14 连续上下文 (第二半): 把这次的产出写回 session 容器。
  // 上半 (contextSeed 注入) 让本将灵看得见前面发生过什么; 这一半让**后面的**将灵和
  // **下一轮主人提问**看得见本将灵查到了什么。两半合起来才是分工不丢成果 ——
  // 旧码只有 subagent-runs.jsonl 的一行摘要, 谁在跑过什么看得见, 但"查到了什么"
  // 只活到那一次 run 结束就蒸发了。
  let _traceSummary = null;
  if (_trace) {
    try {
      // 断言接地: 答案里出现的工具, 逐个标出证据是否完整 (截断/失败的尤其要说)
      for (const _t of realToolResults.slice(0, 20)) {
        _trace.claim({ text: '调用 ' + _t.name, kind: 'tool', grounded: _t.ok === true });
      }
      // 2026-10-14 溯源链强校验: 上面那条 claim 只说明"我调过工具",
      // 不说明"答案里的数字来自工具"。这里把链接到**断言**上 ——
      // 答案里每个带量纲的数字都回 tool_result 里找一遍, 找不到就标未接地。
      // 判出来的结果只留痕不改答案: 文本级判定一定有误报, 拿它去拦答案
      // 会把真结论判死, 那样守卫就再也没人信了。可证伪比强拦更有用。
      try {
        const _gc = require('../modules/grounding_check');
        const _g = _gc.check(finalText, realToolResults);
        if (_g.total > 0) {
          for (const _c of _g.ungrounded.slice(0, 30)) {
            _trace.claim({
              text: '未接地断言: ' + _c.raw, kind: _c.kind, grounded: false,
            });
          }
          _trace.event('grounding', {
            total_claims: _g.total,
            grounded: _g.grounded,
            ungrounded: _g.ungrounded_count,
            grounded_ratio: Number(_g.grounded_ratio.toFixed(3)),
            evidence_chars: _g.evidence_chars,
            has_evidence: _g.evidence_chars > 0,
            // 没调过任何工具还报一堆数字 = 最典型的编造信号
            fabricated_signal: _g.evidence_chars === 0 && _g.total > 0,
          });
        }
      } catch (_) { /* 接地核查异常不阻断主流程 */ }

      // 2026-10-21: 柱位保真核查 (E2E 实跑第 6 轮 ——
      //   工具给 庚午/癸未/戊子/己未, 模型答成 年庚午｜月**辛未**｜日戊子｜时**辛未**。
      //   月柱时柱双双改写, 上面那套数字接地核查**抓不到**: 干支不是带量纲的数字。
      //   而五行六格判据接进来之后这更致命 —— 判据是照着工具给的盘算的,
      //   模型把盘改错, 后面"哪一格不成立""喜忌如何"整套推断全建在错的盘上,
      //   而且因为判据层本身权威, 错得更有欺骗性。
      //
      // 哲学与 grounding_check 一字不差: **只留痕, 不改答案, 不判 failed**。
      //   文本级判定一定有误报, 拿它去拦答案会把真结论判死。
      //   这一层只回答"答案里说的柱, 和 sxtwl 算出来的柱, 对不对得上"。
      try {
        const _cf = require('../modules/chart_fidelity');
        const _pf = _cf.check(finalText, realToolResults);
        if (_pf.applicable) {
          const _note = _cf.describe(_pf);
          if (_note) console.warn('[sub-agent] ' + _note);
          _trace.event('pillar_fidelity', {
            checked: _pf.checked,
            mismatches: _pf.mismatches.length,
            mismatch_detail: _pf.mismatches.slice(0, 8),
            authoritative: _pf.pillars,
            // 只留痕不改答案 —— 与 grounding 同策, 明确的证据边界
            answer_modified: false,
          });
          for (const _m of _pf.mismatches.slice(0, 8)) {
            _trace.claim({
              text: '柱位改写: ' + _m.position + ' 写成 ' + _m.said + ' (sxtwl 排盘是 ' + _m.expected + ')',
              kind: 'chart', grounded: false,
            });
          }
        }
      } catch (_) { /* 柱位核查异常不阻断主流程 */ }

      _trace.event('result', {
        runtime_status: runtimeStatus,
        chars: String(finalText || '').length,
        tools: toolsUsed,
        rounds: round + 1,
        tokens_used: _tokenUsed,
        duration_ms: Date.now() - _t_start,
      });
      _traceSummary = _trace.finish(runtimeStatus === 'done' ? 'done' : 'incomplete');
    } catch (_) {}
  }
  try {
    const _sc = require('../modules/session_container').getContainer();
    if (_parentSessionId) {
      // 工具证据摘要 —— 让下游能"按需自己取", 不用把上游全文再灌一遍 prompt
      const _ev = realToolResults.slice(0, 6).map(t => {
        let body = '';
        try { body = typeof t.result === 'string' ? t.result : JSON.stringify(t.result); } catch (_) { body = ''; }
        if (body.length > 220) body = body.slice(0, 220) + '…';
        return t.name + (t.ok ? '' : '(失败)') + ': ' + (body || String(t.error || ''));
      }).join('\n  ');
      _sc.appendFinding(_parentSessionId, {
        agent: mode, task: taskText, summary: finalText,
        tools: toolsUsed, toolEvidence: _ev, ok: runtimeStatus === 'done',
      });
      if (_traceSummary) _sc.ensureRoot(_parentSessionId, _traceSummary.root_id);
    }
  } catch (_) {}
  return {
    ok: runtimeStatus === 'done', mode, summary: finalText, runtimeStatus, toolsUsed,
    data: { finalText, toolHistory },
    metrics: {
      rounds: round + 1,
      tokens_used: _tokenUsed,
      duration_ms: Date.now() - _t_start,
      budget_exhausted: !!_budgetOut,
      budget_kind: _budgetKind || null,
      ctx_turns_inherited: _ctxTurns.length,
      ctx_findings_inherited: _ctxFindings ? 1 : 0,
      trace_id: _traceSummary ? _traceSummary.trace_id : null,
    },
  };
}

// 2026-10-16 (现场 live-1792145181125): planner 42.7s 就"拆完刀", 拆出来的却是
// parsePlan 的硬编码 fallback —— [analyzer「分析需求:」/ executor「执行任务:」/ checker「验证结果」],
// 三刀同一毫秒并发, 每刀都拿到同一份任务全文。主人看到的是"拆了刀、也并行了", 于是以为拆解是对的,
// 实际上一刀都没拆 —— 而日志里**一个字**都没说它走了 fallback。
//
// 根因: 原来用 `text.match(/\{[\s\S]*\}/)` 抓 JSON。那是贪婪匹配 = 第一个 `{` 到最后一个 `}`。
// 模型只要在 JSON 前后说了任何带花括号的话("用 {} 表示占位"、"思路 {k:1} 然后 {...}"),
// 整块就变成 "{...} 说明: 用 {} 表示占位", JSON.parse 直接抛, 于是**静默**退回 fallback。
// 实测 5 种真实输出形状里 3 种中招 (含被 max_tokens 截断那种, 连正则都匹配不到)。
// 更糟的是 fallback 那三刀看起来"正常"(有 agent 有 task 有并发), 所以它在盘古自己的
// 事件流里跟真拆解长得一模一样 —— 只有 task 前缀是「分析需求:」才认得出来。
// 括号配对扫描: 逐字符数 {} 深度, 跳过字符串字面量里的括号 (含转义引号)。
// 这样拿到的是**一个**完整 JSON 对象, 不受前后散文干扰。
// accept 是可选的形状判定: 同一段文本里可能有多段合法 JSON (比如先讲思路再给结果),
// 由调用方决定哪一段才算数 —— 所以这里不替调用方猜。
function _extractJsonObjects(text, accept) {
  const s = String(text || '');
  const out = [];
  if (!s) return out;
  for (let start = s.indexOf('{'); start !== -1; start = s.indexOf('{', start + 1)) {
    let depth = 0, inStr = false, esc = false, end = -1;
    for (let i = start; i < s.length; i++) {
      const ch = s[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { if (inStr) esc = true; continue; }
      if (ch === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i; break; }
      }
    }
    if (end === -1) continue;              // 这段没闭合 (典型: 被 max_tokens 截断), 试下一个 {
    try {
      const j = JSON.parse(s.slice(start, end + 1));
      if (j && typeof j === 'object' && !Array.isArray(j)) {
        if (typeof accept !== 'function' || accept(j)) out.push(j);
      }
    } catch (_) { /* 不是合法 JSON, 继续找下一个 { */ }
  }
  return out;
}

// planner 专用: 取第一个带非空 subTasks 的对象
function _extractPlanJson(text) {
  const hits = _extractJsonObjects(text, (j) => Array.isArray(j.subTasks) && j.subTasks.length > 0);
  return hits.length ? hits[0] : null;
}

function parsePlan(text, taskText) {
  const json = _extractPlanJson(text);

  if (json && Array.isArray(json.subTasks) && json.subTasks.length > 0) {
    return {
      ok: true,
      summary: 'Plan generated',
      pattern: json.pattern || 'general',
      // 角色名在这里归一成拼音 —— parsePlan 是**每一份** planner 产出的唯一漏斗
      // (真拆解和 fallback 都从这里出去), 所以归一放这一处就够, 下游拿到的
      // 一律是拼音。
      //
      // 为什么必须归一 (2026-10-18): 提示词历史里全是 analyzer/executor, 模型十次
      // 有几次就这么写。归一之前 `ROLES[subTask.agent]` 查不到 → 落到"未知角色"分支
      // → **降级成无白名单的全量工具**, 只读角色由此拿到写盘权, 日志只有一行 warn。
      // 认不出来的名字原样留着 (不猜成 kun): 错名字交给 validateTasks 报错,
      // 猜对一把错刀就会以合法身份真跑起来, 那比报错糟得多。
      subTasks: json.subTasks.map((t) => {
        if (!t || typeof t !== 'object') return t;
        const raw = String(t.agent == null ? '' : t.agent).trim().toLowerCase();
        const canon = raw ? resolveRole(raw) : null;
        return canon ? { ...t, agent: canon } : t;
      }),
      data: { goal: taskText, ...json }
    };
  }

  // fallback: 默认流程
  // 走到这里 = planner 这一刀白花了 (几十到几百秒), 而产物跟真拆解在事件流里长得一样。
  // 不喊出来就永远查不到 —— 上面那个现场就是这么被"拆了刀"的假象骗过去的。
  console.warn('[planner] ⚠️ 输出里没有可解析的 subTasks, 退回 3 刀默认流程 '
    + '(这不是拆解, 等于没人拆)。原文 ' + String(text || '').length + ' 字符, 前 300 字: '
    + JSON.stringify(String(text || '').slice(0, 300)));
  return {
    ok: true,
    summary: 'Fallback plan',
    pattern: 'general',
    subTasks: [
      { agent: 'li', task: '分析需求: ' + taskText },
      { agent: 'kun', task: '执行任务: ' + taskText },
      { agent: 'dui', task: '验证结果' }
    ],
    data: { goal: taskText, fallback: true, raw: text }
  };
}

async function runPlanner({ taskText, model, cfg, configPath, onProgress, reasoningEffort }) {
  // 2026-10-12 (现场 probe-art3-2143): planner 凭空编造"今天日期", 把错日期写进 task
  // 当权威指令传给 executor → executor 忠实写盘 + 伪造字节级证据自证。系统真实时间是唯一真源,
  // 提示层不给它就等于让模型猜。这里显式注入, 并明令不许编造事实性常量。
  let _timeBlock = '';
  try { _timeBlock = require('../modules/factual_anchor').timeAnchorBlock(); } catch (_) {}
  // 2026-10-16 (现场 longtask-234507 实测: 5 步长任务的 planner 165s 里 160s 在思考,
  // 7327 字 thinking 只换来 192 字 JSON 正文 —— planner 成了整条长任务链的头号瓶颈):
  // 提示词层预算指令**从来没到过 planner**。它在 llm_caller._reasoningBudgetInstruction,
  // 只挂在主链路的 soul 块上; 而 planner 走自己的 runPlanner, system prompt 是
  // `ROLES.kan.system + 时间块 + 拆任务铁律` —— 一条预算指令都没有。
  //
  // 为什么必须走提示词层: 本地模型的 reasoning_effort **字段**是空转的
  // (llm_caller 里有 N=5 实测: 字段发出去模型侧收不到, "No valid custom reasoning
  // fields found")。而 `_effortForRole('planner', ...)` 算出的 medium 只落在那个
  // 空转的字段上 —— 于是"给了预算"和"预算生效"是两回事。
  //
  // 挂之前先算 requestModel: 它已经带了 reasoningEffort, 复用同一份判定, 免得两处
  // 各算一遍然后对不上。
  const requestModel = ['off', 'low', 'medium', 'high'].includes(reasoningEffort)
    ? { ...model, reasoning_effort: reasoningEffort }
    : model;
  let _budgetBlock = '';
  try { _budgetBlock = require('../modules/llm_caller')._reasoningBudgetInstruction(requestModel) || ''; } catch (_) {}
  const messages = [
    { role: 'system', content: ROLES.kan.system + '\n\n' + _timeBlock
      + '\n\n【拆任务铁律】日期/时间/时区/文件绝对路径/数量这类**事实性常量**, '
      + '若主人没明说, 一律用上面的真实时间或让子 agent 调工具取 —— '
      + '**绝不许在 task 里编造一个具体值**。编造的常量会被下游当权威指令执行。'
      // 实测 (probe-date-fix-2146): 提示层说"不许编"不够 —— planner 会把 2026-10-12
      // 抄进 executor 的 task (对), 再抄进 checker 的 task 时转写成 2026-12-10 (年月日颠倒)。
      // 模型搬运日期字符串本身不可靠, 所以 task 里**只给锚点句式, 不给具体值**:
      // 让执行方从自己 system 里的【当前真实时间】取值, 杜绝二次转写。
      + '\n\n【task 写法 — 日期只给句式, 不给字面值】'
      + '每个子任务的 task 里, 涉及"今天/现在"时**写"当前真实日期"(照抄上面锚点里的说法), '
      + '不要把具体日期字符串抄进 task**。执行方的 system 里带着同一份【当前真实时间】, '
      + '它会自己取真值。你抄一遍就多一次转写错误的可能(实测把 2026-10-12 抄成了 2026-12-10)。'
      + '若主人原话里已经给了具体日期/路径, 照抄主人原话, 不许改动或"规范化"。'
      // 预算指令排最后 —— 越靠近 user 消息越压得住 (llm_caller 里的同一条注释,
      // 讲的是提示词缓存: 易变块要垫在静态前缀之后)。这里不涉及缓存, 但
      // "离 user 近 = 权重高" 这条经验一致。
      + (_budgetBlock ? '\n\n' + _budgetBlock : '') },
    { role: 'user', content: taskText }
  ];
  // 2026-10-16: planner 走的是**自己的** runPlanner, 不经过 runAgentLoop —— 所以
  // 主调用点接了 onTick 还不够, 这里漏了就等于 planner 仍然是非流式阻塞,
  // 仍然会在本地慢模型上被 300s 墙砍掉 (现场: "Planner failed: LLM timeout")。
  // 而 planner 恰恰是主人唯一看不见"在干什么"的那几分钟。
  const response = await callLLM(messages, requestModel, [], {
    mode: 'kan',
    onTick: (e) => { if (onProgress) onProgress(e); },
  });
  // 2026-09-16 老板拍: 子 agent 按职能配工具 — planner 无工具, 保持纯 JSON 输出
  return parsePlan(response.text, taskText);
}

async function run({ taskText, mode = 'kun', configPath, onProgress, res, sessionId, toolsAllowed, reasoningEffort, images, directAnswer, anchorTime, mainModel, contextSeed, parentSessionId }) {
  // 2026-10-18 拼音统一 (第二次): mode 可能来自历史会话 / 旧调用点。
  //
  // 旧写法是 `resolveRole(mode) || mode` —— 认不出来就把原始字符串留着。英文身份
  // 删掉之后这个写法变危险了: 认不出的名字会一路传进 permCtx.agent, 而只读守卫
  // 对认不出的角色名是 **fail-closed** (按只读处理) —— 于是这个实际上正跑着 ROLES.kun
  // 的 agent, 却被守卫当成只读角色挡住写盘。角色跑对了、权限却错了, 极难查。
  //
  // 所以兜底必须是**一个真角色**, 不是原样透传: 认不出 = 就是 kun。
  // 这样下游拿到的 mode 永远是 8 将灵之一, 守卫和实际行为永远一致。
  mode = require('./gua-identity').resolveRole(mode) || 'kun';
  // 2026-09-16 老板拍: 子 agent 按职能配工具 — toolsAllowed (dispatcher 按 ROLES.tools 注入) 透传给 runAgentLoop
  const cfg = loadConfig(configPath);
  // 2026-09-14 (老板拍: 将灵配角色专属模型): 按角色档位选模型 (fast/standard/smart), 子 agent 温度钉 0
  // 兜底 = 当前在用模型, 绝不让子 agent 没模型跑
  let model;
  try {
model = require('../modules/role_model').resolveRoleModel(cfg, mode, mainModel) || mainModel || getEnabledModel(cfg);
  } catch (_) { model = getEnabledModel(cfg); }
  if (!model) throw new Error('No model available');
  if (['off', 'low', 'medium', 'high'].includes(reasoningEffort)) {
    model = { ...model, reasoning_effort: reasoningEffort };
  }
  if (model._role_model) console.log('[sub-agent] ' + mode + ' → ' + model.id + ' (tier=' + (model._role_model.tier || '?') + ', temp=0)');

  if (mode === 'kan' || mode === 'qian') {
    return runPlanner({ taskText, model, cfg, configPath, onProgress, reasoningEffort });
  }

  if (mode === 'zhen') {
    const messages = [
      { role: 'system', content: ROLES.zhen.system },
      { role: 'user', content: taskText }
    ];
    const response = await callLLM(messages, model, []);
    return { ok: true, mode, summary: response.text, data: { finalText: response.text } };
  }

  // 2026-09-14: 将灵页 role_configs 进运行时 (步数预算/并行/记忆开关)
  let roleCfg = {};
  try { roleCfg = require('../modules/role_model').roleConfig(cfg, mode); } catch (_) {}
  return await runAgentLoop({ taskText, mode, model, cfg, configPath, onProgress, roleCfg, res, sessionId, toolsAllowed, images, directAnswer, anchorTime, contextSeed, parentSessionId });
}

// CLI 入口
if (require.main === module) {
  const taskText = process.argv[2] || process.argv[1] || '';
  const mode = process.env.PANGU_AGENT_MODE || 'kun';
  // 节点配置路径 —— 不写死任何人的机器名 (2026-10-26 第 109 批)。
  //   CLI 独立跑时没有 pangu-single 传进来的 CONFIG_PATH, 自己解析一份。
  const configPath = process.env.PANGU_CONFIG_PATH
    || require('../config/node_config').resolveNodeConfigPathOrEmpty()
    || require('../config/node_config').resolveNodeConfigPathOrExample();

  run({ taskText, mode, configPath, onProgress: (e) => console.error('[progress]', JSON.stringify(e)) })
    .then(r => { console.log(JSON.stringify(r)); process.exit(0); })
    .catch(e => { console.error(e.stack || e.message); process.exit(1); });
}

// 2026-09-18: 所有将灵 system 统一挂工具箱意识 (执行类最常用)
for (const _k of Object.keys(ROLES)) {
  if (ROLES[_k].system) ROLES[_k].system = ROLES[_k].system + _SKILL_AWARE;
}
// 2026-10-17: 批量取证规则。**planner 不挂** —— 它的 tools 是空的, 从不发工具调用,
// 给它一条"一轮多发几个工具"是纯噪音, 而 planner 提示词每多一行都在主链路的
// prefill 里乘一次 (现场 9k~12k inputTokens)。只挂真的会调工具的将灵。
for (const _k of Object.keys(ROLES)) {
  // 判据是**有没有工具**, 不是它叫什么名字 (2026-10-18 实测: 这里原来写死
  // `if (_k === 'planner') continue`, 而键早就换成拼音 'kan' 了 → 那条 continue
  // 永远不成立 → 坎被挂上了这条只对会调工具的角色有意义的规则, 它的 tools 明明是空的。
  // 写死名字的判据在改名那一刻就静默失效了, 而且 E1 那条守卫正好被同一个失效盖住,
  // 一起变绿 —— 判据必须落在**行为事实**上。
  if (!Array.isArray(ROLES[_k].tools) || ROLES[_k].tools.length === 0) continue;
  if (ROLES[_k].system) ROLES[_k].system = ROLES[_k].system + _BATCH_AWARE;
}

module.exports = { run, runAgentLoop, callLLM, _nativeTools, _nativeCallsFrom, _assistantMessage, _fixAssistantToolMessages, _sanitizePairs, loadConfig, getEnabledModel, ROLES, GUA_ROLES, GUA_BY_CODE, extractToolCalls, executeTool, normalizeToolArgs, stripToolMarkup, _prepareMessagesForModel, parsePlan, _extractPlanJson, _extractJsonObjects };
