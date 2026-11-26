// pillars.mjs —— 四柱表的数据取用 (纯逻辑, 无 DOM)
//
// 为什么要抽出来: 第 119 批补修时发现一个真 bug ——
// 天干行和地支行**都打印了整柱** (「己未」), 因为老代码只把字符串切了取色,
// 打印时用的还是整串。老静态页 (第 113 批) 就是错的, 搬进工作台时照抄了。
// 这类「取字」逻辑藏在 render() 里没法测 ⇒ 抽成纯函数, 单测直接盯住「一个字」。
//
// 2026-10-27 老板给了标准四柱表版式 (传统命书《判断日元强弱条例》那张):
//     日期 | 年柱 | 月柱 | 日柱 | 时柱
//     主星 | (天干十神, 日柱是日元本人)
//     天干 | (一个字 + 五行色)
//     地支 | (一个字 + 五行色)
//     藏干 | (干+五行, 竖着堆)
//     副星 | (藏干各自的十神, 跟藏干一行一行对齐)
// ⇒ 行名改成主星/副星这套叫法, 藏干带上五行, 副星跟藏干逐行对齐。
//
// 2026-11-04 (UI 重写 · 样稿终版): 天干/地支两行合并成一行「干支」,
// 每柱干上支下竖排 (bz-gzstack); 星运/自坐/空亡收成小胶囊 (bz-mp)。
// 取字逻辑不变, 只换排版。

import { esc } from '../util.mjs';
import { iconHTML } from '../icons.mjs';

export const WX_ORDER = ['木', '火', '土', '金', '水'];

/**
 * 五行材质图标。老排盘表里天干/地支的字旁边跟一个「材质」小图标:
 * 木=树、火=火焰、土=土山、金=金锭、水=水滴。
 * 光靠颜色分不清金跟土 —— 尤其浅色主题下两个都是黄系 ⇒ 必须有形状才认得出。
 * 图标用 currentColor 描边, 跟着该字的五行色走, 不用再单独配色。
 */
export const WX_ICON = {
  木: 'wx-mu',
  火: 'wx-huo',
  土: 'wx-tu',
  金: 'wx-jin',
  水: 'wx-shui',
};

export const GAN_WX = {
  甲: '木', 乙: '木', 丙: '火', 丁: '火', 戊: '土',
  己: '土', 庚: '金', 辛: '金', 壬: '水', 癸: '水',
};

export const ZHI_WX = {
  子: '水', 丑: '土', 寅: '木', 卯: '木', 辰: '土', 巳: '火',
  午: '火', 未: '土', 申: '金', 酉: '金', 戌: '土', 亥: '水',
};

export const PILLAR_COLS = ['年柱', '月柱', '日柱', '时柱'];

const YANG_GAN = '甲丙戊庚壬';

export function wxClass(wx) { return 'bz-wx-' + wx; }

/**
 * 五行在命局里的**喜忌档**。
 *
 * 老板 10-27 原话: 「都用五行喜忌的颜色, 更明显」。
 * 只给五行色不够 —— 看一眼表分不出哪个是喜用、哪个是忌神,
 * 得再加一档强弱, 全页一套语言:
 *     xi  喜用 → 实心五行色 (最醒目)
 *     cai 财星 → 淡五行底 (可用但不宜过旺)
 *     ji  忌神 → 灰底 (色相保留, 但退到后面)
 * 优先级: 喜用 > 财星 > 忌神 (真出现冲突时以喜用为准)。
 */
export function wuxingRole(wx, chart) {
  if (!wx) return '';
  const c = chart || {};
  const has = (arr) => Array.isArray(arr) && arr.indexOf(wx) >= 0;
  if (has(c.xi_yong)) return 'xi';
  if (has(c.cai_xing)) return 'cai';
  if (has(c.ji_shell)) return 'ji';
  return '';
}

/** 喜忌档的类名 (没有档位时返回空串, 别留一个空 class)。 */
export function roleClass(role) {
  return role ? 'bz-role-' + role : '';
}

/** 纳音名的五行: 「天上火」→ 火, 「大林木」→ 木。纳音末字就是五行。 */
export function nayinWx(nayin) {
  const last = String(nayin || '').trim().slice(-1);
  return WX_ORDER.indexOf(last) >= 0 ? last : '';
}

/** 五行材质图标的小 HTML (没有图标定义就返回空串, 不能让表格炸掉)。 */
export function wxIconHtml(wx, size = 13) {
  const name = WX_ICON[wx];
  if (!name) return '';
  return '<span class="bz-ico" data-wx="' + esc(wx) + '" data-ico="' + esc(name) + '" aria-hidden="true">'
    + iconHTML(name, size) + '</span>';
}

/** 一柱「己未」的天干 = 己 */
export function ganOf(pillar) {
  return String(pillar || '').slice(0, 1);
}

/** 一柱「己未」的地支 = 未 */
export function zhiOf(pillar) {
  return String(pillar || '').slice(1, 2);
}

