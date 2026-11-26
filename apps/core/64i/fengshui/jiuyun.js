/**
 * Pangu · 64i Layer
 * fengshui/jiuyun.js
 *
 * 三元九运层 —— 「现在走到第几运」 (2026-10-23 第 68 批)
 *
 * ═══════════════════════════════════════════════════════════════
 * §一、锚点(逐字出处)
 * ═══════════════════════════════════════════════════════════════
 *
 *   出处: `64i/sources/course_env_bazhai.txt`
 *     「九运五行：当前为九紫离火运（2024–2043）」
 *
 * ═══════════════════════════════════════════════════════════════
 * §二、其余八运怎么来的(是**推导**, 不是抄)
 * ═══════════════════════════════════════════════════════════════
 *
 *   一运 20 年, 九运共 180 年(三元: 上元一~三元/中元四~六/下元七~九)。
 *   查法资料给了**九运**这一运的年份(2024–2043), 于是整张表被**唯一钉死**:
 *     九运 2024-2043 → 八运 2004-2023 → … → 一运 1864-1883
 *   这个推导只依赖两件事: 「一运 20 年」与「九运 2024-2043」;
 *   两者都能核 ⇒ 其余七运不是编的。
 *
 *   ⚠️ 与「64卦卦序」无关(又是 0~63 那个坑的亲戚): 三元九运是**时间轴**,
 *     跟卦序、跟二进制 index 都不搭。
 */

'use strict';

const SOURCE_ID = 'course_env_bazhai';

/** 一运 = 20 年; 九运共 180 年。 */
const YEARS_PER_YUN = 20;

/** 九运的起止年 —— 逐字出处见文件头 §一。 */
const JIUYUN_ANCHOR = Object.freeze({ yun: 9, from: 2024, to: 2043 });

/**
 * 三元的起点: 1864。
 *
 * ⚠️ 这不是抄的, 是**从锚点推出来的**:
 *   九运 = 2024-2043(逐字可核), 一运 = 20 年 ⇒ 往前数 8 运 = 160 年
 *   ⇒ 1864 + 160 = 2024 ✓ 对得上。
 */
const FIRST_YEAR = JIUYUN_ANCHOR.from - (JIUYUN_ANCHOR.yun - 1) * YEARS_PER_YUN;

/** 九运的五行/卦(查法资料原话: 「九紫离火运」)。 */
const YUN_GUA = Object.freeze({
  1: { gua: '坎', element: '水' },
  2: { gua: '坤', element: '土' },
  3: { gua: '震', element: '木' },
  4: { gua: '巽', element: '木' },
  5: { gua: '中宫', element: '土' },
  6: { gua: '乾', element: '金' },
  7: { gua: '兑', element: '金' },
  8: { gua: '艮', element: '土' },
  9: { gua: '离', element: '火' },
});

/**
 * 某年落在第几运。
 * @param {number} year
 */
function yunOf(year) {
  const y = Number(year);
  if (!Number.isInteger(y)) return { ok: false, input: year, reason: '年份不是整数' };
  // 三元起于 1864(与九运 2024-2043 相差 160 年 = 8 运 × 20 年)
  const k = Math.floor((y - FIRST_YEAR) / YEARS_PER_YUN);
  const yun = k + 1;
  if (yun < 1 || yun > 9) {
    return {
      ok: false,
      input: y,
      reason: '超出三元九运覆盖范围(1864-2043, 三元 180 年)',
    };
  }
  const start = FIRST_YEAR + (yun - 1) * YEARS_PER_YUN;
  const fact = YUN_GUA[yun];
  return {
    ok: true,
    year: y,
    yun,
    from: start,
    to: start + YEARS_PER_YUN - 1,
    gua: fact.gua,
    element: fact.element,
    label: yun + '运(' + fact.gua + fact.element + '运)',
  };
}

/** 九运全表(1864-2043), 便于对账。 */
function table() {
  const out = [];
  for (let y = 1864; y <= 2043; y++) {
    const r = yunOf(y);
    if (r.ok) out.push(r);
  }
  return out;
}

module.exports = {
  SOURCE_ID,
  YEARS_PER_YUN,
  JIUYUN_ANCHOR,
  YUN_GUA,
  yunOf,
  table,
};
