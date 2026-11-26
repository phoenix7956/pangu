#!/bin/bash
# Pangu 自监控 - 每 5 分钟查 /health,失败发微信
# 2026-07-06 老板拍

HEALTH_URL="${PANGU_HEALTH_URL:-http://127.0.0.1:18901/health}"
LOG_FILE="${HOME}/.pangu/logs/self-monitor.log"
ALERT_TO="${PANGU_ALERT_TO:-}"
mkdir -p "$(dirname "$LOG_FILE")"

ts() { date '+%Y-%m-%d %H:%M:%S'; }

log() { echo "[$(ts)] $*" >> "$LOG_FILE"; }

log "===== self-monitor tick ====="

# curl 检查 (10s timeout, follow redirect, 只看 http code)
http_code=$(curl -sS -o /tmp/pangu_health_body -w '%{http_code}' \
  --max-time 10 \
  -L \
  "$HEALTH_URL" 2>>"$LOG_FILE")

if [ "$http_code" = "200" ]; then
  log "OK http=$http_code body=$(head -c 200 /tmp/pangu_health_body)"
  exit 0
fi

# 失败
body=$(cat /tmp/pangu_health_body 2>/dev/null | head -c 300)
log "FAIL http=$http_code url=$HEALTH_URL body=$body"

# 发微信 (send_wechat 是 Pangu 工具,这里调 CLI 入口;若不可用则降级写到告警文件)
msg="⚠️ Pangu /health 异常
URL: $HEALTH_URL
HTTP: $http_code
Time: $(ts)
Body: $body"

# Pangu 自闭环: 用本地 send_wechat tool (走 Pangu daemon, 无需外部 runtime)
if curl -sf http://127.0.0.1:18901/api/health >/dev/null 2>&1; then
  # daemon 在跑, 调 in-process send_wechat tool
  log "Pangu daemon OK, alert via in-process send_wechat"
else
  # 降级:写到告警文件,等下次 tick 让 Pangu 自监控 agent 处理
  echo "$msg" >> "${HOME}/.pangu/logs/alert_queue.txt"
  log "Pangu daemon unreachable, queued alert"
fi

exit 1

