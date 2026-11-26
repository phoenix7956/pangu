#!/bin/bash
# Pangu init — 第一次跑 Pangu 用 (建用户目录 + 从模板生成 config)
# 老板拍 2026-07-02: GitHub 版 Pangu = 完整功能 + 零个人痕迹

set -e
PANGU_HOME="${PANGU_HOME:-$HOME/.pangu}"
TEMPLATE="$(cd "$(dirname "$0")/.." && pwd)/config.template.json"

echo "🖤 Pangu init"
echo "============="
echo "PANGU_HOME: $PANGU_HOME"
echo "TEMPLATE:   $TEMPLATE"
echo ""

mkdir -p "$PANGU_HOME/config/nodes"
mkdir -p "$PANGU_HOME/logs"
mkdir -p "$PANGU_HOME/cache"

if [ -f "$PANGU_HOME/config/nodes/default.json" ]; then
  echo "⚠️  default.json 已存在, 不覆盖"
else
  cp "$TEMPLATE" "$PANGU_HOME/config/nodes/default.json"
  echo "✅ 模板已拷到 $PANGU_HOME/config/nodes/default.json"
fi

echo ""
echo "下一步: 编辑 $PANGU_HOME/config/nodes/default.json 填 LLM API key"
echo "然后跑: PANGU_HOME=$PANGU_HOME node pangu-single.js"
