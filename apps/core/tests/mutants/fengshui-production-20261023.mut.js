'use strict';
/**
 * 第 69 批变异体检 —— 验「tests/fengshui-production-20261023.test.js」的判据真能咬住。
 *
 * ## 铁律: 打空枪的变异比没有变异更坏
 *
 * 它给你「验过了」的假安全感。所以本 harness 的判据是:
 *   **每个变异都必须让目标测试 FAIL。跑完还是 PASS = 空枪 = 本批判据无效, 必须重做。**
 * 空枪不计入成功数, 单独报出来, 退出码非 0。
 *
 * ## 变异从哪来
 *
 * 照着本批**真实可能发生的错**编的 —— 而且其中三个**真的发生过**(本批实现时):
 *   · M1: mingGua 性别认不出就默认成男命 —— **本批真 bug**,
 *     而且第 68 批的 80 条全量对账**逮不到它**(那 80 条全是显式传 m/f)
 *   · M2: parseSitting 的结果喂给 zhaiGua() (山名那把钥匙) ⇒ gua: undefined
 *     —— **本批真 bug**, 而且**不报错**, 输出一份「undefined宅(undefined)」的盘
 *   · M3: 「坐北向南」的 how 标成 facing_direction_inverted (卦对、how 错)
 *     —— **本批真 bug**, 而且 how 是模型判断「罗盘读的还是反推的」的唯一依据
 *   · M4: fengshui_calc 不进 MAIN_GENERAL_TOOLS_FOR_LLM ⇒ 模型根本调不到
 *   · M5: fengshui_calc 进了 li 的白名单 ⇒ 顶穿 9000 字符守卫
 *   · M6: 身份标签从渲染点里摘掉 ⇒ 模型会把风水口径当《易经》原文讲出去
 *   · M7: 生产层硬写标签字面量 (不引用内核常量) ⇒ 改一处忘一处就有一半路径裸着
 *   · M8: 出处台账把 interpretive 字段的 production 块删掉 ⇒ 标签守卫失去依据
 *   · M9: 风水路由排在 decision 之后 ⇒ 排盘题被"谋断类"抢走去起卦
 *   · M10: 词表里塞进「方位」这种通用词 ⇒ 八字题被改造成风水题
 *   · M11: 缺性别时用默认值补一个命卦 ⇒ 缺料就编
 *   · M12: 灶那一项渲染统一走 item.positions ⇒ undefined.map 抛异常
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.join(__dirname, '..', '..');
const F = (rel) => path.join(CORE, rel);

const MING = F('64i/fengshui/ming_gua.js');
const ZHAI = F('64i/fengshui/zhai_gua.js');
const FSIDX = F('64i/fengshui/index.js');
const REPORT = F('modules/fengshui_report.js');
const SCHEMA = F('modules/tools_schema.js');
const TOOLS = F('modules/tools/index.js');
const LPLAN = F('modules/layer_plan.js');
const PROVENANCE = F('64i/provenance.js');
const SUBAGENT = F('agents/sub-agent.js');

const TESTS = [
  path.join('tests', 'fengshui-production-20261023.test.js'),
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
    name: 'M1 内核: mingGua 性别认不出又默认成男命 (本批真 bug)',
    files: [[MING, (s) => rep(s,
      "  if (g !== 'm' && g !== 'f') {",
      "  if (false) {")]],
  },
  {
    name: 'M2 内核: parseSitting 的结果喂给 zhaiGua() (山名那把钥匙) ⇒ gua: undefined (本批真 bug)',
    files: [[FSIDX, (s) => rep(s,
      "const zhai = zhaiGua.zhaiGuaByGua(parsed.gua);",
      "const zhai = zhaiGua.zhaiGua(parsed.gua);")]],
  },
  {
    name: 'M3 内核: 「坐北向南」的 how 标成按朝向反推 (卦对、how 错) (本批真 bug)',
    files: [[ZHAI, (s) => rep(s,
      "  const zuoPart = raw.replace(/[朝向][^坐]*/, ' ').replace(/坐/, ' ');",
      "  const zuoPart = raw;")]],
  },
  {
    name: 'M4 接线: fengshui_calc 不进 MAIN_GENERAL_TOOLS_FOR_LLM ⇒ 模型根本调不到',
    files: [[SCHEMA, (s) => rep(s,
      "  'fengshui_calc',\n",
      "")]],
  },
  {
    name: 'M5 接线: fengshui_calc 进了 li 的白名单 ⇒ 顶穿 9000 字符守卫',
    files: [[SUBAGENT, (s) => rep(s,
      "'wuxing_judge', 'list_pangu_agents'",
      "'wuxing_judge', 'list_pangu_agents', 'fengshui_calc'")]],
  },
  {
    name: 'M6 接线: 身份标签从渲染点里摘掉 ⇒ 模型会把风水口径当《易经》原文讲出去',
    files: [[REPORT, (s) => rep(s,
      "  return lines.join('\\n') + '\\n' + FENGSHUI_TAG;",
      "  return lines.join('\\n');")]],
  },
  {
    name: 'M7 接线: 生产层硬写标签字面量 (不引用内核常量) ⇒ 改一处忘一处就有一半路径裸着',
    files: [[REPORT, (s) => rep(s,
      "  return lines.join('\\n') + '\\n' + FENGSHUI_TAG;",
      "  return lines.join('\\n') + '\\n' + '〔风水层为风水查法资料口径, 非《易经》原文〕';")]],
  },
  {
    name: 'M8 台账: 把 interpretive 字段的 production 块删掉 ⇒ 标签守卫失去依据',
    files: [[PROVENANCE, (s) => rep(s,
      "        production: {\n"
      + "          renderedIn: ['modules/fengshui_report.js:renderFengshuiReport'],\n"
      + "          marker: '〔此条为盘古按课程推导, 非课程逐字原文〕',\n"
      + "          markerConstant: '64i/fengshui/index.js:FENGSHUI_INTERPRETIVE_TAG',\n"
      + "          why: '不标身份, 模型会把「宅卦=坐山所属卦」当经典结论讲出去 —— '\n"
      + "            + '主人问一句「哪本书上说的」就露馅, 而盘古答不出。',\n"
      + "        },",
      "")]],
  },
  {
    name: 'M9 接线: 风水路由排在 decision 之后 ⇒ 排盘题被"谋断类"抢走去起卦',
    files: [[LPLAN, (s) => rep(s,
      "  } else if (fengshui.matched) {",
      "  } else if (false && fengshui.matched) {")]],
  },
  {
    name: 'M10 接线: 词表里塞进「方位」这种通用词 ⇒ 八字题被改造成风水题',
    files: [[LPLAN, (s) => rep(s,
      "  '坐向', '朝向',",
      "  '坐向', '朝向', '方位',")]],
  },
  {
    name: 'M11 接线: 缺性别时用默认值补一个命卦 ⇒ 缺料就编',
    files: [[TOOLS, (s) => rep(s,
      "      else if (/^(女|female|f|0|false)$/i.test(genderRaw.trim())) gender = 'f';",
      "      else if (/^(女|female|f|0|false)$/i.test(genderRaw.trim())) gender = 'f';\n"
      + "      else gender = 'm';")]],
  },
  {
    name: 'M12 接线: 灶那一项渲染统一走 item.positions ⇒ undefined.map 抛异常',
    // ⚠️ 这一发要**两处一起改**才对得上那个真 bug:
    //   真 bug 是「四项统一走 item.positions.map(...)」—— 即
    //     ① 灶没有特殊分支   ② 而且**没有 `|| []` 兜底**
    //   只改 ① 的话, `item.positions || []` 仍然兜住 ⇒ 不抛异常 ⇒ 空枪。
    //   ⇒ 一发变异必须同时还原这两处, 才等于当初那个错。
    files: [[REPORT, (s) => {
      let out = rep(s,
        "      if (k === '灶') {",
        "      if (false) {");
      out = rep(out,
        "      const pos = item.positions || [];",
        "      const pos = item.positions;");
      return out;
    }]],
  },
  {
    name: 'M13 接线: 命卦那行判错字段(.ok 而命卦对象没有 ok) ⇒ 静悄悄少一行(本批真 bug)',
    files: [[REPORT, (s) => rep(s,
      "  if (profile.ming_gua && profile.ming_gua.gua) {",
      "  if (profile.ming_gua && profile.ming_gua.ok) {")]],
  },
  {
    name: 'M14 接线: 缺料时也把该项渲染出来(没出生年也出【命卦】)',
    // ⚠️ 这个变异要真的改**行为**, 所以连 null 那一支一起放开:
    //   只把 `.gua` 改成 `.ok` 的话, 缺料时 profile.ming_gua 是 null,
    //   `if (profile.ming_gua)` 本来就判假 ⇒ 输出不变 ⇒ 空枪。
    //   真正要模拟的是「缺料也硬渲染一行」⇒ 判 null 也要进。
    files: [[REPORT, (s) => {
      let out = rep(s,
        "  if (profile.ming_gua && profile.ming_gua.gua) {",
        "  if (profile.ming_gua !== undefined) {");
      out = rep(out,
        "    lines.push('【命卦】' + profile.ming_gua.label + ' — ' + profile.ming_gua.group",
        "    lines.push('【命卦】' + (profile.ming_gua ? profile.ming_gua.label : '缺') + ' — ' + (profile.ming_gua ? profile.ming_gua.group : '缺')");
      return out;
    }]],
  },
];

function main() {
  const orig = new Map();
  const allFiles = [MING, ZHAI, FSIDX, REPORT, SCHEMA, TOOLS, LPLAN, PROVENANCE, SUBAGENT];
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
