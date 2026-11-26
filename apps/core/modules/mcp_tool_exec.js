/**
 * modules/mcp_tool_exec.js —— MCP 工具的**执行路由**与**只读边界**
 *
 * 2026-10-24 (第 79 批)。这个文件是为了补三处实测出来的断点:
 *
 *   (1) 签名层: native 路径的 API schema 以前一个 `mcp__` 工具都没有
 *       => 模型看得见提示词里那 44 个 MCP 工具的名字, 却一个都**签不出来**
 *       (提示词写着「跟内部工具一样直接用」, 而 toolsSchema 只从 TOOLS_SCHEMA 取,
 *        那里 `mcp__` 开头的工具是 0 个)。已修: j2_agent_loop 把 MCP schema
 *        并进 worker 的 toolsSchema (只给 worker, 不给 main)。
 *
 *   (2) 执行层: **只修签名等于没修**。
 *       j2_agent_loop 的 native 路径执行工具是 `TOOLS[tc.name](...)`,
 *       而 TOOLS 表里 `mcp__` 开头的工具是 **0 个** => 模型签得出来, 一调就炸
 *       ("TOOLS[...] is not a function")。
 *       legacy 那条路 (pangu-single.js 的 `_j2ExecuteToolCalls`) **有** `mcp__` 路由,
 *       native 这条**没有** —— 而本地模型 (LM Studio) 走的就是 native。
 *       => 两路必须走**同一个**入口, 否则又是一套"配了但不生效"。
 *
 *   (3) 只读边界: 内部工具那边有 action_policy 闸着 (只读角色不许 write_file),
 *       MCP 这边**没有** => 只读角色 (analyzer/checker/...) 拿到
 *       `mcp__filesystem-mcp__write_file` 就破了"只读"承诺, 而它不在任何角色的
 *       白名单里 (白名单只管内部工具)。这里补上, 判据是**代码**, 不是提示词里的承诺。
 *
 * 刻意不做的事: 不在这里改 schema, 不在这里判角色白名单。
 * 那两件事分别在 j2_agent_loop (签名) 与 action_policy (执行闸) 里, 各归各位。
 */

// MCP 工具的命名格式: mcp__<server>__<tool>
const MCP_PREFIX = 'mcp__';

/**
 * @param {string} name
 * @returns {boolean} 是不是 MCP 工具名
 */
function isMcpToolName(name) {
  if (typeof name !== 'string') return false;
  if (!name.startsWith(MCP_PREFIX)) return false;
  // 必须还有一段 server__tool => 光 "mcp__" 不算 (那不是任何工具)
  return name.indexOf('__', MCP_PREFIX.length) > MCP_PREFIX.length;
}

/**
 * 叶子名 (不含 server 前缀): mcp__filesystem-mcp__write_file -> write_file
 * @param {string} name
 * @returns {string}
 */
function mcpLeafName(name) {
  if (!isMcpToolName(name)) return '';
  const parts = String(name).split('__');
  return parts[parts.length - 1] || '';
}

/**
 * 已知**只读**的 MCP 工具叶子名。
 *
 * 这里是**白名单**, 不是黑名单 —— 名单外的叶子一律按"会改状态"处理 (fail-closed)。
 * 理由: MCP server 是外部进程, 盘古不知道它将来会加什么工具;
 * 黑名单漏一个 = 只读角色写盘没人拦。白名单漏一个 = 只读角色少调一个工具,
 * 代价小得多 (而且只读角色本来就不该写盘)。
 *
 * 逐个核过 44 个工具的语义 (2026-10-24):
 *   github-mcp     读: search_* / get_* / list_*
 *                  写: create_* / update_* / push_files / fork_* / merge_* / add_issue_comment
 *   filesystem-mcp 读: read_* / list_* / search_files / get_file_info / directory_tree
 *                  写: write_file / edit_file / create_directory / move_file
 *   pixel2motion   读: audit_svg (只出审计报告)
 *                  写: capture_frames (落 PNG) / animate_logo_svg (落 HTML) / fit_svg (落 SVG)
 */
const MCP_READONLY_LEAVES = new Set([
  // filesystem-mcp
  'read_file', 'read_text_file', 'read_media_file', 'read_multiple_files',
  'list_directory', 'list_directory_with_sizes', 'directory_tree',
  'search_files', 'get_file_info', 'list_allowed_directories',
  // github-mcp
  'search_repositories', 'search_code', 'search_issues', 'search_users',
  'get_file_contents', 'get_issue', 'get_pull_request',
  'list_commits', 'list_issues', 'list_pull_requests',
  'get_pull_request_files', 'get_pull_request_status',
  'get_pull_request_comments', 'get_pull_request_reviews',
  // pixel2motion
  'audit_svg',
]);

/**
 * 这个 MCP 工具会不会改状态?
 * @param {string} name 完整工具名 (mcp__server__tool)
 * @returns {boolean} true = 会改状态 (只读角色不许调)
 */
function isMcpMutatingTool(name) {
  if (!isMcpToolName(name)) return false;
  const leaf = mcpLeafName(name);
  if (!leaf) return true;              // 认不出来 => 按会改状态处理 (fail-closed)
  return !MCP_READONLY_LEAVES.has(leaf);
}

/**
 * 真调 MCP 工具。**唯一**执行入口 (native / legacy 都走它)。
 *
 * @param {string} name 完整工具名 (mcp__server__tool)
 * @param {object} params
 * @returns {Promise<object>} { ok, data?, error? }
 */
async function execMcpTool(name, params) {
  // 延迟 require: mcp_adapter 在 require 时会带起 stdio 子进程管理,
  // 放进模块顶层会让所有 import 它的地方都付出这个代价。
  const { _callMcpTool } = require('./mcp_adapter');
  return await _callMcpTool(name, params || {});
}

module.exports = {
  MCP_PREFIX,
  MCP_READONLY_LEAVES,
  isMcpToolName,
  mcpLeafName,
  isMcpMutatingTool,
  execMcpTool,
};
