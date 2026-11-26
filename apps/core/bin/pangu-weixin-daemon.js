'use strict';
/**
 * bin/pangu-weixin-daemon.js
 * 盘古 · 微信通道守护进程
 *
 * 单跑一个进程: 长轮询微信 → 交给盘古 agent → 回微信。
 * 独立于 pangu-single.js (HTTP 服务), 这样微信通道挂了不会带崩网页版,
 * 反过来也一样。
 *
 * 启动:
 *   node apps/core/bin/pangu-weixin-daemon.js
 * 状态:
 *   node apps/core/bin/pangu-weixin-daemon.js --status
 */

const channel = require('../modules/weixin_channel');
const bridge = require('../modules/weixin_bridge');

function printStatus() {
  const s = channel.status();
  console.log(JSON.stringify(s, null, 2));
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--status')) {
    printStatus();
    return;
  }

  const s = channel.status();
  if (!s.configured) {
    console.error('[weixin] 没绑账号 —— 先跑 scripts/pangu-weixin-bind.js 把凭据写进 '
      + s.dir + '/account.json');
    process.exit(1);
  }

  console.log('[weixin] 盘古微信通道启动 · account=' + s.accountId + ' dir=' + s.dir);
  const poller = bridge.start();

  const shutdown = (sig) => {
    console.log('[weixin] 收到 ' + sig + ', 收尾退出');
    poller.stop();
    setTimeout(() => process.exit(0), 200);
  };
  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  await poller.promise;
}

main().catch((e) => {
  console.error('[weixin] 守护进程起不来: ' + (e && e.stack ? e.stack : e));
  process.exit(1);
});
