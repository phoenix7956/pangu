#!/usr/bin/env node
'use strict';

// 一次性数据迁移 (2026-10-18): 把 ~/.pangu/subagent-runs.jsonl 里**已经写下去**
// 的英文 code 全部就地改写成拼音。
//
// 为什么要有这一步: 身份统一到拼音之后, 代码里所有"读时翻译英文"的表
// (subagent_runs.LEGACY_RUN_CODE / qian._weightsByPinyin / l3_dispatcher._parse)
// 就都可以删掉了 —— 但删之前必须先把**数据本身**改掉, 否则那一个月的实跑
// 记录会静默清零: digest() 按拼音索引查, 英文 code 一个都命中不了, UI 上
// 8 将灵齐刷刷显示"今天 0 次运行", 而磁盘上明明有 958 次。
//
// 所以顺序是: 先迁数据 → 再删表。数据迁完, 表就是纯冗余。
//
// 用法: node scripts/migrate-run-codes-to-pinyin-20261018.js [--dry-run]

const fs = require('fs');
const os = require('os');
const path = require('path');
const { resolveRole } = require('../agents/gua-identity');
const { GUA_ROLES } = require('../agents/gua-identity');

const RUNS_FILE = path.join(os.homedir(), '.pangu', 'subagent-runs.jsonl');
const BACKUP = RUNS_FILE + '.pre-pinyin-20261018.bak';
const DRY = process.argv.includes('--dry-run');
const CORE = path.join(__dirname, '..');
const L3_FILES = [
  path.join(CORE, '.learn', 'l3_state.json'),
  path.join(os.homedir(), '.pangu', 'learn', 'l3_state.json'),
];

// 旧英文 code → 拼音。只在这一个一次性脚本里出现; 迁移完连同数据一起消失。
const OLD = Object.freeze({
  dispatcher: 'qian', planner: 'kan', learner: 'gen', reflector: 'zhen',
  bug_hunter: 'xun', bughunter: 'xun', analyzer: 'li', executor: 'kun',
  checker: 'dui',
});

// 卦名 → 拼音 (从身份真源派生, 不另抄一份)。
// 用途: code 认不出来时, 回退看这一行**自己带的 gua 字段**。
// 全账本只有 1 行吃到这条路 (code=synthesizer, gua=乾) —— 那是旧版抄错的
// CODE_TO_GUA 留下的: 乾被写成 synthesizer, 而真源里乾= qian。记录自己
// 说了它是乾, 所以按 gua 还原成 qian 是**读它自己的话**, 不是又一次猜。
const GUA_TO_CODE = Object.freeze(
  GUA_ROLES.reduce((m, r) => { m[r.gua] = r.code; return m; }, Object.create(null)));

function convert(line) {
  let rec;
  try { rec = JSON.parse(line); } catch (_) { return { line, changed: false, why: 'unparsable' }; }
  if (!rec || typeof rec !== 'object') return { line, changed: false, why: 'not-object' };
  const k = String(rec.code == null ? '' : rec.code).trim();
  if (!k) return { line, changed: false, why: 'no-code' };
  // 已经是拼音/卦名 = 迁移过了 (或本来就是新的)
  const already = resolveRole(k);
  if (already === k.toLowerCase() && already === k) return { line, changed: false, why: 'already' };
  const fromGua = GUA_TO_CODE[String(rec.gua || '').trim()];
  const p = already || OLD[k.toLowerCase()] || fromGua;
  if (!p) return { line, changed: false, why: 'unknown:' + k };
  rec.code = p;
  // gua 字段跟着 code 一起校正 (旧表抄错时它和 code 是同一条错链的两端)
  const r = GUA_ROLES.find(x => x.code === p);
  if (r) rec.gua = r.gua;
  return { line: JSON.stringify(rec), changed: true, why: k + '->' + p + (fromGua ? '(via gua)' : '') };
}

function main() {
  migrateL3();
  migrateLedger();
}

