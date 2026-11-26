#!/bin/bash
# scripts/setup_credential.sh — 把一把 API key 存进凭证库 (~/.pangu/credentials.json)
#
# 用法:
#   bash setup_credential.sh MINIMAX_API_KEY sk-cp-xxxx
#   bash setup_credential.sh MINIMAX_API_KEY --from-env MINIMAX_API_KEY
#   cat key.txt | bash setup_credential.sh MINIMAX_API_KEY --stdin
#
# 为什么有 --from-env / --stdin:
#   `bash setup.sh NAME sk-cp-xxx` 会让这把 key 出现在 **进程列表**里
#   (ps aux 一眼可见, 同一台机器上的别的用户也看得见)。
#   密钥不该经过命令行 —— 用 --from-env / --stdin 绕开。
#
# 存哪: ~/.pangu/credentials.json (chmod 600, 只有 owner 能读)
#   盘古的取 key 链会自动按厂商名约定找它 (见 modules/api_key_resolver.js):
#     provider=minimax ⇒ MINIMAX_API_KEY
#     provider=kimi    ⇒ KIMI_API_KEY
#     provider=openai  ⇒ OPENAI_API_KEY
#   厂商名对不上约定时, 在模型条目里显式写 api_key_credential: "<条目名>"。

set -e

NAME="$1"
SOURCE="$2"
VALUE=""

if [ -z "$NAME" ]; then
  echo "用法: bash $0 <CREDENTIAL_NAME> <value>|--from-env <ENV_NAME>|--stdin" >&2
  exit 1
fi

# 凭证名只允许 [A-Z0-9_] —— 它会变成 JSON 键, 也是环境变量名的一部分
if ! echo "$NAME" | grep -Eq '^[A-Z][A-Z0-9_]*$'; then
  echo "凭证名不合法: '$NAME' —— 只允许大写字母/数字/下划线, 且以字母开头" >&2
  exit 1
fi

case "$SOURCE" in
  --stdin)
    VALUE="$(cat)"
    ;;
  --from-env)
    ENV_NAME="${3:-}"
    if [ -z "$ENV_NAME" ]; then
      echo "用法: bash $0 $NAME --from-env <ENV_NAME>" >&2
      exit 1
    fi
    VALUE="$(printenv "$ENV_NAME" || true)"
    ;;
  "")
    echo "用法: bash $0 $NAME <value>|--from-env <ENV_NAME>|--stdin" >&2
    exit 1
    ;;
  *)
    VALUE="$SOURCE"
    ;;
esac

if [ -z "$VALUE" ]; then
  echo "没拿到值 —— 密钥是空的, 不写。" >&2
  exit 1
fi

CRED_FILE="$HOME/.pangu/credentials.json"
mkdir -p "$(dirname "$CRED_FILE")"
chmod 700 "$(dirname "$CRED_FILE")"
if [ ! -f "$CRED_FILE" ]; then
  echo "{}" > "$CRED_FILE"
fi
chmod 600 "$CRED_FILE"

# 用 node 合并 JSON (避免 jq 解析 unicode 报错; 值走 argv 不经过 shell 展开)
node -e "
const fs = require('fs');
const f = process.argv[1];
const name = process.argv[2];
const value = process.argv[3];
let cur = {};
try { cur = JSON.parse(fs.readFileSync(f, 'utf8')); } catch (e) { cur = {}; }
const prev = cur[name];
cur[name] = Object.assign({}, prev && typeof prev === 'object' ? prev : {}, {
  value,
  enabled: true,
  updatedAt: new Date().toISOString(),
  createdAt: (prev && prev.createdAt) || new Date().toISOString(),
});
fs.writeFileSync(f, JSON.stringify(cur, null, 2));
fs.chmodSync(f, 0o600);
console.log('✓ ' + name + ' 存到 ' + f + ' (chmod 600, ' + value.length + ' 字符)');
" "$CRED_FILE" "$NAME" "$VALUE"

# 验证: 读回来确认非空 (不打印内容)
node -e "
const c = JSON.parse(require('fs').readFileSync(process.argv[1], 'utf8'));
const v = c[process.argv[2]];
console.log('读回:', v && v.value ? 'OK (' + v.value.length + ' 字符)' : 'MISSING');
" "$CRED_FILE" "$NAME"
