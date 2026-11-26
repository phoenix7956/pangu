'use strict';
/**
 * tests/helpers/strip-comments.js
 *
 * 源码里读「声明」时, 必须先把注释剥干净 —— 注释里常写着历史说明
 * (「原来这里印的是几个 emoji」这类), 按全文匹配去判就会**自己咬自己**。
 *
 * 但**不能**用简单正则:
 *   ① 斜杠星号出现在行注释里 (例如「数据源: memory/sessions/星号.md」) 时,
 *      块注释正则会从那里一路吞到下一个块注释结束符, 中间几百行代码全被吞掉 ——
 *      守卫读到的是残缺源码 (2026-10-29 实测踩到, 页面根检查因此误判)。
 *   ② 只剥块注释会漏掉行注释。
 *
 * ⇒ 走一个字符级扫描: 认三种引号 (字符串整体保留 —— class 名常在字符串里),
 *   认行注释与块注释两种注释, 其余原样。
 *
 * 注意: 这个文件自己**不能**在块注释里写出「块注释结束符」那三个字符,
 * 否则它自己把自己的注释提前关掉 (2026-10-29 实测踩到, 语法直接炸)。
 */
function stripComments(src) {
  let out = '';
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    if (c === '/' && c2 === '/') {
      while (i < n && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && c2 === '*') {
      i += 2;
      while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      const q = c;
      out += c;
      i++;
      while (i < n) {
        if (src[i] === '\\') { out += src[i] + (src[i + 1] || ''); i += 2; continue; }
        out += src[i];
        if (src[i] === q) { i++; break; }
        i++;
      }
      continue;
    }
    out += c;
    i++;
  }
  return out;
}

module.exports = { stripComments };
