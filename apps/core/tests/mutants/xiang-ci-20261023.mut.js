'use strict';
/**
 * 第 70 批变异体检 —— 验「tests/xiang-ci-20261023.test.js」的判据真能咬住。
 *
 * ## 铁律: 打空枪的变异比没有变异更坏
 *
 * 它给你「验过了」的假安全感。所以本 harness 的判据是:
 *   **每个变异都必须让目标测试 FAIL。跑完还是 PASS = 空枪 = 本批判据无效, 必须重做。**
 * 空枪不计入成功数, 单独报出来, 退出码非 0。
 *
 * ## 变异从哪来
 *
 * 照着本批**真实可能发生的错**编的 —— 其中前三个**真的发生过**(本批实现时):
 *   · M1: 切片里某卦的象辞改一个字 ⇒ 内核与切片分家
 *   · M2: 核心里某卦的象辞换成别卦的(贴错卦) —— **本批真踩过**:
 *     外部源把「否」卦的象辞贴成了「屯」卦的「云雷，屯, 君子以经纶」,
 *     整句通顺, 不查卦名根本发现不了
 *   · M3: 核心里某卦的象辞清空 ⇒ 静悄悄丢一层, 不报错
 *   · M4: 切片删掉一条 ⇒ 覆盖不满 64
 *   · M5: 切片异文段删掉一条 ⇒ 异文条数不闭合
 *   · M6: 切片某条加错字 ⇒ 与内核分家
 *   · M7: 核心里塞一条异体字(懼/惧、遯/遁) ⇒ 逐字不一致
 *   · M8: 卦象块不印大象辞 ⇒ 模型看不到那一层
 *   · M9: 渲染点把身份标签摘掉 ⇒ 模型会把对账定稿当原样引文
 *   · M10: 出处台账把 xiang 的 production 块删掉 ⇒ 标签守卫失去依据
 *   · M11: 异文台账里的一条删掉 ⇒ 台账与切片分家
 *   · M12: 异文台账的 gua 写成数组下标(0-based) ⇒ 卦序错位
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.join(__dirname, '..', '..');
const F = (rel) => path.join(CORE, rel);

const HEX = F('64i/hexagrams.js');
const SLICE = F('64i/sources/xiang_ci_64.txt');
const GUAB = F('modules/gua_block.js');
const TOOLS = F('modules/tools/index.js');
const PROVENANCE = F('64i/provenance.js');
const YAOM = F('64i/yao_models.js');
const ENGINE = F('modules/gua_engine.js');

const TESTS = [
  path.join('tests', 'xiang-ci-20261023.test.js'),
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
    name: 'M1 内核: 某卦象辞改一个字 ⇒ 与切片分家',
    files: [[HEX, (s) => rep(s,
      "xiang: '天行健，君子以自强不息。'",
      "xiang: '天行健，君子以自强不息也。'")]],
  },
  {
    name: 'M2 内核: 某卦象辞换成别卦的(贴错卦) —— 本批真踩过',
    files: [[HEX, (s) => rep(s,
      "xiang: '天地不交，否；君子以俭德辟难，不可荣以禄。'",
      "xiang: '云雷，屯，君子以经纶。'")]],
  },
  {
    name: 'M3 内核: 某卦象辞清空 ⇒ 静悄悄丢一层',
    files: [[HEX, (s) => rep(s,
      "xiang: '天行健，君子以自强不息。'",
      "xiang: ''")]],
  },
  {
    name: 'M4 切片: 删掉一条 ⇒ 覆盖不满 64',
    files: [[SLICE, (s) => s.split('\n').filter((l) => !l.startsWith('01 乾|')).join('\n')]],
  },
  {
    name: 'M5 切片: 异文段删掉一条 ⇒ 异文条数不闭合',
    files: [[SLICE, (s) => {
      let n = 0;
      return s.split('\n').filter((l) => {
        if (/^\d{2} .+\|.+\|[ABC]\|/.test(l)) { if (n === 0) { n++; return false; } }
        return true;
      }).join('\n');
    }]],
  },
  {
    name: 'M6 切片: 某条加错字 ⇒ 与内核分家',
    files: [[SLICE, (s) => rep(s,
      '02 坤|地势坤，君子以厚德载物。',
      '02 坤|地势坤，君子以厚德栽物。')]],
  },
  {
    name: 'M7 内核: 塞一条异体字(懼/惧、遯/遁) ⇒ 逐字不一致',
    files: [[HEX, (s) => rep(s,
      "xiang: '泽灭木，大过；君子以独立不惧，遯世无闷。'",
      "xiang: '泽灭木，大过；君子以独立不懼，遁世无闷。'")]],
  },
  {
    name: 'M8 生产: 卦象块不印大象辞 ⇒ 模型看不到那一层',
    files: [[GUAB, (s) => rep(s,
      "    ? ('大象辞: ' + gua.gua_xiang + ' ' + XIANG_CI_TAG + '\\n')",
      "    ? ('')")]],
  },
  {
    name: 'M9 生产: 渲染点把身份标签摘掉 ⇒ 模型会把对账定稿当原样引文',
    files: [[TOOLS, (s) => rep(s,
      "          tag: require('../gua_block').XIANG_CI_TAG,",
      "          tag: '（标签被摘掉）',")]],
  },
  {
    name: 'M10 台账: 把 xiang 的 production 块删掉 ⇒ 标签守卫失去依据',
    files: [[PROVENANCE, (s) => {
      const i = s.indexOf("{ field: '大象辞(xiang)', status: 'sourced'");
      if (i < 0) throw new Error('锚点没找到: 大象辞字段登记');
      const j = s.indexOf('production: {', i);
      if (j < 0) throw new Error('锚点没找到: production 块');
      // 块尾: 找 production 块里第一个 "markerConstant:" 行之后的 "} }," 
      const mk = s.indexOf('markerConstant:', j);
      if (mk < 0) throw new Error('锚点没找到: markerConstant');
      const k = s.indexOf('} },', mk);
      if (k < 0) throw new Error('锚点没找到: production 块结尾');
      // 只删 production 这个成员本身: `} },` 里的第一个 `}` 收的是 production,
      //   第二个 `}` 收的是**字段对象** —— 连第二个一起删, 整个文件语法就坏了
      //   (变异器自己犯的错, 会被当成「语法坏」而不是「咬住」)。
      return s.slice(0, j) + s.slice(k + 1);
    }]],
  },
  {
    name: 'M11 台账: 异文台账删掉一条 ⇒ 台账与切片分家',
    files: [[PROVENANCE, (s) => rep(s,
      "  { gua: 12, name: '否', kind: 'misfiled', src: 'A',\n    note: '源A(npm)把此卦的象辞贴成了屯卦的「云雷，屯，君子以经纶」—— '\n      + '源自己的数据错(首句不含「否」), 裁决出局。' },\n",
      "")]],
  },
  {
    name: 'M12 台账: 异文的 gua 写成数组下标(0-based) ⇒ 卦序错位',
    files: [[PROVENANCE, (s) => rep(s,
      "{ gua: 12, name: '否', kind: 'misfiled', src: 'A',",
      "{ gua: 11, name: '否', kind: 'misfiled', src: 'A',")]],
  },
  {
    name: 'M13 生产: yao_models.getGuaXiang 改成永远返回 null ⇒ 起卦拿不到大象辞',
    files: [[YAOM, (s) => rep(s,
      "function getGuaXiang(guaId) {\n  const h = HEXAGON_MAP[guaId];\n  return h && h.xiang ? h.xiang : null;\n}",
      "function getGuaXiang(guaId) {\n  return null;\n}")]],
  },
  {
    name: 'M14 生产: 起卦返回不带身份标签 ⇒ 模型把对账定稿当原样引文',
    // 这条对应本批整链回归第一次跑出来的**真红灯**:
    //   出处台账把 'modules/gua_engine.js:castGua' 登记成带标签渲染点,
    //   而那个函数体里没有引用标签常量 —— 台账说了假话, 守卫 P12 逮住了。
    //   修法是让身份跟着数据走(gua_xiang_basis), 不是把台账那一行删掉。
    files: [[ENGINE, (s) => rep(s,
      "    gua_xiang_basis: {\n      tag: XIANG_CI_TAG,",
      "    gua_xiang_basis: {\n      tag: '（标签被摘掉）',")]],
  },
  {
    name: 'M15 台账: 把 gua_engine:castGua 从渲染点里删掉 ⇒ 有人偷偷摘标签也没人管',
    files: [[PROVENANCE, (s) => rep(s,
      "            'modules/gua_engine.js:castGua',\n",
      "")]],
  },
  {
    name: 'M16 切片: 异文段多漏一条(屯/源B 那条) ⇒ 台账与切片分家',
    // 这一条对应本批**真踩过**的洞:
    //   台账是手写的 15 条, 而 build 脚本 --check 实算出 16 条
    //   (多的是「屯/源B」—— 源B 把「云雷」脱成「云」, 首句因此不含卦名)。
    //   手写台账 ⇒ 漏条 ⇒ 守卫报「异文实算 16 条, 台账 15 条」。
    //   ⇒ 异文台账必须跟着 build 脚本的实算走, 不能手写。
    files: [[SLICE, (s) => s.replace(
      /^03 屯\|.*$/m,
      '')]],
  },
  {
    name: 'M17 切片: 正读里某卦改成异体字(懼) ⇒ 与内核分家',
    files: [[SLICE, (s) => rep(s,
      '28 大过|泽灭木，大过；君子以独立不惧，遯世无闷。',
      '28 大过|泽灭木，大过；君子以独立不懼，遯世无闷。')]],
  },
];

const BACKUP = new Map();
function snapshot(files) {
  for (const f of files) BACKUP.set(f, fs.readFileSync(f, 'utf8'));
}
function restore() {
  for (const [f, s] of BACKUP) fs.writeFileSync(f, s);
  BACKUP.clear();
}

const allFiles = [...new Set(MUTANTS.flatMap((m) => m.files.map((x) => x[0])))];
let killed = 0;
const empty = [];
const crashed = [];

console.log(`第 70 批变异体检: ${MUTANTS.length} 发, 目标测试 ${TESTS.join(', ')}\n`);

for (const mut of MUTANTS) {
  snapshot(mut.files.map((x) => x[0]));
  try {
    for (const [file, fn] of mut.files) {
      const src = fs.readFileSync(file, 'utf8');
      fs.writeFileSync(file, fn(src));
    }
    const syn = syntaxOk(mut.files.map((x) => x[0]).filter((f) => f.endsWith('.js')));
    if (!syn.ok) {
      crashed.push(mut.name + ' :: 语法坏了: ' + syn.detail);
      console.log(`✘ 语法坏  ${mut.name}`);
      restore();
      continue;
    }
    const r = runTest();
    if (!r.pass) {
      killed++;
      console.log(`✔ 咬住    ${mut.name}`);
    } else {
      empty.push(mut.name);
      console.log(`✘ 空枪!!  ${mut.name}   ← 判据没咬住, 必须重做`);
    }
  } catch (e) {
    crashed.push(mut.name + ' :: ' + String(e.message).slice(0, 80));
    console.log(`✘ 变异器错 ${mut.name} :: ${String(e.message).slice(0, 80)}`);
  }
  restore();
}

console.log(`\n变异 ${MUTANTS.length} 发: 咬住 ${killed}, 空枪 ${empty.length}, 变异器错 ${crashed.length}`);
if (empty.length) {
  console.log('\n空枪清单(每一条都说明判据有洞):');
  empty.forEach((n) => console.log('  · ' + n));
}
if (crashed.length) {
  console.log('\n变异器错清单:');
  crashed.forEach((n) => console.log('  · ' + n));
}
process.exit(empty.length || crashed.length ? 1 : 0);
