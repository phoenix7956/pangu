/**
 * modules/mcp_adapter.js
 * 盘古 · MCP (Model Context Protocol) 适配器（Claude Code 风格）
 * 工具前缀规则 / 5种传输类型 / JSON-RPC 2.0 / 超时控制
 */

const { spawn } = require('child_process');
const http = require('http');
const https = require('https');

const TOOL_PREFIXES = { LONG: 'long_mcp_', DURABLE: 'mmcp_', DEFAULT: 'mcp_' };
const TRANSPORT_TYPES = { STDIO: 'stdio', HTTP: 'http', SSE: 'sse', STREAMABLE_HTTP: 'streamable-http' };

/**
 * 2026-10-24 (第 81 批实测): MCP 协议有**两条**错误通道, 以前只听了一条。
 *
 *   ① JSON-RPC 层: 响应是 `{ error: { code, message } }`
 *      => callTool 直接 reject => _callMcpTool 的 catch => { ok:false } ✅ 这条一直是对的
 *
 *   ② 工具层 (协议规定的**主要**通道): 响应**照样**是 `{ result: {...} }`,
 *      但 result 里带 `isError: true`, 错误正文放在 result.content[].text
 *      => callTool 正常 resolve => 以前一律包成 { ok:true } ❌ 撒谎
 *
 * 现场 (probe80 实跑, /tmp/pangu-single.log): filesystem-mcp 对 /tmp/probe80-work 回的是
 *   { content:[{type:'text',text:'Access denied - path outside allowed directories: /tmp/probe80-work not in /home/you'}],
 *     isError:true }
 * 盘古照样报 `ok=true exec_ms=173` —— 模型以为写成功了, SSE 显示成功,
 * 而磁盘上什么都没有 ⇒ 模型照着"成功"重试/交卷 ⇒ 假交付 + 重试风暴。
 *
 * 修法放在**协议解释层** (_callMcpTool), 不放在某个调用点:
 * native 执行器 / legacy 执行器 / HTTP 的 /api/mcp/call 都走它 ——
 * 判据只有一处, 别的层不用各自记得 (两处各判一次 = 迟早分叉)。
 */

/**
 * 这个 MCP 调用结果是不是"工具层失败"。
 *
 * 判据只看协议字段 `isError === true` —— **不**看错误正文长什么样。
 * (用 "denied" / "error" 这种字符串去猜 = 换个措辞就漏判, 而且会把
 *  成功消息里带 "no error" 字样的结果误判成失败。)
 *
 * @param {object} result MCP CallToolResult
 * @returns {boolean}
 */
function mcpResultIsError(result) {
  return !!(result && typeof result === 'object' && result.isError === true);
}

/**
 * 把工具层失败的正文抠出来 (错误正文在 content[].text 里, 协议规定如此)。
 * 抠不出来就退回结构化内容, 再不行就 JSON 摘要 —— **不许空着**,
 * 空错误正文会让模型以为"失败但不知道为什么", 于是原样重试。
 *
 * @param {object} result MCP CallToolResult
 * @returns {string}
 */
function extractMcpErrorText(result) {
  if (!result || typeof result !== 'object') return '';
  const parts = [];
  const c = result.content;
  if (typeof c === 'string') {
    parts.push(c);
  } else if (Array.isArray(c)) {
    for (const item of c) {
      if (item == null) continue;
      if (typeof item === 'string') { parts.push(item); continue; }
      if (typeof item.text === 'string') parts.push(item.text);
    }
  }
  if (!parts.length) {
    const sc = result.structuredContent;
    if (sc && typeof sc === 'object') {
      if (typeof sc.content === 'string') parts.push(sc.content);
      else if (typeof sc.error === 'string') parts.push(sc.error);
    }
  }
  const text = parts.filter(Boolean).join('\n').trim();
  if (text) return text;
  try { return JSON.stringify(result).slice(0, 500); } catch (_) { return ''; }
}

/**
 * 把 MCP 的 CallToolResult 归一成盘古的工具结果。
 *
 * **真伪判定只在这里做一次** —— `_callMcpTool` (所有 MCP 调用路的唯一入口) 调它,
 * 测试也直接调它。判据 = 协议字段 `isError === true`, 不看错误正文长什么样。
 *
 * @param {object} result MCP CallToolResult
 * @param {string} serverName MCP server 名
 * @param {string} toolName MCP 工具名 (叶子名)
 * @returns {{ok: boolean, data?: object, error?: object}}
 */
