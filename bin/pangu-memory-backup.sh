#!/bin/bash
# pangu-memory-backup.sh — 每日 03:00 备份 memory/main.sqlite
# 2026-08-04 Hermes 加 (Bug #4)
BACKUP_DIR="$HOME/.pangu/memory/backups"
SRC="$HOME/.pangu/memory/main.sqlite"
DATE=$(date +%Y%m%d-%H%M%S)
mkdir -p "$BACKUP_DIR"
# 留 7 天, 老的删
sqlite3 "$SRC" ".backup '$BACKUP_DIR/main-$DATE.sqlite'" && echo "[$(date)] OK backup: $BACKUP_DIR/main-$DATE.sqlite" >> "$HOME/Library/Logs/pangu/memory-backup.log"
ls -t "$BACKUP_DIR"/main-*.sqlite 2>/dev/null | tail -n +8 | xargs -I {} rm -f {}
# 删 30 天以上的 .gz (如果有)
find "$BACKUP_DIR" -name "*.gz" -mtime +30 -delete 2>/dev/null
