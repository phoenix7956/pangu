// apps/core/modules/mini_yaml.js — 极简 YAML 解析器
// 2026-08-22 立: LM Studio model.yaml 真源读取
// 范围: model.yaml 实际语法 (nested map / sequence of scalars / 标量 / 注释)
// 不替代完整 yaml 库, 但比 npm i js-yaml 轻, 无依赖
function stripComment(line) {
  let inS = null;
  for (let k = 0; k < line.length; k++) {
    const c = line[k];
    if (inS) { if (c === inS) inS = null; continue; }
    if (c === '"' || c === "'") { inS = c; continue; }
    if (c === '#') return line.slice(0, k).trimEnd();
  }
  return line.trimEnd();
}
function parseScalar(v) {
  v = (v || '').trim();
  if (v === '') return null;
  if (v === 'true') return true;
  if (v === 'false') return false;
  if (v === 'null' || v === '~') return null;
  if (/^-?\d+$/.test(v)) return parseInt(v, 10);
  if (/^-?\d+\.\d+$/.test(v)) return parseFloat(v);
  if (/^-?\d+e\d+$/i.test(v)) return parseFloat(v);
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) return v.slice(1, -1);
  return v;
}
function classifyLine(raw) {
  const stripped = stripComment(raw);
  if (stripped.trim() === '') return null;
  const m = stripped.match(/^(\s*)(.*)$/);
  const indent = m[1].length;
  const body = m[2];
  if (body === '-' || body.startsWith('- ')) {
    return { indent, kind: 'seqItem', value: body === '-' ? '' : body.slice(2) };
  }
  const km = body.match(/^([^:]+?):(?:\s+(.*))?$/);
  if (!km) return null;
  return { indent, kind: 'map', key: km[1].trim(), value: (km[2] || '').trim() };
}
function parseYaml(text) {
  const rawLines = (text || '').split('\n');
  const lines = [];
  for (const r of rawLines) {
    const c = classifyLine(r);
    if (c) lines.push(c);
  }
  let pos = 0;
  function parseBlock(parentIndent) {
    const out = { kind: 'map', map: {}, seq: null };
    while (pos < lines.length) {
      const ln = lines[pos];
      if (ln.indent < parentIndent) break;
      if (ln.indent > parentIndent) { pos++; continue; }
      if (ln.kind === 'seqItem') {
        if (out.kind !== 'seq') { out.kind = 'seq'; out.seq = []; out.map = null; }
        if (ln.value === '') {
          pos++;
          const sub = parseBlock(ln.indent + 2);
          out.seq.push(sub.kind === 'map' ? sub.map : sub.seq);
        } else {
          const km = ln.value.match(/^([^:]+?):\s*(.*)$/);
          if (km) {
            // inline object: "- k: v"
            const o = {};
            o[km[1].trim()] = parseScalar(km[2]);
            out.seq.push(o);
          } else {
            out.seq.push(parseScalar(ln.value));
          }
          pos++;
        }
      } else if (ln.kind === 'map') {
        if (out.kind === 'seq') { pos++; continue; }
        if (ln.value === '') {
          pos++;
          const sub = parseBlock(ln.indent + 2);
          out.map[ln.key] = sub.kind === 'map' ? sub.map : sub.seq;
        } else {
          out.map[ln.key] = parseScalar(ln.value);
          pos++;
        }
      } else {
        pos++;
      }
    }
    return out;
  }
  const root = parseBlock(0);
  return root.kind === 'map' ? root.map : root.seq;
}

module.exports = { parseYaml, parseScalar };
