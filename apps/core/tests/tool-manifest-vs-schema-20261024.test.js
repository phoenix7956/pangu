// 第 79 批: 工具清单必须与「这一轮真能调的集」一致 —— 三条判据
//
// 现场 (实跑 probe79-moeduan, 2026-10-24):
//   ① 提示词清单列**全部 130 个**工具, 而 main 的 API schema 只给 **38** 个
//      ⇒ **92 个工具模型看得见、调不到**; 其中 **69 个任何将灵都调不到** (纯死工具)。
//      跟 worker 档 2026-10-16 修过的病是同一个, main 档当时漏了。
//   ② MCP 工具在提示词里写着「44 个 … 跟内部工具一样直接用」, 而 native 路径的
//      toolsSchema 只从 TOOLS_SCHEMA 取 ⇒ TOOLS_SCHEMA 里 `mcp__` 是 **0 个**
//      ⇒ 模型看得见 44 个 MCP 工具, 一个都签不出来 (执行层是通的, 断的是签名)。
//   ③ 这块清单本身 12238 字符 ≈ 5563 token, 而主 agent 整个静态前缀才 ~19.3k
//      ⇒ 首轮 prefill 干等 62 秒 (LM Studio 缓存命中率 58%, 磁盘缓存 100% 满)。
//
// 修法 (llm_caller._loadToolSummary / _mcpSchemasForLLM + j2_agent_loop 的 toolsSchema):
//   ① 清单按「这一轮真能调的集」出 (main = MAIN_GENERAL_TOOLS_FOR_LLM);
//      别的将灵能调的**移出主清单**但标明归属 (派活要用), 死工具整段消失。
//   ② MCP 工具进 API schema, 但 parameters 精简 (参数说明搬进 description)。
//
// 本测试文件只测**判据本身**; 变异测试 (/tmp/mut79.mjs) 证明判据会咬人。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lc = require('../modules/llm_caller');
const { TOOLS_SCHEMA, MAIN_GENERAL_TOOLS_FOR_LLM } = require('../modules/tools_schema');

const MAIN_SET = new Set(MAIN_GENERAL_TOOLS_FOR_LLM);
const CORE = path.join(__dirname, '..');

