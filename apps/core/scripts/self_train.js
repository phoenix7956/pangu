#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { sourceFiles, readJsonl, toSample } = require('./agent_lightning_rollouts');

const PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const DEFAULT_OUTPUT = path.join(PANGU_HOME, 'training', new Date().toISOString().slice(0, 10));
function stableBucket(task) { return parseInt(crypto.createHash('sha256').update(String(task || '')).digest('hex').slice(0, 8), 16) % 10; }
function buildSamples(source) { return sourceFiles(source).flatMap(readJsonl).map((r, i) => toSample(r, 'pangu-' + String(i + 1).padStart(6, '0'))); }
function splitSamples(samples) {
  const train = [], evalSet = [];
  for (const sample of samples) (stableBucket(sample.task) < 8 ? train : evalSet).push(sample);
  return { train, eval: evalSet };
}
function quality(samples) {
  const eligible = samples.filter(s => s.eligible_for_positive_training).length;
  const rewarded = samples.filter(s => s.reward > 0).length;
  return { total: samples.length, eligible, rewarded, positive_rate: samples.length ? Number((eligible / samples.length).toFixed(4)) : 0, reward_rate: samples.length ? Number((rewarded / samples.length).toFixed(4)) : 0 };
}
function writeJsonl(file, rows) { fs.writeFileSync(file, rows.map(row => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8'); }
function run(argv = process.argv.slice(2)) {
  const args = { source: path.join(PANGU_HOME, 'evolution'), output: DEFAULT_OUTPUT, minEval: 20, margin: 0.05 };
  for (let i = 0; i < argv.length; i++) { if (argv[i] === '--source') args.source = argv[++i]; else if (argv[i] === '--output') args.output = argv[++i]; else if (argv[i] === '--min-eval') args.minEval = Number(argv[++i]); else if (argv[i] === '--margin') args.margin = Number(argv[++i]); }
  const samples = buildSamples(args.source); const { train, eval: evalSet } = splitSamples(samples); const trainPositive = train.filter(s => s.eligible_for_positive_training);
  const baseline = quality(evalSet); const candidate = quality(trainPositive);
  const promotion = { eligible: evalSet.length >= args.minEval && baseline.positive_rate >= candidate.positive_rate - args.margin, reason: evalSet.length < args.minEval ? 'eval_set_too_small' : 'await_local_policy_review', requires_human_review: true, deployment: 'local-policy-only' };
  fs.mkdirSync(args.output, { recursive: true });
  writeJsonl(path.join(args.output, 'train.jsonl'), trainPositive); writeJsonl(path.join(args.output, 'eval.jsonl'), evalSet); writeJsonl(path.join(args.output, 'negative.jsonl'), train.filter(s => !s.eligible_for_positive_training));
  const manifest = { schema: 'pangu.self-training/v1', generated_at: new Date().toISOString(), source: path.resolve(args.source), split: { train: train.length, eval: evalSet.length, positive_train: trainPositive.length }, baseline, candidate, promotion, deployment: { mode: 'local-policy-only', model_weights_changed: false, code_changed: false } };
  fs.writeFileSync(path.join(args.output, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8'); return manifest;
}
if (require.main === module) console.log(JSON.stringify(run(), null, 2));
module.exports = { stableBucket, buildSamples, splitSamples, quality, run };
