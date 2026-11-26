'use strict';
// 2026-10-13 soak-live-1791880619 现场 (修完「转述当真源」之后的下一层):
//
// 三个 executor 子会话 (sub-0/sub-1/sub-3) 全是 5 条消息收场, 最后一条 system:
//   [SELF_CORRECT_FAIL] tool=code_execute verdict=incorrect
//   reason=tool 返 ok=false, 错误码 FORBIDDEN_PY — 需重规划
// 8 份文件**一份都没写出来**。模型想批量写 8 个文件, 选了 code_execute
// (Python 批量 open-write), 撞上 modules/tools/index.js:1787 的 FORBIDDEN_PY
// 拦截器 (open('x','w') 在禁字表里)。
//
// 拦截器本身是对的 —— code_execute 是通用代码执行器, 本不该被当批量写文件用。
// 但模型选错工具, 是因为三处现场:
//   ① 角色白名单里 code_execute 排得很靠前 (sub-agent.js executor 白名单第 5 位),
//      紧挨 write_file, 模型自然挑"靠前 + 能批量"的;
//   ② code_execute 的 schema 描述只写「执行Python/JS代码」, 没说不许写文件,
//      Python 最自然的批量写盘就是 open(f,'w') —— 直接撞 FORBIDDEN_PY;
//   ③ global_agent_rules.js 的 Tier 1 列表也把 code_execute 列进「优先」。
//
// 修法三层 (本测试全部钉住):
//   A. prompt 层: code_execute 描述加禁区 (批量/新建文件用 write_file / exec_command heredoc,
//      Python 代码禁止 open() 写盘 / import os / subprocess —— 会被 FORBIDDEN_PY 拦);
//   B. 排序层: 两个白名单里 code_execute 一律排到 write_file / file_edit / exec_command
//      之后 (确定性写盘工具之后), 且不占 Tier 1 前三;
//   C. 规则层: global_agent_rules Tier 1 列表里 code_execute 不再与写盘工具并列「优先」,
//      且规则文案里点明「code_execute 不用于写文件」。
//
// 判定标准: 修前 A/B/C 三条全红; 修后全绿。
const test = require('node:test');
const assert = require('node:assert/strict');

const toolsIndex = require('../modules/tools/index.js');
const { TOOLS_SCHEMA } = require('../modules/tools_schema.js');
const subAgent = require('../agents/sub-agent.js');
const dispatcher = require('../agents/qian.js');
const { GLOBAL_AGENT_RULES } = require('../modules/global_agent_rules.js');

// ---- A. prompt 层: code_execute schema 描述必须把写文件禁区说死 ----
test('A: code_execute schema 描述必须点明「不用于写文件, 被 FORBIDDEN_PY 拦」', () => {
  const schema = TOOLS_SCHEMA.code_execute;
  assert.ok(schema, 'code_execute 工具 schema 本身必须存在 (前提校验)');
  const desc = schema.function.description || '';
  assert.match(desc, /FORBIDDEN_PY|拦截/i,
    'code_execute 描述必须提前说明 Python 写盘会被 FORBIDDEN_PY 拦 (现场: 模型撞了才发现)');
  assert.match(desc, /write_file|exec_command/i,
    'code_execute 描述必须把「新建/批量写文件」指到正路 (write_file / exec_command)');
  // 原描述「执行Python/JS代码」不能继续当完整描述 (模型照它选了 code_execute 写 8 个文件)
  assert.ok(desc.length > ('代码执行 - 执行Python/JS代码').length,
    'code_execute 描述必须比旧版「执行Python/JS代码」更具体 —— 旧版是 1791880619 选错工具的直接诱因');
});

// ---- B. 排序层: 白名单里 code_execute 不得压在写盘工具前面 ----
function assertOrder(list, label) {
  const ci = list.indexOf('code_execute');
  assert.ok(ci >= 0, label + ': code_execute 本来就在白名单里 (不许顺手删掉 —— 它仍有合法用途: 跑脚本/数据处理)');
  assert.ok(ci < list.length - 1 || list.length <= 6, label + ': 红线 —— code_execute 被挪到列表最尾但整体仍是完整白名单 (防"挪到末尾=删掉"的假绿)');
  for (const writeTool of ['write_file', 'exec_command']) {
    const wi = list.indexOf(writeTool);
    assert.ok(wi >= 0 && wi < ci,
      label + ': ' + writeTool + ' (写盘工具, idx ' + wi + ') 必须排在 code_execute (idx ' + ci + ') 之前 —— 现场: code_execute 排在前面, 模型被工具顺序带偏去批量写文件');
  }
  const fei = list.indexOf('file_edit');
  if (fei >= 0) {
    assert.ok(fei < ci,
      label + ': file_edit (idx ' + fei + ') 也必须排在 code_execute (idx ' + ci + ') 之前');
  }
}

