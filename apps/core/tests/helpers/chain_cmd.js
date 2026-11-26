'use strict';
/**
 * tests/helpers/chain_cmd.js —— 「这条链」的唯一读法 (第 180 批)
 *
 * ## 为什么要有这个
 *
 * 2026-10-31 实跑发现的坑:
 *   原来的 `test:chain` 是 `node --test A && node --test B && ...`,
 *   `&&` 的语义是**前一段失败就停**。workbench-original-ui 在第 301 段,
 *   它一挂 ⇒ **后面 27 个测试文件根本没跑**。
 *   而报告里只能看到「not ok 2」, 看不到「有 27 段没执行」——
 *   于是我当场汇报了「只有两个 fail, 其余全绿」, 那句话是**错的**。
 *
 *   「少跑的段」在报告里跟「跑了但没断言」长得一模一样 —— 都是沉默。
 *
 * ## 现在的形状
 *
 *   package.json:
 *     scripts['test:chain']         = 'node scripts/test-chain.mjs'   ← 入口
 *     scripts['test:chain:segments'] = 'node --test A && node --test B && ...'  ← 段落表
 *     scripts['test:chain:env']      = 'PANGU_SESSIONS_DIR=... $$ ...'          ← 隔离环境
 *
 *   runner (scripts/test-chain.mjs) 逐段跑完再汇总, 前一段失败**不拦**后面。
 *
 * ## 守卫为什么该走这里
 *
 * 有三个守卫要问「这条链里有没有 X」/「链有没有带隔离变量」。
 * 它们不该各自去猜 package.json 的哪个键 —— 拆一次改一次, 守卫就得跟着改一次,
 * 漏改一个就变成假绿 (注释≠隔离的同一个坑, 落在测试自己身上)。
 * ⇒ 一律走本文件。
 */

const fs = require('fs');
const path = require('path');

const CORE = path.join(__dirname, '..', '..');

function pkg() {
  return JSON.parse(fs.readFileSync(path.join(CORE, 'package.json'), 'utf8'));
}

/** 整条链的「命令文本」: 隔离环境变量 + 段落表 (人看的那个完整形态)。 */
function chainCommand() {
  const p = pkg();
  const env = p.scripts['test:chain:env'] || '';
  const segs = p.scripts['test:chain:segments'] || '';
  return (env + ' ' + segs).trim();
}

/** 链里用 `node --test <file>` 形式挂着的测试文件。 */
function chainTestFiles() {
  const segs = pkg().scripts['test:chain:segments'] || '';
  return [...segs.matchAll(/node --test ([^\s&|]+)/g)]
    .map((m) => m[1].replace(/^['"]|['"]$/g, ''))
    .filter(Boolean);
}

/** 链的段落 (拆成一条条可单独执行的命令)。 */
function chainSegments() {
  const segs = pkg().scripts['test:chain:segments'] || '';
  return segs.split('&&').map((s) => s.trim()).filter(Boolean);
}

module.exports = { CORE, pkg, chainCommand, chainTestFiles, chainSegments };

