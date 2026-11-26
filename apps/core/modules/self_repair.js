// self_repair.js — 盘古自愈: 崩溃 → 诊断 → 自修 → 验证 → 提交 → 自重启
// 2026-09-14 (老板拍: "这是盘古应该自己解决的"):
//   const _note += 崩了一天的教训 — 外部修是打补丁, 盘古要能自己抓崩、自己修、自己验证。
//
// 闭环: handleCrash(type, err, ctx)
//   1. 事故落盘 incidents.jsonl (任何崩溃都记, 不修也记)
//   2. 栈顶帧在 apps/core/**.js 内 → 进入修复流程
//   3. 规则快修 (已知模式, 零 LLM): Assignment to constant variable → const→let
//   4. LLM 精修: 文件上下文 ±20 行 + 错误栈 → 严格 JSON {find, replace} 最小补丁
//   5. 三重验证: find 全文件唯一匹配 / node --check 语法过 / 不改其他文件
//   6. 验证过 → git 提交留痕 + repairs.jsonl 记功 → 5s 后 process.exit(0), launchd 拉起新进程
//   7. 任何一步失败 → 回滚原文件, 记失败, 不重试 (rate limit: 同签名 24h 一次, 全天 5 次封顶)
//
// 纪律: 只修 apps/core 内的 .js; 不碰 config/state/前端; 修不了就诚实记账, 绝不硬改。

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');     // modules → core → apps → pangu 根
const CORE_ROOT = path.join(REPO_ROOT, 'apps', 'core');          // 只许修这里
const STATE_DIR = path.join(os.homedir(), '.pangu', 'state', 'self_repair');
const INCIDENTS_LOG = path.join(STATE_DIR, 'incidents.jsonl');
const REPAIRS_LOG = path.join(STATE_DIR, 'repairs.jsonl');

const MAX_REPAIRS_PER_DAY = 5;
const SAME_SIGNATURE_COOLDOWN_MS = 24 * 3600 * 1000;
let _restartScheduled = false;

function _ensureDir() { try { fs.mkdirSync(STATE_DIR, { recursive: true }); } catch (_) {} }

function _append(file, obj) {
  _ensureDir();
  try { fs.appendFileSync(file, JSON.stringify({ ts: new Date().toISOString(), ...obj }) + '\n'); } catch (_) {}
}

function _readLog(file) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch (_) { return null; } }).filter(Boolean);
  } catch (_) { return []; }
}

// 栈顶第一个 apps/core 内的帧
function _topCoreFrame(stack) {
  if (!stack) return null;
  const re = /\((\/[^):]+\.js):(\d+):(\d+)\)/g;
  let m;
  while ((m = re.exec(stack)) !== null) {
    const file = m[1];
    if (file.startsWith(CORE_ROOT) && !file.includes('node_modules')) {
      return { file, line: parseInt(m[2], 10), col: parseInt(m[3], 10) };
    }
  }
  // 无括号帧 (顶层)
  const re2 = /at (\/[^:]+\.js):(\d+):(\d+)/g;
  while ((m = re2.exec(stack)) !== null) {
    if (m[1].startsWith(CORE_ROOT) && !m[1].includes('node_modules')) return { file: m[1], line: +m[2], col: +m[3] };
  }
  return null;
}

// ---- 规则快修 ----
// Assignment to constant variable: 在崩溃行找被赋值的变量名 → 全文件找 const 声明 → 改 let
function _ruleFix(err, frame, src) {
  if (!/Assignment to constant variable/.test(err.message || '')) return null;
  const lines = src.split('\n');
  const crashLine = lines[frame.line - 1] || '';
  const am = crashLine.match(/\b([A-Za-z_$][\w$]*)\s*(\+=|-=|\*=|\/=|=|\+\+|--)/);
  if (!am) return null;
  const name = am[1];
  const declRe = new RegExp('^([ \\t]*)const\\s+' + name + '\\b', 'm');
  const dm = src.match(declRe);
  if (!dm) return null;
  const find = dm[0];
  if ((src.match(new RegExp(declRe.source, 'gm')) || []).length !== 1) return null; // 多处声明不动
  return { find, replace: find.replace(/\bconst\b/, 'let'), rule: 'const_to_let', var: name };
}

