/**
 * tests/helpers/provenance_mutate.js
 *
 * 出处层的负例都要「复制一棵 64i 树 → 改一处 → 重新 require」。
 * 这件事看着一行就够, 但有三个坑, 三个都踩过, 所以收成一处:
 *
 * ① **临时树必须长成 `<tmp>/64i/` + `<tmp>/modules`**
 *    守卫 P12 从 `64i/../modules/gua_block.js` 找生产层文件。
 *    只复制 64i 的话它读不到 ⇒ P12 误报一片红 ⇒ **真负例被噪声淹掉**
 *    (第 45 批: 16 项里第 13 项红了, 报的却是「渲染点读不到」)。
 *
 * ② **变异必须真的生效**
 *    负例靠字符串替换改源码。锚点一旦跟源码脱节(散文被改写、格式变了),
 *    替换静默不生效 ⇒ 那条负例变成**假绿**, 比没有这条负例更坏。
 *    (第 45 批: 把 reason 从两段扩成五段, 旧正则就匹配不上了。)
 *    所以跑完 mutator 必须比对整棵树的指纹, 没变就当场报红。
 *    ⚠️ 比**整棵树**而不是只比 provenance.js —— 有的负例改的是 sources/*.txt
 *    (改引文/删切片), 有的是新增 64i 模块文件, 只比一个文件会误伤正常负例。
 *
 * ③ 删 require 缓存的键要用**根目录**前缀。
 *    只按 64i 子目录清缓存, 共享的 modules 缓存不干净 ⇒ 拿到旧模块。
 *
 * ⚠️ 一份东西抄四遍 = 迟早只改其中一份 —— 所以收在这里, 四个测试文件共用。
 */

'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('node:assert/strict');

function copyTree(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    if (e.name === 'node_modules') continue;
    const s = path.join(src, e.name);
    const d = path.join(dst, e.name);
    if (e.isDirectory()) copyTree(s, d);
    else fs.copyFileSync(s, d);
  }
  return dst;
}

const crypto = require('crypto');

/**
 * 整棵 64i 树的指纹: 相对路径 + 文件内容哈希。用来判断变异到底有没有动。
 *
 * ⚠️ 必须用**哈希**, 不能只用文件长度 —— 长度会骗人:
 *   把台账里的 `identical: 197` 改成 `384`、`diff: 7` 改成 `0`、 yinMismatch 同理,
 *   改完长度**一模一样** ⇒ 只比长度的指纹报告「没变」⇒ 负例假绿。
 *   (第 45 批真踩到: 下游台账钉子的负例就是这么被我自己写的弱指纹遮住的。)
 */
function fingerprint(dir) {
  const out = [];
  const walk = (d, rel) => {
    const entries = fs.readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1));
    for (const e of entries) {
      const r = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) walk(path.join(d, e.name), r);
      else {
        const buf = fs.readFileSync(path.join(d, e.name));
        out.push(r + ':' + crypto.createHash('sha1').update(buf).digest('hex'));
      }
    }
  };
  walk(dir, '');
  return out.join('\n');
}

/**
 * 造一棵「坏树」并重新 require 它的 provenance.js。
 *
 * @param {string} coreRoot  apps/core 目录
 * @param {string} tag       临时目录前缀, 便于辨认
 * @param {(tmp:string)=>void} mutator  在临时 64i 上改一处
 * @returns {object} 新树的 provenance 模块
 */
function mutateProvenance(coreRoot, tag, mutator) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-prov-' + tag + '-'));
  const tmp = copyTree(path.join(coreRoot, '64i'), path.join(root, '64i'));
  // ① 让 P12 找得到生产层
  try {
    fs.symlinkSync(path.join(coreRoot, 'modules'), path.join(root, 'modules'), 'dir');
  } catch (_) {
    /* 软链失败 ⇒ P12 读不到生产层, 相关检查会误报 —— 但不该让整条负例崩掉 */
  }
  const before = fingerprint(tmp);
  mutator(tmp);
  // ② 变异必须真的动了
  assert.notEqual(fingerprint(tmp), before,
    '变异没生效 —— 替换锚点跟当前源码对不上, 这条负例已经是假绿(锚点该改成结构性的)');
  // ③ 按根目录清缓存
  //
  // ⚠️ 2026-10-26: `k.startsWith(root)` 在 macOS 上**永远不成立** ——
  //   os.tmpdir() 给的是 `/var/folders/…`, 而 `/var` 是 `/private/var` 的软链,
  //   Node 的 require 用 realpath 做 key ⇒ 缓存里的 key 全是 `/private/var/…`。
  //   于是这段清理**一行都没删掉**, 同一棵树第二次 require 拿回的是**旧模块** ——
  //   也就是"变异改了文件, 但被测的还是没变的那份" ⇒ 负例静默变成假绿。
  //   (今天实测: 复用同一棵 tmp 树二次 require, dir 字段改了也读不到新值。)
  //   现在按 realpath 比, 两边对得上。
  for (const k of Object.keys(require.cache)) {
    if (k.startsWith(root) || k.startsWith(fs.realpathSync(root))) delete require.cache[k];
  }
  return require(path.join(tmp, 'provenance.js'));
}

module.exports = { copyTree, fingerprint, mutateProvenance };
