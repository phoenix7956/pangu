/**
 * Pangu · 64i Layer
 * bazi/zhis_relations.js - 地支关系(六合/三合/三会/六冲/六害/三刑/自刑)
 *
 * 数据源: 桌面"易经"文件夹 / <course-source> + <course-source>
 * 消化日期: 2026-09-03
 */

'use strict';

// ============================================================
// 基础常量
// ============================================================

const DI_ZHI = ['子', '丑', '寅', '卯', '辰', '巳', '午', '未', '申', '酉', '戌', '亥'];

const WUXING = {
  '子': '水', '丑': '土', '寅': '木', '卯': '木', '辰': '土', '巳': '火',
  '午': '火', '未': '土', '申': '金', '酉': '金', '戌': '土', '亥': '水',
};

const YIN_YANG = {
  '子': '阳', '丑': '阴', '寅': '阳', '卯': '阴', '辰': '阳', '巳': '阴',
  '午': '阳', '未': '阴', '申': '阳', '酉': '阴', '戌': '阳', '亥': '阴',
};

// ============================================================
// 六合 (6 对合,对称分布,反映"对称美")
// 子丑合土 / 寅亥合木 / 卯戌合火 / 辰酉合金 / 巳申合水 / 午未合土
//
// ⚠️ 2026-10-22 第 42 批: 午未原来写「土/火」—— 出处层核出来真源只说「午未合土」
//   (64i/sources/course_zhi_chong_he.txt: 「子丑合土、寅亥合木、卯戌合火、辰酉合金、
//   巳申合水、午未合土。」)。「土/火」是本地自撰时留下的模糊口径, 跟真源不符 ⇒ 改。
// ============================================================

const LIU_HE = [
  { pair: ['子', '丑'], element: '土', meaning: '子丑合化成功条件紧邻且天干透土' },
  { pair: ['寅', '亥'], element: '木', meaning: '寅亥合木' },
  { pair: ['卯', '戌'], element: '火', meaning: '卯戌合火' },
  { pair: ['辰', '酉'], element: '金', meaning: '辰酉合金(经典案例: 辰上透庚)' },
  { pair: ['巳', '申'], element: '水', meaning: '巳申合水(经典案例: 巳申合水但巳上不透壬癸=合而不化)' },
  { pair: ['午', '未'], element: '土', meaning: '午未合土' },
];

// 合化条件: 1.两支紧邻 2.合化五行能透出天干 3.不透=合而不化
// ============================================================
// 三合局 (4 组) — 三合像三个好友志同道合往一处使劲,力量大
// ============================================================

const SAN_HE = [
  { trio: ['亥', '卯', '未'], element: '木', meaning: '亥卯未合木局(经典: 亥卯未+月令亥水生木=三合成功能量加强)' },
  { trio: ['寅', '午', '戌'], element: '火', meaning: '寅午戌合火局' },
  { trio: ['巳', '酉', '丑'], element: '金', meaning: '巳酉丑合金局' },
  { trio: ['申', '子', '辰'], element: '水', meaning: '申子辰合水局' },
];

// 三合条件: 三支齐全 + 月令当旺(在月令成化)
// ============================================================
// 三会局 (4 组) — 季节成局,力量大于三合
// ============================================================

const SAN_HUI = [
  { trio: ['寅', '卯', '辰'], element: '木', season: '春', meaning: '寅卯辰会木' },
  { trio: ['巳', '午', '未'], element: '火', season: '夏', meaning: '巳午未会火' },
  { trio: ['申', '酉', '戌'], element: '金', season: '秋', meaning: '申酉戌会金' },
  { trio: ['亥', '子', '丑'], element: '水', season: '冬', meaning: '亥子丑会水' },
];

// 三会条件: 三支齐全 + 月令
// 三会与三合象义: 三合=志同道合的朋友,三会=季节力量,更强
// ============================================================
// 六冲 (6 对冲) — 阴阳同性相冲,相反方位相冲,像两个人打架,彼此都受伤
// ============================================================

