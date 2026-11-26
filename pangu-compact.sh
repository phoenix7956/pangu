#!/bin/bash
# 2026-08-30 立 — 盘古手动压缩 CLI 包装
# 触发 /api/pangu/admin/compact 强制压缩 session, 同时 reset budget
# 用法:
#   ./pangu-compact.sh <session_id>
#   ./pangu-compact.sh --queue      # 看当前队列
#   ./pangu-compact.sh --list-sessions  # 列 ~/.pangu/state/ 下最近 5 个 session
set -e
HOST=${PANGU_HOST:-127.0.0.1}
PORT=${PANGU_PORT:-18901}
BASE="http://${HOST}:${PORT}"

case "${1:-}" in
  --queue|-q)
    curl -sS --max-time 5 "$BASE/api/pangu/admin/compact-queue" | python3 -m json.tool 2>/dev/null || curl -sS --max-time 5 "$BASE/api/pangu/admin/compact-queue"
    ;;
  --list-sessions|-l)
    ls -lt ~/.pangu/state/checkpoints/*_r0.json 2>/dev/null | head -5 | awk '{print $NF}' | xargs -I{} basename {} _r0.json
    ;;
  --help|-h|"")
    echo "用法:"
    echo "  $0 <session_id>            强制压缩指定 session (并 reset budget)"
    echo "  $0 --queue                 看当前 pending 队列"
    echo "  $0 --list-sessions         列最近 5 个 session_id"
    echo "  $0 --help                  看这个帮助"
    ;;
  *)
    SID="$1"
    echo "[pangu-compact] POST $BASE/api/pangu/admin/compact session_id=$SID"
    curl -sS --max-time 10 -X POST "$BASE/api/pangu/admin/compact" \
      -H "Content-Type: application/json" \
      -d "{\"session_id\":\"$SID\"}" | python3 -m json.tool 2>/dev/null \
      || curl -sS --max-time 10 -X POST "$BASE/api/pangu/admin/compact" \
           -H "Content-Type: application/json" \
           -d "{\"session_id\":\"$SID\"}"
    ;;
esac
