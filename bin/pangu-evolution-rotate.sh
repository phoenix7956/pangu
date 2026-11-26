#!/bin/bash
# pangu-evolution-rotate.sh — evolution/ 单文件超 50MB 时 rotate
# 2026-08-04 加 (Bug #5)
EV_DIR="$HOME/.pangu/evolution"
MAX_BYTES=52428800  # 50MB
mkdir -p "$EV_DIR/archived"
for f in "$EV_DIR"/*.jsonl; do
  [ -f "$f" ] || continue
  sz=$(stat -f%z "$f")
  if [ "$sz" -gt "$MAX_BYTES" ]; then
    base=$(basename "$f" .jsonl)
    date=$(date +%Y%m%d-%H%M%S)
    mv "$f" "$EV_DIR/archived/${base}-$date.jsonl"
    # 压缩 30 天以上的
    find "$EV_DIR" -name "*.jsonl" -mtime +30 -exec gzip {{}} \; 2>/dev/null
    find "$EV_DIR" -name "*.jsonl.gz" -mtime +90 -delete 2>/dev/null
    echo "[$(date)] rotated: $f -> archived/${base}-$date.jsonl" >> "$HOME/Library/Logs/pangu/evolution-rotate.log"
  fi
done
