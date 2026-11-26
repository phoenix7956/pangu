/**
 * modules/lsp.js
 * 盘古 · LSP integration (P0-#17 · P0-10 LSP 整合)
 *
 * 设计变更 (§0.24 教训): vscode-langservers-extracted@4.10.0 不含 tsserver 入口
 * (新版可能更名/分类), 改走 tree-sitter + symbol_search fallback 真路径.
 *
 * 实测可用方式:
 *   - definition  → tree-sitter symbol_search (找该 line 的最近 symbol)
 *   - references  → ripgrep 跨文件搜 symbol 名
 *
 * 后续: 当 vscode-langservers-extracted 包 API 落定, 真 LSP 路径可加
 *       (_getLspClient_lsp() 留给未来实现)
 *
 * 新 tool:
 *   - lsp_definition(file, line, character, lang?)
 *   - lsp_references(file, line, character, symbol, lang?)
 */

'use strict';

const path = require('path');
const cp = require('child_process');

/**
 * lsp_definition 主 tool — 用 tree-sitter _extractFromFile 真路径
 * (bypass symbol_search 的 pattern filter, 因为 smoke 1 显示
 *  pattern 只 匹配 single symbol name, 不实用跳定义)
 *
 * 实现: 直接调 tree-sitter _extractFromFile 拿 file 全部 symbol,
 * 选 ≤ posLine 的最近 (= 定义/最近的 enclosing context)
 *
 * @param {object} args - { file: string, line: number, character?: number, lang?: string }
 * @returns {Promise<{ok, result?, error?}>}
 */
async function lspDefinition(args = {}) {
  if (!args.file || typeof args.line !== 'number') {
    return { ok: false, error: { code: 'INVALID_PARAMS', message: '需 file + line (1-based)' } };
  }
  try {
    const ss = require('./symbol_search');
    const absFile = path.isAbsolute(args.file) ? args.file : path.resolve(args.file);
    // 调内部 _extractFromFile (§0.24 教训: smoke 2 验证 single-file 路径更准)
    const allSymbols = ss._extractFromFile ? ss._extractFromFile(absFile) : [];
    if (!allSymbols || allSymbols.length === 0) {
      return { ok: true, result: null, _meta: { source: 'tree-sitter-extract-empty', reason: 'file 提取空' } };
    }
    // 找 ≤ posLine 最近的 symbol (这是 enclosing context / definition)
    let best = null;
    for (const s of allSymbols) {
      if (s.line <= args.line) {
        if (!best || s.line > best.line) best = s;
      }
    }
    if (!best) {
      return { ok: true, result: null, _meta: { source: 'tree-sitter-extract', file_symbols_total: allSymbols.length } };
    }
    return {
      ok: true,
      result: { file: absFile, line: best.line, character: best.character || 0, name: best.name, type: best.type, scope: best.scope },
      _meta: { source: 'tree-sitter-extract', file_symbols_total: allSymbols.length },
    };
  } catch (e) {
    return { ok: false, error: { code: 'LSP_DEFINITION_ERROR', message: e.message } };
  }
}

/**
 * lsp_references 主 tool — 用 ripgrep 跨文件搜 symbol 名
 * @param {object} args - { file: string, line: number, character?, symbol: string, lang? }
 */
async function lspReferences(args = {}) {
  if (!args.file || typeof args.line !== 'number' || !args.symbol) {
    return { ok: false, error: { code: 'INVALID_PARAMS', message: '需 file + line + symbol' } };
  }
  try {
    const absFile = path.isAbsolute(args.file) ? args.file : path.resolve(args.file);
    const rootDir = args.root || path.resolve(__dirname, '../..');
    // 排除 symbol 自身 (再 grep 一遍所在 line, exclude)
    const symbol = args.symbol;
    const escSymbol = symbol.replace(/'/g, "'\\''");
    const cmd = `grep -rn --include='*.js' --include='*.ts' --include='*.tsx' --include='*.jsx' -E '\\b${escSymbol}\\b' . 2>/dev/null | head -50`;
    let out;
    try {
      out = cp.execSync(cmd, { cwd: rootDir, encoding: 'utf8', timeout: 5000 });
    } catch (e) {
      // 没找到 (grep exit 1)
      out = '';
    }
    const lines = out.split('\n').filter(Boolean);
    const references = lines.map(ln => {
      // 格式: ./path/to/file.js:42:    code  (grep -n)
      const m = ln.match(/^(\.\/[^:]+|\/[^:]+):(\d+):(.+)$/);
      if (m) {
        return { file: path.isAbsolute(m[1]) ? m[1] : path.resolve(rootDir, m[1]), line: parseInt(m[2], 10), character: 0, preview: m[3].trim().slice(0, 80) };
      }
      return null;
    }).filter(Boolean);
    // 排除自身定义位置 (line 完全等于)
    const filtered = references.filter(r => !(r.file === absFile && r.line === args.line));
    return {
      ok: true,
      result: filtered,
      _meta: { source: 'ripgrep-fallback', symbol: args.symbol, total_before_filter: references.length, filtered_out: references.length - filtered.length },
    };
  } catch (e) {
    return { ok: false, error: { code: 'LSP_REFERENCES_ERROR', message: e.message } };
  }
}

module.exports = {
  lspDefinition,
  lspReferences,
};