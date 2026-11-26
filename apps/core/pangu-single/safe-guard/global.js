// pangu-single/safe-guard/global.js
// 全局异常兜底；修复 EPIPE 自循环 + unhandledRejection 不退出 + log rotate
// TL-5 子项 C: 加 crash pattern detect + 老板触发 issue (P0-13 雏形)
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');

const CRASH_LOG_DIR = path.join(os.homedir(), '.pangu', 'logs');
const CRASH_LOG_PATH = path.join(CRASH_LOG_DIR, 'pangu-crash.log');
const ISSUES_DIR = path.join(os.homedir(), 'Desktop', 'pangu', 'issues');
const MAX_LOG_SIZE = 50 * 1024 * 1024; // 50MB
const MAX_LOG_BACKUPS = 3;
const CRASH_PATTERN_THRESHOLD = 3;  // 同一 exception type 出现 ≥3 次算 pattern

let _shuttingDown = false;

// EPIPE / 关闭的 stream 会二次抛错，safe-guard 不应再写日志，避免自循环
function _isBrokenPipe(err) {
  if (!err) return false;
  const code = err.code || (typeof err === 'string' ? err : '');
  const msg = err.message || String(err);
  return code === 'EPIPE' || code === 'ERR_STREAM_DESTROYED' ||
    msg.includes('EPIPE') || msg.includes('ERR_STREAM_DESTROYED');
}

function _isHarmless(reason) {
  if (!reason) return false;
  const msg = (reason.message || String(reason));
  return msg.includes('ERR_HTTP_HEADERS_SENT') ||
    msg.includes('Cannot set headers after they are sent') ||
    msg.includes('Cannot write headers after they are sent') ||
    msg.includes('write after end');
}

function ensureCrashLogDir() {
  try {
    if (!fs.existsSync(CRASH_LOG_DIR)) fs.mkdirSync(CRASH_LOG_DIR, { recursive: true });
  } catch (e) {
    // 如果连日志目录都建不了，至少写 stderr（仅在 stderr 还能写时）
    if (!_isBrokenPipe(e)) console.error('[safe-guard] failed to create crash log dir:', e.message);
  }
}

function rotateCrashLog() {
  try {
    if (!fs.existsSync(CRASH_LOG_PATH)) return;
    const stat = fs.statSync(CRASH_LOG_PATH);
    if (stat.size < MAX_LOG_SIZE) return;
    // 删除最老的，依次重命名
    for (let i = MAX_LOG_BACKUPS - 1; i >= 1; i--) {
      const older = `${CRASH_LOG_PATH}.${i}`;
      const newest = `${CRASH_LOG_PATH}.${i + 1}`;
      if (fs.existsSync(older)) fs.renameSync(older, newest);
    }
    fs.renameSync(CRASH_LOG_PATH, `${CRASH_LOG_PATH}.1`);
  } catch (e) {
    if (!_isBrokenPipe(e)) console.error('[safe-guard] failed to rotate crash log:', e.message);
  }
}

function writeCrash(kind, err) {
  // EPIPE 时 stdout/stderr 已不可写，再写会再次触发 EPIPE，导致自循环
  if (_isBrokenPipe(err)) return;

  ensureCrashLogDir();
  const ts = new Date().toISOString();
  const entry = `[${ts}] [${kind}] ${err && err.stack ? err.stack : String(err)}\n`;
  try {
    fs.appendFileSync(CRASH_LOG_PATH, entry);
  } catch (e) {
    if (!_isBrokenPipe(e)) {
      try { console.error('[safe-guard] failed to write crash log:', e.message); } catch {}
      try { console.error(entry); } catch {}
    }
  }
  try {
    console.error(entry);
  } catch (e) {
    // stderr 已关闭， swallow
  }
}

function shutdownAfterMs(ms, code) {
  if (_shuttingDown) return;
  _shuttingDown = true;
  try { console.error(`[safe-guard] process will exit(${code}) in ${ms}ms`); } catch {}
  setTimeout(() => process.exit(code), ms).unref();
}

