#!/usr/bin/env node
/**
 * scripts/evolution_miner.js — L2 矿工 (补 self-evolution.js TODO §0.31)
 *
 * 职责:
 *   1. 读 evolution/<date>.jsonl (L1)
 *   2. 聚合模式: tool_usage / fail_rate / latency / rounds / model_perf / boss_feedback_signal
 *   3. 写到 state/evolution/l2-insights-<date>.json (深度, 比 self-evolution.js 内联统计更细)
 *
 * 被 self-evolution.js runL2Miner() 调用 (走 execSync, stdio pipe), 失败不抛
 *
 * 2026-09-03 Codex 补
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const EVO_DIR = path.join(PANGU_HOME, 'evolution');
const OUT_DIR = path.join(PANGU_HOME, 'state', 'evolution');
const TODAY = new Date().toISOString().slice(0, 10);

function readJsonl(p) {
  if (!fs.existsSync(p)) return [];
  return fs.readFileSync(p, 'utf8').split('\n').filter(Boolean).map(l => {
    try { return JSON.parse(l); } catch { return null; }
  }).filter(Boolean);
}

function pct(n, d) { return d > 0 ? +(n / d * 100).toFixed(1) : 0; }

// 模式 1: 工具使用分布
function mineToolUsage(records) {
  const usage = {}, errors = {};
  records.forEach(r => {
    (r.tool_names || []).forEach(t => {
      usage[t] = (usage[t] || 0) + 1;
      if (!r.success) errors[t] = (errors[t] || 0) + 1;
    });
  });
  return Object.entries(usage)
    .sort((a, b) => b[1] - a[1])
    .map(([name, calls]) => ({
      name, calls,
      errors: errors[name] || 0,
      fail_rate: pct(errors[name] || 0, calls)
    }));
}

// 模式 2: 模型性能
function mineModelPerf(records) {
  const m = {};
  records.forEach(r => {
    const key = r.provider && r.model ? `${r.provider}/${r.model}` : 'unknown';
    if (!m[key]) m[key] = { calls: 0, success: 0, total_ms: 0, total_chars: 0 };
    m[key].calls++;
    if (r.success) m[key].success++;
    m[key].total_ms += r.duration_ms || 0;
    m[key].total_chars += r.total_chars || 0;
  });
  return Object.entries(m).map(([k, v]) => ({
    model: k,
    calls: v.calls,
    success_rate: pct(v.success, v.calls),
    avg_ms: Math.round(v.total_ms / v.calls),
    avg_chars: Math.round(v.total_chars / v.calls)
  })).sort((a, b) => b.calls - a.calls);
}

// 模式 3: 老板反馈信号 (推断)
function mineBossFeedback(records) {
  const signals = { ok: 0, followup: 0, correction: 0, silent: 0 };
  records.forEach(r => {
    const t = (r.input || '').trim();
    if (!t) { signals.silent++; return; }
    if (t.length <= 4 && /[可以ok对好嗯]/.test(t)) signals.ok++;
    else if (t.includes('?') || t.includes('？') || t.startsWith('是不是') || t.startsWith('要')) signals.correction++;
    else if (t.length < 20) signals.followup++;
    else signals.correction++;
  });
  return signals;
}

// 模式 4: 失败 case 抽取 (供 autoImprove 喂给 LLM)
function mineFailures(records) {
  return records.filter(r => !r.success).slice(0, 10).map(r => ({
    ts: r.ts,
    input: (r.input || '').slice(0, 200),
    error: r.error,
    duration_ms: r.duration_ms,
    model: r.model
  }));
}

// 模式 5: 时间分布 (找出低活跃期, 适合空闲学习)
function mineHourlyActivity(records) {
  const h = new Array(24).fill(0);
  records.forEach(r => {
    const hr = new Date(r.ts).getHours();
    h[hr]++;
  });
  return h;
}

function main() {
  const todayFile = path.join(EVO_DIR, `${TODAY}.jsonl`);
  const records = readJsonl(todayFile);

  const insights = {
    date: TODAY,
    generated_at: new Date().toISOString(),
    source_file: todayFile,
    record_count: records.length,
    tool_usage: mineToolUsage(records),
    model_perf: mineModelPerf(records),
    boss_feedback_signals: mineBossFeedback(records),
    failures_sample: mineFailures(records),
    hourly_activity: mineHourlyActivity(records),
    summary: {
      overall_success_rate: pct(records.filter(r => r.success).length, records.length),
      avg_rounds: records.length ? +(records.reduce((s, r) => s + (r.rounds || 0), 0) / records.length).toFixed(2) : 0,
      avg_duration_ms: records.length ? Math.round(records.reduce((s, r) => s + (r.duration_ms || 0), 0) / records.length) : 0,
      idle_hours: mineHourlyActivity(records).map((c, h) => ({ h, c })).filter(x => x.c === 0).map(x => x.h)
    }
  };

  if (!fs.existsSync(OUT_DIR)) fs.mkdirSync(OUT_DIR, { recursive: true });
  const outFile = path.join(OUT_DIR, `l2-insights-${TODAY}.json`);
  fs.writeFileSync(outFile, JSON.stringify(insights, null, 2));

  // stdout 也打一行, 方便 self-evolution.js 看
  console.log(`[l2-miner] ${TODAY}: ${records.length} records → ${outFile}`);
}

if (require.main === module) main();

module.exports = { main, readJsonl, mineToolUsage, mineModelPerf, mineBossFeedback, mineFailures, mineHourlyActivity };
