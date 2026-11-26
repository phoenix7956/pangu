'use strict';

const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pangu-evolution-record-'));
const previousHome = process.env.HOME;
// 2026-10-26 第 100 批: 账本目录解析收在 modules/evolution_paths.js (唯一真源),
// 顺序是 PANGU_EVO_DIR > PANGU_HOME/evolution > ~/.pangu/evolution。
// 本测试只改 HOME ⇒ 会被链沙箱里的 PANGU_EVO_DIR 抢在前面, 账本落到别处 ⇒ ENOENT。
// ⇒ 显式把**专用开关**指到自己造的目录, 并同时改 HOME 兜底 (双保险, 绝不碰生产)。
const previousEvo = process.env.PANGU_EVO_DIR;
process.env.PANGU_EVO_DIR = path.join(home, '.pangu', 'evolution');
process.env.HOME = home;
try {
  const { _recordEvolution } = require('../modules/evolution_record');
  _recordEvolution({
    success: true,
    runtime_status: 'completed',
    tool_calls_total: 0,
    tool_names: ['task_done'],
    final_text: '已完成',
  });
  const file = path.join(home, '.pangu', 'evolution', new Date().toISOString().slice(0, 10) + '.jsonl');
  const record = JSON.parse(fs.readFileSync(file, 'utf8').trim());
  assert.equal(record.success, false);
  assert.equal(record.effective_success, false);
  assert.equal(record.runtime_status, 'failed');
  _recordEvolution({
    success: true,
    runtime_status: 'completed',
    tool_calls_total: 1,
    tool_names: ['exec_command'],
    final_text: '<think>internal chain of thought</think>\n\n命令执行成功。',
  });
  const records = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(records[1].final_text, '命令执行成功。');

  // 2026-10-15 现场实证: 主人"只回一个词: 盘古", 模型答"盘古" —— 完全正确的交付,
  // 账本却写 runtime_status="failed" / success=false。
  // 根因: execution_succeeded 传的是 record.success, 而它的含义是"有没有 task_done 收口",
  // 于是每一个没调 task_done 的正常轮次(聊天/直答/短答)都被当成执行失败。
  // 这条假失败会继续喂给 L1→L2→L3, 会自我放大, 所以必须在这一层钉住。
  _recordEvolution({
    input: '只回一个词: 盘古',
    success: false,              // 调用方的 completed 判定: 短答没调 task_done, 确实 false
    runtime_status: 'partial',
    tool_calls_total: 0,
    real_tool_calls_total: 0,
    tool_names: [],
    final_text: '盘古',
  });
  const all = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  const terse = all[all.length - 1];
  assert.equal(terse.final_text, '盘古');
  assert.notEqual(terse.runtime_status, 'failed',
    '正确的短答在账本里被记成 failed —— execution_succeeded 拿 task_done 当成功标志了');
  assert.equal(terse.runtime_status, 'partial');

  // 但"报错又一个字都没产出"仍然是真失败, 不能一起放过。
  _recordEvolution({
    success: false,
    runtime_status: 'failed',
    tool_calls_total: 0,
    real_tool_calls_total: 0,
    tool_names: [],
    final_text: '   ',
    error: 'LLM_SOCKET_TIMEOUT_300s',
  });
  const all2 = fs.readFileSync(file, 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(all2[all2.length - 1].runtime_status, 'failed',
    '真失败(有 error 且零产出)被洗成 partial —— 那等于把故障静音');
} finally {
  if (previousEvo === undefined) delete process.env.PANGU_EVO_DIR;
  else process.env.PANGU_EVO_DIR = previousEvo;
  if (previousHome === undefined) delete process.env.HOME;
  else process.env.HOME = previousHome;
}

console.log('evolution record tests: ok');
