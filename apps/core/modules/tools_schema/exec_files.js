'use strict';
/**
 * tools_schema/exec_files.js —— 工具参数 Schema 的一段 (第 97 批从 tools_schema.js 拆出)
 *
 * 拆分纪律 (三条, 一条都不能破):
 *   1. **顺序不变** —— 工具顺序会进 LLM 提示词, 分段必须连续、合并必须按序
 *   2. **内容逐字不变** —— 守卫 tests/tools-schema-split-20261025.test.js 用
 *      拆分前抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对
 *   3. **不改词表** —— 这里只放 schema, 一行语义都不许动
 */

module.exports = {
    exec_command: {
      type: 'function',
      function: {
        name: 'exec_command',
        description: '执行命令 - 在终端执行shell命令。',
        parameters: {
          type: 'object',
          properties: {
          command: { type: 'string', description: '要执行的 shell 命令' },
          timeout: { type: 'number', description: '超时时间(ms)，默认 30000' },
          workdir: { type: 'string', description: '工作目录 (绝对路径, 可选)' },
          run_in_background: { type: 'boolean', description: '借鉴 #3: true 时立即返 task_id 不阻塞 (LLM 下次轮询 task_output); 默认 false 同步等结果' },
          task_id: { type: 'string', description: '借鉴 #3 (output): 启动后台任务时返的 task_id, LLM 下次轮询用 task_output(task_id) 取结果' },
 // 借鉴 #1 (ClaudeCode Leaked BashTool _simulatedSedEdit):
          // 内部 computed field — LLM 看到 schema 但 description 标 "internal, 不要填",
          // Pangu ORM 可注入 (路由建议 / hook 结果); handler 会 strip, LLM 填了也无效
          _panguRoute: { type: 'string', description: '⚠️ INTERNAL — Pangu ORM 路由建议 (e.g. "use_read_file"), LLM 不要填, 填了会被 strip' },
          _panguHookRes: { type: 'object', description: '⚠️ INTERNAL — Pangu hook 结果注入 (e.g. {ok: true, data: {...}}), LLM 不要填, 填了会被 strip', additionalProperties: true }
        },
          required: ['command']
        },
        meta: { required_capabilities: ['code_execution'] }}
    },
    read_file: {
      type: 'function',
      function: {
        name: 'read_file',
        // 2026-10-17 (现场 lt3-1792174695795 / lt3-1792174885738 实测, 三文件分析):
        //   这条描述原来只有五个字"读文件内容"。模型因此不知道 read_file 会**一次给全**,
        //   改用 exec_command 自己分段摸: 17~20 次 wc / head / sed / grep,
        //   其中 161 行的 model_cost.js 被发了 4 次 (sed 100-161 / 110-161 / 120-161 / wc+head -80),
        //   而 read_file 一次调用就把这个文件**整个**取回来了 (实测 162 行 / 5804 字符)。
        //
        //   代价不是"多跑几轮"这么轻: 每多一轮就多付一次完整模型推理 (实测 2.5~5s),
        //   而且分片读的片段是散的, 模型拿不到连贯全文, 汇报质量也跟着掉。
        //
        // 下面每个数字都是实测来的, 不是估的:
        //   - 默认一次取 500 行 (offset 从 1 开始, limit 可调大);
        //   - 返回值带 total_lines —— 拿它判断"这次是不是读全了";
        //   - 工具结果在 j2_agent_loop 里按 PANGU_TOOL_RESULT_MAX_CHARS (默认 24000 字符) 截断,
        //     所以超大文件要分两次 (offset 续读), 两次可以放在同一轮并发发。
        description: '读文件内容。**普通源码文件一次就能读全, 不要用 exec_command 去 wc/head/sed 分段摸** '
          + '(实测 161 行的文件一次就返回 5804 字符)。返回值带 total_lines, '
          + '拿它对照收到的内容判断有没有读全。默认取从 offset 起的 500 行 (offset 从 1 开始); '
          + '文件超过 500 行就用 offset 续读, 两段可以放在同一轮一起发。',
        parameters: {
          type: 'object',
          properties: {
          path: { type: 'string', description: '文件或目录路径' },
          offset: { type: 'number', description: '起始行号 (从 1 开始；传 0 兼容按第 1 行读取)' },
          limit: { type: 'number', description: '返回条数上限' }
        },
          required: ['path']
        }
      }
    },
    write_file: {
      type: 'function',
      function: {
        name: 'write_file',
        description: '写文件 (覆盖)',
        parameters: {
          type: 'object',
          properties: {
          path: { type: 'string', description: '文件绝对路径 (例如 /tmp/hello.txt)' },
          content: { type: 'string', description: '要写入文件的文本内容' }
        },
          required: ['path', 'content']
        },
        meta: { required_capabilities: ['code_execution'] }}
    },
    list_directory: {
      type: 'function',
      function: {
        name: 'list_directory',
        description: '列目录',
        parameters: {
          type: 'object',
          properties: {
          path: { type: 'string', description: '文件或目录路径' }
        },
          required: ['path']
        }
      }
    },
};
