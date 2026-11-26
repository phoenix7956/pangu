#!/usr/bin/env node
/**
 * Pangu 自我修复检测器 v1 (2026-08-11 老板拍 §R131-Phase 1)
 *
 * 角色: 发现 Pangu 自己的 bug / 异常 → 写 pending JSON + 报警
 * 不自动 patch (Phase 2 才做)
 *
 * 检测源 (3 处):
 *   1. Pangu SSE 错误 / 异常退出 (扫 /tmp/openclaw/openclaw-YYYY-MM-DD.log 和 /tmp/pangu-single.log)
 *   2. L1 dogfooding success:false (扫 ~/.pangu/evolution/{today}.jsonl)
 *   3. Self-check verify fail (扫 ~/Library/Logs/pangu/self-check.log)
 *
 * 输出:
 *   ~/.pangu/repair/pending-{ts}.json  ← 等待 Phase 2 runner 处理
 *   ~/Library/Logs/pangu/repair-watcher.log  ← 日志
 *   macOS 通知 (去重: 同一信号源 30 分钟内不重复弹)
 *
 * 用法:
 *   node pangu-repair-watcher.js              # 检测一次
 *   node pangu-repair-watcher.js --test       # 强制制造一个测试信号 (验证流程)
 *   node pangu-repair-watcher.js --quiet      # 不弹通知, 仅写 pending
 *
 * Cron: launchd local.pangu-repair-watcher.plist, StartInterval=300 (5 分钟)
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');
// 2026-10-26 第 100 批: 账本目录走唯一真源 (apps/core/modules/evolution_paths.js)。
// 看门狗是**读方** —— 读方不认沙箱开关, 看门狗就永远读生产账本,
// 沙箱里跑链算出来的失败率全是生产数据 ⇒ 守卫结论全是假的。
const { evolutionDir } = require('../apps/core/modules/evolution_paths');

// 第 100 批: 三个目录都可用 env 覆盖 ——
// ① 看门狗**读**的进化账本必须能指向沙箱 (否则测试会读生产账本, 也会把统计信号写进生产 pending 队列);
// ② pending 产物目录要能导走 (生产队列被 45K token 空转塞满了 4775 个 failed-*.json);
// ③ 日志目录同理 (测试不该往生产日志里写)。
// 命名跟第 100 批跑批器 / 账本保持一致: PANGU_REPAIR_DIR / PANGU_EVO_DIR。
const REPAIR_DIR = process.env.PANGU_REPAIR_DIR || path.join(os.homedir(), '.pangu', 'repair');
const LOG_DIR = process.env.PANGU_LOG_DIR || path.join(os.homedir(), 'Library', 'Logs', 'pangu');
const LOG = path.join(LOG_DIR, 'repair-watcher.log');
const SELF_CHECK_LOG = path.join(LOG_DIR, 'self-check.log');
const ALERT_QUEUE = path.join(LOG_DIR, 'alert_queue.txt');

const DEDUP_WINDOW_MS = 30 * 60 * 1000;  // 30 分钟同信号去重
const MAX_PENDING = 20;  // 防爆, 超过就 trim 老的

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

function log(msg) {
  const line = '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] ' + msg;
  console.log(line);
  try { ensureDir(LOG_DIR); fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}

function notifyMacOS(title, body) {
  try {
    execSync(`osascript -e 'display notification "${body.replace(/"/g, '\\"')}" with title "${title.replace(/"/g, '\\"')}"'`, { stdio: 'ignore', timeout: 3000 });
  } catch (_) {}
}

function writeAlert(msg) {
  try {
    ensureDir(LOG_DIR);
    fs.appendFileSync(ALERT_QUEUE, '⚠️ ' + msg + '\nTime: ' + new Date().toISOString() + '\n\n');
  } catch (_) {}
}

let _seqCounter = 0;
// 第 100 批 (2026-10-26): repairable 标记 —— 「这条信号跑批器修得了吗」。
//
// 为什么要有这个标记: 修复跑批器的输入是**代码缺陷 + 源码上下文**。
// 「今日 L1 失败率 331/542」是**统计信号**, 跑批器改不了它 ——
// 2026-10-26 实测: 它把 136KB 的进化账本当源码上下文发去问模型,
// 模型只能答 "这是日志不是源码" → confidence=0 → 跳过。
// 累计启动 10002 次、success=0 次, 而每次都霸占本地 27B 十几分钟
// ⇒ 老板的对话全排在它后面 (本地慢的真凶)。
//
// ⇒ 统计型信号**只报警不排队**: 失败率该给老板看, 但不该占跑批器的队列。
//   真正带源码位置 (文件+行号) 的代码缺陷信号 (pangu-error / self-check-fail) 才排队。
function writePending(signal, severity, summary, evidence, extra) {
  ensureDir(REPAIR_DIR);
  const id = 'pending-' + Date.now() + '-' + (++_seqCounter);
  const fp = path.join(REPAIR_DIR, id + '.json');
  const payload = {
    id,
    ts: Date.now(),
    signal,           // 'pangu-error' | 'l1-fail' | 'self-check-fail'
    severity,         // 'critical' | 'warning' | 'info'
    summary,
    evidence,         // { logLine, count, files }
    status: 'pending',
  };
  if (extra && typeof extra === 'object') Object.assign(payload, extra);
  fs.writeFileSync(fp, JSON.stringify(payload, null, 2));
  log('📝 pending 写入: ' + fp);
  return id;
}

function trimOldPending() {
  const files = fs.readdirSync(REPAIR_DIR).filter(f => f.startsWith('pending-') && f.endsWith('.json')).sort();
  if (files.length <= MAX_PENDING) return;
  const remove = files.slice(0, files.length - MAX_PENDING);
  for (const f of remove) {
    try { fs.unlinkSync(path.join(REPAIR_DIR, f)); } catch (_) {}
  }
  log('🧹 trim ' + remove.length + ' 个旧 pending');
}

// M5 fix: pending 列表内存缓存 — 仅当 REPAIR_DIR mtime 变化 (文件增删) 时才重新扫盘,
// 避免每次 shouldDedup 都 readdirSync + 逐个读 JSON (20+ 次磁盘 IO)
let _dedupCache = { mtimeMs: -1, entries: [] };

function _loadPendingEntries() {
  if (!fs.existsSync(REPAIR_DIR)) return [];
  let mtimeMs = 0;
  try { mtimeMs = fs.statSync(REPAIR_DIR).mtimeMs; } catch (_) {}
  if (mtimeMs === _dedupCache.mtimeMs) return _dedupCache.entries;
  const files = fs.readdirSync(REPAIR_DIR).filter(f => f.startsWith('pending-') && f.endsWith('.json'));
  const entries = [];
  for (const f of files) {
    try {
      const p = JSON.parse(fs.readFileSync(path.join(REPAIR_DIR, f), 'utf8'));
      entries.push({ signal: p.signal, ts: p.ts });
    } catch (_) {}
  }
  _dedupCache = { mtimeMs, entries };
  return entries;
}

function shouldDedup(signal) {
  // 30 分钟内同 signal 不重复报警 (但仍写 pending)
  const entries = _loadPendingEntries();
  // L5 fix: pending 已达 MAX_PENDING 上限, 直接去重, 不再继续放大写入
  if (entries.length >= MAX_PENDING) return true;
  const cutoff = Date.now() - DEDUP_WINDOW_MS;
  return entries.some(p => p.signal === signal && p.ts > cutoff);
}

// ========== 信号源 1: Pangu runtime errors ==========
// 修复 (8/12 09:57): 只扫 Pangu 自己的 log, 不再误扫 OpenClaw log
// 旧逻辑把 /tmp/openclaw/openclaw-YYYY-MM-DD.log 当 Pangu log, 模式 /Error: /g 太宽泛 → 每 30min 误报轰炸
function scanPanguErrors() {
  // 只扫 Pangu 自己的 log (不再扫 OpenClaw)
  const panguLog = path.join(LOG_DIR, 'pangu-single.log');  // ~/Library/Logs/pangu/pangu-single.log
  const fallbackLog = '/tmp/pangu-single.log';
  const logCandidates = [panguLog, fallbackLog].filter(fs.existsSync);
  if (logCandidates.length === 0) {
    log('⚠ 未找到 Pangu log (期望: ' + panguLog + ' 或 ' + fallbackLog + ')');
    return 0;
  }
  // 严格错误模式 (不是宽泛的 "Error: ")
  // 必须包含 Node.js / Pangu 自己的特有错误签名, 避免日常日志中的 "error:" 误报
  const errorPatterns = [
    /TypeError: /g,                              // JS 类型错误
    /UnhandledPromiseRejectionWarning/g,         // 未处理 Promise
    /Cannot find module/g,                        // 模块找不到
    /JavaScript heap out of memory/g,             // 内存溢出
    /FATAL: /g,                                   // 致命错误
    /RangeError: /g,                              // 范围错误 (Pangu 64 卦索引偶尔会)
    /SyntaxError: /g,                             // 语法错误
    /EACCES: permission denied/g,                 // 权限
    /pangu-single\.js.*throw /g,                  // Pangu 自己 throw
  ];
  let findings = 0;
  for (const logPath of logCandidates) {
    try {
      const content = fs.readFileSync(logPath, 'utf8');
      for (const re of errorPatterns) {
        const matches = content.match(re) || [];
        if (matches.length >= 5) {  // 阈值提高 3→5, 防止偶发误报
          const evidence = matches.slice(-3).join(' || ');
          const signal = 'pangu-error:' + re.source.slice(0, 40);
          if (!shouldDedup(signal)) {
            writePending(signal, 'critical', `${matches.length} 个 ${re.source.slice(0, 30)} 在 ${path.basename(logPath)}`, {
              logLine: evidence,
              count: matches.length,
              files: [logPath],
            });
            writeAlert(`Pangu ${re.source.slice(0, 40)} × ${matches.length} (${path.basename(logPath)})`);
            notifyMacOS('盘古异常', `${re.source.slice(0, 30)} × ${matches.length}`);
            findings++;
          } else {
            log('⏭ 跳过 (dedup): ' + signal);
          }
          break;
        }
      }
    } catch (e) {
      log('⚠ 扫 ' + logPath + ' 失败: ' + e.message);
    }
  }
  return findings;
}

// ========== 信号源 2: L1 dogfooding success:false ==========
function scanL1Failures() {
  const today = new Date().toISOString().slice(0, 10);
  const evoFile = path.join(evolutionDir(), today + '.jsonl');
  if (!fs.existsSync(evoFile)) return 0;
  try {
    const lines = fs.readFileSync(evoFile, 'utf8').trim().split('\n').filter(Boolean);
    let failCount = 0;
    const failEvidence = [];
    for (const line of lines) {
      try {
        const rec = JSON.parse(line);
        // 2026-08-24 老板拍 (20:18 通知实案: "8/30 今日失败" 全是误报, "没意义, 取消"):
        // ① SILENT_FAIL_CHAIN_SWITCH_TO_* 是链切换中途记录 — 请求已被下个模型接盘答完,
        //    不是真失败, 不计数 (真失败 = 链耗尽的 SILENT_FAILURE 收口)
        // ② macOS 通知整个取消 (notifyMacOS 调用删除), 修复队列信号保留但只算真失败
        const err = String(rec.error || '');
        if (rec.success === false && !err.startsWith('SILENT_FAIL_CHAIN_SWITCH_TO_')) {
          failCount++;
          failEvidence.push(rec.tool_names ? rec.tool_names.join(',') : rec.error || 'unknown');
        }
      } catch (_) {}
    }
    if (failCount >= 2) {
      const signal = 'l1-fail:' + today;
      if (!shouldDedup(signal)) {
        writePending(signal, 'warning', `今日 L1 真失败 ${failCount}/${lines.length} 次 (不含链切换中途记录)`, {
          count: failCount,
          total: lines.length,
          sample: failEvidence.slice(0, 5).join(' | '),
          files: [evoFile],
        }, {
          // 第 100 批: 这是**统计信号**, 不是代码缺陷 ⇒ 跑批器改不了 ⇒ 别占跑批器的队列。
          // 失败率仍然写 alert 给老板看 (那是它该去的地方), 但不再触发 45K token 的模型请求。
          repairable: false,
        });
        if (failCount >= 5) {
          writeAlert(`L1 真失败率 ${(failCount / lines.length * 100).toFixed(0)}% (${failCount}/${lines.length})`);
        }
        return 1;
      }
    }
  } catch (e) {
    log('⚠ L1 扫失败: ' + e.message);
  }
  return 0;
}

// ========== 信号源 3: self-check verify fail ==========
function scanSelfCheck() {
  if (!fs.existsSync(SELF_CHECK_LOG)) return 0;
  try {
    const content = fs.readFileSync(SELF_CHECK_LOG, 'utf8');
    const lines = content.split('\n').reverse();
    // 找最近 1 小时内 self-check run 的 fail 计数
    const oneHourAgo = Date.now() - 3600 * 1000;
    let critFails = [];
    let inCurrentRun = false;
    let runStart = 0;
    for (const line of lines) {
      const m = line.match(/^\[([\d-]+ [\d:]+)\]/);
      if (m) {
        const ts = new Date(m[1]).getTime();
        if (ts < oneHourAgo) break;
        inCurrentRun = true;
        runStart = ts;
        continue;
      }
      if (!inCurrentRun) continue;
      if (line.includes('❌') && (line.includes('7 bug verify') || line.includes('working tree'))) {
        critFails.push(line.trim().slice(0, 200));
      }
    }
    if (critFails.length > 0) {
      const signal = 'self-check-fail';
      if (!shouldDedup(signal)) {
        writePending(signal, 'critical', `self-check 1h 内 ${critFails.length} 个关键 fail`, {
          count: critFails.length,
          sample: critFails.slice(0, 3).join(' | '),
          files: [SELF_CHECK_LOG],
        });
        writeAlert(`盘古 self-check ${critFails.length} 项关键失败`);
        notifyMacOS('盘古自检失败', `${critFails.length} 项关键 fail`);
        return 1;
      }
    }
  } catch (e) {
    log('⚠ self-check 扫失败: ' + e.message);
  }
  return 0;
}

// ========== Test mode ==========
function testMode() {
  log('=== TEST 模式: 制造 3 类信号 ===');
  const id1 = writePending('test:pangu-error', 'critical', 'TEST: Pangu 错误模式', { logLine: 'TypeError: cannot read property', files: ['/tmp/test'] });
  const id2 = writePending('test:l1-fail', 'warning', 'TEST: L1 失败', { count: 5, total: 10 });
  const id3 = writePending('test:self-check-fail', 'critical', 'TEST: self-check fail', { count: 2 });
  log('✅ 3 个 test pending 写入: ' + [id1, id2, id3].join(', '));
}

// ========== 主流程 ==========
function main() {
  const args = process.argv.slice(2);
  if (args.includes('--test')) {
    testMode();
    return;
  }
  if (args.includes('--quiet')) {
    process.env.REPAIR_QUIET = '1';
  }

  log('=== Pangu 修复检测器启动 ===');
  ensureDir(REPAIR_DIR);
  trimOldPending();

  const f1 = scanPanguErrors();
  const f2 = scanL1Failures();
  const f3 = scanSelfCheck();
  const total = f1 + f2 + f3;

  log(`=== 完成 — 发现 ${total} 个新信号 (pangu-err=${f1}, l1-fail=${f2}, selfcheck=${f3}) ===`);
  if (total > 0 && !process.env.REPAIR_QUIET) {
    notifyMacOS('盘古检测器', `${total} 个信号已写 pending (等 Phase 2 runner 处理)`);
  }
}

// 第 100 批: 导出纯函数给守卫用, 并且只有被当 CLI 跑时才执行 main()。
// (之前 require 这个文件就会真的去扫生产日志、写生产 pending —— 没法单测。)
module.exports = {
  writePending,
  scanL1Failures,
  scanPanguErrors,
  scanSelfCheck,
  trimOldPending,
  REPAIR_DIR,
  evolutionDir,
  LOG_DIR,
};

if (require.main === module) {
  main();
}
