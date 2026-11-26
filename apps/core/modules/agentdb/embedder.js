'use strict';

const DEFAULT_DIMENSION = 384;
const DEFAULT_MODEL = process.env.PANGU_EMBEDDING_MODEL || 'nomic-embed-text';

function normalizeEndpoint(value) {
  return String(value || '').replace(/\/+$/, '');
}

function normalizeSemanticText(value) {
  return String(value || '')
    .toLowerCase()
    .replaceAll('案子', '案件')
    .replaceAll('打官司', '诉讼')
    .replaceAll('应诉', '答辩');
}

function hashString(value) {
  let hash = 2166136261;
  for (const byte of Buffer.from(value, 'utf8')) {
    hash ^= byte;
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

function deterministicEmbedding(text, dimension = DEFAULT_DIMENSION) {
  const size = Number.isInteger(dimension) && dimension > 0 ? dimension : DEFAULT_DIMENSION;
  const normalized = normalizeSemanticText(text);
  const tokens = normalized.match(/[a-z0-9_]+|[\u4e00-\u9fff]/gi) || [normalized];
  const values = new Float64Array(size);
  for (const token of tokens) {
    const hash = hashString(token);
    const index = hash % size;
    const sign = (hash & 1) === 0 ? 1 : -1;
    values[index] += sign;
    if (token.length > 1) {
      const pairHash = hashString(token.slice(0, 2));
      values[pairHash % size] += sign * 0.5;
    }
  }
  const norm = Math.sqrt(values.reduce((sum, value) => sum + value * value, 0)) || 1;
  return Array.from(values, value => value / norm);
}

function validateVector(value) {
  if (!Array.isArray(value) || value.length === 0) return null;
  const vector = value.map(Number);
  if (vector.some(value => !Number.isFinite(value))) return null;
  return vector;
}

async function fetchJson(url, init, timeoutMs = 1200) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`embedding HTTP ${response.status}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function remoteEmbedding(text, { endpoint, model, apiKey, timeoutMs } = {}) {
  const target = normalizeEndpoint(endpoint);
  if (!target) return null;
  const isOllama = /\/api\/embeddings$/.test(target) || /11434/.test(target);
  const headers = { 'Content-Type': 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = isOllama
    ? { model, prompt: text }
    : { model, input: text };
  const json = await fetchJson(target, { method: 'POST', headers, body: JSON.stringify(body) }, timeoutMs);
  const vector = json && (json.embedding || (json.data && json.data[0] && json.data[0].embedding));
  const validated = validateVector(vector);
  if (!validated) throw new Error('embedding response has no vector');
  return { vector: validated, model, source: isOllama ? 'ollama' : 'openai-compatible' };
}

async function embedText(text, options = {}) {
  const dimension = Number.isInteger(options.dimension) && options.dimension > 0
    ? options.dimension
    : Number.parseInt(process.env.PANGU_EMBEDDING_DIM || String(DEFAULT_DIMENSION), 10);
  const model = options.model || process.env.PANGU_EMBEDDING_MODEL || DEFAULT_MODEL;
  const endpoint = options.endpoint || process.env.PANGU_EMBEDDING_URL || (
    process.env.OLLAMA_HOST ? `${normalizeEndpoint(process.env.OLLAMA_HOST)}/api/embeddings` : ''
  );
  if (endpoint) {
    try {
      const remote = await remoteEmbedding(String(text || '').slice(0, 8000), {
        endpoint,
        model,
        apiKey: options.apiKey || process.env.PANGU_EMBEDDING_API_KEY,
        timeoutMs: options.timeoutMs || 1200,
      });
      if (remote.vector.length === dimension || !options.dimension) return remote;
    } catch (error) {
      console.warn('[agentdb-embedder] remote embedding unavailable; using local fallback:', error.message);
    }
  }
  return {
    vector: deterministicEmbedding(String(text || '').slice(0, 8000), dimension),
    model: 'local-hash-v1',
    source: 'local-fallback',
    degraded: Boolean(endpoint),
  };
}

module.exports = {
  DEFAULT_DIMENSION,
  deterministicEmbedding,
  embedText,
  normalizeSemanticText,
  validateVector,
};
