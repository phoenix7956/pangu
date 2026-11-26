'use strict';
/**
 * tools_schema/plan_goal_session.js —— 工具参数 Schema 的一段 (第 97 批从 tools_schema.js 拆出)
 *
 * 拆分纪律 (三条, 一条都不能破):
 *   1. **顺序不变** —— 工具顺序会进 LLM 提示词, 分段必须连续、合并必须按序
 *   2. **内容逐字不变** —— 守卫 tests/tools-schema-split-20261025.test.js 用
 *      拆分前抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对
 *   3. **不改词表** —— 这里只放 schema, 一行语义都不许动
 */

const { _GUA_ROLE_PROMPT } = require('./_gua_roles');

module.exports = {
task_done: {
  type: 'function',
  function: {
    name: 'task_done',
    // 2026-07-26 老板拍 (截图: 自我介绍答案进了思考折叠区, 正文只剩 metrics 汇报):
    // summary 语义 = 对主人问题的**完整答复本身**, 不是"做了什么+结果"的过程汇报
    description: 'Pangu Agent Loop 任务完成工具。**只有当你已经走完所有必要的步骤、拿到结果、要给主人最终答案时,才能调这个工具**。调完后会立刻退出 loop,主人看到的就是 summary。\n\n**summary 铁律**:\n1. summary 是对主人问题的**完整答复本身**, 自包含 — 主人只看 summary 就必须得到满足, 不需要看任何中间过程。\n2. 主人问知识/介绍/分析类问题时, summary 就是完整的答复正文 (可以很长, 该写多长写多长)。\n3. **禁止**只写"我调了 X 工具, 结果是 Y"这种过程汇报 — 工具数据是用来支撑答复的, 不是答复本身。\n4. 如果你前面的流式文本已经是完整答复, 把那份答复原样放进 summary (不要改写不要缩写)。\n\n**不准在**: 只完成一半任务时调 (主人看不到中间过程)。\n\n参数:\n- summary: 对主人问题的完整答复 (必填)\n- pending: (可选)如果还有未完成项,列在这里 — 这样 Pangu 会继续 loop 而不是退出。但一般不用。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '对主人问题的完整答复 (必填, 自包含, 禁止过程汇报)' },
        pending: { type: 'array', items: { type: 'string' }, description: '未完成项(可选)' },
        status: { type: 'string', enum: ['completed','partial','failed'], description: '2026-08-16 P1-1 outcome 跟踪 (新政 #1 闭环交付), 默认 completed' },
        artifacts: { type: 'array', description: '本次任务产出的 artifact 列表 [{type, path, summary}], 用于新政 #1 闭环交付统计' },
        metrics: { type: 'object', description: '业务指标 {tokens_in, tokens_out, rounds, files_written, api_calls} (P1-1 outcome)' }
      },
      required: ['summary']
    },
    meta: { required_capabilities: ['system'] }
  }
  },
plan_approve: {
  type: 'function',
  function: {
    name: 'plan_approve',
    description: '批准 Pangu 生成的 plan. 调后其他 tool 才执行 (P0-#1).',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'SSE event:plan 含的 plan_id (必填)' },
      },
      required: ['plan_id'],
    },
    meta: { required_capabilities: ['system'] }
  },
  },
plan_reject: {
  type: 'function',
  function: {
    name: 'plan_reject',
    description: '拒绝 Pangu 生成的 plan, 必填 reason 说明 (P0-#1).',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'plan_id (必填)' },
        reason: { type: 'string', description: '拒绝原因 (必填, 记 audit trail)' },
      },
      required: ['plan_id', 'reason'],
    },
    meta: { required_capabilities: ['system'] }
  },
  },
plan_status: {
  type: 'function',
  function: {
    name: 'plan_status',
    description: '查询 plan 当前状态 (pending/approved/rejected), 返 audit trail (P0-#1)。**字段名是 plan_id, 不是 task_id/id** — handler 读 params.plan_id, 缺则返 NO_PLAN_ID。',
    parameters: {
      type: 'object',
      properties: {
        plan_id: { type: 'string', description: 'plan_id (handler 只认 plan_id, 不是 task_id/id/planId). 来自 initial_assessment 或 plan_approve 的返回值' },
      },
      required: ['plan_id'],
    },
    meta: { required_capabilities: ['system'] }
  },
  },