// l3_state.json: weights 的键 + taskToAgents[].agents 的成员, 都要拼音。
function migrateL3() {
  for (const file of L3_FILES) {
    if (!fs.existsSync(file)) continue;
    let st;
    try { st = JSON.parse(fs.readFileSync(file, 'utf8')); } catch (_) { continue; }
    let changed = 0;
    const w = Object.create(null);
    for (const [k, v] of Object.entries(st.weights || {})) {
      const p = resolveRole(k);
      if (!p) { changed++; continue; }         // 认不出的键丢掉, 别污染权重表
      if (p !== k) changed++;
      w[p] = v;
    }
    if (Object.keys(w).length) st.weights = w;
    for (const [pat, m] of Object.entries(st.taskToAgents || {})) {
      if (!m || !Array.isArray(m.agents)) continue;
      const next = m.agents.map(a => resolveRole(a)).filter(Boolean);
      if (next.length !== m.agents.length) changed++;
      m.agents = next;
    }
    delete st._weightsMigratedToPinyin;         // 迁移标记已无意义
    if (!changed) { console.log('l3 (no change): ' + file); continue; }
    if (!DRY) {
      if (!fs.existsSync(file + '.pre-pinyin-20261018.bak')) {
        fs.copyFileSync(file, file + '.pre-pinyin-20261018.bak');
      }
      fs.writeFileSync(file, JSON.stringify(st, null, 2));
    }
    console.log('l3: ' + file + ' | rewritten: ' + changed + (DRY ? ' | DRY-RUN' : ''));
  }
}

function migrateLedger() {
  if (!fs.existsSync(RUNS_FILE)) {
    console.log('no ledger at ' + RUNS_FILE + ' — nothing to do');
    return;
  }
  // 服务在跑, 随时可能追加。读 → 改 → 原子换; 换之前发现原文件长了就重来,
  // 免得把迁移窗口里新写进去的那几行弄丢 (新行本来就是拼音, 重来一轮就收敛了)。
  for (let attempt = 1; attempt <= 8; attempt++) {
    const raw = fs.readFileSync(RUNS_FILE, 'utf8');
    const lines = raw.split('\n').filter(Boolean);
    const out = [];
    const reasons = {};
    let changed = 0;
    for (const l of lines) {
      const r = convert(l);
      out.push(r.line);
      if (r.changed) changed++;
      else if (r.why && !r.why.startsWith('already')) reasons[r.why] = (reasons[r.why] || 0) + 1;
    }
    const sizeNow = fs.statSync(RUNS_FILE).size;
    if (sizeNow !== Buffer.byteLength(raw)) {
      console.log('attempt ' + attempt + ': ledger grew while reading, retrying...');
      continue;
    }
    const payload = out.join('\n') + '\n';
    if (!DRY) {
      if (!fs.existsSync(BACKUP)) fs.copyFileSync(RUNS_FILE, BACKUP);
      const tmp = RUNS_FILE + '.migrating';
      fs.writeFileSync(tmp, payload);
      fs.renameSync(tmp, RUNS_FILE);       // 原子替换
    }
    // 复核: 换完再读一遍, 英文不该剩下
    let remaining = 0;
    if (!DRY) {
      for (const l of fs.readFileSync(RUNS_FILE, 'utf8').split('\n').filter(Boolean)) {
        try {
          const c = String((JSON.parse(l) || {}).code || '').trim();
          if (c && !resolveRole(c)) remaining++;
        } catch (_) {}
      }
    }
    console.log('lines: ' + lines.length
      + ' | rewritten: ' + changed
      + ' | unresolved-after: ' + remaining
      + (DRY ? ' | DRY-RUN (no write)' : ' | backup: ' + BACKUP));
    if (Object.keys(reasons).length) console.log('not converted: ' + JSON.stringify(reasons));
    return;
  }
  console.error('ledger kept growing across 8 attempts — aborting, nothing written');
  process.exitCode = 1;
}

main();