const LIU_CHONG = [
  { pair: ['子', '午'], meaning: '子午冲---一生不安,破财,感情不稳定,注意心脏血液' },
  { pair: ['卯', '酉'], meaning: '卯酉冲---背约失信,工作事业不定,婚姻晚,注意肝胆手足' },
  { pair: ['寅', '申'], meaning: '寅申冲---多情且好管闲事' },
  { pair: ['巳', '亥'], meaning: '巳亥冲---多事、喜助人' },
  { pair: ['辰', '戌'], meaning: '辰戌冲---克亲伤子寿短' },
  { pair: ['丑', '未'], meaning: '丑未冲---事多阻逆' },
];

// 六冲条件: 1.必须紧邻才有力 2.隔柱不能冲
// ============================================================
// 六害/穿 (6 对) — 一个人在另一个人背后捅刀子,面和心不合
// ============================================================

const LIU_HAI = [
  { pair: ['子', '未'], meaning: '子未相害' },
  { pair: ['丑', '午'], meaning: '丑午相害' },
  { pair: ['寅', '巳'], meaning: '寅巳相害' },
  { pair: ['卯', '辰'], meaning: '卯辰相害' },
  { pair: ['申', '亥'], meaning: '申亥相害' },
  { pair: ['酉', '戌'], meaning: '酉戌相害' },
];

// 六害条件: 相邻易害,相隔难害
// ============================================================
// 三刑 (4 组 + 4 自刑) — 不协调互不相和有刑伤之意,横向矛盾
// 冲=正面冲突,刑=横向制约+直面冲突
// ============================================================

const SAN_XING = [
  { trio: ['丑', '未', '戌'], element: '土', energy: '最大', meaning: '受伤/牢狱/病灾/官司/突然死亡' },
  { trio: ['寅', '巳', '申'], element: '金', energy: '较大', meaning: '病灾/婚灾/车祸/官司(经典: 牢狱之灾)' },
  { pair: ['子', '卯'], element: '木', energy: '较小', meaning: '口舌争端/流产' },
];

const ZI_XING = [
  { pair: ['辰', '辰'], energy: '最小', meaning: '皮肉磕碰' },
  { pair: ['午', '午'], energy: '最小', meaning: '皮肉磕碰' },
  { pair: ['酉', '酉'], energy: '最小', meaning: '皮肉磕碰(经典: 金被日元所克=破财+感情不顺+肺部)' },
  { pair: ['亥', '亥'], energy: '最小', meaning: '皮肉磕碰' },
];

// ============================================================
// 破 (6 对) — 与六害类似,此处只列映射关系
// ============================================================

const LIU_PO = [
  { pair: ['子', '酉'] }, { pair: ['丑', '辰'] }, { pair: ['寅', '亥'] },
  { pair: ['卯', '午'] }, { pair: ['巳', '申'] }, { pair: ['未', '戌'] },
];

// ============================================================
// 查询函数
// ============================================================

function getRelations(zhi) {
  if (!DI_ZHI.includes(zhi)) return null;
  return {
    liu_he: LIU_HE.filter(r => r.pair.includes(zhi)),
    san_he: SAN_HE.filter(r => r.trio.includes(zhi)),
    san_hui: SAN_HUI.filter(r => r.trio.includes(zhi)),
    liu_chong: LIU_CHONG.filter(r => r.pair.includes(zhi)),
    liu_hai: LIU_HAI.filter(r => r.pair.includes(zhi)),
    san_xing: SAN_XING.filter(r => r.trio.includes(zhi)),
    zi_xing: ZI_XING.filter(r => r.pair[0] === zhi && r.pair[1] === zhi),
    liu_po: LIU_PO.filter(r => r.pair.includes(zhi)),
    element: WUXING[zhi],
    yin_yang: YIN_YANG[zhi],
  };
}

