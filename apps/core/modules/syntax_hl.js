/**
 * modules/syntax_hl.js
 * 盘古 · Syntax highlighting (P0-#16 · P0-10 LSP 整合)
 *
 * chalk + tree-sitter-highlight 集成, 返 ANSI 24bit colored 字符串
 * 内部 helper colorize(code, { lang }) 供 tool 输出端用
 * 终端 capability 检测 (NO_COLOR / CI / 非 TTY) 自动降级纯文本
 *
 * 学 P0-#18 style: 懒加载 + 显式 module.exports
 */

'use strict';

const fs = require('fs');
const path = 'path';

// 懒加载 chalk (启动时不大开销, 第一次调用才 init)
let _chalk = null;
function _loadChalk() {
  if (_chalk) return _chalk;
  // chalk v5 是 pure ESM, 用 chalk 的 CommonJS shim
  try {
    _chalk = require('chalk');
    // force chalk@5 走 CommonJS 兼容: chalk 是 singleton (实例 = default)
    if (_chalk.level === undefined) {
      // chalk v4: level 在 instance; v5: 改 chalk.level (默认 export)
      try { _chalk = _chalk.default || _chalk; } catch (_) {}
    }
  } catch (e) {
    // chalk 装不上时降级到空函数
    _chalk = new Proxy({}, { get: () => (s) => s });
  }
  return _chalk;
}

// 终端 capability 检测 (§0.49 + Claude Fable 5 'lists_and_bullets' 风格: 知道何时降级)
function _isColorSupported() {
  // NO_COLOR env 明确禁色 (https://no-color.org)
  if (process.env.NO_COLOR !== undefined) return false;
  // CI 环境一般无 TTY
  if (process.env.CI === 'true' || process.env.CI === '1') return false;
  // TTY 检测
  if (process.stdout && process.stdout.isTTY === false) return false;
  // FORCE_COLOR 强制 (debug 用)
  if (process.env.FORCE_COLOR === '1' || process.env.FORCE_COLOR === 'true') return true;
  return true;
}

// 懒加载 tree-sitter-highlight
let _highlight = null;
function _loadHighlighter() {
  if (_highlight) return _highlight;
  try {
    _highlight = require('tree-sitter-highlight');
  } catch (e) {
    _highlight = null;
  }
  return _highlight;
}

/**
 * 颜色化代码块 (主 API, 同步)
 * @param {string} code - 源码
 * @param {object} opts - { lang: 'javascript'|'typescript'|'python', lineNumbers: bool, plain: bool }
 * @returns {string} ANSI colored 字符串 (无 TTY 时返 plain text)
 */
function colorize(code, opts = {}) {
  const lang = (opts.lang || 'javascript').toLowerCase();
  const lineNumbers = opts.lineNumbers === true;
  const plain = opts.plain === true || !_isColorSupported();

  if (!code || typeof code !== 'string') return code || '';

  // Plain 模式: 直接返 (加 line numbers)
  if (plain) {
    return lineNumbers ? _addLineNumbers(code) : code;
  }

  // 尝试 tree-sitter-highlight (全彩色 ANSI)
  const _hl = _loadHighlighter();
  if (_hl && _hl.highlight) {
    try {
      const langName = _mapToHighlightLang(lang);
      const fragments = _hl.highlight(langName, code);
      // fragments: [{ text, color }]
      let out = '';
      for (const f of fragments) {
        out += _ansiWrap(f.text, f.color);
      }
      return lineNumbers ? _addLineNumbers(out) : out;
    } catch (e) {
      // 解析失败 → 降级
    }
  }

  // 降级: chalk 简单关键字高亮 (按空格分词, 给关键字/字符串/数字上色)
  return _chalkFallback(code, lang, lineNumbers);
}

/**
 * Lang 名映射: spec 接受 typescript → tree-sitter-highlight 接受 typescript
 */
