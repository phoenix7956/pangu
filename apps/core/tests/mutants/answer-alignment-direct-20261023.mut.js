'use strict';
/**
 * 第 72 批变异体检 —— 验「tests/answer-alignment-direct-20261023.test.js」的判据真能咬住。
 *
 * ## 铁律: 打空枪的变异比没有变异更坏
 *
 * 每个变异都必须让目标测试 FAIL。跑完还是 PASS = 空枪 = 判据无效, 必须重做。
 * 空枪不计入成功数, 单独报出来, 退出码非 0。
 *
 * ## 变异从哪来
 *
 * 照着本批**真实可能发生的错**编的 —— M1 / M2 / M4 这三条是本批实现时**真的想过要写**的:
 *   · M1: 动词表不补 (只+回复/回答/答/返回/给出/说) ⇒ 回到收口前的状态
 *   · M2: 不加「N个字」这个独立信号 ⇒ 「回两个字就好」这类说法漏判
 *   · M4: 顺手把「N个数」也算信号 ⇒ 「这几个数字对不对」被误放行
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.join(__dirname, '..', '..');
const AA = path.join(CORE, 'modules', 'answer_alignment.js');
const TESTS = [path.join('tests', 'answer-alignment-direct-20261023.test.js')];

function runTest() {
  for (const t of TESTS) {
    try {
      execFileSync('node', ['--test', t], { cwd: CORE, stdio: 'pipe', timeout: 120000 });
    } catch (e) {
      return { pass: false };
    }
  }
  return { pass: true };
}

function syntaxOk(files) {
  for (const f of files) {
    try {
      execFileSync('node', ['--check', f], { stdio: 'pipe' });
    } catch (e) {
      return { ok: false, detail: String(e.stderr || e.stdout || e.message).split('\n').slice(0, 3).join(' ') };
    }
  }
  return { ok: true };
}

function rep(src, find, to) {
  const re = find instanceof RegExp ? find : new RegExp(find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 's');
  const hits = src.match(new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g'));
  const n = hits ? hits.length : 0;
  if (n !== 1) throw new Error(`锚点命中 ${n} 次 (要 1 次): ${String(find).slice(0, 70)}`);
  return src.replace(re, to);
}

const MUTANTS = [
  {
    name: 'M1 动词表不补 ⇒ 回到收口前(只+回复/回答/答/返回/给出/说) —— 本批真状态',
    files: [[AA, (s) => rep(s, '|说|回|给|讲|吐|写|整)', '|说)')]],
  },
  {
    name: 'M2 不加「N个字」独立信号 ⇒ 「回两个字就好」这类说法漏判',
    files: [[AA, (s) => rep(s, '|(?:一|两|二|三|四|五|六|七|八|九|十|几)\\s*个字(?!段)', '')]],
  },
  {
    name: 'M3 去掉「个字(?!段)」的否定 ⇒ 「3个字段」被当成要三个字',
    files: [[AA, (s) => rep(s,
      '个字(?!段)|(?:回|给|说|讲|答|写|整|吐)\\s*\\d+\\s*个字(?!段)',
      '个字|(?:回|给|说|讲|答|写|整|吐)\\s*\\d+\\s*个字')]],
  },
  {
    name: 'M4 把「N个数」也算信号 ⇒ 「这几个数字对不对」被误放行 (本批真想过要写)',
    files: [[AA, (s) => rep(s,
      '|(?:只|仅|直接|原样)\\s*(?:要|想要|需要)\\s*(?:一|1|两|2|三|3)?\\s*(?:个)?(?:数|字)',
      '|(?:只|仅|直接|原样)\\s*(?:要|想要|需要)\\s*(?:一|1|两|2|三|3)?\\s*(?:个)?(?:数|字)|(?:一|两|二|三|四|五|六|七|八|九|十|几)\\s*个数')]],
  },
  {
    name: 'M5 把「N句话」也算信号 ⇒ 「说三句话总结」要的是总结, 糊弄答案被放行',
    files: [[AA, (s) => rep(s,
      '|(?:一|两|二|三|四|五|六|七|八|九|十|几)\\s*个字(?!段)',
      '|(?:一|两|二|三|四|五|六|七|八|九|十|几)\\s*(?:个字(?!段)|句话)')]],
  },
  {
    name: 'M6 短答案豁免的长度上界从 12 放宽到 100 ⇒ 长跑题答案被放行',
    files: [[AA, (s) => rep(s,
      'if (_wantsDirect && a.length < 12) return true;',
      'if (_wantsDirect && a.length < 100) return true;')]],
  },
  {
    name: 'M7 删掉短答案豁免整行 ⇒ 全部回到「短答案被拒」的老状态',
    files: [[AA, (s) => rep(s,
      '  if (_wantsDirect && a.length < 12) return true;\n', '')]],
  },
  {
    name: 'M8 又内联一份正则 ⇒ 同一件事两份实现',
    files: [[AA, (s) => rep(s,
      'const _wantsDirect = _WANTS_DIRECT_RE.test(_qRaw);',
      "const _wantsDirect = /(?:只|仅|直接|原样|马上|立刻)\\s*(?:回复|回答|答|返回|给出|说)/.test(_qRaw);")]],
  },
  {
    name: 'M9 删掉「N个字：X」这条点名答案分支 ⇒ 「只回两个字：收到」的长答案被拒',
    files: [[AA, (s) => rep(s,
      '|| _qRaw\n      .match(/(?:一|两|二|三|四|五|六|七|八|九|十|几)\\s*(?:个字|句话)\\s*[:：]\\s*([^\\s，。？！、；]{1,12})/);',
      ';')]],
  },
  {
    name: 'M10 删掉「问题点名答案」这条分支 ⇒ 「请只回复:收到」的长答案被拒',
    files: [[AA, (s) => rep(s,
      'const _want = _qRaw\n    .match(/(?:只|仅|直接|原样)\\s*(?:回复|回答|答|返回|给出)\\s*[:：]?\\s*([^\\s，。？！、；]{1,12})/)',
      'const _want = null')]],
  },
];

const BACKUP = new Map();
function snapshot(files) { for (const f of files) BACKUP.set(f, fs.readFileSync(f, 'utf8')); }
function restore() { for (const [f, s] of BACKUP) fs.writeFileSync(f, s); BACKUP.clear(); }

let killed = 0; const empty = []; const crashed = [];
console.log(`第 72 批变异体检: ${MUTANTS.length} 发, 目标测试 ${TESTS.join(', ')}\n`);

for (const mut of MUTANTS) {
  snapshot(mut.files.map((x) => x[0]));
  try {
    for (const [file, fn] of mut.files) {
      fs.writeFileSync(file, fn(fs.readFileSync(file, 'utf8')));
    }
    const syn = syntaxOk(mut.files.map((x) => x[0]));
    if (!syn.ok) {
      crashed.push(mut.name + ' :: 语法坏了: ' + syn.detail);
      console.log(`✘ 语法坏  ${mut.name}`);
      restore(); continue;
    }
    const r = runTest();
    if (!r.pass) { killed++; console.log(`✔ 咬住    ${mut.name}`); }
    else { empty.push(mut.name); console.log(`✘ 空枪!!  ${mut.name}   ← 判据没咬住, 必须重做`); }
  } catch (e) {
    crashed.push(mut.name + ' :: ' + String(e.message).slice(0, 80));
    console.log(`✘ 变异器错 ${mut.name} :: ${String(e.message).slice(0, 80)}`);
  }
  restore();
}

console.log(`\n变异 ${MUTANTS.length} 发: 咬住 ${killed}, 空枪 ${empty.length}, 变异器错 ${crashed.length}`);
if (empty.length) { console.log('\n空枪清单:'); empty.forEach((n) => console.log('  · ' + n)); }
if (crashed.length) { console.log('\n变异器错清单:'); crashed.forEach((n) => console.log('  · ' + n)); }
process.exit(empty.length || crashed.length ? 1 : 0);
