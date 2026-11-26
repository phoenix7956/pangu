/**
 * modules/najia_bridge.js — 纳甲搭桥的**生产层**
 *
 * 分工 (跟 repo 里既有的层一样):
 *   64i/bagua_annotations/najia_bridge.js  = 判据 (算什么, 依据是什么)
 *   本文件                                = 渲染 + 取数 (给模型看的那一段)
 *
 * 为什么必须有生产层 (2026-10-23 实测):
 *   · 桥的**判据**在 64i 里躺着, 但 `LAYERS.bridge.tools = []` —— 桥没有入口。
 *   · 于是「什么时候串起来用」这个问题, 盘古只能**嘴上回答**: 探测器判出 combo,
 *     给模型看一行「卦给方向, 干支五行给落地, 纳甲搭桥」, 然后**没有然后**。
 *   · 模型手里只有 gua_cast(卦) 和 bazi_calc(干支), 两个工具各给各的,
 *     「搭」这个动作从来没发生过 —— 它只能自己脑补, 或者干脆不提。
 *
 * 这一层把桥**真的搭起来**: 从主人这一轮的话里取出日主(和月支),
 * 跟卦接上, 产出一段**模型看得见的**桥接材料。
 *
 * ⚠️ 三条纪律:
 *   ① **只解释, 不改行为** —— 桥接失败/没有生辰, 一律不阻断主流程。
 *      (同 layer_plan.js 的纪律: 探测器坏了不能连带起卦坏。)
 *   ② **两把尺子都要给** —— 六亲那列的「我」是京房宫五行, 生泄克耗那列的「我」是日主。
 *      只给一列, 模型必然把京房六亲当成「这个人的六亲」讲出去。
 *   ③ **不给用神结论** —— 桥只给材料, 取用神由模型自己说明依据。
 *      (见 64i 那层的 limits。)
 */

'use strict';

const path = require('path');

const bridgeKernel = require(path.join(__dirname, '..', '64i', 'bagua_annotations', 'najia_bridge.js'));

const BRIDGE_TAG = bridgeKernel.BRIDGE_TAG;

const YAO_NAMES = ['初爻', '二爻', '三爻', '四爻', '五爻', '上爻'];

/**
 * 从**一段文本**里取「日主 + 月支」。
 *
 * ⚠️ 这条路只对「文本里已经有干支四柱」的情况有效
 *   (比如主人直接写「甲子年 乙丑月 丙寅日 …」, 或上一轮模型把四柱写进对话了)。
 *   主人给**公历生日**(1990年3月15日)时这条路**取不到** —— 公历生日要排盘才有四柱,
 *   而排盘是 bazi_calc 的活(真万年历), 不是文本正则能干的。
 *   ⇒ 那种情况走 `extractSubjectFromChart`: 从**模型已经调过的 bazi_calc 结果**里取。
 *
 * 为什么用 bazi_chart_facts.extractPillars 而不是自己写正则:
 *   它已经处理了**四柱抽取的两种难点**, 自己重写等于再造一份会漂的:
 *     ① 柱序倒置(时日月年) —— 它有「日主可信度闸」按声明的日主校准
 *     ② 「非本命盘」上下文(大运/流年/纳音/卦/节气) —— 它有 nativeScopeText 排除
 *   那是 2026-10-12 一次实跑事故(首轮纯图做题, 柱序猜错 ⇒ 整盘错)逼出来的。
 *
 * ⚠️ **四柱没抽到就返回 null**, 不猜、不用「日主X」这种半截声明硬凑。
 *
 * @param {string} text 主人的这一轮原话 (或对话上下文)
 * @returns {{dayMaster:string, monthZhi:string, pillars:string[], orderAssumed:?}|null}
 */
