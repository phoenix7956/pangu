#!/usr/bin/env node
'use strict';

// Safe self-training cycle: build corpus, apply explicit feedback, gate updates.
// This improves routing/prompt state; model weights still require a CUDA trainer.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { sourceFiles, readJsonl, toSample } = require('./agent_lightning_rollouts');

function getHome() { return process.env.PANGU_HOME || path.join(os.homedir(), '.pangu'); }

function readLines(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).flatMap(line => {
    try { return [JSON.parse(line)]; } catch (_) { return []; }
  });
}
function loadState() {
  try { return JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch (_) {
    return { version: 1, accepted_cycles: 0, last_score: null, last_run: null };
  }
}
function score(samples, feedback) {
  const eligible = samples.filter(s => s.eligible_for_positive_training);
  const base = samples.length ? eligible.length / samples.length : 0;
  const explicit = feedback.filter(f => f.label === 'positive' || f.label === 'negative');
  const positives = explicit.filter(f => f.label === 'positive').length;
  const negatives = explicit.filter(f => f.label === 'negative').length;
  const feedbackRate = explicit.length ? positives / explicit.length : null;
  return { total: samples.length, eligible: eligible.length, base_rate: Number(base.toFixed(4)), feedback: explicit.length, positives, negatives, feedback_rate: feedbackRate };
}
function run(argv = process.argv.slice(2)) {
  const home = getHome();
  const stateDir = path.join(home, 'state', 'training');
  const feedbackFile = path.join(stateDir, 'feedback.jsonl');
  const stateFile = path.join(stateDir, 'state.json');
  fs.mkdirSync(stateDir, { recursive: true });
  const source = argv[argv.indexOf('--source') + 1] || path.join(home, 'evolution');
  const out = argv[argv.indexOf('--output') + 1] || path.join(stateDir, 'corpus.jsonl');
  const feedback = readLines(feedbackFile);
  const records = sourceFiles(source).flatMap(readJsonl);
  const samples = records.map((r, i) => toSample(r, `pangu-${String(i + 1).padStart(6, '0')}`));
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, samples.map(s => JSON.stringify(s)).join('\n') + (samples.length ? '\n' : ''));
  const metrics = score(samples, feedback);
  const previous = loadState();
  const candidate = { ...previous, last_run: new Date().toISOString(), last_metrics: metrics, feedback_file: feedbackFile, corpus_file: out };
  // Gate: never accept a cycle with no data or explicit degradation.
  const enough = metrics.total >= 5;
  const degraded = previous.last_score != null && metrics.base_rate + 0.05 < previous.last_score;
  candidate.accepted = enough && !degraded;
  candidate.reason = !enough ? 'need_at_least_5_samples' : degraded ? 'candidate_degraded' : 'passed_gate';
  if (candidate.accepted) { candidate.accepted_cycles = (previous.accepted_cycles || 0) + 1; candidate.last_score = metrics.base_rate; }
  fs.writeFileSync(stateFile, JSON.stringify(candidate, null, 2));
  console.log(JSON.stringify({ ok: true, accepted: candidate.accepted, reason: candidate.reason, metrics, corpus: out, state: stateFile }));
  return { candidate, metrics, samples };
}
if (require.main === module) run();
module.exports = { readLines, score, run };
