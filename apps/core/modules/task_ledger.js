'use strict';
// ============================================================
// 任务账本 task_ledger (2026-09-13 老板拍板 "解决问题, 不是打补丁")
//
// 由 tool_result (ground truth) 驱动的持久任务账本 — 跨压缩 / 跨轮 / 跨请求存活。
// 根治三件事:
//   ① 等指示病 — 账本知道干了多少剩多少, 敦促有据 ("已读 3/7, 下一步 #4")
//   ② 模型失忆 — 已核实事实 (真路径/真行数/真字节) 入账, 每请求回灌, 压缩切不掉
//   ③ 进化闭环 — 死因/教训同样入账, 下次开工先读"上次怎么死的"
//
// 铁律: 账本只记 tool_result 的 ground truth, 永远不记模型自述。
// ============================================================
const fs = require('fs');
const path = require('path');
const os = require('os');
// 2026-10-25 (第 92 批): session id → 落盘文件名的唯一真源。
//   原来这里自己抄了一份清洗 ⇒ '!!!' 与 '@@@' 落同一个文件, 两个会话互相覆盖。
//   resolveSessionKey = 纯清洗 (存量零改名) + 真撞名时才换指纹名 (不覆盖别人的账)。
const { sessionKey, resolveSessionKey, probeSessionId } = require('./session_key');
// 2026-10-26 第 100 批: 账本目录走唯一真源 (modules/state_paths.js)
//   沙箱导出 PANGU_LEDGER_DIR ⇒ 测试链不再往生产 ~/.pangu/state/ledger 写测试产物
//   (实测每跑一次链 31 个文件进生产: roletest / test-delivery-* / wcmd-*)。
const statePaths = require('./state_paths');

const PANGU_HOME = process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
const LEDGER_DIR = () => statePaths.ledgerDir();
const CAPS = { files_read: 40, files_written: 30, dirs_seen: 15, paths_missing: 15, cmds_failed: 10, lessons: 20, charts_cast: 10 };

function ensureDir() { try { fs.mkdirSync(LEDGER_DIR(), { recursive: true }); } catch (_) {} }
function ledgerFile(sessionId) {
  return path.join(LEDGER_DIR(), resolveSessionKey(LEDGER_DIR(), sessionId) + '.json');
}

/**
 * 子账本文件名的前缀 —— 子账本的文件名是
 *   sessionKey(parent + '#sub-' + n + '-' + role)
 * ⇒ 开头是 sessionKey(parent) + '_sub-'。
 *
 * ⚠️ 父 id 很长时 (sessionKey 截到 80), '_sub-' 会被截掉 ⇒ 只能按前 75 字符找,
 *    找到再用文件里的 session_id 认领。父 id 短的场合走快路径。
 */
function _childLedgerPrefix(parent) {
  const clean = sessionKey(parent);
  const SEP = '_sub-';
  if (clean.length + SEP.length <= 80) return { prefix: clean + SEP, truncated: false };
  return { prefix: clean.slice(0, 80 - SEP.length), truncated: true };
}

function _blank(sessionId) {
  return {
    session_id: sessionId,
    goal: '',
    facts: { files_read: [], files_written: [], dirs_seen: [], paths_missing: [], cmds_failed: [], charts_cast: [], files_written_total: 0 },
    lessons: [],
    last_run: null,
    updated_at: null,
  };
}

