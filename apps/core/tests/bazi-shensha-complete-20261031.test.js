'use strict';
// 2026-10-31 第 182 批: 神煞按课件 08/09 补齐, 老板盘逐柱 16 条与上课 app 逐字一致。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

test('bazi_calc.py 输出 shensha_by_pillar 字段', () => {
  const py = fs.readFileSync(path.join(ROOT, 'modules/tools/bazi/bazi_calc.py'), 'utf-8');
  assert.match(py, /shensha_by_pillar/);
});

test('老板盘逐柱神煞 16 条与上课 app 逐字一致', async () => {
  const { execFile } = require('node:child_process');
  const { promisify } = require('node:util');
  const pExec = promisify(execFile);
  // bazi_calc.py 依赖 /usr/bin/python3 已装 sxtwl。没装就**跳过** (不是 fail),
  //   免得把「环境缺依赖」当成「排盘逻辑错」报红 —— 有 sxtwl 的机器照验 16 条。
  try {
    await pExec('python3', ['-c', 'import sxtwl'], { stdio: 'pipe' });
  } catch (_) {
    test.skip?.();
    console.log('skip: 本机 python3 未装 sxtwl (bazi_calc.py 的真万年历依赖), 16 条逐字判据在本机验不了');
    return;
  }
  const pyScript = path.join(ROOT, 'modules/tools/bazi/bazi_calc.py');
  const out = await pExec('python3', [pyScript, '1986', '12', '17', '16', '0', 'male',
    '--city', '上海', '--district', '宝山区', '--province', '上海'],
    { maxBuffer: 10 * 1024 * 1024 });
  const d = JSON.parse(out.stdout);
  const sp = d.shensha_by_pillar || {};
  assert.deepEqual(sp['年柱'], ['羊刃', '秀贵人', '亡神']);
  assert.deepEqual(sp['月柱'], ['天乙贵人', '太极贵人', '吊客', '桃花', '灾煞']);
  assert.deepEqual(sp['日柱'], ['华盖', '童子煞']);
  assert.deepEqual(sp['时柱'], ['天乙贵人', '文昌贵人', '天德合', '秀贵人', '驿马', '劫煞']);
  const total = Object.values(sp).reduce((a, arr) => a + arr.length, 0);
  assert.equal(total, 16);
});

test('四柱表有「神煞」行', () => {
  const mjs = fs.readFileSync(path.join(ROOT, 'web/app/lib/bazi/pillars.mjs'), 'utf-8');
  assert.match(mjs, /label:\s*'神煞'/);
});

test('页面有「神煞与地支关系」块', () => {
  const mjs = fs.readFileSync(path.join(ROOT, 'web/app/views/bazi.mjs'), 'utf-8');
  assert.match(mjs, /神煞与地支关系/);
  assert.match(mjs, /bz-shensha-box/);
});

test('解读喂逐柱神煞', () => {
  const mjs = fs.readFileSync(path.join(ROOT, 'web/app/lib/bazi/reading.mjs'), 'utf-8');
  assert.match(mjs, /逐柱神煞:\s*chart\.shensha_by_pillar/);
});

test('撤的是神煞不是别的 —— 文昌位/命宫/空亡/自坐 都还在', () => {
  const py = fs.readFileSync(path.join(ROOT, 'modules/tools/bazi/bazi_calc.py'), 'utf-8');
  assert.match(py, /wenchang_wei/);
  assert.match(py, /minggong/);
  assert.match(py, /xunkong_4/);
  assert.match(py, /zichuan_4/);
});
