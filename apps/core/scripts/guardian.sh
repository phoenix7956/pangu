#!/bin/bash
# Pangu 进程守护 - 每 2 分钟查进程+HTTP，缺失自动重启
# 2026-07-10 老板拍：解决 Pangu 总是断的问题
# 2026-07-16 P2-7: 添加 launchd plist 存在性检查和降级直接启动

set -uo pipefail

# 2026-10-13: 全部改成可注入 (guardian-longwork-20261013 修复的配套):
# 测试要能把 HEALTH_URL / PID 源 / 日志 指到临时目录, 否则会 kill 到真的盘古。
PANGU_PID_FILE="${PANGU_PID_FILE:-${HOME}/.pangu/pangu.pid}"
PANGU_HOME="${PANGU_HOME:-$(cd "$(dirname "$0")/.." && pwd)}"
HEALTH_URL="${PANGU_HEALTH_URL:-http://127.0.0.1:18901/health}"
LOG_FILE="${PANGU_LOG_FILE:-${HOME}/.pangu/logs/self-monitor.log}"
PLIST_PATH="${PANGU_PLIST_PATH:-${HOME}/Library/LaunchAgents/local.pangu-single.plist}"
PANGU_LABEL="${PANGU_LABEL:-local.pangu-single}"
PROC_PATTERN="${PANGU_PROC_PATTERN:-pangu-single.js}"
HEALTH_BODY_FILE="${PANGU_HEALTH_BODY_FILE:-/tmp/pangu_health_body}"
# 长轮次期间事件循环本来就会被堵 (实测 /health 最慢 2.04s), 5s 探活 + 立即 kill -9
# = 任何长任务都在中途被杀。放宽到 25s。
HEALTH_MAX_TIME="${PANGU_HEALTH_MAX_TIME:-25}"
HEALTH_FAIL_THRESHOLD="${PANGU_HEALTH_FAIL_THRESHOLD:-2}"
HEALTH_FAIL_STATE="${PANGU_HEALTH_FAIL_STATE:-${HOME}/.pangu/.guardian_health_fail}"
mkdir -p "$(dirname "$LOG_FILE")"
mkdir -p "$(dirname "$HEALTH_FAIL_STATE")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" >> "$LOG_FILE"; }

log "===== guardian tick ====="

# 检查 launchd plist 是否存在
PLIST_AVAILABLE=false
if [ -f "$PLIST_PATH" ]; then
  PLIST_AVAILABLE=true
else
  log "launchd plist 不存在: $PLIST_PATH"
fi

restart_via_launchd() {
  if $PLIST_AVAILABLE; then
    launchctl kickstart -k "gui/$(id -u)/local.pangu-single" 2>/dev/null && return 0
    launchctl bootstrap "gui/$(id -u)" "$PLIST_PATH" 2>/dev/null && return 0
  fi
  return 1
}

direct_start() {
  log "降级: 直接启动 pangu-single.js"
  cd "$PANGU_HOME" && nohup node pangu-single.js >> "$LOG_FILE" 2>&1 &
  echo $! > "$PANGU_PID_FILE"
}

# 1. 查进程是否存在
# 2026-08-05 修 (重启循环实证): pid 文件会过期 (launchd/手动 kickstart 换了 PID),
# 以 launchd 为权威 PID 源, pid 文件只做兜底; 进程活着就刷新 pid 文件
PID=$(launchctl list 2>/dev/null | awk -v lbl="$PANGU_LABEL" '$3==lbl {print $1}')
if [ -z "$PID" ] || [ "$PID" = "-" ]; then
  PID=$(pgrep -f "$PROC_PATTERN" | head -1 || echo "")
fi
if [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null; then
  echo "$PID" > "$PANGU_PID_FILE"
  log "PID $PID alive"
else
  log "PID $PID NOT FOUND, restarting..."
  if restart_via_launchd; then
    log "通过 launchd 重启成功"
  else
    log "launchd 重启失败，降级直接启动"
    direct_start
  fi
  sleep 3
  NEW_PID=$(pgrep -f "$PROC_PATTERN" | head -1 || echo "")
  if [ -n "$NEW_PID" ]; then
    echo "$NEW_PID" > "$PANGU_PID_FILE"
  fi
  log "restarted, new PID=$NEW_PID"
fi

# 2. 查 HTTP 健康
http_code=$(curl -sS -o "$HEALTH_BODY_FILE" -w '%{http_code}' --max-time "$HEALTH_MAX_TIME" "$HEALTH_URL" 2>/dev/null || echo "000")
if [ "$http_code" = "200" ]; then
  rm -f "$HEALTH_FAIL_STATE"
  log "OK http=$http_code"
  exit 0
fi

# 一次探活失败不致命 —— 长轮次里事件循环被堵是常态, 连续失败到阈值才动手
_fail_count=0
if [ -f "$HEALTH_FAIL_STATE" ]; then
  _fail_count=$(cat "$HEALTH_FAIL_STATE" 2>/dev/null || echo 0)
  case "$_fail_count" in (''|*[!0-9]*) _fail_count=0 ;; esac
fi
_fail_count=$(( _fail_count + 1 ))
echo "$_fail_count" > "$HEALTH_FAIL_STATE"

if [ "$_fail_count" -lt "$HEALTH_FAIL_THRESHOLD" ]; then
  log "HTTP FAIL $http_code (连续 $_fail_count 次, 未到阈值 $HEALTH_FAIL_THRESHOLD, 不重启)"
  exit 0
fi

# 3. 连续失败到阈值, 强制重启
rm -f "$HEALTH_FAIL_STATE"
log "HTTP FAIL $http_code (连续 $_fail_count 次), force restart..."
if [ -n "$PID" ]; then
  # 2026-10-13: 原来直接 kill -9, 盘古的 asyncCleanup (父会话落盘) 一次都没机会跑。
  # 先 SIGTERM 给它 8 秒优雅退出, 不听话再升级。
  kill -TERM "$PID" 2>/dev/null || true
  _waited=0
  while [ "$_waited" -lt 8 ] && kill -0 "$PID" 2>/dev/null; do
    sleep 1
    _waited=$(( _waited + 1 ))
  done
  if kill -0 "$PID" 2>/dev/null; then
    log "SIGTERM 后 $_waited s 仍存活, 升级 SIGKILL"
    kill -9 "$PID" 2>/dev/null || true
  else
    log "SIGTERM 优雅退出成功 (asyncCleanup 有机会落盘)"
  fi
fi
sleep 1

if restart_via_launchd; then
  log "launchd 强制重启成功"
else
  log "launchd 强制重启失败，降级直接启动"
  direct_start
fi
sleep 3
NEW_PID=$(pgrep -f "$PROC_PATTERN" | head -1 || echo "")
if [ -n "$NEW_PID" ]; then
  echo "$NEW_PID" > "$PANGU_PID_FILE"
fi
log "force restarted, new PID=$NEW_PID"
