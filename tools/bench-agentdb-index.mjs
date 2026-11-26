// 量一次 agentdb 索引同步到底多贵 —— 用来判「100% CPU 是不是它干的」。
//
// 现场 (2026-10-19 22:24): pangu 进程 100% CPU / state R, HTTP 根路径 15s 超时,
// sample 抓到 1408 个采样里 802 个在 HierarchicalNSW::addPoint。
// 而 agentdb/index.js 的 sync() 里, 只要 persisted 索引对不上就整库重建:
//     for (const row of rows) index.addPoint(row.vector, Number(row.id));
// 新增一条消息 → count/fingerprint 变 → persisted 作废 → 全量重插。
//
// 本脚本只读 + 在临时目录里重建, **不动** ~/.pangu-data 的真索引。
import { performance } from 'node:perf_hooks';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const mod = await import('../apps/core/modules/agentdb/index.js');
const store = await import('../apps/core/modules/session_store.js');

const db = store.getAgentDb ? store.getAgentDb() : null;
if (!db || typeof db.listEmbeddedMemories !== 'function') {
  console.log('拿不到 agentdb, 换个入口');
  process.exit(1);
}
const rows = db.listEmbeddedMemories();
console.log(`待索引向量: ${rows.length} 条`);

const dir = mkdtempSync(join(tmpdir(), 'agentdb-bench-'));
try {
  // 第一次: 冷建 (等于线上「persisted 作废后全量重建」那条路)
  let t = performance.now();
  const idx1 = new mod.AgentDBIndex({ root: dir });
  const r1 = idx1.sync(rows, db.fingerprint(rows));
  const cold = performance.now() - t;
  console.log(`冷建(全量 addPoint): ${cold.toFixed(0)} ms  mode=${r1.mode} count=${r1.count}`);

  // 第二次: persisted 命中 —— 线上本来应该走这条
  t = performance.now();
  const idx2 = new mod.AgentDBIndex({ root: dir });
  const r2 = idx2.sync(rows, db.fingerprint(rows));
  const warm = performance.now() - t;
  console.log(`复用落盘索引: ${warm.toFixed(0)} ms  mode=${r2.mode} appended=${r2.appended} rebuilt=${r2.rebuilt === true}`);

  // 关键场景: 只多一条消息 (线上每写一条消息就是这个情形)
  const extra = rows.slice();
  const clone = { ...rows[0], id: String(Number(rows[0].id) + 1e9) };
  extra.push(clone);
  t = performance.now();
  const idx3 = new mod.AgentDBIndex({ root: dir });
  const r3 = idx3.sync(extra, db.fingerprint(extra));
  const afterWrite = performance.now() - t;
  console.log(`冷启动 + 只多 1 条: ${afterWrite.toFixed(0)} ms  mode=${r3.mode} appended=${r3.appended} rebuilt=${r3.rebuilt === true}`);

  // 线上真正的形态: 索引常驻内存, 每次 sync 都在同一个实例上。
  // 这一档才是每写一条消息的真实代价(上面那 80ms 一大半是读 28MB 索引文件)。
  t = performance.now();
  const r4 = idx3.sync(extra.concat([{ ...rows[1], id: String(Number(rows[1].id) + 2e9) }]), null);
  const warmAppend = performance.now() - t;
  console.log(`索引常驻内存 + 再多 1 条: ${warmAppend.toFixed(0)} ms  appended=${r4.appended} rebuilt=${r4.rebuilt === true}`);

  console.log('\n结论:');
  console.log(`  每新增一条消息的代价: ${warmAppend.toFixed(0)} ms(常驻内存) / ${afterWrite.toFixed(0)} ms(冷启动)`);
  console.log(`  修之前是 ${cold.toFixed(0)} ms —— 整整一档全量重插, 能把事件循环饿死`);
  console.log(`  提速: ${(cold / Math.max(warmAppend, 0.1)).toFixed(0)}x`);
  idx1.close(); idx2.close(); idx3.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}

