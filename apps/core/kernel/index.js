/**
 * Pangu · kernel layer (2026-07-15 老板拍)
 *
 * 历史: 原 kernel/ 目录被弃 (core/ README DEPRECATED 注释),
 *       64i/ 接管了真 64 卦本体. agents/li.js:90-98 还在
 *       require('../kernel/index.js') — 跑起来就 MODULE_NOT_FOUND.
 *
 * 这个文件是修复: 桥接到 64i 现成能力, 不重写整层.
 *
 *   - divinate(question) → 用 64i 散列算 卦 + 爻 (deterministic, 不真起卦)
 *   - 兼容 analyzer.js 的 divinate() 单参数签名 (question, 忽略 context)
 */
'use strict';

const path = require('path');
const crypto = require('crypto');

let _cached;
function _core() {
  if (_cached) return _cached;
  // 64i 在 pangu 根下的兄弟目录; kernel/ 在 agents/ 兄弟, 所以跳两级
  const x64 = require(path.join(__dirname, '..', '64i'));
  const hexVec = require(path.join(__dirname, '..', '64i', 'hexagram_vector'));
  _cached = { ...x64, hexagramVector: hexVec };
  return _cached;
}

function hashBucket(s, mod = 64) {
  const h = crypto.createHash('sha256').update(String(s || '')).digest();
  return (h.readUInt32BE(0) % mod) + 1; // 1-indexed (64i 习惯)
}

function pickYao(salt, pos) {
  const h = crypto.createHash('sha256').update(String(salt) + '|' + pos).digest();
  return h.readUInt32BE(4) % 2; // 0 阴, 1 阳
}

/**
 * Divination — deterministic 64卦 lookup (跟 _handlePanguDecide 一致风格)
 *   guaId: 1..64 (sha256(question) % 64 + 1)
 *   yaoPos: 1..6 (sha256(question + pos) % 2 — 0 阴 1 阳)
 */
function divinate(question) {
  const core = _core();
  const guaId = hashBucket(question, 64);
  const yaoPositions = [1, 2, 3, 4, 5, 6].map(pos => pickYao(question, pos));
  let vector = null;
  try {
    if (core.hexagramVector && typeof core.hexagramVector.getYaoVector === 'function') {
      vector = core.hexagramVector.getYaoVector(guaId, 1);
    }
  } catch (_) { /* 非关键 — 失败返回 partial 结果 */ }
  const annotated = core.baguaAnnotations
    ? safe(() => core.baguaAnnotations.getAnnotations(guaId))
    : null;
  return {
    hexagram: guaId,
    yaos: yaoPositions,
    vector,
    annotation: annotated,
    question: String(question || '').slice(0, 200),
    origin: 'pangu.kernel.divinate (deterministic, 2026-07-15)',
  };
}

function safe(fn) {
  try { return fn(); } catch (e) { return { error: e.message }; }
}

/**
 * 兼容 agent/analyzer.js 调用方式: invokeDivinate(question, context)
 * context 可选, 忽略
 */
function invokeDivinate(question, _ctx) {
  return divinate(question);
}

module.exports = { divinate, invokeDivinate };
module.exports.divinate = divinate;