function loadLedger(sessionId) {
  try {
    const f = ledgerFile(sessionId);
    if (!fs.existsSync(f)) return null;
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch (_) { return null; }
}

function saveLedger(sessionId, data) {
  try {
    ensureDir();
    data.updated_at = new Date().toISOString();
    // 2026-10-25 (第 92 批): 账本必须自己写着 session_id ——
    //   落盘文件名是**清洗后**的, 真撞名时靠文件里这个字段认领归属。
    //   以前靠调用方自己塞, 漏一个就认不出归属 ⇒ 撞名时可能覆盖别人的账。
    data.session_id = sessionId;
    fs.writeFileSync(ledgerFile(sessionId), JSON.stringify(data, null, 1));
    return true;
  } catch (_) { return false; }
}

// 同 key 去重 (最新覆盖), 尾部追加, 超限裁头
function _push(list, item, cap, keyFn) {
  if (keyFn) {
    const k = keyFn(item);
    const idx = list.findIndex(x => keyFn(x) === k);
    if (idx >= 0) list.splice(idx, 1);
  }
  list.push(item);
  while (list.length > cap) list.shift();
}

// 从 tool_result 提取账目 — 只记 ground truth
// result 形态: { ok: bool, data?: {...}, error?: {code,message}|string, execution_ms }
// 2026-10-13 (现场 r10-live-1): facts.files_written 按 CAPS=30 封顶且按 path 去重,
// 当不了"干了多少活"的单调信号 —— 而 auto_resume 的"有进展就重置预算"
// 和 budget 的"压缩续命看进展"两个判据都要求单调递增。
// 另记一个不封顶的写盘事件总数, 让每条真写盘都被看见。
function _bumpWrites(ledger) {
  const f = (ledger.facts = ledger.facts || {});
  f.files_written_total = (typeof f.files_written_total === 'number' ? f.files_written_total : 0) + 1;
}

// 2026-10-16 (现场 lt3): 写盘记账只认 > >> tee, 于是这些**真写盘**全在账外 ——
//   mkdir -p … && touch a.txt b.txt …   建出来的文件
//   cp a.txt c.txt / mv a.txt b.txt     复制/移动出来的文件
//   install … / dd of=X / sed -i …      同样
// 症状: task_done 被拒 (LEDGER_MISS), 子 agent 白跑工具调用去补一个"账认的写盘",
// 每一次都是一次完整 LLM 往返。更糟的是账本是反幻觉的锚, 锚把真写盘判成没写,
// 等于告诉模型"如实汇报会被拒" —— 那是在训练它改口。
// 边界: 只认**语义上确定会产生目标文件**的命令。不猜的、可能只读的、复杂到
// 解析不了的 (rsync / git checkout / 脚本里循环写) 一律不记 —— 宁可漏, 不造假。
// 宁可漏的理由是另一头还兜着: claim 侧有 mtime 兜底, 漏记最多让对账走那条路;
// 错记则是往账本里塞一条假写盘, 那正是这把尺子要防的东西。
function _shellWriteTargets(cmd, abs) {
  const out = [];
  try {
    // 引号感知切词: cp "/tmp/a b.txt" dst 这种带空格的路径不能按空白劈开
    // (劈开就变成两个半截路径, 目标算错 —— 宁可漏也不能记错)。
    const _tok = (s) => {
      const r = []; let cur = '', q = null;
      for (const ch of String(s || '')) {
        if (q) { if (ch === q) q = null; else cur += ch; continue; }
        if (ch === '"' || ch === "'") { q = ch; continue; }
        if (/\s/.test(ch)) { if (cur) { r.push(cur); cur = ''; } continue; }
        cur += ch;
      }
      if (cur) r.push(cur);
      return r;
    };
    // 按 ; | & 换行切段。`2>&1` 会切成 "2>" 和 "1" —— 它们解析不出目标, 不会造假条目。
    for (const rawSeg of String(cmd || '').split(/[;|&]+|\n+/)) {
      // 剥掉子 shell / 命令替换的包装符, 否则 "(cd /tmp && touch a.txt)" 里的
      // "a.txt)" 会被当成路径记进账本 —— 账本里出现一条不存在的路径, 比不记更糟。
      // 先 trim 再剥包装符 —— 顺序反了的话 " `touch x` " 一个都剥不掉
      const seg = rawSeg.trim().replace(/^\$*\(?`?/, '').replace(/[`)]+$/, '').trim();
      if (!seg) continue;
      const tk = _tok(seg);
      if (!tk.length) continue;
      const head = String(tk[0]).split('/').pop();
      const rest = tk.slice(1).filter(t => !/^-/.test(t));
      const _add = (t) => { const a = abs && abs(t); if (a) out.push(a); };
      switch (head) {
        // cp/mv/install: 最后一个非选项参数就是目标
        case 'cp': case 'mv': case 'install':
          if (rest.length >= 2) _add(rest[rest.length - 1]);
          break;
        // touch: 每个非选项参数都是被创建/更新的目标
        case 'touch':
          for (const t of rest) _add(t);
          break;
        // dd: 目标写在 of= 里
        case 'dd':
          for (const t of tk) {
            const m = /^of=(.+)$/.exec(t);
            if (m) _add(m[1]);
          }
          break;
        // sed -i: 就地改, 最后一个非选项参数是被改的文件
        case 'sed':
          if (tk.includes('-i') && rest.length >= 2) _add(rest[rest.length - 1]);
          break;
        default: break;
      }
    }
  } catch (_) { /* 解析不了就不记, 不猜 */ }
  return out;
}

