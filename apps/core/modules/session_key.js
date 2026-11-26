'use strict';
/**
 * apps/core/modules/session_key.js
 * 盘古 · session id → 落盘文件名的**唯一真源**
 *
 * ## 为什么要有这个模块 (第 92 批)
 *
 * 原来有**十一份**自己抄的清洗, 各自写一份:
 *   budget / task_checkpoint / plan_state / goal / checkpoint / compaction
 *   / handoff / outcome_tracker / peer_message / task_ledger / session_store
 * 规则**不完全一样** (有的留 '-' 有的留 '.' 有的截 80 有的截 60 有的不截),
 * goal.js 还多一道正则 —— 同一个 sid 在不同账里落到不同文件名。
 *
 * ## 现场 (2026-10-25, 实跑不是推理)
 *
 * 病一 · 不同 session 互相覆盖:
 *   sid='!!!' → 清洗成 '___' → 落 ___ .json
 *   sid='@@@' → 清洗成 '___' → **也**落 ___ .json
 *
 * 病二 · goal.js 塌成 'default', 跟真 default 会话串味 (**更严重**):
 *   goal.js 那道正则要求清洗结果里必须含至少一个字母数字, 不满足就整条塌成
 *   'default'。而 'default' 本身是个**真实存在的 session id**。
 *   实跑 (PANGU_HOME 指到临时目录):
 *     setGoal('default', '目标A: 真 default 会话的目标')
 *     setGoal('!!!',    '目标B: 非法 id 会话的目标')
 *   之后 getGoal('default') 读出来的是 **'目标B'** —— A 会话的目标被 B 会话顶掉了。
 *   goal 会被注入 system 消息 ⇒ **这不只是账目串味, 是给主人看了别人的目标**。
 *
 * ## 修法: **纯清洗 + 真撞名才用指纹**
 *
 * 1) 默认**纯清洗** ⇒ **存量零改名**。
 *    实测 (14530 个存量文件, 逐字复现):
 *      budget 1371 / tasks 1359 / plans 403 / goals 20 / handoff 191
 *      / ledger 9467 / sessions 741 / outcomes 774 / peer 7
 *      —— 全部按纯清洗规则复现, 不一致 **0**。
 *    ⇒ 一万八千多个历史账本一个都不改名, 全部继续可达。
 *
 * 2) 只有**真的撞了**才换指纹名 (clean + '-' + sha1(原 id) 前 8 位)。
 *    「真的撞了」的判据是**盘上的事实**: 目标文件里写的 session_id 不是我的。
 *    —— 不是推测, 是把文件读出来看过的。
 *
 * ⚠️ 为什么不是「一律加指纹」
 *   一律加指纹 ⇒ 全部存量文件改名 ⇒ 盘古读不到自己的历史
 *   (goal 读不到、checkpoint 续不了、budget 归零)。
 *   实测过那样改的后果: 18053 个文件里 **9391 个按新名指不到**
 *   ⇒ 断点续跑直接失效。所以那条路否掉了, 走「零改名 + 真撞名兜底」。
 *
 * ## 三条铁律
 *   - 谁占了纯清洗名, 以**盘上文件自己写的 session_id** 为准 ⇒ 不靠命名约定猜。
 *   - 目标文件确实属于别人时, 才换指纹名另起一份 ⇒ **不覆盖别人的账**。
 *   - 读和写走**同一个** resolve 函数 ⇒ 读到的和写进去的永远是同一个文件。
 *
 * ⚠️ 踩过的坑 (2026-10-25, 实跑才暴露):
 *   曾经以为「id 干净 ⇒ 文件名 == id ⇒ 不可能撞」, 于是给干净 id 走了捷径。
 *   实测反例: 干净的 'parent_sub-0-li' 跟脏的 'parent#sub-0-li'
 *   **清洗后同名** ⇒ 后写的那个把前写的覆盖了。
 *   ⇒ 捷径被删掉: 干净 id 也必须看盘上文件的归属。
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// 落盘文件名的合法字符集 (跟原实现一致, 不改存量命名规则)
const _ILLEGAL = /[^A-Za-z0-9_-]/g;

// 读文件头多少字节去找 session_id。
// 实测: tasks 里 session_id 出现的最大字节偏移 = 915, 其余目录都在前 100 字节内 ⇒ 8K 够。
const _PROBE_BYTES = 8192;

/**
 * 清洗规则: 非法字符换 '_', 截到 maxLen。
 * 各模块原来的截断长度**不一样** (budget/task/plan/goal/peer 是 80,
 * compaction 是 60), 所以 maxLen 可传 —— **不是**统一成一个数。
 * 理由: 改截断长度会改文件名 ⇒ 存量快照读不到 (listSnapshots 按前缀匹配)。
 * 真实账本里最长的文件名 48 字符, 两档都不碰存量; 但语义保持原样更稳。
 */