function normalizeMcpCallResult(result, serverName, toolName) {
  if (!mcpResultIsError(result)) {
    return { ok: true, data: result };
  }
  const msg = extractMcpErrorText(result);
  return {
    ok: false,
    error: {
      code: 'MCP_TOOL_ERROR',
      message: ('[' + serverName + '/' + toolName + '] ' + (msg || 'MCP 工具返回失败 (isError=true) 但没给错误正文')).slice(0, 800),
      retryable: false,
      fallback_hint: 'MCP server 拒绝了这次调用 —— 按错误正文改路径或参数, 或改用盘古内部工具 (write_file / read_file)。不要原样重试。',
    },
    data: result,          // 原始回执留着: 模型看得见真错误正文, 排查也不丢证据
  };
}

// 2026-08-02 修: launchd 守护进程 PATH 极简 (无 ~/.local/bin / /opt/homebrew/bin),
// 配置里写裸命令名 (node/npx/python3) 时 fs.existsSync + spawn 双 ENOENT → MCP server 全废
// 解: 裸命令名按已知绝对路径解析 — node 直接用 process.execPath (daemon 自己就跑在 node 上)
function _resolveCommand(cmd) {
  if (!cmd || cmd.includes('/')) return cmd;
  const path = require('path');
  const fs = require('fs');
  const os = require('os');
  const candidates = [];
  if (cmd === 'node') candidates.push(process.execPath);
  candidates.push(
    path.join(path.dirname(process.execPath), cmd),          // npx 常与 node 同目录
    path.join(os.homedir(), '.local', 'bin', cmd),
    path.join('/opt/homebrew/bin', cmd),
    path.join('/usr/local/bin', cmd),
    path.join('/usr/bin', cmd)
  );
  for (const c of candidates) {
    try { if (c && fs.existsSync(c)) return c; } catch (_) {}
  }
  return cmd;  // 解析不到保留原样, 让 spawn 报错更明显
}

class MCPAdapter {
  // 2026-10-30 (第 173 批): 加 cwd —— mcp_loader 早就把 cwd 解析出来了, 但这里
  //   从来没往 spawn 传 ⇒ 凡是依赖工作目录的 MCP server (如 comfy-mcp, 它要在
  //   ComfyUI 目录下找模型/工作流) 一律起在错误的地方。
  constructor({ transport = TRANSPORT_TYPES.STDIO, command = null, args = [], env = {}, cwd = null,
    timeoutMs = null, toolTimeouts = null, toolArgDefaults = null } = {}) {
    this.transport = transport;
    this.command = command;
    this.args = args;
    this.env = env;
    this.cwd = cwd;
    // 2026-10-30 (第 173 批): 超时可配。
    //   MCP 工具的默认超时是 30 秒, 而 comfy-mcp 的 run_workflow 真跑一张
    //   1024×1024 Z-Image 要 40 秒+ ⇒ **每一次出图调用都会超时**
    //   (实测 2026-10-30: MCP tool run_workflow timeout after 30000ms,
    //    而 ComfyUI 那边 job 照跑, 图照出 —— 盘古这边只拿到一个超时回执)。
    //   MCP server 自己不声明 long/durable 标记, 所以只能由**配置**侧给覆盖。
    this.timeoutMs = timeoutMs;
    this.toolTimeouts = toolTimeouts || {};
    // 2026-10-30 (第 173 批): 按工具注入默认参数。
    //   背景: comfy-mcp 的 run_workflow 自带 `timeout_seconds` 默认 **110 秒**
    //   (它自己的 docstring 写着「默认 110s 是为了塞进客户端 ~120s 的预算;
    //   长任务请用 wait=False + job(action='wait')」)。
    //   实测 2026-10-30: 真跑一张 1024×1024 Z-Image 要 **242 秒** ⇒
    //   盘古 LLM 不传这个参数, 每一次出图都在 110 秒处失败
    //   (ComfyUI 那边 job 照跑、图照出, 只有盘古拿到一个失败回执 ——
    //    典型的「后台跑成了、前台以为失败」)。
    //   不指望模型记得每次都传 ⇒ 由**配置**给默认值, 调用方没给才注入。
    this.toolArgDefaults = toolArgDefaults || {};
    this._tools = new Map();
    this._client = null;
    this._connected = false;
    this._requestId = 0;
    this._callbacks = {};
    this._baseUrl = null;
    this._httpHeaders = {};
  }

