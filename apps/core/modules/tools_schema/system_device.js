'use strict';
/**
 * tools_schema/system_device.js —— 工具参数 Schema 的一段 (第 97 批从 tools_schema.js 拆出)
 *
 * 拆分纪律 (三条, 一条都不能破):
 *   1. **顺序不变** —— 工具顺序会进 LLM 提示词, 分段必须连续、合并必须按序
 *   2. **内容逐字不变** —— 守卫 tests/tools-schema-split-20261025.test.js 用
 *      拆分前抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对
 *   3. **不改词表** —— 这里只放 schema, 一行语义都不许动
 */

module.exports = {
    system_info: {
      type: 'function',
      function: {
        name: 'system_info',
        description: '系统信息 - 获取系统信息',
        parameters: {
          type: 'object',
          properties: {
            metric: {
              type: 'string',
              description: '指定查询指标',
              enum: ['cpu', 'memory', 'disk', 'all'],
              default: 'all'
            }
          },
          required: []
        },
        meta: { required_capabilities: ['system'] }}
    },
    process_list: {
      type: 'function',
      function: {
        name: 'process_list',
        description: '进程列表 - 列出运行中进程',
        parameters: {
          type: 'object',
          properties: {
            search: {
              type: 'string',
              description: '进程名搜索关键词(可选)'
            },
            limit: {
              type: 'integer',
              description: '返回最多几条进程',
              default: 20,
              minimum: 1,
              maximum: 500
            }
          },
          required: []
        },
        meta: { required_capabilities: ['system'] }}
    },
    network_check: {
      type: 'function',
      function: {
        name: 'network_check',
        description: '网络检查 - 检查网络状态',
        parameters: {
          type: 'object',
          properties: {
          host: { type: 'string', description: '主机名或 IP' }
        },
          required: ['host']
        },
        meta: { required_capabilities: ['system'] }}
    },
    archive_create: {
      type: 'function',
      function: {
        name: 'archive_create',
        description: '创建 zip / tar.gz 压缩包 (用系统 zip/tar 命令)。**字段命名: 源文件叫 path, 输出叫 output, 不是 name/archive_name**。',
        parameters: {
          type: 'object',
          properties: {
          path: { type: 'string', description: '要打包的文件或目录绝对路径 (handler 读 path, 不是 name)' },
          output: { type: 'string', description: '压缩包输出路径 (handler 读 output, 不是 archive_name). 例: /tmp/foo.zip' },
          format: { type: 'string', enum: ['zip', 'tar.gz'], description: '压缩格式 (默认 zip)' }
        },
          required: ['path', 'output']
        },
        meta: { required_capabilities: ['media'] }}
    },
    archive_extract: {
      type: 'function',
      function: {
        name: 'archive_extract',
        description: '解压 zip / tar.gz 到指定目录。**字段命名: 压缩包叫 path, 输出目录叫 output (handler 必填 output, 不是 destination/target_dir)**。',
        parameters: {
          type: 'object',
          properties: {
          path: { type: 'string', description: '压缩包绝对路径' },
          output: { type: 'string', description: '解压输出目录 (handler 必填, 不是 destination/target_dir). 例: /tmp/extracted/' }
        },
          required: ['path', 'output']
        },
        meta: { required_capabilities: ['media'] }}
    },
    http_check: {
      type: 'function',
      function: {
        name: 'http_check',
        description: 'HTTP检查 - 检查HTTP端点',
        parameters: {
          type: 'object',
          properties: {
          url: { type: 'string', description: '目标 URL (http/https)' },
          timeout: { type: 'number', description: '超时时间 (秒)' }
        },
          required: ['url']
        },
        meta: { required_capabilities: ['web_access'] }}
    },
    list_pangu_agents: {
      type: 'function',
      function: {
        name: 'list_pangu_agents',
        description: '列出 Pangu 当前所有子 agent 及其职责。当用户问"你有多少个子 agent / 它们分别做什么 / 子 agent 清单"时，**必须先调此工具**获取权威列表，不要凭印象回答。',
        parameters: {
          type: 'object',
          properties: {
            reason: { type: 'string', description: '调用原因（一句话）' }
          },
          required: []
        },
        meta: { required_capabilities: ['system'] }
      }
    },
    sleep_timer: {
      type: 'function',
      function: {
        name: 'sleep_timer',
        description: '延时 - 延时执行',
        parameters: {
          type: 'object',
          properties: {
          seconds: { type: 'number', description: '秒数' }
        },
          required: ['seconds']
        },
        meta: { required_capabilities: ['system'] }}
    },
    current_time: {
      type: 'function',
      function: {
        name: 'current_time',
        description: '当前时间 - 获取当前时间',
        parameters: {
          type: 'object',
          properties: {
            timezone: {
              type: 'string',
              description: 'IANA 时区名(如 Asia/Shanghai),默认 Asia/Shanghai',
              default: 'Asia/Shanghai'
            },
            format: {
              type: 'string',
              description: '返回格式',
              enum: ['human', 'iso', 'unix'],
              default: 'human'
            }
          },
          required: []
        },
        meta: { required_capabilities: ['system'] }}
    },
};
