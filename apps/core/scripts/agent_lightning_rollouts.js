#!/usr/bin/env node
'use strict';

// Build a conservative seed/evaluation corpus from Pangu's real L1 records.
// These are not Gateway token traces yet; they establish the task/reward
// contract that Agent Lightning will use once a CUDA Gateway is attached.

const fs = require('fs');
const os = require('os');
const path = require('path');

const PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const DEFAULT_SOURCE = path.join(PANGU_HOME, 'evolution');
const BAD_ALIGNMENT = /我没有拿到与原问题对齐的答案|当前结果未通过问题对齐校验/;
const BAD_TOOL_LOCK = /(?:工具|tool).{0,10}(?:锁(?:了|死)?|被禁|不可用|不能调)|(?:system|系统).{0,16}(?:禁止|不让).{0,16}(?:调|调用).{0,10}(?:工具|tool)/i;
const ORCHESTRATION = /(?:下一步|等你拍|先(?:查|读|写|改)|任务未完成|步骤\s*[一二三四五六七八九十0-9])/;

function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap((line, index) => {
    try { return [{ ...JSON.parse(line), _source: file, _line: index + 1 }]; } catch (_) { return []; }
  });
}

function sourceFiles(input) {
  if (!fs.existsSync(input)) return [];
  const stat = fs.statSync(input);
  if (stat.isFile()) return [input];
  return fs.readdirSync(input)
    .filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/.test(name))
    .sort()
    .map(name => path.join(input, name));
}

function scoreRecord(record) {
  const answer = String(record.final_text || '');
  const alignmentBlocked = BAD_ALIGNMENT.test(answer);
  const fakeToolLock = BAD_TOOL_LOCK.test(answer);
  const hasTools = Number(record.tool_calls_total) > 0 || (Array.isArray(record.tool_names) && record.tool_names.some(n => n !== 'task_done'));
  const planOnly = !hasTools && ORCHESTRATION.test(answer);
  const succeeded = record.effective_success === true || (record.effective_success == null && record.success === true);
  const reward = Number((
    (succeeded ? 0.45 : -0.8)
    + (hasTools ? 0.25 : -0.25)
    + (!alignmentBlocked ? 0.2 : -0.8)
    + (!fakeToolLock ? 0.1 : -0.7)
    + (!planOnly ? 0.1 : -0.35)
  ).toFixed(2));
  return {
    reward,
    labels: { succeeded, has_tools: hasTools, alignment_blocked: alignmentBlocked, fake_tool_lock: fakeToolLock, plan_only: planOnly },
    eligible: succeeded && hasTools && !alignmentBlocked && !fakeToolLock && !planOnly,
  };
}

function toSample(record, id) {
  const scored = scoreRecord(record);
  return {
    id,
    source: { file: path.basename(record._source || ''), line: record._line || 0, timestamp: record.ts || null },
    task: String(record.input || ''),
    response: String(record.final_text || ''),
    trajectory: {
      endpoint: record.endpoint || null,
      model: record.model || null,
      provider: record.provider || null,
      tool_calls_total: Number(record.tool_calls_total) || 0,
      tool_names: Array.isArray(record.tool_names) ? record.tool_names : [],
      rounds: Number(record.rounds) || 0,
      duration_ms: Number(record.duration_ms) || 0,
    },
    reward: scored.reward,
    labels: scored.labels,
    eligible_for_positive_training: scored.eligible,
  };
}

function parseArgs(argv) {
  const out = { source: DEFAULT_SOURCE, output: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--source') out.source = argv[++i];
    if (argv[i] === '--output') out.output = argv[++i];
  }
  return out;
}

function main(argv = process.argv.slice(2)) {
  const { source, output } = parseArgs(argv);
  if (!output) throw new Error('usage: agent_lightning_rollouts.js --output <rollouts.jsonl> [--source <evolution-dir-or-file>]');
  const records = sourceFiles(source).flatMap(readJsonl);
  const samples = records.map((record, index) => toSample(record, `pangu-${String(index + 1).padStart(6, '0')}`));
  fs.mkdirSync(path.dirname(output), { recursive: true });
  fs.writeFileSync(output, samples.map(sample => JSON.stringify(sample)).join(samples.length ? '\n' : '') + (samples.length ? '\n' : ''), 'utf8');
  const stats = samples.reduce((acc, sample) => {
    acc.total++;
    if (sample.eligible_for_positive_training) acc.positive++;
    if (sample.labels.alignment_blocked) acc.alignment_blocked++;
    if (sample.labels.fake_tool_lock) acc.fake_tool_lock++;
    if (sample.labels.plan_only) acc.plan_only++;
    return acc;
  }, { total: 0, positive: 0, alignment_blocked: 0, fake_tool_lock: 0, plan_only: 0 });
  console.log(JSON.stringify({ output, ...stats }));
  return { samples, stats };
}

if (require.main === module) main();

module.exports = { readJsonl, sourceFiles, scoreRecord, toSample, main };
