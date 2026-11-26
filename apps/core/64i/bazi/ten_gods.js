/**
 * Pangu · 64i Layer
 * bazi/ten_gods.js - 十神体系 (比肩/劫财/食神/伤官/偏财/正财/七杀/正官/偏印/正印)
 *
 * 数据源: 桌面"易经"文件夹 / <course-source> + <instructor>老师课件 + 子平学漫画版
 * 消化日期: 2026-09-03
 */

'use strict';

// ============================================================
// 天干 + 阴阳 + 五行
// ============================================================

const TIAN_GAN = ['甲', '乙', '丙', '丁', '戊', '己', '庚', '辛', '壬', '癸'];

const WUXING = {
  '甲': '木', '乙': '木',
  '丙': '火', '丁': '火',
  '戊': '土', '己': '土',
  '庚': '金', '辛': '金',
  '壬': '水', '癸': '水',
};

// 阴阳 (甲丙戊庚壬 = 阳, 乙丁己辛癸 = 阴)
const YIN_YANG = {
  '甲': '阳', '乙': '阴', '丙': '阳', '丁': '阴', '戊': '阳',
  '己': '阴', '庚': '阳', '辛': '阴', '壬': '阳', '癸': '阴',
};

// 五行生克
const SHENG = { '木': '火', '火': '土', '土': '金', '金': '水', '水': '木' };
const KE = { '木': '土', '土': '水', '水': '火', '火': '金', '金': '木' };

// ============================================================
// 十神表 — 以日干为我(主),其他天干相对我的关系
// ============================================================
// 规则:
// 同我(同五行) + 同阴阳 = 比肩
// 同我 + 异阴阳 = 劫财
// 我生 + 同阴阳 = 食神
// 我生 + 异阴阳 = 伤官
// 生我 + 同阴阳 = 偏印
// 生我 + 异阴阳 = 正印
// 我克 + 同阴阳 = 偏财
// 我克 + 异阴阳 = 正财
// 克我 + 同阴阳 = 七杀
// 克我 + 异阴阳 = 正官
// ============================================================

const TEN_GODS = {
  '比肩':   { same_wuxing: true,  same_yinyang: true,  relation: '同我', polarity: '阳阳/阴阳阴' },
  '劫财':   { same_wuxing: true,  same_yinyang: false, relation: '同我', polarity: '阳阴/阴阳' },
  '食神':   { same_wuxing: false, same_yinyang: true,  relation: '我生', polarity: '阳阳/阴阳阴' },
  '伤官':   { same_wuxing: false, same_yinyang: false, relation: '我生', polarity: '阳阴/阴阳' },
  '偏印':   { same_wuxing: false, same_yinyang: true,  relation: '生我', polarity: '阳阳/阴阳阴' },
  '正印':   { same_wuxing: false, same_yinyang: false, relation: '生我', polarity: '阳阴/阴阳' },
  '偏财':   { same_wuxing: false, same_yinyang: true,  relation: '我克', polarity: '阳阳/阴阳阴' },
  '正财':   { same_wuxing: false, same_yinyang: false, relation: '我克', polarity: '阳阴/阴阳' },
  '七杀':   { same_wuxing: false, same_yinyang: true,  relation: '克我', polarity: '阳阳/阴阳阴' },
  '正官':   { same_wuxing: false, same_yinyang: false, relation: '克我', polarity: '阳阴/阴阳' },
};

// ============================================================
// 十神象义 (从<course-source> + <instructor>课件抽取)
// ============================================================

const TEN_GODS_MEANING = {
  '比肩': '与我同类,象征朋友/兄弟/同事/竞争者,平起平坐',
  '劫财': '与我同类但异阴阳,象征夺财/争夺/竞争/同性朋友/破财',
  '食神': '我生之同阴阳,象征才华/表达/口福/子女/福气/温和',
  '伤官': '我生之异阴阳,象征叛逆/聪明/创意/口舌是非/伤官见官为祸',
  '偏印': '生我之同阴阳,又称枭神,象征继母/偏门学问/权谋/特殊才能',
  '正印': '生我之异阴阳,象征母亲/学问/文书/权柄/庇护/善良',
  '偏财': '我克之同阴阳,象征父亲(男)/情人/横财/投资/商业',
  '正财': '我克之异阴阳,象征妻子(男)/稳定收入/财产/理财/勤俭',
  '七杀': '克我之同阴阳,又称偏官,象征权威/压力/小人/竞争/武将/果断',
  '正官': '克我之异阴阳,象征官位/上司/考试/法律/女儿/名声/约束',
};

// ============================================================
// 推算函数 (从 bazi_calc.py 移植为 JS,无 Python 依赖)
// ============================================================

function getTenGod(dayMaster, target) {
  if (!TIAN_GAN.includes(dayMaster) || !TIAN_GAN.includes(target)) return null;
  if (dayMaster === target) return null;

  const dmWx = WUXING[dayMaster];
  const tgWx = WUXING[target];
  const sameYinYang = YIN_YANG[dayMaster] === YIN_YANG[target];

  if (dmWx === tgWx) return sameYinYang ? '比肩' : '劫财';
  if (SHENG[dmWx] === tgWx) return sameYinYang ? '食神' : '伤官';
  if (SHENG[tgWx] === dmWx) return sameYinYang ? '偏印' : '正印';
  if (KE[dmWx] === tgWx) return sameYinYang ? '偏财' : '正财';
  if (KE[tgWx] === dmWx) return sameYinYang ? '七杀' : '正官';
  return null;
}

function analyzePillars(pillars) {
  // pillars: ['甲子', '乙丑', ...] — 第 3 柱(日柱)是天干为日主
  const dayMaster = pillars[2][0]; // 日干 = 我
  const zhis = pillars.map(p => p.slice(-1));
  const gans = pillars.map(p => p[0]);

  return pillars.map((p, i) => {
    const gan = p[0];
    const zhi = p.slice(-1);
    return {
      pillar: i === 0 ? '年' : i === 1 ? '月' : i === 2 ? '日' : '时',
      gan, zhi,
      ten_god_gan: i === 2 ? null : getTenGod(dayMaster, gan),
      is_day_master: i === 2,
    };
  });
}

module.exports = {
  TIAN_GAN, WUXING, YIN_YANG, SHENG, KE,
  TEN_GODS, TEN_GODS_MEANING,
  getTenGod, analyzePillars,
};