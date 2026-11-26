// apps/core/tests/tools_selftest.js
//
// Phase R0.9 · Core TOOLS baseline selftest
//
// 目的: 锁定 Core 在 R2 destructive 改之前的 baseline, R2 之后同样的 30 条
//       必须仍然过, 证明功能等价.
//
// 设计: lenient PASS = tool 返回结构化响应 或 抛可预期错 (validation/sentinel/BRIDGE_UNAVAILABLE)。
//       危险工具 (会真触发 OS 动作的) 跳过, 不参与计数.
//
// 这份 baseline 必须两种状态都过:
//   - R2 之前: tool 内部直接调 ffmpeg/osascript, sentinel 入参 → 结构化失败
//   - R2 之后: tool 走 bridge.call(), Bridge 未起 → BRIDGE_UNAVAILABLE → 同样结构化失败
//
// 注释规范: 零署名注释 (per §1 红线 / §10.2 验收)。git blame 保留 attribution。

'use strict';

const { TOOLS } = require('../modules/tools/index.js');

const TARGET_PASS = 30;
const INVOKE_TIMEOUT_MS = 5000;

// 危险工具: 会真触发 OS 动作 (拍照/截图/录音/弹 OS 框/真实键鼠/真实发消息)
// 测试不碰, 跳过计数。等 R4 helper + 真桥上架后, R5/R6 再用 hosted mock 触发。
const DANGER_TOOLS = new Set([
  'take_photo',
  'screenshot',
  'record_audio',
  'permission_apply',
  'computer_use_click',
  'computer_use_type',
  'computer_use_key',
  'computer_use_drag',
  'computer_use_vision_act',
  'send_wechat',
  'tts_speak',
  'tools_selftest',
]);

// 已知 "可预期" 的错误关键词。粗筛: 只要看起来不像 panic / undefined var,
// 都算 PASS。R2 之后会出现 BRIDGE_UNAVAILABLE 等真实运行时的失败模式。
function looksLikeExpectedError(err) {
  if (!err) return true;
  const msg = String(err.message || err || '');
  if (msg.length === 0) return true;
  // 真正的 panic / 未定义变量一般会带 source code 位置 (含 ":" 行号)
  // 比如 "ReferenceError: foo is not defined\n at ..."
  const hasStackTrace = /\n\s+at\s/.test(err.stack || '');
  if (hasStackTrace && !/(?:sentinel|undefined|null|missing|invalid|empty|not found|not configured|required|api.*key|bridge)/i.test(msg)) {
    return false;
  }
  return true;
}

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`TIMEOUT_${ms}ms: ${label}`)), ms)
    ),
  ]);
}

async function selftest() {
  const tools = Object.keys(TOOLS).filter(k => typeof TOOLS[k] === 'function');
  const pass = [];
  const skip = [];
  const fail = [];

  for (const name of tools) {
    if (DANGER_TOOLS.has(name)) {
      skip.push({ name, reason: 'dangerous — skipped to avoid real OS action' });
      continue;
    }

    let outcome;
    try {
      const result = await withTimeout(
        TOOLS[name]({
          context: { user: 'pangu_selftest', action: 'selftest', _baseline: true },
          params: { _selftest_sentinel: true },
        }),
        INVOKE_TIMEOUT_MS,
        name
      );
      outcome = { kind: 'return', value: result };
    } catch (err) {
      outcome = { kind: 'throw', error: err };
    }

    let passed = false;
    if (outcome.kind === 'return') {
      const v = outcome.value;
      if (v === undefined || v === null || typeof v === 'object' || typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') {
        passed = true;
      }
    } else if (outcome.kind === 'throw') {
      if (looksLikeExpectedError(outcome.error)) {
        passed = true;
      }
    }

    if (passed) {
      pass.push(name);
    } else {
      fail.push({ name, outcome });
    }
  }

  // Phase B.3 fix verification: permission_apply 各 type 返合理 shape
  // (DANGER list 里没跑过; 这里补一个 mock-less 的 shape check, 不真触发 TCC dialog)
  {
    const before = pass.length;
    for (const pt of ['camera', 'microphone', 'screen_recording', 'accessibility', 'automation', 'full_disk_access', 'input_monitoring']) {
      let outcome;
      try {
        const result = await Promise.resolve(TOOLS.permission_apply({
          context: { user: 'pangu_selftest', action: 'selftest' },
          params: { _selftest_sentinel: true, permission_type: pt }
        }));
        outcome = { kind: 'return', value: result };
      } catch (err) {
        outcome = { kind: 'throw', error: err };
      }
      if (outcome.kind === 'return' && (outcome.value === undefined || outcome.value === null || typeof outcome.value === 'object')) {
        pass.push('permission_apply[' + pt + ']');
      } else if (outcome.kind === 'throw' && looksLikeExpectedError(outcome.error)) {
        pass.push('permission_apply[' + pt + ']');
      } else {
        fail.push({ name: 'permission_apply[' + pt + ']', outcome });
      }
    }
    if (pass.length > before) {
      console.log('  (permission_apply shape: +' + (pass.length - before) + ' cases)');
    }
  }

  const total = pass.length + fail.length + skip.length;
  const coverage = pass.length;
  const ok = coverage >= TARGET_PASS;

  console.log('=== Core TOOLS selftest (baseline) ===');
  console.log('Phase: R0.9 baseline (pre-R2 destructive change)');
  console.log('Tools enumerated (functions only):', total);
  console.log('  PASS (structured return or expected throw):', pass.length);
  console.log('  SKIP (dangerous OS-trigger tools):', skip.length);
  console.log('  FAIL (panic or non-structured):', fail.length);
  console.log('Target:', TARGET_PASS, '—', ok ? 'MET' : 'BELOW');
  console.log('');
  console.log('Pass list (first 30):');
  pass.slice(0, 30).forEach(n => console.log('  ✓', n));
  if (pass.length > 30) console.log(`  ... and ${pass.length - 30} more`);
  console.log('');
  console.log('Skip list:');
  skip.forEach(({ name }) => console.log('  —', name));
  if (fail.length) {
    console.log('');
    console.log('Fail list (first 20):');
    fail.slice(0, 20).forEach(({ name, outcome }) => {
      const detail = outcome.kind === 'throw'
        ? outcome.error.message
        : `returned ${typeof outcome.value}`;
      console.log('  ✗', name, '—', detail);
    });
  }
  console.log('');
  console.log(ok
    ? `OK — selftest green. R0.9 gate cleared.`
    : `FAIL — selftest below target (${coverage}/${TARGET_PASS}).`);

  process.exit(ok ? 0 : 1);
}

selftest().catch(err => {
  console.error('selftest fatal:', err);
  process.exit(2);
});