// ---- LLM 精修 ----
function _pickModel(cfg) {
  const models = cfg && cfg.llm && Array.isArray(cfg.llm.models) ? cfg.llm.models : [];
  if (!models.length) return null;
  const def = cfg.llm.default_model && models.find(m => m.id === cfg.llm.default_model);
  // 2026-10-26 (第 110 批): 「有 key」按**统一解析链**判, 不看明文字段。
  //   明文已从配置里收编进凭证库 ⇒ 只看 m.api_key 会把所有云端模型都判成「没 key」。
  const { resolveApiKey } = require('./api_key_resolver');
  const cloud = models.find(m => m.endpoint && !String(m.endpoint).includes('127.0.0.1') && resolveApiKey(m));
  return def || cloud || models[0];
}

function _llmFix(err, frame, src, cfg) {
  const model = _pickModel(cfg);
  if (!model || !model.endpoint) return null;
  const lines = src.split('\n');
  const lo = Math.max(0, frame.line - 21), hi = Math.min(lines.length, frame.line + 20);
  const excerpt = lines.slice(lo, hi).map((l, i) => (lo + i + 1) + ': ' + l).join('\n');
  const prompt = [
    '你是盘古自愈模块。下面这个 Node.js 文件在运行时崩溃了。',
    '错误: ' + (err.message || 'unknown'),
    '崩溃位置: ' + path.basename(frame.file) + ' 第 ' + frame.line + ' 行',
    '栈顶: ' + String(err.stack || '').split('\n').slice(0, 3).join(' | '),
    '',
    '文件片段 (带行号):',
    excerpt,
    '',
    '给出最小修复。只返回 JSON (无 markdown 无解释): {"find": "文件中必须唯一存在的精确原文", "replace": "替换后文本"}',
    '纪律: 最小改动, 不重构, 不改无关行, find 必须是上面片段里逐字符精确的连续原文。',
  ].join('\n');
  try {
    const base = String(model.endpoint).replace(/\/+$/, '');
    const url = base.endsWith('/chat/completions') ? base : base + '/chat/completions';
    const body = JSON.stringify({
      model: model.model || model.id,
      messages: [{ role: 'user', content: prompt }],
      temperature: 0,
      max_tokens: 800,
    });
    const out = spawnSync('curl', ['-sS', '--max-time', '60', '-X', 'POST', url,
      '-H', 'Content-Type: application/json',
      // 2026-10-26 (第 110 批): 走统一解析链 (凭证库 / 环境变量 / 明文兜底)
      '-H', 'Authorization: Bearer ' + (require('./api_key_resolver').resolveApiKey(model) || ''),
      '-d', body], { encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 });
    if (out.status !== 0 || !out.stdout) return null;
    const resp = JSON.parse(out.stdout);
    let text = resp.choices && resp.choices[0] && resp.choices[0].message && resp.choices[0].message.content || '';
    text = text.replace(/```json|```/g, '').trim();
    const jm = text.match(/\{[\s\S]*"find"[\s\S]*"replace"[\s\S]*\}/);
    if (!jm) return null;
    const patch = JSON.parse(jm[0]);
    if (typeof patch.find !== 'string' || typeof patch.replace !== 'string' || !patch.find) return null;
    return { find: patch.find, replace: patch.replace, rule: 'llm', model: model.id };
  } catch (_) { return null; }
}

// 应用补丁: find 必须全文件唯一; 写回后 node --check 验证; 失败回滚
function _applyPatch(file, patch) {
  const src = fs.readFileSync(file, 'utf8');
  const occurrences = src.split(patch.find).length - 1;
  if (occurrences !== 1) return { ok: false, error: 'find 不唯一 (' + occurrences + ' 处), 拒改' };
  const next = src.replace(patch.find, patch.replace);
  if (next === src) return { ok: false, error: '补丁无变化' };
  fs.writeFileSync(file, next);
  const chk = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
  if (chk.status !== 0) {
    fs.writeFileSync(file, src); // 回滚
    return { ok: false, error: 'node --check 未过, 已回滚: ' + String(chk.stderr || '').slice(0, 200) };
  }
  return { ok: true };
}

