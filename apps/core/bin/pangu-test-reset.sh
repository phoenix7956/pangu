#!/bin/bash
# Pangu test-reset — 每天 dogfooding 测试前清数据 (§0.13 老板拍 2026-07-11)
# 设计原则: "做出来能用最好" — 一键清测试数据, 保留核心资产
# 用法: bin/pangu-test-reset.sh [--force]
#       --force: 不确认, 直接清 (适合 cron)
#       无 --force: 列出要清的内容 + 老板确认
#
# 范围:
#   🟢 清: evolution/*.jsonl, ~/.pangu/memory/main.sqlite, ~/.pangu/memory/memory/sessions/*.md,
#           ~/.pangu/memory/memory.md, workspace/.learnings/pangu_evolution/*.md, pangu.pid
#   🔴 保留: MEMORY.md, Pangu config, LM Studio 模型, workspace skills/, AGENTS/SOUL/IDENTITY 等

set -e
PANGU_HOME="${PANGU_HOME:-$HOME/.pangu}"
PANGU_REPO="$(cd "$(dirname "$0")/.." && pwd)"
WORKSPACE="${WORKSPACE:-$HOME/.pangu/workspace}"

FORCE=false
[ "$1" = "--force" ] && FORCE=true

echo "🖤 Pangu test-reset"
echo "==================="
echo "PANGU_HOME: $PANGU_HOME"
echo "PANGU_REPO: $PANGU_REPO"
echo "WORKSPACE:  $WORKSPACE"
echo ""

# 计算要清的文件
echo "📋 将要清理的测试数据:"
echo ""

# 1. evolution/*.jsonl
EVO_FILES=$(find "$PANGU_REPO/evolution" -name "*.jsonl" -type f 2>/dev/null)
EVO_FILES=$(echo "$EVO_FILES" | grep -v "/raw_" || true)
if [ -n "$EVO_FILES" ]; then
  echo "  🟢 evolution/*.jsonl (L1 dogfooding 数据):"
  echo "$EVO_FILES" | while read f; do
    size=$(stat -f%z "$f" 2>/dev/null)
    echo "      $(basename $f) ($size bytes)"
  done
  total=$(echo "$EVO_FILES" | wc -l | tr -d ' ')
  echo "      小计: $total 个文件"
fi

# 2. ~/.pangu/memory/memory.md
if [ -f "$PANGU_HOME/memory/memory.md" ]; then
  size=$(stat -f%z "$PANGU_HOME/memory/memory.md")
  echo "  🟢 ~/.pangu/memory/memory.md (l2-miner 累积记忆): $size bytes"
fi

# 3. ~/.pangu/memory/memory/sessions/*.md (Pangu 实际路径 — 双 memory)
if [ -d "$PANGU_HOME/memory/memory/sessions" ]; then
  SESS_FILES=$(find "$PANGU_HOME/memory/memory/sessions" -name "*.md" -type f 2>/dev/null)
  if [ -n "$SESS_FILES" ]; then
    total=$(echo "$SESS_FILES" | wc -l | tr -d ' ')
    echo "  🟢 ~/.pangu/memory/memory/sessions/ (历史会话): $total 个文件"
  fi
fi

# 3b. ~/.pangu/memory/memory/learning/*.md (L2 学习笔记)
if [ -d "$PANGU_HOME/memory/memory/learning" ]; then
  LR_FILES=$(find "$PANGU_HOME/memory/memory/learning" -name "*.md" -type f 2>/dev/null)
  if [ -n "$LR_FILES" ]; then
    total=$(echo "$LR_FILES" | wc -l | tr -d ' ')
    echo "  🟢 ~/.pangu/memory/memory/learning/ (L2 学习笔记): $total 个文件"
  fi
fi

# 3c. ~/.pangu/memory/memory/archive/*.md (已归档)
if [ -d "$PANGU_HOME/memory/memory/archive" ]; then
  ARC_FILES=$(find "$PANGU_HOME/memory/memory/archive" -name "*.md" -type f 2>/dev/null)
  if [ -n "$ARC_FILES" ]; then
    total=$(echo "$ARC_FILES" | wc -l | tr -d ' ')
    echo "  🟢 ~/.pangu/memory/memory/archive/ (已归档): $total 个文件"
  fi
fi

# 3d. ~/.pangu/memory/memory/*.md (根目录其他累积 .md)
ROOT_MD_FILES=$(find "$PANGU_HOME/memory/memory" -maxdepth 1 -name "*.md" -type f 2>/dev/null)
if [ -n "$ROOT_MD_FILES" ]; then
  total=$(echo "$ROOT_MD_FILES" | wc -l | tr -d ' ')
  echo "  🟢 ~/.pangu/memory/memory/*.md (根目录累积 .md): $total 个文件"
fi

# 3e. ~/.pangu/memory/main.sqlite (大头 — Pangu UI 历史对话页面加载这个)
if [ -f "$PANGU_HOME/memory/main.sqlite" ]; then
  size=$(du -h "$PANGU_HOME/memory/main.sqlite" | awk '{print $1}')
  echo "  🟢 ~/.pangu/memory/main.sqlite (SQLite 历史库, 大头): $size"
fi
if [ -f "$PANGU_HOME/memory/main.sqlite-wal" ]; then
  size=$(du -h "$PANGU_HOME/memory/main.sqlite-wal" | awk '{print $1}')
  echo "  🟢 ~/.pangu/memory/main.sqlite-wal (WAL): $size"
