/**
 * 64i/bagua_annotations/najia_bridge.js
 * 纳甲搭桥 —— 把「卦」和「干支五行」真正接起来的那一步
 *
 * 起因 (老板 2026-10-23 原话, 一字不改):
 *   「所以, 现在的盘古到底是什么情况? 要怎么处理?
 *      什么时候用阴阳五行八卦, 什么时候 64卦+6爻? 什么时候串起来用?」
 *
 * 这个模块回答的是**后半句的实体**: 「串起来用」。
 *
 * 此前「串起来」只有**判据**, 没有**实体**:
 *   · 64i/bagua_annotations/layer_plan.js 的 LAYERS.bridge 写着
 *     「串起来(纳甲搭桥)」, 依据是 najia + liu_qin —— 但它的 `tools: []`
 *     (空!)。**桥没有入口工具** ⇒ 模型被告知「纳甲搭桥」,
 *     手里却只有 gua_cast 和 bazi_calc 两个各自独立的工具,
 *     「搭」这个动作从来没发生过。
 *   · 两侧能力其实都齐了, 缺的是**中间那一步**:
 *     卦侧: 纳甲装卦(每爻装出干支)、京房六亲、64卦辞爻辞、动爻、世应
 *     干支侧: 日主五行、月令、四柱五行分布、旺衰六格
 *   ⇒ 本模块就是那一步。
 *
 * ═══════════════════════════════════════════════════════════════
 * 桥接的判据 (每一段都有出处, 不自己编)
 * ═══════════════════════════════════════════════════════════════
 *
 *   ① 纳甲装卦 —— 爻位 ↔ 干支
 *      出处: 64i/bagua_annotations/najia.js (第 41 批, 四源交叉验证,
 *      384/384 爻位全装得出)。本模块**只调用**, 不重抄任何一张表。
 *
 *   ② 六亲 —— 爻位 ↔ 六亲
 *      出处: 64i/bagua_annotations/liu_qin.js (京房口径: 宫五行=我,
 *      该爻纳甲地支五行=他)。本模块**只调用**。
 *
 *   ③ 爻位地支五行 ↔ 日主五行的生克关系
 *      出处: 《三命通会》「以日干论甲乙…生我者壬癸水, 我生者丙丁火,
 *      克我者庚辛金, 我克者戊己土」(已在 64i/sources/smt_gan_liuge.txt
 *      逐字切片, source_id=smt_gan_liuge, 行 3794-3800)。
 *      关系矩阵取自 wuxing_axioms.js 的 WUXING_RELATION_MATRIX (25 格全满)。
 *
 *   ④ 旺相休囚死 —— 爻上地支在月令下的状态
 *      出处: 《三命通会》「论五行旺相休囚死并寄生十二宫」
 *      (行 1500 起)。判据原文:
 *        「盛德乘时曰旺。如春木旺, 旺则生火, 火乃木之子…故火相;
 *          木用水生, 生我者父母…而生我者当知退矣, 故水休。
 *          火能克金, 金乃木之鬼, 被火克制, 不能施设, 故金囚;
 *          火能生土, 土为木之财…所以春木克土则死。」
 *      ⇒ 相对**月令五行**论: 同我=旺, 我生=相, 生我=休, 克我=囚, 我克=死。
 *      ⚠️ 这一条是**月令五行的旺衰**, 不是爻本身的旺衰 ——
 *         它给的是「这个爻的地支五行, 在月令这个季节里是什么处境」。
 *         爻在月建下的旺衰是另一套更细的判据(需要日/月/时三合), 本模块不碰,
 *         也不许模型拿这个当「爻旺」讲(见下方 NOT_YAO_WANGSHENG 的警告)。
 *
 *   ⑤ 用神爻的取法 —— **本模块不自己定**
 *      「取用神」有多种传统取法(世爻/六亲/动爻/卦宫), 各家不一。
 *      本仓库里只有 tiyong_axioms.js (梅花体用), 那是**体用**不是六爻用神,
 *      两者不是一回事, 拿来套就是拿一套体系冒充另一套。
 *      ⇒ 本模块**只给材料**(每爻的干支/六亲/地支五行/与日主的生克/旺衰态),
 *         **不给「哪一爻是用神」的结论**。要取用神, 模型必须自己说明依据。
 *      这不是保守, 是这层的纪律: 没给的判据, 模型不许自己编一个(同六亲的 null 纪律)。
 *
 * ═══════════════════════════════════════════════════════════════
 * 这层不是「新的断语」
 * ═══════════════════════════════════════════════════════════════
 *
 *   「纳甲把卦接到干支上」这句本身是**盘古的编排设计**(老板 10-23 裁定),
 *   不是典籍断语 ⇒ 见 provenance.js 里 layer_plan 那条 interpretive 登记。
 *   本模块的**每一段判据**都有源(①②③④), 组合方式是编排。
 *   身份标签: BRIDGE_TAG —— 生产层渲染时必须带上, 见 provenance P12 守卫。
 *
 * ⚠️ 边界纪律 (与 yao_layer_boundary.js 同一规矩):
 *   本模块**只做卦层 ↔ 干支层的连接**。
 *   它不判吉凶(那是卦辞爻辞 + 体用的事)、不判用神(见上)、
 *   不做合婚(那是两个日主的事, 由 bazi_calc + 六格负责)。
 */

