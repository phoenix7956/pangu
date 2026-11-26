'use strict';
/**
 * tools_schema/ops_workflow.js —— 工具参数 Schema 的一段 (第 97 批从 tools_schema.js 拆出)
 *
 * 拆分纪律 (三条, 一条都不能破):
 *   1. **顺序不变** —— 工具顺序会进 LLM 提示词, 分段必须连续、合并必须按序
 *   2. **内容逐字不变** —— 守卫 tests/tools-schema-split-20261025.test.js 用
 *      拆分前抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对
 *   3. **不改词表** —— 这里只放 schema, 一行语义都不许动
 */

module.exports = {
    resource_pool: {
      type: 'function',
      function: {
        name: 'resource_pool',
        description: '资源池管理 - 管理系统资源池',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', description: '操作 acquire/release/stats' },
            resource_type: { type: 'string', description: '资源类型 cpu/memory/disk' }
          },
          required: ['action', 'resource_type']
        },
        meta: { required_capabilities: ['system'] }}
    },
 // ===== P0-3 OS 工具 =====
    get_lan_ip: {
      type: 'function',
      function: {
        name: 'get_lan_ip',
        description: '取本机 LAN IP (192.168.x.x / 10.x / 172.16-31.x), 默认 IPv4, 默认自动探测接口',
        parameters: {
          type: 'object',
          properties: {
            interface: { type: 'string', description: '网络接口名 (macOS: en0/en1; Linux: eth0/wlan0; 留空=自动)' },
            family: { type: 'string', enum: ['ipv4', 'ipv6'], description: 'IP 协议族, 默认 ipv4' }
          }
        },
        meta: { required_capabilities: ['system'] }}
    },
    set_env_path: {
      type: 'function',
      function: {
        name: 'set_env_path',
        description: '修改进程 PATH (append/prepend/set)。安全限制: set 必须 replace=true; 不能 set 成 /, /etc, /usr 等关键目录',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['append', 'prepend', 'set'], description: '操作类型, 默认 append' },
            value: { type: 'string', description: '要添加或设置的路径 (e.g. /opt/homebrew/bin)' },
            replace: { type: 'boolean', description: 'action=set 时必须为 true (防误覆盖)' }
          },
          required: ['value']
        },
        meta: { required_capabilities: ['system'] }}
    },
    run_installer: {
      type: 'function',
      function: {
        name: 'run_installer',
        description: '跑 macOS .pkg / .dmg 安装 (高危, 默认 dry-run 仅解析 manifest, 真装需 user_confirmed=true)。\n\n**字段命名: 安装包路径叫 path (handler 必填), 不是 pkg/package/file** — 缺则返 NO_PATH。',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: '安装包绝对路径 (.pkg 或 .dmg). handler 只认 path, 不是 pkg/package/file' },
            mode: { type: 'string', enum: ['dry-run', 'install'], description: 'dry-run 默认只解析 manifest, install 真跑' },
            target: { type: 'string', description: 'install 时的目标卷, 默认 /' },
            user_confirmed: { type: 'boolean', description: 'install 模式必须 true (防 LLM 自动跑)' },
            run_in_background: { type: 'boolean', description: '借鉴 #3: true 时 install 模式长任务立即返 task_id, 不阻塞; 默认 false 同步等 (默认 5 分钟 timeout)' },
            task_id: { type: 'string', description: '借鉴 #3 (output): 后台任务的 task_id' }
          },
          required: ['path']
        },
        meta: { required_capabilities: ['code_execution', 'system'] }}
    },
 // ===== 借鉴 #3 (ClaudeCode Leaked TaskOutputTool) — 异步后台任务 =====
    task_output: {
      type: 'function',
      function: {
        name: 'task_output',
        description: '借鉴 #3 TaskOutputTool: 查询/轮询一个后台任务的输出。LLM 拿到 task_id 后下次 turn 调 task_output 取结果。block=true + wait=true 同步等, block=false 立即返当前 progress。超过 100K char 输出自动落盘, LLM 看 output_file_path 字段。',
        parameters: {
          type: 'object',
          properties: {
            task_id: { type: 'string', description: '后台任务的 task_id (来自 run_in_background: true 调用的返回值)' },
            block: { type: 'boolean', description: 'true 时同步等任务结束 (或 wait_timeout 到期), false 立即返当前状态; 默认 false' },
            wait: { type: 'boolean', description: 'true 时 block 模式才生效 (默认 true) — 同步等; false = 立即返 progress' },
            wait_timeout: { type: 'integer', description: 'block 模式同步等的最大 ms, 默认 30000 (30s)' },
            kill: { type: 'boolean', description: 'true 时杀掉该后台任务 (SIGTERM → SIGKILL)' }
          },
          required: ['task_id']
        },
        meta: { required_capabilities: ['system'] }}
    },
    workflow_create: {
      type: 'function',
      function: {
        name: 'workflow_create',
        description: '创建可重启恢复的持久长工作流。每个步骤必须是已注册工具；用 depends_on 表示前置步骤；kind=review 会暂停并等待人工验收。不要用它执行一次性短命令。',
        parameters: {
          type: 'object',
          properties: {
            title: { type: 'string', description: '工作流标题' },
            input: { type: 'string', description: '原始用户任务' },
            session_id: { type: 'string', description: '会话 ID，可选' },
            priority: { type: 'number', description: '优先级 1=最高, 3=普通' },
            max_retries: { type: 'number', description: '单步骤额外重试次数，默认 2' },
            steps: { type: 'array', description: '步骤列表', items: { type: 'object', properties: {
              id: { type: 'string' }, title: { type: 'string' }, kind: { type: 'string', enum: ['tool', 'review'] },
              tool_name: { type: 'string' }, params: { type: 'object' }, depends_on: { type: 'array', items: { type: 'string' } }, max_attempts: { type: 'number' }
            } } }
          },
          required: ['title', 'steps']
        },
        meta: { required_capabilities: ['system'] }
      }
    },
    workflow_status: {
      type: 'function',
      function: {
        name: 'workflow_status',
        description: '查询持久长工作流的状态、步骤结果和事件。',
        parameters: { type: 'object', properties: { workflow_id: { type: 'string', description: 'workflow_create 返回的工作流 ID' } }, required: ['workflow_id'] },
        meta: { required_capabilities: ['system'] }
      }
    },
    workflow_review: {
      type: 'function',
      function: {
        name: 'workflow_review',
        description: '对 waiting_review 状态的持久工作流执行人工验收或驳回。只能在用户明确给出通过或驳回意见后调用。',
        parameters: { type: 'object', properties: { workflow_id: { type: 'string' }, approved: { type: 'boolean' }, note: { type: 'string' } }, required: ['workflow_id', 'approved'] },
        meta: { required_capabilities: ['system'] }
      }
    },
    // ===== TTS =====
    tts_speak: {
      type: 'function',
      function: {
        name: 'tts_speak',
        description: 'macOS say 文本转语音(产 .aiff 文件,可选播放)。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要念的文本(必填)' },
            voice: { type: 'string', description: '声线名(可选, e.g. Tingting 中文、Alex 英文)' },
            output: { type: 'string', description: '输出文件路径(可选,默认 /tmp/pangu-tts-{ts}.aiff)' },
            speed: { type: 'number', description: '语速 wpm(默认 200)' },
            play: { type: 'boolean', description: '是否立即播放(默认 false)' }
          },
          required: ['text']
        },
        meta: { required_capabilities: ['media'] }}
    },
    tts_voices: {
      type: 'function',
      function: {
        name: 'tts_voices',
        description: '列出 macOS 可用声线,优先推荐中文',
        parameters: {
          type: 'object',
          properties: {
            lang: {
              type: 'string',
              description: '语言过滤(优先列出该语言声线)',
              enum: ['zh', 'en', 'all'],
              default: 'zh'
            },
            sample: {
              type: 'boolean',
              description: '是否返回示例文本',
              default: false
            }
          },
          required: []
        },
        meta: { required_capabilities: ['media'] }}
    },
    stock_resolve: {
      type: 'function',
      function: {
        name: 'stock_resolve',
        description: '按名称/拼音/代码查股票真实代码。**绝不凭记忆猜股票代码** — 主人只给名字(如"内蒙新华")时, 必须先调本工具拿到代码, 再用 stock_quote / stock_history。历史上曾把内蒙新华(603230)错说成 600295(鄂尔多斯) / 600311。',
        parameters: {
          type: 'object',
          properties: {
            name: { type: 'string', description: '股票名称 / 拼音缩写 / 6位代码, 如 内蒙新华 / NMXH / 603230' },
            limit: { type: 'integer', description: '返回候选数(1-20, 默认 5)' }
          },
          required: ['name']
        }
      }
    },
    stock_quote: {
      type: 'function',
      function: {
        name: 'stock_quote',
        description: 'A股实时行情 (东方财富 free)。**只支持 A 股** (6 位数字 / sh / sz 前缀); 美股、港股目前没有数据源, 调了会 BAD_CODE',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '股票代码 (handler 只认 code, 不是 symbol/ticker). 例: 600000 / sh600000 / sz000001' }
          },
          required: ['code']
        },
        meta: { required_capabilities: ['data_analysis'] }}
    },
    // ===== 2026-09-13: 外部 agent 桥接工具已移除 (老板拍: 盘古完全独立, 无其他 agent 痕迹) =====
        stock_history: {
      type: 'function',
      function: {
        name: 'stock_history',
        description: '查A股 K 线(东方财富 free API)。默认 30 天日线前复权。klt=101 日 / 102 周 / 103 月 / 1/5/15/30/60 分线。fqt=0 不复权 / 1 前复权 / 2 后复权。',
        parameters: {
          type: 'object',
          properties: {
            code: { type: 'string', description: '股票代码' },
            days: { type: 'integer', description: '返回条数(1-365, 默认 30)' },
            klt: { type: 'integer', description: 'K线周期(101=日线, 默认)' },
            fqt: { type: 'integer', description: '复权方式(1=前复权, 默认)' }
          },
          required: ['code']
        },
        meta: { required_capabilities: ['data_analysis'] }}
    },
};
