'use strict';
// 盘古**状态子目录**的解析真源 (2026-10-26 第 100 批)
//
// 为什么要有这个模块:
//   主体里的状态目录一律是 `path.join(PANGU_HOME, 'state', '<名字>')` 拼出来的,
//   而沙箱只导走了其中一部分 (CHECKPOINT / OUTCOMES / PLAN / TASK / HANDOFF / EVO)。
//   剩下的 (ledger / compaction / harness runs) **每跑一次链就往生产写一批测试产物**。
//
//   实测 (2026-10-26 第 100 批, 跑链窗口内 diff 生产 ~/.pangu):
//     state/harness/runs  72 个   (内容全是 r24-chain-exhaust / j2-gate-behavior 等测试会话)
//     state/ledger        31 个   (roletest / test-delivery-* / wcmd-* —— wcmd 读的还是 /tmp 临时文件)
//     state/compaction     5 个   (unit-compact-* )
//     ─────────────────────────
//     合计               104 个测试产物进了生产
//
// 规则 (按优先级):
//   1) PANGU_<NAME>_DIR —— **专用开关**。测试沙箱用它把该目录整体导走。
//   2) PANGU_HOME/state/<相对路径> —— 状态根约定。
//   3) ~/.pangu/state/<相对路径> —— 生产默认。
//
// ⚠️ 跟第 100 批给账本目录 (modules/evolution_paths.js) 是同一套思路:
//   沙箱开关必须是**专用**变量, 不能复用 PANGU_HOME ——
//   那个变量在 boot.js / mcp_loader.js 里是**应用根目录**, 一名两义, 当沙箱开关迟早出事。
//
// ⚠️ 本模块只管**状态子目录**; L1/L2 进化账本走 evolution_paths.js (两套规则别混)。

const os = require('os');
const path = require('path');

// 状态根 (PANGU_HOME 优先, 否则 ~/.pangu)
function stateRoot() {
  return process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
}

// 通用: 按 state 下的相对路径解析 (envKey 是专用沙箱开关名)
function stateSubDir(relPath, envKey) {
  if (envKey && process.env[envKey]) return process.env[envKey];
  return path.join(stateRoot(), 'state', relPath);
}

// 任务账本 (session 的 facts/lessons 落盘)
function ledgerDir() {
  return stateSubDir('ledger', 'PANGU_LEDGER_DIR');
}

// harness 根目录 (refine 流程的产物)
function harnessDir() {
  return stateSubDir('harness', 'PANGU_HARNESS_DIR');
}

// 压缩快照
function compactionDir() {
  return stateSubDir('compaction', 'PANGU_COMPACTION_DIR');
}

// 运行轨迹 (harness runs)
function runTraceDir() {
  if (process.env.PANGU_RUN_TRACE_DIR) return process.env.PANGU_RUN_TRACE_DIR;
  return path.join(harnessDir(), 'runs');
}

// 根级散文件 (alignment-blocked.jsonl 之类)
function rootFile(name, envKey) {
  if (envKey && process.env[envKey]) return process.env[envKey];
  return path.join(stateRoot(), name);
}

function alignmentAuditFile() {
  return rootFile('alignment-blocked.jsonl', 'PANGU_ALIGNMENT_AUDIT_FILE');
}

module.exports = {
  stateRoot,
  stateSubDir,
  ledgerDir,
  harnessDir,
  compactionDir,
  runTraceDir,
  rootFile,
  alignmentAuditFile,
};
