// modules/grounding_check.js — 溯源链强校验 (2026-10-14)
//
// 现状: run_trace 只记一条 claim, 内容是 "调用 exec_command" —— 那说的是
// "我调过工具", 不是 "答案里的数字来自工具"。于是溯源链断在工具这一层:
// 子 agent 可以凭空写 "共 40 个文件", trace 里照样一片 grounded,
// 事后没人能查出这个 40 是从哪个 tool_result 里来的。
//
// 这一层把链**接到断言上**: 把最终答案里的可核查断言抽出来, 逐条回到
// tool_result 的真实内容里找。找不到 = 未接地, 留痕, 可证伪。
//
// 设计上刻意只抓**高信号**数字 (带单位/量纲的), 不抓裸数字:
// 裸数字在中文散文里误报率极高 ("第一个"、"三点"、"二话不说"), 一旦误报
// 就会把真答案判成假, 那比漏报更糟 —— 守卫一旦撒谎就没人再信它。
// 宁可漏报一部分"共 3 点"这种, 也不能把 "45 个文件" 这种放过。
'use strict';

// 带量纲的计数 —— 最强的一类信号。
//
// 结尾**不能**用 \b: JS 的 \b 只认 [A-Za-z0-9_] 是 \w, 中文不是。
// "共 40 个文件" 里 个 后面紧跟 文 (都是非 \w), 没有边界 → \b 永不成立,
// 一条计数都抓不到。这里改用 (?![A-Za-z0-9]) : 只挡 ASCII 字母数字, 中文照过。
const COUNT_RE = /(?<![\d.])(\d[\d,]*(?:\.\d+)?)\s*(个|项|条|次|份|只|张|行|页|家|台|款|种|类|组|批|道|步|轮|层|根|块|件|笔|款|人|台)(?![A-Za-z0-9])/g;
const PERCENT_RE = /(?<![\d.])(\d+(?:\.\d+)?)\s*%/g;
// 数字允许千分位逗号: "1,072 MB"。少了 [\d,]* 的话, 逗号会让 (?<![\d.]) 前面
// 站着一个非数字, 于是从 "072" 开始匹配 —— 现场 gc-verify-5 抽出过 "072 MB" 这种
// 截断值, 拿去核对永远核不上, 白占一条未接地。_norm 会把逗号去掉, 匹配时不受影响。
const SIZE_RE = /(?<![\d.])(\d[\d,]*(?:\.\d+)?)\s*(KB|MB|GB|TB|kB|Mib|MiB|GiB|ms|s|秒|分钟|小时|天|周|个月|年)/g;
const MONEY_RE = /(?<![\d.])(\d[\d,]*(?:\.\d+)?)\s*(元|美元|美金|块|万|亿|rmb|RMB|CNY|USD)/g;
// 版本号必须有明确形态才认: 要么 v 前缀, 要么至少两个点 (x.y.z)。
// 旧写法 v?(\d+\.\d+...) 会把 "5.9 GiB" 里的 5.9 当成版本号 ——
// 而 5.9 同时又是 SIZE_RE 的主体, 同一条断言被抽两遍, 凭空多一份未接地。
const VERSION_RE = /(?<![\d.])v(\d+\.\d+(?:\.\d+)*)(?![\d.])|(?<![\d.])(\d+\.\d+\.\d+(?:\.\d+)*)(?![\d.])/g;
const DATE_RE = /(?<![\d])(\d{4})[-/年](\d{1,2})(?:[-/月](\d{1,2}))?日?(?![\d])/g;

function _norm(s) {
  return String(s == null ? '' : s).replace(/[,，\s]/g, '');
}

// 日期两边写法不一样 ("2026-10-14" vs "2026年10月14日"), 光在 claim 上切片不够 ——
// 必须把**证据里的日期也规范化**, 否则永远对不上, 每次都误报。
function _canonDates(s) {
  return String(s == null ? '' : s).replace(
    /(\d{4})\s*[-/年]\s*(\d{1,2})(?:\s*[-/月]\s*(\d{1,2}))?\s*日?/g,
    (m, y, mo, d) => (d ? y + '-' + String(mo).padStart(2, '0') + '-' + String(d).padStart(2, '0')
                      : y + '-' + String(mo).padStart(2, '0'))
  );
}

/**
 * 抽出答案里可核查的断言。
 * @returns {Array<{kind:string, raw:string, norm:string}>}
 */