// 从清单里解析出「主清单」段落里的工具名。
// 主清单 = 「## 全部工具」到下一个 ## 之前; 派活层 = 「## 你调不到…」段。
function parseManifest(block) {
  const s = String(block);
  const mainPart = s.split('## 全部工具')[1] || '';
  const mainSec = mainPart.split('## ')[0];
  const mainNames = new Set();
  for (const m of mainSec.matchAll(/^- \*{0,2}([a-z_][a-z0-9_]*)\*{0,2}\(/gm)) mainNames.add(m[1]);
  const delegatePart = s.split('## 你调不到')[1] || '';
  const delegateNames = new Set();
  for (const m of delegatePart.matchAll(/^- \*{0,2}([a-z_][a-z0-9_]*)\*{0,2}\(/gm)) delegateNames.add(m[1]);
  return { mainNames, delegateNames, text: s };
}

test('① 主清单里不许出现 main 调不到的工具 (看得见调不到 = 白烧一轮)', () => {
  const { mainNames } = parseManifest(lc._loadToolSummary());
  const ghosts = [...mainNames].filter((n) => !MAIN_SET.has(n));
  assert.equal(ghosts.length, 0,
    `主清单里有 ${ghosts.length} 个 main 调不到的工具: ${ghosts.slice(0, 10).join(', ')}… `
    + '(模型会去调, 撞 tool not found, 白烧一整轮本地推理)');
});

test('① 主清单不许漏掉 main 调得到的工具 (能调但看不见 = 永远不会去调)', () => {
  const { mainNames } = parseManifest(lc._loadToolSummary());
  const missing = [...MAIN_SET].filter((n) => !mainNames.has(n) && TOOLS_SCHEMA[n]);
  assert.equal(missing.length, 0,
    `${missing.length} 个 main 能调的工具在清单里隐身: ${missing.slice(0, 10).join(', ')}…`);
});

test('① 死工具整段消失 (任何将灵都调不到的那种, 不许教模型去撞墙)', () => {
  const { text } = parseManifest(lc._loadToolSummary());
  // 这几个在执行表 TOOLS 里都有, 但不在任何角色的白名单里 ⇒ 纯死工具。
  // ⚠ 2026-10-30 第 172 批: send_wechat 从这里**移出去了** ——
  //   盘古自己接了微信 (modules/weixin_channel.js 直连 iLink), 它不再是空壳,
  //   而且进了 MAIN_GENERAL_TOOLS_FOR_LLM ⇒ 主 agent 真能调。
  //   死工具断言的前提是"执行表里有但没人调得到", send_wechat 现在两条都不成立。
  const DEAD = ['translate_text', 'git_commit', 'git_status',
    'screenshot', 'computer_use_click', 'initial_assessment', 'caution_signal',
    'wait_action', 'opportunity_check', 'first_step', 'peak_detection'];
  const alive = DEAD.filter((n) => text.includes(n));
  assert.equal(alive.length, 0,
    `死工具还在清单里: ${alive.join(', ')} — 没有任何将灵能调它们, 列出来只是教模型撞墙`);
});

test('① send_wechat 现在是活工具 (第 172 批: 盘古自己接微信)', () => {
  const { text } = parseManifest(lc._loadToolSummary());
  assert.ok(text.includes('send_wechat'),
    'send_wechat 不在清单里 —— 老板在微信那头跟盘古说话, 盘古得**看得见**这个工具才能回话');
  const { MAIN_GENERAL_TOOLS_FOR_LLM } = require(path.join(CORE, 'modules', 'tools_schema'));
  assert.ok(MAIN_GENERAL_TOOLS_FOR_LLM.includes('send_wechat'),
    'send_wechat 必须进 main 工具集, 否则主 agent 看得见调不到');
});

test('① 派活层必须保住 (别的将灵能调的不能一起砍掉, 否则主 agent 瞎派)', () => {
  const { delegateNames } = parseManifest(lc._loadToolSummary());
  // web_fetch 只有 li 能调; weather_check 只有 dui 能调 —— 派活时要靠这个。
  for (const n of ['web_fetch', 'weather_check']) {
    assert.ok(delegateNames.has(n), `${n} 能派给别的将灵, 必须在派活层里标明归属`);
  }
});

test('② MCP 工具必须进 API schema (提示词说能调, schema 里没有 = 签不出来)', () => {
  const loopSrc = fs.readFileSync(path.join(CORE, 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.match(loopSrc, /_mcpSchemasForLLM/,
    'j2_agent_loop 的 toolsSchema 必须并进 MCP 工具 —— 否则模型看得见 44 个 MCP 工具却一个都调不了');
  assert.match(loopSrc, /toolsSchema\.push\(\.\.\._mcpSchemas\)/,
    'MCP schema 必须真的 push 进 toolsSchema, 不许只算不用');
});

test('② MCP 工具不许给 main (82 个工具的选择噪声 = 模型一个都不调)', () => {
  // 实测对照 (同一句「现在几点了?」, 同一模型, 唯一差别是这 44 个 MCP 工具):
  //   · 38 个工具 (HEAD): 调了 current_time + task_done ⇒ success:true, 84.8s
  //   · 82 个工具 (加了 MCP): **零工具调用** ⇒ success:false, 100.7s
  // current_time 一直在 schema 里 (位置 20/38) —— 问题是 44 个用不上的工具
  // 挤在后面把选择淹了。跟 2026-07-25「LLM 看到 110 工具全可选 → 优先级混乱」同一个病。
  const loopSrc = fs.readFileSync(path.join(CORE, 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.match(loopSrc, /if\s*\(_roleForThisLoop\s*!==\s*'main'\)\s*\{[\s\S]{0,400}?_mcpSchemasForLLM/,
    'MCP 工具只给 worker (子 agent 干查 GitHub/读文件这类活), 不许进 main 的工具位');
  const mainPush = loopSrc.match(/if\s*\(_roleForThisLoop\s*!==\s*'main'\)\s*\{([\s\S]{0,600}?)\n\s*\}/);
  assert.ok(mainPush, '没找到 MCP 工具的角色守卫');
  const guarded = mainPush[1];
  assert.ok(guarded.includes('_mcpSchemasForLLM') && !/_effectiveTools/.test(guarded),
    'MCP 工具的取数必须在 main 守卫内');
});

test('② MCP schema 的 parameters 必须精简 (完整版 11.5k token, 会把 prefill 顶爆)', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'llm_caller.js'), 'utf8');
  const fn = src.slice(src.indexOf('function _mcpSchemasForLLM'));
  const body = fn.slice(0, fn.indexOf('\n}\n') + 2);
  assert.match(body, /parameters:\s*\{\s*type:\s*'object',\s*properties:\s*\{\}/,
    'MCP 工具的 parameters 必须给空对象 (参数说明搬进 description) —— '
    + '完整版 44 个要 11527 token, 正好是本批要治的 prefill 病');
  assert.match(body, /\[参数:/,
    '参数说明必须搬进 description, 不许直接丢 —— 模型靠它拼参数');
});

test('③ 清单块不许再回到 12k 字符 (静态前缀越大, 首轮 prefill 越久)', () => {
  const block = String(lc._loadToolSummary());
  assert.ok(block.length < 8000,
    `工具清单一共 ${block.length} 字符 —— 改前是 12238 (≈5563 token), `
    + '每轮都压在静态前缀最前面, 直接拖长首轮 prefill');
});

test('③ 头部声明的工具数必须等于真数 (不许声明一个数、列另一个数)', () => {
  const block = String(lc._loadToolSummary());
  const declared = Number((block.match(/\*\*实际能调\*\*\s*的\s*(\d+)\s*个/) || [])[1]);
  const { mainNames } = parseManifest(block);
  assert.equal(declared, mainNames.size,
    `头部声明 ${declared} 个, 主清单实列 ${mainNames.size} 个`);
});

test('③ 清单必须写清「这一轮实际能调」 (别再宣称拥有全量 130 个)', () => {
  const block = String(lc._loadToolSummary());
  assert.match(block, /实际能调/,
    '头部必须说清这是「这一轮你能调的」, 否则模型按全量清单去调');
  assert.doesNotMatch(block, /Pangu 拥有的 \d+ 个/,
    '不许再宣称「Pangu 拥有的 N 个」 —— 那是全量口径, 与这一轮的可调集不是一回事');
});
