#!/bin/bash
# Hermes self-check — 替代 4 个 dead dogfood plist
# 老板睡后 (2026-07-23 凌晨) 启用, 等墨的 spec 期间给老板 health report
#
# 行为:
#   1. 盘古 /health 探活
#   2. pangu-audit-verify 跑一次 (期望 7/7)
#   3. 4 个 dead dogfood plist 提醒 (脚本不在)
#   4. 当前 git status / commit
#   5. LLM model pool enabled 数
# 失败时: 写 ~/Library/Logs/pangu/self-check.log + macOS 通知
# 工作区未提交修改只做报告，不应让 launchd 任务本身变红。
#
# 装: cp this ~/Library/LaunchAgents/local.pangu-self-check.plist && launchctl load

# ROOT_DIR: 基于脚本自身位置, 不依赖硬编码绝对路径
# 相对路径优先: 脚本搬家不会坏
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HOME="${HOME:-$(eval echo ~)}"

set -u
HEALTH_URL="http://127.0.0.1:18901/health"
# 2026-07-26 修: VERIFY 改用脚本自身目录定位 — ~/.openclaw/workspace/scripts/ 已整个消失
# (7/26 凌晨 symlink 灾难后), 硬编码路径导致 "脚本不存在" 假失败
VERIFY="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/pangu-audit-verify.sh"
LOG_DIR="$HOME/Library/Logs/pangu"
LOG="$LOG_DIR/self-check.log"
ALERT="$LOG_DIR/self-check-alert.txt"
# 2026-10-30 修 (第 171 批): 告警**去重指纹**。
#   以前只要有 critical 项 fail, 就**每小时弹一次** macOS 通知 ——
#   连着弹三天, 老板看见的是「盘古是不是坏了」, 其实那一条是恒失败的
#   检查项 (Q2 文档位置过时), 盘古好好的。
#   现在: 同一条告警 24 小时内只弹**第一次**, 之后只写日志。
#   真异常 (health 挂了) 第一次仍然弹 —— 不因为去重而漏报。
FP_FILE="$HOME/Library/Logs/pangu/self-check-alert.fp"
FP_WINDOW=86400   # 24 小时

mkdir -p "$LOG_DIR"

ts() { date '+%Y-%m-%d %H:%M:%S'; }
log() { echo "[$(ts)] $*" | tee -a "$LOG"; }
alert() {
  log "⚠️  ALERT: $*"
  echo "[$(ts)] $*" >> "$ALERT"
  # macOS 通知 (同一条 24h 内只弹一次)
  local fp now last_fp last_at
  fp=$(printf '%s' "$*" | shasum | cut -c1-16)
  now=$(date +%s)
  last_fp=""; last_at=0
  if [[ -f "$FP_FILE" ]]; then
    read -r last_fp last_at < "$FP_FILE" 2>/dev/null || true
  fi
  [[ "$last_at" =~ ^[0-9]+$ ]] || last_at=0
  if [[ "$last_fp" == "$fp" ]] && (( now - last_at < FP_WINDOW )); then
    log "  ↳ 同一告警 24h 内已弹过, 这次只记日志 (去重)"
    return 0
  fi
  printf '%s %s\n' "$fp" "$now" > "$FP_FILE" 2>/dev/null || true
  osascript -e "display notification \"$*\" with title \"Pangu Self-Check\"" 2>/dev/null || true
}

PASS=0
FAIL=0
check() {
  local name="$1" ok="$2" detail="$3"
  if [[ "$ok" == "1" ]]; then
    log "  ✅ $name — $detail"
    PASS=$((PASS+1))
  else
    log "  ❌ $name — $detail"
    FAIL=$((FAIL+1))
  fi
}

log "=================================================="
log "盘古 self-check 启动 (Hermes cron)"
log "=================================================="

# 1. /health 探活
http_code=$(curl -sS -o /tmp/pangu_health_body -w '%{http_code}' --max-time 5 "$HEALTH_URL" 2>/dev/null || echo "000")
if [[ "$http_code" == "200" ]]; then
  body=$(cat /tmp/pangu_health_body 2>/dev/null)
  tools=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['tools_loaded'])" 2>/dev/null || echo "?")
  uptime=$(echo "$body" | python3 -c "import sys,json; print(json.load(sys.stdin)['data']['uptime_s'])" 2>/dev/null || echo "?")
  check "盘古 health" "1" "tools=$tools uptime=${uptime}s"
else
  check "盘古 health" "0" "HTTP $http_code"
  alert "盘古 /health HTTP $http_code — 可能 daemon 死"
fi