'use strict';

const path = require('path');

const najia = require(path.join(__dirname, 'najia.js'));
const liuQin = require(path.join(__dirname, 'liu_qin.js'));
const wuxingAxioms = require(path.join(__dirname, 'wuxing_axioms.js'));

// ============================================================
// 身份标签 (与 layer_plan.js / task_judge.js 同一套做法)
// ============================================================

/**
 * 用**正面式**措辞 (不复述坑日志那条「禁令等于喂给模型」的教训):
 * 身份是事实, 模型照事实说话就够了。
 */
const BRIDGE_TAG = '〔纳甲搭桥为盘古编排设计, 判据逐段有典籍出处〕';

// ============================================================
// 常量
// ============================================================

/** 爻位: 1..6, 1=初爻, 6=上爻 (与 najia.getYaoGanzhi 的 pos 口径一致) */
const YAO_POSITIONS = Object.freeze([1, 2, 3, 4, 5, 6]);

/**
 * 旺相休囚死五态 —— 相对**月令五行**论, 出处见文件头 ④。
 *
 * 顺序即强度: 旺 > 相 > 休 > 囚 > 死。
 */
const WANG_XIANG_XIU_QIU_SI = Object.freeze({
  旺: '旺',
  相: '相',
  休: '休',
  囚: '囚',
  死: '死',
});

/** 五态的强度序 —— 用于排序, 不用于打分数 */
const _WXS_STRENGTH_ORDER = Object.freeze({
  旺: 5, 相: 4, 休: 3, 囚: 2, 死: 1,
});

// ============================================================
// 内部工具
// ============================================================

/**
 * 地支 → 五行。
 *
 * ⚠️ **不走 wuxing_map**: 那张表是按 64 卦编号建的 (`WUXING_MAP` 的键是 1..64),
 *   `getWuxing('子')` 返回的是**第 64 卦**的五行(实测 = 土), 不是子水的五行。
 *   拿它取地支五行 = 静默给错值(踩坑日志:「尺子本身错了」那一类)。
 * ⇒ 地支五行走**纳甲自己给的 `wuxing` 字段** (najia.getYaoGanzhi 返回
 *   `{ ok, pos, ganzhi, tiangan, dienzhi, wuxing, yin_yang }`,
 *   那个 wuxing 是该爻纳甲地支的五行, 是 64i 真源)。
 *   月令地支没有纳甲可用 ⇒ 另走十神层同源的地支五行表 (见 _monthWuxing)。
 */

/**
 * 月支 → 五行。
 * 月支不在卦里, 没有纳甲可查 ⇒ 走 64i/bazi/zhis_relations.js (八字层真源)。
 */
function _monthWuxing(zhi) {
  try {
    const zr = require(path.join(__dirname, '..', 'bazi', 'zhis_relations.js'));
    const w = (zr.WUXING || {})[zhi];
    return typeof w === 'string' ? w : null;
  } catch (_) {
    return null;
  }
}

