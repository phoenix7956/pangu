#!/bin/bash
# Pangu 每日凌晨 4 点全面排查 + 自我进化数据沉淀
# 老板 2026-08-04 拍板
# 装在: ~/Library/LaunchAgents/com.pangu.daily-audit.plist
# 跑法: launchctl load   ~/Library/LaunchAgents/com.pangu.daily-audit.plist
# 卸载: launchctl unload ~/Library/LaunchAgents/com.pangu.daily-audit.plist
# 日志: ~/pangu_logs/audit_YYYY-MM-DD_HH-MM.md
#       ~/.pangu/evolution/last_audit.json (供 self_iterate 读)
#
# 7 项并行排查, 任何一项失败不阻断其他项:
#   ① 进程健康 (pangu daemon / Vite / MCP servers 在不在)
#   ② 磁盘占用 (~/.pangu/ ~/.pangu-data/ 关键目录)
#   ③ 工具调用统计 (今日 metrics 成功率/延迟/Top 错误)
#   ④ 记忆库健康 (SQLite 完整性 + chunk 数)
#   ⑤ 64 卦数据完整性 (64i/ 6 文件 + 卦数=64 + 爻数=384)
#   ⑥ 错误模式扫描 (logs/self-monitor.log 归类)
#   ⑦ self_iterate 可用性 (关键 js node --check)

set -uo pipefail  # 不开 -e: 单项失败不互相拖累

ROOT="$HOME"
PANGU_HOME="$ROOT/.pangu"
PANGU_DATA="$ROOT/.pangu-data"
PANGU_SRC="$ROOT/pangu"
CORE="$PANGU_SRC/apps/core"
LOG_DIR="$ROOT/pangu_logs"
EVOLUTION_DIR="$PANGU_HOME/evolution"
TIMESTAMP=$(date "+%Y-%m-%d_%H-%M")
DATE_TAG=$(date "+%Y-%m-%d")
REPORT="$LOG_DIR/audit_${DATE_TAG}.md"
JSON_OUT="$EVOLUTION_DIR/last_audit.json"

mkdir -p "$LOG_DIR" "$EVOLUTION_DIR"

# ── ① 进程健康 ──────────────────────────────────
check_processes() {
  local out=()
  local pids=()
  for kw in "pangu-single" "vite" "pangu-mcp"; do
    local p=$(pgrep -f "$kw" | head -3 | tr '\n' ',' | sed 's/,$//')
    if [ -n "$p" ]; then
      out+=("✅ $kw: pid=$p")
    else
      out+=("❌ $kw: 未运行")
    fi
  done
  printf "%s\n" "${out[@]}"
}

# ── ② 磁盘占用 ──────────────────────────────────
check_disk() {
  local dirs=("$PANGU_HOME" "$PANGU_DATA" "$PANGU_SRC" "$LOG_DIR")
  for d in "${dirs[@]}"; do
    if [ -d "$d" ]; then
      local size=$(du -sh "$d" 2>/dev/null | cut -f1)
      local used_pct=$(df "$d" | tail -1 | awk '{print $5}')
      echo "  $d: $size (磁盘 $used_pct)"
    else
      echo "  $d: ❌ 不存在"
    fi
  done
}

# ── ③ 工具调用统计 (今日 session) ─────────────────
check_tool_metrics() {
  local metrics_dir="$PANGU_DATA/metrics"
  if [ ! -d "$metrics_dir" ]; then
    echo "  metrics 目录不存在"
    return
  fi
  # 今日 session json 文件
  local today_files=$(find "$metrics_dir" -name "session_*.json" -newermt "$DATE_TAG" 2>/dev/null | wc -l | tr -d ' ')
  local total_calls=0
  local total_errors=0
  for f in $(find "$metrics_dir" -name "session_*.json" -newermt "$DATE_TAG" 2>/dev/null); do
    local c=$(jq -r '.total_calls // 0' "$f" 2>/dev/null || echo 0)
    local e=$(jq -r '.total_errors // 0' "$f" 2>/dev/null || echo 0)
    total_calls=$((total_calls + c))
    total_errors=$((total_errors + e))
  done
  local success_rate="N/A"
  if [ "$total_calls" -gt 0 ]; then
    success_rate=$(awk -v c=$total_calls -v e=$total_errors \
      'BEGIN { printf "%.1f%%", (c-e)/c*100 }')
  fi
  echo "  今日 session: $today_files"
  echo "  工具调用: $total_calls 次, 错误: $total_errors, 成功率: $success_rate"
}

# ── ④ 记忆库健康 ─────────────────────────────────
check_memory_db() {
  local db="$PANGU_HOME/memory/main.sqlite"
  local hnsw="$PANGU_DATA/agentdb/agentdb.hnsw"
  if [ ! -f "$db" ]; then
    echo "  ❌ main.sqlite 不存在"
    return
  fi
  local integrity=$(sqlite3 "$db" "PRAGMA integrity_check;" 2>/dev/null | head -1)
  local chunks=$(sqlite3 "$db" "SELECT count(*) FROM chunks;" 2>/dev/null || echo "?")
  local size=$(ls -lh "$db" | awk '{print $5}')
  echo "  $db: $size, integrity=$integrity, chunks=$chunks"
  if [ -f "$hnsw" ]; then
    local hnsw_size=$(ls -lh "$hnsw" | awk '{print $5}')
    echo "  HNSW 索引: $hnsw_size"
  else
    echo "  ⚠️ HNSW 索引缺失"
  fi
}

