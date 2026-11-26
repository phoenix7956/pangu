'use strict';
/**
 * tools_schema/dev_misc.js —— 工具参数 Schema 的一段 (第 97 批从 tools_schema.js 拆出)
 *
 * 拆分纪律 (三条, 一条都不能破):
 *   1. **顺序不变** —— 工具顺序会进 LLM 提示词, 分段必须连续、合并必须按序
 *   2. **内容逐字不变** —— 守卫 tests/tools-schema-split-20261025.test.js 用
 *      拆分前抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对
 *   3. **不改词表** —— 这里只放 schema, 一行语义都不许动
 */

module.exports = {
self_correct: {
  type: 'function',
  function: {
    name: 'self_correct',
    description: 'Pangu 自检工具 (§0.7 + P0-#7). Pangu 调 tool 后, 用 LLM judge 评估输出是否正确. 若 error/可疑 → 重规划, 若正确 → 继续. (Claude Code 自检机制)',
    parameters: {
      type: 'object',
      properties: {
        tool_name: { type: 'string', description: '被检查的 tool name (必填)' },
        original_result: { type: 'object', description: '原 tool 输出 (必填)' },
        judge_prompt: { type: 'string', description: '自定义 judge prompt (可选, 默认用模板)' },
        plan_id: { type: 'string', description: '当前 plan_id (持久化用)' },
      },
      required: ['tool_name', 'original_result'],
    },
    meta: { required_capabilities: ['system'] }
  },
  },
symbol_search: {
  type: 'function',
  function: {
    name: 'symbol_search',
    description: '跨文件搜 symbol (支持 glob)',
    parameters: {
      type: 'object',
      properties: {
        pattern: { type: 'string', description: 'symbol 名或 glob (e.g. "addUser" 或 "*Controller"). 必填, handler 只认 pattern' },
        type: { type: 'string', enum: ['function', 'class', 'variable', 'all'], description: '默认 all' },
        lang: { type: 'string', enum: ['javascript', 'typescript', 'tsx', 'python', 'all'], description: '默认 typescript' },
        max_results: { type: 'number', description: '默认 100' },
        root: { type: 'string', description: '搜根目录 (默认 Pangu repo 根)' },
      },
      required: ['pattern'],
    },
    meta: { required_capabilities: ['system'] }
  },
  },
lsp_definition: {
  type: 'function',
  function: {
    name: 'lsp_definition',
    description: 'LSP go-to-definition (P0-#17 / P0-10 LSP 整合). vscode-langservers-extracted + tsserver (TS/JS), Python 暂用 fallback (tree-sitter + grep). 返定义位置 (file, line, character).',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '源文件路径 (必填)' },
        line: { type: 'number', description: '行号, 1-based (必填)' },
        character: { type: 'number', description: '列号, 0-based (默认 0)' },
        lang: { type: 'string', enum: ['javascript', 'typescript', 'tsx', 'python'], description: '默认按扩展名推断' },
        root: { type: 'string', description: '工作区根 (默认 Pangu repo 根)' },
      },
      required: ['file', 'line'],
    },
    meta: { required_capabilities: ['system'] }
  },
  },
lsp_references: {
  type: 'function',
  function: {
    name: 'lsp_references',
    description: 'LSP find-references (P0-#17 / P0-10 LSP 整合). 返所有引用位置列表 [{file, line, character}].',
    parameters: {
      type: 'object',
      properties: {
        file: { type: 'string', description: '源文件路径 (必填)' },
        line: { type: 'number', description: '行号, 1-based (必填)' },
        character: { type: 'number', description: '列号, 0-based (默认 0)' },
        symbol: { type: 'string', description: 'symbol 名 (fallback 用 grep 找, 不传也能跑但精度差)' },
        lang: { type: 'string', enum: ['javascript', 'typescript', 'tsx', 'python'], description: '默认按扩展名推断' },
        root: { type: 'string', description: '工作区根 (默认 Pangu repo 根)' },
      },
      required: ['file', 'line'],
    },
    meta: { required_capabilities: ['system'] }
  },
  },
