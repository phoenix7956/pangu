#!/bin/bash
# setup_minimax_key.sh — 一次性把 minimax key 存到 credentials.js (chmod 600)
# 用法: bash setup_minimax_key.sh <sk-cp-*** key>
# 之后: export MINIMAX_API_KEY 环境变量可省略, 盘古自动从 credentials 读
set -e
KEY="$1"
if [ -z "$KEY" ]; then
  echo "用法: bash $0 <MINIMAX_API_KEY>" >&2
  exit 1
fi
CRED_FILE="$HOME/.pangu/credentials.json"
mkdir -p "$(dirname "$CRED_FILE")"
if [ ! -f "$CRED_FILE" ]; then
  echo "{}" > "$CRED_FILE"
fi
chmod 600 "$CRED_FILE"
# 用 node 合并 JSON (避免 jq 解析 unicode 报错)
node -e "
const fs = require('fs');
const f = '$CRED_FILE';
const cur = JSON.parse(fs.readFileSync(f, 'utf8'));
cur.MINIMAX_API_KEY = '$KEY';
fs.writeFileSync(f, JSON.stringify(cur, null, 2));
fs.chmodSync(f, 0o600);
console.log('✓ MINIMAX_API_KEY 存到', f, '(chmod 600)');
"
# 验证
node -e "const c = JSON.parse(require('fs').readFileSync('$CRED_FILE','utf8')); console.log('读回:', c.MINIMAX_API_KEY ? 'OK ('+c.MINIMAX_API_KEY.length+' 字符)' : 'MISSING');"