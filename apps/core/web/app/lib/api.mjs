// api.mjs —— 盘古后端 API 映射 (浏览器版)
//
// 2026-10-27 (第 117 批): 从原版 `apps/desktop/src/lib/api.js` (git 110661d^) 原样搬过来,
//   只砍掉 Tauri 分支 —— core 就在同机, 浏览器直接 fetch 相对路径。
//   **端点清单不许自己发挥**: 原版调得动的, 这里就调得动; 后端死了这里就红。
//   唯一改动: 原版 `panguUrl` 在浏览器里拼 '/api' + path, 这里直接写**规范路径**,
//   省掉一层前缀拼接 (也免得 'api' 拼两次)。
//
// 2026-10-28 (第 141 批): 端点一律**相对** ('api/version' 而不是 '/api/version')。
//   盘古可能被挂在 nginx 的 /pangu/ 这种子路径下 —— 前端写死前导斜杠就会丢前缀。
//   相对地址由浏览器按当前文档基址解析, 前缀不用前端知道。

async function call(method, path, body, opts = {}) {
  const timeoutMs = typeof opts.timeoutMs === 'number' ? opts.timeoutMs : 30000;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    // endpoint 是用户在「设置 · 连接」里手填的**绝对**服务器地址 (可以为空 = 同源)。
    //   它跟站内相对路径是两回事: 拼的时候自己补一个斜杠 (相对路径不带前导斜杠了)。
    const url = endpoint ? endpoint + '/' + path.replace(/^\/+/, '') : path;
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined || body === null ? undefined : JSON.stringify(body),
      signal: ctrl.signal,
    });
    const text = await res.text();
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) { parsed = { ok: false, raw: text }; }
    if (!res.ok) {
      return { ...parsed, ok: false, status: res.status, statusText: res.statusText || '', httpError: true };
    }
    return parsed;
  } catch (e) {
    return {
      ok: false,
      error: errorMessage(e),
      timeout: ctrl.aborted,
    };
  } finally {
    clearTimeout(timer);
  }
}

export function errorMessage(error, fallback = '请求失败') {
  if (typeof error === 'string' && error.trim()) return error;
  if (error && typeof error === 'object') {
    if (typeof error.message === 'string' && error.message.trim()) return error.message;
    if (typeof error.error === 'string' && error.error.trim()) return error.error;
    if (error.error && typeof error.error.message === 'string' && error.error.message.trim()) {
      return error.error.message;
    }
    if (typeof error.code === 'string' && error.code.trim()) return error.code;
  }
  return fallback;
}

// 2026-10-19 老板: 「显示太复杂, 大面积, 谁会看?」
// 编排内部的报错原样上屏 = 英文角色名 + 英文堆栈短语, 占掉一整张气泡卡。
// 只把**已知**的内部角色名换成人话, 底下那句真因留着; 认不出来的原样返回 ——
// 宁可没翻译, 不要翻译错。
export function humanizeStreamError(raw) {
  const s = String(raw || '').trim();
  if (!s) return '出错了, 已记日志';
  const rules = [
    [/^Planner failed:\s*(.+)$/i, (m) => `拆解没成功, 已自动改走其他路径（${m}）`],
    [/^(Read )?ECONNRESET$/i, () => '本地模型连接被重置, 已自动重试'],
    [/^ETIMEDOUT$/i, () => '本地模型响应超时, 已自动重试'],
  ];
  for (const [re, fn] of rules) {
    const m = s.match(re);
    if (m) return fn(m);
  }
  return s;
}

const q = (v) => encodeURIComponent(v == null ? '' : String(v));

// 后端地址: 空串 = 同源 (浏览器工作台默认)。
// 设置页「连接」里填了绝对地址就切过去 —— 这样那个输入框是真的有用, 不是摆设。
let endpoint = '';

export function setEndpoint(v) {
  endpoint = String(v || '').trim().replace(/\/+$/, '');
  return endpoint;
}

export function getEndpoint() {
  return endpoint;
}