syntax_highlight: {
  type: 'function',
  function: {
    name: 'syntax_highlight',
    description: '语法高亮 (P0-#16 / P0-10 LSP 整合). chalk + tree-sitter-highlight, 返 ANSI 24bit colored 字符串. 终端能力检测 (NO_COLOR / CI / 非 TTY) 自动降级纯文本. 支持 code 字符串或 file 路径.',
    parameters: {
      type: 'object',
      properties: {
        code: { type: 'string', description: '待高亮的源码 (跟 file 二选一).' },
        file: { type: 'string', description: '待高亮的文件路径 (跟 code 二选一, 优先).' },
        lang: { type: 'string', enum: ['javascript', 'typescript', 'tsx', 'python'], description: 'code 模式必填, file 模式按扩展名自动检测' },
        lineNumbers: { type: 'boolean', description: '是否加行号 (gutter), 默认 false' },
        plain: { type: 'boolean', description: '强制纯文本不色 (debug 用), 默认 auto-detect' },
      },
    },
    meta: { required_capabilities: ['system'] }
  },
  },
metrics_query: {
  type: 'function',
  function: {
    name: 'metrics_query',
    description: '查 token 累计 / 按 round / 按 tool 统计 (P0-#36). 持久化在 ~/.pangu-data/metrics/session_<id>.json',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '省略 = 当前会话 (想看别的会话才传)' },
        scope: { type: 'string', enum: ['session', 'tool', 'round'], description: '默认 session' },
      },
    },
    meta: { required_capabilities: ['system'] }
  },
  },
metrics_dashboard: {
  type: 'function',
  function: {
    name: 'metrics_dashboard',
    description: '查 dashboard 数据 (累计 / 当 session / 工具 top-5 / 最近 10 调) (P0-#36). 老板看花了多少',
    parameters: {
      type: 'object',
      properties: {
        session_id: { type: 'string', description: '省略 = 当前会话 (想看别的会话才传)' },
      },
    },
    meta: { required_capabilities: ['system'] }
  },
  },
todo_write: {
  type: 'function',
  function: {
    name: 'todo_write',
    description: 'TodoWrite 状态机',
    parameters: {
      type: 'object',
      properties: {
        op: { type: 'string', enum: ['add', 'update', 'list'], description: '操作' },
        items: { type: 'array', items: { type: 'object', properties: { content: { type: 'string' }, activeForm: { type: 'string' } } }, description: 'add 时的 todo 项' },
        id: { type: 'string', description: 'update 时的 todo id' },
        status: { type: 'string', enum: ['pending', 'in_progress', 'completed'], description: 'update 时的新状态' }
      },
      required: ['op']
    },
    meta: { required_capabilities: ['system'] }
  }
  },
