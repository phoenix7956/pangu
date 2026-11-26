'use strict';

/**
 * modules/markdown_list.js —— 有序列表编号的判据与剥除。
 *
 * ── 为什么它住在 core (2026-10-26 第 107 批) ──────────────────────────
 *   这条规则原本住在 `apps/desktop/src/lib/markdown-list.js`。桌面端下线时搬到 core,
 *   理由: **规则比界面活得久**。盘古对外的答复本来就是 markdown 文本
 *   (`/api/chat` 直接回 markdown), 任何客户端渲染它都要这条判据 ——
 *   规则放在界面目录里, 等于「谁做界面谁负责别吃用户的字」,
 *   而吃字是**静默**的, 没人会想到去界面目录里找判据。
 *
 * ── 修的是什么 (2026-10-19 老板:「1991被吃了?」) ─────────────────────
 *   用户原话是「1991、11、23 20时05分 女 江苏盐城，做八字排盘」,
 *   界面上显示成「11. 23 20时05分 …」—— 自己打的字, 显示回来少了一截。
 *   后端 session 存盘逐字完整、盘古也算对了 1991 年, 所以被改的只有渲染。
 *
 *   元凶是旧判据 (实测正则, 非推测): 行首是「数字 + . 或 ) 或 顿号」就当列表编号,
 *   后跟任意空白 (即 `^\s*\d+[.、)]\s*` 那一族)。
 *   「1991、」开头是「数字 + 顿号」→ 判定为列表编号 → 整段 replace 掉。
 *   同一行正则还顺手吃别的: 「3.14 是圆周率」丢「3.」, 变成「14 是圆周率」。
 *   凡是行首的年份、小数、编号连写, 都会少一截 —— 而且是**静默**少, 没人报错。
 *
 *   定修法的账 (实数 ~/.pangu/memory, 不是估的):
 *       ASCII 序号 (1. / 2))     2967 条
 *       中文序号 (1、内容)           52 条
 *   改严的代价 = 那 52 条退化成普通段落: 排版差一点, **一个字都不少**。
 *   不改的代价 = 主人亲手打的话被静默删除。
 *   这个不对等, 所以往严了改。三条约束一起上:
 *     ① 编号后必须有空白 (或行尾) —— 「1. 内容」认, 「3.14」「1.5寸」不认。
 *     ② 编号位数封顶 —— 「1991、」是四位年份, 不可能是列表序号。
 *     ③ 中文顿号后不许紧跟数字 —— 「11、23」「2024、2025」是日期/编号, 不是列表。
 */

// ASCII: 点 / 右括号 + 必须有空白。位数封顶 3, 挡住 1991 这类年份。
const ORDERED_ASCII = /^\s*\d{1,3}[.)](?:\s+|$)/;
// 中文顿号: 位数封顶 2 (真序号都是个位数或十位数), 且顿号后不许紧跟数字。
const ORDERED_CJK = /^\s*\d{1,2}、(?!\d)\s*/;

const STRIP_ASCII = /^\s*\d{1,3}[.)]\s+/;
const STRIP_CJK = /^\s*\d{1,2}、(?!\d)\s*/;

/** 这一行是不是有序列表项? */
function isOrderedItem(line) {
  return ORDERED_ASCII.test(line) || ORDERED_CJK.test(line);
}

/**
 * 剥掉有序列表的编号。
 * 不是列表行就**原样返回** —— 调用方直接拿返回值渲染, 所以这里必须是 no-op 而不是 ''。
 */
function stripOrderedMarker(line) {
  const s = String(line == null ? '' : line);
  if (ORDERED_ASCII.test(s)) return s.replace(STRIP_ASCII, '');
  if (ORDERED_CJK.test(s)) return s.replace(STRIP_CJK, '');
  return s;
}

module.exports = { ORDERED_ASCII, ORDERED_CJK, isOrderedItem, stripOrderedMarker };
