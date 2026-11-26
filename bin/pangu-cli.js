#!/usr/bin/env node
// bin/pangu-cli.js — 盘古 CLI (Prime Agent 风格)
// 通过 HTTP API 操作 daemon, 不直接 require daemon 模块
// 用法: pangu <command> [args]
//
// commands:
//   status                    daemon 健康 + uptime
//   agents [limit]            列 agent sessions (类似 prime-agent agents)
//   resume <id>               取 session 全量 (打印 messages 摘要)
//   attach <id>               同 resume (语义: 重新挂回)
//   delete <id>               删 session
//   doctor                    健康自检 (health + housekeeping + budget)
//   shutdown [--force]        停 daemon (PID 文件 + SIGTERM)
//   compaction [--run] [--session-id=X]  列/触发 compaction
//   goal [set <text> | get | list | clear | pause] [session-id]
//   refine [--harness | --snapshots | --rollback <id>]
//   permission [get | set <level>]
//   budget [session-id]       看 budget
//
// 默认 daemon URL: http://127.0.0.1:18901 (--url=... 覆盖)

'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const args = process.argv.slice(2);
const opts = {};
// 2026-08-16 fix: 这些 flag 后跟 value (支持 --flag=value 或 --flag value)
const VALUE_FLAGS = { '--url': 'url', '--session-id': 'sessionId', '--since': 'since', '--from': 'from', '--kind': 'kind', '--scope': 'scope' };
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a.startsWith('--url=')) { opts.url = a.slice(6); continue; }
  if (a.startsWith('--session-id=')) { opts.sessionId = a.slice(13); continue; }
  if (VALUE_FLAGS[a] && i + 1 < args.length) { opts[VALUE_FLAGS[a]] = args[++i]; continue; }
  if (a === '--force') { opts.force = true; continue; }
  if (a === '--harness') { opts.harness = true; continue; }
  if (a === '--snapshots') { opts.snapshots = true; continue; }
  if (a === '--run') { opts.run = true; continue; }
  if (!opts.cmd) opts.cmd = a;
  else if (!opts.arg1) opts.arg1 = a;
  else if (!opts.arg2) opts.arg2 = a;
}

const BASE = opts.url || process.env.PANGU_URL || 'http://127.0.0.1:18901';

function call(method, path, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(BASE + path);
    // 2026-08-16 fix: 必须显式 Content-Length (无它时 daemon 收不到 body)
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = { 'Content-Type': 'application/json' };
    if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);
    const req = http.request({
      hostname: url.hostname, port: url.port, path: url.pathname + url.search, method,
      headers,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch (_) { resolve({ status: res.statusCode, body: data }); }
      });
    });
    req.on('error', reject);
    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

function short(obj, max = 80) {
  return String(obj || '').replace(/\s+/g, ' ').slice(0, max);
}

function out(label, obj) {
  console.log(label + ':');
  console.log(JSON.stringify(obj, null, 2));
}

// 2026-08-16 P1-D fix: argv 中跳过 flag 后取第一个非 flag arg
// VALUE_FLAGS 后跟的下一个 token 视为 value, 也跳过
const _VALUE_FLAGS = new Set(['--url','--session-id','--since','--from','--kind']);
function _isFlag(a) { return a.startsWith('--'); }
function _nextArgAfter(fromIdx, flags) {
  for (let i = fromIdx; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (flags.some(f => a === f || a.startsWith(f + '='))) { if (_VALUE_FLAGS.has(a)) i++; continue; }
    if (_isFlag(a)) continue;
    return a;
  }
  return null;
}

function _restArgsAfter(fromIdx, flags) {
  const out = [];
  for (let i = fromIdx; i < process.argv.length; i++) {
    const a = process.argv[i];
    if (flags.some(f => a === f || a.startsWith(f + '='))) { if (_VALUE_FLAGS.has(a)) i++; continue; }
    if (_isFlag(a)) continue;
    out.push(a);
  }
  return out.join(' ').trim();
}