function _mapToHighlightLang(lang) {
  const map = {
    javascript: 'javascript',
    js: 'javascript',
    typescript: 'typescript',
    ts: 'typescript',
    tsx: 'tsx',
    python: 'python',
    py: 'python',
  };
  return map[lang] || lang;
}

/**
 * 给一段文本加 ANSI 颜色
 * @param {string} text - 原始文本
 * @param {string|number|null} color - ANSI 颜色码 (e.g. _hl.KEYWORD)
 */
function _ansiWrap(text, color) {
  if (color === null || color === undefined) return text;
  // tree-sitter-highlight 返 color 是 key 名 ('keyword', 'string' 等) 或 number
  // 简化为 chalk style 名称
  const _c = _loadChalk();
  const style = typeof color === 'string'
    ? _c[color] || _c.keyword || ((s) => s)
    : ((s) => s);
  try { return style(text); } catch (_) { return text; }
}

/**
 * Chalk fallback 关键字着色 (没 tree-sitter-highlight 也好看)
 * 用 regex 简单标记 — 不能跟 tree-sitter 比, 但比纯 text 好
 */
function _chalkFallback(code, lang, lineNumbers) {
  const _c = _loadChalk();
  const keywordColor = _c.cyan || ((s) => s);
  const stringColor = _c.green || ((s) => s);
  const numberColor = _c.yellow || ((s) => s);
  const commentColor = _c.gray || ((s) => s);

  // 按 lang 给关键字
  const KWS = {
    javascript: /\b(const|let|var|function|return|if|else|for|while|class|new|export|import|async|await|from|as|of|in|true|false|null|undefined)\b/g,
    typescript: /\b(const|let|var|function|return|if|else|for|while|class|new|export|import|async|await|from|as|of|in|interface|type|enum|true|false|null|undefined)\b/g,
    python: /\b(def|return|if|elif|else|for|while|class|import|from|as|True|False|None|lambda|yield|with|try|except|finally)\b/g,
  };
  const kwPattern = KWS[lang] || KWS.javascript;
  const STRINGS = /(['"`])(?:(?=(\\?))\2.)*?\1/g;
  const NUMBERS = /\b\d+(\.\d+)?\b/g;
  const COMMENTS = lang === 'python'
    ? /#[^\n]*/g
    : /\/\/[^\n]*|\/\*[\s\S]*?\*\//g;

  let out = code
    .replace(COMMENTS, (m) => commentColor(m))
    .replace(STRINGS, (m) => stringColor(m))
    .replace(NUMBERS, (m) => numberColor(m));

  // 注意: kw 替换放最后 (避免 keyword color 改坏 string/number 内的字)
  // 但要排除已经在 colored 字符串里的, 简化为非 ANSI 范围
  out = out.replace(kwPattern, (m) => kwPattern.test(out) ? keywordColor(m) : m);

  return lineNumbers ? _addLineNumbers(out) : out;
}

/**
 * 加行号 (gutter)
 */
function _addLineNumbers(text) {
  const lines = text.split('\n');
  const width = String(lines.length).length;
  return lines.map((ln, i) => `${String(i + 1).padStart(width, ' ')} │ ${ln}`).join('\n');
}

/**
 * 文件 → colorize 便捷接口 (同步)
 * @param {string} filePath
 * @param {object} opts - { lang?: auto-detect by extension, plain?, lineNumbers? }
 * @returns {string}
 */
function colorizeFile(filePath, opts = {}) {
  if (!fs.existsSync(filePath)) return `[file not found: ${filePath}]`;
  const code = fs.readFileSync(filePath, 'utf8');
  const lang = opts.lang || _autoDetectLang(filePath);
  return colorize(code, { lang, ...opts });
}

function _autoDetectLang(filePath) {
  if (filePath.endsWith('.ts') || filePath.endsWith('.tsx')) return 'typescript';
  if (filePath.endsWith('.py')) return 'python';
  return 'javascript';
}

module.exports = {
  colorize,
  colorizeFile,
  _isColorSupported,
  _autoDetectLang,
};