plan_create: {
  type: 'function',
  function: {
    name: 'plan_create',
    description: '创建/替换 Plan — 拆任务成结构化步骤 (goal + steps + DoD)。长任务/多文件任务必须在第一次调 tool 之前先调这个。',
    parameters: {
      type: 'object',
      properties: {
        goal: { type: 'string', description: '一句话目标 (必填)' },
        steps: { type: 'array', items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '步骤 ID (例 s1)' },
            title: { type: 'string', description: '步骤标题 (≤200 字)' },
            dod: { type: 'string', description: 'DoD (Definition of Done, 可验证验收标准, ≤500 字)' },
            // 2026-10-18: 这段描述是**喂给 LLM 的提示词**, 原来列的是上一代英文 code
            // (dispatcher/analyzer/executor/...), 而运行时只认拼音 —— 模型照着这段学,
            // 学的就是一套永远被丢弃的名字。跟 dispatch_rules 那个坑同源: 模板教的名字
            // 和 allowed 集合不是同一个。
            // 现在从身份真源生成 (拼音 + 卦名 + 职责), 手抄的表迟早又漂移。
            agent: { type: 'string', description: `本步归属的将灵 code (拼音, 只认这 8 个): ${_GUA_ROLE_PROMPT().join(' / ')}。不确定可省略, 默认按工具名归属` },
          },
          required: ['title']
        }, description: '步骤清单 (≥1)' },
      },
      required: ['goal', 'steps']
    },
    meta: { required_capabilities: ['system'] }
  }
  },
plan_step_done: {
  type: 'function',
  function: {
    name: 'plan_step_done',
    description: '标记某步骤 done — DoD 验证通过后调用, evidence 必填 (文件/测试输出路径)。',
    parameters: {
      type: 'object',
      properties: {
        step_id: { type: 'string', description: '步骤 ID (例 s1)' },
        evidence: { type: 'string', description: '完成证据 (文件路径/测试输出/实际值, ≤1000 字)' },
      },
      required: ['step_id', 'evidence']
    },
    meta: { required_capabilities: ['system'] }
  }
  },
plan_step_failed: {
  type: 'function',
  function: {
    name: 'plan_step_failed',
    description: '标记某步骤 failed — reason 必填 (为什么做不下来)。',
    parameters: {
      type: 'object',
      properties: {
        step_id: { type: 'string', description: '步骤 ID' },
        reason: { type: 'string', description: '失败原因 (≤500 字)' },
      },
      required: ['step_id', 'reason']
    },
    meta: { required_capabilities: ['system'] }
  }
  },
plan_view: {
  type: 'function',
  function: {
    name: 'plan_view',
    description: '查看当前 plan 状态 (progress / current_step / done 列表)。',
    parameters: { type: 'object', properties: {} },
    meta: { required_capabilities: ['system'] }
  }
  },
goal_set: {
  type: 'function',
  function: {
    name: 'goal_set',
    description: '设/换持久目标 — 跨 turn 跟踪, LLM 每轮收到 reminder 直到 complete。',
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: '目标文本 (≤500 字)' },
        priority: { type: 'string', enum: ['low', 'normal', 'high'], description: '默认 normal' },
      },
      required: ['text']
    },
    meta: { required_capabilities: ['system'] }
  }
  },
goal_progress: {
  type: 'function',
  function: {
    name: 'goal_progress',
    description: '上报目标进度 (完成节点/阶段结果)。',
    parameters: {
      type: 'object',
      properties: {
        note: { type: 'string', description: '进度说明 (≤500 字)' },
      },
      required: ['note']
    },
    meta: { required_capabilities: ['system'] }
  }
  },
goal_complete: {
  type: 'function',
  function: {
    name: 'goal_complete',
    description: '完成目标 — summary 必填。',
    parameters: {
      type: 'object',
      properties: {
        summary: { type: 'string', description: '完成总结' },
      },
      required: ['summary']
    },
    meta: { required_capabilities: ['system'] }
  }
  },
