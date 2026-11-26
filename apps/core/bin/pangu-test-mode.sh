#!/bin/bash
# Pangu test-mode 启动器 (老板拍 2026-07-11 §0.13 dogfooding)
# 功能: 跳过持久记忆 + tools summary 注入, 从干净状态开始测试
# 用法:
#   bin/pangu-test-mode.sh           # 默认启动 (port 18901, test mode)
#   PORT=18911 bin/pangu-test-mode.sh # 自定义端口
#   bin/pangu-test-mode.sh stop      # 停掉 test mode Pangu

set -e
PANGU_REPO="$(cd "$(dirname "$0")/.." && pwd)"
PANGU_NODE="$PANGU_REPO/runtime/bin/node"
PANGU_BIN="$PANGU_REPO/pangu-single.js"
PORT="${PORT:-18901}"
PANGU_HOME="${PANGU_HOME:-$HOME/.pangu}"
LOG="/tmp/pangu-test-mode.log"
PID_FILE="/tmp/pangu-test-mode.pid"

export PANGU_TEST_MODE=1
export PANGU_HOME

case "$1" in
  stop)
    if [ -f "$PID_FILE" ]; then
      pid=$(cat "$PID_FILE")
      kill "$pid" 2>/dev/null && echo "✓ killed PID $pid" || echo "PID $pid not running"
      rm -f "$PID_FILE"
    else
      lsof -i :$PORT -P -n -t 2>/dev/null | xargs -r kill 2>/dev/null
      echo "✓ port $PORT freed"
    fi
    ;;
  status)
    if [ -f "$PID_FILE" ] && kill -0 "$(cat $PID_FILE)" 2>/dev/null; then
      echo "✓ test mode Pangu running: PID $(cat $PID_FILE), port $PORT"
      curl -s "http://127.0.0.1:$PORT/health" | head -c 200
      echo ""
    else
      echo "✗ test mode Pangu not running"
    fi
    ;;
  *)
    # 先停旧
    if [ -f "$PID_FILE" ]; then
      kill "$(cat $PID_FILE)" 2>/dev/null || true
      rm -f "$PID_FILE"
    fi
    lsof -i :$PORT -P -n -t 2>/dev/null | xargs -r kill 2>/dev/null || true
    sleep 1
    echo "🧪 启动 Pangu test-mode (port $PORT, 跳过长期记忆)"
    nohup "$PANGU_NODE" "$PANGU_BIN" > "$LOG" 2>&1 &
    echo $! > "$PID_FILE"
    sleep 2
    if curl -s -o /dev/null -w "%{http_code}" "http://127.0.0.1:$PORT/health" | grep -q 200; then
      echo "✅ test mode Pangu 启动成功 (PID: $(cat $PID_FILE), port: $PORT)"
      echo "   日志: tail -f $LOG"
      echo "   验证 test mode: 应该看到 [pangu] TEST_MODE=1 detected"
      grep -i "test_mode\|TEST_MODE" "$LOG" | head -3
    else
      echo "❌ 启动失败, 看日志: tail -50 $LOG"
      tail -50 "$LOG"
    fi
    ;;
esac
