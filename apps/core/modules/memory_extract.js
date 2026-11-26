/**
 * modules/memory_extract.js
 * Session Memory 自动提取 — Forked 子进程
 * 由 server.js 在阈值触发时 fork，不阻塞主流程
 *
 * 用法：node memory_extract.js [sessionFilePath]
 * 若传入 sessionFilePath（由 server.js 写入），直接读取之
 * 否则回退到扫描 data/memory/user/ 目录
 *
 * 阈值（Claude Code 对齐）：
 * - token 增量 > 1000
 * - tool_calls >= 10
 * - 时间间隔 > 30s
 */

'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data', 'memory');
const USER_DIR = path.join(DATA_DIR, 'user');

// 命令行参数：可选的会话文件路径
const sessionFileArg = process.argv[2];

function loadSessionData() {
  // 优先使用 server.js 传入的临时会话文件
  if (sessionFileArg && fs.existsSync(sessionFileArg)) {
    try {
      const data = JSON.parse(fs.readFileSync(sessionFileArg, 'utf8'));
      fs.unlinkSync(sessionFileArg); // 用完即删
      return data;
    } catch (e) {
      console.warn('[MemoryExtract] 读取临时会话文件失败:', e.message);
    }
  }
  // 回退：扫描 data/memory/user/ 最新 session 文件
  if (!fs.existsSync(USER_DIR)) return null;
  var files = fs.readdirSync(USER_DIR).filter(f => !f.startsWith('_') && f.endsWith('.json'));
  if (!files.length) return null;
  files.sort();
  var latest = path.join(USER_DIR, files[files.length - 1]);
  try { return JSON.parse(fs.readFileSync(latest, 'utf8')); } catch { return null; }
}

function extractMemory() {
  var sessionData = loadSessionData();
  if (!sessionData || !sessionData.messages || sessionData.messages.length < 4) return;

  var messages = sessionData.messages;
  var recent = messages.slice(-20).filter(m => m.role === 'user' || m.role === 'assistant');
  var summary = summarize(recent);

  var memFile = path.join(DATA_DIR, 'session_summary.md');
  var existing = fs.existsSync(memFile) ? fs.readFileSync(memFile, 'utf8') : '';
  var timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  var entry = '\n\n---\n## ' + timestamp + '\n\n' + summary;
  fs.appendFileSync(memFile, entry, 'utf8');
  console.log('[MemoryExtract] 已提取记忆到 ' + memFile);
}

function summarize(messages) {
  // 简单的提取式摘要：取关键意图 + 用户事实
  var facts = [];
  var intents = [];
  for (var i = 0; i < messages.length; i++) {
    var m = messages[i];
    var content = (m.content || '').trim();
    if (!content || content.length < 5) continue;
    if (m.role === 'user') {
      // 提取关键事实（简短指令、偏好设置）
      if (content.startsWith('记住') || content.startsWith('请记住') || content.startsWith('以后')) {
        facts.push(content.slice(0, 100));
      } else if (content.length < 80) {
        intents.push(content);
      }
    }
  }
  var result = '';
  if (facts.length) result += '### 用户事实\n' + facts.map(f => '- ' + f).join('\n') + '\n\n';
  if (intents.length) result += '### 最近意图\n' + intents.slice(-5).map(t => '- ' + t).join('\n') + '\n\n';
  return result || '（无可用摘要数据）';
}

extractMemory();