/** 五行 → 旺相休囚死: 相对月令五行论 */
function _wangXiangXiuQiuSi(selfWuxing, monthWuxing) {
  if (!selfWuxing || !monthWuxing) return null;
  //
  // ⚠️ getRelation(我, 他) 返回的是**四态**, 不是三态:
  //   'sheng'(我生他) / 'bei_sheng'(他生我) / 'ke'(我克他) / 'bei_ke'(他克我) / 'tong'(同我)
  //   (见 wuxing_axioms.js 的 RELATIONS 与 5×5 矩阵: 25 格恰好被这五类填满)
  // ⇒ 写 'sheng'/'ke'/'tong' 三个分支会把**反向关系整片漏掉** ——
  //   初版就是这么写的, 结果旺衰判据全错(测试当场逮住: 金该「死」判成了「囚」)。
  //
  // 旺相休囚死的口径 (《三命通会》「盛德乘时曰旺…故火相…故水休…故金囚…则死」),
  //   **以月令五行为「我」**:
  //     同我者 旺 · 我生者 相 · 生我者 休 · 克我者 囚 · 我克者 死
  //   ⇒ 判「爻的纳甲地支五行(自)在月令(我)面前是什么处境」:
  //     getRelation(月令, 爻) = 'tong' → 旺(同我)
  //     getRelation(月令, 爻) = 'sheng' → 相(月令生爻 = 我生者)
  //     getRelation(月令, 爻) = 'bei_sheng' → 休(爻生月令 = 生我者)
  //     getRelation(月令, 爻) = 'bei_ke' → 囚(爻克月令 = 克我者)
  //     getRelation(月令, 爻) = 'ke' → 死(月令克爻 = 我克者)
  const rel = wuxingAxioms.getRelation(monthWuxing, selfWuxing);
  switch (rel) {
    case 'tong': return WANG_XIANG_XIU_QIU_SI.旺;        // 同我者旺 (乘时)
    case 'sheng': return WANG_XIANG_XIU_QIU_SI.相;       // 我生者相 (月令生爻)
    case 'bei_sheng': return WANG_XIANG_XIU_QIU_SI.休;   // 生我者休 (爻生月令)
    case 'bei_ke': return WANG_XIANG_XIU_QIU_SI.囚;      // 克我者囚 (爻克月令)
    case 'ke': return WANG_XIANG_XIU_QIU_SI.死;          // 我克者死 (月令克爻)
    default: break;
  }
  return null;
}

/**
 * 爻上地支五行 ↔ 日主五行的关系标签 (出处在文件头 ③)。
 *
 * 口径: **日主=我**, 爻的纳甲地支=他。
 *   生我者 → 生
 *   我生者 → 泄
 *   克我者 → 克
 *   我克者 → 耗
 *   同我者 → 同
 *
 * ⚠️ 这里给的是**关系**, 不是「这一爻好不好」。
 *   「我生者=泄」不代表这条爻不吉利(泄在有些格局里正是「我生者为食伤,
 *   食伤泄秀」的通路)—— 强弱与吉凶由上层结合旺衰与卦辞断, 本层不越界。
 */
function _relationToDayMaster(dayMasterWuxing, yaoWuxing) {
  if (!dayMasterWuxing || !yaoWuxing) return null;
  // ⚠️ 同上: getRelation 是**四态**矩阵, 五个关系各有各的标签, 不能只认三个。
  const rel = wuxingAxioms.getRelation(dayMasterWuxing, yaoWuxing);
  switch (rel) {
    case 'bei_sheng': return '生';   // 爻生我 = 生我者
    case 'bei_ke': return '克';      // 爻克我 = 克我者
    case 'tong': return '同';    // 同我者
    case 'sheng': return '泄';       // 我生爻 = 我生者(泄)
    case 'ke': return '耗';          // 我克爻 = 我克者(耗)
    default: break;
  }
  return null;
}

// ============================================================
// 主函数
// ============================================================

/**
 * 把一个卦和一个日主接起来。
 *
 * @param {object} opts
 * @param {number} opts.guaId          卦序 1..64 (文王卦序: 乾=1 坤=2)
 * @param {string} opts.dayMaster       日主天干 (甲乙丙丁戊己庚辛壬癸)
 * @param {string} [opts.monthZhi]     月支 (子丑寅卯辰巳午未申酉戌亥) —— 旺衰要用
 * @param {number} [opts.movingYao]    动爻位 (1..6) —— 只标注, 不参与判据
 * @returns {object} 桥接结果 (见下方 shape 说明)
 *
 * 返回 shape:
 *   {
 *     ok: true,
 *     guaId, guaName?, dayMaster, dayMasterWuxing, monthZhi?, monthWuxing?,
 *     yao: [ { pos, ganzhi, zhi, zhiWuxing, liuQin, relationToDayMaster,
 *              wangXiangXiuQiuSi, moving? } x6 ],
 *     coverage: { yaoLoadable, yaoTotal },
 *     basis: {...},        // 判据出处, 逐段
 *     limits: [...],       // 本层**没有**的东西 (不许模型自己补)
 *     tag: BRIDGE_TAG,
 *   }
 *   或 { ok: false, error: { code, message } }
 */
