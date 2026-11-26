'use strict';
/**
 * 第 68 批变异体检 —— 验「tests/fengshui-core-20261023.test.js」的判据真能咬住。
 *
 * ## 铁律: 打空枪的变异比没有变异更坏
 *
 * 它给你「验过了」的假安全感。所以本 harness 的判据是:
 *   **每个变异都必须让目标测试 FAIL。跑完还是 PASS = 空枪 = 本批判据无效, 必须重做。**
 * 空枪不计入成功数, 单独报出来, 退出码非 0。
 *
 * ## 变异从哪来
 *
 * 照着本批**真实可能发生的错**编的 —— 而且其中几个**真的发生过**(本批实现初版):
 *   · M1/M2/M3: 命卦算法(11减/4加/减完再拆加)抄错一位 ⇒ 整表对不上
 *   · M4: 5 黄星男女写反(男作坤 vs 女作艮) —— 写反了看不出来, 因为两边都是"西四命"
 *   · M5: 5 黄星的标签保留数字 5 写成 2 ⇒ 与速查表逐字对不上
 *   · M6: 二十四向山抄错一格(卯 归到坎) ⇒ 一座宅的宅卦整片错
 *   · M7: 大游年歌诀抄错一个字(六→八) ⇒ **不动点检查必须破**(这是本批最值钱的一条)
 *   · M8: 顺时针次序算反 ⇒ 八条歌诀同时不自洽
 *   · M9: 四吉四凶挪错一个 ⇒ 每宅 4:4 检查破
 *   · M10: 宅命相配改回整串比较 ⇒ 「东四命 × 东四宅」全判成不配(本批真发生过的 bug)
 *   · M11: 三元起点 1864 改成 1860 ⇒ 锚点与边界全错
 *   · M12: 出处台账把「宅卦=坐山」从 interpretive 改成 sourced ⇒ 拿自创口径冒充原文
 *   · M13: 切片器把 xlsx 表格读空 ⇒ 速查表真源消失
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.join(__dirname, '..', '..');
const F = (rel) => path.join(CORE, rel);

const MING = F('64i/fengshui/ming_gua.js');
const ZHAI = F('64i/fengshui/zhai_gua.js');
const DAYUN = F('64i/fengshui/dayun_geometry.js');
const JIUYUN = F('64i/fengshui/jiuyun.js');
const PROVENANCE = F('64i/provenance.js');
const SLICER = F('scripts/extract_provenance_sources.js');

const TESTS = [
  path.join('tests', 'fengshui-core-20261023.test.js'),
];

function runTest() {
  for (const t of TESTS) {
    try {
      execFileSync('node', ['--test', t], { cwd: CORE, stdio: 'pipe', timeout: 120000 });
    } catch (e) {
      return { pass: false, out: String(e.stdout || '') + String(e.stderr || '') };
    }
  }
  return { pass: true };
}

function syntaxOk(files) {
  for (const f of files) {
    try {
      execFileSync('node', ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      return {
        ok: false,
        detail: String(e.stderr || e.stdout || e.message).split('\n').slice(0, 3).join(' '),
      };
    }
  }
  return { ok: true };
}

function rep(src, find, to) {
  const re = find instanceof RegExp ? find : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 's');
  const hits = src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  const n = hits ? hits.length : 0;
  if (n !== 1) {
    throw new Error(`锚点命中 ${n} 次 (要 1 次): ${String(find).slice(0, 70)}`);
  }
  return src.replace(re, to);
}

const MUTANTS = [
  {
    name: 'M1 命卦: 女命 4 加改成 5 加 (方向错一位)',
    files: [[MING, (s) => rep(s,
      "let v = g === 'm' ? 11 - x : x + 4;",
      "let v = g === 'm' ? 11 - x : x + 5;")]],
  },
  {
    name: 'M2 命卦: 男命 11 减改成 10 减',
    files: [[MING, (s) => rep(s,
      "let v = g === 'm' ? 11 - x : x + 4;",
      "let v = g === 'm' ? 10 - x : x + 4;")]],
  },
  {
    name: 'M3 命卦: 减完/加完不再拆加至个位数 (11-1=10 直接当命星)',
    files: [[MING, (s) => rep(s,
      "  while (v > 9) v = String(v).split('').reduce((acc, ch) => acc + Number(ch), 0);",
      "  // 变异: 不再拆加")]],
  },
  {
    name: 'M4 命卦: 5黄星男女写反 (男作艮/女作坤)',
    files: [[MING, (s) => rep(s,
      "  m: Object.freeze({ gua: '坤', element: '土', group: '西四命', star: 5 }),\n"
      + "  f: Object.freeze({ gua: '艮', element: '土', group: '西四命', star: 5 }),",
      "  m: Object.freeze({ gua: '艮', element: '土', group: '西四命', star: 5 }),\n"
      + "  f: Object.freeze({ gua: '坤', element: '土', group: '西四命', star: 5 }),")]],
  },
  {
    name: 'M5 命卦: 5黄星标签把数字 5 写成 2 (与速查表逐字对不上)',
    files: [[MING, (s) => rep(s,
      "    label: labelOf(five ? 5 : v, fact.gua, fact.element),",
      "    label: labelOf(five ? 2 : v, fact.gua, fact.element),")]],
  },
  {
    name: 'M6 宅卦: 二十四向山抄错一格 (卯 归到坎)',
    files: [[ZHAI, (s) => rep(s,
      "  甲: '震', 卯: '震', 乙: '震',",
      "  甲: '震', 卯: '坎', 乙: '震',")]],
  },
  {
    name: 'M7 大游年: 歌诀抄错一个字 (震 那条的「六」写成「八」)',
    files: [[DAYUN, (s) => rep(s,
      "  震: '伏延生祸绝五天六',",
      "  震: '伏延生祸绝五天八',")]],
  },
  {
    name: 'M8 大游年: 顺时针次序算反 (方位排序取反)',
    files: [[DAYUN, (s) => rep(s,
    "    .sort((a, b) => a.bearing - b.bearing)",
    "    .sort((a, b) => b.bearing - a.bearing)")]],
  },
  {
    name: 'M9 大游年: 四吉四凶挪错一个 (祸害 从凶挪到吉)',
    files: [[DAYUN, (s) => rep(s,
      "const UNLUCKY_STARS = Object.freeze(['祸害', '绝命', '五鬼', '六煞']);",
      "const UNLUCKY_STARS = Object.freeze(['绝命', '五鬼', '六煞']);")]],
  },
  {
    name: 'M10 大游年: 宅命相配改回整串比较 (东四命 × 东四宅 全判成不配)',
    files: [[DAYUN, (s) => rep(s,
      "  const cls = (s) => String(s || '').replace(/[命宅]$/, '');\n"
      + "  const ok = cls(mingGroup) === cls(zhaiGroup);",
      "  const ok = mingGroup === zhaiGroup;")]],
  },
  {
    name: 'M11 三元九运: 起点 1864 改成 1860 (整表错位)',
    files: [[JIUYUN, (s) => rep(s,
      "const FIRST_YEAR = JIUYUN_ANCHOR.from - (JIUYUN_ANCHOR.yun - 1) * YEARS_PER_YUN;",
      "const FIRST_YEAR = JIUYUN_ANCHOR.from - (JIUYUN_ANCHOR.yun - 1) * YEARS_PER_YUN - 4;")]],
  },
  {
    name: 'M12 出处: 把「宅卦 = 坐山所属卦」从 interpretive 改成 sourced (拿自创口径冒充原文)',
    files: [[PROVENANCE, (s) => rep(s,
      "      { field: '宅卦 = 坐山所属卦', status: 'interpretive',",
      "      { field: '宅卦 = 坐山所属卦', status: 'sourced',")]],
  },
  {
    name: 'M13 切片器: 表格渲染的分隔符从制表符改成分号 (切片与抽取器不自洽)',
    files: [[SLICER, (s) => rep(s,
      "    .map((cells) => cells.map((c) => String(c === undefined ? '' : c)).join('\\t'))",
      "    .map((cells) => cells.map((c) => String(c === undefined ? '' : c)).join(';'))")]],
  },
  {
    name: 'M14 切片器: xlsx 解析只取前 5 列 (右半栏 2021-2040 整片丢失)',
    files: [[SLICER, (s) => rep(s,
      "  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];\n"
      + "  return { ok: true, rows };",
      "  for (let i = 0; i < rows.length; i++) if (!rows[i]) rows[i] = [];\n"
      + "  const trimmed = rows.map((cells) => cells.slice(0, 5));\n"
      + "  return { ok: true, rows: trimmed };")]],
  },
  {
    name: 'M15 装时自检: 把风水那两把刀从 PROGRAMS 里摘掉 (刀变成没人执行的判决)',
    files: [[PROVENANCE, (s) => rep(s,
      "  mingGuaAgainstTable: checkMingGuaAgainstTable,\n"
      + "  dayunSongsAgainstRule: checkDayunSongsAgainstRule,\n",
      "")]],
  },
];

function main() {
  const orig = new Map();
  const allFiles = [MING, ZHAI, DAYUN, JIUYUN, PROVENANCE, SLICER];
  for (const f of allFiles) orig.set(f, fs.readFileSync(f, 'utf8'));

  let killed = 0;
  const blanks = [];
  const errors = [];

  for (const m of MUTANTS) {
    let files = [];
    try {
      files = m.files.map(([f, fn]) => [f, fn(orig.get(f))]);
    } catch (e) {
      errors.push({ name: m.name, detail: '打变异时炸了: ' + e.message });
      continue;
    }

    const syn = syntaxOk(files.map(([f]) => f));
    if (!syn.ok) {
      errors.push({ name: m.name, detail: '语法错误(假咬住): ' + syn.detail });
      for (const [f, s] of files) fs.writeFileSync(f, s);
      continue;
    }

    for (const [f, s] of files) fs.writeFileSync(f, s);
    const r = runTest();
    for (const [f] of files) fs.writeFileSync(f, orig.get(f));

    if (r.pass) {
      blanks.push(m.name);
    } else {
      killed++;
      console.log('✅ 咬住: ' + m.name);
    }
  }

  console.log('');
  console.log('变异结果: ' + killed + '/' + MUTANTS.length + ' 咬住');
  if (blanks.length) {
    console.log('❌ 空枪 ' + blanks.length + ' 个 (打空枪比没有变异更坏 —— 本批判据无效, 必须重做):');
    for (const b of blanks) console.log('   · ' + b);
  }
  if (errors.length) {
    console.log('❌ 变异本身出问题 ' + errors.length + ' 个:');
    for (const e of errors) console.log('   · ' + e.name + ' —— ' + e.detail);
  }

  const bad = blanks.length + errors.length;
  console.log(bad ? '❌ 退出码 1 (有空枪或变异本身坏了)' : '✅ 全部咬住');
  process.exit(bad ? 1 : 0);
}

main();