function _clean(raw, maxLen) {
  return String(raw).replace(_ILLEGAL, '_').slice(0, maxLen);
}

// 原 id 的指纹 —— 只在「真的撞名」时才用
function _fingerprint(raw) {
  return crypto.createHash('sha1').update(String(raw), 'utf8').digest('hex').slice(0, 8);
}

// 空 / undefined / null ⇒ 'default' (跟旧实现一致, 不动存量 default.json)
function _effective(sid) {
  if (sid === undefined || sid === null || sid === '') return 'default';
  return String(sid);
}

/**
 * session id → 落盘文件名主干 (不含 .json) —— **纯清洗, 零改名**
 *
 * @param {*} sid  session id (字符串 / undefined / null 都收)
 * @param {number} [maxLen=80] 清洗后截断长度 (保持各模块原值)
 * @returns {string} 文件名主干
 */
function sessionKey(sid, maxLen) {
  const _max = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : 80;
  return _clean(_effective(sid), _max) || 'default';
}

/**
 * 指纹名: 纯清洗 + '-' + sha1(原 id) 前 8 位。
 * 只在**真撞名**时用 (见 resolveSessionKey)。
 */
function fingerprintKey(sid, maxLen) {
  const _max = Number.isFinite(maxLen) && maxLen > 0 ? Math.floor(maxLen) : 80;
  return _clean(_effective(sid), _max) + '-' + _fingerprint(_effective(sid));
}

/**
 * 这个 sid 可能对应的文件名主干 —— 按优先级排:
 *   [纯清洗名, 指纹名]
 * 纯清洗名永远是第一个 (存量都在它下面); 指纹名是兜底
 * (第 92 批中途那版规则写出来的少数文件 + 将来真撞名时的落点)。
 */
function sessionKeyCandidates(sid, maxLen) {
  const plain = sessionKey(sid, maxLen);
  const fp = fingerprintKey(sid, maxLen);
  return fp === plain ? [plain] : [plain, fp];
}

/**
 * 从文件头里读出它自己的 session id —— 读不到就返回 null。
 *
 * 这是「这个文件到底是谁的」的**唯一依据**: 不靠推测, 不靠命名约定,
 * 直接看文件自己写的 session_id / sessionId。
 * 兼容 .json (顶层字段) 和 .jsonl (第一条记录)。
 */
function probeSessionId(file) {
  let fd = null;
  try {
    fd = fs.openSync(file, 'r');
    const buf = Buffer.alloc(_PROBE_BYTES);
    const n = fs.readSync(fd, buf, 0, _PROBE_BYTES, 0);
    if (!n) return null;
    const head = buf.slice(0, n).toString('utf8');
    const m = head.match(/"(?:session_id|sessionId|sid)"\s*:\s*"((?:[^"\\]|\\.)*)"/);
    if (!m) return null;
    try { return JSON.parse('"' + m[1] + '"'); } catch (_) { return m[1]; }
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

