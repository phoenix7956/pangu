// tool-contract-regression.test.js — 2026-10-09 内核审计发现的问题
// 起因: 老板贴了一段真实对话, 盘古查股票全程失败且编数据。根因链:
//   1) web_search 的 schema 声明参数叫 q, 实现只读 query → 模型永远传 q → 搜索从未成功过
//   2) 没有任何"名称→股票代码"的工具 → 模型只能凭记忆猜, 把内蒙新华(603230) 猜成
//      600295(鄂尔多斯) / 600311, 然后拿错票的数据当目标票汇报
//   3) push2.eastmoney 行情接口被限流, 而 stock_quote / stock_history 没有任何兜底
//      → 模型只拿到 FETCH_FAILED, 于是转头编数据
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MODULES = path.join(__dirname, '..', 'modules');
// 2026-10-25 (第 97/98 批): 工具实现按域拆进了 modules/tools/*.js, 工具 schema 拆进了
//   modules/tools_schema/*.js —— 原来「只读门面一个文件」的源码扫描会**漏掉拆出去的部分**。
//   ⇒ 工具源码读**全部**文件 (门面 + 各族), 一行都不漏; schema 改读**运行时真源**
//   (比读源码文本更强: 源码文本能被注释/废弃条目骗过, 运行时注册表骗不了)。
const toolsSrc = (() => {
  const dir = path.join(MODULES, 'tools');
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.js'))
    .sort()
    .map(f => fs.readFileSync(path.join(dir, f), 'utf8'))
    .join('\n');
})();
const TOOLS_SCHEMA = require(path.join(MODULES, 'tools_schema')).TOOLS_SCHEMA;
const streamSrc = fs.readFileSync(path.join(MODULES, 'pangu_agent_stream.js'), 'utf8');
// 2026-10-21: 卦块正文搬进 modules/gua_block.js (唯一真源) —— 顺序指令现在住在那儿。
const guaBlockSrc = fs.readFileSync(path.join(MODULES, 'gua_block.js'), 'utf8');
const singleSrc = fs.readFileSync(path.join(__dirname, '..', 'pangu-single.js'), 'utf8');

test('web_search: schema 的 q 与实现的 query 必须都能收', () => {
  assert.ok(
    /const query = params\.q \|\| params\.query/.test(toolsSrc),
    'web_search 必须同时接受 q(schema 名)和 query(实现旧名) — 只读一个会让搜索永远失败',
  );
});

test('必须有 stock_resolve(名称→代码), 否则模型只能猜代码', () => {
  assert.ok(/stock_resolve: async \(ctx\)/.test(toolsSrc), '缺少 stock_resolve 工具实现');
  assert.ok(
    !!TOOLS_SCHEMA.stock_resolve
      && !!TOOLS_SCHEMA.stock_resolve.function
      && TOOLS_SCHEMA.stock_resolve.function.name === 'stock_resolve',
    'stock_resolve 必须注册进 schema, 否则模型看不见',
  );
  // 解析走东财 suggest(与 push2 行情是不同主机, 行情被限流时它仍可用)
  assert.ok(/searchapi\.eastmoney\.com\/api\/suggest\/get/.test(toolsSrc), 'stock_resolve 应走 suggest 接口');
});

test('stock_resolve 必须挂进会用行情的角色白名单', () => {
  const saSrc = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  // 2026-10-18 拼音统一: 按 ROLES 字面量位置切片, 键名跟着换 (analyzer→li, checker→dui)。
  // 断言内容不变 —— 两个角色都仍必须挂 stock_resolve 且提示词禁止猜代码。
  for (const role of ['li', 'dui']) {
    const idx = saSrc.indexOf(`  ${role}: {`);
    assert.ok(idx > -1, `找不到角色 ${role}`);
    const seg = saSrc.slice(idx, saSrc.indexOf('  },', idx));
    assert.ok(seg.includes("'stock_resolve'"), `${role} 的工具白名单必须含 stock_resolve — 不然模型根本看不到它`);
    assert.ok(seg.includes('绝不凭记忆猜'), `${role} 的 system 提示必须写明"禁止猜代码"`);
  }
});

