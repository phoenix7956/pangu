#!/usr/bin/env bash
# 集群健康检查 —— 从 openclaw 接收而来 (2026-10-30 第 173 批)
#
# 来源: ~/.openclaw/scripts/ssh-cluster-healthcheck.sh (2026-07-05 立, 老板拍)
# 接收时改了一处关键的:
#   旧版查 `ceo_openclaw_18789` (本机 openclaw gateway) —— 那玩意儿 2026-10-30 12:16
#   已经 SIGTERM 干净停掉, 检查项必然 FAIL (实测 10 ok / 2 warn / 1 fail, 那个 fail
#   就是它) ⇒ **恒失败的检查项 = 每小时一次的假警报** (踩坑日志 171 批同款病)。
#   改成查盘古自己的两条命脉: pangu-single :18901 + 微信通道守护进程/sync 心跳。
#   .120 (CFO) 那边的 openclaw :18789 **照查** —— 那是另一台机器, 不归我们退休。
#
# 退出码契约 (跟旧版一致, 别改):
#   0 = 全 ok
#   2 = 有 warn 但不致命 (cto 离线 / pn53 离线 / cfo_pangu 端口空 等)
#   1 = 有 critical 失败

set +e  # 不让个别 fail 阻塞整体
TS=$(date +%Y-%m-%d_%H:%M:%S)
PANGU_HOME="${PANGU_HOME:-$HOME/.pangu}"

ok_count=0
fail_count=0
warn_count=0
results_text=""
overall="ok"

check() {
  local name="$1"
  local cmd="$2"
  local critical="$3"  # "critical" | "warn"
  local out
  out=$(eval "$cmd" 2>&1)
  local rc=$?
  if [ $rc -eq 0 ] && [ -n "$out" ]; then
    results_text+="$(printf '  %-26s %s' "$name" '✅ ok')\n"
    results_text+="$(printf '    └─ %s\n' "$out" | head -1)\n"
    ok_count=$((ok_count+1))
    return 0
  else
    if [ "$critical" = "critical" ]; then
      results_text+="$(printf '  %-26s %s' "$name" '❌ FAIL')\n"
      results_text+="$(printf '    └─ %s\n' "$out" | head -1)\n"
      fail_count=$((fail_count+1))
      overall="degraded"
    else
      results_text+="$(printf '  %-26s %s' "$name" '⚠️ warn')\n"
      results_text+="$(printf '    └─ %s\n' "$out" | head -1)\n"
      warn_count=$((warn_count+1))
    fi
    return 1
  fi
}

echo "=========================================="
echo "集群健康检查 (盘古接管版) — $TS"
echo "=========================================="
echo ""

# === A. SSH 双向 .88 ⇄ .120 ===
echo "[A] SSH 双向通道"
check "ssh_mo_to_cfo" \
  'ssh -o ConnectTimeout=5 -o BatchMode=yes cfo-120 "echo OK_\$(hostname)_\$(date +%s)" 2>&1' \
  "critical"

check "ssh_cfo_to_mo" \
  'ssh cfo-120 "ssh -o ConnectTimeout=5 -o BatchMode=yes mo-88 \"echo OK_\$(hostname)_\$(date +%s)\"" 2>&1' \
  "critical"

# === B. CFO (.120) 业务存活 ===
echo ""
echo "[B] CFO (.120) 业务"
check "cfo_openclaw_18789" \
  'ssh cfo-120 "curl -sS -m 3 http://127.0.0.1:18789/health 2>&1"' \
  "critical"

check "cfo_pangu_18903" \
  'ssh cfo-120 "curl -sS -m 3 http://127.0.0.1:18903/health 2>&1"' \
  "warn"

check "cfo_mission_control" \
  'ssh cfo-120 "curl -sS -m 3 http://127.0.0.1:7891/api/agents 2>&1 | head -c 20"' \
  "warn"

# === C. CEO (.88) 主控 — 盘古接管后查盘古, 不再查已退休的 openclaw gateway ===
echo ""
echo "[C] CEO (.88) 主控 (盘古)"
check "ceo_pangu_18901" \
  'curl -sS -m 3 http://127.0.0.1:18901/health 2>&1' \
  "critical"

# 微信通道: 守护进程在 + 长轮询心跳新鲜 (sync.json 约 18s 刷一次, 超过 180s 视为卡死)
check "ceo_weixin_daemon" \
  "pgrep -f pangu-weixin-daemon.js >/dev/null && echo 'daemon alive pid='\$(pgrep -f pangu-weixin-daemon.js | head -1)" \
  "critical"

check "ceo_weixin_sync" \
  "python3 -c \"
import json,time,sys,datetime
p='$PANGU_HOME/weixin/sync.json'
d=json.load(open(p))
ts=d['updatedAt'].replace('Z','')
dt=datetime.datetime.fromisoformat(ts)
if dt.tzinfo is None:
    dt=dt.replace(tzinfo=datetime.timezone.utc)
age=time.time()-dt.timestamp()
if age>180: print('stale %.0fs'%age); sys.exit(1)
print('fresh %.0fs ago, buf=%d'%(age,len(d.get('get_updates_buf',''))))
\"" \
  "warn"

# === D. 5 节点 ping ===
echo ""
echo "[D] 5 节点 ping (legacy 节点 fail 不致命)"
for ip in 192.168.0.88 192.168.0.120 192.168.0.183 192.168.0.192 192.168.0.235; do
  if ping -c 1 -W 2 "$ip" >/dev/null 2>&1; then
    name=$(echo "$ip" | sed -E 's|.*\.([0-9]+)$|ip_\1|; s|ip_88|ceo|; s|ip_120|cfo|; s|ip_183|pn53|; s|ip_192|hub|; s|ip_235|nas|')
    results_text+="$(printf '  %-26s %s' "ping_$name" "✅ ok ($ip)")\n"
    ok_count=$((ok_count+1))
  else
    name=$(echo "$ip" | sed -E 's|.*\.([0-9]+)$|ip_\1|; s|ip_88|ceo|; s|ip_120|cfo|; s|ip_183|pn53|; s|ip_192|hub|; s|ip_235|nas|')
    if [ "$name" = "ceo" ] || [ "$name" = "cfo" ]; then
      results_text+="$(printf '  %-26s %s' "ping_$name" "❌ FAIL ($ip)")\n"
      fail_count=$((fail_count+1))
      overall="degraded"
    else
      results_text+="$(printf '  %-26s %s' "ping_$name" "⚠️ 离线 (legacy)")\n"
      warn_count=$((warn_count+1))
    fi
  fi
done

# === E. CTO .244 状态 (老板关电源, 期望离线) ===
echo ""
echo "[E] CTO .244 (老板 7/5 关电源,期望离线)"
if ping -c 1 -W 2 192.168.0.244 >/dev/null 2>&1; then
  results_text+="$(printf '  %-26s %s' "cto_244" "⚠️ 居然 reachable,可能被远程开机")\n"
  warn_count=$((warn_count+1))
  overall="warn"
else
  results_text+="$(printf '  %-26s %s' "cto_244" "✅ 离线(符合预期)")\n"
  ok_count=$((ok_count+1))
fi

echo ""
echo "=========================================="
echo -e "$results_text"
echo "=========================================="
echo "汇总: ✅ $ok_count ok | ⚠️ $warn_count warn | ❌ $fail_count fail"
echo "Overall: $overall"
echo "=========================================="

case $overall in
  ok) exit 0 ;;
  warn) exit 2 ;;
  *) exit 1 ;;
esac