function extractBridgeSubject(text) {
  let chart = null;
  try {
    const cf = require('./bazi_chart_facts.js');
    chart = cf.extractPillars(text);
  } catch (_) { return null; }
  if (!chart || !chart.pillars || chart.pillars.length < 3) return null;

  const pillars = chart.pillars;
  const dayPillar = pillars[2];
  const monthPillar = pillars[1];
  if (!dayPillar || typeof dayPillar !== 'string' || dayPillar.length < 1) return null;

  return {
    dayMaster: dayPillar[0],
    monthZhi: (monthPillar && typeof monthPillar === 'string' && monthPillar.length >= 2)
      ? monthPillar[1] : null,
    pillars,
    orderAssumed: chart.orderAssumed || null,
  };
}

/**
 * 从**一份 bazi_calc 的排盘结果**里取「日主 + 月支」。
 *
 * 这是桥的**正规来路**: 主人给公历生日 → 模型调 bazi_calc → 拿到真盘 →
 * 桥拿这个盘当「干支那一头」跟卦接上。
 *
 * ⚠️ 字段名必须跟 bazi_calc.py 的真实输出对齐(实测):
 *   `day_master` (日主天干), `month_branch` (月支),
 *   `pillars` (dict: 年柱/月柱/日柱/时柱), `day_master_wuxing`。
 *   ⚠️ 别拿 `month_zhi` —— 那是 python 里的**局部变量名**, 不在返回 dict 里。
 *     (实测 `pillars.month_zhi` 是 undefined, 拿它当月支 = 旺衰整列静默变 null。)
 *
 * @param {object} chart bazi_calc 的 data (或 data.pillars)
 * @returns {{dayMaster:string, monthZhi:?string}|null}
 */
function extractSubjectFromChart(chart) {
  if (!chart || typeof chart !== 'object') return null;
  //
  // ⚠️ 三种形状都要吃下 (实测这三种真的都会来):
  //   ① bazi_calc 的 data       → { pillars: {年柱,月柱,日柱,时柱}, day_master, month_branch, ... }
  //   ② bazi_calc 的 data.pillars → { 年柱, 月柱, 日柱, 时柱, day_master, month_branch, ... }
  //   ③ 账本 collectCastCharts  → { pillars: {年柱,月柱,日柱,时柱} }  ← 只有四柱字典
  //
  // ③ 是**最常见**的那条 (桥接生产路径走它), 而它**没有** day_master 字段
  //    —— 日主只能从「日柱」的天干取。所以下面三条取法都得试。
  const p = (chart.pillars && typeof chart.pillars === 'object') ? chart.pillars : chart;

  let dayMaster = p.day_master || chart.day_master || null;
  let monthZhi = p.month_branch || chart.month_branch || null;

  // 兜底 A: p 自己就是四柱字典 (形状 ③) —— 日柱天干 / 月柱地支
  if (!dayMaster) {
    const day = p['日柱'];
    if (typeof day === 'string' && day.length >= 1) dayMaster = day[0];
  }
  if (!monthZhi) {
    const mon = p['月柱'];
    if (typeof mon === 'string' && mon.length >= 2) monthZhi = mon[1];
  }
  // 兜底 B: p.pillars 里还有一层四柱字典
  if (!dayMaster && p.pillars && typeof p.pillars === 'object') {
    const day = p.pillars['日柱'];
    if (typeof day === 'string' && day.length >= 1) dayMaster = day[0];
  }
  if (!monthZhi && p.pillars && typeof p.pillars === 'object') {
    const mon = p.pillars['月柱'];
    if (typeof mon === 'string' && mon.length >= 2) monthZhi = mon[1];
  }

  const GAN = '甲乙丙丁戊己庚辛壬癸';
  if (!dayMaster || GAN.indexOf(dayMaster) < 0) return null;
  return { dayMaster, monthZhi: monthZhi || null };
}

/**
 * 渲染桥接材料 (模型看得见的那一段)。
 *
 * 格式刻意**一行一爻**, 不用表格 —— 模型读表格容易串列, 而这里恰恰是两列
 * 「我」不同的两把尺子, 一行一爻 + 列名固定, 最不容易读串。
 *
 * @param {object} bridge 64i 层 bridgeGuaWithDayMaster 的返回值
 * @returns {string} 空串 = 没有可渲染的内容
 */
