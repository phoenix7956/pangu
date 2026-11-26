#!/bin/bash
# run-self-evolve.sh — 盘古凌晨自检 + 自我进化 (R-L4 4am cron)
# 2026-08-04 老板拍板: 每天 4:00 跑一次全面排查
# 卦象: 未济→蒙,四爻动,体克用,中吉 — 还没成,继续检
#
# 设计: 离线跑, 不依赖 daemon (4am daemon 可能 sleep)
# 8 维度巡检 + 自动归档 + 致命时弹桌面通知
#
# 用法: ./run-self-evolve.sh [--dry-run] [--notify]
#   --dry-run: 只跑不归档不通知
#   --notify:  无论结果都弹桌面通知
# 输出: ~/.pangu/scripts/l4-self-evolve.log (append)
#       ~/.pangu/reports/self-evolve-YYYYMMDD.md (每日覆盖)

set -uo pipefail

DRY_RUN=false
NOTIFY=false
for arg in "$@"; do
  case "$arg" in
    --dry-run) DRY_RUN=true ;;
    --notify)  NOTIFY=true ;;
  esac
done

ROOT="$ROOT_DIR"
CORE="$ROOT/apps/core"
TS=$(date '+%Y-%m-%d %H:%M:%S')
DATE=$(date '+%Y%m%d')
LOG="$HOME/.pangu/scripts/l4-self-evolve.log"
REPORT_DIR="$HOME/.pangu/reports"
REPORT="$REPORT_DIR/self-evolve-$DATE.md"

mkdir -p "$REPORT_DIR"

# ====== 累计计数 ======
WARNINGS=0
ERRORS=0
OK_LINES=()

log() { echo "[$TS] $*" | tee -a "$LOG" ; }
ok()  { OK_LINES+=("$*"); log "  ✅ $*"; }
warn(){ WARNINGS=$((WARNINGS+1)); log "  ⚠️  $*"; }
err() { ERRORS=$((ERRORS+1)); log "  ❌ $*"; }

log "============================================"
log "🔧 盘古自检开始 (R-L4 cron)"
log "============================================"

# ============================================================
# 维度 1: Daemon 健康 — 进程在不在, 心跳新不新
# ============================================================
log "[1/8] Daemon 健康"
DAEMON_PID=$(pgrep -f "pangu-single.js" | head -1)
if [ -n "$DAEMON_PID" ]; then
  ok "daemon 进程 PID=$DAEMON_PID"
  HB_FILE="$ROOT/apps/core/.heartbeat"
  if [ -f "$HB_FILE" ]; then
    HB_AGE=$(( $(date +%s) - $(stat -f %m "$HB_FILE") ))
    if [ "$HB_AGE" -lt 600 ]; then
      ok "心跳新鲜 (${HB_AGE}s 前)"
    else
      warn "心跳过期 ${HB_AGE}s — daemon 可能僵死"
    fi
  else
    warn "无 .heartbeat 文件"
  fi
else
  warn "daemon 未运行 (cron 时正常, 白天会自启)"
fi

# ============================================================
# 维度 2: 工具自检 — 117 个工具黑盒
# ============================================================
log "[2/8] 工具自检 (baseline selftest)"
cd "$CORE"
SELFTEST_OUT=$(timeout 60 node tests/tools_selftest.js 2>&1)
SELFTEST_RC=$?
PASS=$(echo "$SELFTEST_OUT" | grep -E "PASS.*[0-9]+/[0-9]+" | tail -1)
FAIL=$(echo "$SELFTEST_OUT" | grep -cE "FAIL " || echo 0)
if [ "$SELFTEST_RC" -eq 0 ] && [ "$FAIL" -eq 0 ]; then
  ok "工具自检全过 — $PASS"
else
  err "工具自检失败 — rc=$SELFTEST_RC FAIL=$FAIL"
  echo "$SELFTEST_OUT" | tail -20 >> "$LOG"
fi

