#!/usr/bin/env node
/**
 * Pangu 自我修复执行器 v1 (2026-08-12 老板拍 §R131-Phase 2)
 *
 * 角色: 读 ~/.pangu/repair/pending-*.json → diagnose via LLM → apply patch in worktree
 *       → test → merge 或 rollback → 写 done-*.json / failed-*.json
 *
 * 输入:  ~/.pangu/repair/pending-*.json (Phase 1 watcher 写的)
 * 输出:  ~/.pangu/repair/done-{ts}.json | failed-{ts}.json
 * 保护:  rate-limit ≤3 patches/day + patch pangu-single.js/j2_agent_loop.js 必须先停 Pangu
 *
 * 用法:
 *   node pangu-repair-runner.js              # 处理所有 pending
 *   node pangu-repair-runner.js --dry-run    # 只 diagnose, 不 apply
 *   node pangu-repair-runner.js --one        # 只处理第 1 个 pending
 *   node pangu-repair-runner.js --test       # 故意制造 1 个 pending + 处理它
 *
 * Cron: launchd local.pangu-repair-runner.plist, StartInterval=600 (10 分钟)
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync, spawnSync } = require('child_process');
const crypto = require('crypto');

// 第 100 批: REPAIR_DIR 可用 PANGU_REPAIR_DIR 覆盖 ——
// 否则**测试**跑跑批器就会往生产 ~/.pangu/repair 写 pending/result 产物。
// (跟第 100 批给进化账本加 PANGU_EVO_DIR 是同一个道理: 沙箱变量必须专用, 不能复用 PANGU_HOME —— 那个变量一名两义。)
const REPAIR_DIR = process.env.PANGU_REPAIR_DIR || path.join(os.homedir(), '.pangu', 'repair');
// 第 100 批: 日志目录也可导走 (测试跑跑批器不该往生产日志里写)。
const LOG_DIR = process.env.PANGU_LOG_DIR || path.join(os.homedir(), 'Library', 'Logs', 'pangu');
const LOG = path.join(LOG_DIR, 'repair-runner.log');
const PANGU_ROOT = process.env.PANGU_ROOT || path.join(os.homedir(), 'Desktop', 'pangu');
const TEST_CMD = 'cd ' + PANGU_ROOT + ' && bash scripts/pangu-audit-verify.sh 2>&1 | tail -50';
const STOP_PANGU = 'launchctl bootout gui/501/local.pangu-single 2>&1 || true';
const START_PANGU = 'launchctl bootstrap gui/501 ~/Library/LaunchAgents/local.pangu-single.plist 2>&1';
const RATE_FILE = path.join(REPAIR_DIR, '.rate-counter.json');
const MAX_PER_DAY = 3;  // 老板 §R131-Phase2.2 保护
const CRITICAL_FILES = ['pangu-single.js', 'j2_agent_loop.js'];  // 必须先停 Pangu

// ===========================================================================
// 2026-10-26 第 100 批: 「本地慢」的真凶 —— 跑批器空转烧本地 GPU
// ===========================================================================
// 现场取证 (2026-10-26, 实测不是推断):
//   · 跑批器每 10 分钟跑一次 (launchd StartInterval=600), 共启动过 **10002 次**,
//     累计 **success=0 / failed=4818** —— 一次都没修成过。
//   · 它每次都把 **136695 字节**的提示词发给本地 27B (≈45K token),
//     因为 pending 的证据文件是**进化账本 .jsonl** —— 跑批器把日志当"源码上下文"喂了进去。
//   · 模型只能答 "这是运行日志不是源码, 没有可复现的缺陷" → confidence=0 → 跳过。
//   · 代价: 本地 GPU 被占住十几分钟, 老板的对话全排在它后面 ⇒ "跟死了一样";
//     45K token 的请求还会把 LM Studio 的 prompt 缓存顶到 85% ⇒ 触发缓存守卫重载
//     ⇒ 下一次请求又是全量 prefill (75s) ⇒ 越滚越慢。
//
// 修法 (三条, 都按**机制**不是按名字):
//   ① 证据里只有**源码**才能进上下文 (日志类文件不算) —— 统计型信号模型根本改不了,
//      不该问它。总上下文还有 16KB 上限 —— 一次修复不需要 45K token。
//   ② 证据不是源码 ⇒ **不发请求**, 直接跳过 (省掉整条 GPU 占用链)。
//   ③ **熔断**: 同一类信号连续 2 次 confidence<0.6 ⇒ 冷却 24h, 不再重试。
//      (模型反复修不了的信号, 无限重试只是无限烧 GPU。)

// 日志/统计类扩展名 —— 这些不是源码, 模型改不了它们。
const LOG_LIKE_EXT = new Set(['.log', '.jsonl', '.ndjson', '.txt', '.md', '.csv', '.tsv']);
// 源码上下文总量上限 (16KB ≈ 4K token)
const SOURCE_CONTEXT_MAX_BYTES = 16 * 1024;
// 熔断状态文件 + 参数
const BREAKER_FILE = path.join(REPAIR_DIR, '.breaker.json');
const BREAKER_FAIL_THRESHOLD = 2;      // 连续几次修不了就冷却
const BREAKER_COOLDOWN_MS = 24 * 3600 * 1000;  // 冷却 24 小时
// 失败产物保留天数 (产物不是账本 —— 账本在 incidents.jsonl / repairs.jsonl)
const FAILED_KEEP_DAYS = 7;

// 证据文件分类: 源码 vs 日志。返回纯数据, 便于单测。
function _classifyEvidence(files) {
  const source = [], skipped = [];
  for (const f of (files || [])) {
    if (!f || typeof f !== 'string') { skipped.push({ file: String(f), why: '路径无效' }); continue; }
    const ext = path.extname(f).toLowerCase();
    if (LOG_LIKE_EXT.has(ext)) { skipped.push({ file: f, why: '日志/统计类文件, 不是源码' }); continue; }
    source.push(f);
  }
  return { source, skipped };
}

// 这个 pending 要不要问模型? 返回 { skip: bool, why: string }。
// ⚠️ 顺序很重要: 先看信号本身标没标"不可修", 再看证据里有没有源码。
function _decideSkip(pending) {
  if (pending && pending.repairable === false) {
    return { skip: true, why: '信号被标为不可修 (统计型信号, 跑批器改不了)' };
  }
  const cls = _classifyEvidence((pending && pending.evidence && pending.evidence.files) || []);
  if (!cls.source.length) {
    return { skip: true, why: '证据里没有源码文件 (只有日志/统计) ⇒ 模型改不了, 不问' };
  }
  return { skip: false, why: '' };
}

// 信号类: 'l1-fail:2026-10-25' → 'l1-fail' (去掉日期等易变后缀, 熔断按类算)
function _signalClass(signal) {
  const s = String(signal || '').split(':')[0].trim();
  return s || 'unknown';
}

function _readBreaker(file = BREAKER_FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch (_) { return {}; }
}
function _writeBreaker(state, file = BREAKER_FILE) {
  try { ensureDir(path.dirname(file)); fs.writeFileSync(file, JSON.stringify(state, null, 2)); } catch (_) {}
}
function _breakerCoolingDown(state, cls, now = Date.now()) {
  const e = state && state[cls];
  return !!(e && e.cooldownUntil && now < e.cooldownUntil);
}
// 记一次结果: 成功就清零, 失败就累加, 到阈值就进冷却。
function _breakerRecord(state, cls, ok, now = Date.now()) {
  const e = (state && state[cls]) || { consecutiveFails: 0 };
  if (ok) {
    e.consecutiveFails = 0;
    e.cooldownUntil = 0;
    e.lastOkAt = now;
  } else {
    e.consecutiveFails = (e.consecutiveFails || 0) + 1;
    e.lastFailAt = now;
    if (e.consecutiveFails >= BREAKER_FAIL_THRESHOLD) {
      e.cooldownUntil = now + BREAKER_COOLDOWN_MS;
      e.cooldownFrom = now;
    }
  }
  state[cls] = e;
  return state;
}

function ensureDir(p) { if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true }); }

// 2026-10-18: 把 endpoint 补成完整的 OpenAI 兼容 chat 路径。
// 实测 LM Studio (llama.cpp server): 裸 host / 或缺 /v1 一律 **HTTP 200** +
// {"error":"Unexpected endpoint or method. ..."} 空壳, curl -f 抓不到, 静默失败。
// 规矩: 路径为空先补 /v1; 没有 /chat/completions 后缀再补后缀 (已带查询串的不动)。
function _completeChatPath(raw) {
  let u;
  try { u = new URL(String(raw)); } catch (_) { return String(raw); }
  let p = u.pathname;
  if (p === '' || p === '/') p = '/v1';
  if (!/\/chat\/completions$/.test(p)) p = p.replace(/\/+$/, '') + '/chat/completions';
  u.pathname = p;
  return u.toString();
}

function log(msg) {
  const line = '[' + new Date().toISOString().replace('T', ' ').slice(0, 19) + '] ' + msg;
  console.log(line);
  try { ensureDir(LOG_DIR); fs.appendFileSync(LOG, line + '\n'); } catch (_) {}
}

function todayKey() {
  return new Date().toISOString().slice(0, 10);  // YYYY-MM-DD
}

function getRate() {
  try {
    const r = JSON.parse(fs.readFileSync(RATE_FILE, 'utf8'));
    if (r.date === todayKey()) return r.count || 0;
  } catch (_) {}
  return 0;
}

function incRate() {
  const today = todayKey();
  let count = 0;
  try {
    const r = JSON.parse(fs.readFileSync(RATE_FILE, 'utf8'));
    if (r.date === today) count = r.count || 0;
  } catch (_) {}
  count++;
  fs.writeFileSync(RATE_FILE, JSON.stringify({ date: today, count }));
  return count;
}

function sh(cmd, opts = {}) {
  log('$ ' + cmd);
  const r = spawnSync('bash', ['-c', cmd], {
    cwd: opts.cwd || PANGU_ROOT,
    timeout: opts.timeout || 60000,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return { code: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

function readPending() {
  ensureDir(REPAIR_DIR);
  return fs.readdirSync(REPAIR_DIR)
    .filter(f => f.startsWith('pending-') && f.endsWith('.json'))
    .sort()
    .map(f => {
      try {
        return { file: f, ...JSON.parse(fs.readFileSync(path.join(REPAIR_DIR, f), 'utf8')) };
      } catch (_) { return null; }
    })
    .filter(Boolean);
}

function writeResult(prefix, payload) {
  ensureDir(REPAIR_DIR);
  const id = prefix + '-' + Date.now() + '-' + crypto.randomBytes(2).toString('hex');
  const fp = path.join(REPAIR_DIR, id + '.json');
  fs.writeFileSync(fp, JSON.stringify(payload, null, 2));
  log('📝 写 ' + prefix + ': ' + fp);
  return id;
}

function rmPending(file) {
  try { fs.unlinkSync(path.join(REPAIR_DIR, file)); log('🗑  删 pending: ' + file); }
  catch (e) { log('⚠ 删 pending 失败: ' + e.message); }
}

// ========== LLM diagnose ==========
// 调用老板主用的模型 (MiniMax-M3) 给出 root_cause + patch (unified diff) + confidence
// v1 简化: 直接走 OpenAI 兼容 API (默认 Pangu 自己的 LLM endpoint)
//
// 第 100 批: 源码上下文的组装抽成纯函数 _buildSourceContext —— 可单测。
// 三条硬规则:
//   ① 只有**源码**文件能进上下文 (日志/统计类不进)
//   ② 总量上限 16KB (旧版没有上限 ⇒ 一次 136KB ⇒ 45K token)
//   ③ 每个文件最多 3 个、每个最多 200 行 (旧版就有, 保留)
function _buildSourceContext(files, pending, maxBytes = SOURCE_CONTEXT_MAX_BYTES) {
  let sourceContext = '';
  // ⚠️ 这里**再过滤一次**日志类文件, 不是冗余:
// 规则「日志不进上下文」必须由这个函数自己守住 ——
// 万一将来有人加了个新调用点忘了先分类, 日志就会又混进提示词里 (那正是 45K token 空转的根因)。
  // 防御性过滤放在**收口的那个函数**里, 而不是要求每个调用方都记得做。
  const _cls = _classifyEvidence(files);
  for (const f of _cls.source.slice(0, 3)) {
    try {
      // 读文件路径可以是绝对/相对 PANGU_ROOT
      const fp = f.startsWith('/') ? f : path.join(PANGU_ROOT, f);
      if (!fs.existsSync(fp)) continue;
      const content = fs.readFileSync(fp, 'utf8');
      const lines = content.split('\n');
      // 试从 logLine 提取行号 (e.g. "wuxing_map.js:42")
      const lnMatch = String((pending && pending.evidence && pending.evidence.logLine) || '').match(/:(\d+)/);
      const targetLn = lnMatch ? parseInt(lnMatch[1], 10) : null;
      let sliceLines, startLn = 1;
      if (targetLn && targetLn > 0) {
        startLn = Math.max(1, targetLn - 30);
        const endLn = Math.min(lines.length, targetLn + 30);
        sliceLines = lines.slice(startLn - 1, endLn);
        sourceContext += `\n=== ${f} (lines ${startLn}-${endLn}) ===\n` + sliceLines.map((l, i) => `${startLn + i}: ${l}`).join('\n') + '\n';
      } else {
        // 无行号, 读前 100 行
        sliceLines = lines.slice(0, 100);
        sourceContext += `\n=== ${f} (前 100 行) ===\n` + sliceLines.map((l, i) => `${i + 1}: ${l}`).join('\n') + '\n';
      }
    } catch (e) {
      sourceContext += `\n=== ${f} 读失败: ${e.message} ===\n`;
    }
  }
  // 总量上限: 一次修复不需要 45K token 的上下文 (旧版没有上限 ⇒ 一次 136KB)
  if (sourceContext.length > maxBytes) {
    sourceContext = sourceContext.slice(0, maxBytes)
      + `\n[上下文已截断: 超过 ${maxBytes} 字节上限]\n`;
  }
  return sourceContext;
}

async function diagnose(pending) {
  const ctx = JSON.stringify(pending, null, 2);

  // 从 pending.evidence.files 读源码上下文 (最多 3 个文件, 每个 200 行)
  //
  // 第 100 批: **只有源码文件能进上下文**, 且总量有 16KB 上限。
  // 旧版把 .jsonl 进化账本也当"源码"读进来 (136KB) ⇒ 每次请求 45K token,
  // 而模型面对一堆日志根本给不出 patch ⇒ confidence=0 ⇒ 白烧本地 GPU。
  const _cls = _classifyEvidence((pending.evidence && pending.evidence.files) || []);
  if (_cls.skipped.length) {
    log('  📄 跳过非源码证据 ' + _cls.skipped.length + ' 个: ' + _cls.skipped.map(s => path.basename(s.file)).join(', '));
  }
  const sourceContext = _buildSourceContext(_cls.source, pending);
  log('  📚 源码上下文: ' + sourceContext.length + ' 字节 (上限 ' + SOURCE_CONTEXT_MAX_BYTES + '), 来源 ' + _cls.source.length + ' 个源码文件');

  const prompt = `你是 Pangu 自愈 agent。给定一个 pending 信号 (来自 self-repair watcher), 输出严格 JSON:
{
  "root_cause": "一句话原因",
  "old_text": "完整原文件内容 (从源码上下文复制, 不要省略)",
  "new_text": "完整修改后文件内容 (只改必要部分)",
  "files_to_modify": ["相对路径"],
  "test_plan": "如何验证修复 (一条 bash 命令)",
  "confidence": 0.0-1.0,
  "reasoning": "为何这样修"
}

重要: 不要输出 unified diff, 只输出 old_text + new_text (完整文件内容)。unified diff 格式 LLM 容易出错, 我会用 diff 命令自动生成。

规则:
1. patch 必须最小化 (只改必要行)
2. confidence < 0.6 = 拒绝, 返回 {"confidence": 0.0, "reasoning": "不修, 原因"}
3. 不改 j2_agent_loop.js / pangu-single.js (除非是 critical 修复, 但需 confidence > 0.9)
4. 不引入新依赖, 不改 schema, 不动 mcp-loader
5. 测试命令必须在 Pangu repo 根目录能跑通

Pending:
${ctx}

源码上下文 (从 evidence.files 读):
${sourceContext || '(无文件可读)'}`;

  // v1 简化: 走 Pangu 自己的 minimax endpoint (env 变量 PANGU_LLM_URL / PANGU_LLM_KEY)
  // 如果没设, 走 fallback (mock diagnose + 标记 needs-human)
  let url = process.env.PANGU_LLM_URL;
  let key = process.env.PANGU_LLM_KEY;
  let model = process.env.PANGU_LLM_MODEL || '';
  if (!url || !key) {
    // 从 Pangu config 读 minimax 配置
    try {
      // 节点配置路径 —— 不写死任何人的机器名 (2026-10-26 第 109 批)。
      const cfgPath = require(path.join(PANGU_ROOT, 'apps/core/config/node_config.js')).resolveNodeConfigPathOrEmpty();
      if (!cfgPath) throw new Error('找不到节点配置 (apps/core/config/nodes/node.json)');
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
      // 2026-09-16 老板拍: 跟盘古 current_model_id 走, 不写死 minimax
      const _curId2 = cfg.llm && cfg.llm.current_model_id;
      const m = (cfg.llm?.models || []).find(x => x.id === _curId2)
             || (cfg.llm?.models || []).find(x => x.id === 'minimax-m3' || x.provider === 'minimax');
      if (m) {
        url = m.endpoint;
        key = m.api_key;
        // 2026-10-18: 上报的模型名必须是**那个端点真有的名字**。之前写死 'MiniMax-M3',
        // 发给只装了 qwen 的 LM Studio 必然对不上 —— 跟着 current_model_id 走就得连名字一起跟。
        if (!model) model = m.model || m.id || '';
        log('🔌 从 Pangu config 读 endpoint: ' + url + ' (model=' + (model || '?') + ')');
      }
    } catch (e) {
      log('⚠ 读 Pangu config 失败: ' + e.message);
    }
  }
  // M9 fix: 回退默认值时显式记日志, 避免静默降级到不可达 endpoint 难以排查
  if (!url) { url = 'http://127.0.0.1:18901/v1/chat/completions'; log('⚠ 未配置 PANGU_LLM_URL, 回退本地默认: ' + url); }
  if (!key) { key = 'no-key'; log('⚠ 未配置 PANGU_LLM_KEY, 使用占位 no-key (多数本地端点可忽略)'); }
  if (!/^https?:\/\//.test(url)) {
    throw new Error('LLM URL 配置无效 (需 http(s):// 开头): ' + url);
  }
  if (!model) { model = 'MiniMax-M3'; log('⚠ 未能确定模型名, 回退 MiniMax-M3'); }
  // 2026-10-18 fix: endpoint 路径补全。裸 host 不补全, LM Studio 会用 **HTTP 200**
  // 回一个 {"error":"Unexpected endpoint or method."} 空壳, curl -f 看不见失败,
  // 于是 JSON.parse 炸掉、confidence=0、每轮照样删 pending —— 自愈静默失效一个月。
  // 现场: current_model_id=qwen_qwen3.8-27b 的 endpoint 是裸 host http://127.0.0.1:1234,
  // 2026-09-18 16:00 起连续 439 次 diagnose 全灭。
  // 注意实测: 光补 /chat/completions 不够, LM Studio 要的是 /v1/chat/completions。
  url = _completeChatPath(url);

  try {
    const body = JSON.stringify({
      model,
      messages: [
        { role: 'system', content: 'You are a precise repair agent. Output strict JSON only, no markdown fencing.' },
        { role: 'user', content: prompt },
      ],
      temperature: 0.1,
      max_tokens: 2000,
    });
    // 2026-10-18: 超时预算按「本地 vs 云端」分开。跟 current_model_id 走就意味着
    // 可能打到本地 LM Studio, 而现场 --dry-run 实测 62KB prompt 打 27B 本地模型
    // 第一发就撞满 60s (curl 28 timeout), 第二次才 52s 跑完。
    // llm_caller.js 早就为本地模型放宽到 300s, 这里还死写 60 = 白丢一次重试。
    const _isLocal = /^(https?:\/\/)?(127\.0\.0\.1|localhost|\[::1\]|0\.0\.0\.0)(:|\/|$)/i.test(url);
    const _timeoutSec = _isLocal ? 300 : 60;
    const _spawnMs = (_timeoutSec + 5) * 1000;
    // 重试 3 次, 退避 2/4/8s (minimax API 偶发超时)
    // H4 fix: spawnSync 数组参数直调 curl, 不经 shell, 消除 url/key shell 注入风险
    let r = { code: 1, stdout: '', stderr: 'init' };
    for (let attempt = 1; attempt <= 3; attempt++) {
      log('$ curl -fsS --max-time ' + _timeoutSec + ' -X POST ' + url + ' (body ' + body.length + ' bytes, key 已省略)');
      const cr = spawnSync('curl', [
        '-fsS', '--max-time', String(_timeoutSec), '-X', 'POST', url,
        '-H', 'Authorization: Bearer ' + key,
        '-H', 'Content-Type: application/json',
        '-d', body,
      ], { cwd: PANGU_ROOT, timeout: _spawnMs, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      r = { code: cr.status, stdout: cr.stdout || '', stderr: cr.stderr || (cr.error ? cr.error.message : '') };
      if (r.code === 0) break;
      log('  ⚠ LLM 调用重试 ' + attempt + '/3: ' + r.stderr.slice(0, 100));
      if (attempt < 3) sleep(2000 * attempt);  // 2s, 4s
    }
    if (r.code !== 0) throw new Error('LLM call failed (3 次重试): ' + r.stderr);
    const json = JSON.parse(r.stdout);
    // 2026-10-18: 上游会用 **HTTP 200** 回一个 {"error":...} 空壳 (路径不对/模型名不认识),
    // curl -f 看不见, 于是走进下面的 content='' → confidence 0 → 「跳过 (人工 review)」,
    // 一个月没人知道自愈从来没真跑过。这里显式炸出来, 不许再伪装成"模型没把握"。
    if (json && json.error) {
      throw new Error('上游 200 但返回 error (endpoint/模型名不对?): '
        + String(json.error).slice(0, 200) + ' | url=' + url + ' model=' + model);
    }
    if (!json || !json.choices || !json.choices.length) {
      throw new Error('上游 200 但响应没有 choices (不是 OpenAI 兼容形状): '
        + String(r.stdout).slice(0, 200) + ' | url=' + url + ' model=' + model);
    }
    const content = json.choices?.[0]?.message?.content || '';
    // 多层 fallback 提取 JSON:
    // 0. 去掉 <think>...</think> 块 (某些模型如 minimax-m3 会返回思考过程, 需容错未闭合)
    // 1. 去 ```json ... ``` markdown fence
    // 2. 找首个完整的 { ... } (brace counting)
    // 3. 兜底 regex greedy match
    let parsed = null;
    let extractErr = null;
    // 0. strip think block: 闭合的优先, 不闭合的也算到首个完整 { 之前
    let cleaned = content;
    // 闭合 think 块
    cleaned = cleaned.replace(/<think>[\s\S]*?<\/think>/gi, '');
    // 未闭合 think 块: 去掉 <think> 后面所有内容直到首个 {
    const thinkStart = cleaned.indexOf('<think>');
    if (thinkStart >= 0) {
      const beforeThink = cleaned.slice(0, thinkStart);
      const afterThink = cleaned.slice(thinkStart);
      const firstBrace = afterThink.indexOf('{');
      if (firstBrace >= 0) {
        cleaned = beforeThink + afterThink.slice(firstBrace);
      } else {
        cleaned = beforeThink;  // 整个响应都是 think, 没 JSON
      }
    }
    // 层 1: strip fence
    cleaned = cleaned.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();
    // 层 2: brace counting - 找首个 balance 的 { ... }
    try {
      const start = cleaned.indexOf('{');
      if (start >= 0) {
        let depth = 0, end = -1;
        for (let i = start; i < cleaned.length; i++) {
          if (cleaned[i] === '{') depth++;
          else if (cleaned[i] === '}') {
            depth--;
            if (depth === 0) { end = i; break; }
          }
        }
        if (end > start) {
          parsed = JSON.parse(cleaned.slice(start, end + 1));
        }
      }
    } catch (e) { extractErr = e; }
    // 层 3: 兜底 regex
    if (!parsed) {
      try {
        const m = content.match(/\{[\s\S]*\}/);
        if (m) parsed = JSON.parse(m[0]);
      } catch (e) { extractErr = e; }
    }
    if (!parsed) {
      // 保存原始 + cleaned 内容到 /tmp 调试
      try {
        fs.writeFileSync('/tmp/pangu-repair-last-raw.txt', content);
        fs.writeFileSync('/tmp/pangu-repair-last-cleaned.txt', cleaned);
      } catch (_) {}
      throw new Error('JSON parse 失败: ' + (extractErr?.message || 'unknown') + ' | 原始 (前 500 字符): ' + content.slice(0, 500));
    }
    log('🧠 diagnose: confidence=' + parsed.confidence + ', root_cause=' + (parsed.root_cause || '').slice(0, 80));
    log('  old_text: ' + ((parsed.old_text || '').slice(0, 200) + (parsed.old_text && parsed.old_text.length > 200 ? '... (len=' + parsed.old_text.length + ')' : '')));
    log('  new_text: ' + ((parsed.new_text || '').slice(0, 200) + (parsed.new_text && parsed.new_text.length > 200 ? '... (len=' + parsed.new_text.length + ')' : '')));
    log('  files_to_modify: ' + JSON.stringify(parsed.files_to_modify || []));
    log('  has patch (deprecated): ' + (parsed.patch ? 'yes' : 'no'));
    // 全量保存 raw LLM 响应到 /tmp (调试用)
    try { fs.writeFileSync('/tmp/pangu-repair-last-diag.json', JSON.stringify(parsed, null, 2)); } catch (_) {}
    return parsed;
  } catch (e) {
    log('⚠ LLM diagnose 失败: ' + e.message);
    return { confidence: 0.0, reasoning: 'LLM 不可达或返错: ' + e.message };
  }
}

// ========== Apply patch in worktree ==========
async function applyPatch(diag) {
  // 早 return: LLM 没返回足够字段
  if (!diag.old_text || !diag.new_text || !diag.files_to_modify || diag.files_to_modify.length === 0) {
    return { ok: false, reason: 'LLM 返回缺 old_text/new_text/files_to_modify' };
  }

  const wtBranch = 'auto-repair-' + Date.now();
  const wtPath = path.join(os.homedir(), 'pangu-repair-' + Date.now());

  // 1. worktree
  let r = sh(`git worktree add -b ${wtBranch} '${wtPath}' HEAD`);
  if (r.code !== 0) {
    // 如果分支已存在, 换个名字
    const altBranch = wtBranch + '-' + crypto.randomBytes(2).toString('hex');
    r = sh(`git worktree add -b ${altBranch} '${wtPath}' HEAD`);
    if (r.code !== 0) return { ok: false, reason: 'worktree add 失败: ' + r.stderr };
  }

  // 2. apply patch via diff (LLM 返回 old_text + new_text)
  const targetRel = diag.files_to_modify[0];
  const targetAbs = targetRel.startsWith('/') ? targetRel : path.join(PANGU_ROOT, targetRel);
  // 写 old/new 到 worktree, 用 diff 生成 patch
  const oldFile = path.join(wtPath, targetRel + '.old');
  const newFile = path.join(wtPath, targetRel + '.new');
  fs.mkdirSync(path.dirname(oldFile), { recursive: true });
  fs.writeFileSync(oldFile, diag.old_text);
  fs.writeFileSync(newFile, diag.new_text);
  // 用 diff -u 生成 patch
  r = sh(`diff -u '${targetRel}.old' '${targetRel}.new' > .auto-repair.patch || true`, { cwd: wtPath });
  // diff 返回 1 表示文件不同 (成功), 0 表示相同, 2 表示错
  if (!fs.existsSync(path.join(wtPath, '.auto-repair.patch'))) {
    sh(`git worktree remove --force '${wtPath}'`);
    return { ok: false, reason: 'diff 生成 patch 失败' };
  }
  const patchText = fs.readFileSync(path.join(wtPath, '.auto-repair.patch'), 'utf8');
  if (!patchText || !patchText.includes('---') || !patchText.includes('+++')) {
    sh(`git worktree remove --force '${wtPath}'`);
    return { ok: false, reason: 'diff 输出无 patch (old == new?)' };
  }
  // 备份到 /tmp
  const debugPatch = `/tmp/pangu-repair-${Date.now()}.patch`;
  fs.writeFileSync(debugPatch, patchText);
  log('📄 patch (diff 生成) 备份: ' + debugPatch + ' (' + patchText.length + ' chars)');
  // 检查 patch 是否会命中实际文件 (使用 --check 验证 hunk 正确)
  // diff 生成的 patch path 是 old/new (临时文件路径), 需要 strip 后用 git apply -p1
  const applyPatch = patchText
    .replace(new RegExp(`\\-\\-\\- a?${targetRel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\.old`, 'g'), `--- a/${targetRel}`)
    .replace(new RegExp(`\\+\\+\\+ b?${targetRel.replace(/[.*+?^${}()|[\\]\\\\]/g, '\\\\$&')}\\.new`, 'g'), `+++ b/${targetRel}`);
  // 先写 old_text 到实际文件 (worktree 里可能没有, 需创建)
  const actualTargetPath = path.join(wtPath, targetRel);
  fs.mkdirSync(path.dirname(actualTargetPath), { recursive: true });
  if (!fs.existsSync(actualTargetPath)) {
    fs.writeFileSync(actualTargetPath, diag.old_text);
    log('📝 初始化 worktree 文件 (old_text): ' + actualTargetPath);
  }
  fs.writeFileSync(path.join(wtPath, '.auto-repair.patch'), applyPatch);
  r = sh(`git apply --check .auto-repair.patch`, { cwd: wtPath });
  if (r.code !== 0) {
    sh(`git worktree remove --force '${wtPath}'`);
    return { ok: false, reason: 'diff patch --check 失败: ' + r.stderr };
  }
  r = sh(`git apply .auto-repair.patch`, { cwd: wtPath });
  if (r.code !== 0) {
    sh(`git worktree remove --force '${wtPath}'`);
    return { ok: false, reason: 'diff patch apply 失败: ' + r.stderr };
  }

  // 3. critical file check (必须先停 Pangu)
  const needsStop = diag.files_to_modify.some(f => CRITICAL_FILES.some(c => f.includes(c)));
  let stopped = false;
  if (needsStop) {
    log('🛑 涉及 critical 文件, 先停 Pangu');
    sh(STOP_PANGU);
    stopped = true;
    sleep(3000);  // 等 Pangu 完全退出
  }

  // 4. test (跑 LLM 给的 test_plan, 或默认 syntax check)
  const testCmd = diag.test_plan && diag.test_plan.length > 5 ? diag.test_plan : `node -c ${targetRel}`;
  log('🧪 test: ' + testCmd.slice(0, 200));
  r = sh(testCmd, { cwd: wtPath, timeout: 60000 });
  const testOk = r.code === 0;

  // 5. decision
  let result = { ok: false, wtPath, branch: wtBranch, testOutput: r.stdout.slice(-1000), testExitCode: r.code };

  if (testOk && diag.confidence >= 0.7) {
    // commit + merge
    r = sh(`git add -A && git commit -m "auto-repair: ${(diag.root_cause || 'unknown').slice(0, 60)}"`, { cwd: wtPath });
    if (r.code === 0) {
      // merge 前先清冲突的 untracked 文件 (PANGU_ROOT 里同路径可能被手动添加)
      sh(`test -f '${targetRel}' && git ls-files --error-unmatch '${targetRel}' >/dev/null 2>&1 || rm -f '${targetRel}'`, { cwd: PANGU_ROOT });
      r = sh(`git merge --no-ff --allow-unrelated-histories -m "auto-repair merge: ${(diag.root_cause || '').slice(0, 60)}" ${wtBranch}`, { cwd: PANGU_ROOT });
      if (r.code === 0) {
        result.ok = true;
        result.merged = true;
        log('✅ patch merged');
      } else {
        result.reason = 'merge 失败: ' + r.stderr;
        log('⚠ merge 失败, rollback worktree');
      }
    } else {
      result.reason = 'commit 失败: ' + r.stderr;
    }
  } else {
    result.reason = `test 失败或 confidence 低 (testOk=${testOk}, conf=${diag.confidence})`;
    log('⚠ ' + result.reason);
  }

  // 6. cleanup worktree (无论成功失败)
  sh(`git worktree remove --force '${wtPath}'`);

  // 7. restart Pangu if stopped
  if (stopped) {
    log('🚀 重启 Pangu');
    sh(START_PANGU);
  }

  return result;
}

function sleep(ms) {
  spawnSync('sleep', [String(ms / 1000)]);
}

// ========== Process one pending ==========
async function processOne(pending, opts = {}) {
  log('━━━ 处理 pending: ' + pending.id + ' ━━━');
  log('  signal: ' + pending.signal);
  log('  severity: ' + pending.severity);
  log('  summary: ' + pending.summary);

  // 第 100 批: 问模型之前先问「这信号模型修得了吗?」
  // 统计型信号 (失败率) 修不了 ⇒ 不发请求 (旧版每次白烧本地 GPU 十几分钟)。
  const _decision = _decideSkip(pending);
  if (_decision.skip) {
    log('⏭ 跳过 (不调用模型): ' + _decision.why);
    const id = writeResult('skipped', {
      reason: 'not-repairable',
      detail: _decision.why,
      signal: pending.signal,
      pendingId: pending.id,
    });
    rmPending(pending.file);
    return { skipped: true, id, reason: 'not-repairable' };
  }

  // 第 100 批: 熔断 —— 同一类信号连续修不了 ⇒ 冷却期内不再问模型。
  const _cls = _signalClass(pending.signal);
  const _breaker = _readBreaker();
  if (_breakerCoolingDown(_breaker, _cls)) {
    const until = _breaker[_cls].cooldownUntil;
    log('🔌 熔断中 (类=' + _cls + ', 冷却到 ' + new Date(until).toISOString() + '), 不调用模型');
    const id = writeResult('skipped', {
      reason: 'breaker-cooldown',
      signalClass: _cls,
      cooldownUntil: until,
      pendingId: pending.id,
    });
    rmPending(pending.file);
    return { skipped: true, id, reason: 'breaker-cooldown' };
  }

  // rate limit
  const todayCount = getRate();
  if (todayCount >= MAX_PER_DAY) {
    log('⏸ rate limit hit (今日已 ' + todayCount + ' patches), 跳过');
    const id = writeResult('skipped', {
      reason: 'rate-limit',
      pendingId: pending.id,
      todayCount,
    });
    rmPending(pending.file);
    return { skipped: true, id };
  }

  // dry-run: 只 diagnose
  if (opts.dryRun) {
    const diag = await diagnose(pending);
    log('🔍 dry-run diagnose: ' + JSON.stringify(diag, null, 2));
    return { dryRun: true, diag };
  }

  // diagnose
  const diag = await diagnose(pending);
  if (diag.confidence < 0.6) {
    log('⚠ confidence < 0.6, 跳过 (人工 review)');
    // 第 100 批: 连续修不了就进冷却 (模型反复修不了的信号, 无限重试只是无限烧 GPU)
    const st = _breakerRecord(_readBreaker(), _cls, false);
    _writeBreaker(st);
    if (st[_cls] && st[_cls].cooldownUntil > Date.now()) {
      log('🔌 熔断已触发 (类=' + _cls + ', 连续失败 ' + st[_cls].consecutiveFails + ' 次, 冷却 24h)');
    }
    const id = writeResult('failed', {
      reason: 'low-confidence',
      confidence: diag.confidence,
      reasoning: diag.reasoning,
      pendingId: pending.id,
    });
    rmPending(pending.file);
    return { failed: true, id, reason: 'low-confidence' };
  }

  // apply
  const result = await applyPatch(diag);

  if (result.ok) {
    incRate();
    _writeBreaker(_breakerRecord(_readBreaker(), _cls, true));
    const id = writeResult('done', {
      success: true,
      pendingId: pending.id,
      diag: { root_cause: diag.root_cause, confidence: diag.confidence },
      merged: result.merged,
      branch: result.branch,
    });
    rmPending(pending.file);
    return { success: true, id };
  } else {
    const id = writeResult('failed', {
      success: false,
      pendingId: pending.id,
      diag: { root_cause: diag.root_cause, confidence: diag.confidence },
      reason: result.reason,
      patchBackup: fs.existsSync('/tmp/pangu-repair-last.patch') ? '/tmp/pangu-repair-last.patch' : null,
      testOutput: result.testOutput,
    });
    rmPending(pending.file);
    return { failed: true, id, reason: result.reason };
  }
}

// ========== Test mode ==========
async function testMode() {
  log('=== TEST 模式: 制造 1 个真 bug + 触发修复 ===');
  // 1. 故意在 wuxing_map.js 加一个 typo
  const target = path.join(PANGU_ROOT, 'apps', 'core', 'config', 'wuxing_map.js');
  if (!fs.existsSync(target)) {
    log('⚠ wuxing_map.js 不存在, 跳过 test');
    return;
  }
  // 不真改源码, 改 sandbox test 文件
  const testFile = path.join(PANGU_ROOT, '.test-repair-sandbox.js');
  fs.writeFileSync(testFile, '// sandbox for repair test\nconst x = BROKEN_CONSTANT;\n');
  fs.writeFileSync(path.join(REPAIR_DIR, 'pending-test-repair.json'), JSON.stringify({
    id: 'pending-test-repair',
    ts: Date.now(),
    signal: 'pangu-error:TypeError',
    severity: 'critical',
    summary: 'TEST: sandbox error',
    evidence: { logLine: 'TypeError: BROKEN_CONSTANT is not defined', files: [testFile] },
    status: 'pending',
  }, null, 2));
  log('✅ 制造 1 个 pending + sandbox 文件, 等下次自动跑');
}

// ========== 主流程 ==========
// 第 100 批: 清理老的**结果产物**。
// 实测: 空转那阵子堆了 4775 个 failed-*.json (19MB) —— 每次都写, 从来没人看。
// 失败**产物**不是账本 (账本在 incidents.jsonl / repairs.jsonl), 留 7 天够了。
//
// ⚠️ skipped-*.json 也要清: 跳过的 pending 每次写一条结果产物, 而看门狗每 5 分钟
// 就产一个 l1-fail 信号 ⇒ 一天 288 条 skipped 产物。不清的话一年 20MB 纯垃圾。
const RESULT_ARTIFACT_RE = /^(failed|skipped)-.*\.json$/;

function cleanupOldResults(days = FAILED_KEEP_DAYS, now = Date.now(), dir = REPAIR_DIR) {
  let removed = 0;
  try {
    for (const f of fs.readdirSync(dir)) {
      if (!RESULT_ARTIFACT_RE.test(f)) continue;
      const fp = path.join(dir, f);
      let st; try { st = fs.statSync(fp); } catch (_) { continue; }
      if (now - st.mtimeMs > days * 24 * 3600 * 1000) {
        try { fs.unlinkSync(fp); removed++; } catch (_) {}
      }
    }
  } catch (_) {}
  return removed;
}

async function main() {
  const args = process.argv.slice(2);
  if (args.includes('--test')) { await testMode(); return; }
  const dryRun = args.includes('--dry-run');
  const oneOnly = args.includes('--one');

  log('=== Pangu 修复执行器启动 (dryRun=' + dryRun + ', one=' + oneOnly + ') ===');
  ensureDir(REPAIR_DIR);
  ensureDir(LOG_DIR);
  const _cleaned = cleanupOldResults();
  if (_cleaned) log('🧹 清理过期失败产物: ' + _cleaned + ' 个');

  const pending = readPending();
  log('📋 待处理 pending: ' + pending.length);

  if (pending.length === 0) {
    log('✨ 无 pending, 收工');
    return;
  }

  const toProcess = oneOnly ? pending.slice(0, 1) : pending;
  let successCount = 0, failCount = 0;

  for (const p of toProcess) {
    try {
      const r = await processOne(p, { dryRun });
      if (r.success) successCount++;
      else if (r.failed) failCount++;
    } catch (e) {
      log('💥 处理 ' + p.id + ' 异常: ' + e.message + '\n' + e.stack);
      failCount++;
    }
  }

  log('=== 完成 — success=' + successCount + ', failed=' + failCount + ' ===');
}

// 第 100 批: 抽出纯函数给单测用 (之前这个文件只能当 CLI 跑, 没法测)。
module.exports = {
  _classifyEvidence,
  _decideSkip,
  _signalClass,
  _buildSourceContext,
  _readBreaker,
  _writeBreaker,
  _breakerCoolingDown,
  _breakerRecord,
  cleanupOldResults,
  LOG_LIKE_EXT,
  SOURCE_CONTEXT_MAX_BYTES,
  BREAKER_FAIL_THRESHOLD,
  BREAKER_COOLDOWN_MS,
  REPAIR_DIR,
};

if (require.main === module) {
  main().catch(e => {
    log('💥 顶层异常: ' + e.message + '\n' + e.stack);
    process.exit(1);
  });
}