function analyzePillars(pillars) {
  // pillars: ['甲子', '乙丑', ...] 或 4 字数组
  const zhis = pillars.map(p => p.slice(-1)); // 提取每柱地支
  const result = {
    liu_he: [], san_he: [], san_hui: [], liu_chong: [], liu_hai: [], san_xing: [], liu_po: [],
  };

  // 检测六合 (相邻两柱地支)
  for (let i = 0; i < zhis.length - 1; i++) {
    const a = zhis[i], b = zhis[i + 1];
    const found = LIU_HE.find(r =>
      (r.pair[0] === a && r.pair[1] === b) || (r.pair[0] === b && r.pair[1] === a)
    );
    if (found) result.liu_he.push({ at: [i, i + 1], ...found });
  }

  // 检测三合
  SAN_HE.forEach(r => {
    const hits = r.trio.map(t => zhis.indexOf(t)).filter(i => i >= 0);
    if (hits.length === 3) result.san_he.push({ at: hits, ...r });
    else if (hits.length === 2) result.san_he.push({ at: hits, partial: true, ...r });
  });

  // 检测三会
  SAN_HUI.forEach(r => {
    const hits = r.trio.map(t => zhis.indexOf(t)).filter(i => i >= 0);
    if (hits.length === 3) result.san_hui.push({ at: hits, ...r });
    else if (hits.length === 2) result.san_hui.push({ at: hits, partial: true, ...r });
  });

  // 检测六冲 (必须相邻)
  for (let i = 0; i < zhis.length - 1; i++) {
    const a = zhis[i], b = zhis[i + 1];
    const found = LIU_CHONG.find(r =>
      (r.pair[0] === a && r.pair[1] === b) || (r.pair[0] === b && r.pair[1] === a)
    );
    if (found) result.liu_chong.push({ at: [i, i + 1], ...found });
  }

  // 检测六害 (相邻)
  for (let i = 0; i < zhis.length - 1; i++) {
    const a = zhis[i], b = zhis[i + 1];
    const found = LIU_HAI.find(r =>
      (r.pair[0] === a && r.pair[1] === b) || (r.pair[0] === b && r.pair[1] === a)
    );
    if (found) result.liu_hai.push({ at: [i, i + 1], ...found });
  }

  // 检测三刑
  // 2026-10-12 修: SAN_XING 里子卯刑用 pair 字段 (2 元), 旧代码只读 r.trio →
  // r.trio undefined.length 直接 TypeError, analyzePillars 一调就崩 (从没被真调过, 暗死)。
  SAN_XING.forEach(r => {
    const members = r.trio || r.pair;
    if (!Array.isArray(members)) return;
    if (members.length === 3) {
      const hits = members.map(t => zhis.indexOf(t)).filter(i => i >= 0);
      if (hits.length === 3) result.san_xing.push({ at: hits, ...r });
    } else if (members.length === 2) {
      const hits = members.map(t => zhis.indexOf(t)).filter(i => i >= 0);
      if (hits.length === 2) result.san_xing.push({ at: hits, ...r });
    }
  });

  // 自刑 (同柱重复)
  zhis.forEach((z, i) => {
    const same = zhis.indexOf(z) !== i;
    if (same) {
      const found = ZI_XING.find(r => r.pair[0] === z && r.pair[1] === z);
      if (found) result.san_xing.push({ at: [zhis.indexOf(z), i], ...found, type: '自刑' });
    }
  });

  // 检测破 (相邻)
  for (let i = 0; i < zhis.length - 1; i++) {
    const a = zhis[i], b = zhis[i + 1];
    const found = LIU_PO.find(r =>
      (r.pair[0] === a && r.pair[1] === b) || (r.pair[0] === b && r.pair[1] === a)
    );
    if (found) result.liu_po.push({ at: [i, i + 1], ...found });
  }

  return result;
}

module.exports = {
  DI_ZHI, WUXING, YIN_YANG,
  LIU_HE, SAN_HE, SAN_HUI, LIU_CHONG, LIU_HAI, SAN_XING, ZI_XING, LIU_PO,
  getRelations, analyzePillars,
};
