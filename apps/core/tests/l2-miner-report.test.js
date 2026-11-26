'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { test } = require('node:test');

// 2026-08-24 (老板拍 A: L2 cron 矿工) — aggregateL1 聚合 L1 jsonl 后,
// 除 l2/{date}.json 外还要写人读版《进化建议报告》 reports/{date}.md。
// 全程 PANGU_EVO_DIR 指 temp 目录, 零生产副作用 (r46 事故教训)。
//
// 2026-10-26 第 100 批: 账本目录解析收进 modules/evolution_paths.js (唯一真源),
// 开关统一成 PANGU_EVO_DIR —— 原来的 PANGU_EVOLUTION_DIR 是 l2-miner 自己造的第四个名字,
// 跟写方 (evolution_record.js) 认的不是同一个 ⇒ 写进 A 目录、却从 B 目录读。

function setupTmpEvo(t) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'l2-report-iso-'));
  process.env.PANGU_EVO_DIR = tmpDir;
  t.after(() => {
    delete process.env.PANGU_EVO_DIR;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
  return tmpDir;
}

function writeL1(dir, date, records) {
  fs.writeFileSync(
    path.join(dir, date + '.jsonl'),
    records.map(r => JSON.stringify(r)).join('\n') + '\n'
  );
}

// 注意: require 在 env 设置之后 (EVO_DIR 在模块加载时定)
function requireMiner() {
  delete require.cache[require.resolve('../scripts/l2-miner.js')];
  return require('../scripts/l2-miner.js');
}

test('合成异常 L1 → 聚合 json + md 报告, 建议命中', (t) => {
  const tmp = setupTmpEvo(t);
  const date = '2026-08-24';
  const recs = [];
  // 工具 exec_command: 10 次调用 5 次失败 (50% > 10% 阈值)
  for (let i = 0; i < 10; i++) {
    recs.push({ ts: '2026-08-24T01:00:00Z', model: 'good-model', success: i < 5, tool_names: ['exec_command'], error: i >= 5 ? 'SANDBOX_DENIED' : undefined });
  }
  // 模型 bad-model: 4 次调用 1 次成功 (25% < 70% 阈值)
  for (let i = 0; i < 4; i++) {
    recs.push({ ts: '2026-08-24T01:01:00Z', model: 'bad-model', success: i === 0, tool_names: [] });
  }
  writeL1(tmp, date, recs);

  const miner = requireMiner();
  const l2 = miner.aggregateL1(date);
  assert.ok(l2, '聚合应返回结果');
  assert.strictEqual(l2.total_sessions, 14);

  // l2 json 落盘
  const l2File = path.join(tmp, 'l2', date + '.json');
  assert.ok(fs.existsSync(l2File), 'l2 json 应落盘');

  // md 报告落盘 + 内容断言
  const reportFile = path.join(tmp, 'reports', date + '.md');
  assert.ok(fs.existsSync(reportFile), 'md 建议报告应落盘');
  const md = fs.readFileSync(reportFile, 'utf8');
  assert.match(md, /# Pangu 进化建议报告 \(2026-08-24\)/);
  assert.match(md, /exec_command \| 10 \| 50%/, '工具失败率表应含 exec_command 50%');
  assert.match(md, /bad-model \| 4 \| 25%/, '模型成功率表应含 bad-model 25%');
  assert.match(md, /exec_command 失败率 50%/, '修复建议应含工具失败警告');
  assert.match(md, /bad-model 成功率仅 25%/, '修复建议应含模型成功率警告');
  assert.match(md, /只建议, 不改码/);
});

test('正常 L1 (无异常) → 报告显示无建议', (t) => {
  const tmp = setupTmpEvo(t);
  const date = '2026-08-25';
  const recs = [];
  for (let i = 0; i < 6; i++) {
    recs.push({ ts: '2026-08-25T01:00:00Z', model: 'good-model', success: true, tool_names: ['read_file'] });
  }
  writeL1(tmp, date, recs);

  const miner = requireMiner();
  const l2 = miner.aggregateL1(date);
  assert.ok(l2);
  assert.strictEqual(l2.success_rate, 1);
  const md = fs.readFileSync(path.join(tmp, 'reports', date + '.md'), 'utf8');
  assert.match(md, /今日无异常, 无建议/);
});

test('L1 文件不存在 → 返回 null, 不写报告', (t) => {
  const tmp = setupTmpEvo(t);
  const miner = requireMiner();
  const r = miner.aggregateL1('2099-01-01');
  assert.strictEqual(r, null);
  assert.ok(!fs.existsSync(path.join(tmp, 'reports', '2099-01-01.md')));
});