fi
if [ -f "$PANGU_HOME/memory/main.sqlite-shm" ]; then
  echo "  🟢 ~/.pangu/memory/main.sqlite-shm (SHM)"
fi

# 4. workspace/.learnings/pangu_evolution/*.md
if [ -d "$WORKSPACE/.learnings/pangu_evolution" ]; then
  EVO_REPORTS=$(find "$WORKSPACE/.learnings/pangu_evolution" -maxdepth 1 -name "*.md" -type f 2>/dev/null)
  if [ -n "$EVO_REPORTS" ]; then
    total=$(echo "$EVO_REPORTS" | wc -l | tr -d ' ')
    echo "  🟢 workspace/.learnings/pangu_evolution/*.md (日报): $total 个文件"
  fi
fi

# 5. pangu.pid
if [ -f "$PANGU_REPO/pangu.pid" ]; then
  pid=$(cat "$PANGU_REPO/pangu.pid" 2>/dev/null)
  echo "  🟢 pangu.pid (记录: $pid, 实际可能不一致 — 让 Pangu 重启时刷新)"
fi

echo ""
echo "🔴 将保留 (核心资产):"
echo "  - MEMORY.md (老板铁律)"
echo "  - Pangu config (model 配置)"
echo "  - LM Studio 模型"
echo "  - workspace/skills/ (SKILL.md 知识库)"
echo "  - workspace/AGENTS.md / SOUL.md / IDENTITY.md / USER.md / TOOLS.md / HEARTBEAT.md"
echo ""

# 确认
if [ "$FORCE" = false ]; then
  read -p "确认清数据? (yes/no): " confirm
  if [ "$confirm" != "yes" ]; then
    echo "❌ 取消"
    exit 0
  fi
fi

echo ""
echo "🧹 开始清理..."

# 1. evolution/*.jsonl (保留 raw_* 不动)
if [ -d "$PANGU_REPO/evolution" ]; then
  for f in $(find "$PANGU_REPO/evolution" -name "*.jsonl" -type f 2>/dev/null); do
    if [[ ! "$f" == *"/raw_"* ]]; then
      rm -f "$f"
      echo "  ✓ rm $(basename $f)"
    fi
  done
fi

# 2. ~/.pangu/memory/memory.md
if [ -f "$PANGU_HOME/memory/memory.md" ]; then
  rm -f "$PANGU_HOME/memory/memory.md"
  echo "  ✓ rm memory.md"
fi

# 3. ~/.pangu/memory/memory/sessions/*.md (Pangu 实际路径 — 双 memory)
if [ -d "$PANGU_HOME/memory/memory/sessions" ]; then
  rm -f "$PANGU_HOME/memory/memory/sessions"/*.md 2>/dev/null || true
  echo "  ✓ rm memory/sessions/*.md"
fi

# 3b. ~/.pangu/memory/memory/learning/*.md (L2 学习笔记)
if [ -d "$PANGU_HOME/memory/memory/learning" ]; then
  rm -f "$PANGU_HOME/memory/memory/learning"/*.md 2>/dev/null || true
  echo "  ✓ rm memory/learning/*.md"
fi

# 3c. ~/.pangu/memory/memory/archive/*.md (已归档)
if [ -d "$PANGU_HOME/memory/memory/archive" ]; then
  rm -f "$PANGU_HOME/memory/memory/archive"/*.md 2>/dev/null || true
  echo "  ✓ rm memory/archive/*.md"
fi

# 3d. ~/.pangu/memory/memory/*.md (根目录累积 .md, 不含子目录)
if [ -d "$PANGU_HOME/memory/memory" ]; then
  rm -f "$PANGU_HOME/memory/memory"/*.md 2>/dev/null || true
  echo "  ✓ rm memory/*.md"
fi

# 3e. ~/.pangu/memory/main.sqlite (大头)
if [ -f "$PANGU_HOME/memory/main.sqlite" ]; then
  rm -f "$PANGU_HOME/memory/main.sqlite"
  echo "  ✓ rm main.sqlite"
fi
if [ -f "$PANGU_HOME/memory/main.sqlite-wal" ]; then
  rm -f "$PANGU_HOME/memory/main.sqlite-wal"
  echo "  ✓ rm main.sqlite-wal"
fi
if [ -f "$PANGU_HOME/memory/main.sqlite-shm" ]; then
  rm -f "$PANGU_HOME/memory/main.sqlite-shm"
  echo "  ✓ rm main.sqlite-shm"
fi

# 4. workspace/.learnings/pangu_evolution/*.md
if [ -d "$WORKSPACE/.learnings/pangu_evolution" ]; then
  rm -f "$WORKSPACE/.learnings/pangu_evolution"/*.md 2>/dev/null || true
  echo "  ✓ rm pangu_evolution/*.md"
fi

# 5. pangu.pid
if [ -f "$PANGU_REPO/pangu.pid" ]; then
  rm -f "$PANGU_REPO/pangu.pid"
  echo "  ✓ rm pangu.pid"
fi

echo ""
echo "✅ 清数据完成"
echo ""
echo "下一步建议:"
echo "  1. 重启 Pangu: launchctl kickstart -k gui/\$(id -u)/local.pangu-single"
echo "  2. 跑测试, 验证 fail-stop / tool 调用正常"
echo "  3. 跑 1 天 dogfooding, 看 evolution 数据累积"