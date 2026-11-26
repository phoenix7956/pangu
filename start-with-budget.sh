#!/bin/bash
# 2026-08-30 立 — 盘古启动包装 (预算 + 跨 session 上下文补丁配套)
# 用法: ./start-with-budget.sh [start|stop|status|restart]
export PANGU_BUDGET_MAX_WALL_MS=${PANGU_BUDGET_MAX_WALL_MS:-1800000}
export PANGU_BUDGET_MAX_ROUNDS=${PANGU_BUDGET_MAX_ROUNDS:-80}
export PANGU_BUDGET_MAX_TOKENS=${PANGU_BUDGET_MAX_TOKENS:-500000}
export PANGU_BUDGET_MAX_TOOL_CALLS=${PANGU_BUDGET_MAX_TOOL_CALLS:-200}
export PANGU_BUDGET_MAX_COMPACT_RESETS=${PANGU_BUDGET_MAX_COMPACT_RESETS:-10}
export PANGU_BUDGET_IDLE_GAP_MS=${PANGU_BUDGET_IDLE_GAP_MS:-120000}

PANGU_DIR="$(cd "$(dirname "$0")" && pwd)"
NODE_BIN="$HOME/.local/bin/node"
PID_FILE=/tmp/pangu-single.pid
LOG_FILE=/tmp/pangu.log

case "${1:-status}" in
  start)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "pangu 已在跑 (pid=$(cat "$PID_FILE"))"; exit 1
    fi
    cd "$PANGU_DIR" || exit 2
    echo "[start-with-budget] env: MAX_WALL_MS=$PANGU_BUDGET_MAX_WALL_MS MAX_ROUNDS=$PANGU_BUDGET_MAX_ROUNDS MAX_TOKENS=$PANGU_BUDGET_MAX_TOKENS"
    nohup "$NODE_BIN" --expose-gc apps/core/pangu-single.js > "$LOG_FILE" 2>&1 &
    echo $! > "$PID_FILE"
    echo "pangu 启动 pid=$(cat "$PID_FILE"), log=$LOG_FILE"
    ;;
  stop)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      kill "$(cat "$PID_FILE")"; rm -f "$PID_FILE"; echo "pangu 停止"
    else
      echo "pangu 未跑"; rm -f "$PID_FILE"
    fi
    ;;
  restart)
    "$0" stop; sleep 1; "$0" start
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
      echo "pangu 运行中 pid=$(cat "$PID_FILE") 端口 18901"
      ps -p "$(cat "$PID_FILE")" -o pid,rss,etime,command | tail -1
    else
      echo "pangu 未跑"; rm -f "$PID_FILE"
    fi
    ;;
  *) echo "用法: $0 {start|stop|restart|status}"; exit 3 ;;
esac
