/**
 * Pangu · Web Search Module
 * 基于 SearXNG JSON API 的独立联网搜索模块
 * 
 * 使用方式：
 *   const { webSearch } = require('./web_search');
 *   const results = await webSearch({ query: '习近平', baseUrl: 'http://localhost:8080' });
 */

'use strict';

const http = require('http');
const https = require('https');
const { URL } = require('url');

// ============================================================
// 缓存（进程内，15分钟TTL）
// ============================================================

const SEARCH_CACHE = new Map();
const CACHE_TTL_MS = 15 * 60 * 1000;

function normalizeCacheKey(params) {
  return JSON.stringify({
    query: params.query,
    count: params.count || 5,
    categories: params.categories || '',
    language: params.language || '',
    baseUrl: params.baseUrl
  });
}

function readCache(key) {
  const entry = SEARCH_CACHE.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > CACHE_TTL_MS) {
    SEARCH_CACHE.delete(key);
    return null;
  }
  return entry.value;
}

function writeCache(key, value) {
  SEARCH_CACHE.delete(key);
  SEARCH_CACHE.set(key, { value, ts: Date.now() });
}

// ============================================================
// 工具函数
// ============================================================

function resolveSearchCount(count, defaultCount) {
  const n = parseInt(count, 10);
  if (isNaN(n) || n < 1) return defaultCount || 5;
  return Math.min(n, 10);
}

function normalizeBaseUrl(value) {
  if (!value) return null;
  return value.replace(/\/+$/u, '') || null;
}

function normalizeTrimmedString(value) {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function resolveSiteName(urlStr) {
  try {
    return new URL(urlStr).hostname.replace(/^www\./, '');
  } catch {
    return null;
  }
}

function isBlockedHostname(hostname) {
  const blocked = ['localhost', '127.0.0.1', '0.0.0.0', '::1'];
  const lower = hostname.toLowerCase();
  // 127.0.0.1 的多种表示形式
  if (lower === '127.1' || lower === '127.0.1' || lower === '2130706433') return true;
  // IPv6 mapped IPv4: ::ffff:127.0.0.1
  if (lower.includes('::ffff:127.') || lower.includes('::ffff:0:127.')) return true;
  return blocked.some(b => lower === b || lower.endsWith('.local') || lower.endsWith('.test'));
}

function buildSearxngSearchUrl(params) {
  const base = normalizeBaseUrl(params.baseUrl);
  if (!base) throw new Error('baseUrl is required');
  const url = new URL(base);
  const suffix = url.pathname.endsWith('/') ? 'search' : '/search';
  url.pathname = url.pathname + suffix;
  url.searchParams.set('q', params.query);
  url.searchParams.set('format', 'json');
  if (params.categories) url.searchParams.set('categories', params.categories);
  if (params.language) url.searchParams.set('language', params.language);
  return url.toString();
}

function normalizeSearxngResult(value) {
  if (!value || typeof value !== 'object') return null;
  if (typeof value.url !== 'string' || typeof value.title !== 'string') return null;
  return {
    url: value.url,
    title: value.title,
    content: typeof value.content === 'string' ? value.content : null,
    img_src: typeof value.img_src === 'string' ? value.img_src : null
  };
}

function parseSearxngResponseText(text, count) {
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error('SearXNG returned invalid JSON');
  }
  if (!parsed || typeof parsed !== 'object') return [];
  const rawResults = Array.isArray(parsed.results) ? parsed.results : [];
  const results = [];
  for (const rawResult of rawResults) {
    const result = normalizeSearxngResult(rawResult);
    if (result) results.push(result);
    if (results.length >= count) break;
  }
  return results;
}

async function fetchUrl(urlStr, timeoutMs) {
  return new Promise((resolve, reject) => {
    const parsedUrl = new URL(urlStr);
    const isHttps = parsedUrl.protocol === 'https:';
    const client = isHttps ? https : http;

    if (isBlockedHostname(parsedUrl.hostname)) {
      return reject(new Error(`Blocked hostname: ${parsedUrl.hostname}`));
    }

    const req = client.get(urlStr, {
      headers: { Accept: 'application/json' },
      timeout: timeoutMs || 20000
    }, (res) => {
      if (res.statusCode !== 200) {
        res.destroy();
        return reject(new Error(`SearXNG search error (${res.statusCode})`));
      }
      const chunks = [];
      let size = 0;
      const MAX_BYTES = 1e6;
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > MAX_BYTES) {
          res.destroy();
          return reject(new Error('SearXNG response too large'));
        }
        chunks.push(chunk);
      });
      res.on('end', () => {
        try {
          resolve(Buffer.concat(chunks).toString('utf8'));
        } catch (e) {
          reject(e);
        }
      });
      res.on('error', reject);
    });

    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('SearXNG request timeout'));
    });
  });
}

// ============================================================
// 核心搜索函数
// ============================================================

/**
 * SearXNG 联网搜索
 * @param {Object} params
 * @param {string} params.query - 搜索关键词
 * @param {string} [params.baseUrl] - SearXNG实例地址，如 http://localhost:8080
 * @param {number} [params.count] - 返回结果数量（默认5，最大10）
 * @param {string} [params.categories] - 搜索分类，如 general,news,science
 * @param {string} [params.language] - 结果语言，如 zh,en
 * @param {number} [params.timeoutSeconds] - 超时秒数（默认20）
 * @returns {Promise<Object>} 搜索结果
 */
async function webSearch(params) {
  if (!params.query || !params.query.trim()) {
    throw new Error('query is required');
  }

  const baseUrl = normalizeBaseUrl(params.baseUrl || process.env.SEARXNG_BASE_URL);
  if (!baseUrl) {
    throw new Error('SearXNG base URL not configured. Set baseUrl or SEARXNG_BASE_URL env var.');
  }

  const count = resolveSearchCount(params.count, 5);
  const language = normalizeTrimmedString(params.language);
  const categories = normalizeTrimmedString(params.categories);
  const timeoutSeconds = parseInt(params.timeoutSeconds, 10) || 20;

  // 缓存检查
  const cacheKey = normalizeCacheKey({ query: params.query, count, categories, language, baseUrl });
  const cached = readCache(cacheKey);
  if (cached) {
    return { ...cached, cached: true };
  }

  const startedAt = Date.now();
  const searchUrl = buildSearxngSearchUrl({ baseUrl, query: params.query, categories, language });

  let results;
  try {
    const text = await fetchUrl(searchUrl, timeoutSeconds * 1000);
    results = parseSearxngResponseText(text, count);
  } catch (e) {
    throw new Error(`SearXNG search failed: ${e.message}`);
  }

  const payload = {
    query: params.query,
    provider: 'searxng',
    count: results.length,
    tookMs: Date.now() - startedAt,
    cached: false,
    results: results.map(r => ({
      title: r.title,
      url: r.url,
      snippet: r.content || '',
      siteName: resolveSiteName(r.url) || null
    }))
  };

  writeCache(cacheKey, payload);
  return payload;
}

/**
 * 清空搜索缓存
 */
function clearCache() {
  SEARCH_CACHE.clear();
}

/**
 * 获取缓存状态
 */
function getCacheStatus() {
  return {
    size: SEARCH_CACHE.size,
    entries: Array.from(SEARCH_CACHE.keys()).map(k => {
      const entry = SEARCH_CACHE.get(k);
      return { key: k, ageMs: Date.now() - entry.ts };
    })
  };
}

module.exports = { webSearch, clearCache, getCacheStatus };