/**
 * 天干十神。后端给的是「己 -> 七杀」这种合成串,
 * 表里天干行已经写了「己」⇒ 这里只取十神那一半。
 */
export function ganShishen(chart, col) {
  const raw = String((chart.shishen_tiangan || {})[col + '干'] || '');
  const parts = raw.split('->');
  const v = (parts[parts.length - 1] || '').trim();
  return v || '-';
}

/**
 * 地支十神 —— 取本气那一条 (藏干表的第一条就是本气)。
 * 后端给的是数组: [{干:'己',十神:'七杀'}, {干:'丁',十神:'偏财'}, ...]
 */
export function zhiShishen(chart, col) {
  const list = (chart.shishen_dizhi || {})[col + '支'] || [];
  const first = list[0] || {};
  return first['十神'] || '-';
}

/**
 * 日柱的「主星」= **日元本人**, 写「元男」/「元女」。
 *
 * ⚠ 口径 (2026-10-31 第 176 批修正):
 *   「元男/元女」跟的是**命主性别**, **不是日元阴阳**。
 *
 *   旧实现按 `day_master_yinyang` (日元阴阳) 判 ⇒ 男命里凡阴日干 (乙丁己辛癸)
 *   全被标成「元女」, 女命里凡阳日干全被标成「元男」⇒ **一半的盘是错的**。
 *   (本盘: 1986-12-17 4:20 上海宝山区 **男** 命, 日主乙木(阴) ⇒ 旧代码输出「元女」)
 *
 *   判定依据 (老板自己给的参考表, 不用推测):
 *     ~/Documents/Codex/2026-10-27/pangu-process-docs/BAZI-ROUTE-119-2026-10-27.md:286
 *       主星  正官  伤官  元女  偏财
 *       天干  乙    辛    戊    壬
 *       地支  丑    巳    辰    子
 *     日柱 **戊辰** —— 戊是**阳干**, 却标「元女」。
 *     ⇒ 若按日元阴阳判, 阳干必标「元男」, 与原表矛盾;
 *       只有「这是女命」才解释得通 ⇒ 元男/元女 = 命主性别。
 *
 * 性别取不到时显示「-」, **不许猜** (猜错就是又一次静默错盘)。
 */
export function yuanZi(chart) {
  const c = chart || {};
  // 性别可能挂在 chart.gender (顶层) 或 chart.input.gender (排盘输入层) —— 两个都认。
  const g = normalizeGender(c.gender || (c.input && c.input.gender));
  if (g === 'male') return '元男';
  if (g === 'female') return '元女';
  return '-';
}

/**
 * 性别归一化 —— 前端这一侧的**唯一**性别真源。
 * 后端 `bazi_calc.py` 只认 'male'/'female'; 人话(男/女/男命/乾)必须先翻译。
 * 认不出来就返回 'unknown', 不猜。
 */
export function normalizeGender(raw) {
  if (raw === null || raw === undefined) return 'unknown';
  if (typeof raw === 'boolean') return raw ? 'male' : 'female';
  if (typeof raw === 'number') {
    if (raw === 1) return 'male';
    if (raw === 0) return 'female';
    return 'unknown';
  }
  const s = String(raw).trim().toLowerCase();
  if (['男', '男性', '男命', '乾', 'male', 'm', 'man', 'boy', '1', 'true'].includes(s)) return 'male';
  if (['女', '女性', '女命', '坤', 'female', 'f', 'woman', 'girl', '0', 'false'].includes(s)) return 'female';
  return 'unknown';
}

/**
 * 主星行: 年/月/时柱 = 天干十神; 日柱 = 日元本人 (元男/元女)。
 */
export function masterStar(chart, col) {
  if (col === '日柱') return yuanZi(chart);
  return ganShishen(chart, col);
}

/**
 * 藏干行: 「己土」这种干+五行, 竖着堆。带五行色。
 */
export function cangGanCells(chart, col) {
  const list = ((chart || {}).cang_gan || {})[col] || [];
  return list.map((x) => {
    const gan = String(x['干'] || '');
    const wx = String(x['五行'] || GAN_WX[gan] || '');
    return '<span class="bz-cang bz-wxb ' + wxClass(wx) + ' ' + roleClass(wuxingRole(wx, chart)) + '">'
      + esc(gan + wx) + '</span>';
  }).join('');
}

/**
 * 副星行: 藏干各自的十神, **跟藏干一行一行对齐**
 * (藏干有三条 ⇒ 副星也有三条, 依次对应)。
 */
export function fuStarCells(chart, col) {
  const list = ((chart || {}).cang_gan || {})[col] || [];
  return list.map((x) => '<span class="bz-cang bz-fu">' + esc(x['十神'] || '-') + '</span>').join('');
}

/**
 * 四柱表的每一行。返回 [{label, cells:[html×4]}]。
 * 天干行只有一个字、地支行只有一个字 —— 这是这张表的本体, 不能都印整柱。
 */
