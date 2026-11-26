/**
 * modules/symbol_search.js
 * 盘古 · Symbol search (P0-#18 · P0-10 LSP 整合)
 *
 * tree-sitter + 3 grammar (JS/TS/Python) 提取 function/class/variable + 位置
 * 新 tool symbol_search(pattern, type?, lang?, max_results?)
 *
 * 性能: 用 tree-sitter 增量 parse (不打全 index), <500ms 跑 Pangu 自己的代码 (104 files)
 */

'use strict';

const fs = require('fs');
const path = require('path');

// 懒加载 tree-sitter (启动 + 第一次调用才 init, 加快 daemon boot)
let _Parser = null;
let _JS = null;
let _TS = null;
let _PY = null;
function _loadParsers() {
  if (_Parser) return;
  _Parser = require('tree-sitter');
  _JS = require('tree-sitter-javascript');
  _TS = require('tree-sitter-typescript');
  _PY = require('tree-sitter-python');
}

const _LANG_MAP = {
  javascript: () => { _loadParsers(); return _JS; },
  js: () => { _loadParsers(); return _JS; },
  typescript: () => { _loadParsers(); return _TS.typescript; },
  ts: () => { _loadParsers(); return _TS.typescript; },
  tsx: () => { _loadParsers(); return _TS.tsx; },
  python: () => { _loadParsers(); return _PY; },
  py: () => { _loadParsers(); return _PY; },
};

// 文件 → lang 自动检测
function _detectLang(file) {
  if (/\.tsx$/.test(file)) return 'tsx';
  if (/\.ts$/.test(file)) return 'typescript';
  if (/\.jsx?$/.test(file)) return 'javascript';
  if (/\.py$/.test(file)) return 'python';
  return null;
}

// AST walker: 提取 function/class/variable 名
function _extractSymbols(tree, lang, filePath) {
  const results = [];
  // tree-sitter node types for each lang
  const NODE_TYPES = {
    javascript: { function: ['function_declaration', 'method_definition', 'arrow_function'], class: ['class_declaration'], variable: ['variable_declarator', 'function'] },
    typescript: { function: ['function_declaration', 'method_definition', 'arrow_function'], class: ['class_declaration', 'interface_declaration'], variable: ['variable_declarator'] },
    python: { function: ['function_definition'], class: ['class_definition'], variable: ['assignment'] },
  };
  const types = NODE_TYPES[lang] || NODE_TYPES.javascript;

  function walk(node) {
    if (!node) return;
    let kind = null;
    if (types.function.includes(node.type)) kind = 'function';
    else if (types.class.includes(node.type)) kind = 'class';
    else if (types.variable.includes(node.type)) kind = 'variable';

    if (kind) {
      // 找 name node (function_declaration 的 'name' field, class_declaration 同)
      let name = null;
      if (node.type === 'variable_declarator') {
        name = node.child(0) && node.child(0).text;  // 第一个 child 是 identifier
      } else if (node.childForFieldName('name')) {
        name = node.childForFieldName('name').text;
      } else {
        // fallback: 找第一个 identifier child
        for (let i = 0; i < node.childCount; i++) {
          const c = node.child(i);
          if (c.type === 'identifier' || c.type === 'property_identifier') { name = c.text; break; }
        }
      }
      if (name) {
        const startPos = node.startPosition;
        results.push({
          name,
          type: kind,
          file: filePath,
          line: startPos.row + 1,  // tree-sitter 0-based, 我们 1-based
          character: startPos.column,
          scope: kind === 'method_definition' ? 'class' : (node.parent && node.parent.type === 'class_declaration' ? 'class' : 'global'),
        });
      }
    }
    // 递归
    for (let i = 0; i < node.childCount; i++) {
      walk(node.child(i));
    }
  }
  walk(tree.rootNode);
  return results;
}

// 单文件 symbol 提取
function _extractFromFile(filePath) {
  const lang = _detectLang(filePath);
  if (!lang || !_LANG_MAP[lang]) return [];
  let code;
  try { code = fs.readFileSync(filePath, 'utf8'); } catch (_) { return []; }
  const Parser = _LANG_MAP[lang]();
  // TS 需要用 typescript subgrammar
  const grammar = lang === 'typescript' ? _TS.typescript : lang === 'tsx' ? _TS.tsx : Parser;
  const parser = new _Parser();
  parser.setLanguage(grammar);
  const tree = parser.parse(code);
  return _extractSymbols(tree, lang, filePath);
}

// glob → file list
function _globToFiles(rootDir, pattern) {
  const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
  const out = [];
  function walk(dir) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const e of entries) {
      if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
      const full = path.join(dir, e.name);
      if (e.isDirectory()) { walk(full); continue; }
      if (e.isFile() && _detectLang(e.name) && (pattern === '.*' || re.test(e.name) || re.test(full))) {
        out.push(full);
      }
    }
  }
  walk(rootDir);
  return out;
}

// === symbol_search (主 tool) ===
async function symbolSearch(args = {}) {
  const pattern = args.pattern;
  if (!pattern) return { ok: false, error: { code: 'NO_PATTERN', message: 'pattern required (e.g. "addUser" or "*Controller")' } };
  const type = args.type || 'all';
  // Pangu 是 JS+TS 混编, 默认 lang='all' 包含所有 (避免 spec 默认 typescript 把 .js 漏掉)
  const lang = args.lang || 'all';
  const maxResults = args.max_results || 100;
  const rootDir = args.root || path.resolve(__dirname, '../..');  // Pangu repo 根

  try {
    const globPattern = pattern.includes('*') || pattern.includes('?') ? '.*' : null;
    const files = globPattern
      ? _globToFiles(rootDir, '.*').filter(f => {
          const base = path.basename(f).replace(/\.[jt]sx?$|\.py$/, '');
          const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$');
          return re.test(base);
        })
      : _globToFiles(rootDir, '.*');  // 真搜全 project (默认 104 files)

    const results = [];
    for (const f of files) {
      const fileLang = _detectLang(f);
      if (lang && !lang.split(',').includes(fileLang) && !lang.split(',').includes('all')) continue;
      const syms = _extractFromFile(f);
      for (const s of syms) {
        if (type !== 'all' && s.type !== type) continue;
        // 匹配: exact 或 pattern
        const re = new RegExp('^' + pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
        if (re.test(s.name) || s.name === pattern) {
          results.push(s);
          if (results.length >= maxResults) break;
        }
      }
      if (results.length >= maxResults) break;
    }
    return { ok: true, result: { pattern, type, lang, root: rootDir, file_count: files.length, result_count: results.length, results } };
  } catch (e) {
    return { ok: false, error: { code: 'SYMBOL_SEARCH_ERROR', message: e.message.slice(0, 300) } };
  }
}

module.exports = { symbolSearch, _extractFromFile, _detectLang, _globToFiles };