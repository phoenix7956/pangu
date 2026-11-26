#!/bin/bash
# pangu-tasks — 一屏看全盘古所有 launchd 定时/常驻任务
# 用法: pangu-tasks          表格总览
#       pangu-tasks report   打开最近一次自检报告
set -uo pipefail

AGENTS_DIR="$HOME/Library/LaunchAgents"
BLD=$'\033[1m'; GRN=$'\033[32m'; RED=$'\033[31m'; YEL=$'\033[33m'; DIM=$'\033[2m'; RST=$'\033[0m'

fmt_schedule() {
  local plist="$1"
  local p; p=$(plutil -p "$plist" 2>/dev/null)
  if echo "$p" | grep -q 'StartCalendarInterval'; then
    local h m wd
    h=$(echo "$p" | sed -n 's/.*"Hour" => \([0-9]*\).*/\1/p' | head -1)
    m=$(echo "$p" | sed -n 's/.*"Minute" => \([0-9]*\).*/\1/p' | head -1)
    wd=$(echo "$p" | sed -n 's/.*"Weekday" => \([0-9]*\).*/\1/p' | head -1)
    [ -z "$m" ] && m=0
    if [ -n "$wd" ]; then echo "每周$wd $(printf %02d "${h:-0}"):$(printf %02d "$m")"
    else echo "每天 $(printf %02d "${h:-0}"):$(printf %02d "$m")"; fi
  elif echo "$p" | grep -q 'StartInterval'; then
    local s; s=$(echo "$p" | sed -n 's/.*"StartInterval" => \([0-9]*\).*/\1/p' | head -1)
    if [ -n "$s" ] && [ "$s" -ge 60 ]; then echo "每 $((s/60)) 分钟"; else echo "每 ${s:-?} 秒"; fi
  elif echo "$p" | grep -q '"RunAtLoad" => 1'; then
    echo "常驻 (开机/加载即跑)"
  else
    echo "手动触发"
  fi
}

printf "%s%-24s %-18s %-8s %-8s %s%s\n" "$BLD" "任务" "调度" "PID" "上次退出" "日志/产物" "$RST"
printf '%.0s─' {1..96}; echo

for plist in "$AGENTS_DIR"/*pangu*.plist; do
  [ -f "$plist" ] || continue
  case "$plist" in *.bak*) continue;; esac
  label=$(plutil -extract Label raw "$plist" 2>/dev/null || basename "$plist" .plist)
  sched=$(fmt_schedule "$plist")
  # launchctl list 输出: PID(或-)  退出码  Label
  row=$(launchctl list 2>/dev/null | awk -v L="$label" '$3==L {print $1" "$2}')
  pid=$(echo "$row" | awk '{print $1}'); [ -z "$pid" ] && pid="-"
  exitc=$(echo "$row" | awk '{print $2}'); [ -z "$exitc" ] && exitc="?"
  # 日志路径
  logs=$(plutil -p "$plist" 2>/dev/null | sed -n 's/.*"StandardOutPath" => "\(.*\)"/\1/p' | head -1)
  [ -z "$logs" ] && logs=$(plutil -p "$plist" 2>/dev/null | sed -n 's/.*"StandardErrorPath" => "\(.*\)"/\1/p' | head -1)
  # 颜色: 退出码非 0 红, 常驻在跑绿
  color="$RST"
  if [ "$pid" != "-" ]; then color="$GRN"; elif [ "$exitc" != "0" ] && [ "$exitc" != "?" ]; then color="$RED"; fi
  printf "%s%-24s %-18s %-8s %-8s %s%s\n" "$color" "$label" "$sched" "$pid" "$exitc" "${DIM}${logs:-—}${RST}" "$RST"
done

echo
echo "${BLD}产物目录:${RST}"
echo "  每日自检报告:  ~/pangu_logs/audit_*.md        (每天 04:00 生成)"
echo "  进化数据:      ~/.pangu/evolution/last_audit.json"
echo "  launchd 日志:  ~/Library/Logs/pangu/*.log"
echo
echo "${BLD}常用命令:${RST}"
echo "  pangu-tasks report        打开最近一次自检报告"
echo "  launchctl list | grep pangu"
echo "  tail -f ~/Library/Logs/pangu/com.pangu.daily-audit.out.log"

if [ "${1:-}" = "report" ]; then
  latest=$(ls -t "$HOME/pangu_logs"/audit_*.md 2>/dev/null | head -1)
  if [ -n "$latest" ]; then ${EDITOR:-less} "$latest"; else echo "还没有报告"; fi
fi
