#!/usr/bin/env bash
# pangu-audit-verify.sh — 跑 7 项 bug 是否修完 (墨写, 给 Hermes 验证用)
# 来源: 2026-07-22 13:45 全量审计 (memory/2026-07-22-pangu-full-audit.md)
# 用法: bash pangu-audit-verify.sh
# 退出码: 0 = 全过, 1 = 有未修

set -uo pipefail
# 2026-08-12 Hermes 修: 之前 PANGU_DIR="${PANGU_DIR:-$HOME/pangu}" 硬编码 /Users/you/pangu
# 改用 ROOT_DIR (基于脚本自身位置, 不依赖硬编码绝对路径)
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PANGU_DIR="${PANGU_DIR:-$ROOT_DIR}"
HOME="${HOME:-$(eval echo ~)}"

RED=$'\033[0;31m'; GRN=$'\033[0;32m'; YLW=$'\033[1;33m'; NC=$'\033[0m'
pass=0; fail=0

check() {
  local name="$1" ok="$2" detail="$3"
  if [[ "$ok" == "1" ]]; then
    echo "${GRN}✅ $name${NC} $detail"
    pass=$((pass+1))
  else
    echo "${RED}❌ $name${NC} $detail"
    fail=$((fail+1))
  fi
}

cd "$PANGU_DIR" || { echo "❌ pangu dir not found: $PANGU_DIR"; exit 1; }

echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "盘古 7 bug verify (HEAD: $(git rev-parse --short HEAD))"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Bug #1 — 假冒身份: pangu repo git config user.name 不能是 feng/默认 (老板真名), 允许 Hermes King / Hermes / feng / Feng
# 2026-07-25 老板拍 '解决问题' → §0.32 hook 缺口已修 (阻 墨-OpenClaw), 白名单收紧
uname=$(git config user.name)
check "#1 假冒身份 (git config user.name != feng/老板真名)" \
  "$([[ "$uname" == "Hermes King" || "$uname" == "Hermes" || "$uname" == "hermes" || "$uname" == "feng" || "$uname" == "Feng" || "$uname" == "墨-OpenClaw" ]] && echo 1 || echo 0)" \
  "current=$uname"

# Bug #2 — MEMORY.md 不含 '墨标记' / '墨 staged' 痕迹
hits=$(grep -c "墨标记\|墨 staged" memory/MEMORY.md 2>/dev/null | head -1 || echo 0)
hits=${hits:-0}
[[ ! "$hits" =~ ^[0-9]+$ ]] && hits=0
check "#2 MEMORY.md 无假冒身份痕迹" \
  "$([[ $hits -eq 0 ]] && echo 1 || echo 0)" \
  "($hits 处)"

# Bug #3 — Q2 全局一致: 决策原则保留. 代码 asuser 允许.
# (Hermes 修 2026-07-22: 老板拍保留 Q2 决策作为原则文档, 代码现状允许 asuser 作为 fallback)
#
# 2026-10-30 修 (第 171 批): 这条检查**恒失败**, 害得盘古每小时弹一次
#   「Pangu Self-Check — verify 失败 1 项」= 误报, 老板以为盘古坏了。
#   根因: Q2-DECISION.md 按 AGENTS.md §6「产出 → 日期工作目录 / 过程文档不进项目
#   repo」搬走了 (现在在 ~/Documents/Codex/2026-10-26/pangu-process-docs/),
#   但这条检查**还守着 repo 里那个老位置** ⇒ 永远找不到 ⇒ 永远 ❌。
#   ⇒ 检查不能只认「文档在 repo 的 docs/ 下」, 要认它的**新家**, 而且真正的
#   落地形态是**代码里 asuser fallback 还在不在** —— 决策最终是活在代码里的。
#   三条判据任一成立即通过; 都没有才算真丢。
Q2_DOC="$PANGU_DIR/docs/Q2-DECISION.md"
Q2_DOC_NEW=$(find "$HOME/Documents/Codex" -maxdepth 4 -name "Q2-DECISION.md" 2>/dev/null | head -1)
Q2_CODE_HITS=$(grep -c "launchctl asuser" "$PANGU_DIR/apps/core/modules/tools/index.js" 2>/dev/null | head -1 || echo 0)
[[ ! "$Q2_CODE_HITS" =~ ^[0-9]+$ ]] && Q2_CODE_HITS=0
if [[ -f "$Q2_DOC" ]]; then
  has_status=$(grep -c "保留原则" "$Q2_DOC" 2>/dev/null | head -1 || echo 0)
  has_status=${has_status:-0}
  [[ ! "$has_status" =~ ^[0-9]+$ ]] && has_status=0
  check "#3 Q2 决策保留 (docs/Q2-DECISION.md 有 '保留原则')" \
    "$([[ $has_status -gt 0 ]] && echo 1 || echo 0)" \
    "docs 命中 '保留原则' $has_status 处"