function bridgeGuaWithDayMaster(opts) {
  const o = opts || {};
  const guaId = Number(o.guaId);
  const dayMaster = String(o.dayMaster || '').trim();

  if (!Number.isInteger(guaId) || guaId < 1 || guaId > 64) {
    return {
      ok: false,
      error: {
        code: 'BAD_GUA_ID',
        message: '卦序必须是 1..64 的整数 (文王卦序: 乾=1 坤=2); 收到: ' + o.guaId,
      },
    };
  }

  const GAN = '甲乙丙丁戊己庚辛壬癸';
  if (!GAN.includes(dayMaster) || dayMaster.length !== 1) {
    return {
      ok: false,
      error: {
        code: 'BAD_DAY_MASTER',
        message: '日主必须是十天干之一 (甲乙丙丁戊己庚辛壬癸); 收到: ' + JSON.stringify(o.dayMaster),
      },
    };
  }

  // 日主五行 —— 走十神层真源 (64i/bazi/ten_gods.js), 不自己抄「甲乙木」那张表
  const tenGods = require(path.join(__dirname, '..', 'bazi', 'ten_gods.js'));
  const dayMasterWuxing = (tenGods.WUXING || {})[dayMaster] || null;
  if (!dayMasterWuxing) {
    return {
      ok: false,
      error: {
        code: 'BAD_DAY_MASTER',
        message: '日主 ' + dayMaster + ' 查不到五行 —— 十神层真源里没有这一支',
      },
    };
  }

  // 月令 (旺衰要用) —— 缺了就**不猜**: 旺衰整项给 null + 理由
  let monthWuxing = null;
  const monthZhi = o.monthZhi ? String(o.monthZhi).trim() : '';
  if (monthZhi) {
    const ZHI = '子丑寅卯辰巳午未申酉戌亥';
    if (!ZHI.includes(monthZhi) || monthZhi.length !== 1) {
      return {
        ok: false,
        error: {
          code: 'BAD_MONTH_ZHI',
          message: '月支必须是十二地支之一; 收到: ' + JSON.stringify(o.monthZhi),
        },
      };
    }
    monthWuxing = _monthWuxing(monthZhi);
  }

  // 逐爻
  const yao = [];
  let yaoLoadable = 0;
  for (const pos of YAO_POSITIONS) {
    const nz = najia.getYaoGanzhi(guaId, pos);
    if (!nz || nz.ok === false) {
      // 装不出纳甲 ⇒ 这一爻的材料缺失, **推算填** (与六亲同一纪律)
      yao.push({
        pos,
        ganzhi: null,
        zhi: null,
        zhiWuxing: null,
        liuQin: null,
        relationToDayMaster: null,
        wangXiangXiuQiuSi: null,
        missingReason: (nz && nz.error && nz.error.message)
          ? nz.error.message
          : '这一爻装不出纳甲 (查无出处, 不推算填)',
      });
      continue;
    }
    yaoLoadable++;

    // 纳甲返回形状 (实测): { ok, pos, ganzhi, tiangan, dienzhi, wuxing, yin_yang }
    const ganzhi = nz.ganzhi || null;
    const zhi = nz.dienzhi || (ganzhi && ganzhi.length >= 2 ? ganzhi.slice(-1) : null);
    // 该爻纳甲地支的五行 —— 取纳甲自带的 wuxing (真源), 不自己查表
    const zhiWuxing = typeof nz.wuxing === 'string' ? nz.wuxing : null;

    // 六亲 —— 走 liu_qin (京房口径), 不自己算
    let lq = null;
    try {
      // computeLiuQin(guaId, yaoPosition) —— 注意爻位是 **0 基**(0..5),
      // 而纳甲 getYaoGanzhi 是 **1 基**(1..6)。这两套基号不一样, 混用直接错位一爻。
      const r = liuQin.computeLiuQin(guaId, pos - 1);
      lq = (r && typeof r === 'object') ? (r.liuQin || r.label || r.name || null) : (r || null);
    } catch (_) { lq = null; }

    yao.push({
      pos,
      ganzhi,
      zhi,
      zhiWuxing,
      liuQin: lq,
      relationToDayMaster: _relationToDayMaster(dayMasterWuxing, zhiWuxing),
      wangXiangXiuQiuSi: monthWuxing ? _wangXiangXiuQiuSi(zhiWuxing, monthWuxing) : null,
      moving: (o.movingYao !== undefined && o.movingYao !== null && Number(o.movingYao) === pos),
    });
  }

  const limits = [
    '本层只给材料(每爻的干支/六亲/地支五行/与日主的生克/月令旺衰态), '
      + '**不给「哪一爻是用神」的结论** —— 取用神有多种传统取法, 本仓库只有梅花体用, '
      + '那是体用不是六爻用神, 拿来套就是拿一套体系冒充另一套。要取用神必须自己说明依据。',
    '旺相休囚死是「爻的纳甲地支五行在月令这个季节里的处境」, '
      + '**不是爻本身的旺衰**(那需要日/月/时三合, 本层不碰)。',
    '本层不判吉凶 —— 吉凶是卦辞爻辞 + 体用的事; 也不做合婚 —— 那是两个日主的事。',
  ];

  /**
   * ⚠️⚠️ **两列里的「我」不是同一个我** —— 这是本桥最危险的一点。
   *
   *   · `liuQin`(六亲): 「我」= **京房宫五行** (乾宫 = 金)。
   *     这是卦层自己的口径: 同一宫 8 卦的六亲**相同**, 因为宫不变。
   *     源: 64i/bagua_annotations/liu_qin.js (第 30 批定的口径)。
   *
   *   · `relationToDayMaster`(生泄克耗): 「我」= **日主** (甲木)。
   *     这是干支层的口径: 随主命变, 同一卦换个人主, 这一列全变。
   *     源: 《三命通会》「以日干论甲乙…」(smt_gan_liuge)。
   *
   *   ⇒ 两列**可以同时成立且互相独立**: 乾卦初爻纳甲子(水),
   *     以乾宫金为「我」→ 子孙(金生水, 我生者子孙);
   *     以甲木日主为「我」→ 泄(木生水, 我生者泄)。
   *     **不是矛盾, 是两把尺子量两个对象。**
   *
   *   ⇒ 所以渲染时**必须**把两把尺子都写出来, 不许只给一列 ——
   *     只给一列, 模型必然把「京房六亲」当成「这个人(日主)的六亲」讲出去,
   *     那就是拿卦层的口径冒充干支层的口径(踩坑日志: 两套口径混用那一族)。
   */
  const measures = {
    liuQin: {
      self: '京房宫五行 (' + _gongWuxingLabel(guaId) + ')',
      selfKind: '卦层(宫)',
      note: '同宫 8 卦六亲相同 —— 宫不变, 这列就不随主人变',
    },
    relationToDayMaster: {
      self: '日主 ' + dayMaster + '(' + dayMasterWuxing + ')',
      selfKind: '干支层(日主)',
      note: '随主命变 —— 同一卦换个人主, 这一列全变',
    },
  };

  return {
    ok: true,
    guaId,
    dayMaster,
    dayMasterWuxing,
    monthZhi: monthZhi || null,
    monthWuxing,
    yao,
    coverage: { yaoLoadable, yaoTotal: YAO_POSITIONS.length },
    measures,
    basis: {
      najia: '64i/bagua_annotations/najia.js (第 41 批, 四源交叉验证, 384/384 爻位)',
      liuQin: '64i/bagua_annotations/liu_qin.js (京房口径: 宫五行=我, 纳甲地支五行=他)',
      relation: '《三命通会》「以日干论甲乙…生我者壬癸水, 我生者丙丁火, 克我者庚辛金, 我克者戊己土」'
        + ' (64i/sources/smt_gan_liuge.txt 行 3794-3800) + wuxing_axioms.js 关系矩阵',
      wangXiang: '《三命通会》「论五行旺相休囚死并寄生十二宫」'
        + ' (64i/sources/zhougui_shangjing.txt 同源经典, 行 1500 起)',
      dayMasterWuxing: '64i/bazi/ten_gods.js (日主天干的五行真源)',
    },
    limits,
    tag: BRIDGE_TAG,
  };
}

/** 卦的京房宫五行标签 —— 只用于说明「六亲那列的我是谁」 */
function _gongWuxingLabel(guaId) {
  try {
    const jb = require(path.join(__dirname, 'jingfang_bagong.js'));
    const g = jb.getJingfang(guaId);
    if (g && (g.gong_wuxing || g.gongWuxing)) {
      // 实测字段: { gong:'乾', gong_wuxing:'金', wei, gua_id, gua_name, shi, ying }
      return (g.gong || '') + '宫 ' + (g.gong_wuxing || g.gongWuxing);
    }
  } catch (_) { /* 拿不到就只给宫五行, 不猜 */ }
  return '宫五行';
}

module.exports = {
  BRIDGE_TAG,
  YAO_POSITIONS,
  WANG_XIANG_XIU_QIU_SI,
  bridgeGuaWithDayMaster,
};
