'use strict';
/**
 * tools_schema/dev_files.js —— 工具参数 Schema 的一段 (第 97 批从 tools_schema.js 拆出)
 *
 * 拆分纪律 (三条, 一条都不能破):
 *   1. **顺序不变** —— 工具顺序会进 LLM 提示词, 分段必须连续、合并必须按序
 *   2. **内容逐字不变** —— 守卫 tests/tools-schema-split-20261025.test.js 用
 *      拆分前抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对
 *   3. **不改词表** —— 这里只放 schema, 一行语义都不许动
 */

module.exports = {
    code_execute: {
      type: 'function',
      function: {
        name: 'code_execute',
        description: '代码执行 - 执行Python/JS代码 (数据处理/计算/转换)。**不用于写文件/新建文件/批量写盘** — 那些用 write_file 或 exec_command heredoc。**禁止在 Python 代码里 open(\'...\',\'w\') 写盘 / import os / import subprocess**, 会被 FORBIDDEN_PY 拦截器拦 (2026-10-13 实案: 子 agent 拿它批量写 8 份文件全部被拦)',
        parameters: {
          type: 'object',
          properties: {
          code: { type: 'string', description: '要执行的代码' },
          language: { type: 'string', description: '语言 (python / javascript)' },
          timeout: { type: 'number', description: '超时时间 (秒)' }
        },
          required: ['code']
        },
        meta: { required_capabilities: ['code_execution'] }}
    },
    file_edit: {
      type: 'function',
      function: {
        name: 'file_edit',
        description: '文件原子编辑 (find-replace)。\n\n参数命名约定: **字段名是 old_string/new_string, 不是 old_text/new_text** — handler 只认这俩。\n\n用法: 先 read_file 拿全文 → 复制要改的片段 (含上下文行避免歧义) → 传 old_string 全等匹配 → 传 new_string 替换。',
        parameters: {
          type: 'object',
          properties: {
          path: { type: 'string', description: '文件绝对路径, 如 /Users/you/foo.js' },
          old_string: { type: 'string', description: '要被替换的字符串 (handler 只认 old_string, 不是 old_text/old_content/source_text). 例: "const x = 1;"' },
          new_string: { type: 'string', description: '新字符串 (handler 只认 new_string, 不是 new_text/new_content/target_text). 例: "const x = 2;"' }
        },
          required: ['path', 'old_string', 'new_string']
        },
        meta: { required_capabilities: ['code_execution'] }}
    },
    // TL-5 子项 B: Multi-file atomic edit
    file_edit_batch: {
      type: 'function',
      function: {
        name: 'file_edit_batch',
        description: '多文件原子编辑 - atomic=true 时全成功或全失败 rollback (TL-5 sub-B). 用法: edits=[{path,search,replace}], atomic=true (default).',
        parameters: {
          type: 'object',
          properties: {
            edits: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  path: { type: 'string', description: '文件绝对路径' },
                  search: { type: 'string', description: '要被替换的字符串' },
                  replace: { type: 'string', description: '新字符串' },
                },
                required: ['path', 'search', 'replace'],
              },
              description: 'edit 列表, 顺序执行',
            },
            atomic: { type: 'boolean', description: 'atomic=true 时全成功或全 rollback (default true)' },
          },
          required: ['edits'],
        },
        meta: { required_capabilities: ['code_execution'] }},
    },
    // P0-#14: Git Ops
    git_commit: {
      type: 'function',
      function: {
        name: 'git_commit',
        description: 'git commit - 本地 commit, 不 push (P0-#14). files 默认 git add -A.',
        parameters: {
          type: 'object',
          properties: {
            message: { type: 'string', description: 'commit message (必填)' },
            files: { type: 'array', items: { type: 'string' }, description: '指定文件列表, 缺省 git add -A' },
            amend: { type: 'boolean', description: 'git commit --amend' },
            author: { type: 'object', properties: { name: { type: 'string' }, email: { type: 'string' } }, description: '覆盖 author (默认 Pangu config)' },
          },
          required: ['message'],
        },
        meta: { required_capabilities: ['code_execution'] }},
    },
    git_branch: {
      type: 'function',
      function: {
        name: 'git_branch',
        description: 'git branch 操作 (P0-#14) - list / create / checkout / delete',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['list', 'create', 'checkout', 'delete'], description: '操作类型, default list' },
            name: { type: 'string', description: 'create/checkout/delete 时必须' },
            from: { type: 'string', description: 'create 时基于哪个 commit/branch (默认 HEAD)' },
          },
          required: ['action'],
        },
        meta: { required_capabilities: ['code_execution'] }},
    },
    git_diff: {
      type: 'function',
      function: {
        name: 'git_diff',
        description: 'git diff - working vs HEAD (P0-#14). 顺手把 #29 Diff 显示也修了',
        parameters: {
          type: 'object',
          properties: {
            ref1: { type: 'string', description: '默认 HEAD' },
            ref2: { type: 'string', description: '默认空 = working tree' },
            files: { type: 'array', items: { type: 'string' }, description: '指定文件' },
            format: { type: 'string', enum: ['unified', 'stat', 'name-only'], description: '默认 unified' },
          },
        },
        meta: { required_capabilities: ['code_execution'] }},
    },
    git_status: {
      type: 'function',
      function: {
        name: 'git_status',
        description: 'git status - 当前 branch + working tree + HEAD commit (P0-#14)',
        parameters: {
          type: 'object',
          properties: {
            short: { type: 'boolean', description: '默认 true (简短格式)' },
          },
        },
        meta: { required_capabilities: ['code_execution'] }},
    },
    self_iterate: {
      type: 'function',
      function: {
        name: 'self_iterate',
        description: '盘古自我迭代 (改码 → 验证 → 重启)',
        parameters: {
          type: 'object',
          properties: {
            action: { type: 'string', enum: ['apply', 'status'], description: 'apply=验证+提交+重启+看门狗 (默认); status=查上次迭代结果 (重启后必调, 闭环确认)' },
            note: { type: 'string', description: '一句话说清这次迭代改了什么/为什么 (进 commit message, apply 必填)' },
            restart_only: { type: 'boolean', description: 'true=只重启不提交 (工作区干净时用)' },
            delay_s: { type: 'number', description: '延迟几秒重启 (默认 3, 让当前回复发完)' },
            health_timeout_s: { type: 'number', description: '看门狗健康检查超时秒数 (默认 90)' },
          },
        },
        meta: { required_capabilities: ['code_execution'] }},
    },
    file_grep: {
      type: 'function',
      function: {
        name: 'file_grep',
        description: '文件搜索 - 在文件中搜索内容',
        parameters: {
          type: 'object',
          properties: {
          path: { type: 'string', description: '文件或目录路径' },
          pattern: { type: 'string', description: '匹配模式 (支持正则)' }
        },
          required: ['path']
        }
      }
    },
    file_find: {
      type: 'function',
      function: {
        name: 'file_find',
        description: '查找文件 - 查找文件',
        parameters: {
          type: 'object',
          properties: {
          path: { type: 'string', description: '文件或目录路径' },
          name: { type: 'string', description: '名称 (文件名/对象名)' }
        },
          required: ['path']
        }
      }
    },
    search_files: {
      type: 'function',
      function: {
        name: 'search_files',
        description: '[DEPRECATED 请用 file_grep] 全文搜索 - 全文搜索文件',
        parameters: {
          type: 'object',
          properties: {
          path: { type: 'string', description: '文件或目录路径' },
          pattern: { type: 'string', description: '匹配模式 (支持正则)' },
          file_glob: { type: 'string', description: '文件名过滤 (如 *.js, 可选)' },
          limit: { type: 'number', description: '返回条数上限' }
        },
          required: ['path']
        }
      }
    },
    clipboard_read: {
      type: 'function',
      function: {
        name: 'clipboard_read',
        description: '剪贴板读取 - 读取剪贴板内容',
        parameters: {
          type: 'object',
          properties: {
            format: {
              type: 'string',
              description: '读取格式(text=文本, image=图片 base64, html=富文本)',
              enum: ['text', 'image', 'html'],
              default: 'text'
            }
          },
          required: []
        },
        meta: { required_capabilities: ['media'] }}
    },
    clipboard_write: {
      type: 'function',
      function: {
        name: 'clipboard_write',
        description: '剪贴板写入 - 写入剪贴板',
        parameters: {
          type: 'object',
          properties: {
          text: { type: 'string', description: '待处理文本' }
        },
          required: ['text']
        },
        meta: { required_capabilities: ['media'] }}
    },
};
