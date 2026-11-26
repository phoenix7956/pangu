#!/usr/bin/env node
/**
 * Pangu L2 矿工 v2 — 累积式记忆 + 30天历史滚动 (2026-07-10 老板拍)
 *
 * 设计哲学:
 *   - 历史 (sessions/) = 原始对话, 30天滚动(30天后自动archive清理)
 *   - 记忆 (memory.md) = **累积总结**, 一天一更新, 不分日期分文件
 *   - 当 history 总结 > 30 天 时, 自动抽空白到 archive/
 *
 * 文件结构:
 *   memory/
 *     memory.md         ← 累积记忆(主文件, 老板的根)
 *     memory/{YYYY-MM-DD}.md  ← 当日被消耗的总结(增量更新到 memory.md 后保留1天用于查证)
 *     sessions/{YYYY-MM-DD}.md  ← 历史对话(30天滚动)
 *     archive/sessions-{YYYY-MM-DD}.md  ← 历史归档(> 30天的)
 *
 * 用法:
 *   node l2-miner.js              # 处理今天 (本地时间)
 *   node l2-miner.js 2026-07-06   # 处理指定日期
 *   node l2-miner.js --force      # 强制重跑
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const https = require('https');
const crypto = require('crypto');
const sqlite3 = require('better-sqlite3');

const MEM_ROOT = path.join(os.homedir(), '.pangu', 'memory');
const SESS_DIR = path.join(MEM_ROOT, 'memory', 'sessions');
const ARCHIVE_DIR = path.join(MEM_ROOT, 'memory', 'archive');
const LEARN_DIR = path.join(MEM_ROOT, 'memory');        // 学习日项
const MAIN_MEMORY = path.join(MEM_ROOT, 'memory.md');    // 累积记忆

const DB_PATH = path.join(MEM_ROOT, 'main.sqlite');
const RETENTION_DAYS = 30;

// ========== LLM 调用 ==========
// 2026-07-17 §老板拍: 宽松 api_key 探测 — 找不到时静默返回 null 而非抛错
function loadCfg() {
  // 节点配置路径 —— 不写死任何人的机器名 (2026-10-26 第 109 批)。
  //   解析规则见 config/node_config.js。
  const cfgPaths = [
    require('../config/node_config').resolveNodeConfigPathOrEmpty(),
    path.join(MEM_ROOT, 'config.json'),
  ].filter(Boolean);
  // 2026-10-26 (第 110 批): 真 key 判断走**统一解析链** (modules/api_key_resolver)。
  //   原来这里自己抄了一份 (明文 / env: 前缀 / api_key_source / openai_api_key /
  //   api_key_credential / provider 约定名) —— 第三套顺序, 跟主链和探针链都不同,
  //   于是同一个模型在后台任务里能不能用 key, 跟前台探针给的结论能不一样。
  const { resolveApiKey } = require('../modules/api_key_resolver');
  const hasRealKey = (m) => !!(m && resolveApiKey(m));
  for (const p of cfgPaths) {
    try {
      const cfg = JSON.parse(fs.readFileSync(p, 'utf8'));
      const models = (cfg.llm && cfg.llm.models) || [];
      // 2026-07-18 修: 跳过 api_key=*** 的占位 model, 优先有真 key 的 enabled model
      const withKey = models.filter(m => hasRealKey(m));
      // 2026-09-16 老板拍: 后台任务跟盘古 current_model_id 走, 不写死 minimax-m3 —
      // 老板切默认模型时后台自动跟上, 不出现"前台 A 模型 / 后台 B 模型"的分裂烧钱
      const _curId = cfg.llm && cfg.llm.current_model_id;
      const m = (withKey.find(x => x.id === _curId)
             || withKey.find(x => x.id === 'minimax-m3' || x.id === 'MiniMax-M3'))
             || withKey.find(x => x.enabled === true && !(x.endpoint || '').includes('127.0.0.1') && !(x.endpoint || '').includes('localhost'))
             || withKey.find(x => x.enabled === true)
             || withKey.find(x => x.default === true)
             || withKey[0]
             // fallback: 都没真 key 时退回旧逻辑 (即使 ***)
             || models.find(x => x.enabled === true)
             || models.find(x => x.default === true)
             || models[0];
      if (!m) continue;
      // 2026-10-26 (第 110 批): 取 key 只走统一解析链 (原来这里是第三套顺序)
      const apiKey = resolveApiKey(m) || '';
      if (apiKey) {
        // 字段名带 _resolved 前缀 ⇒ 一眼看出「这是解析出来的」,
        //   不会跟「配置里的 api_key 字段」混为一谈 (守卫判的就是这个区别)。
        return { model: { ...m, _resolvedApiKey: apiKey }, llm: cfg.llm };
      }
    } catch (_) {}
  }
  // 不再抛错，返回 null 让调用方优雅降级
  return null;
}

function callLLM(cfg, systemPrompt, userContent) {
  const m = cfg.model;
  const protocol = (m.protocol || 'anthropic').toLowerCase();
  const url = new URL(m.endpoint || 'https://api.minimaxi.com/anthropic/v1/messages');

  // 2026-07-18: 按 protocol 分派 (openai / anthropic)
  let body, headers;
  if (protocol === 'openai') {
    body = JSON.stringify({
      model: m.name || m.endpoint_id || 'MiniMax-M3',
      max_tokens: 2048,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
    });
    headers = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${m._resolvedApiKey}`,
      'Content-Length': Buffer.byteLength(body),
    };
  } else {
    // anthropic
    body = JSON.stringify({
      model: m.endpoint_id || 'MiniMax-M3',
      max_tokens: 2048,
      system: systemPrompt,
      messages: [{ role: 'user', content: userContent }],
    });
    headers = {
      'Content-Type': 'application/json',
      'x-api-key': m._resolvedApiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body),
    };
  }

  return new Promise((resolve, reject) => {
    const req = https.request({
      hostname: url.hostname, port: 443, path: url.pathname + (url.search || ''), method: 'POST',
      headers,
      timeout: 60000,
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const d = JSON.parse(data);
          // openai 响应: choices[0].message.content
          if (d.choices && d.choices[0] && d.choices[0].message && d.choices[0].message.content) {
            // 2026-08-02 修: reasoning 模型 (doubao-seed/deepseek) content 夹 <think> 块,
            // 直接写进 MEMORY.md 会污染记忆 (今日实炸: 23.6KB 记忆被 think 泄漏版覆盖)
            let _c = d.choices[0].message.content;
            _c = _c.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
            return resolve(_c);
          }
          // anthropic 响应: content[0].text
          if (d.content && d.content[0] && d.content[0].text) {
            return resolve(d.content[0].text);
          }
          if (d.error) return reject(new Error(JSON.stringify(d.error)));
          reject(new Error('空响应: ' + data.slice(0, 300)));
        } catch (e) { reject(new Error('JSON 解析失败: ' + e.message + ' raw=' + data.slice(0, 200))); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('timeout 60s')));
    req.write(body);
    req.end();
  });
}

// ========== 累积记忆 ==========
function readMainMemory() {
  if (!fs.existsSync(MAIN_MEMORY)) return '';
  return fs.readFileSync(MAIN_MEMORY, 'utf8');
}

function writeMainMemory(content) {
  // 2026-08-02: 覆盖前备份 (LLM 合并有把 23KB 写成 6KB 的前科, 留快照可回滚)
  try {
    if (fs.existsSync(MAIN_MEMORY)) {
      const _bakName = MAIN_MEMORY + '.bak.' + new Date().toISOString().slice(0, 10).replace(/-/g, '');
      fs.copyFileSync(MAIN_MEMORY, _bakName);
    }
  } catch (_) {}
  // 防御: 新内容比旧内容短 60%+ 且旧内容 >10KB → 大概率 LLM 乱合并, 拒绝覆盖
  try {
    if (fs.existsSync(MAIN_MEMORY)) {
      const _oldLen = fs.statSync(MAIN_MEMORY).size;
      if (_oldLen > 10240 && content.length < _oldLen * 0.4) {
        console.error('[L2-miner] 拒绝覆盖: 新记忆 ' + content.length + 'B < 旧记忆 ' + _oldLen + 'B 的 40%, 疑似 LLM 乱合并, 已保留旧版 (.bak 快照仍在)');
      } else {
        fs.writeFileSync(MAIN_MEMORY, content, 'utf8');
      }
    } else {
      fs.writeFileSync(MAIN_MEMORY, content, 'utf8');
    }
  } catch (_) { fs.writeFileSync(MAIN_MEMORY, content, 'utf8'); }
  console.log('[L2-miner] updated', MAIN_MEMORY);
}

function readSessions(date) {
  const fp = path.join(SESS_DIR, date + '.md');
  if (!fs.existsSync(fp)) return '';
  return fs.readFileSync(fp, 'utf8');
}

// ========== L1 → L2 聚合 (Phase 3 §R131, 8/12 老板拍) ==========
// 读 ~/.pangu/evolution/{date}.jsonl → 聚合 → 写 ~/.pangu/evolution/l2/{date}.json
// 输出格式: { total_sessions, success_rate, tool_error_rate, model_success_rate, common_failures, recommendation }
// 2026-08-24 老板拍 (A: L2 cron 矿工): + 人读版《进化建议报告》 reports/{date}.md
// 2026-10-26 第 100 批: 目录走唯一真源 (modules/evolution_paths.js)。
// 原来这里自己造了个 PANGU_EVOLUTION_DIR 开关 —— 全仓第四个名字, 跟写方
// (evolution_record.js) 认的不是同一个 ⇒ 写进 A 目录、却从 B 目录读。
// 现在统一到 PANGU_EVO_DIR (旧名 PANGU_EVOLUTION_DIR 在 evolution_paths 里留兼容)。
// ⚠️ 必须是**函数**而不是模块顶层常量: 解析要在调用时做 (测试常在 require 之后才设 env)。
const { evolutionDir, evolutionL2Dir } = require('../modules/evolution_paths');
const EVO_DIR = () => evolutionDir();
const L2_DIR = () => evolutionL2Dir();
const REPORTS_DIR = () => path.join(evolutionDir(), 'reports');

// 人读版修复建议报告 — 纯数据渲染, 不调 LLM (gemma 摘要崩坏 'Summary: Summary:' 前科, 报告必须确定性)
function writeEvolutionReport(l2) {
  if (!l2) return null;
  try {
    if (!fs.existsSync(REPORTS_DIR())) fs.mkdirSync(REPORTS_DIR(), { recursive: true });
    const L = [];
    L.push('# Pangu 进化建议报告 (' + l2.date + ')');
    L.push('');
    L.push('> 生成时间: ' + l2.generated_at + ' · 数据源: evolution/' + l2.date + '.jsonl · 只建议, 不改码');
    L.push('');
    L.push('## 总览');
    L.push('- 请求总数: ' + l2.total_sessions);
    L.push('- 整体成功率: ' + (l2.success_rate * 100).toFixed(1) + '%');
    L.push('');
    const toolRows = Object.entries(l2.tool_counts || {})
      .filter(([t, c]) => c >= 5)
      .sort((a, b) => ((l2.tool_error_rate || {})[b[0]] || 0) - ((l2.tool_error_rate || {})[a[0]] || 0));
    L.push('## 工具失败率 (调用 ≥5 次)');
    if (toolRows.length === 0) L.push('- (今日无高频工具调用)');
    else {
      L.push('| 工具 | 调用次数 | 失败率 |');
      L.push('| --- | ---: | ---: |');
      for (const [t, c] of toolRows) {
        L.push('| ' + t + ' | ' + c + ' | ' + (((l2.tool_error_rate || {})[t] || 0) * 100).toFixed(0) + '% |');
      }
    }
    L.push('');
    const modelRows = Object.entries(l2.model_counts || {})
      .filter(([m, c]) => c >= 3)
      .sort((a, b) => ((l2.model_success_rate || {})[a[0]] || 0) - ((l2.model_success_rate || {})[b[0]] || 0));
    L.push('## 模型成功率 (调用 ≥3 次)');
    if (modelRows.length === 0) L.push('- (今日无高频模型调用)');
    else {
      L.push('| 模型 | 调用次数 | 成功率 |');
      L.push('| --- | ---: | ---: |');
      for (const [m, c] of modelRows) {
        L.push('| ' + m + ' | ' + c + ' | ' + (((l2.model_success_rate || {})[m] || 0) * 100).toFixed(0) + '% |');
      }
    }
    L.push('');
    L.push('## 高频错误 Top5');
    if (!l2.common_failures || l2.common_failures.length === 0) L.push('- (无)');
    else for (const f of l2.common_failures) L.push('- ' + f);
    L.push('');
    L.push('## 修复建议 (只建议, 不改码 — 老板拍板后才动手)');
    if (!l2.recommendations || l2.recommendations.length === 0) L.push('- 今日无异常, 无建议 ✓');
    else l2.recommendations.forEach((r, i) => L.push((i + 1) + '. ' + r));
    L.push('');
    const outFile = path.join(REPORTS_DIR(), l2.date + '.md');
    fs.writeFileSync(outFile, L.join('\n'), 'utf8');
    console.log('[L2-miner] ✅ 建议报告:', outFile);
    return outFile;
  } catch (e) {
    console.error('[L2-miner] 写建议报告失败:', e.message);
    return null;
  }
}

function aggregateL1(date) {
  // L1 实际位置: ~/.pangu/evolution/ (不放在 memory/ 下)
  const L1_FILE = path.join(EVO_DIR(), date + '.jsonl');
  if (!fs.existsSync(L1_FILE)) {
    console.log('[L2-miner] L1 jsonl 不存在:', L1_FILE, ', 跳过聚合');
    return null;
  }
  let lines;
  try {
    lines = fs.readFileSync(L1_FILE, 'utf8').trim().split('\n').filter(Boolean);
  } catch (e) {
    console.error('[L2-miner] 读 L1 失败:', e.message);
    return null;
  }
  if (lines.length === 0) {
    console.log('[L2-miner] L1 空文件, 跳过聚合');
    return null;
  }
  const total = lines.length;
  let successCount = 0;
  const toolCount = {};       // tool name -> 调用次数
  const toolFail = {};        // tool name -> 失败次数
  const modelCount = {};      // model -> 调用次数
  const modelSuccess = {};    // model -> 成功次数
  const errorPatterns = {};   // error type -> 次数 (top 5)
  for (const line of lines) {
    let rec;
    try { rec = JSON.parse(line); } catch (_) { continue; }
    const ok = rec.effective_success === true || (rec.effective_success == null && rec.success === true);
    if (ok) successCount++;
    const model = rec.model || 'unknown';
    modelCount[model] = (modelCount[model] || 0) + 1;
    if (ok) modelSuccess[model] = (modelSuccess[model] || 0) + 1;
    for (const t of (rec.tool_names || [])) {
      toolCount[t] = (toolCount[t] || 0) + 1;
      if (!ok) toolFail[t] = (toolFail[t] || 0) + 1;
    }
    if (rec.error) {
      // 简化 error 模式 (前 50 字符)
      const errKey = String(rec.error).slice(0, 50).replace(/[^a-zA-Z0-9_ ]/g, '_');
      errorPatterns[errKey] = (errorPatterns[errKey] || 0) + 1;
    }
  }
  // 计算 ratio
  const toolErrorRate = {};
  for (const t in toolCount) {
    toolErrorRate[t] = toolCount[t] > 0 ? (toolFail[t] || 0) / toolCount[t] : 0;
  }
  const modelSuccessRate = {};
  for (const m in modelCount) {
    modelSuccessRate[m] = modelCount[m] > 0 ? (modelSuccess[m] || 0) / modelCount[m] : 0;
  }
  // top 5 error patterns
  const topErrors = Object.entries(errorPatterns).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} (${v})`);
  // recommendation (Phase 3 §R131-3.2 hint 生成用)
  const recommendations = [];
  // 高频 tool 失败率 > 10% 报警
  for (const t in toolErrorRate) {
    if (toolCount[t] >= 5 && toolErrorRate[t] > 0.1) {
      recommendations.push(`${t} 失败率 ${(toolErrorRate[t] * 100).toFixed(0)}%, 谨慎或换方案`);
    }
  }
  // 低成功率 model 报警
  for (const m in modelSuccessRate) {
    if (modelCount[m] >= 3 && modelSuccessRate[m] < 0.7) {
      recommendations.push(`${m} 成功率仅 ${(modelSuccessRate[m] * 100).toFixed(0)}%, 需人工 review`);
    }
  }
  const l2 = {
    date,
    total_sessions: total,
    success_rate: total > 0 ? successCount / total : 0,
    tool_error_rate: toolErrorRate,
    tool_counts: toolCount,
    model_success_rate: modelSuccessRate,
    model_counts: modelCount,
    common_failures: topErrors,
    recommendations,
    generated_at: new Date().toISOString(),
  };
  // 写 L2 (放 ~/.pangu/evolution/l2/)
  try {
    if (!fs.existsSync(L2_DIR())) fs.mkdirSync(L2_DIR(), { recursive: true });
    const outFile = path.join(L2_DIR(), date + '.json');
    fs.writeFileSync(outFile, JSON.stringify(l2, null, 2));
    console.log('[L2-miner] ✅ L2 聚合:', outFile);
    console.log('[L2-miner]   total=' + total + ', success=' + (l2.success_rate * 100).toFixed(1) + '%');
    if (recommendations.length > 0) {
      console.log('[L2-miner]   recommendations:');
      for (const r of recommendations) console.log('[L2-miner]     - ' + r);
    }
    writeEvolutionReport(l2);
    return l2;
  } catch (e) {
    console.error('[L2-miner] 写 L2 失败:', e.message);
    return null;
  }
}

// 读取 L2 当日聚合 (single source of truth, 3 路径共用: llm_caller/j2_agent_loop native+legacy)
// 按天缓存 (1 读盘 / 天, 避免每 chat 重读 JSON)
let _l2HintCache = { date: '', hint: '' };
function getL2Hint(date) {
  date = date || new Date().toISOString().slice(0, 10);
  if (_l2HintCache.date === date) return _l2HintCache.hint;
  const L2_FILE = path.join(L2_DIR(), date + '.json');
  let hint = '';
  if (fs.existsSync(L2_FILE)) {
    try {
      const l2 = JSON.parse(fs.readFileSync(L2_FILE, 'utf8'));
      const hints = [];
      for (const t in (l2.tool_error_rate || {})) {
        if ((l2.tool_counts || {})[t] >= 5 && l2.tool_error_rate[t] > 0.1) {
          hints.push(`[!!! L2 警告] ${t} 调用 ${l2.tool_counts[t]} 次失败率 ${(l2.tool_error_rate[t] * 100).toFixed(0)}%, 谨慎使用或考虑替代方案`);
        }
      }
      for (const m in (l2.model_success_rate || {})) {
        if ((l2.model_counts || {})[m] >= 3 && l2.model_success_rate[m] < 0.7) {
          hints.push(`[!!! L2 警告] ${m} 今日成功率仅 ${(l2.model_success_rate[m] * 100).toFixed(0)}% (${l2.model_counts[m]} 调用), 需谨慎决策`);
        }
      }
      hint = hints.join('\n');
    } catch (e) {}
  }
  _l2HintCache = { date, hint };
  return hint;
}

// 导出给 j2_agent_loop.js (require 时直接拿 hint)
module.exports.getL2Hint = getL2Hint;
module.exports.aggregateL1 = aggregateL1;
module.exports.writeEvolutionReport = writeEvolutionReport;

// 增量更新累积记忆 (用 LLM 总结今日,合并到主 memory.md)
async function updateAccumulatedMemory(date, todaySessions, forceMerge = false) {
  const existing = readMainMemory();
  console.log('[L2-miner] 当前累积记忆:', existing.length, '字符');

  const cfg = loadCfg();
  const summary = await callLLM(cfg,
    `你是 Pangu L2 矿工。Pangu 已有累积记忆文件,你需要处理今日的对话增量。
任务:
1. 读现有累积记忆的“重要关键词/重要决策/重要偏好/警觉信号"部分
2. 从今日对话提炼增量要点
3. 返回**合并后的完整记忆**(不是增量,是合并后的完整状态)
4. 删除已完全内化、不再需要保留的已实现项
5. 限制 1500 字以内

格式 (markdown):
# 盘古累积记忆 (最后更新: YYYY-MM-DD)

## 上次总结以来(今日新增)
- 新决策 ...
- 新偏好 ...
- 新洞察 ...
- 警觉信号 ...

## 累计重要决策 (按主题跨日期)
- ...

## 累计重要偏好 (只保留仍未变动的)
- ...

## 累计重要洞察 (只保留仍未变动的)
- ...

## 已实现项 (不再重复)
- ...

## 老请求/老待办 (未做的,按时间顺序)
- ...`,
    `现有累积记忆:
\`\`\`
${existing || '(空, 首次建立)'}
\`\`\`

今日 (${date}) 对话历史:
\`\`\`
${todaySessions.slice(0, 50000)}
\`\`\`

请生成合并后的累积记忆。`
  );

  const header = [
    `# 盘古累积记忆 (最后更新: ${date})`,
    ``,
    `> 自动增量更新 — 累积过去 ${countDays(existing)} 天要点`,
    `> 数据源: 今日 sessions/${date}.md + ${existing.length > 0 ? '历史 memory.md' : '(首次建立)'}`,
    ``,
  ].join('\n');
  const fullContent = header + summary + '\n';
  writeMainMemory(fullContent);
  // reindex
  reindexFile(MAIN_MEMORY);
  return fullContent;
}

function countDays(existingMemory) {
  if (!existingMemory) return 0;
  const m = existingMemory.match(/最后更新: (\d{4}-\d{2}-\d{2})/);
  if (!m) return 0;
  const last = new Date(m[1]).getTime();
  const now = Date.now();
  return Math.floor((now - last) / 86400000);
}

// ========== 30天历史滚动 ==========
function rotateOldSessions() {
  if (!fs.existsSync(SESS_DIR)) return;
  if (!fs.existsSync(ARCHIVE_DIR)) fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const now = Date.now();
  const cutoff = now - RETENTION_DAYS * 86400000;
  const files = fs.readdirSync(SESS_DIR).filter(f => /^\d{4}-\d{2}-\d{2}\.md$/.test(f));
  let rotated = 0;
  for (const f of files) {
    const dateStr = f.replace('.md', '');
    const fileTime = new Date(dateStr).getTime();
    if (fileTime < cutoff) {
      const oldPath = path.join(SESS_DIR, f);
      const newPath = path.join(ARCHIVE_DIR, f);
      fs.renameSync(oldPath, newPath);
      console.log('[L2-miner] rotated 30+ day:', f);
      rotated++;
    }
  }
  if (rotated === 0) console.log('[L2-miner] 无 30+ 天历史需要清理');
  return rotated;
}

// ========== FTS 增量 ==========
function reindexFile(filePath) {
  const relPath = path.relative(MEM_ROOT, filePath);
  const content = fs.readFileSync(filePath, 'utf8');
  const stat = fs.statSync(filePath);
  const fileHash = crypto.createHash('sha256').update(content).digest('hex').slice(0, 16);
  const db = sqlite3(DB_PATH);
  // 2026-07-17 §老板拍: schema 缺失修复 — 必须在任何 DELETE/INSERT 之前建表
  db.exec(`
    CREATE TABLE IF NOT EXISTS files (
      path TEXT PRIMARY KEY,
      source TEXT,
      hash TEXT,
      mtime INTEGER,
      size INTEGER
    );
    CREATE TABLE IF NOT EXISTS chunks (
      id TEXT PRIMARY KEY,
      path TEXT,
      source TEXT,
      start_line INTEGER,
      end_line INTEGER,
      hash TEXT,
      model TEXT,
      text TEXT,
      embedding TEXT,
      updated_at INTEGER
    );
    CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
      text, id UNINDEXED, path UNINDEXED, source UNINDEXED, model UNINDEXED,
      start_line UNINDEXED, end_line UNINDEXED,
      content='chunks', content_rowid='rowid'
    );
  `);
  // 2026-10-30 (第 173 批): chunks_fts 是外部内容表 (content='chunks'),
  //   直接 DELETE FROM chunks **不会**清掉 FTS 索引里的条目 ⇒ 每跑一次
  //   reindexFile 就留一批指向已删 rowid 的孤儿条目 (实测 2026-10-30:
  //   索引 doc 总数 78679, 其中孤儿 77223 ⇒ 98% 是死条目)。
  //
  // ⚠ 顺序是这件事的全部关键 (2026-10-30 当场踩到, 第一次修还修错了):
  //   外部内容表**查询时读的是内容表**, 不是索引。所以
  //   "先 DELETE FROM chunks 再去清 chunks_fts" 永远清不掉 ——
  //   那时内容行已经没了, FTS 侧读到的就是 0 行。
  //   实测 (沙箱副本): 头一版修法把 SELECT 放在 DELETE 之后,
  //   重索引 3 个文件后孤儿从 127 涨到 255, 正好 +128
  //   (= 这 3 个文件刚插进去的 chunk 数) ⇒ 一个都没清掉。
  //   ⇒ 正确顺序跟 modules/memory_helpers.js (R39 那次的教训) 一致:
  //   **先**删 chunks_fts 里该 path 的行 (内容行还在, FTS 读得到值),
  //   **再**删 chunks 的内容行。
  //
  // 另注: 查孤儿必须用 fts5vocab(chunks_fts,'instance') 读索引。
  //   直接 count(*) FROM chunks_fts 读的是内容表, 被删的行自然消失 ⇒ 永远看到 0。
  db.prepare('DELETE FROM chunks_fts WHERE rowid IN (SELECT rowid FROM chunks WHERE path = ?)').run(relPath);
  db.prepare('DELETE FROM chunks WHERE path = ?').run(relPath);
  db.prepare('DELETE FROM files WHERE path = ?').run(relPath);
  db.prepare('INSERT INTO files (path, source, hash, mtime, size) VALUES (?, ?, ?, ?, ?)').run(
    relPath, 'memory', fileHash, Math.floor(stat.mtimeMs), stat.size);
  const insertChunk = db.prepare('INSERT INTO chunks (id, path, source, start_line, end_line, hash, model, text, embedding, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
  const insertFts = db.prepare('INSERT INTO chunks_fts (text, id, path, source, model, start_line, end_line) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const lines = content.split('\n');
  const CHUNK_SIZE = 40;
  for (let i = 0; i < lines.length; i += CHUNK_SIZE) {
    const start = i + 1;
    const end = Math.min(i + CHUNK_SIZE, lines.length);
    const text = lines.slice(i, end).join('\n');
    if (!text.trim()) continue;
    const chunkId = fileHash + '_' + start + '_' + end;
    const chunkHash = crypto.createHash('sha256').update(text).digest('hex').slice(0, 16);
    insertChunk.run(chunkId, relPath, 'memory', start, end, chunkHash, 'sha256-text', text, '[]', Date.now());
    insertFts.run(text, chunkId, relPath, 'memory', 'sha256-text', start, end);
  }
  db.close();
  console.log('[L2-miner] reindexed', relPath);
}

// ========== 主流程 ==========
async function main() {
  const args = process.argv.slice(2);
  const force = args.includes('--force');
  const date = args.find(a => /^\d{4}-\d{2}-\d{2}$/.test(a)) || new Date().toISOString().slice(0, 10);
  console.log('[L2-miner] 日期:', date);
  console.log('[L2-miner] 模式: 累积记忆 + 30天滚动');

  // 0. 检查 LLM 配置
  const cfg = loadCfg();
  if (!cfg) {
    console.log('[L2-miner] ⚠ 无可用 LLM 配置，跳过 LLM 总结，仅做数据清理');
    // 仍然跑数据清理
    console.log('\n[L2-miner] === 阶段 1: 30 天历史滚动 ===');
    rotateOldSessions();
    // 2026-08-12 §R131-Phase3: 即使无 LLM 也跑 L1 聚合 (给 L3 hint 用)
    console.log('\n[L2-miner] === 阶段 1.5: L1 聚合 → L2 (Phase 3) ===');
    aggregateL1(date);
    console.log('[L2-miner] 完成（无 LLM，仅清理 + L1 聚合）');
    return;
  }

  // 1. 先跑 30 天滚动清理 (不动 memory)
  console.log('\n[L2-miner] === 阶段 1: 30 天历史滚动 ===');
  rotateOldSessions();

  // 1.5. L1 聚合 → L2 (Phase 3, 老板 8/12 拍: 不需 LLM 也能跑)
  console.log('\n[L2-miner] === 阶段 1.5: L1 聚合 → L2 (Phase 3) ===');
  aggregateL1(date);

  // 2. 读今日 sessions
  console.log('\n[L2-miner] === 阶段 2: 处理今日会话 ===');
  const sessions = readSessions(date);
  if (!sessions.trim()) {
    console.log('[L2-miner] 今日无对话历史, 跳过 LLM 总结');
    console.log('[L2-miner] 完成 ✓');
    return;
  }
  console.log('[L2-miner] sessions 长度:', sessions.length, '字符');

  // 3. 增量更新累积记忆 (不单独起 1 个 learning/{date}.md)
  console.log('\n[L2-miner] === 阶段 3: 增量合并到累积记忆 ===');
  await updateAccumulatedMemory(date, sessions, force);

  console.log('\n[L2-miner] 完成 ✓');
}

// 2026-08-24: require.main 门 — 被测试/其他模块 require 时不跑 main() (老代码无条件跑, 单测没法隔离)
if (require.main === module) {
  main().catch(e => {
    console.error('[L2-miner] 失败:', e.message);
    // L2 是后台记忆整理任务；LLM 配额、DNS 或上游空响应不应阻断
    // 下次定时运行，也不应把 launchd 标成持续失败。错误已完整写入 stderr。
    process.exit(0);
  });
}