function renderBridgeBlock(bridge) {
  if (!bridge || !bridge.ok || !Array.isArray(bridge.yao)) return '';

  const lines = [];
  lines.push('【纳甲搭桥】卦 ' + bridge.guaId + ' × 日主 ' + bridge.dayMaster
    + '(' + bridge.dayMasterWuxing + ')'
    + (bridge.monthZhi ? ' × 月令 ' + bridge.monthZhi + '(' + bridge.monthWuxing + ')' : '')
    + ' —— 逐爻: 纳甲干支 | 六亲(我=京房宫五行) | 与日主的生泄克耗(我=日主) | 月令旺衰态');

  for (const y of bridge.yao) {
    const name = YAO_NAMES[y.pos - 1] || ('第' + y.pos + '爻');
    if (!y.ganzhi) {
      lines.push('  ' + name + ': (装不出纳甲 — ' + (y.missingReason || '原因未给出') + ')');
      continue;
    }
    const parts = [
      name,
      y.ganzhi + '(' + (y.zhiWuxing || '?') + ')',
      '六亲=' + (y.liuQin || 'null'),
      '生泄克耗=' + (y.relationToDayMaster || 'null'),
    ];
    if (y.wangXiangXiuQiuSi) parts.push('月令下=' + y.wangXiangXiuQiuSi);
    if (y.moving) parts.push('**动爻**');
    lines.push('  ' + parts.join(' | '));
  }

  lines.push('  两把尺子: 六亲那列的「我」= ' + bridge.measures.liuQin.self
    + '(' + bridge.measures.liuQin.note + '); 生泄克耗那列的「我」= '
    + bridge.measures.relationToDayMaster.self + '(' + bridge.measures.relationToDayMaster.note + ')。');
  for (const lim of bridge.limits) lines.push('  ' + lim);
  lines.push('  ' + BRIDGE_TAG);

  return lines.join('\n');
}

/**
 * 生产入口: 给一个卦 + 一头干支, 搭桥。
 *
 * 「干支那一头」有两个来源, 优先级:
 *   ① `opts.chart`  —— **bazi_calc 的排盘结果**(正规来路, 真万年历排的盘)
 *   ② `opts.text`   —— 文本里已有的干支四柱(次要来路)
 *
 * ⚠️ 两个都没有 ⇒ **不搭**。桥需要日主才有「另一头」;
 *   拿「主人好像说了生辰」去猜一个日主 = 编造盘, 那正是盘古最重的病。
 *
 * @param {object} opts
 * @param {number} opts.guaId       卦序 1..64
 * @param {object} [opts.chart]      bazi_calc 的 data
 * @param {string} [opts.text]       主人的话
 * @param {number} [opts.movingYao]  动爻位
 * @returns {{ok:boolean, block?:string, reason?:string, bridge?:object}}
 */
function buildBridgeBlock(opts) {
  const o = opts || {};
  let subject = o.subject || null;
  if (!subject && o.chart) subject = extractSubjectFromChart(o.chart);
  if (!subject && o.text) subject = extractBridgeSubject(o.text);
  if (!subject) {
    return {
      ok: false,
      reason: '取不到干支那一头(日主) —— 桥需要日主才有另一头; '
        + '先把 bazi_calc 排的盘拿过来, 或在对话里给出四柱干支',
    };
  }

  let bridge;
  try {
    bridge = bridgeKernel.bridgeGuaWithDayMaster({
      guaId: o.guaId,
      dayMaster: subject.dayMaster,
      monthZhi: subject.monthZhi || undefined,
      movingYao: o.movingYao,
    });
  } catch (e) {
    return { ok: false, reason: '桥接内核抛错: ' + e.message };
  }
  if (!bridge.ok) {
    return { ok: false, reason: bridge.error ? (bridge.error.code + ': ' + bridge.error.message) : '桥接失败' };
  }

  const block = renderBridgeBlock(bridge);
  if (!block) return { ok: false, reason: '桥接结果渲染为空' };
  return { ok: true, block, bridge, subject };
}

module.exports = {
  BRIDGE_TAG,
  extractBridgeSubject,
  extractSubjectFromChart,
  renderBridgeBlock,
  buildBridgeBlock,
};
