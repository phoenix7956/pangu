'use strict';
/**
 * tools_schema/web_info.js —— 工具参数 Schema 的一段 (第 97 批从 tools_schema.js 拆出)
 *
 * 拆分纪律 (三条, 一条都不能破):
 *   1. **顺序不变** —— 工具顺序会进 LLM 提示词, 分段必须连续、合并必须按序
 *   2. **内容逐字不变** —— 守卫 tests/tools-schema-split-20261025.test.js 用
 *      拆分前抓的基线 (130 个工具的顺序 + 每个 schema 的 sha1) 逐个对
 *   3. **不改词表** —— 这里只放 schema, 一行语义都不许动
 */

module.exports = {
    web_search: {
      type: 'function',
      function: {
        name: 'web_search',
        description: '网络搜索 (SearXNG 优先, 国内 Bing 兜底)',
        parameters: {
          type: 'object',
          properties: {
          q: { type: 'string', description: '搜索关键词, 支持中英文' },
          limit: { type: 'number', description: '返回条数上限' }
        },
          required: ['q']
        },
        meta: { required_capabilities: ['web_access'] }}
    },
    web_fetch: {
      type: 'function',
      function: {
        name: 'web_fetch',
        description: '抓取网页内容 (HTML → text)',
        parameters: {
          type: 'object',
          properties: {
          url: { type: 'string', description: '目标 URL (http/https)' },
          options: { type: 'string', description: '附加选项 (可选)' }
        },
          required: ['url']
        },
        meta: { required_capabilities: ['web_access'] }}
    },
    weather_check: {
      type: 'function',
      function: {
        name: 'weather_check',
        description: '天气查询 - 查询指定城市天气',
        parameters: {
          type: 'object',
          properties: {
          city: { type: 'string', description: '城市名 (中英文均可, 如 上海 / Shanghai)' }
        },
          required: ['city']
        },
        meta: { required_capabilities: ['web_access'] }}
    },
    news_digest: {
      type: 'function',
      function: {
        name: 'news_digest',
        description: '新闻摘要 (RSS 并行)',
        parameters: {
          type: 'object',
          properties: {
          category: { type: 'string', description: '分类 (如 tech / finance / world)' },
          limit: { type: 'number', description: '返回条数上限' }
        },
          required: ['category']
        },
        meta: { required_capabilities: ['web_access'] }}
    },
    translate_text: {
      type: 'function',
      function: {
        name: 'translate_text',
        description: '翻译文本 (MyMemory free API)',
        parameters: {
          type: 'object',
          properties: {
          text: { type: 'string', description: '待处理文本' },
          source_lang: { type: 'string', description: '源语言代码 (如 zh / en, 可选)' },
          target_lang: { type: 'string', description: '目标语言代码 (如 zh / en)' }
        },
          required: ['text']
        },
        meta: { required_capabilities: ['chinese'] }}
    },
    github_api: {
      type: 'function',
      function: {
        name: 'github_api',
        description: 'GitHub API - 调用GitHub API (handler 读 path, 不是 endpoint)',
        parameters: {
          type: 'object',
          properties: {
          path: { type: 'string', description: 'API 路径, 例如 /repos/nodejs/node (从 https://api.github.com 之后)' },
          method: { type: 'string', description: 'HTTP 方法: GET/POST/PUT/DELETE (默认 GET)' },
          body: { type: 'object', description: 'POST/PUT 请求体' }
        },
          required: ['path']
        },
        meta: { required_capabilities: ['web_access'] }}
    },
    send_wechat: {
      type: 'function',
      function: {
        name: 'send_wechat',
        description: '发送微信 - 盘古自己的微信通道直连 iLink, 真实可发 (2026-10-30 起不再是空壳)',
        parameters: {
          type: 'object',
          properties: {
          to: { type: 'string', description: '接收人 user_id (省略 = 发给绑定的默认会话, 也就是主人)' },
          message: { type: 'string', description: '消息正文' }
        },
          required: ['message']
        },
        meta: { required_capabilities: ['chinese'] }}
    },
    currency_check: {
      type: 'function',
      function: {
        name: 'currency_check',
        description: '汇率查询 - 查询货币汇率',
        parameters: {
          type: 'object',
          properties: {
          from_currency: { type: 'string', description: '源货币代码 (如 USD)' },
          to_currency: { type: 'string', description: '目标货币代码 (如 CNY)' },
          amount: { type: 'string', description: '金额' }
        },
          required: ['from_currency']
        },
        meta: { required_capabilities: ['data_analysis'] }}
    },
  // 2026-10-12 (会话 stockprobe-01/02 实案): symbol 参数原来写"股票代码 (如 AAPL / 600519)",
  // 而这是加密货币工具 (Binance/OKX/CoinGecko)。模型照这句推理, 问"英伟达股价"先去调它,
  // 三源全超时 → 整轮零产出。reasoning_content 原话: "crypto_price says stock code like
  // AAPL / 600519 maybe supports US? Let's check crypto_price for NVDA."
  // 一个字的错标 = 一整轮的错工具 + 白烧的 token。
  crypto_price: {
      type: 'function',
      function: {
        name: 'crypto_price',
        description: '加密货币价 (Binance/OKX/CoinGecko 三源并行)。**只管币, 不管股票** — 股票走 stock_resolve 拿代码再 stock_quote',
        parameters: {
          type: 'object',
          properties: {
          symbol: { type: 'string', description: '币种对 (如 BTC/USDT、ETHUSDT、BTC)。**不是股票代码** — 股票代码请用 stock_resolve / stock_quote' }
        },
          required: ['symbol']
        },
        meta: { required_capabilities: ['data_analysis'] }}
    },
};