  async connect() {
    if (this.transport !== TRANSPORT_TYPES.STDIO) throw new Error('connect() only for stdio');
    if (!this.command) throw new Error('MCPAdapter: command required');

    return new Promise((resolve, reject) => {
 // 跨平台修: spawn 前展开 args 里的 ${VAR} 占位符
      // Mac/Linux: 用 process.env + this.env 联合
      // Win: cmd.exe 需要 %VAR% 而不是 ${VAR}, 但我们只 spawn bash/node 这类 UNIX 工具, 所以 ${VAR} OK
      const expandedEnv = { ...process.env, ...this.env };
      const expandVars = (s) => String(s).replace(/\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, k) => expandedEnv[k] != null ? expandedEnv[k] : `\${${k}}`);
      const expandedArgs = (this.args || []).map(expandVars);
      const expandedCommand = expandVars(this.command);
      const spawnOpts = { stdio: ['pipe', 'pipe', 'pipe'], env: expandedEnv };
      // 2026-10-30: cwd 只在目录真实存在时才传 —— 传一个不存在的 cwd 给 spawn
      // 会直接抛 ENOENT, 把整个 MCP server 拖死 (比不传更糟)。
      if (this.cwd) {
        try {
          if (fs.existsSync(this.cwd)) spawnOpts.cwd = this.cwd;
          else console.warn('[mcp-adapter] cwd 不存在, 忽略: ' + this.cwd);
        } catch (_) { /* existsSync 失败就当没有 */ }
      }
      this._client = spawn(expandedCommand, expandedArgs, spawnOpts);
      let handshakeDone = false;
      let buffer = '';
      const initRequestId = ++this._requestId;

      this._client.stdout.on('data', (data) => {
        buffer += data.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop();

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const msg = JSON.parse(line);
            if (!handshakeDone) {
              // Client 角色: 等 server 回 initialize 响应
              if (msg.id === initRequestId && msg.result && msg.result.protocolVersion) {
                handshakeDone = true;
                this._connected = true;
                // 送 notifications/initialized 告诉 server 客户端就绪
                this._send({ jsonrpc: '2.0', method: 'notifications/initialized' });
                resolve();
              } else if (msg.id === initRequestId && msg.error) {
                this._client.kill();
                reject(new Error(`MCP handshake error: ${msg.error.message}`));
              }
            } else {
              this._handleMessage(msg);
            }
          } catch {}
        }
      });

      this._client.stderr.on('data', (d) => { console.error('[MCPAdapter stderr]', d.toString()); });
      this._client.on('error', reject);
      this._client.on('exit', (code) => { this._connected = false; if (!handshakeDone) reject(new Error(`MCP server exited with code ${code}`)); });

      // Client 主动发 initialize 请求 (MCP 协议规定)
      this._send({
        jsonrpc: '2.0',
        id: initRequestId,
        method: 'initialize',
        params: {
          protocolVersion: '2024-11-05',
          capabilities: {},
          clientInfo: { name: 'pangu', version: '1.0' },
        },
      });

