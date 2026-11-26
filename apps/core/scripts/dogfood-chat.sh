#!/bin/bash
# Pangu dogfood 压测 - 普通 chat
# 直接 curl /message/stream, 不依赖 sub-agent, 100% 可靠
# 调用一次 Pangu, 写一条 L1 进化日志

set -euo pipefail

# 随机中文短问 (20 个候选)
QUESTIONS=(
  "今天上海天气怎么样?"
  "用一句话介绍盘古(Pangu)是什么。"
  "推荐一本最近值得读的好书?"
  "你好,介绍一下你自己。"
  "现在几点了?"
  "老板今天心情怎么样?"
  "盘古能做什么?"
  "讲个笑话听听。"
  "什么是品牌心智?"
  "你怎么看待AI替代人类工作?"
  "给我一个提高效率的建议。"
  "为什么天空是蓝色的?"
  "深圳和上海哪个更适合创业?"
  "如何养成早起习惯?"
  "你认为最重要的人生原则是什么?"
  "什么是好的增长策略?"
  "如何快速学会一门新技能?"
  "推荐一部最近值得看的电影?"
  "你有什么人生感悟可以分享?"
  "老板让我问候你。"
)
Q="${QUESTIONS[$((RANDOM % ${#QUESTIONS[@]}))]}"

# curl Pangu 后端
RESULT=$(curl -sN -X POST http://127.0.0.1:18901/message/stream \
  -H "Content-Type: application/json" \
  -d "$(printf '{"input":"%s","messages":[],"stream":true}' "$Q")" \
  --max-time 30 2>&1 || echo "CURL_FAIL")

# 提取关键字段 (head 200 / tail 200 / model_used / total_chars / 错误事件)
HEAD_200=$(echo "$RESULT" | head -c 200)
TAIL_200=$(echo "$RESULT" | tail -c 200)
MODEL_USED=$(echo "$RESULT" | grep -oE '"model_used":"[^"]*"' | tail -1 || echo '"model_used":"?"')
TOTAL_CHARS=$(echo "$RESULT" | grep -oE '"total_chars":[0-9]+' | tail -1 || echo "total_chars:?")
ERROR_EVENTS=$(echo "$RESULT" | grep -c '^event: error' || echo "0")

echo "=== PANGU DOGFOOD - 普通 chat ==="
echo "TIME: $(date -Iseconds)"
echo "INPUT: $Q"
echo "MODEL: $MODEL_USED"
echo "$TOTAL_CHARS"
echo "ERROR_EVENTS: $ERROR_EVENTS"
echo ""
echo "=== HEAD 200 ==="
echo "$HEAD_200"
echo ""
echo "=== TAIL 200 ==="
echo "$TAIL_200"
echo "=== END ==="