function extractClaims(text) {
  const out = [];
  const src = String(text == null ? '' : text);
  const push = (kind, m, idx) => {
    const raw = m[0].trim();
    // 列表序号不是断言: "1. 第一条" / "2) 第二点" / "**3.**"
    const before = src.slice(Math.max(0, idx - 3), idx);
    if (/^\s*[*_#\-–—>]*\s*$/.test(before) && /^[\d]+[.、)）]?$/.test(raw.replace(/\s+\S+$/, ''))) {
      // "1." 这种纯序号直接跳过
      if (/^[\d]+[.、)）]?\s*$/.test(raw)) return;
    }
    // 多分支正则 (版本号的 v1.2.3 / 1.2.3) 数字可能落在不同组, 取第一个有值的。
    let num = null;
    for (let i = 1; i < m.length; i++) {
      if (m[i] !== undefined) { num = m[i]; break; }
    }
    // 单位单独留一份: 字节↔GiB 换算要用 (证据里常是原始字节数, 答案里是人写的 GiB)
    const unit = m.length > 2 && m[2] !== undefined ? String(m[2]) : '';
    out.push({
      kind, raw, unit,
      norm: _norm(kind !== 'date' && num !== null ? num : raw),
    });
  };
  let m;
  COUNT_RE.lastIndex = 0;
  while ((m = COUNT_RE.exec(src)) !== null) push('count', m, m.index);
  PERCENT_RE.lastIndex = 0;
  while ((m = PERCENT_RE.exec(src)) !== null) push('percent', m, m.index);
  SIZE_RE.lastIndex = 0;
  while ((m = SIZE_RE.exec(src)) !== null) push('size', m, m.index);
  MONEY_RE.lastIndex = 0;
  while ((m = MONEY_RE.exec(src)) !== null) push('money', m, m.index);
  VERSION_RE.lastIndex = 0;
  while ((m = VERSION_RE.exec(src)) !== null) push('version', m, m.index);
  DATE_RE.lastIndex = 0;
  while ((m = DATE_RE.exec(src)) !== null) push('date', m, m.index);
  return out;
}

/** 把一批 tool_result 拼成可检索的证据文本 (去掉千分位以便匹配)。 */
function buildEvidence(toolResults) {
  const parts = [];
  for (const t of (toolResults || [])) {
    if (!t) continue;
    if (t.ok === false) continue;
    let body = '';
    // 盘古工具的成功载荷在 **data** 字段 (return { ok: true, data: {...} }),
    // 不是 result。只认 result 会让整套接地校验永远零证据 —— 事件照发, 但
    // evidence_chars 恒为 0, 等于在空转 (现场 gc-verify-2 踩过)。
    if (typeof t.data === 'string') body = t.data;
    else if (t.data !== undefined) {
      try { body = JSON.stringify(t.data); } catch (_) { body = String(t.data); }
    }
    if (!body && typeof t.result === 'string') body = t.result;
    else if (!body && t.result !== undefined) {
      try { body = JSON.stringify(t.result); } catch (_) { body = String(t.result); }
    }
    if (!body) body = String(t.text || t.content || '');
    if (body) parts.push(body);
  }
  return parts.join('\n');
}

function isGrounded(claim, evidenceText) {
  const ev = _norm(evidenceText);
  if (!ev) return false;
  // 数字必须**独立**出现, 不能是别的数字的一部分。
  // 现场 (dbg): 老写法 ev.includes("7") 对上的是证据里的 3814005 —— 任何一位数断言
  // 都能在任意证据里"找到", 校验形同虚设, 而且方向恰恰相反: 把编的数字判成接地。
  // 这比漏报严重得多 —— 漏报只是没查出来, 误接地是**谎报通过**。
  if (claim.norm && _containsNumber(ev, claim.norm)) return true;
  // 换算接地: 现场 gc-verify-3 —— 子 agent 把 hw.memsize 的 137438953472 字节
  // 写成"128 GiB"。字面匹配永远找不到"128", 于是**诚实的换算被判编造**,
  // 现场误报率一度到 40-48%。这种校验错一半, 就没人敢用了。
  if (_matchByConversion(claim, ev)) return true;
  // 日期类允许只匹配到年月 (答案写 2026-10-14, 证据里可能是 2026年10月14日)
  if (claim.kind === 'date') {
    const ym = _norm(_canonDates(claim.raw)).slice(0, 7);
    if (ym && ev.includes(ym)) return true;
  }
  return false;
}

function _containsNumber(ev, norm) {
  const n = String(norm == null ? '' : norm);
  if (!n) return false;
  if (!/^\d/.test(n)) return ev.includes(n);          // 非纯数字 (日期等) 退回子串
  const esc = n.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  try {
    return new RegExp('(?<!\\d)' + esc + '(?!\\d)').test(ev);
  } catch (_) {
    return ev.includes(n);
  }
}

