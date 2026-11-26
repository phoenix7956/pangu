/**
 * Pangu · Web Search Fallback (无 SearXNG 实例时用)
 *
 * 策略: Bing 国内版 HTML scrape
 *   - https://cn.bing.com/search?q=KEYWORD
 *   - 国内可访问, 无需翻墙
 *   - 解析 <ol id="b_results"> 下的 <li class="b_algo"> 项
 *
 * 限制:
 *   - Bing 反爬严格, UA + Accept-Language 必备
 *   - 每天 query 数有限, 15分钟 TTL cache 缓解
 *   - 国内版无英文结果, 跨境查询会被 Bing 重定向到国际版
 *
 * 替代源 (按优先级):
 *   1. cn.bing.com  ← 默认
 *   2. sogou.com    ← 备用
 *   3. 360.cn       ← 备用
 *
 * 用法:
 *   const { bingSearch } = require('./web_search_fallback');
 *   const r = await bingSearch({ query: 'A 股 板块行情', count: 5 });
 *   // r = [{ title, url, snippet }, ...]
 */

'use strict';

const https = require('https');
const http = require('http');
const { URL } = require('url');

// ============================================================
// 缓存 (进程内, 15 分钟 TTL)
// ============================================================
const CACHE = new Map();
const TTL_MS = 15 * 60 * 1000;

function cacheKey(query, count) {
  return JSON.stringify({ q: query, n: count });
}

function readCache(k) {
  const e = CACHE.get(k);
  if (!e) return null;
  if (Date.now() - e.ts > TTL_MS) {
    CACHE.delete(k);
    return null;
  }
  return e.value;
}

function writeCache(k, v) {
  // LRU-ish: 限制 200 条
  if (CACHE.size >= 200) {
    const firstKey = CACHE.keys().next().value;
    CACHE.delete(firstKey);
  }
  CACHE.set(k, { value: v, ts: Date.now() });
}

// ============================================================
// HTTP 抓取
// ============================================================
function fetchUrl(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const client = u.protocol === 'https:' ? https : http;
    const req = client.get(urlStr, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
        'Accept-Encoding': 'gzip, deflate',
        ...opts.headers,
      },
      timeout: opts.timeoutMs || 15000,
    }, (res) => {
      // 处理 redirect
      if ([301, 302, 303, 307, 308].includes(res.statusCode)) {
        const loc = res.headers.location;
        if (loc) {
          res.resume();
          const next = loc.startsWith('http') ? loc : new URL(loc, urlStr).toString();
          return resolve(fetchUrl(next, opts));
        }
      }
      if (res.statusCode !== 200) {
        res.resume();
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      const chunks = [];
      let size = 0;
      const MAX = 2 * 1024 * 1024; // 2 MB 上限
      res.on('data', (c) => {
        size += c.length;
        if (size > MAX) {
          res.destroy();
          return reject(new Error('Response too large'));
        }
        chunks.push(c);
      });
      res.on('end', () => {
        let buf = Buffer.concat(chunks);
        // gzip 解压
        if (res.headers['content-encoding'] === 'gzip') {
          try {
            const zlib = require('zlib');
            buf = zlib.gunzipSync(buf);
          } catch (_) { /* keep raw */ }
        }
        resolve(buf.toString('utf8'));
      });
      res.on('error', reject);
    });
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('Timeout'));
    });
  });
}

// ============================================================
// Bing HTML 解析
// ============================================================
function decodeEntities(s) {
  if (!s) return '';
  return s
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&nbsp;/g, ' ')
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(parseInt(n, 10)));
}

// 从 <li class="b_algo"> 提取 title + url + snippet
function parseBingHtml(html) {
  const results = [];
  // 简单 regex 提取, 不引 cheerio (避免依赖)
  const liRegex = /<li[^>]*class="[^"]*\bb_algo\b[^"]*"[^>]*>([\s\S]*?)<\/li>/gi;
  let m;
  while ((m = liRegex.exec(html)) !== null) {
    const block = m[1];
    // title: <h2><a href="URL">TITLE</a></h2>
    const titleMatch = block.match(/<h2[^>]*>\s*<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>\s*<\/h2>/i);
    if (!titleMatch) continue;
    let url = decodeEntities(titleMatch[1]);
    const titleHtml = titleMatch[2];
    const title = decodeEntities(titleHtml.replace(/<[^>]+>/g, '').trim());
    if (!title || !url) continue;
    // snippet: 第一个 <p> 之后的文本
    const snippetMatch = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    let snippet = '';
    if (snippetMatch) {
      snippet = decodeEntities(snippetMatch[1].replace(/<[^>]+>/g, '').trim());
    }
    // 过滤掉 Bing 自身链接
    if (url.includes('bing.com/') || url.includes('microsoft.com/')) continue;
    results.push({ title, url, snippet, snippet_length: snippet.length });
  }
  return results;
}

// ============================================================
// 公开 API
// ============================================================

/**
 * Bing 国内版搜索
 * @param {object} opts
 * @param {string} opts.query - 搜索关键词
 * @param {number} [opts.count=5] - 返回结果数 (1-10)
 * @returns {Promise<Array<{title,url,snippet}>>}
 */
async function bingSearch({ query, count = 5 } = {}) {
  if (!query) throw new Error('query required');
  const n = Math.max(1, Math.min(10, parseInt(count, 10) || 5));

  const ck = cacheKey(query, n);
  const cached = readCache(ck);
  if (cached) return cached;

  const url = `https://cn.bing.com/search?q=${encodeURIComponent(query)}&count=${n}&FORM=QBLH`;
  const html = await fetchUrl(url, { timeoutMs: 12000 });
  const results = parseBingHtml(html).slice(0, n);

  // 如果 Bing 返回 0 结果, 尝试 sogou 备用
  if (results.length === 0) {
    const sogouUrl = `https://www.sogou.com/web?query=${encodeURIComponent(query)}`;
    try {
      const sogouHtml = await fetchUrl(sogouUrl, { timeoutMs: 10000 });
      const sogouResults = parseSogouHtml(sogouHtml).slice(0, n);
      if (sogouResults.length > 0) {
        writeCache(ck, sogouResults);
        return sogouResults;
      }
    } catch (_) { /* fallthrough */ }
  }

  writeCache(ck, results);
  return results;
}

// Sogou fallback 解析
function parseSogouHtml(html) {
  const results = [];
  // Sogou 链接格式: <a href="..." data-...> title </a> ... <p class="str_info"> snippet </p>
  const re = /<a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*class="str_info"[^>]*>([\s\S]*?)<\/p>/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = decodeEntities(m[1]);
    const title = decodeEntities(m[2].replace(/<[^>]+>/g, '').trim());
    const snippet = decodeEntities(m[3].replace(/<[^>]+>/g, '').trim());
    if (!title || !url || url.includes('sogou.com')) continue;
    results.push({ title, url, snippet, snippet_length: snippet.length });
    if (results.length >= 10) break;
  }
  return results;
}

module.exports = {
  bingSearch,
  parseBingHtml,
  parseSogouHtml,
  fetchUrl,
};