      setTimeout(() => {
        if (!handshakeDone) {
 // W4-B.7 bug fix: client 可能已被释放或根本未启动, 加 null check + try/catch
          try { if (this._client && typeof this._client.kill === 'function') this._client.kill(); } catch (_) { /* 静默 */ }
          reject(new Error('MCP handshake timeout'));
        }
      }, 30000);
    });
  }

  // ── Tools 同步 (MCP 协议 tools/list) ─────────────────────────────────
  async syncTools() {
    // L4 fix: 统一用 _connected 判断 (stdio/http/sse/ws 四种传输 connect 时都会置 true),
    // 不再混入 _ws.readyState, 避免 STDIO 路径误触 WebSocket 分支的错觉
    if (!this._connected) {
      throw new Error('MCPAdapter: not connected, cannot syncTools');
    }
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      const timeout = setTimeout(() => {
        if (this._callbacks?.[id]) {
          delete this._callbacks[id];
          reject(new Error('MCP tools/list timeout after 10s'));
        }
      }, 10000);
      this._callbacks[id] = (result) => {
        clearTimeout(timeout);
        if (result.error) return reject(new Error(result.error.message));
        const tools = (result.tools || []);
        for (const tool of tools) {
          this.register(tool);
        }
        resolve(tools.length);
      };
      this._send({ jsonrpc: '2.0', id, method: 'tools/list', params: {} });
    });
  }

  async connectHttp(baseUrl, headers = {}) {
    this._baseUrl = baseUrl;
    this._httpHeaders = headers;
    this._connected = true;
  }

  // ── SSE（Server-Sent Events）传输 ──────────────────────────────
  async connectSSE(baseUrl, headers = {}) {
    this._baseUrl = baseUrl;
    this._httpHeaders = headers;
    this._sse = true;
    this._sseBuffer = '';
    const url = new URL(baseUrl);
    const lib = url.protocol === 'https:' ? https : http;
    const opts = {
      hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
      path: url.pathname, method: 'GET',
      headers: { 'Accept': 'text/event-stream', ...this._httpHeaders },
    };
    return new Promise((resolve, reject) => {
      const req = lib.request(opts, (res) => {
        this._connected = true;
        res.on('data', (chunk) => {
          this._sseBuffer += chunk.toString();
          const lines = this._sseBuffer.split('\n');
          this._sseBuffer = lines.pop() || '';
          for (const line of lines) {
            const data = line.replace(/^data: /, '');
            if (!data || data === '[DONE]') continue;
            try { this._handleMessage(JSON.parse(data)); } catch {}
          }
        });
        res.on('end', () => { this._connected = false; });
        resolve();
      });
      req.on('error', reject);
      req.end();
    });
  }

  // ── WebSocket 传输 ───────────────────────────────────
  async connectWs(baseUrl, headers = {}) {
    // WebSocket 需要 ws 模块，检测是否可用
    let WS;
    try { WS = require('ws'); } catch { throw new Error('MCPAdapter: ws 模块未安装（npm install ws）'); }
    this._ws = new WS(baseUrl, { headers });
    return new Promise((resolve, reject) => {
      this._ws.on('open', () => { this._connected = true; resolve(); });
      this._ws.on('message', (data) => {
        try { this._handleMessage(JSON.parse(data.toString())); } catch {}
      });
      this._ws.on('close', () => { this._connected = false; });
      this._ws.on('error', reject);
    });
  }

  _send(msg) {
    if (this._client) {
      this._client.stdin.write(JSON.stringify(msg) + '\n');
    } else if (this._ws && this._ws.readyState === 1) {
      this._ws.send(JSON.stringify(msg));
    } else if (this._baseUrl) {
      const url = new URL(this._baseUrl);
      const postData = JSON.stringify(msg);
      const lib = url.protocol === 'https:' ? https : http;
      const options = {
        hostname: url.hostname, port: url.port || (url.protocol === 'https:' ? 443 : 80),
        // H7 fix: baseUrl 以 '/' 结尾时 url.pathname 可能为空串, POST 无路径会 404
        path: url.pathname || '/', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(postData), ...this._httpHeaders },
      };
      const req = lib.request(options, (res) => {
        let data = '';
        res.on('data', (c) => { data += c; });
        res.on('end', () => { try { this._handleMessage(JSON.parse(data)); } catch {} });
      });
      req.write(postData);
      req.end();
    }
  }

  _handleMessage(msg) {
    if (msg.id && this._callbacks?.[msg.id]) {
      this._callbacks[msg.id](msg.result || msg.error);
      delete this._callbacks[msg.id];
    }
  }

  async callTool(toolName, args = {}, options = {}) {
    const toolDef = this._tools.get(toolName);
    const timeout = options.timeout || toolDef?._timeout || 30000;
    // 默认参数只在「调用方没给」时注入 —— 调用方显式传的值优先。
    const defaults = this.toolArgDefaults?.[toolName];
    let callArgs = args || {};
    if (defaults && typeof defaults === 'object') {
      const merged = { ...defaults };
      for (const [k, v] of Object.entries(args || {})) {
        if (v !== undefined && v !== null) merged[k] = v;
      }
      callArgs = merged;
    }
    return new Promise((resolve, reject) => {
      const id = ++this._requestId;
      this._callbacks[id] = (result) => { if (result.error) reject(new Error(result.error.message)); else resolve(result); };
      this._send({ jsonrpc: '2.0', id, method: 'tools/call', params: { name: toolName, arguments: callArgs } });
      setTimeout(() => {
        if (this._callbacks?.[id]) { delete this._callbacks[id]; reject(new Error(`MCP tool ${toolName} timeout after ${timeout}ms`)); }
      }, timeout);
    });
  }

  register(toolDef) {
    const { name, description, inputSchema, long, durable } = toolDef;
    const prefix = long ? TOOL_PREFIXES.LONG : durable ? TOOL_PREFIXES.DURABLE : TOOL_PREFIXES.DEFAULT;
    const fullName = prefix + name;
    // 超时优先级: 配置里对这个工具的单独覆盖 > server 级默认 > long/durable 标记 > 30 秒
    const cfgToolTimeout = Number(this.toolTimeouts?.[name]);
    const cfgServerTimeout = Number(this.timeoutMs);
    const timeoutMs = Number.isFinite(cfgToolTimeout) && cfgToolTimeout > 0
      ? cfgToolTimeout
      : (Number.isFinite(cfgServerTimeout) && cfgServerTimeout > 0
        ? cfgServerTimeout
        : (long ? 300000 : durable ? 120000 : 30000));
    this._tools.set(name, {
      name, fullName, description: description || `MCP tool: ${name}`,
      parameters: { type: 'object', properties: inputSchema?.properties || {}, required: inputSchema?.required || [] },
      // 2026-10-24 (第 79 批实测): **单位错配** —— 这里原来写的是秒
      //   (long ? 300 : durable ? 120 : 30), 而 callTool 是 `setTimeout(..., timeout)`,
      //   按**毫秒**用 ⇒ 默认 MCP 工具的超时是 **30 毫秒**。
      //   现场证据 (实跑 probe79-mcp, kun 调 mcp__filesystem-mcp__read_file):
      //     MCP tool read_file timeout after 30ms
      //   也就是说 MCP 工具**每一次调用都会立刻超时**, 一个都跑不成 ——
      //   而上面那层看起来一切正常 (schema 有它、执行路由通了、错误码还是 retryable),
      //   于是模型会以为"这个工具坏了", 换姿势重试两次再放弃。
      //   全链路的 timeout 一律毫秒 (默认 30000ms), 这里跟着走。
      _mcp: true, _timeout: timeoutMs, _raw: toolDef,
    });
    return fullName;
  }

  /**
   * 把 MCP tool 转成 Pangu in-process tool schema (函数调用格式)
   * Phase 2 集成: 可被 getAllToolSchemas() 合并
   *
   * @param {object} mcpTool MCP tool 对象
   * @param {string} serverName MCP server 名(用于 namespace)
   * @returns {object} Pangu tool schema (function calling 格式)
   */
  toPanguToolSchema(mcpTool, serverName) {
    const namespacedName = `mcp__${serverName}__${mcpTool.name}`;
    return {
      type: 'function',
      function: {
        name: namespacedName,
        description: mcpTool.description || `MCP tool: ${mcpTool.name}`,
        parameters: mcpTool.parameters || { type: 'object', properties: {} },
      },
      _mcp: true,
      _mcpServer: serverName,
      _mcpToolName: mcpTool.name,
      _timeout: mcpTool._timeout || 30000,
    };
  }

  /**
   * Phase 2 辅助: 从 _mcpAdapters 拉所有 tools 转 Pangu schema
   * @param {Array<{name: string, adapter: MCPAdapter}>} mcpAdapters
   * @returns {Array} Pangu tool schema 数组
   */
  static collectPanguToolSchemas(mcpAdapters) {
    const schemas = [];
    for (const { name, adapter } of mcpAdapters) {
      for (const mcpTool of adapter.listTools()) {
        schemas.push(adapter.toPanguToolSchema(mcpTool, name));
      }
    }
    return schemas;
  }

  listTools() { return Array.from(this._tools.values()); }
  toPanguTool(mcpTool) { return { name: mcpTool.fullName, description: mcpTool.description, parameters: mcpTool.parameters, _timeout: mcpTool._timeout, _mcp: true, _mcpRaw: mcpTool._raw }; }
  isConnected() { return this._connected || !!(this._ws && this._ws.readyState === 1); }
  disconnect() {
    if (this._client) { this._client.kill(); this._client = null; }
    if (this._ws) { this._ws.close(); this._ws = null; }
    this._connected = false;
  }
}

