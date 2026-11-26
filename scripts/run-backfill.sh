#!/bin/bash
# R39 件 1: 老 chunks 导到 Hermes 新库 (SQLite + HNSW)
# 老板 7/26 21:08 拍 'A' (R39 spec)
#
# 用法: ./scripts/run-backfill.sh [--limit N] [--dry-run]
# 跑完会:
#   写 ~/.pangu-data/agentdb/agentdb.sqlite (新库)
#   写 ~/.pangu-data/agentdb/agentdb.hnsw (向量索引)
#   自动备份旧新库到 .bak-<timestamp>
# 不动老库 ~/.pangu/memory/main.sqlite

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CORE="$ROOT/apps/core"
TARGET_DB="${HOME}/.pangu-data/agentdb/agentdb.sqlite"

if [ ! -d "$CORE/node_modules" ] && [ -d "$ROOT/node_modules" ]; then
  export NODE_PATH="$ROOT/node_modules"
fi

echo "[run-backfill] start $(date '+%Y-%m-%d %H:%M:%S')"
echo "[run-backfill] target: $TARGET_DB"

cd "$CORE"

if [ ! -f "${HOME}/.pangu/memory/main.sqlite" ]; then
  echo "[run-backfill] FATAL: ${HOME}/.pangu/memory/main.sqlite 不存在, 没法 backfill" >&2
  exit 2
fi

node modules/agentdb/backfill.js "$@"
RC=$?

if [ $RC -ne 0 ]; then
  echo "[run-backfill] backfill 跑失败 rc=$RC" >&2
  exit $RC
fi

# 件 4: 顺手 rebuild 老库 FTS5 (防 drift, 幂等 — drift=0 时 no-op)
node modules/pangu-rebuild-fts.js

echo "[run-backfill] done rc=$RC"
exit 0
