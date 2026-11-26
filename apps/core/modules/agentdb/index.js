'use strict';

const fs = require('fs');
const path = require('path');
const { rowsFingerprint, sortRowsById } = require('./fingerprint');

let HierarchicalNSW;
let loadAttempted = false;

function loadHnsw() {
  if (loadAttempted) return HierarchicalNSW;
  loadAttempted = true;
  try {
    ({ HierarchicalNSW } = require('hnswlib-node'));
  } catch (error) {
    console.warn('[agentdb-index] hnswlib-node unavailable; keyword fallback enabled:', error.message);
    HierarchicalNSW = null;
  }
  return HierarchicalNSW;
}

class AgentDBIndex {
  constructor({ root, indexPath } = {}) {
    this.root = path.resolve(root || process.env.PANGU_AGENTDB_DIR || path.join(require('os').homedir(), '.pangu-data', 'agentdb'));
    fs.mkdirSync(this.root, { recursive: true });
    this.indexPath = indexPath || path.join(this.root, 'agentdb.hnsw');
    this.statePath = `${this.indexPath}.json`;
    this.index = null;
    this.dimension = null;
    this.fingerprint = null;
    this.count = 0;
    // 增量同步的账本。state 里存不存这几项, 决定下次 sync 敢不敢只补插新点。
    this.indexedIds = null;         // this.index 里到底有哪些 id(升序)
    this.indexedFingerprint = null; // 上面这些 id 对应向量的指纹; null = 不可信, 只能全量重建
    this.maxElements = 0;           // 索引容量上限, 补插前要拿它兜底
    this.available = Boolean(loadHnsw());
  }

  sync(rows, fingerprint) {
    const vectors = (rows || []).filter(row => Array.isArray(row.vector) && row.vector.length > 0);
    if (vectors.length === 0) {
      this._forgetIndex();
      this.fingerprint = fingerprint || null;
      return { ok: true, mode: this.available ? 'hnsw-empty' : 'keyword', count: 0 };
    }
    const dimension = vectors[0].vector.length;
    if (vectors.some(row => row.vector.length !== dimension)) {
      throw new Error('inconsistent embedding dimensions');
    }
    if (!this.available) {
      this.dimension = dimension;
      this.fingerprint = fingerprint || null;
      this.count = vectors.length;
      this._forgetLedger();
      return { ok: true, mode: 'keyword', count: vectors.length };
    }
    if (this.index && this.fingerprint === fingerprint && this.dimension === dimension && this.count === vectors.length) {
      return { ok: true, mode: 'hnsw', count: vectors.length, reused: true };
    }
    // 每多一条消息就全量重插 —— 实测 17046 条要 3.3 秒(冷建 51 秒),
    // 而落盘只要 7ms。新增一条的全量重建能把事件循环饿死, 整个 HTTP 服务对外假死。
    // 所以先问「能不能只补插新增的那几条」, 问不到才付全量的钱。
    const appended = this._syncAppend(vectors, dimension, fingerprint);
    if (appended) return appended;
    if (this._loadPersisted(dimension, fingerprint, vectors.length)) {
      return { ok: true, mode: 'hnsw', count: vectors.length, reused: true };
    }
    return this._rebuild(vectors, dimension, fingerprint);
  }

  // 只补插新增的 id。返回 null = 补不了, 交回上层走全量重建。
  _syncAppend(vectors, dimension, fingerprint) {
    const open = this._openForAppend(dimension);
    if (!open) return null;

    // 排序后统一在 ordered 上算指纹 —— state 里存的是 id 升序的指纹,
    // 校验也必须同一个序, 否则对不上就白验证了。
    const ordered = sortRowsById(vectors);
    const indexedSet = new Set(open.indexedIds);
    const currentSet = new Set(ordered.map(row => Number(row.id)));

    // 1) 索引里有、库里查不到了 → 是删除。hnswlib 不能原地删点, 退回全量重建。
    //    注: 后面那条指纹校验其实也能兜住删除(少一个 id 子集指纹必变)。
    //    这里保留是防御性冗余: 万一以后指纹算法变了, 这条是最后一道闸。
    for (const id of open.indexedIds) {
      if (!currentSet.has(id)) return null;
    }
    // 2) 证明已索引那批向量一个都没动过(重新嵌入过就是脏索引, 不能接着用)。
    //    这是"少插几条"和"索引还对"之间的全部区别。
    const shared = ordered.filter(row => indexedSet.has(Number(row.id)));
    if (rowsFingerprint(shared) !== open.indexedFingerprint) return null;
    // 3) 容量兜底: hnsw 装满了 addPoint 会抛, 抛了就只剩全量重建, 不如先判。
    const missing = ordered.filter(row => !indexedSet.has(Number(row.id)));
    if (open.indexedIds.length + missing.length > open.maxElements) return null;

    for (const row of missing) open.index.addPoint(row.vector, Number(row.id));

    const ids = ordered.map(row => Number(row.id));
    const indexedFingerprint = rowsFingerprint(ordered);
    const persisted = this._persist(open.index, {
      dimension,
      count: ids.length,
      maxElements: open.maxElements,
      indexedIds: ids,
      indexedFingerprint,
    }, true);
    if (!persisted.ok) return null;

    this.index = open.index;
    this.dimension = dimension;
    this.fingerprint = fingerprint;
    this.count = ids.length;
    this.indexedIds = ids;
    this.indexedFingerprint = indexedFingerprint;
    this.maxElements = open.maxElements;
    return { ok: true, mode: 'hnsw', count: ids.length, appended: missing.length };
  }

