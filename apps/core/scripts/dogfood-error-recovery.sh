#!/bin/bash
# Pangu dogfood 压测 - 错误恢复
# 4 种错误场景, 看 Pangu 怎么处理
set -euo pipefail

echo "=== PANGU DOGFOOD - 错误恢复 (4 场景) ==="
echo "TIME: $(date -Iseconds)"

# 1. 空 input
echo ""
echo "--- 场景 1: 空 input ---"
curl -sN -X POST http://127.0.0.1:18901/message/stream \
  -H "Content-Type: application/json" \
  -d '{"input":"","messages":[],"stream":true}' \
  --max-time 30 2>&1 | tail -c 200
echo ""

# 2. 超长 input (5000 字)
echo ""
echo "--- 场景 2: 超长 input ---"
LONG_INPUT=$(python3 -c "print('盘古' * 2500)")
curl -sN -X POST http://127.0.0.1:18901/message/stream \
  -H "Content-Type: application/json" \
  -d "$(jq -n --arg s "$LONG_INPUT" '{input:$s, messages:[], stream:true}')" \
  --max-time 60 2>&1 | tail -c 200
echo ""

# 3. 无效 JSON
echo ""
echo "--- 场景 3: 无效 JSON ---"
curl -sN -X POST http://127.0.0.1:18901/message/stream \
  -H "Content-Type: application/json" \
  -d '{not valid json}' \
  --max-time 10 2>&1 | tail -c 200
echo ""

# 4. 不存在的 endpoint
echo ""
echo "--- 场景 4: 不存在的 endpoint ---"
curl -sN -X POST http://127.0.0.1:18901/api/nonexistent \
  -H "Content-Type: application/json" \
  -d '{"foo":"bar"}' \
  --max-time 10 2>&1 | tail -c 200
echo ""

echo ""
echo "=== END ==="