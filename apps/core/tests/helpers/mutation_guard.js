'use strict';
// 变异守卫的**共享实现** —— 101 / 102 两个守卫文件改的是同一批源码, 必须共用一把锁。
//
// ── 为什么要有这把锁 (2026-10-26 当场撞出来的, 不是洁癖) ──────────
//
// 变异体检的做法是「把源码原地改成旧行为 ⇒ 守卫必须报红 ⇒ 再把源码改回来」。
// 101 和 102 两个守卫文件**都改** modules/model_capability.js 和
// modules/llm_capabilities_sync.js, 而 node --test **默认并行跑多个测试文件**,
// 链里也有 `node --test a.js b.js` 这种一次传多个文件的写法。
//
// 两边同时改同一个文件 ⇒ 写入交错 ⇒ A 的 finally 还原的是 B 的变异版 ⇒
// **源码被留在变异状态**。实测后果:
//   · model_capability.js 的软默认门卫 (if (!isSelfHostedByEndpoint(model)) return null;)
//     被删掉还留在工作区 —— 云端端点又吃本地软默认, 而超时走云端口径 ⇒ 两口径。
//   · llm_capabilities_sync.js 的显式 provider 优先被改回规则表硬猜 ⇒ 新厂商又被改判。
//   · 这两处都在**生产代码**里, 而且当时没人知道 (git status 看得到, 但没人会去对)。
//
// 教训写进代码:
//   1. 变异守卫必须**加锁** (跨进程), 不然两个链一起跑就会互相还原错。
//   2. 还原必须**从备份文件还原**, 不能用内存里的 src ——
//      src 可能本身就是别人留下的变异版, 用它还原等于把坏的又写回去。
//   3. 还原之后要**复验** (逐字节比对), 不复验就等于没还原。
//   4. 锁要能识别**陈旧锁** (上次跑崩了留下的), 否则一次崩溃就锁死后面的链。

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// 锁目录: mkdir 是原子的 (POSIX 下 EEXIST 判定), 拿来做互斥最省事。
const LOCK_DIR = path.join(os.tmpdir(), 'pangu-mutation-guard.lock');
// 陈旧锁: 超过这个时间没人动 ⇒ 上一次跑崩了留下的, 可以强行接管。
const LOCK_STALE_MS = 5 * 60 * 1000;

let _held = false;   // 本进程是否已持锁 (可重入: 同一进程里先恢复再变异不算死锁)

function _sleepSync(ms) {
  // Atomics.wait 在主线程也能睡 (Node 22) —— 同步退避, 不必引入 async。
  const sab = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(sab, 0, 0, ms);
}

function _lockAgeMs() {
  try {
    return Date.now() - fs.statSync(LOCK_DIR).mtimeMs;
  } catch (_) {
    return 0;
  }
}

/** 拿锁 (跨进程互斥)。本进程已持锁 ⇒ 直接返回 (可重入)。 */
function acquireLock(waitMs = 300000) {
  if (_held) return;
  const deadline = Date.now() + waitMs;
  for (;;) {
    try {
      fs.mkdirSync(LOCK_DIR);
      // 写一行心跳 (谁在持锁 / 什么时候), 便于事后查
      try {
        fs.writeFileSync(path.join(LOCK_DIR, 'owner'),
          'pid=' + process.pid + ' at=' + new Date().toISOString() + '\n');
      } catch (_) { /* 心跳写不进去不影响锁本身 */ }
      _held = true;
      return;
    } catch (e) {
      if (e && e.code !== 'EEXIST') throw e;
      // 陈旧锁 ⇒ 接管 (上次跑崩了留下的)
      if (_lockAgeMs() > LOCK_STALE_MS) {
        try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch (_) {}
        continue;
      }
      if (Date.now() > deadline) {
        throw new Error('等变异守卫锁超时 (' + waitMs + 'ms) —— 另一个测试链可能正在改源码');
      }
      _sleepSync(120);
    }
  }
}

function releaseLock() {
  if (!_held) return;
  _held = false;
  try { fs.rmSync(LOCK_DIR, { recursive: true, force: true }); } catch (_) {}
}

/** 崩溃恢复: 把上次中断留下的「变异版源码」还原回来。 */
function recoverStaleMutations(dirs, suffix) {
  const list = Array.isArray(dirs) ? dirs : [];
  acquireLock();
  try {
    for (const dir of list) {
      let names = [];
      try { names = fs.readdirSync(dir); } catch (_) { continue; }
      for (const n of names) {
        if (!n.endsWith(suffix)) continue;
        const orig = path.join(dir, n.slice(0, -suffix.length));
        const bak = path.join(dir, n);
        try {
          fs.writeFileSync(orig, fs.readFileSync(bak));
          fs.unlinkSync(bak);
          console.error('[mutation-guard] 恢复了上次中断留下的变异: ' + orig);
        } catch (e) {
          console.error('[mutation-guard] 恢复失败: ' + orig + ' —— ' + e.message);
        }
      }
    }
  } finally {
    releaseLock();
  }
}

/**
 * 变异体检: 把 file 里的 from 换成 to ⇒ 守卫必须报红 ⇒ 还原。
 *
 * opts:
 *   file       相对 apps/core 的源码路径 (如 'modules/model_capability.js')
 *   from       变异锚点 (源码里必须**逐字**存在)
 *   to         改回旧行为后的内容
 *   suffix     备份文件后缀 (同一批源码被多个守卫文件改时, 后缀要不同, 免得互相还原)
 *   runGuard() 跑守卫并返回输出字符串 (返回 null = 全绿 = 守卫没咬)
 */
function mutateAndExpectRed(opts) {
  const { file, from, to, suffix, runGuard } = opts;
  const root = opts.root || path.join(__dirname, '..');
  const p = path.join(root, file);
  const backup = p + suffix;
  const assert = require('node:assert/strict');

  acquireLock();
  try {
    const src = fs.readFileSync(p, 'utf8');
    assert.ok(src.includes(from), '变异锚点没找到 (' + file + ') —— 测试自己失效了');
    const mutated = src.replace(from, to);
    assert.notEqual(mutated, src, '变异没生效 —— 测试自己失效了');
    // 先落盘备份 (抗中断), 再改源码。备份写的是**改之前**的内容。
    fs.writeFileSync(backup, src);
    fs.writeFileSync(p, mutated);
    const out = runGuard();
    assert.ok(out !== null, '守卫在「' + file + ' 被改回旧行为」时**没有报红** ⇒ 守卫是假的');
    assert.match(out, /not ok/, '报红必须是真失败, 不是别的错');
  } finally {
    // ⚠️ 还原必须**从备份文件**还原, 不能用内存里的 src ——
    //    src 可能本身就是别人留下的变异版, 用它还原 = 把坏的又写回去。
    try {
      const good = fs.readFileSync(backup, 'utf8');
      fs.writeFileSync(p, good);
      // 复验: 还原后必须与备份逐字节相同 (不比对 = 没还原)
      const now = fs.readFileSync(p, 'utf8');
      if (now !== good) throw new Error('还原后与备份不一致');
      fs.unlinkSync(backup);
    } catch (e) {
      // 还原失败 ⇒ 备份必须留着 (下一次 recoverStaleMutations 会救回来)
      console.error('[mutation-guard] 还原失败: ' + p + ' —— ' + e.message);
    }
    releaseLock();
  }
}

module.exports = {
  LOCK_DIR,
  acquireLock,
  releaseLock,
  recoverStaleMutations,
  mutateAndExpectRed,
};