// P0-#34 (batch1) Item 2: _setServers hook (TL-3 漏) — 给 pangu-single.js 调,
// 让 daemon 启动时 spawn 多个 MCPAdapter (每个 server 一个), 之前 pangu-single.js
// 调 mcpAdapter._setServers 不存在直接 warn skip, 5 server 全 0 进程
// §0.50 真统计: 修后 pgrep -fl "mcp_servers/" 必须有 N PID
const _multiAdapters = new Map();  // name -> adapter
async function _setServers(servers) {
  // 清旧 adapter
  for (const [name, adp] of _multiAdapters) {
    try { await adp.disconnect(); } catch (_) {}
    _multiAdapters.delete(name);
  }
  // spawn 每个 enabled server
  for (const s of servers || []) {
    if (s.enabled === false) continue;
    if (!s.command) { console.warn('[mcp-multi] ' + (s.name || s.id || '?') + ' no command, skip'); continue; }
    try {
      s.command = _resolveCommand(s.command);
      const adp = new MCPAdapter({
        transport: TRANSPORT_TYPES.STDIO,
        command: s.command,
        args: s.args || [],
        env: s.env || {},
        cwd: s.cwd || null,
        // 2026-10-30 (第 173 批): 超时覆盖从配置来 (mcp_servers.json 的
        //   timeoutMs / toolTimeouts) —— 见 register() 里的优先级说明。
        timeoutMs: s.timeoutMs || null,
        toolTimeouts: s.toolTimeouts || null,
        toolArgDefaults: s.toolArgDefaults || null,
      });
      await adp.connect();
      _multiAdapters.set(s.name || s.id || s.command, adp);
      console.log('[mcp-multi] spawned ' + (s.name || s.id) + ' cmd=' + s.command);
      // 2026-08-02 根治 (老板: "你的mcp没有工具吗?"): connect 后必须 syncTools —
      // 之前没调, _tools 恒空 → listTools()=0 → LLM schema 里 0 个 MCP 工具;
      // 而 /api/mcp/servers 是硬编码 stub 显示"connected 4 tools", 全是假的
      try {
        const _n = await adp.syncTools();
        console.log('[mcp-multi] ' + (s.name || s.id) + ' tools synced: ' + _n);
      } catch (e2) {
        console.warn('[mcp-multi] ' + (s.name || s.id) + ' syncTools failed: ' + e2.message.slice(0, 150));
      }
    } catch (e) {
      console.warn('[mcp-multi] spawn failed for ' + (s.name || s.id) + ': ' + e.message.slice(0, 200));
    }
  }
  console.log('[mcp-multi] active servers: ' + _multiAdapters.size);
}
function _listServers() { return Array.from(_multiAdapters.keys()); }

