'use strict';

// 2026-10-19 现场 desktop-1792368769981:
//   plan s1  status: done
//   evidence: ⚠️ 模型 qwen_qwen3.8-27b 端点连不上: read ECONNRESET — 已重试 2 次仍失败
//
// 一刀 ECONNRESET, 计划卡把它计进「nDone」, 将灵卡显示「完成 90.5s」。
// 主人看到的是"它干完了", 实际它一步都没跑成。
//
// 根因是 subagent_runner.js 一句 `只要 _subSummary 非空就标 done` ——
// 而 LLM 调用失败时 j2 把报错文案塞进了 finalText, 那是个非空字符串。
//
// 这条守卫钉住: **失败不许长成 done**。判定表住在 modules/slice_death.js,
// 因为 j2_dispatcher 已经 require 了 subagent_runner, 表不能住在那边(循环依赖)。
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const death = require(path.join(CORE, 'modules', 'slice_death.js'));

// 现场原句, 一个字没改 —— 用真实字符串, 不用自己编的近似样本
const REAL_ECONNRESET =
  '⚠️ 模型 qwen_qwen3.8-27b 端点连不上: read ECONNRESET — 已重试 2 次仍失败。'
  + '请检查网络/DNS, 或在「设置」切换到其他模型 (如本地 qwen3.6-35b)。';
const REAL_DELIVERY =
  '① 完成: 核验盘古模型池与宿主节点配置, 两份文件全文读通, 逐条给出来源。\n'
  + '② 证据:\n- 模型池 (models.json, 7 个, 全 available)';

test('E1 现场那句 ECONNRESET 必须判成 failed, 不许是 done', () => {
  assert.strictEqual(death.stepStatusFor(REAL_ECONNRESET, undefined), 'failed',
    '这句报错文案又变回 done 了 —— 一刀没跑成的东西在界面上显示"完成"');
  assert.strictEqual(death.sliceIsDead(REAL_ECONNRESET), true);
  assert.strictEqual(death.isRealDelivery(REAL_ECONNRESET, undefined), false);
});

test('E2 真产出必须判成 done (别把成功也一起毙了)', () => {
  assert.strictEqual(death.stepStatusFor(REAL_DELIVERY, 'completed'), 'done');
  assert.strictEqual(death.isRealDelivery(REAL_DELIVERY, 'completed'), true);
  assert.strictEqual(death.stepStatusFor(REAL_DELIVERY, 'partial'), 'done',
    'partial 确实有东西交, 归 done; 归 failed 会让"没收口"和"彻底挂了"混成一类');
});

test('E3 空产出不是 done —— done 的前提是有东西交', () => {
  assert.strictEqual(death.stepStatusFor('', 'partial'), 'failed');
  assert.strictEqual(death.stepStatusFor('   ', undefined), 'failed');
  assert.strictEqual(death.isRealDelivery('', 'completed'), false);
});

test('E4 各种死法都得被认出来 (表漂了就白改)', () => {
  const deads = [
    'read ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'LLM_SOCKET_TIMEOUT',
    'STREAM_IDLE_TIMEOUT', 'STREAM_PREFILL_TIMEOUT',
    '⚠️ 模型 x 额度已耗尽 (HTTP 429)', '端点连不上',
  ];
  for (const s of deads) {
    assert.strictEqual(death.sliceIsDead(s), true, '漏认了死法: ' + s);
    assert.strictEqual(death.stepStatusFor(s, undefined), 'failed', '漏认了死法: ' + s);
  }
  assert.strictEqual(death.stepStatusFor('一切正常', 'completed'), 'done');
});

test('E5 subagent_runner 不许再自己判"非空即 done", 且必须用叶子模块', () => {
  // 去注释再扫 —— 修复说明里**写着**那段被判死的代码原文, 不去注释的话
  // 守卫会把自己的说明当成证据, 然后红给自己看 (第一版就这么栽了)。
  const raw = fs.readFileSync(path.join(CORE, 'modules', 'subagent_runner.js'), 'utf8');
  const src = raw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .split('\n').map((l) => l.replace(/(^|[^:])\/\/.*$/, '$1')).join('\n');
  assert.ok(/require\('\.\/slice_death'\)/.test(src),
    'subagent_runner 没引 slice_death —— 判定逻辑又分叉了一份');
  assert.ok(!/runtimeStatus\s*\|\|\s*'done'\s*\)\s*===\s*'done'/.test(src),
    "那个恒为 false 的 `runtimeStatus === 'done'` 又回来了 (取值只有 completed/partial/failed)");
  // 标 step 的那处必须走判定, 不许再无条件 done
  assert.ok(!/updateStep\([^)]*status:\s*'done'/.test(src),
    "updateStep 又无条件标 'done' 了 —— ECONNRESET 会再次被算成完成");
  assert.ok(/stepStatusFor/.test(src), 'step 状态没走 slice_death.stepStatusFor');
});

test('E6 判定表只有一份 (j2_dispatcher 那边不许留副本)', () => {
  const dj = fs.readFileSync(path.join(CORE, 'modules', 'j2_dispatcher.js'), 'utf8');
  assert.ok(!/const _SLICE_DEAD_RE\s*=\s*\/额度已耗尽/.test(dj),
    'j2_dispatcher 又抄了一份正则 —— 这张表历史上就是抄在三处, 只改一处等于没改');
  assert.ok(/require\('\.\/slice_death'\)/.test(dj), 'j2_dispatcher 没用叶子模块的那份');
});

test('E7 slice_death 必须是零依赖叶子 (反向引用会循环)', () => {
  const src = fs.readFileSync(path.join(CORE, 'modules', 'slice_death.js'), 'utf8');
  const body = src.slice(src.indexOf('module.exports'));
  assert.ok(!/require\(/.test(body),
    'slice_death 的导出段引了东西 —— 它得是叶子, '
    + 'j2_dispatcher 和 subagent_runner 互相 require 过, 表放哪边都不安全');
  assert.strictEqual(require(path.join(CORE, 'modules', 'slice_death.js')), death,
    'require 两次不是同一个模块对象 —— 缓存被绕过了');
});