  // 拿一个"账本可信"的索引来补插。内存里有就直接用(省一次 40ms 读盘),
  // 冷启动才从 state + 索引文件里读回来。
  _openForAppend(dimension) {
    if (this.index && this.dimension === dimension && Array.isArray(this.indexedIds)
      && typeof this.indexedFingerprint === 'string' && this.maxElements > 0) {
      // 内存索引的实际条数跟账本对不上 → 有人在外面动过这个 index, 不敢补。
      if (typeof this.index.getCurrentCount === 'function' && this.index.getCurrentCount() !== this.indexedIds.length) {
        return null;
      }
      return {
        index: this.index,
        indexedIds: this.indexedIds,
        indexedFingerprint: this.indexedFingerprint,
        maxElements: this.maxElements,
      };
    }
    try {
      if (!fs.existsSync(this.indexPath) || !fs.existsSync(this.statePath)) return null;
      const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (state.dimension !== dimension) return null;
      if (!Array.isArray(state.indexedIds) || typeof state.indexedFingerprint !== 'string') return null;
      if (!(state.maxElements > 0) || state.indexedIds.length > state.maxElements) return null;
      const Index = loadHnsw();
      if (!Index) return null;
      const index = new Index('cosine', dimension);
      index.readIndexSync(this.indexPath);
      // 账本说 N 个点、索引文件里只有 M 个 —— 只信账本的话, 中间那批记忆
      // 会永远检索不到, 而且没有任何报错。这条是唯一拦得住它的判据。
      if (index.getCurrentCount() !== state.indexedIds.length) return null;
      return {
        index,
        indexedIds: state.indexedIds,
        indexedFingerprint: state.indexedFingerprint,
        maxElements: state.maxElements,
      };
    } catch (error) {
      console.warn('[agentdb-index] persisted ledger unreadable; rebuilding:', error.message);
      return null;
    }
  }

  _loadPersisted(dimension, fingerprint, count) {
    try {
      if (!fs.existsSync(this.indexPath) || !fs.existsSync(this.statePath)) return false;
      const state = JSON.parse(fs.readFileSync(this.statePath, 'utf8'));
      if (state.dimension !== dimension || state.fingerprint !== fingerprint || state.count !== count) return false;
      const Index = loadHnsw();
      if (!Index) return false;
      const index = new Index('cosine', dimension);
      index.readIndexSync(this.indexPath);
      if (index.getCurrentCount() !== count) return false;
      this.index = index;
      this.dimension = dimension;
      this.fingerprint = fingerprint;
      this.count = count;
      this.indexedIds = null;
      this.indexedFingerprint = null;
      this.maxElements = 0;
      return true;
    } catch (error) {
      console.warn('[agentdb-index] persisted index invalid; rebuilding:', error.message);
      return false;
    }
  }

  _rebuild(rows, dimension, fingerprint) {
    const Index = loadHnsw();
    if (!Index) return { ok: true, mode: 'keyword', count: rows.length, degraded: true };
    const index = new Index('cosine', dimension);
    const maxElements = Math.max(1024, rows.length * 2);
    index.initIndex(maxElements, 16, 200, 100);
    for (const row of rows) index.addPoint(row.vector, Number(row.id));

    const ordered = sortRowsById(rows);
    const persisted = this._persist(index, {
      dimension,
      count: ordered.length,
      maxElements,
      indexedIds: ordered.map(row => Number(row.id)),
      indexedFingerprint: rowsFingerprint(ordered),
    }, true);
    // 全量重建落不了盘就是硬失败: 索引只在内存里, 下次 sync 又得重来, 不能装作成功。
    if (!persisted.ok) throw new Error(`agentdb index persist failed: ${persisted.error}`);
    this.index = index;
    this.dimension = dimension;
    this.fingerprint = fingerprint;
    this.count = ordered.length;
    this.indexedIds = ordered.map(row => Number(row.id));
    this.indexedFingerprint = rowsFingerprint(ordered);
    this.maxElements = maxElements;
    return { ok: true, mode: 'hnsw', count: rows.length, rebuilt: true };
  }

