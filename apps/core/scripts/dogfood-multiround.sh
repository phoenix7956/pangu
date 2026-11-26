#!/bin/bash
# Pangu dogfood 压测 - 多轮对话
# 3 轮连续 chat, 测试 context 保持
set -euo pipefail

INPUTS=(
  "你好,我叫盘古。"
  "我叫什么?"
  "给我推荐一本适合程序员读的书。"
  "这本书讲什么?"
  "这本书适合初学者吗?"
  "总结一下我们聊的。"
)

ALL_OK=true
CONTEXT="[]"
TOTAL_ROUNDS=3
echo "=== PANGU DOGFOOD - 多轮对话 (${TOTAL_ROUNDS} 轮) ==="
echo "TIME: $(date -Iseconds)"

for i in $(seq 1 $TOTAL_ROUNDS); do
  Q="${INPUTS[$((RANDOM % ${#INPUTS[@]}))]}"
  echo ""
  echo "--- 轮 $i ---"
  echo "INPUT: $Q"

  # 构造 messages 历史 + 当前 input
  BODY=$(jq -n --arg input "$Q" --argjson msgs "$CONTEXT" '{input:$input, messages:$msgs, stream:true}')

  RESULT=$(curl -sN -X POST http://127.0.0.1:18901/message/stream \
    -H "Content-Type: application/json" \
    -d "$BODY" \
    --max-time 30 2>&1 || echo "CURL_FAIL")

  TAIL=$(echo "$RESULT" | tail -c 500)
  echo "$TAIL"

  # 提取 final_text 给下一轮 messages
  FINAL_TEXT=$(echo "$RESULT" | grep -oE '"delta":"[^"]*"' | sed 's/"delta":"//;s/"$//' | tr -d '\n' || echo "")
  if [ -z "$FINAL_TEXT" ]; then
    ALL_OK=false
  fi

  # 更新 context: append user + assistant
  CONTEXT=$(echo "$CONTEXT" | jq --arg q "$Q" --arg r "$FINAL_TEXT" '. + [{role:"user", content:$q}, {role:"assistant", content:$r}]')
done

echo ""
echo "=== END ==="
[ "$ALL_OK" = true ] && echo "STATUS: ✅ ALL_ROUNDS_OK" || echo "STATUS: ❌ SOME_ROUND_FAIL"