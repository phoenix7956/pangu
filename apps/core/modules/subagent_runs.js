// modules/subagent_runs.js — 子 agent (8 将灵) 运行记录真源 (2026-09-17 老板拍: 显示工作体现, 前后对应)
//
// 之前子 agent 跑完即丢: [sub-agent] 日志只有 stdout, 没产物、没落盘、没"最近干过啥",
// 设置·将灵页 8 张卡片只能写死 "● 活跃 / ○ 待命" 假状态。
//
// 本模块做两件事:
//   1) record(evt) — 每次子 agent 开始/完成/失败, 追加一行 JSON 到 ~/.pangu/subagent-runs.jsonl
//   2) recent()    — 端点读最近 N 条 + 按 code 聚合 (今日次数 / 最近一次 / 是否正在跑)
//
// 事件由 j2_dispatcher / team_dispatch / sub-agent.run 在开始+结束时各 record 一次,
// 字段带 code(拼音职能) + gua(汉字卦名) 双身份。
// (2026-10-26 桌面端下线: 原来这里写"前端 gua-roster 直接对得上" —— 那个前端文件
//  没了。现在唯一的对照物是 agents/gua-identity.js, 下面就是从它生成的。)

const fs = require('fs');
const path = require('path');
const os = require('os');

// 8 将灵身份 —— 真源 = agents/gua-identity.js (老板 2026-10-18: 「应该统一」)。
//
// 这里以前手抄了一份 CODE_TO_GUA, 而且**抄错了**: 乾写成 `synthesizer`, 而后端
// 根本不存在这个角色 (注册在册的是 dispatcher)。于是 `record({code:'qian'})` 经
// 归一后落到 'synthesizer', 再查这张表命中 → 乾这一格在 UI 上能显示, 但运行时
// 身份和前端身份对不上。3289 次实跑里 synthesizer 只有 1 次, dispatcher 0 次, 就是
// 这条错链的痕迹。现在不抄了, 直接从真源生成。
const {GUA_ROLES, resolveRole} = require('../agents/gua-identity');

// 规范名(拼音) → 卦名。新记录一律用拼音写盘。
const CODE_TO_GUA = Object.freeze(
  GUA_ROLES.reduce((m, r) => { m[r.code] = r.gua; return m; }, Object.create(null)));

const RUNS_FILE = path.join(os.homedir(), '.pangu', 'subagent-runs.jsonl');
// Historical start events can survive a crash/restart. Keep current-process
// activity separately so an old unmatched start cannot leave a role stuck as
// "运行中" forever in the UI.
const _activeCounts = new Map();

function _ensureDir() {
  const d = path.dirname(RUNS_FILE);
  if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true });
}

// 2026-10-18: 这里原来还挂着一张 LEGACY_RUN_CODE (英文 code → 拼音), 理由是
// 「磁盘上那 3963 行是英文, 不翻译就会静默清零」。**数据已经迁完了, 所以表删了。**
//
// 一次性脚本 scripts/migrate-run-codes-to-pinyin-20261018.js 把
// ~/.pangu/subagent-runs.jsonl 就地改写成了拼音 (3545 行, 备份留在
// subagent-runs.jsonl.pre-pinyin-20261018.bak), 现在全文只剩拼音。
// 老板原话:「说了全部换, 还留着干嘛」—— 留着这张表就等于留着第二套身份,
// 而它唯一的作用是给一份**已经不存在**的旧数据兜底。
//
// 为什么当初非迁不可: digest() 按拼音索引查, 英文 code 一个都命中不了 →
// UI 上 8 将灵齐刷刷显示"今天 0 次运行", 而磁盘上明明躺着 958 次。数据迁移
// 先做, 表后删 —— 顺序反过来就是清零。
//
// 规矩: 读写两侧一律拼音, 只认身份真源的 resolveRole。
function _normalize(code) {
  const k = String(code == null ? '' : code).trim().toLowerCase();
  return resolveRole(k);
}

// 追加一条运行事件。kind: start|done|error; code: 职能; 其余透传。
//
// 2026-10-19: model 字段在这里**归一化成字符串**。
// 现场 (subagent-runs.jsonl, 10-10 之后 3799 条里 900 条): j2_dispatcher 有 7 处
// `record({ ..., model })` 传进来的是**整个模型对象**, 不是 `.id` —— 其余 20 处传的是
// `_daModel.id` / `_ffModel.id`。写盘后这 900 行的 model 是 JSON 对象:
//
//   {"kind":"start","code":"kan","model":{"id":"qwen/qwen3.8-27b","provider":...}}
//
// 危害不是"看着难看", 是**按 model 聚合的查询会静默失效** —— 字符串比较全部落空,
// 界面上这个将灵就成了"没跑过"。而且它每轮都在新增(最近一条就是本轮探针)。
//
// 为什么堵在这一层而不是逐个改调用点: 那 7 处的 `model` 变量名一模一样, 光看代码
// 分不出哪个是对象哪个是 id —— 而且下一个写新路径的人还会再犯。record() 是**所有**
// 写盘的唯一出口, 在这里收口, 新增调用点不用记得传对。
// 对象取 id, 字符串原样, 空值原样 —— 磁盘上从此只有一种形状。
function _modelId(model) {
  if (model == null) return null;
  if (typeof model === 'string') return model;
  if (typeof model === 'object') {
    const id = model.id || model.api_model || model.name;
    return id ? String(id) : null;
  }
  return String(model);
}