function recordToolResult(sessionId, toolName, params, result) {
  if (!sessionId || !toolName || !result) return;
  try {
    const p = params || {};
    const ok = !!(result && result.ok);
    const data = (result && result.data) || (result && result.result && result.result.data) || null;
    const errMsg = ok ? '' : String(
      (result.error && result.error.message) || result.error || ''
    ).slice(0, 160);
    const now = Date.now();
    let touched = false;
    const ledger = loadLedger(sessionId) || _blank(sessionId);

    if (ok && toolName === 'read_file' && (p.path || (data && data.path))) {
      _push(ledger.facts.files_read, {
        path: p.path || data.path,
        offset: (data && data.offset) != null ? data.offset : (p.offset != null ? p.offset : 1),
        limit: (data && data.limit) || p.limit || null,
        total_lines: (data && data.total_lines) || null,
        ts: now,
      }, CAPS.files_read, x => x.path + '@' + x.offset);
      touched = true;
    }
    if (ok && /^(write_file|file_edit|apply_patch)$/.test(toolName) && (p.path || (data && data.path))) {
      _push(ledger.facts.files_written, {
        path: p.path || data.path,
        bytes: (data && data.bytes) || null,
        tool: toolName,
        ts: now,
      }, CAPS.files_written, x => x.path);
      _bumpWrites(ledger);
      touched = true;
    }
    // 2026-10-24 (第 81 批): MCP 的写盘工具 (mcp__<server>__write_file / __edit_file)
    //   也是**真写盘**, 但上面那条正则锚死在内部工具名上 (^write_file$) ⇒ MCP 写的文件
    //   从来不进账本。后果: "已真写" 那份清单少它, 对账 (checkDeliveryClaims) 只能靠
    //   mtime 兜底 —— 文件被改名/挪走/清掉就判成"账上无据" ⇒ 合法交付被拒 (LEDGER_MISS)。
    //   路径取工具入参 (p.path) —— MCP 的写盘入参就叫 path, 跟内部工具同名。
    //   注意这里依赖第 81 批的 isError 收口: 失败的 MCP 写 (ok=false) 记不进来,
    //   所以"账上写着写了"= 真写了, 不再是"模型说写了"。
    if (ok && /^mcp__.+__(write_file|edit_file|create_file)$/.test(toolName) && p.path) {
      _push(ledger.facts.files_written, {
        path: p.path,
        bytes: null,          // MCP 的成功回执只给一句 "Successfully wrote to X", 没有字节数
        tool: toolName,
        ts: now,
      }, CAPS.files_written, x => x.path);
      _bumpWrites(ledger);
      touched = true;
    }
    // 2026-09-13 P1a (老板: 对账制): exec_command 重定向/heredoc/tee 写盘也记账 —
    // 堵"绕过 write_file 用 cat > x.md 落盘, 账上无据, 对账验收误判"的洞。
    if (ok && toolName === 'exec_command') {
      const cmd = String(p.command || '');
      // 2026-10-13 (现场 r11-live, /tmp/pangu-single.log:265693): 盘古模型高频写
      //   cd /tmp/pangu_v10 && ... && printf '%s' "$(cat a.txt)" > report.txt && ... >> report.txt
      // 旧正则只认 [~/] 开头的绝对路径 → 这种"cd 到目录 + 相对路径重定向"全部漏记,
      // 实测该子 agent 真写了 3 个文件, 账本只记 2 个。
      // 现在按命令里的 cd 解析相对路径; 定位不出来就如实不记 (对账时还有 mtime 兜底)。
      const cdM = /\bcd\s+(?:"([^"]+)"|'([^']+)'|([^\s;&|]+))/.exec(cmd);
      const cwd = cdM ? String(cdM[1] || cdM[2] || cdM[3] || '').trim() : '';
      const _abs = (t) => {
        if (!t) return null;
        if (t.startsWith('/')) return t;
        if (t.startsWith('~')) return path.join(os.homedir(), t.slice(1));
        if (cwd) return path.resolve(cwd, t);
        return null; // 没有参照就不猜路径
      };
      const targets = [];
      let m;
      const reRedirect = />{1,2}\s*((?:~|\/)?[^\s|;&"']+)/g;
      // 注: `2>&1` / `>&2` 这类 fd 重定向不用特判 —— 捕获组的字符类已排除 `&`,
      // 实测两者都匹配不到任何目标 (别加没有证据的防御)。
      while ((m = reRedirect.exec(cmd))) {
        const t = _abs(m[1]);
        if (t) targets.push(t);
      }
      const reTee = /\btee\s+(?:-a\s+)?((?:~|\/)?[^\s|;&"']+)/g;
      while ((m = reTee.exec(cmd))) {
        const t = _abs(m[1]);
        if (t) targets.push(t);
      }
      for (const t of targets) {
        // 滤掉 /dev/null 之类的伪写盘
        if (/^\/dev\//.test(t)) continue;
        _push(ledger.facts.files_written, { path: t, bytes: null, tool: 'exec_command', ts: now }, CAPS.files_written, x => x.path);
        _bumpWrites(ledger);
        touched = true;
      }
      // 2026-10-16 (现场 lt3, 5 步长任务): 上面只认 > >> tee, 于是
      //   mkdir -p … && touch u1.txt … u5.txt   → 5 个空文件, 账上一个都没有
      //   cp u1.txt u3.txt                       → 真的写了, 账上还是没有
      // 后果不是"少记一点": task_done 被拒 2 次 (LEDGER_MISS count=2), 子 agent
      // 白跑两轮工具调用去补一个它认得的写盘, 每次都是一次完整的 LLM 往返。
      //
      // 更要紧的是账本的角色: 它是反幻觉的**锚**。锚把真写盘说成没写, 不只是漏记 ——
      // 是让"如实汇报"变成罪过, 模型只能改口或重做。锚宁可宽不可窄 (claim 侧还有
      // mtime 兜底 + basename 归一, 两头都不放过真写盘)。
      for (const t of _shellWriteTargets(cmd, _abs)) {
        if (/^\/dev\//.test(t)) continue;
        _push(ledger.facts.files_written, { path: t, bytes: null, tool: 'exec_command', ts: now }, CAPS.files_written, x => x.path);
        _bumpWrites(ledger);
        touched = true;
      }
    }
    if (ok && toolName === 'list_directory' && (p.path || (data && data.path))) {
      const entries = data && (data.entries || data.items || data.files);
      _push(ledger.facts.dirs_seen, {
        path: p.path || data.path,
        entries: Array.isArray(entries) ? entries.length : null,
        ts: now,
      }, CAPS.dirs_seen, x => x.path);
      touched = true;
    }
    //
    // 2026-10-22: 排盘记账 —— 本轮**算过的盘**是唯一真源, 得跨轮存活。
    //
    // 为什么必须记 (老板 10-21 现场): planner 在任何工具都没跑之前就编了一份四柱,
    // 还标成「前一刀已核实，直接采信」喂给下游。要判这是编的, 就得知道
    // 「本轮到底有没有人真的算过盘」—— 而账本原来**不记排盘工具**,
    // 于是这个判据无从查证, 只能靠模型自证。
    //
    // 记的形态: **只存 sxtwl 权威四柱** (data.pillars.pillars),
    // 不存模型自己写的四柱 —— 后者正是要防的编造。
    // 存不下的 (结果形状不对) → 不记, 宁可没有真源也不记假的。
    if (ok && (toolName === 'bazi_calc' || toolName === 'gua_cast')) {
      const p4 = data && data.pillars && data.pillars.pillars;
      if (p4 && typeof p4 === 'object') {
        const chart = {};
        let complete = true;
        for (const k of ['年柱', '月柱', '日柱', '时柱']) {
          const v = p4[k];
          if (typeof v !== 'string' || v.length !== 2) { complete = false; break; }
          chart[k] = v;
        }
        if (complete) {
          _push(ledger.facts.charts_cast, {
            tool: toolName,
            pillars: chart,
            ts: now,
          }, CAPS.charts_cast, x => x.tool + ':' + x.pillars['年柱'] + x.pillars['月柱'] + x.pillars['日柱'] + x.pillars['时柱']);
          touched = true;
        }
      }
    }
    // 不存在路径 — 幻觉防控核心: 模型再想去同一个假路径, 账本直接告诉它"不存在, 别再试"
    if (!ok && /(不存在|No such file|ENOENT|not found|无法访问)/i.test(errMsg)) {
      let target = p.path || '';
      if (!target && toolName === 'exec_command') {
        const m = String(p.command || '').match(/(?:ls|find|cat|cd)\s+(?:-[\w]+\s+)?([/~][^\s|;&"']*)/);
        target = (m && m[1]) || String(p.command || '').slice(0, 60);
      }
      if (target) {
        _push(ledger.facts.paths_missing, { path: target, via: toolName, ts: now }, CAPS.paths_missing, x => x.path);
        touched = true;
      }
    }
    if (!ok && errMsg) {
      _push(ledger.facts.cmds_failed, {
        tool: toolName,
        args: JSON.stringify(p).slice(0, 80),
        error: errMsg.slice(0, 100),
        ts: now,
      }, CAPS.cmds_failed, null);
      touched = true;
    }
    if (touched) saveLedger(sessionId, ledger);
  } catch (_) { /* 记账永不阻塞主流程 */ }
}

// 目标入账 — 确认词/续跑词不换目标 (换了你ledger就忘了自己在干嘛)
function recordGoal(sessionId, input) {
  try {
    let t = String(input || '').trim();
    // 剥起卦前缀块 (pangu_agent_stream._formatGuaFirstBlock 以 "主人问题: " 收尾) —
    // 不剥 goal 会变成卦辞模板, 账本目标栏废掉 (smoke 实测实证)
    const gi = t.lastIndexOf('主人问题: ');
    if (gi >= 0) t = t.slice(gi + '主人问题: '.length).trim();
    if (t.length < 4) return; // 2026-09-13 (16:08 实案): 8 → 4 — "先b+c，再a" (7 字) 是真实拍板指令, 被旧阈值丢掉, 账本目标栏空 → 模型不知道 A/B/C 是什么, 抓错上下文编答案
    if (/^(继续|好|嗯|对|可以|行|ok|全部做了|接着)/i.test(t)) return;
    // 2026-09-22 修 (session 44008568 实案): 澄清/疑问句 ("你分析的是我给你的图吗？") 不该记成新 goal —
    // 旧逻辑把 12 字疑问句当真目标入账, 进度卡注入"不要等主人指示", 模型答非所问。
    // 疑问语气词结尾 + 短于 60 字 = 澄清句, 换目标要等明确的祈使句。
    if (t.length <= 60 && /(?:吗|嘛|么|？|？|\?)([？?]?\s*)$/.test(t) && /吗|？|\?/.test(t.slice(-3))) return;
    // 2026-09-22 修 (session 60273479 实案 "你现在能看见我了吧"): 状态确认/寒暄句
    // ("能看见我了吧/在吗/你好/在不在/能听到吗") 不是任务, 不该换 goal — 旧逻辑把它记成新目标,
    // 进度卡注入"不要等主人指示", 模型就把上一轮任务当成要"继续做" → 答非所问/重新起卦。
    // 这类句一律当 social-confirm, 不换目标 (真任务由后续祈使句/附图承担)。
    // 状态确认/寒暄词根白名单 (短句命中任一 = social-confirm, 不换目标):
    // 词根: 在吗/在不在/在么/在哦/在不/还在吧/你好/您好/嗨/hi/hello/看见我/能看见/能听到/能听见/看得见
    // 边界: "做一下/继续/好" 已有各自守卫, 这里补"你现在能看见我了吧"这种带"我"的状态问句
    if (t.length <= 30) {
      // 状态确认/寒暄句 = 不换目标. 实案 (session 60273479):
      //   "你现在能看见我了吧" / "在吗" / "能看见吗" / "能读到我发的图吧" / "你好"
      // 判定: 短句 + (含"看见/看到/听见/听到/读到/看得见/听得见" 状态动词) 或 纯寒暄词, 且不是祈使句
      // (祈使句 = 以 写/做/跑/查/读这个/把/帮我 开头, 这些是任务不是确认)
      const _isImperative = /^(?:写|做|跑|查|读这|把|帮我|请|执行|跑一下|做一下|测试|分析|生成|建|改|修|查一下|看一)/.test(t);
      if (!_isImperative) {
        const _stateVerb = /看见|看到|听见|听到|读到|读得到|看得见|听得见|在吗|在不在|在么|在哦|在不|你好|您好|嗨|hi|hello/;
        if (_stateVerb.test(t)) {
          console.warn('[task_ledger] social-confirm skip goal:', t);
          return;
        }
      }
    }
    const ledger = loadLedger(sessionId) || _blank(sessionId);
    if (ledger.goal === t.slice(0, 200)) return;
    ledger.goal = t.slice(0, 200);
    saveLedger(sessionId, ledger);
  } catch (_) {}
}

// 教训入账 — 死因标签 + 一句话, 同 kind 去重留最新并累计次数 (屡犯升级硬约束用)
function recordLesson(sessionId, kind, note) {
  try {
    const ledger = loadLedger(sessionId) || _blank(sessionId);
    const k = String(kind || '?').slice(0, 40);
    const prev = (ledger.lessons || []).find(x => x.kind === k);
    _push(ledger.lessons, {
      kind: k,
      note: String(note || '').slice(0, 200),
      count: ((prev && prev.count) || 1) + (prev ? 1 : 0),
      ts: Date.now(),
    }, CAPS.lessons, x => x.kind);
    saveLedger(sessionId, ledger);
  } catch (_) {}
}

// 运行结局入账 — 下次开工先读"上次怎么死的"
function recordRunEnd(sessionId, status, note) {
  try {
    const ledger = loadLedger(sessionId) || _blank(sessionId);
    ledger.last_run = { status: String(status || '?'), note: String(note || '').slice(0, 150), ts: Date.now() };
    saveLedger(sessionId, ledger);
  } catch (_) {}
}

function _fmtRead(r) {
  const range = r.total_lines ? ('第' + r.offset + '行起/' + '共' + r.total_lines + '行') : (r.limit ? ('第' + r.offset + '行起 ' + r.limit + '行') : '');
  return r.path + (range ? ' (' + range + ')' : '');
}

// 渲染账本快照 — 注入 system, 压缩存活 (keepSystemMessages)
// 返回 null = 无账可注入 (新会话首跑)
function renderLedgerForSession(sessionId) {
  const ledger = loadLedger(sessionId);
  if (!ledger) return null;
  const f = ledger.facts || {};
  const hasFacts = (f.files_read || []).length + (f.files_written || []).length +
    (f.dirs_seen || []).length + (f.paths_missing || []).length > 0;
  if (!hasFacts && !ledger.goal && !(ledger.lessons || []).length && !ledger.last_run) return null;

  const lines = ['# 任务账本 (盘古真账 — 全部来自工具结果, 不是你的自述)', ''];
  if (ledger.goal) lines.push('**目标**: ' + ledger.goal);
  if (ledger.last_run) {
    lines.push('**上次运行**: ' + ledger.last_run.status + (ledger.last_run.note ? ' — ' + ledger.last_run.note : ''));
  }
  if ((f.files_read || []).length) {
    lines.push('', '**已真读** (' + f.files_read.length + ' 段):');
    for (const r of f.files_read.slice(-8)) lines.push('- ' + _fmtRead(r));
  }
  if ((f.files_written || []).length) {
    lines.push('', '**已真写** (' + f.files_written.length + ' 份):');
    for (const w of f.files_written.slice(-8)) lines.push('- ' + w.path + (w.bytes ? ' (' + w.bytes + 'B)' : ''));
  }
  if ((f.paths_missing || []).length) {
    lines.push('', '**已核实不存在的路径 (禁止再试, 禁止当原因引用)**:');
    for (const m of f.paths_missing.slice(-5)) lines.push('- ' + m.path);
  }
  if ((f.cmds_failed || []).length) {
    lines.push('', '**近期工具失败** (' + f.cmds_failed.length + '):');
    for (const c of f.cmds_failed.slice(-3)) lines.push('- ' + c.tool + ' ' + c.args + ' → ' + c.error);
  }
  if ((ledger.lessons || []).length) {
    const _hard = ledger.lessons.filter(l => (l.count || 1) >= 2);
    const _soft = ledger.lessons.filter(l => (l.count || 1) < 2);
    if (_hard.length) {
      lines.push('', '**硬约束 (屡犯 ≥2 次, 再犯 = 任务失败, 无任何借口)**');
      for (const l of _hard.slice(-5)) lines.push('- [' + l.kind + ' ×' + (l.count || 2) + '] ' + l.note);
    }
    if (_soft.length) {
      lines.push('', '**教训 (上次怎么死的, 别再犯)**:');
      for (const l of _soft.slice(-5)) lines.push('- [' + l.kind + '] ' + l.note);
    }
  }
  lines.push('', '**运用规则**:');
  lines.push('- 分析原因/做决策只允许引用本账本的事实; 不在账上的路径先 list_directory 核实再读');
  lines.push('- 剩余工作直接继续做, 不要等主人指示, 做完调 task_done 汇报');
  lines.push('- 你的上下文可能被压缩, 本账本随压缩存活 — 记忆以账为准, 不以你印象为准');
  return lines.join('\n');
}

// 交付对账 (2026-09-13 老板 21:40 实案 "说不上来的问题"): 不止 task_done —
// 任何出门文本声称写盘, 都必须账上有据。三道实案全是 0 工具编造落盘出门:
// "落盘 149 行/5.6KB"(文件不存在) / "10 案例落盘完成"(目录零 .md) / "横切对照表落盘"(同上)。
// 返回 null = 无声称或对账通过; { missed, written } = 有编造。
// 2026-09-19 幻觉路径归一 (老板: ~/pangu/IDENTITY.md 等模型编的占位路径被当成读盘证据):
// 路径 expand ~ → 真实 homedir; 相对/仓库内路径 → 锚仓库根; 只有本机真实存在的文件才算数.
// 不存在的路径进 paths_missing (幻觉名单), 不进 files_read / 写盘对账.
const _REPO_ROOT_TL = path.join(__dirname, '..', '..', '..', '..'); // modules → core → apps → 仓库根
function normalizeClaimPath(c) {
  let p = String(c);
  if (p.startsWith('~/')) p = path.join(os.homedir(), p.slice(2));
  else if (!path.isAbsolute(p)) p = path.join(_REPO_ROOT_TL, p); // 相对路径锚仓库根
  p = path.resolve(p);
  if (!/^((\/Users|\/private|\/tmp|\/var|\/opt)(\/.*)?)$/.test(p)) return p;
  try { if (fs.existsSync(p)) return p; } catch (_) {}
  return null; // 本机不存在 = 幻觉路径
}

// 本轮开始的可靠下界 = 这个会话账本文件的创建时间 (它是一进循环就建的)。
// 拿它当基准, 就能判断"这个文件是不是本轮改写的", 而不用猜账本记没记到。
function _runStartedAt(sessionId) {
  const sid = String(sessionId || '');
  let best = 0;
  const consider = (file) => {
    try {
      const st = fs.statSync(file);
      const bt = (st.birthtimeMs && st.birthtimeMs > 0) ? st.birthtimeMs : st.ctimeMs;
      if (bt > 0) best = best ? Math.min(best, bt) : bt;
    } catch (_) {}
  };
  consider(ledgerFile(sid));
  // 子 agent 会话 (parent#sub-N-role): 锚到整个调度轮最早的那份账本,
  // 否则上游兄弟写的产物会被当成"本轮之前的旧文件"而误拦。
  // 父会话同样要锚到子账本 (2026-10-13): 原来只写了"子 → 父+兄弟"方向,
  // 父 sid 取到 0 → _writtenDuringRun(path, 0) 恒 false → mtime 兜底在父会话上完全失效。
  for (const _cf of _childLedgerFiles(sid)) consider(path.join(LEDGER_DIR(), _cf));
  const parent = sid.split('#')[0];
  if (parent && parent !== sid) {
    try {
      const { prefix } = _childLedgerPrefix(parent);
      for (const f of fs.readdirSync(LEDGER_DIR())) {
        if (f.startsWith(prefix)) consider(path.join(LEDGER_DIR(), f));
      }
    } catch (_) {}
  }
  return best;
}

// 账上没记, 但文件在本轮被改写过 → 算本轮真产出。
// 老文件 (mtime 早于本轮) 不算 —— 幻觉保护原样保留。
function _writtenDuringRun(absPath, runStart) {
  if (!runStart || !absPath) return false;
  try {
    const st = fs.statSync(absPath);
    if (!st.isFile()) return false;
    return st.mtimeMs >= runStart;
  } catch (_) { return false; }
}

// basename 版兜底 (见 checkDeliveryClaims 里那处调用)。范围严格受限: 只看
// **本轮已知写盘路径的父目录**, 而且要 stat 到真的存在、mtime >= 本轮开始。
// 换句话说它不"相信"任何东西, 只是换了个拼法去 stat 同一个事实 —— 造不了假。
function _writtenByBasename(baseName, writtenPaths, runStart) {
  if (!baseName || !runStart) return false;
  const dirs = new Set();
  for (const w of writtenPaths || []) {
    const s = String(w || '');
    if (!s) continue;
    const d = path.dirname(s);
    if (d && d !== '.' && path.isAbsolute(d)) dirs.add(d);
  }
  for (const d of dirs) {
    try {
      const st = fs.statSync(path.join(d, baseName));
      if (st.isFile() && st.mtimeMs >= runStart) return true;
    } catch (_) {}
  }
  return false;
}

// 2026-10-13 (现场 session=r10-live-2): 走 dispatcher 的父会话**根本没有账本文件** ——
// 它不经过 j2_agent_loop, 只有 <parent>_sub-N-role 各有一份。于是"本轮真写了哪些文件"
// 这个唯一真源在父会话视角是空的, 连带三处一起瞎:
//   ① checkDeliveryClaims 把子 agent 真写的文件 100% 判成幻觉 (mtime 兜底也失效, 见 _runStartedAt)
//   ② recordOutcome 的 artifacts 恒空 (1023 条结局记录只有 3 条有产物, 全是 09-09 硬编码前)
//   ③ auto_resume / budget 的"写盘进展"判据对父会话恒 false → 长任务被判零进展
// 修法: 本轮真写盘 = 父账本 ∪ 全部子账本, 按 path 去重。三个消费者统一走这里, 单一真源。
function _childLedgerFiles(sessionId) {
  const parent = String(sessionId || '').split('#')[0];
  const { prefix, truncated } = _childLedgerPrefix(parent);
  try {
    const hit = fs.readdirSync(LEDGER_DIR()).filter(f => f.startsWith(prefix) && f.endsWith('.json'));
    if (!truncated) return hit;
    // 父 id 很长 ⇒ 文件名被截断 ⇒ '_sub-' 已被切掉 ⇒ 只能按文件里的 session_id 认领。
    return hit.filter(f => {
      const s = probeSessionId(path.join(LEDGER_DIR(), f));
      return s && String(s).startsWith(parent + '#sub-');
    });
  } catch (_) { return []; }
}

function _collectLedgerStats(sessionId) {
  const files = new Map();
  let total = 0;
  const absorb = (l) => {
    const f = (l && l.facts) || null;
    if (!f) return;
    const ws = Array.isArray(f.files_written) ? f.files_written : [];
    for (const w of ws) {
      const p = String((w && w.path) || '');
      if (p && !files.has(p)) files.set(p, w);
    }
    total += (typeof f.files_written_total === 'number') ? f.files_written_total : ws.length;
  };
  absorb(loadLedger(sessionId));
  for (const fn of _childLedgerFiles(sessionId)) {
    try { absorb(JSON.parse(fs.readFileSync(path.join(LEDGER_DIR(), fn), 'utf8'))); } catch (_) {}
  }
  return { files: [...files.values()], total };
}

// 本轮真写盘路径 (父 + 子, 去重) — 对账 / 产物台账统一用它
function collectWrittenFiles(sessionId) { return _collectLedgerStats(sessionId).files; }

// 本轮写盘事件数 (不封顶, 单调) — **只作观测**, 不再当进展判据
function countWrittenEvents(sessionId) { return _collectLedgerStats(sessionId).total; }

/**
 * 本轮算过的权威盘 (父账本 ∪ 全部子账本), 按盘去重。
 *
 * 2026-10-22: 派活前判"简报里的四柱是不是编的"需要知道
 * 「本轮到底有没有人真的算过盘」。答案在这里 —— 账本记的**只有 sxtwl 权威四柱**,
 * 模型自己写的四柱不进账本 (那正是要防的编造)。
 *
 * 父会话**自己没有账本文件**(走 dispatcher 的父会话不经过 j2_agent_loop),
 * 只有 <parent>_sub-N-role 各有一份 —— 所以必须走子账本聚合, 与
 * _collectLedgerStats 同一个坑、同一个修法。
 *
 * @param {string} sessionId
 * @returns {Array<{tool:string, pillars:object}>}
 */
function collectCastCharts(sessionId) {
  const out = [];
  const seen = new Set();
  const absorb = (l) => {
    const list = l && l.facts && Array.isArray(l.facts.charts_cast) ? l.facts.charts_cast : [];
    for (const c of list) {
      if (!c || !c.pillars) continue;
      const p = c.pillars;
      const key = p['年柱'] + p['月柱'] + p['日柱'] + p['时柱'];
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ tool: c.tool || 'bazi_calc', pillars: p });
    }
  };
  absorb(loadLedger(sessionId));
  for (const fn of _childLedgerFiles(sessionId)) {
    try { absorb(JSON.parse(fs.readFileSync(path.join(LEDGER_DIR(), fn), 'utf8'))); } catch (_) {}
  }
  return out;
}

// 2026-10-13 现场 (resume-live-1791876482, 子 agent 跑满 18 分钟收不了尾):
//   [j2-auto-resume] 上限到达但有实质进展 (done 0→0, files 12→24)
//   [j2-auto-resume] 上限到达但有实质进展 (done 0→0, files 100→114)
//   [j2-auto-resume] 上限到达且无实质进展 (4/3, done=0, files=130), 收口
// done 一直是 0→0 —— **什么都没完成**, 但 files 从 12 涨到 130: 子 agent 在把
// 同一批文件反复重写, 写盘**事件数**被灌水, 于是每一轮都判成「有实质进展」,
// 预算一次次重置, 锁死在重复循环里。这正是「子 agent 调用一直有问题」的机制。
//
// 定式: 进展判据要数「新增的不同交付物」, 不是「动作次数」。
// 有界取舍: facts.files_written 按 CAPS=30 封顶, 所以本计数在单账本 30 份后饱和 ——
// 宁可漏判 (让会话诚实收口), 不可误判 (无限续命)。长任务靠 j2 的 plan done 双信号兜底。
function countDistinctWrittenFiles(sessionId) { return _collectLedgerStats(sessionId).files.length; }

// 2026-10-18 (现场 desktop-1792306846566, 老板 "完全不符合交付常理"):
//   问 "全面介绍一下你自己"。3 个 analyzer 子 agent 各自交出**带完整证据的答复**
//   (ls/cat/grep 的真实路径 + 字节数 + 行号), 父级合成后连收两道:
//   07:04:12 ⚠️ [盘古 对账拦截] …  07:04:23 ⚠️ [盘古 对账拦截] …
//   主人最后收到的是两条拦截提示, 一句答案都没拿到。
//
// 根因是**类别错误**: 旧逻辑把答复里出现的**每一个** .md/.json 路径都当成
// "声称写盘"。可只读取证任务的正确答法恰恰是把源码/配置路径**当证据列出来**
// —— "沙箱白名单: apps/core/modules/sandbox.js:203" 是引用, 不是声称。
// 于是引用被当成冒领, 越举证越被判编造。
//
// 判据: 声称"我做了这个文件"必须有**创作谓词**; 光有路径只是引用。
// 取路径所在**行**为语境 (答复是列表, 一个要点一行) —— 同行出现
// 写入/落盘/生成/创建/产出/保存… 才算冒领, 缺谓词的按引用放过。
//
// 为什么不用"文件早于本轮就不算数"当兜底: 那会把"我生成了 report.md"
// 而 report.md 其实是三个月前的旧文件这种**真冒领**也一并放过。谓词是
// 唯一能把"引用"和"冒领"分开的东西 —— 措辞, 不是时间。
//
// MTIME_REPORT_RE 是现场那句话的本体: "checkpoint 目录 … 最近写入 10-18 15:01"
// —— "写入" 在这里的主语是**文件系统**, 不是盘古。它报的是 mtime。判据前先把
// 这类短语挖空, 否则模型把 mtime 和路径写在同一行时 (很常见的一行式答复)
// 又会被自己的观测读成冒领, 现场那条就白改了。
const _AUTHORSHIP_PREDICATE_RE = /(写入|写到|写成|改成|落盘|存成|存好|保存|写好|生成|产出|创建|新建|导出|复制到|移动到|追加|已改写|改写了|覆盖了)/;
// 时间词必须真的带日期/时刻才当成 mtime 报告 —— "已写入 3 个文件 x.md" 里的
// 数字是**个数**, 不是时间, 那种仍算冒领 (前面 (?:最近|上次|末次)? 的部分刻意
// 不参与判定, 否则这半个可选组会把光秃秃的"写入"也吃掉, 真冒领全放行)。
const _MTIME_REPORT_RE = /写入(?:时间|于)|更新(?:时间|于)|mtime|修改时间|创建时间|访问时间|(?:最近|上次|末次)?写入\s*[:：]?\s*(?=\d[\d\-/.:]*[-/:])/gi;

function _claimHasAuthorshipPredicate(claim, text) {
  const c = String(claim || '');
  if (!c) return false;
  for (const line of String(text || '').split('\n')) {
    if (line.indexOf(c) === -1) continue;
    if (_AUTHORSHIP_PREDICATE_RE.test(line.replace(_MTIME_REPORT_RE, ''))) return true;
  }
  return false;
}

function checkDeliveryClaims(sessionId, text, opts) {
  const t = String(text || '');
  if (!t) return null;
  // 写盘声称词 — 缺 "已" 前缀也抓 (实案: "落盘 1 份深拆 .md" / "10案例落盘完成")
  if (!/(落盘|写入|保存|存好|写好|生成|交付|消化完|完成确认|已产出)/.test(t)) return null;
  const mentions = new Set();
  for (const m of t.match(/[~/][\w./一-鿿（）()【】&\-]+\.(?:md|json|docx|pdf|csv|html|txt)/g) || []) mentions.add(m);
  for (const m of t.match(/[《「『\w一-鿿][\w一-鿿（）()【】《》&_\-+.]{0,60}\.md/g) || []) mentions.add(m.replace(/^[《「『]/, ''));
  // 只有**带创作谓词**的路径才进对账。裸路径是引用 (见上面那段现场) ——
  // 引用不该因为"账上没写盘"被拦, 那正好把只读取证任务判成编造。
  const claims = new Set([...mentions].filter((c) => _claimHasAuthorshipPredicate(c, t)));
  const written = collectWrittenFiles(sessionId).map(w => String(w.path || ''));
  // 2026-09-19 幻觉路径归一: 声称路径 expand ~ + 锚仓库根再对账; 本机绝对路径不存在 → 记 paths_missing (幻觉), 不再当"声称写盘"证据
  const _recordMissing = (c) => {
    try {
      const L = loadLedger(sessionId) || _blank(sessionId);
      _push(L.facts.paths_missing, { path: c, via: 'delivery_claim_hallucination', ts: Date.now() }, CAPS.paths_missing, x => x.path);
      saveLedger(sessionId, L);
    } catch (_) {}
  };
  const base = (s) => { const p = s.split('/'); return p[p.length - 1] || s; };
  // 先按 basename 去重保留最长路径 — "output_files/test.md" 和裸 "test.md" 同现时只认前者
  const byBase = new Map();
  for (const c of claims) { const b = base(c); if (!byBase.has(b) || c.length > byBase.get(b).length) byBase.set(b, c); }
  const deduped = [...byBase.values()];
  // 归一: 不存在的声称路径 (幻觉) → 记幻觉名单, 移出对账; 存在的 → 用真实归一路径对账
  const normClaims = new Set();
  for (const c of deduped) {
    const n = normalizeClaimPath(c);
    if (n === null) { _recordMissing(c); continue; }
    normClaims.add(n);
  }
  const _runStart = _runStartedAt(sessionId);
  const missed = [...normClaims].filter(c => {
    const cb = base(c);
    if (written.some(w => w === c || w.endsWith(c) || c.endsWith(w) || (cb && base(w) === cb))) return false;
    if (_writtenDuringRun(c, _runStart)) return false;
    // 2026-10-16 (现场 lt3): 上面那两条只认"**这条 claim 自己那个路径**"。
    // 模型写简写形式很常见 (u1.txt 复制到 /u3.txt, 而不是全路径), 这时 claim 路径
    // 根本不存在, mtime 兜底必然失灵 → 真写过的文件被判"账上无据"。
    // 最后试一次: 在本轮已知写盘所在的目录里, 按 basename 找有没有一个本轮真改写过的。
    // 范围是有限的 (只扫本轮写过文件的父目录), 不是全盘 find, 所以不贵。
    if (cb && _writtenByBasename(cb, written, _runStart)) return false;
    return true;
  });
  if (missed.length) return { missed, written, hallucinated: deduped.filter(c => normalizeClaimPath(c) === null) };
  // 无文件名但有字节/行数声称 + 全程 0 工具 → 无从核验的编造 (21:36:04 实案 "149 行 / 5.6 KB")
  if (opts && opts.toolsThisRun === 0 && /(\d+(\.\d+)?\s*(KB|MB|字节|B)\b|\d+\s*行)/.test(t)) {
    return { missed: ['(无文件名 — 字节/行数声称, 账上无任何写盘可对)'], written };
  }
  return null;
}

module.exports = {
  countDistinctWrittenFiles,
  collectWrittenFiles,
  countWrittenEvents,
  collectCastCharts,
  loadLedger,
  saveLedger,
  recordToolResult,
  recordGoal,
  recordLesson,
  recordRunEnd,
  renderLedgerForSession,
  checkDeliveryClaims,
  _claimHasAuthorshipPredicate,
  _runStartedAt,
  _writtenDuringRun,
  ledgerFile,
};
