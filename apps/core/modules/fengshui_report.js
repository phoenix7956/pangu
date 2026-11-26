/**
 * modules/fengshui_report.js — 风水层的**生产层**
 *
 * 分工 (跟 repo 里既有的层一样):
 *   64i/fengshui/*  = 判据 (算什么, 依据是什么)
 *   本文件          = 渲染 (给模型看的那一段)
 *
 * 为什么必须有生产层 (2026-10-23 第 68 批的账):
 *   第 68 批把风水门的内核做出来了(命卦/宅卦/大游年/阳宅四要/三元九运, 1052 行),
 *   但**模型够不着** —— 没有工具、没进 LAYERS。
 *   ⇒ 「内核里很完整、模型看不见」= 等于没做。
 *
 * ⚠️ 这一层最要紧的一件事: **标身份**。
 *   风水层里混着三类来源不同的东西:
 *     ① 有逐字原文 —— 二十四向山表、大游年歌诀、阳宅四要四条、三元九运锚点
 *     ② 课上**图片**, 拿不到逐字原文 —— 「宅卦=坐山所属卦」、四吉四凶分组
 *     ③ 盘古**推导** —— 「一运 20 年 ⇒ 1864 起」、坐山/向的对宫
 *   不标的话, 主人问一句「这个哪本书上说的」就露馅 —— 而盘古答不出。
 *
 *   ⇒ 两个标签(定义在 64i/fengshui/index.js, 这里只引用):
 *     FENGSHUI_TAG             —— 整段的身份
 *     FENGSHUI_INTERPRETIVE_TAG —— 段内哪几条是解读/推导
 *
 * ⚠️ 正面式措辞, 不写禁令 (2026-10-21 实跑教训: 提示里出现的词会被模型原样搬去当开篇标签)。
 */

'use strict';

const fengshui = require('../64i/fengshui/index.js');

const FENGSHUI_TAG = fengshui.FENGSHUI_TAG;
const FENGSHUI_INTERPRETIVE_TAG = fengshui.FENGSHUI_INTERPRETIVE_TAG;

/**
 * 排一份风水盘, 渲染成模型看得见的文本块。
 *
 * @param {object} profile  64i/fengshui 的 fengshuiProfile() 结果
 * @returns {string} 空串 = 没有可渲染的东西
 */
function renderFengshuiReport(profile) {
  if (!profile || !profile.ok) return '';

  const lines = [];

  // ── 命卦 ──
  // ⚠️ 命卦对象**没有 ok 字段**(它是「要么算出来要么抛错」的纯函数) ——
  //   判 `profile.ming_gua.ok` 会永远判假 ⇒ 命卦那一行**静悄悄不出现**。
  //   本批已经踩过一次(第二次踩同一个形状): 判据里改对了, 渲染点里没改。
  if (profile.ming_gua && profile.ming_gua.gua) {
    lines.push('【命卦】' + profile.ming_gua.label + ' — ' + profile.ming_gua.group
      + (profile.ming_gua.note ? '（' + profile.ming_gua.note + '）' : ''));
  }

  // ── 宅卦 ──
  if (profile.zhai_gua) {
    if (profile.zhai_gua.ok) {
      lines.push('【宅卦】' + profile.zhai_gua.gua + '宅 — ' + profile.zhai_gua.group
        + '（坐' + (profile.zhai_gua.mountain || profile.zhai_gua.gua) + '）'
        + ' ' + FENGSHUI_INTERPRETIVE_TAG);
    } else {
      lines.push('【宅卦】' + (profile.zhai_gua.reason || '没定下来'));
    }
  }

  // ── 大游年盘 ──
  if (profile.dayun && profile.dayun.ok) {
    const d = profile.dayun;
    lines.push('【大游年】以' + d.gua + '起盘 — 歌诀「' + d.song + '」');
    for (const e of d.entries) {
      lines.push('  ' + e.direction + '(' + e.gua + ') = ' + e.star + ' ' + e.luck);
    }
    if (d.unknown && d.unknown.length) {
      lines.push('  ' + d.unknown.length + ' 个方位落成「未知」(既不在四吉表也不在四凶表) '
        + FENGSHUI_INTERPRETIVE_TAG);
    }
  }

  // ── 阳宅四要 ──
  if (profile.siYao && profile.siYao.ok) {
    const s = profile.siYao.siYao;
    for (const k of ['门', '主', '灶', '厕']) {
      const item = s[k];
      if (!item) continue;
      // ⚠️ 四项的**位置字段不一样**: 门/主/厕 是 `positions`,
      //   灶是「坐凶方、向吉方」两个字段(sit_positions / face_positions)。
      //   写成统一 `item.positions.map(...)` ⇒ 碰到灶就 `undefined.map` 抛异常,
      //   而整次工具调用被 catch 兜住 ⇒ 主人看到的是「工具失败」, 不是「灶那项渲染漏了」。
      //   ⇒ 按字段分别处理, 宁可多写两行, 不留这种一崩全崩的形状。
      if (k === '灶') {
        lines.push('【阳宅四要·' + k + '】' + item.rule + ' → ' + item.need
          + ' (坐: ' + (item.sit_positions || []).map((p) => p.direction).join('、')
          + ' | 向: ' + (item.face_positions || []).map((p) => p.direction).join('、') + ')');
        continue;
      }
      const pos = item.positions || [];
      lines.push('【阳宅四要·' + k + '】' + item.rule + ' → ' + item.need
        + (pos.length ? ' (' + pos.map((p) => p.direction).join('、') + ')' : ''));
    }
  }

  // ── 宅命相配 ──
  if (profile.match) {
    lines.push('【宅命相配】' + profile.match.verdict
      + '（' + profile.match.ming_group + ' × ' + profile.match.zhai_group + '）'
      + (profile.match.advice ? ' — ' + profile.match.advice : ''));
  }

  // ── 宅运 ──
  if (profile.house_yun) {
    lines.push('【宅运】' + (profile.house_yun.ok ? profile.house_yun.label : profile.house_yun.reason));
  }

  if (!lines.length) return '';
  return lines.join('\n') + '\n' + FENGSHUI_TAG;
}

module.exports = {
  renderFengshuiReport,
  FENGSHUI_TAG,
  FENGSHUI_INTERPRETIVE_TAG,
};
