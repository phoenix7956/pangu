/**
 * Pangu · 64i Layer
 * fengshui/ming_gua.js
 *
 * 命卦层 —— 「一个人是哪一命」 (2026-10-23 第 68 批)
 *
 * ═══════════════════════════════════════════════════════════════
 * 为什么这一层先落地
 * ═══════════════════════════════════════════════════════════════
 *
 *   老板 2026-10-21 问「盘古做通用 agent 还是专属术数 agent」, 整改方案里
 *   「专属那半」只做了四分之一 —— 八字/易经/六爻纳甲都有, 风水这一门
 *   **一个实现文件都没有**。这一批先把风水门的第一块砖垫上:
 *   **命卦**, 因为它是整个八宅体系的地基:
 *     命卦 → 宅命相配 → 大游年取用神方位 → 阳宅四要 → 布局建议
 *   没有命卦, 后头三步全都不成立。
 *
 * ═══════════════════════════════════════════════════════════════
 * §一、算法(逐字出处, 不凭记忆)
 * ═══════════════════════════════════════════════════════════════
 *
 *   出处: `64i/sources/course_env_bazhai.txt`
 *     「男命：年份数字相加 → 拆加至个位数 → 用11减 → 得命星」
 *     「女命：年份数字相加 → 拆加至个位数 → 用4加 → 再拆加至个位数 → 得命星」
 *     「5黄星特殊处理：男为坤，女为艮，均属西四命」
 *     「东四命：坎（1）、震（3）、巽（4）、离（9）」
 *     「西四命：坤（2）、兑（7）、艮（8）、乾（6）」
 *
 *   ⚠️ 原文没明说「男命 11减之后还要不要再拆加」, 但**表说了**(见 §二):
 *     男命 x=1 时 11-1=10, 表里给的是「1水坎卦」。
 *     ⇒ 男命减完**同样要拆加至个位数**。这不是我加的规则, 是表逼出来的。
 *
 * ═══════════════════════════════════════════════════════════════
 * §二、这张表的来历(为什么敢拿它当基准)
 * ═══════════════════════════════════════════════════════════════
 *
 *   PDF 讲义里的「命卦速查表」是**一张图片**, 文字层只抽得到标题行 ⇒
 *   走 OCR 会把「壬午」读成「王午」、「艮」读成「長」——
 *   **拿 OCR 结果当基准 = 把噪声写进基准**。
 *   同一份课另有一份同口径的 xlsx:
 *     `/Users/you/Desktop/course-source`
 *   由抽取器机械切成 `64i/sources/course_env_bazhai_minggua_table.txt`
 *   (纯 Node 解析 xlsx, 一格不改; `--check` 可逐字节复校)。
 *
 *   口径细节(**表里的写法, 不是我编的**):
 *     · 5 黄星在表里写成「5土坤卦」「5土艮卦」—— **保留数字 5**,
 *       不写成「2土坤卦」。本模块的 `label` 与表**逐字同形**,
 *       因为这是要拿去跟表对账的那一列。
 *     · 表是两栏并排(左栏 2001-2020, 右栏 2021-2040), 切片保持原行序;
 *       **换序由本模块做**(见 `parseTable`), 换序规则写在代码里, 可审。
 *
 * ═══════════════════════════════════════════════════════════════
 * §三、这一层**不做什么**(边界比能力重要)
 * ═══════════════════════════════════════════════════════════════
 *
 *   · **不给「命好命坏」结论** —— 只给「哪一卦/东西四命」。
 *   · **不把命卦当下卦** —— 八宅与大游年用的是**方位**, 不是六爻装卦。
 *   · **不碰「流年命卦」** —— 那是另一套(以立春换年), 本层只有出生年命卦。
 *   · **不给方位吉凶** —— 那是 `dayun_geometry.js` 的活(大游年排盘)。
 */

'use strict';

const fs = require('fs');
const path = require('path');

const SOURCE_ID = 'course_env_bazhai_minggua_table';
const SOURCE_FILE = 'course_env_bazhai_minggua_table.txt';
const SOURCES_DIR = path.join(__dirname, '..', 'sources');

/**
 * 八卦 → 命星数字/五行/东西四命。
 *
 * ⚠️ 数字是**命星序号**, 不是 64 卦卦序, 也不是二进制 index。
 *   老板 10-21 点的那个坑(「64卦不是 1~64 是 0~63」)在这一层**不适用**:
 *   八宅用的是 1..9 的命星数, 没有 0。
 */
const GUA_FACTS = Object.freeze({
  1: { gua: '坎', element: '水', group: '东四命' },
  2: { gua: '坤', element: '土', group: '西四命' },
  3: { gua: '震', element: '木', group: '东四命' },
  4: { gua: '巽', element: '木', group: '东四命' },
  6: { gua: '乾', element: '金', group: '西四命' },
  7: { gua: '兑', element: '金', group: '西四命' },
  8: { gua: '艮', element: '土', group: '西四命' },
  9: { gua: '离', element: '火', group: '东四命' },
});

/** 5 黄星: 男作坤, 女作艮, **都是西四命**(出处见文件头 §一)。 */
const FIVE_YELLOW = Object.freeze({
  m: Object.freeze({ gua: '坤', element: '土', group: '西四命', star: 5 }),
  f: Object.freeze({ gua: '艮', element: '土', group: '西四命', star: 5 }),
});

