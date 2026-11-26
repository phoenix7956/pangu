#!/bin/bash
# Pangu dogfood 压测 - vision 任务
# 发 1x1 base64 PNG, 让 Pangu 走 vision 链路
# 2026-07-09 老板拍：不依赖 jq/python3，纯 bash + curl
set -uo pipefail

PNG_DATA="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="

QUESTIONS=(
  "这张图里有什么?"
  "描述一下这张图片。"
  "图里是什么颜色?"
  "这是什么类型的图像?"
  "这张图片能用来做什么?"
)
Q="${QUESTIONS[$((RANDOM % ${#QUESTIONS[@]}))]}"

# 纯 bash JSON 构造（不依赖 jq/python3）
JSON_BODY=$(cat <<EOF
{"input":"$Q","messages":[{"role":"user","content":"$Q","images":["$PNG_DATA"]}],"stream":true}
EOF
)

RESULT=$(curl -sN -X POST http://127.0.0.1:18901/message/stream \
  -H "Content-Type: application/json" \
  -d "$JSON_BODY" \
  --max-time 60 2>&1 || echo "CURL_FAIL")

HEAD_200=$(echo "$RESULT" | head -c 200)
TAIL_200=$(echo "$RESULT" | tail -c 200)
MODEL_USED=$(echo "$RESULT" | grep -oE '"model_used":"[^"]*"' | tail -1 || echo '"model_used":"?"')
TOOLS=$(echo "$RESULT" | grep -oE '"name":"[^"]*"' | head -5 | tr '\n' ' ')

echo "=== PANGU DOGFOOD - vision ==="
echo "TIME: $(date -Iseconds)"
echo "INPUT: $Q"
echo "MODEL: $MODEL_USED"
echo "TOOLS: $TOOLS"
echo ""
echo "=== HEAD 200 ==="
echo "$HEAD_200"
echo ""
echo "=== TAIL 200 ==="
echo "$TAIL_200"
echo "=== END ==="