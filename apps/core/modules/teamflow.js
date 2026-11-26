/**
 * modules/teamflow.js — 爻阵 · 卦阵工作流 (2026-08-05 v2, 老板拍板: 直接拆分, 每个子 agent 对照一套卦象)
 *
 * 流程:
 *   ① 总卦断方向: 目标起一卦 → 体用可行性门 (大吉/次吉干, 中吉干但费力, 小凶确认, 大凶拦)
 *   ② planner 拆分成 subTasks (复用 dispatcher 8 角色机制)
 *   ③ 每个子任务起自己的子卦: 卦象/动爻爻辞/体用注入该子 agent 的 prompt 当对照系
 *      - 子卦大凶 → 该子任务拦下跳过 (emit node_skip), 不烧 token
 *      - depends_on 的子任务拿到前置结果再跑
 *   ④ 逐子验卦 (启发式: 卦断吉凶 vs 实际成败, 相符=应) + 总体 reflector 验卦
 *   ⑤ 全部落盘 evolution/teamflow-yan-*.jsonl → l2-miner 学卦象→成功率分布
 *
 * v1 (动爻稀疏执行+改道) 已废 — 老板 8/5: 拆分更简单, 每子 agent 对照一套卦象
 */
'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync } = require('child_process');
const { safeStatus } = require('./http_status');
const { castGua } = require('./gua_engine');
// 爻位性质的身份标签跟 gua_block 共用同一份 —— 两处渲染不许各写各的,
// 否则模型会从 teamflow 那条路拿到没标签的版本, 白标。
const { POSITION_NATURE_TAG } = require('./gua_block');
const subAgent = require('../agents/sub-agent');

// sub-agent 用的节点配置 —— 跟 pangu-single 同一份, 但**不写死任何人的机器名**
// (2026-10-26 第 109 批)。解析规则见 config/node_config.js。
const CONFIG_PATH = process.env.PANGU_CONFIG_PATH
  || require('../config/node_config').resolveNodeConfigPathOrEmpty();

const MAX_SUBTASKS = 6;

// launchd label → 中文显示名 (老板 8/5: label 是文件名, 看不懂)
const TASK_NAMES = {
  'local.pangu-single': '盘古本体 (daemon :18901)',
  'local.pangu-guardian': '看门狗 · 进程守护',
  'com.pangu.daily-audit': '每日全面排查 (7项)',
  'local.pangu-memory-backup': '记忆库备份',
  'local.pangu-l2-miner': 'L2 记忆矿工 (消化当日会话)',
  'local.pangu-self-monitor': '健康监控 · 告警',
  'local.pangu-self-check': '自检 · 7 bug 验证',
};

// ── 可行性门 ──────────────────────────────────
function gateOf(gua) {
  const level = gua && gua.ti_yong && gua.ti_yong.level || '';
  if (level === '大吉' || level === '次吉') return { action: 'go', note: `${level}(${gua.ti_yong.pct}) · ${gua.ti_yong.verdict}` };
  if (level === '中吉') return { action: 'go', note: `中吉(${gua.ti_yong.pct}) · 事可成但费力` };
  if (level === '小凶') return { action: 'caution', note: `小凶(${gua.ti_yong.pct}) · 事难成` };
  return { action: 'no_go', note: `大凶(${gua.ti_yong.pct}) · 事不成` };
}

// ── 子卦对照系注入 ─────────────────────────────
function buildSubtaskPrompt(goal, subtask, subGua, depResults) {
  const zhi = subGua.zhi_gua ? ` | 变卦: ${subGua.zhi_gua.name}「${subGua.zhi_gua.gua_ci || ''}」` : '';
  let p = `【子卦对照系 · 卦象脚手架】\n` +
    `卦: ${subGua.gua_name_full || subGua.gua_name}「${subGua.gua_ci || ''}」${zhi}\n` +
    `体用: ${(subGua.ti_yong && subGua.ti_yong.summary) || ''}\n` +
    `动爻: ${subGua.yao_name || ('第' + subGua.moving_yao + '爻')}「${subGua.moving_yao_ci || ''}」` +
    ` | 爻位性质: ${subGua.position_nature || ''}${POSITION_NATURE_TAG} | 五行: ${subGua.yao_wuxing || ''}(${subGua.wuxing_rel || ''})\n` +
    `—— 先据此卦断这摊子事的方向 (攻守/缓急/风险点), 再直接用工具做事, 不要复述卦文。\n\n`;
  if (depResults) p += `【前置结论】\n${depResults}\n\n`;
  p += `总目标: ${goal}\n你的子任务: ${subtask.task}`;
  return p;
}