/** 表里的标签写法: 「8土艮卦」「5土坤卦」—— 数字 + 五行 + 卦名 + 卦。 */
function labelOf(star, gua, element) {
  return String(star) + element + gua + '卦';
}

/** 把出生年份的数字和**拆加至个位数**。 */
function digitRoot(year) {
  let s = String(year).split('').reduce((acc, ch) => acc + Number(ch), 0);
  while (s > 9) s = String(s).split('').reduce((acc, ch) => acc + Number(ch), 0);
  return s;
}

/**
 * 命卦计算。
 *
 * @param {number} year  出生年(公历年四位)
 * @param {'m'|'f'} gender 男/女
 */
function mingGua(year, gender) {
  // ⚠️ 性别**认不出就报错**, 不许默认成男命(2026-10-23 第 69 批修的真 bug)。
  //   原来写的是 `gender === 'f' ? 'f' : 'm'` —— 传 undefined / '' / 'x' 都落成男命,
  //   **不报错**。而命卦的男女是「11 减」对「4 加」, 方向完全相反:
  //   1991 年男命 = 9离, 女命 = 6乾 —— 猜错整盘反了, 而且结果看起来完全正常。
  //   为什么第 68 批没暴露: 那 80 条对账全是显式传 'm' / 'f', 永远碰不到这条。
  //   ⇒ 「缺料就编」这个洞, 只有**显式传错值**的判据才逮得到。
  const g = String(gender || '').trim().toLowerCase();
  if (g !== 'm' && g !== 'f') {
    throw new Error('命卦必须给性别(m/f): 男女是「11减」对「4加」, 方向相反, 认不出不能猜'
      + '(收到 gender=' + JSON.stringify(gender) + ')');
  }
  const x = digitRoot(year);
  let v = g === 'm' ? 11 - x : x + 4;
  // 男命减完 / 女命加完, 都可能 ≥10 ⇒ 再拆加至个位数(表逼出来的, 见文件头 §一)
  while (v > 9) v = String(v).split('').reduce((acc, ch) => acc + Number(ch), 0);
  const five = v === 5;
  const fact = five ? FIVE_YELLOW[g] : GUA_FACTS[v];
  if (!fact) {
    // 理论上到不了: v 必落在 1..9。留着是防「以后改了算法忘了改这里」。
    throw new Error('命星越界: year=' + year + ' gender=' + gender + ' v=' + v);
  }
  return {
    year,
    gender: g,
    digit_sum: x,
    star: five ? 5 : v,
    gua: fact.gua,
    element: fact.element,
    group: fact.group,
    label: labelOf(five ? 5 : v, fact.gua, fact.element),
  };
}

/**
 * 读仓库内的真源表(切片), 返回 {year: {m: {...}, f: {...}}}。
 *
 * 换序规则(写在这里, 可审): 表是两栏并排 —— 第 1..5 列是 2001-2020,
 * 第 6..10 列是 2021-2040 ⇒ **按列块拆开, 再按年份升序**。
 */
function parseTable(text) {
  const lines = String(text).split('\n');
  const rows = lines
    .filter((l) => l && !l.startsWith('#'))
    .map((l) => l.split('\t'));
  const out = {};
  for (const cells of rows) {
    if (!cells.length) continue;
    const y0 = Number(cells[0]);
    const y1 = Number(cells[5]);
    if (Number.isInteger(y0) && y0 > 1000) {
      out[y0] = {
        m: { label: cells[1], group: cells[2] },
        f: { label: cells[3], group: cells[4] },
      };
    }
    if (Number.isInteger(y1) && y1 > 1000) {
      out[y1] = {
        m: { label: cells[6], group: cells[7] },
        f: { label: cells[8], group: cells[9] },
      };
    }
  }
  return out;
}

let _table = null;

/** 仓库内的真源表(懒加载)。缺失时返回 null (调用方判 skipped), 不炸。 */
function table() {
  if (_table === null) {
    const abs = path.join(SOURCES_DIR, SOURCE_FILE);
    if (!fs.existsSync(abs)) { _table = null; return null; }
    _table = parseTable(fs.readFileSync(abs, 'utf8'));
  }
  return _table;
}

/**
 * 公式 × 真源表 逐年对账。
 * 表缺失 ⇒ 返回 { skipped:true }; 是否当失败由调用方 (provenance 守卫, 按 .pangu-open-source 标记) 定。
 */
function verifyAgainstTable() {
  const t = table();
  if (!t) return { checked: 0, mismatches: [], skipped: true, reason: 'course_env_bazhai_minggua_table 速查表缺失' };
  const mismatches = [];
  let checked = 0;
  for (const year of Object.keys(t).map(Number).sort((a, b) => a - b)) {
    for (const g of ['m', 'f']) {
      const got = mingGua(year, g);
      const exp = t[year][g];
      checked += 1;
      if (got.label !== exp.label || got.group !== exp.group) {
        mismatches.push({
          year,
          gender: g,
          expected: exp.label + '/' + exp.group,
          got: got.label + '/' + got.group,
        });
      }
    }
  }
  return { checked, mismatches };
}

module.exports = {
  SOURCE_ID,
  SOURCE_FILE,
  GUA_FACTS,
  FIVE_YELLOW,
  mingGua,
  digitRoot,
  labelOf,
  parseTable,
  table,
  verifyAgainstTable,
};