test('行情工具有兜底源, 主源挂掉时模型仍能拿到真数据', () => {
  assert.ok(/_stockQuoteFallback/.test(toolsSrc), 'stock_quote 需要兜底(腾讯行情)');
  assert.ok(/_stockHistoryFallback/.test(toolsSrc), 'stock_history 需要兜底(腾讯K线)');
  // 兜底要接全 3 条路径: stock_quote 的 NO_DATA + catch, stock_history 的 catch
  const fbCalls = toolsSrc.match(/if \(fb\) return fb;/g) || [];
  assert.strictEqual(fbCalls.length, 3, `兜底应接 stock_quote(NO_DATA+catch) 与 stock_history(catch) 共 3 处, 实际 ${fbCalls.length}`);
});

test('起卦与事实: 取数类问题不起卦, 且提示词要求事实优先', () => {
  // 起卦开关独立于 dispatcher, 不再"什么都起卦"
  assert.ok(/function _shouldCastGua\(userInput\)/.test(singleSrc), '应有独立的起卦判定 _shouldCastGua');
  // 2026-10-23 第 58 批: 词表搬去 modules/gua_gate_kws.js 后,
// `/_GUA_SUPPRESS_KWS/.test(singleSrc)` 只会匹配到解构别名那一行 —— **守卫变哑了**
  // (断言还在, 但不再验任何东西)。改成验**唯一真源里那张表本身**。
  const { GATE } = require('./helpers/gua_gate_load.js');
  assert.ok(GATE.GUA_SUPPRESS_KWS.length >= 20, '取数类抑制表不该是空的或只剩几条');
  for (const kw of ['查一下', '看看', '统计']) {
    assert.ok(GATE.GUA_SUPPRESS_KWS.includes(kw), '取数类关键词应能抑制起卦, 缺: ' + kw);
  }
  // 2026-10-13 (现场 longwork-1791848550): 上一版这里断言的是 `||` 字面量,
  // 而 `||` 恰好**不是**这条断言自己写的那个意图 —— pangu-single 把两张表都接进 deps,
  // 兜底分支永不触发, 实际语义是"只要走 dispatcher 就起卦"。纯执行任务(创建 40 个文件)
  // 因此被挂了卦象, 答案开头变成「大壮初九…不宜抢进」。改成三元才是"优先 + 缺失才回退"。
  // 断言意图而不是断言旧字面量: 意图对了写法换一种不该拦; 意图错了写法再像也不放行。
  assert.ok(
    /_deps\._shouldCastGua[\s\S]{0,80}\?\s*_deps\._shouldCastGua[\s\S]{0,40}:\s*_deps\._shouldUseDispatcher/.test(streamSrc),
    '起卦应优先用 _shouldCastGua, 老 deps 缺失时回退 _shouldUseDispatcher',
  );
  // 注意参数顺序: doesNotMatch(string, regexp, message)
  assert.doesNotMatch(
    streamSrc,
    /_deps\._shouldCastGua\s*\|\|/,
    '起卦开关不得 OR 上 dispatcher: 那是"走 dispatcher 就起卦", 不是回退',
  );
  // 提示词: 没有卦象块就不许写卦象定调; 事实必须在卦象之前
  assert.ok(/绝对不要\*\*自己编卦象/.test(singleSrc), '系统提示词应写明: 无卦象块时禁止编卦象定调');
  assert.ok(/事实永远优先于卦象/.test(singleSrc), '系统提示词应写明事实优先于卦象');
  assert.ok(
    /先给已核实的事实\/结论/.test(guaBlockSrc),
    '【盘古起卦】块内的顺序指令也应改成"先给事实, 卦象定调在之后"',
  );
  // 块正文只有一份 (三处各抄一份 → 改一次断一次, 见 gua_block.js 顶上的教训)
  assert.ok(/formatGuaFirstBlock/.test(streamSrc),
    'pangu_agent_stream 必须用 gua_block.js 的格式化函数, 不要自己再抄一份块正文');
});

test('实体锚定: 标识符一旦确定必须沿用', () => {
  assert.ok(
    /实体锚定/.test(singleSrc) && /不得改写、不得凭记忆替换/.test(singleSrc),
    '系统提示词应要求标识符(股票代码/路径等)一旦确定后续沿用',
  );
});
