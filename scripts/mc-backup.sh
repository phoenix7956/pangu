#!/bin/bash
# MC3 数据库定时备份：本机 v3 (mc3-server/data/mc3.db) → NAS
# 2026-09-11 重写: 旧版 ssh 备份已退役的 MC3 v2 (mini 192.168.0.120), 每 2 小时超时挂红 (teamflow exit 126 根因)
# 2026-09-26: .88 已作废, 真源已迁 192.168.0.192:7893。本机 .88 的 mc3.db 只作冷备份保留, 非主库
# 每 2 小时由 launchd 触发；MacBook 睡眠错过的触发会在唤醒时补跑
set -u
TS=$(date +%Y%m%d-%H%M%S)
LOG="${HOME}/Library/Logs/pangu/mc-backup.log"
NAS="/Volumes/gongzuo/agents/mc-backup"
DB="/Users/you/Desktop/workspace/mc3-server/data/mc3.db"

log() { echo "[$(date '+%F %T')] $*" >> "$LOG"; }

mkdir -p "$(dirname "$LOG")" 2>/dev/null || true

if [ ! -f "$DB" ]; then
  log "FAIL: 本机 mc3.db 不存在: $DB"
  exit 1
fi

# 1. NAS 未挂载则用钥匙串挂载
# launchd 没有稳定的桌面/TCC 权限，不能在后台可靠地用 AppleScript 挂载 NAS。
# 只检查挂载状态并快速失败；下一个周期会重试，日志明确提示手动挂载。
if [ ! -d "/Volumes/gongzuo" ]; then
  log "SKIP: NAS 未挂载，请先在 Finder 挂载 smb://phoenixfn(SMB)._smb._tcp.local/gongzuo/"
  # 外部 NAS 未连接不是备份脚本自身崩溃；返回 0，等待下一周期重试。
  exit 0
fi
mkdir -p "$NAS"

# 2. 本机一致性备份 (WAL 模式下 .backup 安全, 不锁业务库)
DEST="$NAS/mc3-backup-$TS.db"
if command -v sqlite3 >/dev/null 2>&1; then
  if ! sqlite3 "$DB" ".backup '$DEST'" 2>/dev/null; then
    cp "$DB" "$DEST" || { log "FAIL: mc3.db 备份失败"; exit 1; }
  fi
else
  cp "$DB" "$DEST" || { log "FAIL: mc3.db 备份失败"; exit 1; }
fi

# 3. 滚动保留最近 30 份 (只滚 mc3- 前缀, 不动旧版 mc-backup-*.db)
ls -t "$NAS"/mc3-backup-*.db 2>/dev/null | tail -n +31 | while read -r f; do rm -f "$f"; done

SIZE=$(ls -lh "$DEST" 2>/dev/null | awk '{print $5}')
log "OK: mc3-backup-$TS.db ($SIZE) -> NAS, mc3 保留 $(ls "$NAS"/mc3-backup-*.db 2>/dev/null | wc -l | tr -d ' ') 份"