function install() {
  // 启动时轮转一次 crash log
  rotateCrashLog();
  ensureCrashLogDir();

  process.on('uncaughtException', (err) => {
    if (_isBrokenPipe(err)) {
      // 管道断开是常见桌面进程退出场景, 真退 (spawn 子进程重启)
      shutdownAfterMs(500, 0);
      return;
    }
    // B3 修: uncaughtException 也不再杀进程, 成熟 agent 实践
    // 之前: shutdownAfterMs(5000, 1) → 任何 throw 把整个 Pangu 杀掉
    // 现在: log + 继续 (因为一个 tool 异常不该杀整个 daemon)
    try { writeCrash('uncaughtException', err); } catch (e) {}
    try {
      const patterns = detectCrashPattern();
      for (const p of patterns) {
        if (p.count >= CRASH_PATTERN_THRESHOLD) {
          const r = openIssue(p);
          if (r.ok) console.error('[safe-guard] auto-opened issue:', r.path);
        }
      }
    } catch (e) {}
    try { console.error('[safe-guard] uncaughtException logged, continuing (B3 fix — 不再杀进程):', err && err.message); } catch (e) {}
    // 不再 shutdownAfterMs — 保持 daemon 运行
  });

  process.on('unhandledRejection', (reason, promise) => {
    // B1 修: unhandledRejection 不再杀进程, 成熟 agent 实践
    // 之前: shutdownAfterMs(5000, 1) → 任何 unhandled promise 把整个 Pangu 杀掉
    // 现在: 写 crash log 记录, 继续运行 (因为一个 tool 失败不该杀掉整个 daemon)
    if (_isHarmless(reason)) {
      try { console.error('[safe-guard] harmless unhandledRejection ignored:', reason && reason.message); } catch (e) {}
      return;
    }
    try { writeCrash('unhandledRejection', reason); } catch (e) {}
    try { console.error('[safe-guard] unhandledRejection logged, continuing (B1 fix — 不再杀进程):', reason && reason.message); } catch (e) {}
    // 不再 shutdownAfterMs — 保持 daemon 运行
  });

  process.on('SIGTERM', () => {
    console.log('[safe-guard] SIGTERM received, exiting gracefully');
    process.exit(0);
  });

  process.on('SIGINT', () => {
    console.log('[safe-guard] SIGINT received, exiting gracefully');
    process.exit(0);
  });

  try {
    ensureCrashLogDir();
  } catch (e) {
    if (!_isBrokenPipe(e)) console.error('[safe-guard] init error:', e.message);
  }
}

module.exports = { install, writeCrash, detectCrashPattern, openIssue, CRASH_LOG_PATH, ISSUES_DIR };

// 2026-10-13 (现场): 原来只在**首次**出现时写 sample_message, 之后不再更新 ——
// 同一个 exception type 里的**其他消息全部丢掉**。令牌发现的现场:
//   issues/2026-10-12T16-12-29-019Z-ReferenceError.md 写着 Count: 65, 但 Sample message 只是
//   "Cannot access 'path' before initialization" —— 同时期另一种 ReferenceError
//   ("model is not defined" @ llm_caller.js:1211, 压死在 ClientRequest 回调里不在 Promise 链的
//   try/catch 内) 在 issue 文件里**完全不可见** —— 它是我今天找不到根因的直接原因。
// 改成: 每个 type 保留有界的**不同消息**列表(归一化签名去掉数字/长 hex id,
// 同一个模板的每个实例只算一条), 各自带次数与首末见时间。
const MAX_DISTINCT_PER_TYPE = 5;
function _crashSig(body) {
  return String(body).replace(/[0-9a-f]{8,}/gi, '#').replace(/\d+/g, '#').replace(/\s+/g, ' ').trim().slice(0, 140);
}

