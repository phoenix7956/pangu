'use strict';

// 2026-10-14: 清 ~/.pangu/models-registry.json 里的坟场条目。
//
// registry 以前只进不出 —— 每次探到新模型就 setContextLength 写一条, 从没人删。
// 现场 24 条里混着: 4 条 r46-*/test-model 测试垃圾、3 条 mlx-serve 死条目(端口早 DEAD)、
// 2 条幽灵(google_gemma-4-26b-a4b-qat / qwen_qwen3.6-35b-a3b, ctx 185386/185378 ——
// 这两个正是曾经躺在 fallback_chain 里、池里根本不存在的幽灵引用)、
// 1 条 oMLX 的 Qwen3.8-27B-4bit (端点已不用)。
//
// 判据只有一条: **config.llm.models 是唯一真源**, registry 里池外的 id 一律清掉。
// 重新加回模型时会重新探, 丢的只是缓存, 不是能力 —— 宁可清干净。
//
// 用法:
//   node scripts/prune-model-registry.js --dry     只看要删什么, 不落盘
//   node scripts/prune-model-registry.js           真删 (先自动备份)

const fs = require('fs');
const path = require('path');

// 节点配置路径 —— 不写死任何人的机器名 (2026-10-26 第 109 批)。
const CONFIG_PATH = require('../config/node_config').resolveNodeConfigPathOrEmpty();
const dry = process.argv.includes('--dry');

function main() {
  const cfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  const live = new Set(
    ((cfg.llm && Array.isArray(cfg.llm.models)) ? cfg.llm.models : [])
      .map((m) => m && m.id).filter(Boolean)
  );
  if (!live.size) {
    console.error('[prune] config.llm.models 是空的 —— 拒绝执行 (空池清库 = 事故, 不是清理)');
    process.exit(1);
  }

  const registry = require('../modules/model_registry');
  const before = registry.listModels();
  // 判"池外"必须跟 pruneModels 用同一套 id 解析 (resolveKey), 不许精确匹配 ——
  // 池里 minimax_m3.1-flash-preview, registry 里 minimax-m3.1-flash-preview,
  // 精确匹配会把这条活着的缓存误判成垃圾。
  const keptKeys = new Set();
  for (const id of live) {
    const k = registry.resolveKey(id);
    if (k) keptKeys.add(k);
  }
  console.log('池里活着的 id (' + live.size + '): ' + [...live].join(', '));
  console.log('registry 现有 (' + before.length + ' 条):');

  const doomed = before.filter((m) => !keptKeys.has(m.id));
  for (const m of before) {
    const tag = doomed.includes(m) ? '✗ 删' : '· 留';
    console.log(
      '  ' + tag + ' ' + m.id.padEnd(36) +
      ' ctx=' + String(m.context_length === undefined ? '-' : m.context_length).padEnd(8) +
      ' source=' + (m.source || '-')
    );
  }

  if (!doomed.length) {
    console.log('\n没有可删的条目, 完事。');
    return;
  }
  if (dry) {
    console.log('\n[dry] 会删 ' + doomed.length + ' 条, 没落盘。去掉 --dry 真删。');
    return;
  }

  const regPath = registry.registryPath();
  const backup = regPath + '.bak-' + Date.now();
  fs.copyFileSync(regPath, backup);
  console.log('\n已备份: ' + backup);

  const r = registry.pruneModels([...live]);
  console.log('删掉 ' + r.removed.length + ' 条, ' + r.before + ' → ' + r.after);
}

main();

