'use strict';
// 2026-10-13 守护进程把长工作杀掉 —— 「移植/盘古做不了长工作」的第四个真凶
//
// 线上现场 (resume-live-1791861754, 第一轮跑了 1077.8s = 18 分钟):
//   ~/.pangu/logs/self-monitor.log
//     [2026-10-13 11:40:32] HTTP FAIL 000000, force restart...
//     [2026-10-13 11:40:46] force restarted, new PID=90300
//   /tmp/pangu-single.log
//     [safe-guard] SIGTERM received, exiting gracefully
//   → 探针第二轮直接 Connection refused; 父会话 resume-live-1791861754.json
//     根本没落盘 (只有 sub-0/sub-1 两个子会话文件), 所以「上一轮」一片空白。
//
// 根因 (apps/core/scripts/guardian.sh):
//   1) 探活 `--max-time 5` —— 盘古跑长轮次时事件循环本来就会被堵。
//      我在同一轮跑动期间实测 /health: 37 次采样 0 失败, 但 10 次 >1s, 最慢 2.04s。
//      5s 的探活窗口 + 重载时的 GC/落盘尖峰 = 长任务必然被误判成「死了」。
//   2) **单次**失败就 `kill -9` —— 没有重试, 没有连续失败计数。
//   3) 只用 kill -9, 盘古的 SIGTERM asyncCleanup (父会话落盘那条路) 一次机会都没有。
//
// 修法: 超时放宽到 25s (可注入) + 连续失败 2 次才重启 + 先 SIGTERM 给 8 秒优雅退出。
// 另外把 PID 源/探活 URL/日志/进程特征全部改成可注入, 否则本测试会 kill 到真的盘古。
const test = require('node:test');
const assert = require('node:assert/strict');

const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const GUARDIAN = path.join(__dirname, '..', 'scripts', 'guardian.sh');

// 起一个行为可编程的探活端点
function startHealthServer(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer(handler);
    srv.listen(0, '127.0.0.1', () => resolve({ srv, port: srv.address().port }));
  });
}

// 一个假盘古进程: argv 里带唯一 marker, 让 pgrep -f 能找到它; 收到 SIGTERM 就落一个文件
function startFakePangu(marker, tmp) {
  const flag = path.join(tmp, 'sigterm-seen');
  const child = spawn(process.execPath, [
    '-e',
    "process.on('SIGTERM',()=>{require('fs').writeFileSync(" + JSON.stringify(flag) + ",'1');process.exit(0)});setTimeout(()=>{},600000)",
    marker,
  ], { stdio: 'ignore' });
  return { child, flag };
}

// 必须异步: 用 spawnSync 会把本进程的 event loop 堵死, 同进程的健康服务端
// 根本没法 accept 连接, curl 只会拿到 000000 —— 那是测试自己造的假现场。
function tick(env) {
  return new Promise((resolve) => {
    const child = spawn('bash', [GUARDIAN], { env: { ...process.env, ...env }, stdio: 'ignore' });
    const timer = setTimeout(() => child.kill('SIGKILL'), 60000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ status: code }); });
  });
}

function fixture(t, srvPort, marker) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-lw-'));
  // direct_start 会 `cd $PANGU_HOME && nohup node pangu-single.js`, 放个假的进去,
  // 它写 marker 文件 = 「重启真的发生了」
  fs.writeFileSync(path.join(tmp, 'pangu-single.js'),
    "require('fs').writeFileSync(process.env.GUARDIAN_RESTART_MARKER || '/tmp/nope','1');process.exit(0);\n");
  return {
    tmp,
    env: {
      GUARDIAN_RESTART_MARKER: path.join(tmp, 'restarted'),
      PANGU_LOG_FILE: path.join(tmp, 'guardian.log'),
      PANGU_HEALTH_URL: `http://127.0.0.1:${srvPort}/health`,
      PANGU_PID_FILE: path.join(tmp, 'pangu.pid'),
      PANGU_HEALTH_FAIL_STATE: path.join(tmp, 'health_fail'),
      PANGU_HEALTH_BODY_FILE: path.join(tmp, 'health_body'),
      // 这两个是关键: 指向不存在的 launchd 标签和不存在的进程特征,
      // 保证脚本既不会查到真的盘古, 也不会去 kickstart 真的 launchd 作业
      PANGU_LABEL: `guardian-fixture-no-such-label-${marker}`,
      PANGU_PROC_PATTERN: `guardian-fixture-proc-${marker}`,
      PANGU_PLIST_PATH: path.join(tmp, 'nonexistent.plist'),
      PANGU_HOME: tmp,
    },
    restarted: () => fs.existsSync(path.join(tmp, 'restarted')),
    failState: () => {
      const p = path.join(tmp, 'health_fail');
      return fs.existsSync(p) ? fs.readFileSync(p, 'utf8').trim() : null;
    },
    log: () => fs.readFileSync(path.join(tmp, 'guardian.log'), 'utf8'),
  };
}