export const api = {
  // ── 基础 ──────────────────────────────────────────────────────
  health: () => call('GET', 'health'),
  config: () => call('GET', 'config'),
  patchConfig: (patch) => call('PATCH', 'config', patch),
  license: () => call('GET', 'api/license/status'),
  modules: () => call('GET', 'modules'),
  version: () => call('GET', 'api/version'),
  nodes: () => call('GET', 'nodes'),
  cleanup: () => call('POST', 'cleanup'),
  panguRestart: () => call('POST', 'api/pangu/restart', {}, { timeoutMs: 8000 }),

  // ── 语音 ──────────────────────────────────────────────────────
  voiceDevices: () => call('GET', 'api/voice/devices'),
  voiceStatus: () => call('GET', 'api/voice/status'),

  // ── 技能 / 卦 / 历史 ───────────────────────────────────────────
  skills: () => call('GET', 'skills'),
  hexagrams: () => call('GET', 'hexagrams'),
  hexagram: (id) => call('GET', 'hexagram/' + q(id)),
  history: () => call('GET', 'sessions'),
  sessionRead: (date) => call('GET', 'sessions/' + q(date)),
  sessionDelete: (date) => call('DELETE', 'sessions/' + q(date), { confirm: true }),
  sessionClearAll: async () => {
    const list = await call('GET', 'sessions');
    if (!list || !list.ok) {
      return { ok: false, error: (list && list.error) || 'SESSION_LIST_FAILED', status: list && list.status };
    }
    const dates = (list.data && list.data.sessions) || list.sessions || [];
    let ok = 0;
    let fail = 0;
    for (const d of dates) {
      const date = typeof d === 'string' ? d : d.date;
      const r = await call('DELETE', 'sessions/' + q(date));
      if (r && r.ok) ok++; else fail++;
    }
    return {
      ok: fail === 0,
      deleted: ok,
      failed: fail,
      total: dates.length,
      error: fail ? 'SESSION_DELETE_PARTIAL' : undefined,
    };
  },

  // ── 活跃会话 (JSON, 侧栏会话列表) ─────────────────────────────
  agentSessionList: (limit = 20) => call('GET', 'api/pangu/agent/sessions?limit=' + q(limit)),
  agentSessionRead: (id) => call('GET', 'api/pangu/agent/sessions/' + q(id)),
  agentSessionDelete: (id) => call('DELETE', 'api/pangu/agent/sessions/' + q(id), { confirm: true }),

  // ── 断点续跑 ──────────────────────────────────────────────────
  checkpointGet: (sessionId) => call('GET', 'api/pangu/agent/checkpoint?sessionId=' + q(sessionId)),
  checkpointList: (sessionId, limit = 20) => call('GET',
    'api/pangu/agent/checkpoint/list?sessionId=' + q(sessionId) + '&limit=' + q(limit)),
  checkpointClear: (sessionId) => call('DELETE', 'api/pangu/agent/checkpoint?sessionId=' + q(sessionId), { confirm: true }),

  // ── 交付闭环 ──────────────────────────────────────────────────
  outcomeList: (sessionId, limit = 50) => call('GET',
    'api/pangu/agent/outcome?sessionId=' + q(sessionId) + '&limit=' + q(limit)),
  outcomeStats: () => call('GET', 'api/pangu/agent/outcome/stats'),

  // ── 权限 ──────────────────────────────────────────────────────
  permissionRespond: (token, approved, reason) =>
    call('POST', 'api/pangu/agent/permission/respond', { token, approved, reason }),
  permissionPending: (sessionId) =>
    call('GET', 'api/pangu/agent/permission/pending?sessionId=' + q(sessionId)),
  permissionGet: (sessionId) =>
    call('GET', 'api/pangu/permission/level' + (sessionId ? '?sessionId=' + q(sessionId) : '')),
  permissionSet: (body) => call('PUT', 'api/pangu/permission/level',
    typeof body === 'string' ? { level: body } : body),

  // ── 自愈 / 自进化 ─────────────────────────────────────────────
  selfRepairGet: () => call('GET', 'api/pangu/self-repair'),
  // 第 172 批: 盘古自己的微信通道 (直连 iLink, 不经老 openclaw 桌面端)
  weixinStatus: () => call('GET', 'api/pangu/weixin/status'),
  weixinSend: (body) => call('POST', 'api/pangu/weixin/send', body, { timeoutMs: 20000 }),
  evolutionDryRun: () => call('POST', 'api/pangu/evolution/dry-run'),
  evolutionAutoImprove: () => call('POST', 'api/pangu/evolution/auto-improve'),
  evolutionLast: () => call('GET', 'api/pangu/evolution/last'),
  // 第 176 批: 进化页 (逐日账本画图用)
  //   evolution      = 汇总 + 最近 20 条 (老端点, 状态/命令行也在用)
  //   evolutionSeries = **逐日序列** (画趋势图要的就是它)
  evolution: () => call('GET', 'api/pangu/evolution'),
  evolutionSeries: () => call('GET', 'api/pangu/evolution/series'),

  // ── housekeeping / 预算 / 分级 ────────────────────────────────
  housekeepingStats: () => call('GET', 'api/pangu/housekeeping/stats'),
  housekeepingRun: () => call('POST', 'api/pangu/housekeeping/run'),
  budgetGet: (sessionId) => call('GET', 'api/pangu/budget?sessionId=' + q(sessionId)),
  budgetGlobal: () => call('GET', 'api/pangu/budget/global'),
  budgetClear: (sessionId) => call('DELETE', 'api/pangu/budget?sessionId=' + q(sessionId), { confirm: true }),
  tiersList: () => call('GET', 'api/pangu/tiers'),
  tiersGet: (id, sessionId) =>
    call('GET', 'api/pangu/tiers/' + q(id) + (sessionId ? '?sessionId=' + q(sessionId) : '')),

  // ── 工具 ──────────────────────────────────────────────────────
  panguTools: () => call('GET', 'api/pangu/tools'),
  toolsToggle: (name, enabled) => call('POST', 'api/tools/toggle', { name, enabled }),
  toolSchema: (name) => call('GET', 'api/tools/schema/' + q(name)),
  toolTest: (name, params) => call('POST', 'api/tools/test', { name, params: params || {} }),

  // ── 兼容对话端点 (第 119 批: 八字排盘的分项解读用它) ──────────
  // 非流式: 一次请求一次答复。默认超时给到 150s —— 后端自己也有 timeout_ms,
  // 客户端的 AbortController 比它短的话, 会先被前端掐掉。
  chat: (body, opts) => call('POST', 'api/chat', body, { timeoutMs: 150000, ...(opts || {}) }),

  // ── MCP ───────────────────────────────────────────────────────
  mcpServers: () => call('GET', 'api/mcp/servers'),
  mcpTools: () => call('GET', 'api/mcp/tools'),
  mcpCall: (server, tool, args) => call('POST', 'api/mcp/call', { server, tool, args }),
  mcpRestart: (server) => call('POST', 'api/mcp/restart', { server }),
  mcpAdd: (server) => call('POST', 'api/mcp/servers', server),
  mcpDelete: (server) => call('DELETE', 'api/mcp/servers/' + q(server)),
  mcpUpdate: (server, patch) => call('PATCH', 'api/mcp/servers/' + q(server), patch),

  // ── 技能库 ────────────────────────────────────────────────────
  listPanguSkills: () => call('GET', 'api/pangu/skills'),
  createPanguSkillForm: (spec) => call('POST', 'api/pangu/skills/create-from-form', spec),
  importSkillFromPath: (path) => call('POST', 'api/pangu/skills/import-from-path', { path }),
  importSkillFromUrl: (url) => call('POST', 'api/pangu/skills/import-from-url', { url }),
  deletePanguSkill: (name) => call('DELETE', 'api/pangu/skills/' + q(name)),
  convertPanguSkillToMcp: (name) => call('POST', 'api/pangu/skills/' + q(name) + '/convert-to-mcp'),

  // ── 模型池 ────────────────────────────────────────────────────
  modelsList: () => call('GET', 'api/llm/models'),
  modelsRouting: () => call('GET', 'api/llm/routing'),
  modelsRoutingRefresh: () => call('POST', 'api/llm/routing/refresh', {}, { timeoutMs: 60000 }),
  modelsTestConnection: (body) => call('POST', 'api/llm/test-connection', body, { timeoutMs: 20000 }),
  presetsList: () => call('GET', 'api/llm/presets'),
  modelsAddFromPreset: (presetKey, override) =>
    call('POST', 'api/llm/models', { action: 'add_from_preset', preset_key: presetKey, override }),
  modelsAdd: (model) => call('POST', 'api/llm/models', { action: 'add', model }),
  modelsUpdate: (model) => call('POST', 'api/llm/models', { action: 'update', model }),
  modelsDelete: (id) => call('POST', 'api/llm/models', { action: 'delete', id }),
  modelsUse: (id) => call('POST', 'api/llm/use', { id }),
  providerModelsRefresh: (provider, extra) =>
    call('POST', 'api/llm/provider-models/refresh', { provider, ...(extra || {}) }, { timeoutMs: 15000 }),
  providerModelAdd: (provider, id) =>
    call('POST', 'api/llm/provider-models/add', { provider, id }, { timeoutMs: 15000 }),
  probeVision: (idOrModel) => call('POST', 'api/llm/probe-vision',
    typeof idOrModel === 'string' ? { id: idOrModel } : { model: idOrModel }, { timeoutMs: 35000 }),
  lmstudioDiscover: () => call('GET', 'api/llm/lmstudio-discover'),
  lmstudioApply: (opts) => call('POST', 'api/llm/lmstudio-discover/apply', opts || {}),
  syncCapabilities: () => call('POST', 'api/llm/sync-capabilities', {}, { timeoutMs: 30000 }),
  capabilitiesStatus: () => call('GET', 'api/llm/capabilities-status'),
  selfReport: (opts) => call('POST', 'api/llm/self-report', opts || {}, { timeoutMs: 35000 }),

  // ── 决策 / 派单 ───────────────────────────────────────────────
  programmingJudgment: (params) => call('POST', 'api/pangu/decide', params, { timeoutMs: 60000 }),
  decideAll: (params) => call('POST', 'api/pangu/decide-all', params, { timeoutMs: 120000 }),
  dispatch: (input) => call('POST', 'api/pangu/dispatch', { task: input }, { timeoutMs: 15000 }),

  // ── 凭证 ──────────────────────────────────────────────────────
  credentialsList: () => call('GET', 'api/credentials/list'),
  credentialsSet: (name, value, note = '', enabled = true) =>
    call('POST', 'api/credentials/set', { name, value, note, enabled }),
  credentialsToggle: (name, enabled) => call('POST', 'api/credentials/toggle', { name, enabled }),
  credentialsRemove: (name) => call('POST', 'api/credentials/remove', { name }),

  // ── 技能市场 ──────────────────────────────────────────────────
  marketplaceList: (params) => call('GET',
    'api/marketplace/list' + (params ? '?' + new URLSearchParams(params).toString() : '')),
  marketplaceInstalled: () => call('GET', 'api/marketplace/installed'),
  marketplaceInstall: (idOrPkg) => call('POST', 'api/marketplace/install', { id: idOrPkg }),
  marketplaceUninstall: (name) => call('POST', 'api/marketplace/uninstall', { name }),
  marketplaceDetail: (id) => call('GET', 'api/marketplace/detail/' + q(id)),
  marketplaceInternal: () => call('GET', 'api/marketplace/internal'),
  marketplaceInternalLayout: (order) => call('POST', 'api/marketplace/internal/layout', { order }),

  // ── 将灵 ──────────────────────────────────────────────────────
  subagentRuns: () => call('GET', 'api/pangu/subagents/runs'),
  subagentRoles: () => call('GET', 'api/pangu/subagents/roles'),
};

if (typeof window !== 'undefined') window.PG_api = api;