permission_apply: {
  type: 'function',
  function: {
    name: 'permission_apply',
    description: '**盘古弹自家 dialog + 打开 系统设置 面板**\n\n⚠️ **关键 — 这是 Pangu 自己的 dialog, 不是 macOS TCC 原生系统弹窗**:\n\n当 take_photo / record_audio / screencapture 返回 `CAMERA_PERMISSION_DENIED` 等错时, 本 tool 会:\n1. 弹 Pangu 自己的 AppleScript/HTML dialog (盘古自家 UI, 不是系统级) + 打开 系统设置 → 隐私与安全性 → X 面板\n2. 主人**必须**在 系统设置 里勾选 Terminal (或 Cursor)\n3. **必须完全退出 (Cmd+Q) 并重启 Terminal/Cursor** — 不重启 TCC 不刷新, 下次拍照仍会失败\n\n**节流**: 同 permission_type 在 30 秒内只能调 1 次真 dialog. 后续调用直接返回 `THROTTLED` + cooldown_remaining, 不会真弹 dialog. 收到 THROTTLED 后**禁止**再调本 tool — 必须等主人按 user_action 4 步操作.\n\n**禁止脑补 (全局规则 #13)**: 当 verified=false / THROTTLED 时, 盘古**不得**在 chat 里说\n- "已请求系统级权限" / "已请求系统级摄像头权限"\n- "macOS TCC 系统弹窗已弹出" / "系统已批准"\n- "权限已激活" / "权限已开启" / "已批准"\n这些都是**假话** — TCC 系统弹窗根本没触发. 必须告诉主人: "我没真正拿到权限, 请按 tool_result.data.user_action 走 (4 步操作)".\n\n**禁止循环 (全局规则 #15)**: 收到 `THROTTLED` / `USER_CANCELLED` / `DIALOG_HANDOFF_FAILED` 后, 盘古**不得**再调本 tool — 必须告诉主人按 user_action 操作, 然后等主人说\'权限已开\'才再试.\n\n**支持权限类型**: camera / microphone / accessibility / automation / full_disk_access / screen_recording / input_monitoring\n\n**silent=true 跳过弹窗, 只检测状态** (用于测试).',
    parameters: {
      type: 'object',
      properties: {
        permission_type: {
          type: 'string',
          enum: ['camera', 'microphone', 'accessibility', 'automation', 'full_disk_access', 'screen_recording', 'input_monitoring'],
          description: '申请的权限类型'
        },
        reason: { type: 'string', description: '为什么需要这个权限 (弹窗里显示给主人看)' },
        verify: { type: 'boolean', default: false, description: 'true 时验证授权是否真的生效' },
        silent: { type: 'boolean', default: false, description: 'true 时不弹 GUI 对话框, 只检测 + 返回状态' }
      },
      required: ['permission_type']
    },
    meta: { required_capabilities: ['system'] }
  }
  },
take_photo: {
  type: 'function',
  function: {
    name: 'take_photo',
    description: '**盘古长出眼睛** — 用 macOS 摄像头抓 1 帧图片.\n\n走 AVFoundation (ffmpeg). **2 路 handoff** (按序尝试, 任一成功即返回):\n1. execFile — Node 直接调 ffmpeg (继承 Pangu 进程 TCC)\n2. launchctl asuser UID — 走用户 Aqua GUI session (借 Terminal TCC)\n\n**2 路全失败 = `CAMERA_PERMISSION_DENIED`**, user_action 含系统设置指引 (调 permission_apply 拉 x-apple.systempreferences:...Privacy_Camera).\n\n**TCC 限制关键事实**: macOS TCC 看到 launchd 跑的 Pangu 进程是 background session, 无 GUI context, 默认拿不到摄像头. handoff 把请求委托到 Terminal/Cursor 的 GUI session. **完全退出 (Cmd+Q) 并重启 Terminal/Cursor 是必须的**, 否则 TCC 不刷新.\n\n返回: 成功 = PNG 文件路径 + size + handoff 用了哪条路. 失败 = `CAMERA_PERMISSION_DENIED` + user_action.',
    parameters: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'AVFoundation 设备名 (默认 "MacBook Pro相机", 中文系统名)' },
        output: { type: 'string', description: '输出 PNG 路径 (默认 /tmp/pangu-eye-{ts}.png)' }
      }
    },
    meta: { required_capabilities: ['media'] }
  }
  },
record_audio: {
  type: 'function',
  function: {
    name: 'record_audio',
    description: '**盘古长出耳朵** — 用 macOS 麦克风录一段音频.\n\n走 AVFoundation (ffmpeg), 默认设备 `MacBook Pro麦克风`.\n2 路 handoff (execFile → launchctl asuser).\n\n返回: WAV 文件路径 + 时长 + handoff.',
    parameters: {
      type: 'object',
      properties: {
        device: { type: 'string', description: 'AVFoundation 设备名 (默认 "MacBook Pro麦克风")' },
        duration_s: { type: 'number', default: 3, description: '录多少秒 (默认 3)' },
        output: { type: 'string', description: '输出音频路径 (默认 /tmp/pangu-ear-{ts}.wav)' }
      }
    },
    meta: { required_capabilities: ['media'] }
  }
  },
  dispatch_subagents: require('../dispatch_subagents_schema').TOOL,
};
