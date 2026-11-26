'use strict';

const dns = require('dns').promises;
const net = require('net');

function checkLocalOrigin(req, res) {
  const origin = req.headers && req.headers.origin;
  if (!origin) return true;
  try {
    const host = new URL(origin).hostname.toLowerCase();
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return true;
  } catch (_) {}
  const token = req.headers && req.headers['x-pangu-token'];
  if (token && process.env.PANGU_INTERNAL_TOKEN && token === process.env.PANGU_INTERNAL_TOKEN) return true;
  if (!res.headersSent) res.writeHead(403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: false, error: 'CROSS_ORIGIN_FORBIDDEN' }));
  return false;
}

function isPrivateIPv4(ip) {
  const p = ip.split('.').map(Number);
  return p[0] === 10 || p[0] === 127 || (p[0] === 169 && p[1] === 254)
    || (p[0] === 172 && p[1] >= 16 && p[1] <= 31)
    || (p[0] === 192 && p[1] === 168) || p[0] === 0;
}

function isPrivateAddress(ip) {
  if (net.isIPv4(ip)) return isPrivateIPv4(ip);
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80:');
  }
  return false;
}

async function validateOutboundUrl(raw) {
  let url;
  try { url = new URL(String(raw || '')); } catch (_) { return { ok: false, error: 'INVALID_URL' }; }
  if (!['http:', 'https:'].includes(url.protocol)) return { ok: false, error: 'URL_SCHEME_NOT_ALLOWED' };
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '');
  if (host === 'localhost' || host.endsWith('.localhost') || host === 'metadata.google.internal' || host.endsWith('.local')) {
    return { ok: false, error: 'PRIVATE_URL_BLOCKED' };
  }
  if (isPrivateAddress(host)) return { ok: false, error: 'PRIVATE_URL_BLOCKED' };
  try {
    const records = await dns.lookup(host, { all: true, verbatim: true });
    if (!records.length || records.some(r => isPrivateAddress(r.address))) return { ok: false, error: 'PRIVATE_URL_BLOCKED' };
  } catch (_) { return { ok: false, error: 'DNS_LOOKUP_FAILED' }; }
  return { ok: true, url };
}

module.exports = { checkLocalOrigin, validateOutboundUrl };
