const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TOOLS_SCHEMA } = require('../modules/tools_schema');

// 现场证据 (2026-10-12, 会话 stockprobe-01/02): 问盘古 "查一下英伟达 NVDA 的最新股价",
// 连问三次全部零可用结果。抓到的账本实况:
//
//   cmds_failed: [{ tool: "crypto_price", args: "{\"symbol\":\"NVDA\"}",
//                   error: "所有源都失败: Binance: timeout | OKX: ENOTFOUND | CoinGecko: timeout" }]
//
// 模型为什么去调 crypto_price? 它的 reasoning_content 原话:
//   "stock_quote is for A-share (东方财富), not US. crypto_price says stock code like
//    AAPL / 600519 maybe supports US? Let's check crypto_price for NVDA."
//
// 它是照着 schema 里的话推理的 —— crypto_price 的 symbol 参数描述写着
//   "股票代码 (如 AAPL / 600519)"
// 而这个工具是**加密货币**价 (Binance / OKX / CoinGecko 三源)。描述直接把它指向了股票。
// 一个字写错, 模型就去调错工具; 调完超时, 整轮无产出。

test('crypto_price 是加密货币工具, 参数描述不许出现股票代码示例', () => {
  const p = TOOLS_SCHEMA.crypto_price.function.parameters;
  const sym = p.properties.symbol.description || '';
  // 禁的是"把股票代码当成本工具的入参示例", 不是禁"提一句股票" ——
  // 指路 (股票请用 stock_resolve) 是修复的一部分, 要允许。
  assert.doesNotMatch(sym, /AAPL|600519|600000|ticker/i,
    `crypto_price 的 symbol 描述写着股票代码示例, 模型会照着去调它: "${sym}"`);
  assert.doesNotMatch(sym, /(股票代码|stock code)[^。]{0,12}[（(]/,
    `symbol 描述把入参定义成了股票代码: "${sym}"`);
  assert.match(sym, /不是股票|币种对/, `symbol 描述要点明这是币种对: "${sym}"`);
  assert.match(sym, /BTC|ETH|USDT|币/i,
    '描述要说清这是币种对, 让模型一眼分得清股票和加密货币');
});

test('加密货币与股票工具必须互相点名, 别让模型自己猜哪个是哪个', () => {
  const cp = String(TOOLS_SCHEMA.crypto_price.function.description || '')
    + String(TOOLS_SCHEMA.crypto_price.function.parameters.properties.symbol.description || '');
  assert.match(cp, /stock_resolve|stock_quote/,
    'crypto_price 要写明"股票请走 stock_resolve/stock_quote", 把模型从错工具上掰回来');
});

test('stock_quote 只支持 A 股, 描述必须说清 (别让模型拿美股来试)', () => {
  const desc = String(TOOLS_SCHEMA.stock_quote.function.description || '');
  assert.match(desc, /A\s*股|沪|深|6\s*位/,
    `stock_quote 实际只走东方财富 A 股, 描述必须写明, 否则模型会拿美股/港股代码来试: "${desc}"`);
});

test('recognizeCode 认不出来时要说清只支持什么 (美股港股目前不支持)', () => {
  // 2026-10-25 (第 98 批): 工具实现按域拆进 modules/tools/*.js ⇒ 读**全部**工具源文件,
  //   只读门面会把 stock_quote 那段漏掉。
  const src = (() => {
    const dir = path.join(__dirname, '..', 'modules', 'tools');
    return fs.readdirSync(dir).filter(f => f.endsWith('.js')).sort()
      .map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  })();
  const m = src.match(/BAD_CODE'[^\n]*无法识别的代码/);
  assert.ok(m, '没找到 stock_quote 的 BAD_CODE 分支');
  assert.match(src, /无法识别的代码[\s\S]{0,220}(A\s*股|沪|深|美股|港股|暂不)/,
    'BAD_CODE 的报错必须说清支持范围 —— 现在只说"无法识别", 模型拿不到下一步的线索');
});