function _gitCommit(file, msg) {
  try {
    execSync('git add "' + file + '" && git commit -m "' + msg.replace(/"/g, "'") + '"', { cwd: REPO_ROOT, stdio: 'pipe' });
    return true;
  } catch (_) { return false; }
}

function _scheduleRestart(reason) {
  if (_restartScheduled) return;
  _restartScheduled = true;
  console.warn('[self-repair] 修复已验证落盘, 5s 后自重启生效 (launchd 拉起): ' + reason);
  setTimeout(() => { try { process.exit(0); } catch (_) {} }, 5000).unref();
}

// 对外主入口 — 崩溃处理器调用, fire-and-forget (绝不 throw)
function handleCrash(type, err, ctx) {
  try {
    const frame = _topCoreFrame(err && err.stack);
    const signature = (err && err.message || 'unknown') + ' @ ' + (frame ? path.basename(frame.file) + ':' + frame.line : 'no-frame');
    _append(INCIDENTS_LOG, { type, message: err && err.message, signature, frame, session: ctx && ctx.sessionId });
    console.warn('[self-repair] 事故记账: ' + signature);

    if (!frame) return { ok: false, reason: 'no-core-frame' };

    // rate limit
    const repairs = _readLog(REPAIRS_LOG);
    const today = new Date().toISOString().slice(0, 10);
    if (repairs.filter(r => (r.ts || '').startsWith(today) && r.ok).length >= MAX_REPAIRS_PER_DAY) {
      return { ok: false, reason: 'daily-cap' };
    }
    const lastSame = repairs.filter(r => r.signature === signature).pop();
    if (lastSame && Date.now() - new Date(lastSame.ts).getTime() < SAME_SIGNATURE_COOLDOWN_MS) {
      return { ok: false, reason: 'same-signature-cooldown' };
    }

    const src = fs.readFileSync(frame.file, 'utf8');
    // 规则快修优先 (零 LLM 零风险), 不中再走 LLM
    let patch = _ruleFix(err, frame, src);
    if (!patch && ctx && ctx.config) patch = _llmFix(err, frame, src, ctx.config);
    if (!patch) {
      _append(REPAIRS_LOG, { signature, file: frame.file, line: frame.line, ok: false, reason: 'no-patch' });
      return { ok: false, reason: 'no-patch' };
    }

    const applied = _applyPatch(frame.file, patch);
    if (!applied.ok) {
      _append(REPAIRS_LOG, { signature, file: frame.file, line: frame.line, ok: false, reason: applied.error, rule: patch.rule });
      return { ok: false, reason: applied.error };
    }

    const committed = _gitCommit(frame.file, '[self-repair] ' + signature.slice(0, 72));
    _append(REPAIRS_LOG, { signature, file: frame.file, line: frame.line, ok: true, rule: patch.rule, var: patch.var, model: patch.model, committed });
    console.warn('[self-repair] ✅ 自愈成功: ' + signature + ' (rule=' + patch.rule + ', committed=' + committed + ')');

    // 进化记账 — 让反思/学习将灵后续能看到这次自愈
    try { require('./evolution_record')._recordEvolution({ type: 'self_repair', signature, file: frame.file, line: frame.line, rule: patch.rule, ts: Date.now() }); } catch (_) {}

    _scheduleRestart(signature);
    return { ok: true, rule: patch.rule };
  } catch (e) {
    console.warn('[self-repair] 自愈流程自身异常 (不阻断):', e.message);
    return { ok: false, reason: 'self-repair-crash: ' + e.message };
  }
}

function listIncidents(limit) {
  return _readLog(INCIDENTS_LOG).slice(-(limit || 50));
}
function listRepairs(limit) {
  return _readLog(REPAIRS_LOG).slice(-(limit || 50));
}

module.exports = { handleCrash, listIncidents, listRepairs,
  // 2026-09-14 (#7): 导出内部件供 e2e 实测 (LLM 精修路径此前从未真测过)
  _internals: { _ruleFix, _llmFix, _applyPatch, _topCoreFrame, _pickModel } };