// ── 启发式逐子验卦: 卦断吉凶 vs 实际成败 ──────
function quickYan(gate, ok) {
  const lucky = gate.action === 'go';
  if (lucky && ok) return { verdict: '应', note: `卦断${gate.note}, 果成` };
  if (!lucky && !ok) return { verdict: '应', note: `卦断${gate.note}, 果未成` };
  if (lucky && !ok) return { verdict: '不应', note: `卦断${gate.note}, 却未成` };
  return { verdict: '半应', note: `卦断${gate.note}, 却成了` };
}

// ── 验卦落盘 ──────────────────────────────────
function persistYan(record) {
  try {
    const dir = path.join(os.homedir(), 'Desktop', 'pangu', 'evolution');
    fs.mkdirSync(dir, { recursive: true });
    const day = new Date().toISOString().slice(0, 10);
    fs.appendFileSync(path.join(dir, `teamflow-yan-${day}.jsonl`), JSON.stringify(record) + '\n');
  } catch (e) { console.warn('[teamflow] yan persist failed:', e.message); }
}

// ── HTTP helpers ──────────────────────────────
function readBody(req) {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 1024 * 1024) req.destroy(); });
    req.on('end', () => { try { resolve(JSON.parse(body || '{}')); } catch { resolve({}); } });
    req.on('error', () => resolve({}));
  });
}