  _persist(index, state, trusted) {
    const temporaryIndex = `${this.indexPath}.tmp-${process.pid}-${Date.now()}`;
    const temporaryState = `${this.statePath}.tmp-${process.pid}-${Date.now()}`;
    const payload = JSON.stringify({
      // 老字段留着 —— 老 _loadPersisted 还在读, 旧 state 文件也要能继续用。
      dimension: state.dimension,
      fingerprint: trusted ? state.indexedFingerprint : null,
      count: state.count,
      // 增量同步的账本。缺任何一个, 下次 sync 都只能退回全量重建。
      version: 2,
      indexedIds: state.indexedIds,
      indexedFingerprint: trusted ? state.indexedFingerprint : null,
      maxElements: state.maxElements,
    });
    try {
      index.writeIndexSync(temporaryIndex);
      fs.writeFileSync(temporaryState, payload, 'utf8');
      fs.renameSync(temporaryIndex, this.indexPath);
      fs.renameSync(temporaryState, this.statePath);
      return { ok: true };
    } catch (error) {
      try { fs.unlinkSync(temporaryIndex); } catch (_) {}
      try { fs.unlinkSync(temporaryState); } catch (_) {}
      return { ok: false, error: error.message };
    }
  }

  _forgetIndex() {
    this.index = null;
    this.dimension = null;
    this.count = 0;
    this._forgetLedger();
  }

  _forgetLedger() {
    this.indexedIds = null;
    this.indexedFingerprint = null;
    this.maxElements = 0;
  }

  search(vector, k = 5, rows = []) {
    if (!Array.isArray(vector) || vector.length === 0 || this.count === 0) return null;
    const amount = Math.max(1, Math.min(Number(k) || 5, this.count));
    if (this.index && this.available && vector.length === this.dimension) {
      try {
        return this.index.searchKnn(vector, amount);
      } catch (error) {
        console.warn('[agentdb-index] search failed; brute-force fallback enabled:', error.message);
      }
    }
    // Keep retrieval alive when the native addon is unavailable or an index is corrupt.
    // This is slower than HNSW but preserves correctness and the JSON/SQLite fallback path.
    const scored = (rows || []).filter(row => Array.isArray(row.vector) && row.vector.length === vector.length).map(row => {
      let dot = 0;
      let queryNorm = 0;
      let rowNorm = 0;
      for (let i = 0; i < vector.length; i += 1) {
        const q = Number(vector[i]) || 0;
        const v = Number(row.vector[i]) || 0;
        dot += q * v;
        queryNorm += q * q;
        rowNorm += v * v;
      }
      const similarity = dot / ((Math.sqrt(queryNorm) * Math.sqrt(rowNorm)) || 1);
      return { id: Number(row.id), distance: 1 - similarity };
    }).sort((a, b) => a.distance - b.distance).slice(0, amount);
    return { neighbors: scored.map(item => item.id), distances: scored.map(item => item.distance) };
  }

  addPoint(vector, label) {
    if (!this.available || !this.index) return false;
    if (!Array.isArray(vector) || vector.length === 0) return false;
    if (vector.length !== this.dimension) return false;
    try {
      this.index.addPoint(vector, Number(label));
      this.count = Math.max(this.count, this.index.getCurrentCount ? this.index.getCurrentCount() : this.count + 1);
      if (Array.isArray(this.indexedIds)) {
        this.indexedIds = [...new Set([...this.indexedIds, Number(label)])].sort((a, b) => a - b);
      }
      // 聚合指纹没法靠单个向量增量更新 —— 记成不可信, 下次 sync 全量重建。
      // 宁可慢一次, 也不能拿一个说不清对不对的索引继续用。
      this.indexedFingerprint = null;
      return true;
    } catch (error) {
      console.warn('[agentdb-index] addPoint failed:', error.message);
      return false;
    }
  }

  save() {
    if (!this.available || !this.index) return { ok: false, mode: 'noop' };
    const trusted = Array.isArray(this.indexedIds) && typeof this.indexedFingerprint === 'string';
    const persisted = this._persist(this.index, {
      dimension: this.dimension,
      count: this.count,
      maxElements: this.maxElements > 0 ? this.maxElements : Math.max(1024, this.count * 2),
      indexedIds: Array.isArray(this.indexedIds) ? this.indexedIds : [],
      indexedFingerprint: this.indexedFingerprint,
    }, trusted);
    if (!persisted.ok) {
      console.warn('[agentdb-index] save failed:', persisted.error);
      return { ok: false, mode: 'error', error: persisted.error };
    }
    return { ok: true, count: this.count };
  }

  close() {
    this.index = null;
    this.count = 0;
    this._forgetLedger();
  }
}

module.exports = { AgentDBIndex };
