'use strict';

const crypto = require('crypto');

// 行指纹 = sha256 顺序遍历 (id, 向量 float32 字节)。
//
// 为什么必须共用一份而不是各写各的:
// 增量同步靠「重算已索引子集的指纹, 和 state 里存的对上」来证明这批向量没变过。
// 只要 index.js 和 db.js 的算法有一丁点不一样(字段顺序、buffer 复用、少了 id),
// 验证就永远失败 —— 表现是「代码看着在增量, 实际每条消息还是全量重建」,
// 而且日志里一声不响。所以算法只有这一处。
function rowsFingerprint(rows) {
  const hash = crypto.createHash('sha256');
  for (const row of rows || []) {
    hash.update(String(row.id));
    hash.update(Buffer.from(new Float32Array(row.vector).buffer));
  }
  return hash.digest('hex');
}

// 行序由调用方决定, 但**必须**在算指纹前排成 id 升序:
// 索引的 state 里存的是按 id 升序算出来的指纹, 校验时也要升序, 否则永远对不上。
function sortRowsById(rows) {
  return (rows || []).slice().sort((a, b) => Number(a.id) - Number(b.id));
}

module.exports = { rowsFingerprint, sortRowsById };
