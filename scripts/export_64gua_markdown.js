#!/usr/bin/env node
/**
 * export_64gua_markdown.js
 *
 * 把 64i 真源 (apps/core/64i/hexagrams.js) 的 64 卦导出成一张 Markdown 表格。
 *
 * 口径说明 (别改错):
 *   - 卦序用 id (1..64 文王卦序, 乾=1 … 未济=64)。index(0..63) 与 id 在 1..63 完全重叠,
 *     传错基数不报错、只会安静返回另一卦 —— 所以本脚本只输出 id。
 *   - 卦象名 (山火贲) 走 xiangNameOf(), 不从别处拼。
 *   - 卦辞 gua_ci / 大象辞 xiang / 爻辞 yao_ci 全部原样取自真源, 不改写不裁剪。
 *
 * 用法:
 *   node scripts/export_64gua_markdown.js [输出路径]
 *   默认输出: ~/Desktop/64卦辞对照表.md
 *   加 --yao-table 额外再出一份「384 爻明细」表
 */

'use strict';

const path = require('path');
const fs = require('fs');
const os = require('os');

const CORE = path.resolve(__dirname, '..', 'apps', 'core');
const {
  HEXAGRAMS,
  getAllHexagrams,
  xiangNameOf,
  assertBaseIntegrity,
} = require(path.join(CORE, '64i', 'hexagrams.js'));

const args = process.argv.slice(2);
const withYaoTable = args.includes('--yao-table');
const outPath = path.resolve(
  os.homedir(),
  'Desktop',
  '64卦辞对照表.md'
);

function pickOutput() {
  const positional = args.filter((a) => !a.startsWith('--'));
  if (positional.length) return path.resolve(positional[0]);
  return outPath;
}

function esc(v) {
  if (v === null || v === undefined) return '';
  return String(v)
    .replace(/\|/g, '\\|')
    .replace(/\r?\n/g, ' ')
    .trim();
}

function buildMainTable(list) {
  const header = [
    '卦序',
    '卦名',
    '卦象名',
    '符号',
    '上卦',
    '下卦',
    '卦辞',
    '大象辞',
    '初爻',
    '二爻',
    '三爻',
    '四爻',
    '五爻',
    '上爻',
    '卦义',
    '关键词',
    '五行(上卦口径)',
    '八宫(上卦分组)',
    '卦码(6-bit)',
  ];
  const rows = list.map((g) => {
    const yao = g.yao_ci || [];
    const cell = (i) => esc(yao[i] || '');
    return [
      g.id,
      esc(g.name),
      esc(xiangNameOf(g)),
      esc(g.symbol),
      esc(g.trigrams && g.trigrams.upper_name),
      esc(g.trigrams && g.trigrams.lower_name),
      esc(g.gua_ci),
      esc(g.xiang),
      cell(0), cell(1), cell(2), cell(3), cell(4), cell(5),
      esc(g.nature),
      esc((g.keywords || []).join('、')),
      esc(g.elements),
      esc(g.bagong),
      esc(g.binary),
    ].join(' | ');
  });
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map((r) => `| ${r} |`),
  ].join('\n');
}

function buildYaoTable(list) {
  const header = ['卦序', '卦名', '爻位', '爻辞'];
  const rows = [];
  for (const g of list) {
    (g.yao_ci || []).forEach((t, i) => {
      rows.push(`| ${g.id} | ${esc(g.name)} | ${i + 1} | ${esc(t)} |`);
    });
  }
  return [
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows,
  ].join('\n');
}

function main() {
  assertBaseIntegrity();

  const list = (typeof getAllHexagrams === 'function' ? getAllHexagrams() : HEXAGRAMS)
    .slice()
    .sort((a, b) => a.id - b.id);

  if (list.length !== 64) {
    console.error(`✗ 真源卦数异常: ${list.length} (期望 64)`);
    process.exit(1);
  }
  const yaoTotal = list.reduce((n, g) => n + (g.yao_ci || []).length, 0);
  if (yaoTotal !== 384) {
    console.error(`✗ 爻辞总数异常: ${yaoTotal} (期望 384)`);
    process.exit(1);
  }

  const target = pickOutput();
  const parts = [];
  parts.push('# 64 卦辞对照表');
  parts.push('');
  parts.push(
    `数据源: \`apps/core/64i/hexagrams.js\` (64i 真源) · 卦 ${list.length} 卦 / 爻 ${yaoTotal} 辞 · 卦序为文王序 id (1..64)`
  );
  parts.push('');
  parts.push('> `五行`/`八宫` 两列为**上卦口径**（非京房八宫之宫）；`卦码` 为 6-bit 编次约定，非典籍原文。');
  parts.push('');
  parts.push('## 64 卦总表');
  parts.push('');
  parts.push(buildMainTable(list));

  if (withYaoTable) {
    parts.push('');
    parts.push('## 384 爻明细');
    parts.push('');
    parts.push(buildYaoTable(list));
  }

  fs.writeFileSync(target, parts.join('\n') + '\n', 'utf8');
  console.log(`✓ 已导出: ${target}`);
  console.log(`  卦 ${list.length} / 爻 ${yaoTotal}`);
  if (withYaoTable) console.log('  含 384 爻明细表');
}

main();