# ============================================================
# 维度 3: 64 卦内核 — 起一卦验证引擎 + 数据
# ============================================================
log "[3/8] 64 卦内核验证"
GUA_OUT=$(cd "$CORE" && timeout 15 node -e "
const {guaCast} = require('./modules/gua_engine.js');
try {
  const r = guaCast({method:'time'});
  console.log('OK', r.gua_name, '→', r.zhi_gua.name, '动爻', r.moving_yao);
} catch(e) {
  console.error('FAIL', e.message);
  process.exit(2);
}
" 2>&1)
if echo "$GUA_OUT" | grep -q "^OK"; then
  ok "卦引擎可用 — $GUA_OUT"
else
  err "卦引擎异常: $GUA_OUT"
fi

# ============================================================
# 维度 4: 记忆库体检
# ============================================================
log "[4/8] 记忆库"
MEM_DB="$HOME/.pangu/memory/main.sqlite"
if [ -f "$MEM_DB" ]; then
  SIZE_MB=$(du -m "$MEM_DB" | cut -f1)
  CHUNKS=$(sqlite3 "$MEM_DB" "SELECT COUNT(*) FROM chunks;" 2>/dev/null || echo "N/A")
  ok "memory.sqlite ${SIZE_MB}MB / ${CHUNKS} chunks"
  if [ "$SIZE_MB" -gt 500 ]; then
    warn "memory 库超 500MB, 建议 prune"
  fi
else
  warn "memory.sqlite 不存在"
fi

# agentdb
ADB="$HOME/.pangu-data/agentdb/agentdb.sqlite"
if [ -f "$ADB" ]; then
  ADB_SIZE=$(du -m "$ADB" | cut -f1)
  ok "agentdb.sqlite ${ADB_SIZE}MB"
else
  warn "agentdb 未建, 首次 backfill 后才有"
fi

# ============================================================
# 维度 5: 磁盘空间
# ============================================================
log "[5/8] 磁盘空间"
DISK_FREE=$(df -g "$HOME" | tail -1 | awk '{print $4}')
if [ "$DISK_FREE" -lt 10 ]; then
  err "主盘只剩 ${DISK_FREE}G — 危险"
else
  ok "主盘剩余 ${DISK_FREE}G"
fi
for d in "$HOME/.pangu-data" "$HOME/.pangu" "$ROOT"; do
  if [ -d "$d" ]; then
    D_SIZE=$(du -sh "$d" | cut -f1)
    log "  · $d → $D_SIZE"
  fi
done

# ============================================================
# 维度 6: Git 状态 (仓库脏不脏)
# ============================================================
log "[6/8] Git 状态"
cd "$ROOT"
DIRTY=$(git status --porcelain 2>/dev/null | wc -l | tr -d ' ')
HEAD_CMT=$(git log -1 --format='%h %s' 2>/dev/null)
if [ "$DIRTY" -gt 0 ]; then
  warn "working tree 有 ${DIRTY} 个未提交改动 — 最近 commit: $HEAD_CMT"
else
  ok "working tree 干净 — HEAD: $HEAD_CMT"
fi

# ============================================================
# 维度 7: 日志关键字扫描 (近 24h ERROR/FATAL)
# ============================================================
log "[7/8] 日志扫描"
LOG_DIR="$ROOT/logs"
if [ -d "$LOG_DIR" ]; then
  ERR_COUNT=$(find "$LOG_DIR" -name "*.log" -mtime -1 -exec grep -hE "ERROR|FATAL|UnhandledPromise" {} \; 2>/dev/null | wc -l | tr -d ' ')
  if [ "$ERR_COUNT" -gt 0 ]; then
    warn "近 24h 日志有 ${ERR_COUNT} 条 ERROR/FATAL"
    find "$LOG_DIR" -name "*.log" -mtime -1 -exec grep -hE "ERROR|FATAL" {} \; 2>/dev/null | tail -5 >> "$LOG"
  else
    ok "近 24h 日志无 ERROR/FATAL"
  fi
fi

# ============================================================
# 维度 8: 进程级健康 — 端口 + 内存
# ============================================================
log "[8/8] 进程健康"
PANGU_MEM=$(ps -o rss= -p $(pgrep -f "pangu-single.js" | head -1) 2>/dev/null | tr -d ' ')
if [ -n "$PANGU_MEM" ]; then
  MEM_MB=$((PANGU_MEM / 1024))
  ok "daemon 内存 ${MEM_MB}MB"
  if [ "$MEM_MB" -gt 2048 ]; then
    warn "daemon 内存超 2GB — 可能泄漏"
  fi
fi

# ============================================================
# 总结 + 报告
# ============================================================
log "============================================"
log "📊 总结: ✅ ${#OK_LINES[@]} OK | ⚠️  $WARNINGS 警告 | ❌ $ERRORS 错误"
log "============================================"

# 写报告
{
  echo "# 盘古自检报告 — $TS"
  echo ""
  echo "**卦象**: 未济→蒙,四爻动,体克用,**中吉**"
  echo ""
  echo "## 汇总"
  echo "- ✅ 通过: ${#OK_LINES[@]}"
  echo "- ⚠️  警告: $WARNINGS"
  echo "- ❌ 错误: $ERRORS"
  echo ""
  echo "## 各项"
  for o in "${OK_LINES[@]}"; do echo "- $o"; done
  echo ""
  if [ "$ERRORS" -gt 0 ] || [ "$WARNINGS" -gt 0 ]; then
    echo "## 警告/错误"
    tail -50 "$LOG" | grep -E "⚠️|❌" || echo "无"
  fi
  echo ""
  echo "## HEAD"
  cd "$ROOT" && git log -1 --format='%h %ai %s'
} > "$REPORT"

# 通知 (致命时)
if [ "$ERRORS" -gt 0 ] || [ "$NOTIFY" = true ]; then
  if [ "$DRY_RUN" = false ]; then
    osascript -e "display notification \"盘古自检: ${ERRORS} 错误 / ${WARNINGS} 警告\" with title \"Pangu R-L4 4am 自检\" subtitle \"$TS\"" 2>/dev/null || true
  fi
fi

# 旧报告清理 (保留 14 天)
if [ "$DRY_RUN" = false ]; then
  find "$REPORT_DIR" -name "self-evolve-*.md" -mtime +14 -delete 2>/dev/null || true
fi

# 退出码: 错=1, 警=2, 全过=0
if [ "$ERRORS" -gt 0 ]; then exit 1; fi
if [ "$WARNINGS" -gt 0 ]; then exit 2; fi
exit 0