'use strict';
/**
 * tools_schema/computer_use.js —— 工具参数 Schema 的一段 (第 97 批从 tools_schema.js 拆出)
 *
 * 2026-10-26 第 107 批: 文件名从 desktop_ui.js 改成 computer_use.js。
 *   原名里的 "desktop" 指的是**电脑操作**（截屏/点击/打字），不是那个
 *   已被下线的 Web 图形界面。桌面端下线后留着这名字，会让人以为这个文件
 *   是界面层的、该跟着一起删 —— 实际它装的是 core 的 computer_use 工具组。
 *   **只改文件名, 内容一个字没动**（tools-schema-split 守卫按 sha1 逐字对过）。
 *
 * 拆分纪律 (三条, 一条都不能破):
 *   1. **顺序不变** —— 工具顺序会进 LLM 提示词, 分段必须连续、合并必须按序
 *   2. **内容逐字不变** —— 守卫 tests/tools-schema-split-20261025.test.js 用
 *      拆分前抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对
 *   3. **不改词表** —— 这里只放 schema, 一行语义都不许动
 */

module.exports = {
    screenshot: {
      type: 'function',
      function: {
        name: 'screenshot',
        description: '截取当前屏幕(macOS screencapture)。**触发场景**:用户说"截图/截屏/看屏幕/截个图"时调用。**也用于 computer_use 闭环的前置步骤**(vision 模型需要看截图才能判断点击位置)。默认存到 /tmp/pangu_screenshot.png。**注意**:macOS Retina 屏截图是物理像素(如 6400x3600),传给 computer_use_click 时直接用物理坐标。',
        parameters: {
          type: 'object',
          properties: {
          path: { type: 'string', description: '保存路径,默认 /tmp/pangu_screenshot.png' },
          delay: { type: 'number', description: '截图前等待秒数,默认 0' }
        },
          required: []
        },
        meta: { required_capabilities: ['vision'] }}
    },
    computer_use_click: {
      type: 'function',
      function: {
        name: 'computer_use_click',
        description: '鼠标点击屏幕指定坐标 (AppleScript + System Events)。**触发场景**:用户说"点屏幕/点击/鼠标点XX/点开XX/按下XX"且**已经给了坐标**时调用。**坐标是屏幕物理像素**(Retina 2x,3200x1800 逻辑屏对应 6400x3600 物理)。例:"点屏幕 100,200"→click(100,200);"在微信图标上点一下"(无坐标时,应先 screenshot + vision 模型推断坐标)。**注意**:首次调用会触发 System Events 授权弹窗,需要用户在"系统设置 → 隐私与安全 → 辅助功能"批准。',
        parameters: {
          type: 'object',
          properties: {
            x: { type: 'number', description: '屏幕物理 x 坐标(Retina 屏要 ×2)' },
            y: { type: 'number', description: '屏幕物理 y 坐标(Retina 屏要 ×2)' },
            button: { type: 'string', description: 'left/right/middle,默认 left' },
            double: { type: 'boolean', description: '是否双击,默认 false' }
          },
          required: ['x', 'y']
        },
        meta: { required_capabilities: ['vision', 'computer_use'] }}
    },
    computer_use_type: {
      type: 'function',
      function: {
        name: 'computer_use_type',
        description: '在当前焦点窗口输入文本 (AppleScript keystroke)。**触发场景**:用户说"输入XX/键入XX/打字/在XX里输XX"时调用。**前置条件**:必须先确保目标输入框有焦点(可先用 computer_use_click 点击输入框)。**特殊字符**:中文/Unicode 部分场景可能不稳定,纯 ASCII/英文最稳。',
        parameters: {
          type: 'object',
          properties: {
            text: { type: 'string', description: '要输入的文本' },
            delay_ms: { type: 'number', description: '输入后等待毫秒,默认 0' }
          },
          required: ['text']
        },
        meta: { required_capabilities: ['computer_use'] }}
    },
    computer_use_key: {
      type: 'function',
      function: {
        name: 'computer_use_key',
        description: '按键盘按键 (AppleScript keystroke)。**触发场景**:用户说"按回车/按 Enter/按 Tab/按 ESC/按方向键/按删除"时调用。**修饰键**:modifiers 是数组,如 ["cmd","shift"]。例:"按回车"→key("return");"按 Cmd+S"→key("s",["cmd"]);"按 Cmd+Shift+P"→key("p",["cmd","shift"])。**常用键名**:return/tab/space/escape/up/down/left/right/delete/backspace/a-z/0-9。',
        parameters: {
          type: 'object',
          properties: {
            key: { type: 'string', description: '键名,如 return/tab/space/escape/up/down/left/right/delete/a/s/p 等' },
            modifiers: { type: 'array', items: { type: 'string' }, description: '修饰键数组,可选 cmd/shift/option/control' }
          },
          required: ['key']
        },
        meta: { required_capabilities: ['computer_use'] }}
    },
    computer_use_drag: {
      type: 'function',
      function: {
        name: 'computer_use_drag',
        description: '从坐标 (x1,y1) 拖到 (x2,y2) (AppleScript 简化版:click + click target)。**触发场景**:用户说"拖动XX到XX/拖拽XX/把窗口拖到XX"时调用。duration 是拖拽耗时(秒),默认 0.5。**注意**:当前实现是简化版(两次 click),复杂拖拽场景可能不完美,后续可用 cliclick 或原生 mouse event 升级。',
        parameters: {
          type: 'object',
          properties: {
            x1: { type: 'number', description: '起点物理 x' },
            y1: { type: 'number', description: '起点物理 y' },
            x2: { type: 'number', description: '终点物理 x' },
            y2: { type: 'number', description: '终点物理 y' },
            duration: { type: 'number', description: '拖拽耗时(秒),默认 0.5' }
          },
          required: ['x1', 'y1', 'x2', 'y2']
        },
        meta: { required_capabilities: ['vision', 'computer_use'] }}
    },
    computer_use_vision_act: {
      type: 'function',
      function: {
        name: 'computer_use_vision_act',
        description: '**Vision 闭环**(LM Studio vision 模型驱动): screenshot → vision 模型看图 → 自动执行 click/type/key。**触发场景**:用户说"点开XX/打开XX/截屏看看然后点XX/分析屏幕后点击"时用。**与 computer_use_click 的区别**:computer_use_click 需要用户给坐标;computer_use_vision_act 由 vision 模型推断坐标。**前置条件**:LM Studio (port 1234) 已加载任一支持 vision 的模型 — 通过 ctx.config.vision.model 或 injectedTools._visionModel 配置（默认 fallback 到 ctx.config.llm.current_model_id，需实测是否支持 vision）。**返回**:截图路径 + vision 描述 + 执行的工具名和参数。',
        parameters: {
          type: 'object',
          properties: {
            instruction: { type: 'string', description: '自然语言指令,如"打开微信/点开设置/截屏看看当前界面"' },
            savePath: { type: 'string', description: '截图保存路径,默认 /tmp/pangu_vision_screenshot.png' }
          },
          required: ['instruction']
        },
        meta: { required_capabilities: ['vision', 'computer_use'] }}
    },
};
