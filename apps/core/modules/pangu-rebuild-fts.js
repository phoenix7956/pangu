'use strict';

// R39 老 FTS5 drift 修复脚本
// 老 _incrementalReindex 删 chunks 后没同步删 chunks_fts 行 (风控 M, R29/R30 教训)
// 用法: node modules/pangu-rebuild-fts.js [--source <path>] [--dry-run]
// 单跑命令: ./scripts/run-backfill.sh 跑完 backfill 后, 不必单独跑, 但保留以备 FTS5 漂移时手动修

const fs = require('fs');
const os = require('os');
const path = require('path');
const Database = require('better-sqlite3');

const DEFAULT_SOURCE = path.join(os.homedir(), '.pangu', 'memory', 'main.sqlite');

function parseArgs(argv) {
  const out = { source: DEFAULT_SOURCE, dryRun: false };
  for (let i = 2; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--source' || arg === '-s') out.source = argv[++i];
    else if (arg === '--dry-run') out.dryRun = true;
    else if (arg === '--help' || arg === '-h') {
      process.stdout.write('node modules/pangu-rebuild-fts.js [--source <path>] [--dry-run]\n');
      process.exit(0);
    } else throw new Error(`unknown arg: ${arg}`);
  }
  return out;
}

function rebuild(opts) {
  if (!fs.existsSync(opts.source)) {
    return { ok: false, error: `source not found: ${opts.source}` };
  }
  const db = new Database(opts.source, { readonly: false, fileMustExist: true });
  try {
    const chunksCount = db.prepare('SELECT COUNT(*) AS n FROM chunks').get().n;
    // 2026-10-30 (第 173 批): COUNT(*) FROM chunks_fts 读的是**内容表**,
    //   不是索引 ⇒ 跟 chunksCount 恒相等 ⇒ drift 恒为 0 ⇒ 这个修复脚本
    //   在生产里从来只报 no-op, 一次都没真修过。
    //   孤儿只能从**索引**里数: fts5vocab(chunks_fts,'instance')。
    // 计数必须走**独立连接**: vocab_drift 是挂在 fts5 索引上的游标,
    // 跟主连接共用时会让后面的 DELETE FROM chunks_fts 撞
    // "This database connection is busy executing a query" (实测 2026-10-30)。
    let ftsCount = chunksCount;
    let orphanCount = 0;
    {
      const probe = new Database(opts.source, { fileMustExist: true });
      try {
        // vocab 表必须建在 **main** schema: fts5vocab 的参数是相对 vocab 表自己
        // 所在 schema 解析的 —— 建在 temp 里, 裸名 chunks_fts 会被解析成 temp.chunks_fts
        // ⇒ "no such fts5 table"。建完立刻 DROP, 别把临时表留在生产库里。
        probe.exec("CREATE VIRTUAL TABLE IF NOT EXISTS main.vocab_drift USING fts5vocab(chunks_fts, 'instance')");
        // 2026-10-30 (复核轮修正): FTS 索引为空时 fts5vocab 建出来也是空的
        //   (没有 token 可枚举 ⇒ 0 行), count(DISTINCT doc) 会误报 0。
        //   缺行场景: 内容表有行但索引没物化 ⇒ ftsCount 假 0 ⇒ 误判 no-op。
        //   解法: 索引空时显式 rebuild 一次, 让索引从内容表物化, 再数。
        //   这一步对 no-op 场景 (索引已物化) 无副作用 —— rebuild 幂等。
        ftsCount = probe.prepare('SELECT count(DISTINCT doc) AS n FROM main.vocab_drift').get().n;
        if (ftsCount === 0 && chunksCount > 0) {
          // 索引空但内容表有行 → 缺行, 显式物化索引再数
          probe.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
          ftsCount = probe.prepare('SELECT count(DISTINCT doc) AS n FROM main.vocab_drift').get().n;
        }
        orphanCount = probe.prepare(
          'SELECT count(DISTINCT i.doc) AS n FROM main.vocab_drift i ' +
          'WHERE NOT EXISTS (SELECT 1 FROM chunks c WHERE c.rowid = i.doc)'
        ).get().n;
      } finally {
        try { probe.exec('DROP TABLE IF EXISTS main.vocab_drift;'); } catch (_) {}
        probe.close();
      }
    }
    // 2026-10-30 (复核轮修正): fts5vocab 在「索引为空」时建出来是空的
    //   (没有 token 可枚举 ⇒ 0 行 ⇒ ftsCount 误报 0), 不能作为缺行判据。
    //   缺行/多余行/孤儿的统一口径 = 净差; 但只有 fts5vocab 非空时
    //   count(DISTINCT doc) 才可信, 索引为空时用 COUNT(*) (读内容表,
    //   与 chunksCount 恒等) 兜底, 让「缺行」也触发 rebuild。
    const netDrift = Math.abs(chunksCount - ftsCount);

    if (netDrift === 0 && orphanCount === 0) {
      return { ok: true, source: opts.source, chunksCount, ftsCount, orphanCount, drift: 0, mode: 'no-op' };
    }

    if (opts.dryRun) {
      return { ok: true, source: opts.source, chunksCount, ftsCount, orphanCount, drift: netDrift, mode: 'dry-run' };
    }

    // 备份老库 (跟 backfill 一样, 写前 cp)
    const stamp = Math.floor(Date.now() / 1000);
    const backup = `${opts.source}.bak-${stamp}`;
    fs.copyFileSync(opts.source, backup);
    if (fs.existsSync(`${opts.source}-wal`)) fs.copyFileSync(`${opts.source}-wal`, `${backup}-wal`);
    if (fs.existsSync(`${opts.source}-shm`)) fs.copyFileSync(`${opts.source}-shm`, `${backup}-shm`);

    // 一次性 rebuild FTS5 from chunks
    //
    // 2026-10-30 (第 173 批): 重建方式换了。原来是
    //   DELETE FROM chunks_fts;  然后把 chunks 全量重插一遍
    // —— 这条路在外部内容表上是**错的** (chunks_fts content='chunks'):
    //   全删只清索引、不动内容表, 于是内容表与索引失配;
    //   紧接着再对同一个 vtab 做 fts5 操作, 直接
    //   SQLITE_CORRUPT_VTAB ("database disk image is malformed")。
    //   实测 (合成库 3 行): 全删 → 重插 → 崩;
    //   实测 (生产库): 全删+重插后孤儿从 2 涨到 1464。
    //
    // 正确做法是 fts5 的正规重建命令:
    //   INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')
    // 它从内容表重建索引, 顺带把已有孤儿清掉
    // (实测 合成库: rebuild 前 orphans=1 → rebuild 后 orphans=0)。
    db.transaction(() => {
      db.exec("INSERT INTO chunks_fts(chunks_fts) VALUES('rebuild')");
    })();
    db.close();
    return { ok: true, source: opts.source, chunksCount, ftsCount, orphanCount, drift: netDrift, mode: 'rebuilt', backup };
  } catch (error) {
    try { db.close(); } catch (_) {}
    return { ok: false, error: error.message };
  }
}

if (require.main === module) {
  const opts = parseArgs(process.argv);
  const result = rebuild(opts);
  process.stdout.write(JSON.stringify(result, null, 2) + '\n');
  process.exit(result.ok ? 0 : 1);
}

module.exports = { rebuild, parseArgs };
