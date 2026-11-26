#!/bin/bash
# scripts/pangu-weixin-install.sh
# 盘古 · 微信通道开机自启 (launchd)
#
# 2026-10-30 第 172 批: 老 openclaw 桌面端退休, 微信通道搬到盘古名下。
#   盘古自己的通道 = apps/core/bin/pangu-weixin-daemon.js (常驻, 长轮询 iLink)
#   账号凭据        = ~/.pangu/weixin/account.json (盘古 owns, 不读 openclaw 目录)
#
# 用法:
#   bash scripts/pangu-weixin-install.sh          # 装 + 起
#   bash scripts/pangu-weixin-install.sh --stop  # 只停
set -euo pipefail

LABEL="local.pangu-weixin"
PLIST="$HOME/Library/LaunchAgents/${LABEL}.plist"
APP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# 兜底也用 $HOME, 不写死任何人的机器名 —— 写死会被开源体检
# (tests/open-source-hygiene-20261026.test.js) 判红, 也会让别人 clone 之后直接坏掉。
NODE_BIN="$(command -v node || echo "${HOME}/.local/bin/node")"
UID_="$(id -u)"

stop_it() {
  launchctl bootout "gui/${UID_}/${LABEL}" 2>/dev/null || true
  echo "[weixin] 已停 ${LABEL}"
}

if [ "${1:-}" = "--stop" ]; then
  stop_it
  exit 0
fi

mkdir -p "$HOME/.pangu/logs" "$HOME/Library/LaunchAgents"

cat > "$PLIST" <<PLIST_EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
	<key>EnvironmentVariables</key>
	<dict>
		<key>PATH</key>
		<string>$HOME/.pangu/runtime/bin:/opt/homebrew/bin:$HOME/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin</string>
		<key>PANGU_HOME</key>
		<string>$HOME/.pangu</string>
	</dict>
	<key>Label</key>
	<string>${LABEL}</string>
	<key>ProgramArguments</key>
	<array>
		<string>${NODE_BIN}</string>
		<string>${APP_DIR}/bin/pangu-weixin-daemon.js</string>
	</array>
	<key>RunAtLoad</key>
	<true/>
	<key>KeepAlive</key>
	<true/>
	<key>ThrottleInterval</key>
	<integer>10</integer>
	<key>StandardErrorPath</key>
	<string>$HOME/.pangu/logs/pangu-weixin.err.log</string>
	<key>StandardOutPath</key>
	<string>$HOME/.pangu/logs/pangu-weixin.out.log</string>
</dict>
</plist>
PLIST_EOF

launchctl bootout "gui/${UID_}/${LABEL}" 2>/dev/null || true
launchctl bootstrap "gui/${UID_}" "$PLIST"
sleep 2

if launchctl list | grep -q "${LABEL}"; then
  echo "[weixin] ${LABEL} 已起 (pid $(launchctl list | awk -v l="${LABEL}" '$3==l{print $1}'))"
else
  echo "[weixin] ${LABEL} 没起来 —— 看 $HOME/.pangu/logs/pangu-weixin.err.log"
  exit 1
fi