test('B1: sub-agent.js executor 白名单里 code_execute 排在写盘工具之后 (红线: 修前 code_execute idx=5, 紧跟 write_file 后面但仍是模型批量写文件首选)', () => {
  const list = subAgent.ROLES.kun.tools;
  const ci = list.indexOf('code_execute');
  assert.ok(ci > 0, '修前现场锚: code_execute 本来就不在第 0 位 (前提校验, 防"删了它就算过了"的假绿)');
  assertOrder(list, 'sub-agent executor');
});

test('B2: dispatcher.js ROLES.kun 白名单里 code_execute 排在写盘工具之后', () => {
  assertOrder(dispatcher.ROLES.kun.tools, 'dispatcher executor');
});

// ---- C. 规则层: global_agent_rules Tier 1 文案不许把 code_execute 当「写文件首选」----
test('C: global_agent_rules Tier 1 不再把 code_execute 与写盘工具并列「优先」', () => {
  const lines = GLOBAL_AGENT_RULES.split('\n');
  const tier1 = lines.filter(l => l.includes('Tier 1') && l.includes('exec_command'));
  assert.ok(tier1.length >= 1, '前提校验: 确实存在 Tier 1 规则行 (18901 线上跑的就是这段文案)');
  for (const l of tier1) {
    const idxExec = l.indexOf('exec_command');
    const idxWrite = l.indexOf('write_file');
    const idxCode = l.indexOf('code_execute');
    // code_execute 要么不在 Tier 1 优先列表里, 要么排到 exec/write 之后
    if (idxCode >= 0) {
      assert.ok(idxExec < idxCode && (idxWrite < 0 || idxWrite < idxCode),
        'Tier 1 规则行里 code_execute 不得排在 exec_command / write_file 前面: ' + l.slice(0, 120));
    }
  }
  // 规则文案必须点明 code_execute 不用于写文件
  assert.match(GLOBAL_AGENT_RULES, /code_execute[^\n]*(不用于|不是|禁止|别|勿).*写|code_execute[^\n]*写[^\n]*(不用于|不是|禁止|别|勿)/,
    'global_agent_rules 必须有一句话点明 code_execute 不适合写文件 (现场: Tier 1 列表里排前面, 模型照单批量 open 写 8 个文件被 FORBIDDEN_PY 拦)');
});

// ---- 现场复现锚: FORBIDDEN_PY 拦截器本身必须存活 (不许把拦截器删了"修"成放行) ----
test('现场锚: FORBIDDEN_PY 拦截器存活 (import os 必拦, 且消息引导到写盘正路)', async () => {
  // 2026-10-13 实测 index.js:1787 的 FORBIDDEN_PY 拦截器 index.js:1787 的 FORBIDDEN_PY 拦截器对**裸 open 写盘是失明的**:
  // 先剥字符串字面量 (open('/tmp/x','w') → open("","").write("")), 再看 /\bopen\s*\([^)]*['"][wa]/ —
  // 剥完 open 的实参里已没有 'w' 字面量, 正则必然失配。已实测 4 种形态全部放行并真写了盘 (/tmp/x /tmp/y)。
  // 所以本锚钉的是「拦截器对能命中的形态仍然生效 + 错误消息引导重规划」, 不是「全部写盘都拦得住」。
  // 盲区 (裸 open 写盘) 的根治在 prompt 层 (A/C): 模型根本不该把 code_execute 当写文件工具。
  // 形态 1: import os —— 剥字符串后 import os 仍在, 必须拦
  const r1 = await toolsIndex.TOOLS.code_execute({
    params: { code: "import os\n", language: 'python' },
  });
  assert.strictEqual(r1.ok, false, 'import os 必须被拦 (剥字符串后 import os 仍在)');
  assert.ok(r1.error && /FORBIDDEN_PY/.test(r1.error.code), '错误码必须是 FORBIDDEN_PY (实际: ' + (r1.error && r1.error.code) + ')');
  // 形态 2: 写盘路径的引导 —— 错误消息必须提示走 write_file / exec_command 正路,
  // 否则模型撞了 FORBIDDEN_PY 只会 SELF_CORRECT_FAIL 重规划, 不知道正路在哪 (现场 5 条消息收场, 8 份文件一份没写)。
  assert.match(r1.error.message, /write_file|exec_command/, 'FORBIDDEN_PY 消息必须引导到写盘正路 (write_file / exec_command) —— 现场只有一行 FORBIDDEN_PY, 模型无处可去');
});
