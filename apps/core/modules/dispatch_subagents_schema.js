// ============================================================================
// dispatch_subagents — 主 agent (乾) 的编排工具
// ============================================================================
//
// 老板原话 (2026-10-17): 「乾就应该把任务拆了, 分下去, 子agent只做自己相关的,
// 做好汇报, 这个跟你应该是一样的。」
//
// 立这个工具前的事实 (已核实, 别重新推导):
//   MAIN_GENERAL_TOOLS_FOR_LLM 里**没有 plan_create 也没有任何派活工具** ——
//   主 agent 完全够不着编排能力。于是"该不该派活"是 j2_dispatcher 里四个
//   正则/启发式说了算 (直答短路 → 规则快路 _fastPlanFor → 坎·planner →
//   关键词兜底), 主循环只是最后兜底。
//   结果是: 长任务里主 agent 只能自己单线程硬啃, 没人拆、没人并行、没人汇报 ——
//   老板说的"跟死了一样"。
//
// 这个工具怎么执行: **不在 tools/index.js 里**。tools 的 ctx 只有
// { user, sessionId } —— 没有 res / model / configPath, 拿不到派发要的东西。
// 所以由 j2_agent_loop 主循环**拦截**它, in-process 调 subagent_runner
// (与 dispatcher 同一份实现), 结果作为 tool result 回给主 agent,
// 主 agent 拿着结果继续自己的 loop 综合出最终答复 —— 就是 Codex 的模式。
//
// 为什么不让子 agent 互相派活 (递归派发): 没有深度闸门时这是 token 黑洞 ——
// 一个 executor 完全可以自己再拆三个 executor, 子会话的 abort 域和账本
// 都会失控。深度锁 1 层: 子 agent 的白名单里根本没有这个工具。

const ROLES_HINT = [
  // 2026-10-25 (第 82 批): 这里原来写的是**英文名** (analyzer/executor/checker/…),
  //   而同一份 schema 下面的 enum 是**拼音** (li/kun/dui/xun/zhen/gen) ——
  //   两套名字摆在同一个工具描述里。模型照 hint 写英文 → enum 校验不过 →
  //   整刀失败; 模型照 enum 写拼音 → hint 里的职责说明它没读到。
  //   职责从 GUA_ROLES 取真源, 不手抄第二份 (同 enum 那条注释的道理)。
  'li 离(读) — 只读取证/搜索/分析 (读文件、查资料、给结论), **不许写盘**',
  'kun 坤(做) — 确定性执行 (写文件、跑命令、生成产物)',
  'dui 兑(验) — 独立验收 (必须给出 PASS 或 FAIL 明确结论, 别含糊)',
  'xun 巽(找雷) — 扫描缺陷/安全隐患',
  'zhen 震(复盘) — 复盘总结',
  'gen 艮(记) — 学习沉淀到记忆',
].join('\n');