/**
 * **这个 sid 真正该用哪个文件名主干** —— 读和写都调它, 保证一致。
 *
 * 判据只有两条:
 *   1. 纯清洗名 == 原 id ⇒ 文件名就是 id ⇒ 不可能撞 ⇒ 直接用 (零 IO)。
 *   2. 否则: 看目标文件在盘上是谁的。
 *      - 读不出 session_id ⇒ 按老规矩用纯清洗名 (不猜, 不改行为)。
 *      - 是我的 ⇒ 纯清洗名。
 *      - **是别人的** ⇒ 换指纹名 (不覆盖别人的账)。
 *
 * @param {string} dir    目录 (绝对路径)
 * @param {*} sid        session id
 * @param {object} [opts] { ext='.json', maxLen=80 }
 * @returns {string} 文件名主干 (不含扩展名)
 */
function resolveSessionKey(dir, sid, opts) {
  const o = opts || {};
  const ext = o.ext || '.json';
  const eff = _effective(sid);
  const plain = sessionKey(eff, o.maxLen);
  const fp = fingerprintKey(eff, o.maxLen);

  const plainPath = path.join(dir, plain + ext);
  let exists = false;
  try { exists = fs.existsSync(plainPath); } catch (_) { exists = false; }

  if (!exists) {
    // 纯清洗名下面没有文件 —— 但第 92 批中途那版规则 (一律加指纹) 写过少数文件,
    // 那些文件在指纹名下面 ⇒ 继续可达, 不许失联。
    try { if (fs.existsSync(path.join(dir, fp + ext))) return fp; } catch (_) {}
    return plain;
  }

  const owner = probeSessionId(plainPath);
  // 读不出归属 ⇒ 按老规矩 (不猜, 不改行为)。
  if (owner === null || owner === eff) return plain;

  // ★ 真撞名: 这个文件是别人的 ⇒ 用指纹名另起一份, 不覆盖它。
  return fp;
}

/**
 * **前缀族**的文件名 (checkpoint 的 `<key>_r<N>.json`、compaction 快照的 `<key>-<时间戳>.json`)
 * —— 同一个 sid 对应**一组**文件, 不是一个。
 *
 * 判据跟 resolveSessionKey 一样, 只是「归属」要看这一族里的任意一份。
 *
 * @param {string} dir
 * @param {*} sid
 * @param {object} [opts] { ext='.json', sep='_r', maxLen=80 }
 * @returns {string} 文件名主干
 */
function resolveSessionKeyPrefix(dir, sid, opts) {
  const o = opts || {};
  const ext = o.ext || '.json';
  const sep = o.sep === undefined ? '_r' : o.sep;
  const eff = _effective(sid);
  const plain = sessionKey(eff, o.maxLen);
  const fp = fingerprintKey(eff, o.maxLen);

  let files = [];
  try { files = fs.readdirSync(dir); } catch (_) { return plain; }
  const fam = (c) => files.filter(f => f.startsWith(c + sep) && f.endsWith(ext));

  const hitPlain = fam(plain);
  if (!hitPlain.length) {
    // 纯清洗名下没有这一族 —— 看看指纹名下有没有 (第 92 批中途那版规则写的)。
    const hitFp = fam(fp);
    if (hitFp.length) {
      const o2 = probeSessionId(path.join(dir, hitFp[0]));
      if (o2 === null || o2 === eff) return fp;
    }
    return plain;
  }

  // 归属看这一族里的任意一份 (内容里都写着同一个 session_id)。
  const owner = probeSessionId(path.join(dir, hitPlain[0]));
  if (owner === null || owner === eff) return plain;

  // ★ 这一族是别人的 ⇒ 落指纹名。
  const hitFp = fam(fp);
  if (hitFp.length) {
    const o2 = probeSessionId(path.join(dir, hitFp[0]));
    if (o2 === null || o2 === eff) return fp;
  }
  return fp;
}

module.exports = {
  sessionKey,
  fingerprintKey,
  sessionKeyCandidates,
  resolveSessionKey,
  resolveSessionKeyPrefix,
  probeSessionId,
  // 导出清洗规则本身, 供测试对齐存量行为 (不作为第二份真源使用)
  _clean,
};