// 2026-07-26 老板拍: 内部工具 / MCP 工具分开统计 + MCP 工具对 LLM 可见可调
function _toolStats() {
  const perServer = {};
  let tools = 0;
  for (const [name, adp] of _multiAdapters) {
    const n = adp.listTools().length;
    perServer[name] = n;
    tools += n;
  }
  return { servers: _multiAdapters.size, tools, perServer };
}

// 从所有 active adapter 收集 Pangu 格式 schema (注入 LLM tools 用)
function _collectAllToolSchemas() {
  const schemas = [];
  for (const [name, adp] of _multiAdapters) {
    for (const t of adp.listTools()) {
      schemas.push(adp.toPanguToolSchema(t, name));
    }
  }
  return schemas;
}

// mcp__<server>__<tool> 路由调用 (agent loop 执行层入口)
async function _callMcpTool(namespacedName, params) {
  const m = String(namespacedName || '').match(/^mcp__(.+)__(.+)$/);
  if (!m) return { ok: false, error: { code: 'MCP_BAD_NAME', message: 'bad mcp tool name: ' + namespacedName, retryable: false } };
  const adp = _multiAdapters.get(m[1]);
  if (!adp) return { ok: false, error: { code: 'MCP_SERVER_DOWN', message: 'MCP server not active: ' + m[1] + ' (active: ' + Array.from(_multiAdapters.keys()).join(',') + ')', retryable: true } };
  try {
    const result = await adp.callTool(m[2], params || {});
    // 2026-10-24 (第 81 批): 工具层失败 (result.isError) 以前一律包成 { ok:true } ——
    //   实测 (probe80): filesystem-mcp 明明白白回了 "Access denied - path outside
    //   allowed directories", 盘古照样报 ok=true。模型据此以为写成功 ⇒ 假交付 + 重试风暴。
    //   判据落在 normalizeMcpCallResult (纯函数, 唯一一处)。
    return normalizeMcpCallResult(result, m[1], m[2]);
  } catch (e) {
    return { ok: false, error: { code: 'MCP_CALL_FAILED', message: e.message, retryable: true } };
  }
}

module.exports = { MCPAdapter, TRANSPORT_TYPES, TOOL_PREFIXES, collectPanguToolSchemas: MCPAdapter.collectPanguToolSchemas, _setServers, _listServers, _toolStats, _collectAllToolSchemas, _callMcpTool, _resolveCommand, mcpResultIsError, extractMcpErrorText, normalizeMcpCallResult, _multiAdapters };
module.exports.createMCPAdapter = (config) => new MCPAdapter(config);
