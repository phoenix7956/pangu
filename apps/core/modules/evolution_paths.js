'use strict';
// L1/L2 进化账本目录的**唯一解析规则** (2026-10-26 第 100 批)
//
// 为什么必须有这个模块:
//   账本目录在主体里有 7+ 处各自硬编码 `~/.pangu/evolution` ——
//   写方 (modules/evolution_record.js) 和读方 (agents/self-evolution.js /
//   modules/router/smart_router.js / modules/llm_caller.js /
//   pangu-single/routes/inline_router.js / pangu-single/routes/pangu-meta.js /
//   scripts/l2-miner.js / bin/pangu-repair-watcher.js) 各写一份。
//   只要有一处漏改, 就出现**读写分裂**: 写进沙箱、却从生产读 ——
//   测试读到陈旧生产数据, 结论全是假的 (2026-10-15 沙箱守卫注释里记过这个坑:
//   force-compact 那次把刚写的 17 条读成 4 条)。
//
// 解析规则 (按优先级):
//   1) PANGU_EVO_DIR —— **专用开关**。测试沙箱用它把账本整体导走。
//   2) PANGU_HOME   —— 状态根约定 (l3_dispatcher / compaction / housekeeping /
//      peer_message / checkpoint / self-evolution 都用它指 ~/.pangu)。
//      账本 = $PANGU_HOME/evolution。
//   3) ~/.pangu/evolution —— 生产默认。
//
// ⚠️ 为什么沙箱开关不直接用 PANGU_HOME:
//   那个变量在 boot.js / mcp_loader.js 里是**应用根目录**,
//   在状态目录那一族里是**状态根** —— 同名两义。
//   拿它当沙箱开关, 迟早在某个模块里指向错的地方 (第 100 批已经踩过一次)。
//   ⇒ 沙箱专用开关必须是**独立**的 PANGU_EVO_DIR。
//
// ⚠️ 解析必须在**调用时**做, 不能在模块顶层:
//   测试常在 require 之后才设环境变量。

const os = require('os');
const path = require('path');

// 状态根 (PANGU_HOME 优先, 否则 ~/.pangu)
function stateRoot() {
  return process.env.PANGU_HOME || path.join(os.homedir(), '.pangu');
}

// L1 账本目录 (每天一个 <date>.jsonl)
function evolutionDir() {
  return process.env.PANGU_EVO_DIR || path.join(stateRoot(), 'evolution');
}

// L2 聚合目录 (l2/<date>.json)
function evolutionL2Dir() {
  return path.join(evolutionDir(), 'l2');
}

module.exports = { evolutionDir, evolutionL2Dir, stateRoot };