# 2. verify 跑一次 (期望 7/7)
if [[ -x "$VERIFY" ]]; then
  out=$(bash "$VERIFY" 2>&1)
  pass_count=$(echo "$out" | grep -c "✅")
  fail_count=$(echo "$out" | grep -c "❌")
  # verify 的唯一常态失败项可能是开发工作区未提交修改；它不应让 launchd 任务失败。
  verify_critical=$(echo "$out" | grep "❌" | grep -vc "working tree" || true)
  verify_critical=${verify_critical:-0}
  check "7 bug verify" "$([[ $verify_critical -eq 0 && $pass_count -ge 6 ]] && echo 1 || echo 0)" "$pass_count pass / $fail_count fail (critical=$verify_critical)"
  # 2026-07-26 修: 只有 working tree 脏 (开发中常态) 不弹通知 — 通知 = 真异常才发
  fail_critical=$(echo "$out" | grep "❌" | grep -vc "working tree" || true)
  fail_critical=${fail_critical:-0}
  if [[ "$fail_critical" -gt 0 ]]; then
    alert "verify 失败 $fail_critical 项 (期望 0)"
    # 2026-08-11 R131-Phase 1 §老板拍: 触发 self-repair 检测器 (Phase 2 才真修, 现在只发现)
    if [[ -x "$HOME/.local/bin/node" && -f "$ROOT_DIR/bin/pangu-repair-watcher.js" ]]; then
      node $ROOT_DIR/bin/pangu-repair-watcher.js --quiet 2>/dev/null || true
      log "  ↳ 已触发 repair-watcher (写 pending 到 ~/.pangu/repair/)"
    fi
  fi
else
  check "7 bug verify" "0" "脚本不存在: $VERIFY"
fi

# 3. 4 dead dogfood plist 状态
dead_count=0
for p in chat error-recovery multiround vision; do
  plist="$HOME/Library/LaunchAgents/local.pangu-dogfood-$p.plist"
  if [[ -f "$plist" ]]; then
    loaded=$(launchctl list 2>/dev/null | grep -c "local.pangu-dogfood-$p ")
    if [[ $loaded -eq 0 ]]; then
      dead_count=$((dead_count+1))
    fi
  fi
done
check "dogfood plist 不死配置" "$([[ $dead_count -eq 0 ]] && echo 1 || echo 0)" "$dead_count/4 dead"

# 4. git status
# 2026-08-12 Hermes 修: PANGU_DIR 之前是硬编码 /Users/you/pangu, 我 inject 时删了, 但 line 104 还在用 → set -u 炸
# 改用 ROOT_DIR (脚本自身位置, 不依赖硬编码)
cd "$ROOT_DIR" || exit 1
untracked=$(git status --porcelain 2>/dev/null | grep -c "^??" | head -1 || echo 0)
untracked=${untracked:-0}
[[ ! "$untracked" =~ ^[0-9]+$ ]] && untracked=0
modified=$(git status --porcelain 2>/dev/null | grep -c "^ M" | head -1 || echo 0)
modified=${modified:-0}
[[ ! "$modified" =~ ^[0-9]+$ ]] && modified=0
check "working tree 干净" "$([[ $untracked -eq 0 && $modified -eq 0 ]] && echo 1 || echo 0)" "untracked=$untracked modified=$modified"

# 5. LLM model pool enabled 数
# 2026-07-26 修: node → python3 — launchd 环境 PATH 没有 ~/.local/bin, node 找不到 → 恒 "0/0" 假失败
# 2026-08-12 Hermes 修: PANGU_DIR 之前硬编码 /Users/you/pangu, 改用 ROOT_DIR 相对路径
# 前面 cd "$ROOT_DIR" 已 ok, 直接用相对路径
pool=$(python3 -c "
import json
cfg = json.load(open('apps/core/config/nodes/your-mac.json'))
models = cfg['llm']['models']
enabled = sum(1 for m in models if m.get('enabled'))
print(str(enabled) + '/' + str(len(models)))
" 2>/dev/null)
pool=${pool:-0/0}
enabled_count="${pool%%/*}"
enabled_count=${enabled_count:-0}
[[ ! "$enabled_count" =~ ^[0-9]+$ ]] && enabled_count=0
check "LLM 模型池" "$([[ $enabled_count -ge 2 ]] && echo 1 || echo 0)" "$pool"

log "=================================================="
log "本次结果: $PASS pass / $FAIL fail"
log "=================================================="

# git 工作区脏是开发态信息，不算健康任务的致命失败；其他检查仍返回失败码。
critical_fail=$FAIL
if [[ $untracked -gt 0 || $modified -gt 0 ]]; then
  critical_fail=$((critical_fail - 1))
fi
(( critical_fail < 0 )) && critical_fail=0
exit "$critical_fail"
