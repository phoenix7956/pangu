'use strict';
/**
 * tools_schema/cache_sched.js —— 工具参数 Schema 的一段 (第 97 批从 tools_schema.js 拆出)
 *
 * 拆分纪律 (三条, 一条都不能破):
 *   1. **顺序不变** —— 工具顺序会进 LLM 提示词, 分段必须连续、合并必须按序
 *   2. **内容逐字不变** —— 守卫 tests/tools-schema-split-20261025.test.js 用
 *      拆分前抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对
 *   3. **不改词表** —— 这里只放 schema, 一行语义都不许动
 */

module.exports = {
    cache_get: {
      type: 'function',
      function: {
        name: 'cache_get',
        description: '临时缓存获取 (⚠️ 不是记忆) - 读进程内 KV 缓存, 重启即丢。**禁止**用它回答"你记得吗/我说过/历史/偏好/你有没有记忆"类问题 — 那些必须调 memory_search (持久记忆库)。cache_get 返回空 ≠ 没有记忆。仅用于本次运行内的临时存取。',
        parameters: {
          type: 'object',
          properties: {
          key: { type: 'string', description: '缓存 key (临时, 非记忆 key)' }
        },
          required: ['key']
        }
      }
    },
    cache_put: {
      type: 'function',
      function: {
        name: 'cache_put',
        description: '临时缓存写入 (⚠️ 不是记忆) - 写进程内 KV 缓存, 重启即丢。要长期记住信息 → 用 memory_write, 不要用 cache_put。',
        parameters: {
          type: 'object',
          properties: {
          key: { type: 'string', description: '缓存 key (临时, 非记忆 key)' },
          value: { type: 'string', description: '缓存 value (临时)' },
          ttl: { type: 'string', description: '过期时间 (秒, 可选)' }
        },
          required: ['key']
        },
        meta: { required_capabilities: ['system'] }}
    },
    cache_preheat: {
      type: 'function',
      function: {
        name: 'cache_preheat',
        description: '缓存预热 - 预热缓存',
        parameters: {
          type: 'object',
          properties: {
          keys: { type: 'string', description: '键名列表' }
        },
          required: ['keys']
        },
        meta: { required_capabilities: ['system'] }}
    },
    cache_evict: {
      type: 'function',
      function: {
        name: 'cache_evict',
        description: '缓存清除 - 清除缓存条目',
        parameters: {
          type: 'object',
          properties: {
          key: { type: 'string', description: '键名' }
        },
          required: ['key']
        },
        meta: { required_capabilities: ['system'] }}
    },
    cache_stats: {
      type: 'function',
      function: {
        name: 'cache_stats',
        description: '临时缓存统计 (⚠️ 不是记忆) - 看进程内缓存命中率/条目数, 仅用于性能诊断。查"记住了什么"用 memory_search, 不用 cache_stats。',
        parameters: {
          type: 'object',
          properties: {
            scope: {
              type: 'string',
              description: '统计范围',
              enum: ['all', 'memory', 'disk'],
              default: 'all'
            },
            top_n: {
              type: 'integer',
              description: '返回前 N 个条目统计',
              default: 10,
              minimum: 1,
              maximum: 100
            }
          },
          required: []
        },
        meta: { required_capabilities: ['system'] }}
    },
    batch_execute: {
      type: 'function',
      function: {
        name: 'batch_execute',
        description: '批量执行 - 并行或串行执行命令',
        parameters: {
          type: 'object',
          properties: {
          commands: { type: 'array', items: { type: 'string' }, description: '要执行的命令数组' },
          parallel: { type: 'boolean', description: '是否并行执行 (默认 true)' },
          timeout: { type: 'number', description: '超时时间 (秒)' }
        },
          required: ['commands']
        },
        meta: { required_capabilities: ['code_execution'] }}
    },
    team_dispatch: {
      type: 'function',
      function: {
        name: 'team_dispatch',
        description: '派子 agent (task 必填)',
        parameters: {
          type: 'object',
          properties: {
          task: { type: 'string', description: '任务描述 (一句话说清要做什么)' },
          agents: { type: 'string', description: '子 agent 列表' },
          priority: { type: 'string', description: '优先级 (high / normal / low)' }
        },
          required: ['task']
        },
        meta: { required_capabilities: ['system'] }}
    },
    permission_check: {
      type: 'function',
      function: {
        name: 'permission_check',
        description: '权限检查 - 检查任务执行权限',
        parameters: {
          type: 'object',
          properties: {
          task: { type: 'string', description: '任务描述 (一句话说清要做什么)' },
          context: { type: 'string', description: '任务背景/上下文 (给执行者看的补充信息)' }
        },
          required: ['task']
        },
        meta: { required_capabilities: ['system'] }}
    },
    permission_grant: {
      type: 'function',
      function: {
        name: 'permission_grant',
        description: '权限授予 - 授予指定目标权限',
        parameters: {
          type: 'object',
          properties: {
          target: { type: 'string', description: '目标对象' },
          level: { type: 'string', description: '级别' }
        },
          required: ['target']
        },
        meta: { required_capabilities: ['system'] }}
    },
};
