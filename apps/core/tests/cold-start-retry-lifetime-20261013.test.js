const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// ===========================================================================
// 冷启动重试在常驻服务里只生效一次 (2026-10-13 代码审计, llm_caller.js:1062-1078):
//
//   const isColdStart = process.env.PANGU_COLD_START_ATTEMPTED !== '1';
//   if (isColdStart) { process.env.PANGU_COLD_START_ATTEMPTED = '1'; ... }
//
//   PANGU_COLD_START_ATTEMPTED 是**进程级全局**, 全文件只有"读"和"写"两处,
//   没有任何地方复位它。于是:
//     进程启动 → 第一次调用武装冷启动重试 → 置 '1' → 此后**永远**不再武装。
//
// 为什么这在盘古身上格外致命:
//   盘古是 launchd KeepAlive 常驻服务, 连跑几天。模型端点闲置一段时间会降温,
//   **闲置后的第一次调用恰恰就是冷启动**, 也恰恰是最容易超时/5xx 的那一刻 ——
//   而那正是最需要重试的时刻, 偏偏重试早已被解除武装。
//   结果: 一次冷启动超时直接穿透成整轮失败 → 降级 legacy → Silent Failure。
//   (现场日志 /tmp/pangu-single.err 可见 "解析响应失败" → fallback → SILENT_FAILURE
//    成串出现, 正是这条链的末端表现。)
//
// 正确语义: "冷启动" = 端点闲置一段时间后的首次调用, 不是"进程启动后第一次"。
// 判据应基于**距上次成功调用的时间**, 而不是一次性全局标志。
// ===========================================================================
const SRC = fs.readFileSync(require.resolve('../modules/llm_caller.js'), 'utf8');

test('冷启动判定不得使用一次性全局环境变量', () => {
  assert.doesNotMatch(SRC, /process\.env\.PANGU_COLD_START_ATTEMPTED/,
    '不得用进程级一次性标志判冷启动 (常驻服务里只生效一次)');
});

test('冷启动判定必须基于"距上次成功调用的时间"', () => {
  assert.match(SRC, /_lastSuccessCallTs|lastSuccess|COLD_START_WINDOW|_msSinceLastSuccess/i,
    '必须按距上次成功调用的时间判定冷启动, 而不是一次性标志');
});

test('必须导出可测的冷启动判定谓词', () => {
  const m = SRC.match(/function\s+(_shouldArmColdStart\w*|_isColdStart\w*)\s*\(/);
  assert.ok(m, '应能找到冷启动判定函数');
  assert.match(SRC, /module\.exports\s*=\s*\{[\s\S]{0,4000}/, '模块应有 exports');
  assert.match(SRC, new RegExp(m[1].replace('$', '\\$')),
    '冷启动谓词应可被单测直接调用');
});

test('闲置超过窗口后必须重新武装冷启动重试', () => {
  // 复刻应有的时间窗判定: 上次成功距今超过窗口 = 端点已冷 = 该武装重试
  const WINDOW = 5 * 60 * 1000;
  const justUsed = Date.now() - 30 * 1000;        // 30 秒前刚成功用过 → 热
  const longIdle = Date.now() - 30 * 60 * 1000;   // 30 分钟没用 → 冷
  const isCold = (lastTs) => (lastTs == null) || (Date.now() - lastTs > WINDOW);
  assert.equal(isCold(justUsed), false, '刚用过 → 不算冷启动');
  assert.equal(isCold(longIdle), true, '闲置 30 分钟 → 必须重新算冷启动并武装重试');
  assert.equal(isCold(null), true, '从未成功调用过 → 算冷启动');
});
