'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

test('self-evolution uses PANGU_HOME, skips corrupt L1, and saves report', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-evolution-'));
  const date = new Date().toISOString().slice(0, 10);
  fs.mkdirSync(path.join(home, 'evolution'), { recursive: true });
  fs.writeFileSync(path.join(home, 'evolution', `${date}.jsonl`), [
    '{not-json}',
    JSON.stringify({ success: false, tool_names: ['exec_command'], rounds: 5 }),
  ].join('\n'));
  const previous = process.env.PANGU_HOME;
  // 2026-10-26 第 100 批: L1 账本目录的**唯一真源**是 modules/evolution_paths.js,
// 解析顺序 PANGU_EVO_DIR > PANGU_HOME/evolution > ~/.pangu/evolution。
// 本测试要读自己造的 L1 ⇒ 必须把**专用开关** PANGU_EVO_DIR 指过去;
// 只设 PANGU_HOME 会被链沙箱里的 PANGU_EVO_DIR 抢在前面 ⇒ 读到别处去。
  const previousEvo = process.env.PANGU_EVO_DIR;
  process.env.PANGU_EVO_DIR = path.join(home, 'evolution');
  process.env.PANGU_HOME = home;
  try {
    delete require.cache[require.resolve('../agents/self-evolution')];
    const evolution = require('../agents/self-evolution');
    const report = await evolution.evolve();
    assert.equal(report.l1Records, 1);
    assert.equal(evolution.getLastReport().l1Records, 1);
    assert.ok(fs.existsSync(path.join(home, 'state', 'evolution', `l2-insights-${date}.json`)));
  } finally {
    if (previousEvo === undefined) delete process.env.PANGU_EVO_DIR;
    else process.env.PANGU_EVO_DIR = previousEvo;
    if (previous === undefined) delete process.env.PANGU_HOME;
    else process.env.PANGU_HOME = previous;
  }
});

test('scheduler implements pangu self-reflect and inbox actions', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-scheduler-'));
  const previous = process.env.PANGU_HOME;
  process.env.PANGU_HOME = home;
  try {
    delete require.cache[require.resolve('../modules/scheduler')];
    const scheduler = require('../modules/scheduler');
    const reflect = await scheduler._runJobAction('pangu.self_reflect', {});
    assert.equal(reflect.ok, true);
    const inbox = path.join(home, 'inbox');
    const learned = path.join(home, 'learned');
    fs.mkdirSync(inbox, { recursive: true });
    fs.writeFileSync(path.join(inbox, 'note.txt'), 'lesson');
    const scan = await scheduler._runJobAction('pangu.inbox_scan', { inbox_dir: inbox, learned_dir: learned });
    assert.equal(scan.moved, 1);
    assert.equal(fs.readFileSync(path.join(learned, 'note.txt'), 'utf8'), 'lesson');
  } finally {
    if (previous === undefined) delete process.env.PANGU_HOME;
    else process.env.PANGU_HOME = previous;
  }
});