test('探活慢 7 秒但最终 200 = 一切正常, 绝不能重启 (现场就是被这个杀掉的)', async (t) => {
  const marker = 'slow' + Date.now();
  const { srv, port } = await startHealthServer((req, res) => {
    setTimeout(() => { res.writeHead(200); res.end('{"ok":true}'); }, 7000);
  });
  const fake = startFakePangu('guardian-fixture-proc-' + marker, os.tmpdir());
  const fx = fixture(t, port, marker);
  t.after(() => { srv.close(); fake.child.kill('SIGKILL'); });

  const r = await tick(fx.env);

  assert.equal(r.status, 0, 'guardian 应正常退出');
  assert.equal(fx.restarted(), false, '慢响应不等于死了 —— 5s 探活窗口会误杀长轮次, 这是本次的真凶');
  assert.match(fx.log(), /OK http=200/);
});

test('连续失败到阈值才重启: 第一次失败放过, 第二次才动手', async (t) => {
  const marker = 'thresh' + Date.now();
  const { srv, port } = await startHealthServer((req, res) => { res.writeHead(500); res.end('boom'); });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-thr-'));
  const fake = startFakePangu('guardian-fixture-proc-' + marker, tmp);
  const fx = fixture(t, port, marker);
  t.after(() => { srv.close(); fake.child.kill('SIGKILL'); });

  await tick(fx.env);
  assert.equal(fx.restarted(), false, '单次探活失败不得重启 (长轮次里 event loop 抖动是常态)');
  assert.equal(fx.failState(), '1', '失败计数要落盘, 跨 tick 累计');

  await tick(fx.env);
  assert.equal(fx.restarted(), true, '连续两次失败才算死, 必须重启');
  assert.equal(fx.failState(), null, '重启后失败计数要清零');
});

test('偶发失败后恢复 = 永不重启, 且计数清零', async (t) => {
  const marker = 'flap' + Date.now();
  let hits = 0;
  const { srv, port } = await startHealthServer((req, res) => {
    hits += 1;
    if (hits === 2) { res.writeHead(503); res.end('blip'); return; }   // 只抖这一次
    res.writeHead(200); res.end('{"ok":true}');
  });
  const fake = startFakePangu('guardian-fixture-proc-' + marker, os.tmpdir());
  const fx = fixture(t, port, marker);
  t.after(() => { srv.close(); fake.child.kill('SIGKILL'); });

  await tick(fx.env);     // ok
  await tick(fx.env);     // 503 → 记 1
  assert.equal(fx.failState(), '1');
  await tick(fx.env);     // ok → 必须清零
  await tick(fx.env);     // ok

  assert.equal(fx.restarted(), false, '抖动一次就重启 = 盘古反复重启, 长工作必碎');
  assert.equal(fx.failState(), null, '恢复后失败计数必须清零, 否则下一次单点抖动就会被当成第二次');
});

test('真的要重启时走 SIGTERM, 让盘古的 asyncCleanup 有机会落盘', async (t) => {
  const marker = 'term' + Date.now();
  const { srv, port } = await startHealthServer((req, res) => { res.writeHead(500); res.end('dead'); });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'guardian-term-'));
  const fake = startFakePangu('guardian-fixture-proc-' + marker, tmp);
  const fx = fixture(t, port, marker);
  t.after(() => { srv.close(); fake.child.kill('SIGKILL'); });

  await tick(fx.env);
  await tick(fx.env);

  assert.equal(fx.restarted(), true, '连续失败应该重启');
  assert.equal(fs.existsSync(fake.flag), true,
    '必须先 SIGTERM 让进程自己收尾 (父会话落盘走的就是这条 asyncCleanup), 不能上来就 kill -9');
  assert.match(fx.log(), /SIGTERM 优雅退出成功/);
});