// 字节单位 → 字节数。证据里的原始值绝大多数就是字节 (macOS 的 sysctl/df 给的就是)。
//
// 关键: GB/MB/KB **两种进制都要试**。现场 gc-verify-4: 子 agent 把 hw.memsize
// 的 137438953472 写成 "137.44 GB" —— 那是 1000^3 的算法 (137438953472/1e9);
// 我原来只按 1024^3 换算 (=128 GiB), 于是这条**如实换算**又判成编造。
// macOS 的 df/man 也确实两种都出现, 所以两种都认。
const _BYTE_UNITS = {
  B: [1], KB: [1024, 1000], MB: [1024 ** 2, 1000 ** 2], GB: [1024 ** 3, 1000 ** 3], TB: [1024 ** 4, 1000 ** 4],
  KIB: [1024], MIB: [1024 ** 2], GIB: [1024 ** 3], TIB: [1024 ** 4],
  K: [1000], M: [1000 ** 2], G: [1000 ** 3], T: [1000 ** 4],
};
const _TIME_UNITS = {
  ms: 1e-3, s: 1, 秒: 1, 分钟: 60, 分: 60, 小时: 3600, 时: 3600, 天: 86400, 周: 604800,
};

// 只认精确等值 (相对误差 < 0.5%, 换算必然带取整), 放宽就会变成"什么都能算对上"。
function _matchByConversion(claim, ev) {
  if (!claim.unit) return false;
  const val = Number(claim.norm);
  if (!Number.isFinite(val) || val <= 0) return false;

  const up = String(claim.unit).toUpperCase();
  const byteMuls = _BYTE_UNITS[up] || _BYTE_UNITS[String(claim.unit)];
  if (byteMuls) {
    const bigNums = ev.match(/\d{9,}/g) || [];
    const allNums = ev.match(/\d+(?:\.\d+)?/g) || [];
    for (const mul of byteMuls) {
      const target = val * mul;
      for (const n of bigNums) {
        const b = Number(n);
        if (!Number.isFinite(b) || b <= 0) continue;
        if (Math.abs(b - target) / target < 0.005) return true;   // 答案写 GiB, 证据写字节
        if (Math.abs(val - b) / b < 0.005) return true;           // 反向
      }
    }
    // 页数换算: macOS 的 vm_stat 给的是"页数 + page size", 内存数字是
    // pages × pageSize 算出来的 (现场 gc-verify-4 的 58.3 GiB / 31.4 GiB 全是这一路)。
    // 不认这一步, 内存类断言就永远判未接地。
    // 注意: ev 已经被 _norm 去掉所有空格, "page size of 16384" 在这里是
    // "pagesizeof16384" —— 写成 /page size of\s*(\d+)/ 永远匹配不上, 页数换算静默失效。
    // \D{0,4} 只吃非数字, 正好跳过 "of"。
    const psM = ev.match(/pagesize\w{0,2}\s*of\s*(\d+)/i) || ev.match(/pagesize\D{0,4}(\d+)/i);
    if (psM) {
      const pageSize = Number(psM[1]);
      if (Number.isFinite(pageSize) && pageSize > 0) {
        for (const mul of byteMuls) {
          const target = val * mul;
          for (const n of allNums) {
            const pages = Number(n);
            if (!Number.isFinite(pages) || pages <= 0) continue;
            const asBytes = pages * pageSize;
            if (Math.abs(asBytes - target) / target < 0.005) return true;
          }
        }
      }
    }
    return false;
  }

  const timeMul = _TIME_UNITS[claim.unit];
  if (timeMul) {
    const targetSec = val * timeMul;
    const nums = ev.match(/\d+(?:\.\d+)?/g) || [];
    for (const n of nums) {
      const v = Number(n);
      if (!Number.isFinite(v) || v <= 0) continue;
      if (Math.abs(v - targetSec) / targetSec < 0.005) return true;
    }
  }
  return false;
}

/**
 * 核查答案里的断言是否都有工具证据。
 * @returns {{total:number, grounded:number, ungrounded:Array, evidence_chars:number}}
 */
function check(text, toolResults) {
  const claims = extractClaims(text);
  // 证据只规范化一次 —— 每条断言都重跑一遍日期正则在长 tool_result 上很贵。
  const ev = _norm(_canonDates(buildEvidence(toolResults)));
  const ungrounded = [];
  let grounded = 0;
  for (const c of claims) {
    if (isGrounded(c, ev)) grounded++;
    else ungrounded.push(c);
  }
  return {
    total: claims.length,
    grounded,
    ungrounded,
    ungrounded_count: ungrounded.length,
    grounded_ratio: claims.length ? grounded / claims.length : 1,
    evidence_chars: ev.length,
  };
}

module.exports = { extractClaims, buildEvidence, isGrounded, check };