const TOOL = {
  type: 'function',
  function: {
    name: 'dispatch_subagents',
    description: [
      '**把活拆下去并行干** — 你 (主 agent) 自己决定怎么拆、派给谁、派几刀。',
      '',
      '**什么时候该用**: 主人交给你一件能拆成 2 个以上互不相干的子任务, 而且',
      '一件事一个人干要很久。典型: 「分别分析这三个文件」「查一下 A 再查一下 B」',
      '「先扫描再修再验证」「把这三个模块都过一遍」。',
      '',
      '**什么时候不该用**: ① 一句话就能答完的事; ② 拆出来的刀会互相覆盖写同一个',
      '文件 (那是分工灾难, 不如自己串行做); ③ 主人明说别派活。',
      '',
      '**分工铁律 (违反就是白烧 token)**:',
      '- 每一刀的 task 必须是**自足的**: 写清要做什么、看哪些路径、交付什么。',
      '  子 agent 拿到的是**你这一刀**, 不是主人的原话全文。',
      '- 路径要**逐字**照抄主人的原话, 不许用你自己的 cwd 顶替。',
      '- 并列互不相干的刀, depends_on 留空数组 (它们会自动并行);',
      '  后一刀要用前一刀的结论, 就写 depends_on: [前一刀的下标]。',
      '- **别自己顺手把整件事做了**。你派了活就等它们回来, 拿着汇报综合答复。',
      '',
      '**可用角色**:',
      ROLES_HINT,
      '',
      '**返回**: 每个角色的汇报 + 产出 artifact 路径 + 失败原因 (如果有)。',
      '汇报是子 agent 的一手判断, 不是工具原始 JSON —— 基于它综合, 别重推一遍。',
      '',
      '**派几刀由你判断**: 互不相干的才拆, 能一刀做完的别拆。',
      '并发按**这一轮实际跑的端点**自动取额: 本地模型单卡只能同时解 1 路, 超过的自动排队; '
        + '云端同时 3 路。排队的刀会先给你报一声, 不是卡死。',
      '所以主模型在本地时, 一次拆 5 刀不会更快 —— 5 刀要排队跑完, 等待时间比拆 2 刀长得多。',
      '本地端点上, **2~3 刀是合适的量**; 云端端点可以拆到 4~5 刀。',
    ].join('\n'),
    parameters: {
      type: 'object',
      properties: {
        tasks: {
          type: 'array',
          minItems: 2,
          maxItems: 6,
          description: '要派的刀。至少 2 个 —— 一件事不该派活。',
          items: {
            type: 'object',
            properties: {
              agent: {
                type: 'string',
                // 拼音就是唯一身份, 模型看到什么名字它就写什么名字回来。
                // 这里留英文 (2026-10-18 前) 的直接后果: enum 说 analyzer,
                // ROLES 里是 li → 主 agent 照 enum 派活 → 落到一个没有 system prompt
                // 的空角色。enum 必须是 ROLES 真源的投影, 不许手抄第二份。
                enum: ['li', 'kun', 'dui', 'xun', 'zhen', 'gen'],
                description: '这一刀派给谁',
              },
              task: {
                type: 'string',
                description: '这一刀的自足任务书: 做什么 / 看哪些绝对路径 / 交付什么。不许写「同上」「按上面」。',
              },
              depends_on: {
                type: 'array',
                items: { type: 'integer' },
                description: '依赖的前序刀下标 (从 0 开始)。互不相干就留空数组 —— 会并行跑。',
              },
            },
            required: ['agent', 'task'],
          },
        },
        reason: {
          type: 'string',
          description: '一句话说明为什么这么拆 (主人会看到状态行)。可选。',
        },
      },
      required: ['tasks'],
    },
  },
};

// 派活结果 → 回灌给主 agent 的 tool result 文本。
// 汇报在前、工具证据次之 —— 这条顺序是 2026-10-16 现场改的: 旧码优先用原始
// toolHistory, 于是**只要子 agent 干了活, 它写的汇报就被丢掉**, 父 agent 拿着
// 同一批工具 JSON 再推一遍结论 (更贵, 而且没有子的一手判断只能靠猜)。
function renderDispatchResult(results, opts) {
  const o = opts || {};
  const list = Array.isArray(results) ? results : [];
  if (!list.length) {
    return { ok: false, content: 'DISPATCH_EMPTY: 一个子 agent 都没起来。检查 tasks 参数。' };
  }
  const blocks = list.map((r) => {
    const head = '【' + (r.agent || 'agent') + '】任务: ' + String(r.task || '').slice(0, 200);
    if (r.error) {
      return head + '\n状态: 失败 — ' + String(r.error).slice(0, 300)
        + '\n【怎么办】别替它编结论。要么基于已有产出如实说这一步没跑成, 要么换个角色/换个路径再派一次。';
    }
    const summary = String((r.result && r.result.summary) || '').slice(0, o.perAgentChars || 1200);
    const artifacts = Array.isArray(r.result && r.result.artifacts) ? r.result.artifacts : [];
    const artLine = artifacts.length
      ? '\n产出(已落盘, 详情用 read_file 按路径取): ' + artifacts.map((a) => (a && a.path) || a).join(', ')
      : '';
    const tools = Array.isArray(r.result && r.result.toolsUsed) ? r.result.toolsUsed : [];
    const toolLine = tools.length ? '\n用过的工具: ' + tools.join(', ') : '';
    return head
      + '\n状态: ' + ((r.result && r.result.runtimeStatus) || 'done')
      + '\n汇报:\n' + (summary || '(子 agent 没交汇报 —— 别替它补, 按下面的产出路径自己 read_file 取)')
      + artLine + toolLine;
  });
  const failed = list.filter((r) => r.error).length;
  const head = failed
    ? '派了 ' + list.length + ' 刀, ' + failed + ' 刀失败。下面是每刀的一手汇报 —— 综合时如实反映失败, 不许粉饰。'
    : '派了 ' + list.length + ' 刀, 全部完成。下面是每刀的一手汇报。';
  return {
    ok: failed === 0,
    content: head + '\n\n' + blocks.join('\n\n---\n\n'),
  };
}

module.exports = { TOOL, renderDispatchResult };
