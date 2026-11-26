'use strict';
/**
 * scripts/pangu-weixin-bind.js
 * 盘古 · 把已绑好的微信账号搬进盘古自己的目录
 *
 * 背景 (2026-10-30): 微信 bot 账号 `308231fa95df-im-bot` 是在老 openclaw 桌面端里
 * 扫码绑定的, 凭据落在 ~/.openclaw/openclaw-weixin/accounts/。
 * 老板要「盘古接微信」, 而老桌面端要退休 ⇒ 凭据得**复制**一份到盘古名下,
 * 不能让盘古一直去读老桌面端的目录 (它随时可能整个被删)。
 *
 * 用法:
 *   node apps/core/scripts/pangu-weixin-bind.js            # 从 openclaw 搬过来
 *   node apps/core/scripts/pangu-weixin-bind.js --show      # 只看状态
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

const channel = require('../modules/weixin_channel');

const OPENCLAW_ACCOUNTS = path.join(os.homedir(), '.openclaw', 'openclaw-weixin', 'accounts');

function _readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { return fallback; }
}

function findOpenClawAccount() {
  let files = [];
  try { files = fs.readdirSync(OPENCLAW_ACCOUNTS); } catch (_) { return null; }
  for (const f of files) {
    if (!f.endsWith('.json')) continue;
    if (f.includes('context-tokens') || f.includes('sync')) continue;
    const acc = _readJson(path.join(OPENCLAW_ACCOUNTS, f), null);
    if (acc && acc.token) {
      return {
        accountId: f.replace(/\.json$/, ''),
        token: acc.token,
        baseUrl: acc.baseUrl || channel.DEFAULT_BASE_URL,
        userId: acc.userId || '',
      };
    }
  }
  return null;
}

function main() {
  if (process.argv.includes('--show')) {
    console.log(JSON.stringify(channel.status(), null, 2));
    return;
  }
  const src = findOpenClawAccount();
  if (!src) {
    console.error('[weixin] 在 ' + OPENCLAW_ACCOUNTS + ' 里没找到已绑账号 —— '
      + '要么手动把 {token,baseUrl,userId} 写进 ' + channel.configDir() + '/account.json');
    process.exit(1);
  }
  channel.saveAccount(src);

  // 会话 token 一并搬过来 (老会话的回复还得靠它才发得出去)
  const tokensFile = path.join(OPENCLAW_ACCOUNTS, src.accountId + '.context-tokens.json');
  const tokens = _readJson(tokensFile, {});
  let moved = 0;
  for (const [userId, token] of Object.entries(tokens || {})) {
    channel.saveContextToken(userId, token);
    moved += 1;
  }
  console.log('[weixin] 已绑定到盘古: account=' + src.accountId
    + ' user=' + src.userId + ' 会话token=' + moved
    + ' → ' + channel.configDir());
}

main();