function sseWrite(res, event, data) {
  try { res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`); } catch (_) {}
}

// POST /api/teamflow/cast {goal, numbers?} → {ok, gua, gate}  (总卦预览)
async function handleCast(req, res) {
  const body = await readBody(req);
  const goal = String(body.goal || '').trim();
  if (!goal) { res.writeHead(400, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: false, error: 'goal 必填' })); }
  try {
    const gua = castGua(goal, { numbers: body.numbers });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, gua, gate: gateOf(gua) }));
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: false, error: e.message }));
  }
}

// POST /api/teamflow/run {goal, override?} (SSE) — 总卦→拆分→子卦对照执行→验卦
async function handleRun(req, res) {
  const body = await readBody(req);
  const goal = String(body.goal || '').trim();
  res.writeHead(200, { 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-cache', 'Connection': 'keep-alive' });
  const hb = setInterval(() => { try { res.write(': hb\n\n'); } catch (_) {} }, 15000);
  const finish = (data) => { sseWrite(res, 'done', data || {}); clearInterval(hb); try { res.end(); } catch (_) {} };
  if (!goal) return finish({ ok: false, error: 'goal 必填' });

  const t0 = Date.now();

  // ① 总卦断方向
  let totalGua;
  try { totalGua = castGua(goal, { numbers: body.numbers }); } catch (e) { return finish({ ok: false, error: 'cast failed: ' + e.message }); }
  const totalGate = gateOf(totalGua);
  sseWrite(res, 'cast', { gua: totalGua, gate: totalGate });
  if (totalGate.action === 'no_go' && !body.override) {
    persistYan({ ts: new Date().toISOString(), type: 'total', goal, gua_id: totalGua.gua_id, gua_name: totalGua.gua_name, ti_yong: totalGua.ti_yong, gate: totalGate.action, blocked: true });
    sseWrite(res, 'gate_block', { gate: totalGate });
    return finish({ ok: false, blocked: true, gate: totalGate });
  }

  // ② planner 拆分
  let subTasks = [];
  try {
    const plan = await subAgent.run({ taskText: goal, mode: 'kan', configPath: CONFIG_PATH });
    subTasks = (plan && Array.isArray(plan.subTasks) ? plan.subTasks : []).slice(0, MAX_SUBTASKS);
  } catch (e) { console.warn('[teamflow] planner failed:', e.message); }
  if (subTasks.length === 0) subTasks = [{ agent: 'kun', task: goal }];
  sseWrite(res, 'plan', { subTasks: subTasks.map((s, i) => ({ i, agent: s.agent || 'kun', task: String(s.task || '').slice(0, 200) })) });

  // ③ 逐子任务: 起子卦 → 对照执行 → 逐子验卦
  const results = [];
  const records = [];
  let doneCount = 0;
  for (let i = 0; i < subTasks.length; i++) {
    const st = subTasks[i];
    const role = String(st.agent || 'kun');
    const taskText = String(st.task || goal).slice(0, 500);

    // 子卦用报数法 (课件主推): 同时辰时间卦全 run 相同, 每子任务必须各对照一套卦象
    let subGua;
    try {
      const seed = `${goal}|${i + 1}|${taskText}`;
      let h = 0; for (let k = 0; k < seed.length; k++) h = (h * 31 + seed.charCodeAt(k)) >>> 0;
      subGua = castGua(`${goal} || 子任务${i + 1}: ${taskText}`, { numbers: [h % 997 + 1, (h >> 8) % 997 + 1, (h >> 16) % 997 + 1] });
    } catch (e) { subGua = null; }
    const subGate = subGua ? gateOf(subGua) : { action: 'go', note: '(子卦失败, 放行)' };
    sseWrite(res, 'subtask_cast', { i, agent: role, gua: subGua, gate: subGate });

    if (subGate.action === 'no_go' && !body.override) {
      sseWrite(res, 'node_skip', { i, agent: role, reason: subGate.note });
      results[i] = { ok: false, skipped: true, summary: '子卦大凶, 拦下未行' };
      records.push({ type: 'subtask', i, agent: role, task: taskText, gua_id: subGua && subGua.gua_id, gua_name: subGua && subGua.gua_name, ti_yong: subGua && subGua.ti_yong, gate: subGate.action, skipped: true, yan: { verdict: '未验', note: '被拦' } });
      continue;
    }

    sseWrite(res, 'node_start', { i, agent: role, task: taskText });
    // depends_on: 注入前置结论
    let depResults = '';
    const deps = Array.isArray(st.depends_on) ? st.depends_on : [];
    for (const d of deps) {
      if (results[d] && results[d].summary) depResults += `子任务${d + 1} 结论: ${results[d].summary.slice(0, 400)}\n`;
    }
    const prompt = subGua ? buildSubtaskPrompt(goal, { task: taskText }, subGua, depResults) : (depResults + `\n总目标: ${goal}\n你的子任务: ${taskText}`);
    let result = null;
    try {
      result = await subAgent.run({
        taskText: prompt, mode: role, configPath: CONFIG_PATH,
        onProgress: (e) => sseWrite(res, 'node_progress', { i, stage: e.stage || '', round: e.round || 0 }),
      });
    } catch (e) { result = { ok: false, error: e.message }; }
    const summary = String((result && (result.summary || (result.data && result.data.finalText) || result.error)) || '').slice(0, 2000);
    const ok = !!(result && result.ok && !result.suspicious);
    if (ok) doneCount++;
    results[i] = { ok, summary };
    const yan = quickYan(subGate, ok);
    sseWrite(res, ok ? 'node_done' : 'node_failed', { i, agent: role, ok, summary, yan });
    records.push({ type: 'subtask', i, agent: role, task: taskText, gua_id: subGua && subGua.gua_id, gua_name: subGua && subGua.gua_name, moving_yao: subGua && subGua.moving_yao, ti_yong: subGua && subGua.ti_yong, gate: subGate.action, ok, yan, summary: summary.slice(0, 300) });
  }

  // ④ 总体验卦 (reflector 对照总卦)
  const finalOk = doneCount > 0 && doneCount >= Math.ceil(subTasks.length / 2);
  let yan = { verdict: finalOk ? '应' : '不应', note: '' };
  try {
    const brief = results.map((r, i) => `子${i + 1}(${subTasks[i].agent}): ${r.skipped ? '被拦' : r.ok ? '成' : '未成'} ${r.summary.slice(0, 120)}`).join('\n');
    const yanPrompt = `【验卦】总目标: ${goal}\n总卦: ${totalGua.gua_name_full || totalGua.gua_name}「${totalGua.gua_ci || ''}」\n变卦(归宿): ${(totalGua.zhi_gua && totalGua.zhi_gua.name) || ''}「${(totalGua.zhi_gua && totalGua.zhi_gua.gua_ci) || ''}」\n体用断语: ${(totalGua.ti_yong && totalGua.ti_yong.summary) || ''}\n执行(${doneCount}/${subTasks.length} 成):\n${brief}\n—— 对照总卦与断语, 一句话断: 应 / 半应 / 不应, 并说凭什么。格式: 判定|理由`;
    const r = await subAgent.run({ taskText: yanPrompt, mode: 'zhen', configPath: CONFIG_PATH });
    const text = String((r && (r.summary || (r.data && r.data.finalText))) || '');
    const m = text.match(/(半应|不应|应)\s*[|｜:：]?\s*([\s\S]{0,300})/);
    if (m) yan = { verdict: m[1], note: m[2].trim() };
    else if (text) yan.note = text.slice(0, 300);
  } catch (e) { yan.note = 'reflector 不可用, 启发式判定'; }
  sseWrite(res, 'yan', yan);

  // ⑤ 落盘
  persistYan({
    ts: new Date().toISOString(), type: 'run', goal, duration_ms: Date.now() - t0,
    total_gua: { id: totalGua.gua_id, name: totalGua.gua_name, moving_yao: totalGua.moving_yao, ti_yong: totalGua.ti_yong, gate: totalGate.action },
    subtasks: records, done: doneCount, total: subTasks.length, final_ok: finalOk, yan,
  });
  finish({ ok: finalOk, done: doneCount, total: subTasks.length, yan });
}

// GET /api/teamflow/yan → 最近验卦记录 (今日+昨日, 最多 50 条)
function handleYanLog(req, res) {
  const out = [];
  try {
    const dir = path.join(os.homedir(), 'Desktop', 'pangu', 'evolution');
    for (let d = 0; d < 2 && out.length < 50; d++) {
      const day = new Date(Date.now() - d * 86400000).toISOString().slice(0, 10);
      const f = path.join(dir, `teamflow-yan-${day}.jsonl`);
      if (!fs.existsSync(f)) continue;
      for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { out.push(JSON.parse(line)); } catch (_) {}
      }
    }
  } catch (_) {}
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, records: out.slice(-50).reverse() }));
}

// GET /api/teamflow/tasks → launchd 定时/常驻任务实况 (老板 8/5: 页面显示定时任务比标题有用)
function handleTasks(req, res) {
  const tasks = [];
  // 2026-10-26 第 109 批: launchd 是 **macOS 专属**。
  //   内核是跨平台的, 这条路在别的平台上不是「500」而是「这个平台没有这概念」。
  //   原来直接 readdirSync(~/Library/LaunchAgents) —— 目录不存在就抛, 整个端点 500。
  if (process.platform !== 'darwin') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({
      ok: true,
      tasks: [],
      platform: process.platform,
      note: '定时任务管理走 macOS launchd, 当前平台不支持 ⇒ 没有这一类任务',
    }));
  }
  try {
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    // launchctl list: "PID\texit\tlabel" (PID 运行中, "-" 未跑)
    const live = {};
    try {
      for (const line of execFileSync('launchctl', ['list'], { encoding: 'utf8', timeout: 5000 }).split('\n')) {
        const cols = line.trim().split(/\s+/);
        if (cols.length >= 3) live[cols[2]] = { pid: cols[0], exit: cols[1] };
      }
    } catch (_) {}
    for (const f of fs.readdirSync(dir)) {
      if (!f.includes('pangu') || !f.endsWith('.plist')) continue;
      let p;
      try { p = JSON.parse(execFileSync('plutil', ['-convert', 'json', '-o', '-', path.join(dir, f)], { encoding: 'utf8', timeout: 5000 })); }
      catch (_) { continue; }
      const label = p.Label || f.replace(/\.plist$/, '');
      let schedule = '手动触发';
      const sci = p.StartCalendarInterval;
      if (sci && typeof sci === 'object') {
        const hm = `${String(sci.Hour ?? 0).padStart(2, '0')}:${String(sci.Minute ?? 0).padStart(2, '0')}`;
        schedule = sci.Weekday !== undefined ? `每周${sci.Weekday} ${hm}` : `每天 ${hm}`;
      } else if (p.StartInterval) {
        schedule = p.StartInterval >= 60 ? `每 ${Math.round(p.StartInterval / 60)} 分钟` : `每 ${p.StartInterval} 秒`;
      } else if (p.KeepAlive) {
        schedule = p.RunAtLoad ? '常驻 (加载即跑)' : '常驻';
      } else if (p.RunAtLoad) {
        schedule = '加载时执行一次';
      }
      // 老板 8/5: 手动触发的不是定时任务, 不进列表
      if (!sci && !p.StartInterval && !p.RunAtLoad && !p.KeepAlive) continue;
      const lv = live[label];
      const running = !!(lv && lv.pid && lv.pid !== '-');
      const lastExit = lv ? parseInt(lv.exit, 10) : null;
      tasks.push({
        label, name: TASK_NAMES[label] || label, schedule, running,
        pid: running ? lv.pid : null,
        last_exit: Number.isFinite(lastExit) ? lastExit : null,
        // 未运行的任务不能仅凭上次退出码判定当前状态；保留退出码供诊断。
        ok: running || lastExit === 0,
        state: running ? 'running' : (lastExit === null ? 'never_run' : (lastExit === 0 ? 'idle_ok' : 'last_failed')),
        log: p.StandardOutPath || p.StandardErrorPath || null,
      });
    }
    tasks.sort((a, b) => (a.ok === b.ok ? 0 : a.ok ? 1 : -1));  // 坏任务排前
  } catch (e) {
    res.writeHead(500, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: false, error: e.message }));
  }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, tasks }));
}


function _end(res, status, obj) {
  try {
    res.writeHead(safeStatus(status, 200), { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(obj));
  } catch (_) {}
}

// 2026-08-30 §team-ui: 用户加/删定时任务 (UI 上 + 新建按钮要的后端)
// 安全约束: label 必须含 "pangu" (防误删系统 plist), program 路径必须存在
function handleCreateTask(req, res) {
  let body = '';
  req.on('data', c => {
    body += c;
    if (body.length > 8192) { body = ''; return _end(res, 413, { ok: false, error: 'BODY_TOO_LARGE' }); }
  });
  req.on('end', () => {
    let p;
    try { p = JSON.parse(body || '{}'); } catch (_) { return _end(res, 400, { ok: false, error: 'BAD_JSON' }); }
    const label = String(p.label || '').trim();
    const program = String(p.program || '').trim();
    const args = Array.isArray(p.args) ? p.args.map(a => String(a)) : [];
    const scheduleType = String(p.schedule_type || '');  // 'daily'|'interval'|'atload'
    const scheduleValue = p.schedule_value;
    const env = (p.env && typeof p.env === 'object') ? p.env : {};
    // 安全: label 必须含 pangu (含 local.*pangu* 或 com.*pangu*)
    if (!label || !label.match(/^(local|com)\.[a-z0-9.-]*pangu[a-z0-9.-]*$/i)) {
      return _end(res, 400, { ok: false, error: 'LABEL_MUST_BE_PANGU', hint: 'label must match /^(local|com)\..*pangu.*$/i' });
    }
    if (!label.match(/^[a-z0-9.-]+$/i)) return _end(res, 400, { ok: false, error: 'BAD_LABEL_CHARS' });
    if (!program) return _end(res, 400, { ok: false, error: 'NO_PROGRAM' });
    if (!fs.existsSync(program)) return _end(res, 400, { ok: false, error: 'PROGRAM_NOT_FOUND', program });
    const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
    const file = path.join(dir, label + '.plist');
    if (fs.existsSync(file)) return _end(res, 409, { ok: false, error: 'ALREADY_EXISTS', file });
    const plist = { Label: label, ProgramArguments: [program, ...args], RunAtLoad: false };
    if (scheduleType === 'daily') {
      const m = String(scheduleValue || '').match(/^(\d{1,2}):(\d{2})$/);
      if (!m) return _end(res, 400, { ok: false, error: 'BAD_DAILY_FORMAT', hint: 'HH:MM, e.g. 04:00' });
      plist.StartCalendarInterval = { Hour: parseInt(m[1], 10), Minute: parseInt(m[2], 10) };
    } else if (scheduleType === 'interval') {
      const sec = parseInt(scheduleValue, 10);
      if (!Number.isFinite(sec) || sec < 1) return _end(res, 400, { ok: false, error: 'BAD_INTERVAL', hint: 'positive integer seconds' });
      plist.StartInterval = sec;
    } else if (scheduleType === 'atload') {
      plist.RunAtLoad = true;
    } else if (scheduleType) {
      return _end(res, 400, { ok: false, error: 'BAD_SCHEDULE_TYPE', hint: 'daily|interval|atload' });
    }
    // 日志
    const logDir = path.join(os.homedir(), 'Library', 'Logs', 'pangu');
    try { fs.mkdirSync(logDir, { recursive: true }); } catch (_) {}
    plist.StandardOutPath = path.join(logDir, label + '.out.log');
    plist.StandardErrorPath = path.join(logDir, label + '.err.log');
    // env
    const envObj = {
      HOME: os.homedir(),
      PATH: [path.join(os.homedir(), '.local', 'bin'), '/usr/local/bin', '/opt/homebrew/bin', '/usr/bin', '/bin'].join(':'),
    };
    for (const [k, v] of Object.entries(env)) { if (typeof v === 'string') envObj[k] = v; }
    plist.EnvironmentVariables = envObj;
    // 写 plist 用 plutil (避免 XML 注入) — 直接 -o file 一次落盘
    try {
      const tmpJson = file + '.tmp.json';
      try {
        fs.writeFileSync(tmpJson, JSON.stringify(plist), 'utf8');
        execFileSync('plutil', ['-convert', 'xml1', '-o', file, tmpJson], { timeout: 5000 });
      } finally {
        try { fs.unlinkSync(tmpJson); } catch (_) {}
      }
      execFileSync('launchctl', ['load', '-w', file], { timeout: 5000 });
      return _end(res, 200, { ok: true, label, file, log_out: plist.StandardOutPath, log_err: plist.StandardErrorPath });
    } catch (e) {
      return _end(res, 500, { ok: false, error: e.message, step: 'write_or_load' });
    }
  });
}

function handleDeleteTask(req, res, label) {
  if (!label || !label.match(/^(local|com)\.[a-z0-9.-]*pangu[a-z0-9.-]*$/i)) {
    return _end(res, 400, { ok: false, error: 'LABEL_MUST_BE_PANGU' });
  }
  const dir = path.join(os.homedir(), 'Library', 'LaunchAgents');
  const file = path.join(dir, label + '.plist');
  if (!fs.existsSync(file)) return _end(res, 404, { ok: false, error: 'NOT_FOUND', file });
    try {
      try { execFileSync('launchctl', ['unload', file], { timeout: 5000 }); } catch (_) {}
      fs.unlinkSync(file);
      for (const suffix of ['.out.log', '.err.log']) {
        try { fs.unlinkSync(path.join(os.homedir(), 'Library', 'Logs', 'pangu', label + suffix)); } catch (_) {}
      }
      return _end(res, 200, { ok: true, label, deleted: file });
  } catch (e) {
    return _end(res, 500, { ok: false, error: e.message });
  }
}

module.exports = {
  handleCast, handleRun, handleYanLog, handleTasks, handleCreateTask, handleDeleteTask, gateOf,
  // 导出给测试: 纯渲染函数, 无副作用。跟 gua_block.formatGuaFirstBlock 同一个理由 ——
  // 不导出的话「爻位性质有没有标身份」就只能靠人读源码, 而人是会漏的。
  buildSubtaskPrompt,
};
