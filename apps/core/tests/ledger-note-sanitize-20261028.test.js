'use strict';
/**
 * tests/ledger-note-sanitize-20261028.test.js
 *
 * 账本守卫文件里的机器路径 —— 必须洗掉 (第 140 批)
 *
 * ── 起因 ──────────────────────────────────────────────────────
 *   `tests/ledger-lessons.test.js` 是**签进仓里**的守卫文件 (每日反思自动重建),
 *   内容里的「最近: …」来自运行时账本 —— 常带本机绝对路径
 *   (例: 「声称写盘 /Users/<某人>/.pangu/models-registry.json」)。
 *   ⇒ 开着服务跑一轮, 仓里就被写进**本机绝对路径** ⇒ 开源导出体检直接红
 *     ⇒ **导出被卡死** (第 140 批实测: publish-open-source.js 拒绝导出)。
 *   这跟「桌面端剥离」同一类: 机器状态不许漏进开源产物。
 *
 * 本文件锁三件事:
 *   1. sanitizeNote 把本机家目录换成 ~
 *   2. 别人的家目录前缀 (/Users/you/、/home/you/) 也换成 ~/
 *   3. 生成出来的守卫文件里不许出现任何 /Users/ 或 /home/ 的机器路径
 */
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const CORE = path.join(__dirname, '..');
const lr = require(path.join(CORE, 'modules', 'ledger_reflect.js'));

test('140-8: sanitizeNote 把本机家目录换成 ~', () => {
  const home = os.homedir();
  const out = lr.sanitizeNote('声称写盘 ' + home + '/.pangu/models-registry.json 但账上无记录');
  assert.ok(!out.includes(home), '本机家目录不许出现在洗过的 note 里: ' + out);
  assert.ok(out.includes('~/.pangu/models-registry.json'), '路径要保留成 ~ 形式: ' + out);
});

test('140-8b: 别人的家目录前缀也换成 ~/', () => {
  for (const p of ['/Users/you/.pangu/x.json', '/home/you/x.json']) {
    const out = lr.sanitizeNote('写了 ' + p);
    assert.ok(!/\/(Users|home)\//.test(out), '机器路径没洗掉: ' + out);
    assert.ok(out.includes('~/'), '路径要保留成 ~ 形式: ' + out);
  }
});

test('140-8c: 生成出来的守卫文件里不许有机器路径', () => {
  const file = path.join(CORE, 'tests', 'ledger-lessons.test.js');
  const src = fs.readFileSync(file, 'utf8');
  assert.ok(!/\/(Users|home)\/[A-Za-z0-9._-]+\//.test(src),
    '守卫文件里出现了机器绝对路径 —— 开着服务跑一轮就会漏进开源产物');
});
