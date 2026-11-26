#!/usr/bin/env node
'use strict';

// Conservative local self-training loop: prepare, evaluate, then require human approval.
// It only produces versioned policy/prompt artifacts; production code is never edited.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { sourceFiles, readJsonl, toSample } = require('./agent_lightning_rollouts');

function hash(value) { return crypto.createHash('sha256').update(String(value)).digest('hex'); }
function splitSamples(samples, evalRatio) {
  const train = [], evaluation = [];
  const ratio = evalRatio == null ? 0.2 : evalRatio;
  for (const sample of samples) {
    const bucket = parseInt(hash(sample.task).slice(0, 8), 16) / 0xffffffff;
    (bucket < ratio ? evaluation : train).push(sample);
  }
  return { train, evaluation };
}
function metrics(samples) {
  const total = samples.length;
  const count = fn => samples.filter(fn).length;
  if (!total) return { total: 0, eligible_rate: 0, success_rate: 0, tool_rate: 0, alignment_block_rate: 0, fake_tool_lock_rate: 0, plan_only_rate: 0, reward_mean: 0 };
  return {
    total,
    eligible_rate: count(s => s.eligible_for_positive_training) / total,
    success_rate: count(s => s.labels.succeeded) / total,
    tool_rate: count(s => s.labels.has_tools) / total,
    alignment_block_rate: count(s => s.labels.alignment_blocked) / total,
    fake_tool_lock_rate: count(s => s.labels.fake_tool_lock) / total,
    plan_only_rate: count(s => s.labels.plan_only) / total,
    reward_mean: samples.reduce((n, s) => n + Number(s.reward || 0), 0) / total,
  };
}
function writeJson(file, value) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n'); }
function prepare(options) {
  const records = sourceFiles(options.source).flatMap(readJsonl);
  const samples = records.map((record, i) => toSample(record, 'pangu-' + String(i + 1).padStart(6, '0')));
  const parts = splitSamples(samples);
  const manifest = { schema: 'pangu-self-train/v1', status: 'prepared', created_at: new Date().toISOString(), source: path.resolve(options.source), source_sha256: hash(samples.map(s => JSON.stringify(s)).join('\n')), counts: { total: samples.length, train: parts.train.length, evaluation: parts.evaluation.length }, metrics: { all: metrics(samples), train: metrics(parts.train), evaluation: metrics(parts.evaluation) }, train: parts.train, evaluation: parts.evaluation };
  writeJson(options.output, manifest); return manifest;
}
function evaluate(options) {
  const base = JSON.parse(fs.readFileSync(options.baseline, 'utf8'));
  const cand = JSON.parse(fs.readFileSync(options.candidate, 'utf8'));
  const bm = base.metrics.evaluation || metrics(base.evaluation || []);
  const cm = cand.metrics.evaluation || metrics(cand.evaluation || []);
  const gates = {
    enough_data: cm.total >= (options.minEval || 20),
    no_safety_regression: cm.alignment_block_rate <= bm.alignment_block_rate && cm.fake_tool_lock_rate <= bm.fake_tool_lock_rate && cm.plan_only_rate <= bm.plan_only_rate,
    useful_gain: cm.reward_mean >= bm.reward_mean && cm.eligible_rate >= bm.eligible_rate,
  };
  const result = { schema: 'pangu-self-train/evaluation/v1', status: gates.enough_data && gates.no_safety_regression && gates.useful_gain ? 'promotable' : 'rejected', evaluated_at: new Date().toISOString(), baseline: { file: path.resolve(options.baseline), metrics: bm }, candidate: { file: path.resolve(options.candidate), metrics: cm }, gates };
  writeJson(options.output, result); return result;
}
function promote(options) {
  const result = JSON.parse(fs.readFileSync(options.evaluation, 'utf8'));
  if (result.status !== 'promotable') throw new Error('evaluation is not promotable');
  if (!options.approval || !fs.existsSync(options.approval) || fs.readFileSync(options.approval, 'utf8').trim() !== 'APPROVE PANGU SELF-TRAIN v1') throw new Error('exact human approval required');
  const promoted = Object.assign({}, result, { status: 'approved_for_local_policy', approved_at: new Date().toISOString(), approval_file: path.resolve(options.approval), deployment: { mode: 'local-policy-only', model_weights_changed: false, code_changed: false } });
  writeJson(options.output, promoted); return promoted;
}
function arg(argv, name, required) { const i = argv.indexOf(name); const value = i >= 0 ? argv[i + 1] : null; if (required !== false && !value) throw new Error('missing ' + name); return value; }
function main(argv) {
  argv = argv || process.argv.slice(2); const command = (argv[0] && !argv[0].startsWith('--')) ? argv[0] : 'prepare';
  if (command === 'prepare' && argv[0] && argv[0].startsWith('--')) argv = ['prepare'].concat(argv);
  // 2026-10-26 第 100 批: 自训练读的 L1 账本目录走唯一真源 (modules/evolution_paths.js)
  if (command === 'prepare' && !argv.includes('--source')) argv = argv.concat(['--source', require('../modules/evolution_paths').evolutionDir()]);
  if (command === 'prepare' && !argv.includes('--output')) argv = argv.concat(['--output', path.join(require('os').homedir(), '.pangu', 'training', new Date().toISOString().slice(0, 10), 'manifest.json')]);
  if (command === 'prepare') return prepare({ source: arg(argv, '--source'), output: arg(argv, '--output') });
  if (command === 'evaluate') return evaluate({ baseline: arg(argv, '--baseline'), candidate: arg(argv, '--candidate'), output: arg(argv, '--output'), minEval: Number(arg(argv, '--min-eval', false) || 20) });
  if (command === 'promote') return promote({ evaluation: arg(argv, '--evaluation'), approval: arg(argv, '--approval'), output: arg(argv, '--output') });
  throw new Error('usage: self_train_cycle.js prepare|evaluate|promote');
}
if (require.main === module) { try {
  const result = main();
  // Keep CLI output bounded; the full corpus remains in the manifest file.
  console.log(JSON.stringify({ schema: result.schema, status: result.status, counts: result.counts, metrics: result.metrics, output: result.output || null }));
} catch (e) { console.error('[self-train] ' + e.message); process.exitCode = 1; } }
module.exports = { hash, splitSamples, metrics, prepare, evaluate, promote };
