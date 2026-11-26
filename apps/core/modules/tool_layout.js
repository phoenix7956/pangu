// modules/tool_layout.js — 内部工具顺序重组 (2026-09-14 老板拍 #6: marketplace 对内工作)
// 老板定义: marketplace = 外部工具安装 + 内部工具的顺序重组。
// 真效果: 喂给 LLM 的 tools schema 顺序 (越靠前模型越优先选) + 设置页/工具箱的展示顺序。
// 落盘: apps/core/config/internal_tool_layout.json { order: [toolName...], updated_at }
// 防御: 文件坏/缺 → 原顺序; 未知工具名忽略; 未列入的工具保持相对顺序排在已列之后。
'use strict';

const fs = require('fs');
const path = require('path');

const LAYOUT_PATH = process.env.PANGU_TOOL_LAYOUT_PATH
  || path.join(__dirname, '..', 'config', 'internal_tool_layout.json');

let _cache = null;
let _cacheMtime = 0;

function loadLayout() {
  try {
    const st = fs.statSync(LAYOUT_PATH);
    if (_cache && st.mtimeMs === _cacheMtime) return _cache;
    const j = JSON.parse(fs.readFileSync(LAYOUT_PATH, 'utf8'));
    const order = Array.isArray(j.order) ? j.order.filter(x => typeof x === 'string') : [];
    _cache = { order, updated_at: j.updated_at || null };
    _cacheMtime = st.mtimeMs;
    return _cache;
  } catch (_) {
    _cache = { order: [], updated_at: null };
    _cacheMtime = 0;
    return _cache;
  }
}

function saveLayout(order) {
  const clean = [...new Set((Array.isArray(order) ? order : []).filter(x => typeof x === 'string' && x.trim()))];
  const j = { _meta: { purpose: '内部工具顺序重组 (marketplace 内部 tab 写入; LLM schema + UI 共用)', owner: 'pangu' }, order: clean, updated_at: new Date().toISOString() };
  fs.writeFileSync(LAYOUT_PATH, JSON.stringify(j, null, 2));
  _cache = null; // bust cache
  return { ok: true, count: clean.length };
}

// 对工具名数组应用布局顺序: 布局内的按布局排, 布局外的保持原相对顺序排在后面
function orderNames(names) {
  const { order } = loadLayout();
  if (!order.length) return names;
  const pos = new Map(order.map((n, i) => [n, i]));
  return [...names].sort((a, b) => {
    const pa = pos.has(a) ? pos.get(a) : Infinity;
    const pb = pos.has(b) ? pos.get(b) : Infinity;
    if (pa === pb) return 0; // 稳定排序保原相对顺序
    return pa - pb;
  });
}

// 对 OpenAI schema 数组 (s.function.name) 应用布局顺序
function orderSchemas(schemas) {
  if (!Array.isArray(schemas) || !schemas.length) return schemas;
  const names = schemas.map(s => s && s.function && s.function.name);
  const ordered = orderNames(names);
  const byName = new Map(schemas.map(s => [s && s.function && s.function.name, s]));
  return ordered.map(n => byName.get(n)).filter(Boolean);
}

module.exports = { loadLayout, saveLayout, orderNames, orderSchemas, LAYOUT_PATH };
