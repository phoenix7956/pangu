'use strict';
/**
 * tools_schema/decision_signals.js —— 工具参数 Schema 的一段 (第 97 批从 tools_schema.js 拆出)
 *
 * 拆分纪律 (三条, 一条都不能破):
 *   1. **顺序不变** —— 工具顺序会进 LLM 提示词, 分段必须连续、合并必须按序
 *   2. **内容逐字不变** —— 守卫 tests/tools-schema-split-20261025.test.js 用
 *      拆分前抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对
 *   3. **不改词表** —— 这里只放 schema, 一行语义都不许动
 */

module.exports = {
    situation_check: {
      type: 'function',
      function: {
        name: 'situation_check',
        description: '[真起卦 · 梅花易数] 局势检查 — 真·梅花易数起卦, 返回本卦/动爻爻词/之卦/五行, 基于 384 爻真数据判局势\n\n调用的时机:\n- 主人明确说"算一卦/用易经看"\n- 或主人偏好启用\n\n默认: 不调, 走 LLM 自身判断。\n输出: 总结必须引用真卦辞/动爻爻词 (gua 字段), 让主人看到真凭实据。',
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
    initial_assessment: {
      type: 'function',
      function: {
        name: 'initial_assessment',
        description: '初步评估 - 初步评估形势',
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
    caution_signal: {
      type: 'function',
      function: {
        name: 'caution_signal',
        description: '谨慎信号 - 发出谨慎操作信号',
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
    wait_action: {
      type: 'function',
      function: {
        name: 'wait_action',
        description: '等待行动 - 等待指定时间后行动',
        parameters: {
          type: 'object',
          properties: {
          context: { type: 'string', description: '任务背景/上下文 (给执行者看的补充信息)' },
          duration: { type: 'string', description: '时长 (如 30m / 2h)' }
        },
          required: ['context']
        }
      }
    },
    signal_detection: {
      type: 'function',
      function: {
        name: 'signal_detection',
        description: '信号检测 - 检测卦象信号',
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
    trend_judgment: {
      type: 'function',
      function: {
        name: 'trend_judgment',
        description: '[真起卦 · 梅花易数] 趋势判断 — 梅花易数真起卦, 基于真动爻位置 + 384 爻词判断趋势方向\n\n调用的时机:\n- 主人明确说"算一卦/用易经看"\n- 或主人偏好启用\n\n默认: 不调, 走 LLM 自身判断。\n输出: 总结必须引用真卦辞/动爻爻词 (gua 字段), 让主人看到真凭实据。',
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
    opportunity_check: {
      type: 'function',
      function: {
        name: 'opportunity_check',
        description: '机会检查 - 检查是否存在机会',
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
    first_step: {
      type: 'function',
      function: {
        name: 'first_step',
        description: '第一步 - 确定行动第一步',
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
    patience_manager: {
      type: 'function',
      function: {
        name: 'patience_manager',
        description: '耐心管理 - 管理等待与耐心',
        parameters: {
          type: 'object',
          properties: {
          context: { type: 'string', description: '任务背景/上下文 (给执行者看的补充信息)' },
          duration: { type: 'string', description: '时长 (如 30m / 2h)' }
        },
          required: ['context']
        }
      }
    },
    dilemma_resolution: {
      type: 'function',
      function: {
        name: 'dilemma_resolution',
        description: '困境解决 - 分析并解决困境',
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
    stakeholder_check: {
      type: 'function',
      function: {
        name: 'stakeholder_check',
        description: '利益方检查 - 检查相关利益方',
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
    steady_action: {
      type: 'function',
      function: {
        name: 'steady_action',
        description: '稳健行动 - 执行稳健行动',
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
    critical_point_analysis: {
      type: 'function',
      function: {
        name: 'critical_point_analysis',
        description: '[真起卦 · 梅花易数] 临界点分析 — 梅花易数真起卦, 基于真动爻位置 (四爻=临界) 判断是否到临界点\n\n调用的时机:\n- 主人明确说"算一卦/用易经看"\n- 或主人偏好启用\n\n默认: 不调, 走 LLM 自身判断。\n输出: 总结必须引用真卦辞/动爻爻词 (gua 字段), 让主人看到真凭实据。',
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
    breakthrough_check: {
      type: 'function',
      function: {
        name: 'breakthrough_check',
        description: '突破检查 - 检查是否可以突破',
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
    direction_decision: {
      type: 'function',
      function: {
        name: 'direction_decision',
        description: '方向决策 - 决策下一步方向',
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
};