function record({ kind, code, task, model, sessionId, summary, error, meta = {} }) {
  const c = _normalize(code);
  if (!c || !CODE_TO_GUA[c]) return null;  // 未知角色不记 (保持 8 将灵边界)
  const evt = {
    ts: new Date().toISOString(),
    kind,
    code: c,
    gua: CODE_TO_GUA[c],
    task: (task || '').slice(0, 400),
    model: _modelId(model || meta.model),
    session: sessionId || null,
  };
  if (kind === 'start') _activeCounts.set(c, (_activeCounts.get(c) || 0) + 1);
  if (kind === 'done' || kind === 'error') {
    const next = Math.max(0, (_activeCounts.get(c) || 0) - 1);
    if (next) _activeCounts.set(c, next); else _activeCounts.delete(c);
  }
  if (kind === 'done' && summary) evt.summary = String(summary).slice(0, 800);
  if (kind === 'error' && error) evt.error = String(error).slice(0, 400);
  if (meta.durationMs) evt.durationMs = meta.durationMs;
  try {
    _ensureDir();
    fs.appendFileSync(RUNS_FILE, JSON.stringify(evt) + '\n');
  } catch (e) {
    console.warn('[subagent-runs] record failed:', e.message);
  }
  return evt;
}

// 读最近 n 条事件 (倒序, 最新在前)
function recent(n = 200) {
  let lines = [];
  try {
    lines = fs.readFileSync(RUNS_FILE, 'utf-8').split('\n').filter(Boolean);
  } catch (e) {
    return { ok: true, events: [], today: 0, running: false };
  }
  const events = lines.slice(-n).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean).reverse();
  // 今日 (本机时区) 统计
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  const today = events.filter(e => new Date(e.ts).getTime() >= dayStart.getTime()).length;
  return { ok: true, events: events.slice(0, Math.min(n, 200)), today };
}

// 按 code 聚合工作体现: { <code>: { gua, runs_today, last_ts, last_kind, running, tasks_preview } }
function digest(limit = 3) {
  const all = recent(2000);
  const byCode = {};
  const dayStart = new Date(); dayStart.setHours(0, 0, 0, 0);
  for (const c of Object.keys(CODE_TO_GUA)) {
    byCode[c] = { code: c, gua: CODE_TO_GUA[c], runs_today: 0, last_ts: null, last_kind: null, running: false, recent_tasks: [] };
  }
  // events 是倒序 (最新在前)
  for (const e of all.events) {
    // 磁盘上现在**只有拼音** (2026-10-18 一次性迁完, 见文件头)。仍过一遍
    // resolveRole 是为了 fail-closed: 认不出来就不进任何一格, 而不是拿原字符串
    // 去 byCode 上撞出一个不存在的将灵。
    const _nc = _normalize(e.code);
    const b = _nc ? byCode[_nc] : null;
    if (!b) continue;
    if (new Date(e.ts).getTime() >= dayStart.getTime()) b.runs_today++;
    if (!b.last_ts || new Date(e.ts) > new Date(b.last_ts)) { b.last_ts = e.ts; b.last_kind = e.kind; }
    // 2026-09-18 修: events 倒序 (最新在前)。旧逻辑按流顺序设 running,
    // 会被"更早的一条未闭合 start"误置 true → 卡片假显示"运行中"。
    // 正解: 每个 code 只看它最新一条事件决定 running。倒序下第一次命中即最新,
    // 所以只处理 _first 这一次, 后续更旧的不再改 running。
    if (!b._firstSeen) {
      b._firstSeen = true;
      b.running = (_activeCounts.get(_nc) || 0) > 0;
    }
    if ((e.kind === 'done' || e.kind === 'error') && e.task) b.recent_tasks.unshift({ task: e.task.slice(0, 120), at: e.ts, kind: e.kind, summary: e.summary ? String(e.summary).slice(0, 200) : null });
  }
  for (const c of Object.keys(byCode)) byCode[c].recent_tasks = byCode[c].recent_tasks.slice(0, limit);
  return { ok: true, by_code: byCode, totals: all.events.length, today: all.today };
}

module.exports = { record, recent, digest, CODE_TO_GUA, RUNS_FILE };