export function pillarRows(chart) {
  const c = chart || {};
  const p = c.pillars || {};
  return [
    {
      label: '主星',
      cells: PILLAR_COLS.map((col) => '<span class="bz-master">' + esc(masterStar(c, col)) + '</span>'),
    },
    {
      // 2026-11-04 (UI 重写 · 样稿终版): 天干/地支**合并成一行「干支」** ——
      //   每柱干上支下竖排 (bz-gzstack), 跟大运/流年/流月的 bz-gz 同一形态。
      //   字还是各一个 (bz-gan=干 / bz-zhi=支), 取字逻辑没变, 只换排版。
      label: '干支',
      cells: PILLAR_COLS.map((col) => {
        const g = ganOf(p[col]);
        const wg = GAN_WX[g] || '';
        const z = zhiOf(p[col]);
        const wz = ZHI_WX[z] || '';
        return '<span class="bz-gzstack">'
          + '<span class="bz-gan bz-wxb ' + wxClass(wg) + ' ' + roleClass(wuxingRole(wg, c)) + '">'
          + esc(g || '-') + wxIconHtml(wg) + '</span>'
          + '<span class="bz-zhi bz-wxb ' + wxClass(wz) + ' ' + roleClass(wuxingRole(wz, c)) + '">'
          + esc(z || '-') + wxIconHtml(wz) + '</span>'
          + '</span>';
      }),
    },
    {
      label: '藏干',
      cells: PILLAR_COLS.map((col) => cangGanCells(c, col)),
    },
    {
      label: '副星',
      cells: PILLAR_COLS.map((col) => fuStarCells(c, col)),
    },
    {
      label: '星运',
      // 2026-11-04: 收成小胶囊 (bz-mp), 排版对齐样稿终版
      cells: PILLAR_COLS.map((col) => '<span class="bz-mp">' + esc((c.changsheng_4 || {})[col] || '-') + '</span>'),
    },
    {
      // 自坐行 (2026-10-31 第 176 批): **这一柱自己的天干**坐在**这一柱自己的地支**上。
      //   跟上面的「星运」完全不同 —— 星运是「日主」在四柱地支上的位置。
      //   老板 app: 丙寅=长生 庚子=死 乙未=养 甲申=绝
      label: '自坐',
      cells: PILLAR_COLS.map((col) => '<span class="bz-mp">' + esc((c.zichuan_4 || {})[col] || '-') + '</span>'),
    },
    {
      label: '纳音',
      // 纳音名自带五行 (天上火 / 大林木 / 剑锋金 / 大溪水) ⇒ 染上五行色,
      // 但**不套喜忌档** —— 纳音是「纳」不是「用」, 不参与命局用事。
      cells: PILLAR_COLS.map((col) => {
        const ny = (c.nayin_4 || {})[col] || '-';
        const wx = nayinWx(ny);
        return '<span class="bz-nayin ' + (wx ? 'bz-wxb ' + wxClass(wx) : '') + '">' + esc(ny) + '</span>';
      }),
    },
    {
      // 空亡行 (2026-10-31 第 176 批): **每柱按自己所在旬**算, 不是全盘一个值。
      //   老板 app: 年柱戌亥 / 月柱辰巳 / 日柱辰巳 / 时柱午未
      label: '空亡',
      cells: PILLAR_COLS.map((col) => '<span class="bz-mp">' + esc((c.xunkong_4 || {})[col] || '-') + '</span>'),
    },
    {
      // 逐柱神煞 (2026-10-31 第 182 批恢复: 按课件 08/09 补齐)
      label: '神煞',
      cells: PILLAR_COLS.map((col) => {
        const list = ((c.shensha_by_pillar || {})[col]) || [];
        if (!list.length) return '<span class="bz-fu">-</span>';
        return list.map((s) => '<span class="bz-shensha">' + esc(s) + '</span>').join('');
      }),
    },
  ];
}

/** 整张四柱表的 HTML (含表头行)。 */
/**
 * @param {object} chart 排盘 dict (bazi_calc 输出同构)
 * @param {string[]|null} rowLabels 要画的行。null/undefined = 全画 (八字页原样);
 *   传子集 = 只画那些行 (compat页: 主星/干支/藏干/副星, 老板 11-05「星运·自坐·
 *   纳音·空亡·神煞不需要」)。按 label 精确匹配, 找不到的行**不画**, 不报错 ——
 *   compat页喂的是裁剪过的盘, 缺字段时宁可少画一行, 不能炸。
 */
export function pillarTableHtml(chart, rowLabels = null) {
  const all = pillarRows(chart);
  const rows = rowLabels ? all.filter((r) => rowLabels.includes(r.label)) : all;
  let html = '<tr><th>日期</th>' + PILLAR_COLS.map((x) => '<th>' + x + '</th>').join('') + '</tr>';
  for (const r of rows) {
    html += '<tr><td class="rowh">' + esc(r.label) + '</td>'
      + r.cells.map((h) => '<td>' + h + '</td>').join('') + '</tr>';
  }
  return html;
}