function help() {
  console.log('pangu <command> [args]');
  console.log('  status | agents [limit] | resume <id> | attach <id> | delete <id>');
  console.log('  doctor | shutdown [--force]');
  console.log('  compaction [--run] [--session-id=X]');
  console.log('  goal [set <text>|get|list|clear|pause|complete|progress <note>] [--session-id=X]');
  console.log('  refine [--harness|--snapshots|--rollback <id>]');
  console.log('  permission [get|set <level>|levels|overrides|clear] [--scope=session] [--session-id=X]');
  console.log('  budget [--session-id=X]');
  console.log('  schedule [list|add <name> <cron> <action>|del <id>|tick]');
  console.log('  peer send <sid> <content> [--from=X] [--kind=X]');
  console.log('  peer list <sid> [--since=ts]');
  console.log('  peer ack <sid> <id1,id2,...>');
  console.log('  skill list | skill get <name|alias>');
}

const cmd = opts.cmd;

// 2026-10-01: 从 launchd 取权威 PID (KeepAlive 重启后 pangu.pid 会陈旧, 见 shutdown 分支注释)
function _launchdPid() {
  try {
    const out = require('child_process').execFileSync('launchctl', ['list', 'local.pangu-single'],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    const pid = String(out).trim().split(/\s+/)[0];
    return /^\d+$/.test(pid) ? pid : null;
  } catch (_) { return null; }
}

// pid 文件兜底: 必须确认该 PID 还活着且确实是 pangu, 否则宁可不杀
function _isPanguPid(pid) {
  const n = parseInt(String(pid || ''), 10);
  if (!Number.isInteger(n) || n <= 1) return false;
  try {
    const cmd = require('child_process').execFileSync('ps', ['-o', 'command=', '-p', String(n)],
      { encoding: 'utf8', timeout: 5000, stdio: ['ignore', 'pipe', 'ignore'] });
    return /pangu-single\.js/.test(String(cmd));
  } catch (_) { return false; }
}
(async () => {
  try {
    if (!cmd || cmd === 'help' || cmd === '-h' || cmd === '--help') {
      help(); return;
    }

    if (cmd === 'status') {
      const r = await call('GET', '/api/pangu/health');
      if (!r.body.ok) { console.error('daemon unhealthy:', r.body); process.exit(2); }
      const d = r.body.data || {};
      console.log('● pangu daemon alive');
      console.log('  uptime:        ' + d.uptime_s + 's');
      console.log('  version:       ' + r.body.version);
      console.log('  mode:          ' + r.body.mode);
      console.log('  tools:         ' + d.tools_loaded);
      console.log('  memory:        ' + d.memory.mb + ' MB (' + d.memory.level + ')');
      console.log('  event_loop:    ' + (d.eventLoop.blocked ? '⚠ blocked ' + d.eventLoop.delayMs + 'ms' : 'ok'));
      console.log('  crashes:       ' + d.crash.count);
      console.log('  port:          ' + d.port.port);
      return;
    }

    if (cmd === 'agents') {
      const limit = parseInt(opts.arg1 || '20', 10);
      const r = await call('GET', '/api/pangu/agent/sessions?limit=' + limit);
      if (!r.body.ok) { console.error('error:', r.body); process.exit(1); }
      const list = (r.body.result && r.body.result.sessions) || [];
      console.log('● ' + list.length + ' agent sessions');
      for (const s of list) {
        console.log('  - ' + s.session_id + '  msgs=' + s.message_count + '  state=' + s.state + '  updated=' + new Date(s.last_updated).toISOString());
      }
      return;
    }

    if (cmd === 'resume' || cmd === 'attach') {
      const id = opts.arg1;
      if (!id) { console.error('usage: pangu ' + cmd + ' <id>'); process.exit(1); }
      const r = await call('GET', '/api/pangu/agent/sessions/' + encodeURIComponent(id));
      if (!r.body.ok) { console.error('error:', r.body); process.exit(1); }
      const sess = r.body.result || {};
      console.log('● session: ' + id);
      console.log('  plan_id:    ' + sess.plan_id);
      console.log('  state:      ' + sess.state);
      console.log('  messages:   ' + (sess.messages ? sess.messages.length : 0));
      if (sess.messages && sess.messages.length) {
        const last3 = sess.messages.slice(-3);
        console.log('  last 3:');
        for (const m of last3) {
          console.log('    [' + m.role + '] ' + short(m.content || m.text || JSON.stringify(m).slice(0, 100), 100));
        }
      }
      console.log('\\n→ 继续对话: pangu-agent-stream 或 UI');
      return;
    }

    if (cmd === 'delete') {
      const id = opts.arg1;
      if (!id) { console.error('usage: pangu delete <id>'); process.exit(1); }
      const r = await call('DELETE', '/api/pangu/agent/sessions/' + encodeURIComponent(id));
      if (!r.body.ok) { console.error('error:', r.body); process.exit(1); }
      console.log('✓ deleted session: ' + id);
      return;
    }

    if (cmd === 'doctor') {
      const r = await call('GET', '/api/pangu/health');
      const hk = await call('GET', '/api/pangu/housekeeping/stats');
      console.log('● doctor report');
      if (r.body.ok) {
        const d = r.body.data;
        console.log('  daemon:    alive (uptime ' + d.uptime_s + 's, crashes ' + d.crash.count + ')');
        console.log('  tools:     ' + d.tools_loaded);
        console.log('  memory:    ' + d.memory.mb + ' MB');
        console.log('  eventLoop: ' + (d.eventLoop.ok ? 'ok' : '⚠ delay ' + d.eventLoop.delayMs + 'ms'));
      } else {
        console.log('  daemon:    ⚠ unhealthy');
      }
      if (hk.body.ok) {
        const h = hk.body.result;
        console.log('  sessions:  ' + h.sessions.count);
        console.log('  outcomes:  ' + h.outcomes.count + ' (' + h.outcomes.total_mb + ' MB)');
        console.log('  ck:        ' + h.checkpoints.count);
        console.log('  issues:    ' + h.issues_archived.count);
        console.log('  repair:    ' + h.repair_queue.count);
      }
      return;
    }

    if (cmd === 'shutdown') {
      // 2026-10-01 修: ~/.pangu/pangu.pid 没人写 (daemon 和 start 脚本都不写), launchd 每次
      // KeepAlive 拉起都是新 PID, 文件里的旧 PID 早已是死进程/甚至被系统回收给别人。
      // 旧逻辑直接 SIGTERM 那个陈旧 PID → 打空或误杀。改成: launchctl 为权威, pid 文件只作
      // 兜底且必须校验进程确实是 pangu-single.js, 绝不盲杀。
      const pidFile = path.join(process.env.HOME || require('os').homedir(), '.pangu', 'pangu.pid');
      let filePid = null;
      try { filePid = fs.readFileSync(pidFile, 'utf8').trim(); } catch (_) {}
      const pid = _launchdPid() || (_isPanguPid(filePid) ? filePid : null);
      if (!opts.force) {
        console.log('● shutdown is a no-op without --force (avoid accidental kill)');
        console.log('  实际运行 PID = ' + (pid || '<未运行>') + (pid ? ' (launchctl)' : ''));
        console.log('  pangu.pid 文件 = ' + (filePid || '<missing>')
          + (filePid && filePid !== pid ? '  <-- 陈旧, 已忽略' : ''));
        console.log('  use: pangu shutdown --force   |   或直接: launchctl kickstart -k gui/$UID/local.pangu-single');
        return;
      }
      if (!pid) {
        console.error('找不到运行中的 pangu daemon (launchctl 无记录, pangu.pid 也不可信)');
        console.error('重启请用: launchctl kickstart -k gui/' + process.getuid() + '/local.pangu-single');
        process.exit(1);
      }
      try { process.kill(parseInt(pid, 10), 'SIGTERM'); console.log('✓ SIGTERM sent to pid ' + pid); }
      catch (e) { console.error('kill failed:', e.message); process.exit(1); }
      return;
    }

    if (cmd === 'compaction') {
      if (opts.run) {
        const r = await call('POST', '/api/pangu/compaction/run', { session_id: opts.sessionId || 'cli-test' });
        out('compaction run', r.body);
      } else {
        const q = opts.sessionId ? '?sessionId=' + encodeURIComponent(opts.sessionId) : '';
        const r = await call('GET', '/api/pangu/compaction/snapshots' + q);
        if (!r.body.ok) { console.error('error:', r.body); process.exit(1); }
        console.log('● ' + r.body.count + ' compaction snapshots' + (opts.sessionId ? ' (session=' + opts.sessionId + ')' : ''));
        for (const s of (r.body.result || [])) {
          console.log('  - ' + s.id + '  old=' + s.old_count + ' recent=' + s.recent_count);
        }
      }
      return;
    }

    if (cmd === 'goal') {
      const sub = opts.arg1;
      // 2026-08-16 fix: sid 优先 --session-id flag, 其次 positional (argv[4]), 最后 default
      const sid = opts.sessionId || opts.arg2 || 'default';
      if (sub === 'set') {
        const text = _restArgsAfter(4, ['--session-id']);
        if (!text) { console.error('usage: pangu goal set <text> [--session-id=X]'); process.exit(1); }
        const r = await call('POST', '/api/pangu/goal', { session_id: sid, text, priority: 'normal' });
        out('goal set', r.body);
      } else if (sub === 'get') {
        const r = await call('GET', '/api/pangu/goal?sessionId=' + encodeURIComponent(sid));
        out('goal get', r.body);
      } else if (sub === 'list') {
        const r = await call('GET', '/api/pangu/goal/list');
        out('goal list', r.body);
      } else if (sub === 'clear') {
        const r = await call('POST', '/api/pangu/goal/clear', { session_id: sid });
        out('goal clear', r.body);
      } else if (sub === 'pause') {
        const r = await call('POST', '/api/pangu/goal/pause', { session_id: sid, reason: 'cli' });
        out('goal pause', r.body);
      } else if (sub === 'complete') {
        const r = await call('POST', '/api/pangu/goal/complete', { session_id: sid, summary: 'completed via cli' });
        out('goal complete', r.body);
      } else if (sub === 'progress') {
        const note = _restArgsAfter(4, ['--session-id']);
        if (!note) { console.error('usage: pangu goal progress <note> [--session-id=X]'); process.exit(1); }
        const r = await call('POST', '/api/pangu/goal/progress', { session_id: sid, note });
        out('goal progress', r.body);
      } else {
        console.error('goal subcommand: set|get|list|clear|pause|complete|progress'); process.exit(1);
      }
      return;
    }

    if (cmd === 'refine') {
      if (opts.harness) {
        const r = await call('GET', '/api/pangu/refine/harness');
        const list = (r.body.result && r.body.result.entries) || [];
        console.log('● harness: ' + list.length + ' entries');
        for (const e of list) {
          console.log('  - [' + e.kind + '] ' + short(e.content, 100) + ' (' + e.source + ' @ ' + e.ts + ')');
        }
      } else if (opts.snapshots) {
        const r = await call('GET', '/api/pangu/refine/snapshots');
        console.log('● snapshots: ' + r.body.count);
        for (const s of (r.body.result || [])) {
          console.log('  - ' + s.id + '  reason=' + s.reason + '  entries=' + s.entries_count);
        }
      } else if (opts.arg1 === 'rollback') {
        const id = opts.arg2;
        if (!id) { console.error('usage: pangu refine rollback <id>'); process.exit(1); }
        const r = await call('POST', '/api/pangu/refine/rollback', { snapshot_id: id });
        out('rollback', r.body);
      } else {
        console.error('refine flags: --harness | --snapshots | rollback <id>'); process.exit(1);
      }
      return;
    }

    // 2026-08-16 P1-B: schedule 命令 (cron jobs)
    if (cmd === 'schedule') {
      const sub = opts.arg1;
      if (sub === 'list' || !sub) {
        const r = await call('GET', '/api/pangu/schedule');
        out('schedule list', r.body);
      } else if (sub === 'add') {
        const name = opts.arg2;
        // argv: [..., 'schedule', 'add', NAME, CRON, ACTION...]
        const cron = _nextArgAfter(5, []);
        const action = _restArgsAfter(6, []);
        if (!name || !cron || !action) { console.error('usage: pangu schedule add <name> <cron> <action>'); process.exit(1); }
        const r = await call('POST', '/api/pangu/schedule', { name, cron, action });
        out('schedule add', r.body);
      } else if (sub === 'del' || sub === 'delete') {
        const id = opts.arg2;
        if (!id) { console.error('usage: pangu schedule del <id>'); process.exit(1); }
        const r = await call('DELETE', '/api/pangu/schedule?id=' + encodeURIComponent(id));
        out('schedule del', r.body);
      } else if (sub === 'tick') {
        const r = await call('POST', '/api/pangu/schedule/tick', {});
        out('schedule tick', r.body);
      } else {
        console.error('schedule subcommand: list | add <name> <cron> <action> | del <id> | tick'); process.exit(1);
      }
      return;
    }

    // 2026-08-16 P1-C: peer 子代理直连
    if (cmd === 'peer') {
      const sub = opts.arg1;
      if (sub === 'send') {
        const sid = opts.arg2;
        // argv layout: [..., 'peer', 'send', SID, content..., --from X, --kind Y]
        const content = _restArgsAfter(5, ['--from','--kind']);
        const from = _nextArgAfter(5, ['--from']) || 'cli';
        const kind = _nextArgAfter(5, ['--kind']) || 'info';
        if (!sid || !content) { console.error('usage: pangu peer send <sid> <content> [--from=X] [--kind=X]'); process.exit(1); }
        const r = await call('POST', '/api/pangu/agent/' + encodeURIComponent(sid) + '/peer', { from, content, kind });
        out('peer send', r.body);
      } else if (sub === 'list') {
        const sid = opts.arg2;
        const since = _nextArgAfter(5, ['--since']) || '0';
        if (!sid) { console.error('usage: pangu peer list <sid> [--since=ts]'); process.exit(1); }
        const r = await call('GET', '/api/pangu/agent/' + encodeURIComponent(sid) + '/peer?since=' + since);
        out('peer list', r.body);
      } else if (sub === 'ack') {
        const sid = opts.arg2;
        const idsStr = _restArgsAfter(5, []);
        if (!sid || !idsStr) { console.error('usage: pangu peer ack <sid> <id1,id2,...>'); process.exit(1); }
        const ids = idsStr.split(',').map(x => x.trim()).filter(Boolean);
        const r = await call('DELETE', '/api/pangu/agent/' + encodeURIComponent(sid) + '/peer', { ids });
        out('peer ack', r.body);
      } else {
        console.error('peer subcommand: send | list | ack'); process.exit(1);
      }
      return;
    }

    // 2026-08-16 P1-D: skill 命令 (Prime Agent skills list 对位)
    if (cmd === 'skill') {
      const sub = opts.arg1;
      if (sub === 'list' || !sub) {
        const r = await call('GET', '/api/pangu/skill/list');
        out('skill list', r.body);
      } else if (sub === 'get') {
        const key = opts.arg2;
        if (!key) { console.error('usage: pangu skill get <name|alias>'); process.exit(1); }
        const r = await call('GET', '/api/pangu/skill/' + encodeURIComponent(key));
        out('skill get', r.body);
      } else {
        console.error('skill subcommand: list | get <name|alias>'); process.exit(1);
      }
      return;
    }

    if (cmd === 'permission') {
      const sub = opts.arg1;
      if (sub === 'set') {
        const level = opts.arg2;
        if (!level) { console.error('usage: pangu permission set <level> [--scope=session] [--session-id=X]'); process.exit(1); }
        const scope = opts.scope || 'global';
        const sessionId = opts.sessionId || null;
        const body = { level, scope };
        if (scope === 'session' && !sessionId) { console.error('--session-id required when scope=session'); process.exit(1); }
        if (sessionId) body.sessionId = sessionId;
        const r = await call('PUT', '/api/pangu/permission/level', body);
        out('permission set', r.body);
      } else if (sub === 'levels') {
        const sid = opts.sessionId || '';
        const url = sid ? '/api/pangu/permission/level?sessionId=' + encodeURIComponent(sid) : '/api/pangu/permission/level';
        const r = await call('GET', url);
        out('permission levels', r.body);
      } else if (sub === 'overrides') {
        const r = await call('GET', '/api/pangu/permission/overrides');
        out('permission overrides', r.body);
      } else if (sub === 'clear') {
        const sid = opts.sessionId || opts.arg2;
        if (!sid) { console.error('usage: pangu permission clear --session-id=X'); process.exit(1); }
        const r = await call('DELETE', '/api/pangu/permission/level?sessionId=' + encodeURIComponent(sid));
        out('permission clear', r.body);
      } else if (sub === 'get' || !sub) {
        const sid = opts.sessionId || '';
        const url = sid ? '/api/pangu/permission/level?sessionId=' + encodeURIComponent(sid) : '/api/pangu/permission/level';
        const r = await call('GET', url);
        if (!r.body.ok) { console.error('error:', r.body); process.exit(1); }
        const res = r.body.result;
        console.log('● current: ' + res.current + (res.scope && res.scope !== 'global' ? ' (' + res.scope + (res.session_id ? ': ' + res.session_id : '') + ')' : ''));
        for (const lv of res.levels) {
          console.log('  ' + (lv.current ? '✓' : ' ') + ' ' + lv.id.padEnd(20) + ' ' + lv.icon + ' ' + lv.name + ' — ' + lv.description);
        }
        if (res.session_overrides && res.session_overrides.length) {
          console.log('\n● session overrides:');
          for (const o of res.session_overrides) {
            console.log('  - ' + o.session_id + ' → ' + o.level + (o.expires_at ? ' (until ' + o.expires_at + ')' : ''));
          }
        }
      } else {
        console.error('permission subcommand: get | set <level> [--scope=session] [--session-id=X] | levels | overrides | clear --session-id=X'); process.exit(1);
      }
      return;
    }

    if (cmd === 'budget') {
      const sid = opts.arg1 || opts.sessionId || 'default';
      const r = await call('GET', '/api/pangu/budget?sessionId=' + encodeURIComponent(sid));
      if (!r.body.ok) { console.error('error:', r.body); process.exit(1); }
      const b = r.body.result;
      console.log('● budget: ' + sid);
      console.log('  rounds:    ' + b.rounds + ' / ' + b.limits.max_rounds + '  (' + b.usage_pct.rounds + '%)');
      console.log('  tokens:    ' + b.tokens + ' / ' + b.limits.max_tokens + '  (' + b.usage_pct.tokens + '%)');
      console.log('  wall:      ' + Math.round(b.elapsed_ms / 1000) + 's / ' + Math.round(b.limits.max_wall_ms / 1000) + 's  (' + b.usage_pct.wall + '%)');
      console.log('  tool_calls:' + b.tool_calls + ' / ' + b.limits.max_tool_calls + '  (' + b.usage_pct.tool_calls + '%)');
      if (b.exceeded) console.log('  ⚠ EXCEEDED: ' + b.exceeded);
      if (b.warnings && b.warnings.length) console.log('  ⚠ warnings: ' + b.warnings.join('; '));
      return;
    }

    console.error('unknown command: ' + cmd);
    help();
    process.exit(1);
  } catch (e) {
    console.error('CLI error: ' + e.message);
    process.exit(2);
  }
})();
