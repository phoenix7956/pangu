const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const lc = require('../modules/llm_caller');
const { TOOLS_SCHEMA } = require('../modules/tools_schema');

// 现场证据 (2026-10-12): 问盘古 "查一下英伟达 NVDA 的最新股价" → **零工具调用**,
// 答复 "没拿到数据: 子任务实际调用工具数为 0"。而 stock_resolve / stock_quote 直调完全正常
// (stock_resolve('英伟达') 直接返回 NVDA + secid 105.NVDA)。
//
// 根因: _loadToolSummary() 硬限 6000 字符, 全量带说明要 9344 字节 —— 只能塞下 89 个,
// **38 个工具模型压根不知道存在**, 其中就有 stock_quote / stock_resolve / tts_speak。
// 钱花在让 89 个工具的描述更啰嗦上, 同时让 38 个工具彻底隐身。

const ALL = Object.keys(TOOLS_SCHEMA);

// 2026-10-24 (第 79 批): 本文件的**原意保留** (能调的工具不许隐身、必填参数要露出来),
// 但**口径改了**: 从「全量 130 个」换成「**这一轮真能调的集**」。
//
// 为什么改口径 (不是删测试, 是它的假设已经不成立):
//   这份测试 2026-10-12 立的时候, 现场是「问英伟达股价 → 零工具调用」, 根因是
//   清单被 6000 字符截断, 89 个里塞不下 38 个 —— 于是"全量列出来"成了当时的解法。
//   但**全量列出来 ≠ 能调**:
//   · 实测 (2026-10-24): stock_quote / stock_resolve / tts_speak **根本不在 main 的
//     API 白名单** (MAIN_GENERAL_TOOLS_FOR_LLM, 38 个) —— 它们当年就调不到,
//     清单列着只是教模型去撞墙 (白烧一整轮 ~40s 本地推理)。
//   · 实测: 清单里的 92 个「不在 main schema」的工具, 其中 **69 个任何将灵都调不到**
//     (逐角色 buildRoleToolFilter 算出来全是空) —— 是纯死工具。
//   ⇒ 「看得见但调不到」比「看不见」更糟。worker 档 2026-10-16 已经为同一个病
//     把整块清单剔掉了, main 档当时漏了, 这批补上。
//
// 现在的口径: 清单 = 这一轮**真能调**的集 (main 38 个) + 标明归属的派活层
// (别的将灵能调的, 标"派给谁")。死工具整段不出现。
// 详见 tests/tool-manifest-vs-schema-20261024.test.js。
const { MAIN_GENERAL_TOOLS_FOR_LLM } = require('../modules/tools_schema');
const CALLABLE = new Set(MAIN_GENERAL_TOOLS_FOR_LLM);

// 解析清单: 主清单段 (## 全部工具 到下一个 ##) + 派活层 (## 你调不到… 段)
function parseManifest(block) {
  const s = String(block);
  const mainSec = (s.split('## 全部工具')[1] || '').split('## ')[0];
  const mainNames = new Set();
  for (const m of mainSec.matchAll(/^- \*{0,2}([a-z][a-z0-9_]*)\*{0,2}\(/gm)) mainNames.add(m[1]);
  const delSec = s.split('## 你调不到')[1] || '';
  const delegateNames = new Set();
  for (const m of delSec.matchAll(/^- \*{0,2}([a-z][a-z0-9_]*)\*{0,2}\(/gm)) delegateNames.add(m[1]);
  return { mainNames, delegateNames };
}

test('工具清单必须列出每一个模型能调的工具 —— 一个都不许隐身', () => {
  const { mainNames } = parseManifest(lc._loadToolSummary());
  const missing = [...CALLABLE].filter((n) => !mainNames.has(n));
  assert.equal(missing.length, 0,
    `${missing.length} 个模型能调的工具在清单里隐身, 模型永远不会去调: ${missing.slice(0, 12).join(', ')}…`);
});

test('清单头部声明的工具数必须等于真数 (别声明 127 却只列 89)', () => {
  const block = String(lc._loadToolSummary());
  const declared = Number((block.match(/\*\*实际能调\*\*\s*的\s*(\d+)\s*个/) || [])[1]);
  const { mainNames } = parseManifest(block);
  assert.equal(declared, mainNames.size, '头部声明的工具数与实际列出的对不上');
  assert.equal(declared, CALLABLE.size, '头部声明的工具数与这一轮真能调的集对不上');
});

test('不许列不存在的工具 (清单不许凭空多出条目)', () => {
  const block = String(lc._loadToolSummary());
  const listed = new Set();
  for (const m of block.matchAll(/^- \*{0,2}([a-z][a-z0-9_]*)\*{0,2}\(/gm)) listed.add(m[1]);
  const ghost = [...listed].filter((n) => !ALL.includes(n));
  // MCP 工具 (mcp__server__tool) 合法, 其余必须是真实工具
  const realGhost = ghost.filter((n) => !n.startsWith('mcp__'));
  assert.equal(realGhost.length, 0, `清单里有不存在的工具: ${realGhost.slice(0, 8).join(', ')}`);
});

test('必填参数必须列出来 (不然模型只会传错参数名)', () => {
  const block = String(lc._loadToolSummary());
  // 口径跟着真源走: 这一轮能调的每个工具, 必填参数都得露出来。
  // (原版硬编码 stock_quote / stock_resolve —— 那两个不在 main 白名单里, 属于死工具。)
  const { mainNames } = parseManifest(block);
  for (const name of mainNames) {
    const fn = TOOLS_SCHEMA[name] && TOOLS_SCHEMA[name].function;
    const req = (fn && fn.parameters && Array.isArray(fn.parameters.required) ? fn.parameters.required : []);
    for (const r of req) {
      // 主清单行是 "- name(a,b)"; 说明层行是 "- **name**(a,b): 描述" —— 两种都要认
      const re = new RegExp(`^-\\s*\\**${name}\\**\\([^)]*\\b${r}\\b`, 'm');
      assert.ok(re.test(block),
        `${name} 的必填参数 ${r} 没露出来`);
    }
  }
});

test('persona 里的工具数必须等于真能调的数量, 不许把内部 helper 算进去', () => {
  const { TOOLS } = require('../modules/tools');
  const internal = Object.keys(TOOLS).filter((n) => !TOOLS_SCHEMA[n]);
  assert.ok(internal.length > 0, '前提: TOOLS 命名空间里确实混着内部 helper');
  const factsMod = fs.readFileSync(path.join(__dirname, '..', 'pangu-single.js'), 'utf8');
  const line = factsMod.split('\n').find((l) => l.includes('toolCount:')) || '';
  assert.notEqual(line, '', '没找到 toolCount 定义, 测试本身失效了');
  assert.doesNotMatch(line, /TOOLS\)/,
    'toolCount 直接数 TOOLS 命名空间 (含内部 helper), 与清单的 TOOLS_SCHEMA 口径不一致 —— '
    + `模型会在同一段上下文里看到两个工具数 (当前差 ${internal.length} 个)`);
  assert.match(line, /TOOLS_SCHEMA/, 'toolCount 应当数 TOOLS_SCHEMA (模型真正能调的)');
});

test('源码地图块不许硬编码工具数 (117 是化石, 现在是 127)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');
  const sm = src.match(/自身源码地图[\s\S]{0,1200}/);
  assert.ok(sm, '没找到自身源码地图块');
  assert.doesNotMatch(sm[0], /工具实现 \(\d+ 个\)/,
    '源码地图里的工具数是硬编码的化石数字, 会跟真实清单对不上');
});