// TL-5 子项 C: 扫 crash log 找重复 exception type
// 返 [{type, count, first_seen, last_seen, sample_message, distinct:[{sig,count,first_seen,last_seen,sample_message}]}]
function detectCrashPattern(logPath = CRASH_LOG_PATH, threshold = CRASH_PATTERN_THRESHOLD) {
  if (!fs.existsSync(logPath)) return [];
  let content;
  try { content = fs.readFileSync(logPath, 'utf8'); } catch (_) { return []; }
  // 解析 crash log: 形如 [2026-07-23T...] [kind] Error: msg
  //   or           [2026-07-23T...] [kind] TypeError: x
  const re = /\[([^\]]+)\] \[(\w+)\] ([\s\S]*?)(?=\n\[|$)/g;
  const patterns = new Map();
  let m;
  while ((m = re.exec(content)) !== null) {
    const ts = m[1], kind = m[2], body = m[3].trim();
    // 拿 exception type 头 (e.g. "TypeError: x" → "TypeError"; "Error: x" → "Error")
    const tm = body.match(/^(\w+Error|Error|TypeError|RangeError|ReferenceError|SyntaxError):/);
    const type = tm ? tm[1] : 'Unknown';
    if (!patterns.has(type)) patterns.set(type, { type, count: 0, first_seen: ts, last_seen: ts, kind, sample_message: body.slice(0, 200), distinct: [] });
    const p = patterns.get(type);
    p.count++;
    p.last_seen = ts;
    // 归一化后去重: 同模板的每个实例只占一条, 不把有界列表消耗尽
    const sig = _crashSig(body);
    const hit = p.distinct.find(d => d.sig === sig);
    if (hit) { hit.count++; hit.last_seen = ts; }
    else if (p.distinct.length < MAX_DISTINCT_PER_TYPE) {
      p.distinct.push({ sig, count: 1, first_seen: ts, last_seen: ts, sample_message: body.slice(0, 200) });
    } else {
      // 满了就逐出 **last_seen 最早**的那条 —— 而不是无规则地丢掉新的。
      // 这里最值钱的正是**刚出的新 bug** (2026-10-12 的 "model is not defined" 被老的挤掉就是这个原因),
      // 而不是八月那些旧残留 —— 看 issue 的人是在查新 bug。
      let oi = 0;
      for (let i = 1; i < p.distinct.length; i++) {
        if (String(p.distinct[i].last_seen) < String(p.distinct[oi].last_seen)) oi = i;
      }
      p.distinct.splice(oi, 1);
      p.distinct.push({ sig, count: 1, first_seen: ts, last_seen: ts, sample_message: body.slice(0, 200) });
      p.distinct_overflow = (p.distinct_overflow || 0) + 1;
    }
  }
  // 过滤 ≥ threshold
  return Array.from(patterns.values()).filter(p => p.count >= threshold);
}

// TL-5 子项 C: 老板触发 "开 issue" — 写 Pangu repo issues/<timestamp>-<type>.md
function openIssue(crashInfo, dirOverride) {   // dirOverride: 仅测试用, 默认行为不变
  if (!crashInfo || !crashInfo.type) return { ok: false, error: 'crashInfo.type missing' };
  const dir = dirOverride || ISSUES_DIR;
  try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  const ts = new Date().toISOString().replace(/[:.]/g, '-');
  const file = path.join(dir, `${ts}-${crashInfo.type}.md`);
  const content = `# Crash Report: ${crashInfo.type}\n\n` +
    `- **Type**: ${crashInfo.type}\n` +
    `- **Count**: ${crashInfo.count}\n` +
    `- **Last seen**: ${crashInfo.last_seen}\n` +
    `- **Kind**: ${crashInfo.kind || 'unknown'}\n` +
    `- **Auto-generated**: ${new Date().toISOString()}\n\n` +
    `## Sample message\n\n\`\`\`\n${crashInfo.sample_message || ''}\n\`\`\`\n\n` +
    // 2026-10-13: 同一 type 下的**其他**不同消息也要列出来 —— 只留第一条
    // 让同一个 ReferenceError 里的副品 bug (如 model is not defined) 完全看不到。
    ((crashInfo.distinct && crashInfo.distinct.length)
      ? `## Distinct messages (${crashInfo.distinct.length}${crashInfo.distinct_overflow ? '+' : ''})\n\n`
        + crashInfo.distinct.map((d, i) =>
          `### ${i + 1}. ×${d.count} · ${d.first_seen} → ${d.last_seen}\n\n\`\`\`\n${d.sample_message}\n\`\`\`\n`).join('\n')
        + (crashInfo.distinct_overflow ? `\n> 另有 ${crashInfo.distinct_overflow} 条不同消息因达上限未列出。\n` : '')
      : '') +
    `## Suggested action\n\n- 查看 daemon log: \`/tmp/pangu-single.log\`\n- 复现并查 stack trace\n- 修完 close issue\n`;
  try {
    fs.writeFileSync(file, content, 'utf8');
    return { ok: true, path: file, type: crashInfo.type, count: crashInfo.count };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}