checkpoint_create: {
  type: 'function',
  function: {
    name: 'checkpoint_create',
    description: 'Pangu 改文件前打 checkpoint (git stash + audit json). 改坏可用 checkpoint_rollback 回滚 (P0-#33).',
    parameters: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'checkpoint 描述 (默认 auto-checkpoint-{id})' },
        files: { type: 'array', items: { type: 'string' }, description: '指定文件 (默认 git add -A, 必须全在 Pangu repo 内)' },
      },
    },
    meta: { required_capabilities: ['code_execution'] }
  },
  },
checkpoint_list: {
  type: 'function',
  function: {
    name: 'checkpoint_list',
    description: '列最近 N 个 checkpoint (按 created_at desc) (P0-#33).',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '默认 20' },
      },
    },
    meta: { required_capabilities: ['code_execution'] }
  },
  },
checkpoint_rollback: {
  type: 'function',
  function: {
    name: 'checkpoint_rollback',
    description: '回滚到指定 checkpoint (P0-#33).',
    parameters: {
      type: 'object',
      properties: {
        checkpoint_id: { type: 'string', description: 'checkpoint id (必填, cp_2026..._xxx)' },
        force: { type: 'boolean', description: '默认 false, true 跳过确认' },
      },
      required: ['checkpoint_id'],
    },
    meta: { required_capabilities: ['code_execution'] }
  },
  },
session_save: {
  type: 'function',
  function: {
    name: 'session_save',
    description: '保存 session 状态到 ~/.pangu-data/sessions JSON fallback + ~/.pangu-data/agentdb SQLite/HNSW.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'session id (必填)' },
        plan_id: { type: 'string', description: '当前 plan_id (可选)' },
        messages: { type: 'array', items: { type: 'object' }, description: '对话消息 list' },
        compaction_summary: { type: 'string', description: 'TL-6 摘要' },
        state: { type: 'string', enum: ['active', 'paused', 'completed'], description: '默认 active' },
        ts: { type: 'number', description: '时间戳 (默认 now)' },
      },
      required: ['session_id', 'messages'],
    },
    meta: { required_capabilities: ['system'] }
  },
  },
session_load: {
  type: 'function',
  function: {
    name: 'session_load',
    description: '优先从 ~/.pangu-data/agentdb SQLite 读完整 session；不可用时降级 JSON fallback.',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'session id (必填)' },
      },
      required: ['session_id'],
    },
    meta: { required_capabilities: ['system'] }
  },
  },
session_recall: {
  type: 'function',
  function: {
    name: 'session_recall',
    description: '语义召回历史 session. AgentDB 优先走 HNSW, 索引或 embedding 不可用时自动降级 SQLite 关键词搜索.',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '要回忆的问题或关键词' },
        k: { type: 'number', description: '返回条数, 默认 5, 最大 20' },
      },
      required: ['query'],
    },
    meta: { required_capabilities: ['system'] }
  },
  },
tools_selftest: {
  type: 'function',
  function: {
    name: 'tools_selftest',
    description: 'GUI/系统工具自检 — 逐个探测 computer_use / screenshot / record_audio / permission 等工具能不能真跑 (cliclick/vision 端点/权限), 返回逐项 ok/fail 清单.',
    parameters: {
      type: 'object',
      properties: {
        only_failed: { type: 'boolean', description: '只看失败项, 默认 false' },
        targets: { type: 'array', items: { type: 'string' }, description: '指定要测的工具名, 默认全套 GUI 工具' },
      },
    },
    meta: { required_capabilities: ['system'] }
  },
  },
session_list: {
  type: 'function',
  function: {
    name: 'session_list',
    description: '列最近 N 个 session (按 last_updated desc) (P0-#34).',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: '默认 20' },
      },
    },
    meta: { required_capabilities: ['system'] }
  },
  },
session_delete: {
  type: 'function',
  function: {
    name: 'session_delete',
    description: '删除 session (P0-#34).',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: 'session id (必填)' },
      },
      required: ['session_id'],
    },
    meta: { required_capabilities: ['system'] }
  },
  },
};