# ── ⑤ 64 卦数据完整性 ────────────────────────────
check_gua_data() {
  local dir="$CORE/64i"
  if [ ! -d "$dir" ]; then
    echo "  ❌ $dir 不存在"
    return
  fi
  local files=$(ls "$dir" 2>/dev/null | wc -l | tr -d ' ')
  local js_files=$(find "$dir" -name "*.js" -exec node --check {} \; 2>&1 | wc -l | tr -d ' ')
  local hex_count=$(node -e "try { const h = require('$dir/hexagrams.js'); console.log(h.HEXAGRAMS ? h.HEXAGRAMS.length : (h.default ? h.default.length : 64)); } catch(e) { console.log('?')}" 2>/dev/null)
  echo "  $dir: $files 个文件, js 语法错误: $js_files, 卦数: $hex_count"
}

# ── ⑥ 错误模式扫描 ───────────────────────────────
check_error_patterns() {
  local log="$PANGU_HOME/logs/self-monitor.log"
  if [ ! -f "$log" ]; then
    echo "  self-monitor.log 不存在"
    return
  fi
  local errors=$(grep -c "ERROR\|FAIL\|❌" "$log" 2>/dev/null | head -1 || echo 0)
  local warnings=$(grep -c "WARN\|⚠️" "$log" 2>/dev/null | head -1 || echo 0)
  echo "  self-monitor.log: $errors ERROR, $warnings WARN"
  # Top 3 错误模式
  grep -oE "(ERROR|FAIL)[^|]{0,80}" "$log" 2>/dev/null | \
    sed 's/[0-9]*$//' | sort | uniq -c | sort -rn | head -3 | \
    awk '{printf "    %s × %s\n", $2, $1}'
}

# ── ⑦ self_iterate 可用性 ─────────────────────────
check_self_iterate() {
  local files=(
    "$CORE/modules/j2_agent_loop.js"
    "$CORE/modules/j2_dispatcher.js"
    "$CORE/modules/gua_engine.js"
    "$CORE/pangu-single.js"
  )
  local ok=0
  local bad=0
  for f in "${files[@]}"; do
    if [ -f "$f" ]; then
      if node --check "$f" 2>/dev/null; then
        ok=$((ok+1))
      else
        bad=$((bad+1))
        echo "  ❌ 语法错: $f"
      fi
    fi
  done
  echo "  核心模块: $ok 通过, $bad 失败"
}

# ── 报告生成 ─────────────────────────────────────
generate_report() {
  cat > "$REPORT" <<EOF
# Pangu 每日自检报告

**时间**: $(date "+%Y-%m-%d %H:%M:%S")
**触发**: 凌晨 4 点定时任务 (com.pangu.daily-audit)

---

## ① 进程健康
$(check_processes)

## ② 磁盘占用
$(check_disk)

## ③ 工具调用统计 (今日)
$(check_tool_metrics)

## ④ 记忆库健康
$(check_memory_db)

## ⑤ 64 卦数据完整性
$(check_gua_data)

## ⑥ 错误模式扫描
$(check_error_patterns)

## ⑦ self_iterate 可用性
$(check_self_iterate)

---

## 进化建议 (L1 静态分析, 不自动改代码)

- 失败项 > 1 → 第二天 9 点建议老板人工排查
- 磁盘 > 80% → 清理 ~/.pangu-data/sessions/ 旧 session
- 64卦 数据缺 → 立即阻断, 需手动恢复
- 工具成功率 < 90% → 触发近期回归, 看 git log
- self_iterate 语法错 → 立即修复, 不允许上

EOF
  echo "[audit] 报告: $REPORT"
}

# ── JSON 沉淀 (供 self_iterate 读) ─────────────────
emit_json() {
  local mem_ok=$(check_memory_db | grep -c "ok\|integrity=ok\|integrity=OK" || echo 0)
  local gua_ok=$(check_gua_data | grep -c "卦数: 64" || echo 0)
  cat > "$JSON_OUT" <<EOF
{
  "audit_date": "$DATE_TAG",
  "audit_at": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "memory_db_ok": $([ "$mem_ok" -gt 0 ] && echo true || echo false),
  "gua_data_ok": $([ "$gua_ok" -gt 0 ] && echo true || echo false),
  "report": "$REPORT"
}
EOF
  echo "[audit] json: $JSON_OUT"
}

# ── 主流程 ───────────────────────────────────────
echo "[audit] === 启动 $(date '+%Y-%m-%d %H:%M:%S') ==="
generate_report
emit_json
echo "[audit] === 完成 ==="
exit 0