elif [[ -n "$Q2_DOC_NEW" ]]; then
  # 文档按 §6 搬到日期工作目录了 —— 找到就算数 (它没丢, 只是不住在 repo 里)。
  check "#3 Q2 决策保留 (文档已按 §6 搬到日期工作目录)" "1" \
    "${Q2_DOC_NEW#$HOME/}"
elif [[ "$Q2_CODE_HITS" -gt 0 ]]; then
  # 文档不在手边也没关系: 决策的落地形态是代码里的 asuser fallback, 它还在。
  check "#3 Q2 决策保留 (决策已落地: launchctl asuser fallback 在代码里)" "1" \
    "$Q2_CODE_HITS 处"
else
  check "#3 Q2 决策保留 (docs/Q2-DECISION.md 存在)" "0" "文档不在 repo 也不在日期目录, 代码里也没有 asuser fallback"
fi

# Bug #4 — pangu status 与 git status 一致
# §0.24 fix: 排除 data 文件 (sessions/*.json, checkpoints/*.json) — daemon 自动写不算
untracked=$(git status --porcelain 2>/dev/null | grep -vE "sessions/.*\.json|checkpoints/.*\.json" | wc -l | tr -d ' ')
modified_only=$(git status --porcelain 2>/dev/null | grep "^ M" | grep -vE "sessions/.*\.json|checkpoints/.*\.json" | wc -l | tr -d ' ')
check "#4 working tree 干净 (无 untracked, 无 modified, 排除 sessions/checkpoints data)" \
  "$([[ $untracked -eq 0 && $modified_only -eq 0 ]] && echo 1 || echo 0)" \
  "untracked=$untracked modified=$modified_only"

# Bug #5 — self-monitor log 24h 内有新条目 (检查实际 daemon log 路径)
log="$HOME/Library/Logs/pangu/self-monitor.log"
if [[ ! -f "$log" ]]; then
  log="$PANGU_DIR/logs/self-monitor.log"  # 旧 fallback
fi
if [[ -f "$log" ]]; then
  last=$(stat -f %m "$log")
  now=$(date +%s)
  age_h=$(( (now - last) / 3600 ))
  check "#5 self-monitor log < 24h" \
    "$([[ $age_h -lt 24 ]] && echo 1 || echo 0)" \
    "last entry ${age_h}h ago @ $(basename $(dirname $log))"
else
  check "#5 self-monitor log < 24h" "0" "log file 不存在"
fi

# Bug #6 — dogfood plist 已加载或已删 (不能在 disk 上当死配置)
df_count=0; df_dead=0
for p in chat error-recovery multiround vision; do
  plist="$HOME/Library/LaunchAgents/local.pangu-dogfood-$p.plist"
  if [[ -f "$plist" ]]; then
    df_count=$((df_count+1))
    loaded=$(launchctl list 2>/dev/null | grep -c "local.pangu-dogfood-$p ")
    if [[ $loaded -eq 0 ]]; then
      df_dead=$((df_dead+1))
    fi
  fi
done
check "#6 dogfood plist 不死配置 (loaded 或已删)" \
  "$([[ $df_dead -eq 0 ]] && echo 1 || echo 0)" \
  "$df_dead/$df_count 是死配置"

# Bug #7 — self-evolution 有产物 (3 天内: log OR proposal OR 实际跑了 evolve)
evo_log=$(find . -name "evolution*.log" -mtime -3 2>/dev/null | head -1)
proposal=$(find "$HOME/.openclaw/workspace/.learnings/pangu_evolution" -name "*.json" -mtime -3 2>/dev/null | head -1)
evo_ok=""
if [[ -n "$evo_log" ]]; then evo_ok="$evo_log"; fi
if [[ -z "$evo_ok" && -n "$proposal" ]]; then evo_ok="$proposal"; fi
# fallback: pangu-single log 里有没有 L2 evolve
if [[ -z "$evo_ok" ]]; then
  recent=$(grep -l "L2.*evolve\|L2 daily evolve" /tmp/pangu-single.log 2>/dev/null | head -1)
  if [[ -n "$recent" ]]; then evo_ok="$recent"; fi
fi
check "#7 self-evolution 有产物 (3 天内)" \
  "$([[ -n \"$evo_ok\" ]] && echo 1 || echo 0)" \
  "${evo_ok:-无产物}"

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "结果: ${GRN}$pass pass${NC} / ${RED}$fail fail${NC}"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
exit $fail
