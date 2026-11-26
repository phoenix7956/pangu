'use strict';
/**
 * tools_schema/gua_trend.js —— 工具参数 Schema 的一段 (第 97 批从 tools_schema.js 拆出)
 *
 * 拆分纪律 (三条, 一条都不能破):
 *   1. **顺序不变** —— 工具顺序会进 LLM 提示词, 分段必须连续、合并必须按序
 *   2. **内容逐字不变** —— 守卫 tests/tools-schema-split-20261025.test.js 用
 *      拆分前抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对
 *   3. **不改词表** —— 这里只放 schema, 一行语义都不许动
 */

module.exports = {
    gua_cast: {
      type: 'function',
      function: {
        name: 'gua_cast',
        description: '起卦 (3 数法)',
        parameters: {
          type: 'object',
          properties: {
            question: { type: 'string', description: '所占之事 (主人的问题)' },
            numbers: { type: 'array', items: { type: 'number' }, description: '数字起卦: 主人报的三个数 [n1, n2, n3] (n1→上卦, n2→下卦, n3→动爻)。报了必传, 没报不传 (走时间起卦)' }
          },
          required: []
        }
      }
    },
    hexagram_lookup: {
      type: 'function',
      function: {
        name: 'hexagram_lookup',
        // 2026-10-21 (老板原话「64卦有一个最大的坑, 不是 1~64 是 0~63」):
        //   两套编号在 1..63 上完全重叠, 所以**必须**在描述里把基数写死,
        //   不能指望模型猜。这里写的是 id 那一套 (文王卦序, 乾=1 坤=2)。
        description: '查 64i 真源 (64 卦完整数据: 卦辞/爻辞/八宫/纳甲/五行/nature/keywords)。整理/对比 64 卦第一动作 = 先查这里, 不从 extracted/ 推算。传 query=卦名(如"讼") 或卦序数字; 不传或传 "list" 返回全部。'
          + '⚠️ 数字一律是**卦序 1..64**(文王卦序: 乾=1 坤=2 屯=3 蒙=4 … 既济=63 未济=64), 不是 0..63(那套是 坤=0 乾=63) —— 传进来会被明确报错, 不悄悄返回另一卦。'
          + '⚠️ xiang_name=卦象名(山火贲), nature=卦义(贲饰), 别混。'
          + '问"第N卦是哪一卦 / 卦辞爻辞 / 卦序编号 / 上下卦" → 第一个动作就调这里, 不要搜网, 也不要用 exec_command grep 源文件 (实测: 派 2 个子 agent 用 22 次 shell, ~80 秒); 要引出处就引结果里的 source_ref。',
        parameters: {
          type: 'object',
          properties: {
            query: { type: 'string', description: '卦名 (如"讼"/"乾") 或**卦序 1..64** 的数字 (可写字符串)。不传 = 列全部 64 卦' }
          },
          required: []
        }
      }
    },
    wuxing_judge: {
      type: 'function',
      function: {
        name: 'wuxing_judge',
        // 2026-10-22 (老板原话「就拿八字排盘…但是这用在项目上, 加强了停顿, 走一步判断一步,
        //   而且挂永远没有100%」):
        //   这是「生彼泻克耗」用在**非八字**事情上的唯一入口。以前这套内核只能从
        //   bazi_calc 顺带出来, 于是「用在项目上」这句话盘古执行不了。
        //
        //   描述里写清三件事: 什么时候调 / 怎么填 / 结果怎么用。
        //   ⚠️ 「提示里的词会被模型原样搬去当开篇标签」(10-21 实跑教训) ——
        //   所以这里只描述**什么时候调**和**怎么填**, 不描述答案该长什么样。
        // ⚠️ 描述长度是**有预算的**: 2026-10-16 实测 (tests/cloud-reasoning-budget-20261016
        //   T10) li 角色的工具 schema 每刀都要带一遍, 超过 9000 字符那条守卫就红。
        //   第一版这里写了 718 字符, 把 li 的 schema 从 7962 顶到 9329 —— 直接把守卫顶穿。
        //   所以: 描述只留「什么时候调 / 怎么填 / 结果怎么用」三件事, 其余全删。
        description: [
          '六格判局 —— 用「生彼泻克耗」给**一件事**出结构判断 (项目/决策/取舍/该不该继续)。',
          '【何时调】主人问「这事该继续还是该停 / 优先级怎么排 / 卡在哪」这类**判断题**时;「该怎么干」是执行题, 不调。',
          '【怎么填】你只列条目, 判据由内核算, **不许自己下结论**:',
          '  subject(必填)=这件事=彼; resources=生我者(手上的助力); outputs=我生者(已产出);',
          '  blockers=克我者(阻力); targets=我克者(要啃的); peers=同我者(平级协作, 不参与停点, 可不填)。',
          '  每格 0 条=不成立, 1~2 条=弱, 3 条以上=强 → 条目要具体(「缺 X 权限」算,「资源不足」不算)。',
          '【结果】六格分档 + 停点: 停(没料也没得啃, 别硬撑) / 换向(阻力压着没产出, 先解阻力) / 续(按可攻克项走, 下轮再判)。',
          '  永不 100%, 是参考不是断言; 一条没列内核会拒给结论。',
        ].join('\n'),
        parameters: {
          type: 'object',
          properties: {
            subject: { type: 'string', description: '这件事是什么 (彼)。必填' },
            resources: { type: 'array', items: { type: 'string' }, description: '生我者: 手上的助力' },
            outputs: { type: 'array', items: { type: 'string' }, description: '我生者: 已产出' },
            blockers: { type: 'array', items: { type: 'string' }, description: '克我者: 阻力' },
            targets: { type: 'array', items: { type: 'string' }, description: '我克者: 要啃的' },
            peers: { type: 'array', items: { type: 'string' }, description: '同我者: 平级/协作' },
          },
          required: ['subject']
        }
      }
    },
    risk_assessment: {
      type: 'function',
      function: {
        name: 'risk_assessment',
        description: '[真起卦 · 梅花易数] 风险评估 — 梅花易数真起卦, 基于真动爻位置 (高位=高风险) + 384 爻词评估行动风险\n\n调用的时机:\n- 主人明确说"算一卦/用易经看"\n- 或主人偏好启用\n\n默认: 不调, 走 LLM 自身判断。\n输出: 总结必须引用真卦辞/动爻爻词 (gua 字段), 让主人看到真凭实据。',
        parameters: {
          type: 'object',
          properties: {
          context: { type: 'string', description: '任务背景/上下文 (给执行者看的补充信息)' },
          params: { type: 'string', description: '参数 (JSON 字符串)' }
        },
          required: ['context']
        }
      }
    },
    momentum_assessment: {
      type: 'function',
      function: {
        name: 'momentum_assessment',
        description: '[真起卦 · 梅花易数] 势头评估 — 梅花易数真起卦, 基于真动爻位置 (五爻=鼎盛/上爻=转衰) + 384 爻词评估当前势头\n\n调用的时机:\n- 主人明确说"算一卦/用易经看"\n- 或主人偏好启用\n\n默认: 不调, 走 LLM 自身判断。\n输出: 总结必须引用真卦辞/动爻爻词 (gua 字段), 让主人看到真凭实据。',
        parameters: {
          type: 'object',
          properties: {
          context: { type: 'string', description: '任务背景/上下文 (给执行者看的补充信息)' },
          skill: { type: 'string', description: '技能名' }
        },
          required: ['context']
        }
      }
    },
    main_force_analysis: {
      type: 'function',
      function: {
        name: 'main_force_analysis',
        description: '主力分析 - 分析主力动向',
        parameters: {
          type: 'object',
          properties: {
          context: { type: 'string', description: '任务背景/上下文 (给执行者看的补充信息)' },
          params: { type: 'string', description: '参数 (JSON 字符串)' }
        },
          required: ['context']
        }
      }
    },
    peak_judgment: {
      type: 'function',
      function: {
        name: 'peak_judgment',
        description: '峰值判断 - 判断是否达到峰值',
        parameters: {
          type: 'object',
          properties: {
          context: { type: 'string', description: '任务背景/上下文 (给执行者看的补充信息)' },
          skill: { type: 'string', description: '技能名' }
        },
          required: ['context']
        }
      }
    },
    full_deployment: {
      type: 'function',
      function: {
        name: 'full_deployment',
        description: '全面部署 - 执行全面部署',
        parameters: {
          type: 'object',
          properties: {
          context: { type: 'string', description: '任务背景/上下文 (给执行者看的补充信息)' },
          params: { type: 'string', description: '参数 (JSON 字符串)' }
        },
          required: ['context']
        }
      }
    },
    peak_detection: {
      type: 'function',
      function: {
        name: 'peak_detection',
        description: '峰值检测 - 检测峰值信号',
        parameters: {
          type: 'object',
          properties: {
          context: { type: 'string', description: '任务背景/上下文 (给执行者看的补充信息)' },
          skill: { type: 'string', description: '技能名' }
        },
          required: ['context']
        }
      }
    },
    reversal_signal: {
      type: 'function',
      function: {
        name: 'reversal_signal',
        description: '反转信号 - 检测反转信号',
        parameters: {
          type: 'object',
          properties: {
          context: { type: 'string', description: '任务背景/上下文 (给执行者看的补充信息)' },
          params: { type: 'string', description: '参数 (JSON 字符串)' }
        },
          required: ['context']
        }
      }
    },
    withdrawal_plan: {
      type: 'function',
      function: {
        name: 'withdrawal_plan',
        description: '撤退计划 - 制定撤退计划',
        parameters: {
          type: 'object',
          properties: {
          context: { type: 'string', description: '任务背景/上下文 (给执行者看的补充信息)' },
          skill: { type: 'string', description: '技能名' }
        },
          required: ['context']
        }
      }
    },
    graceful_exit: {
      type: 'function',
      function: {
        name: 'graceful_exit',
        description: '优雅退出 - 执行优雅退出',
        parameters: {
          type: 'object',
          properties: {
          context: { type: 'string', description: '任务背景/上下文 (给执行者看的补充信息)' },
          params: { type: 'string', description: '参数 (JSON 字符串)' }
        },
          required: ['context']
        }
      }
    },
};
