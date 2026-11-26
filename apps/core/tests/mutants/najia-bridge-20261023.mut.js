'use strict';
/**
 * 第 66 批变异体检 —— 验「tests/najia-bridge-20261023.test.js」的判据真能咬住。
 *
 * ## 铁律: 打空枪的变异比没有变异更坏
 *
 * 它给你「验过了」的假安全感。所以本 harness 的判据是:
 *   **每个变异都必须让目标测试 FAIL。跑完还是 PASS = 空枪 = 本批判据无效, 必须重做。**
 * 空枪不计入成功数, 单独报出来, 退出码非 0。
 *
 * ## 变异从哪来
 *
 * 不是随手编的, 是**照着本批真实可能发生的错**编的 —— 而且其中几个**真的发生过**:
 *   · M1/M2/M3: getRelation 的**四态**语义(sheng/bei_sheng/ke/bei_ke/tong)抄成三态
 *     ⇒ 反向关系整片漏掉。本批实现初版就是这么写的, 被测试当场逮住
 *     (金该「死」判成了「囚」、子水该「生」判成了「泄」)。
 *   · M4: 六亲的爻位基号混用(0 基 / 1 基) —— 错位一爻且一声不吭
 *   · M5: 爻的纳甲地支五行改从 wuxing_map 取(那张表按 64 卦编号建, 取地支会得到错值)
 *   · M6: 两把尺子只给一列(模型必然把京房六亲当「这个人的六亲」讲出去)
 *   · M7: 桥接失败时不 return, 改成把桥整个吞掉(起卦结果里桥字段消失)
 *   · M8: 干支那一头不按 tool 过滤(拿 gua_cast 的条目当盘)
 *   · M9: 桥给了用神爻结论(没给的判据自己编)
 *   · M10: 出处台账把「组合」那条从 interpretive 改成 sourced(拿自己的设计冒充典籍)
 */

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const CORE = path.join(__dirname, '..', '..');
const KERNEL = path.join(CORE, '64i', 'bagua_annotations', 'najia_bridge.js');
const PROD = path.join(CORE, 'modules', 'najia_bridge.js');
const TOOLS = path.join(CORE, 'modules', 'tools', 'index.js');
const LAYER_PLAN = path.join(CORE, '64i', 'bagua_annotations', 'layer_plan.js');
const PROVENANCE = path.join(CORE, '64i', 'provenance.js');

const TESTS = [
  path.join('tests', 'najia-bridge-20261023.test.js'),
  // 老判据也一起跑: 第 66 批动了 layer_plan 的 bridge 层与 combo 的 note,
  // 这些判据必须**没被放松**。
  path.join('tests', 'layer-plan-20261023.test.js'),
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
  // ---- M1: 旺衰判据把「我生者相 / 生我者休」两档漏掉 ----
  {
    name: 'M1 旺衰: 删掉 bei_sheng/bei_ke 两档 (三态语义漏掉反向关系)',
    files: [[KERNEL, (s) => rep(s,
      "    case 'bei_sheng': return WANG_XIANG_XIU_QIU_SI.休;   // 生我者休 (爻生月令)\n"
      + "    case 'bei_ke': return WANG_XIANG_XIU_QIU_SI.囚;      // 克我者囚 (爻克月令)\n",
      "")]],
  },
  // ---- M2: 旺衰把「我克者死 / 克我者囚」两档对调 ----
  {
    name: 'M2 旺衰: 囚与死两档对调 (金该死判成囚)',
    files: [[KERNEL, (s) => rep(s,
      "    case 'bei_ke': return WANG_XIANG_XIU_QIU_SI.囚;      // 克我者囚 (爻克月令)\n"
      + "    case 'ke': return WANG_XIANG_XIU_QIU_SI.死;          // 我克者死 (月令克爻)",
      "    case 'bei_ke': return WANG_XIANG_XIU_QIU_SI.死;      // 克我者囚 (爻克月令)\n"
      + "    case 'ke': return WANG_XIANG_XIU_QIU_SI.囚;          // 我克者死 (月令克爻)")]],
  },
  // ---- M3: 生泄克耗把「泄/耗」两档漏掉 ----
  {
    name: 'M3 生泄克耗: 删掉 sheng/ke 两档 (我生者/我克者判不出来)',
    files: [[KERNEL, (s) => rep(s,
      "    case 'sheng': return '泄';       // 我生爻 = 我生者(泄)\n"
      + "    case 'ke': return '耗';          // 我克爻 = 我克者(耗)\n",
      "")]],
  },
  // ---- M4: 六亲的爻位基号混用 (0 基 / 1 基) ----
  {
    name: 'M4 六亲: 爻位基号混用 (0 基/1 基错位一爻, 一声不吭)',
    files: [[KERNEL, (s) => rep(s,
      "const r = liuQin.computeLiuQin(guaId, pos - 1);",
      "const r = liuQin.computeLiuQin(guaId, pos);")]],
  },
  // ---- M5: 爻的纳甲地支五行改从 wuxing_map 取 (那张表按 64 卦编号建) ----
  {
    name: 'M5 纳甲地支五行: 改走 wuxing_map (按 64 卦编号建的表, 取地支得到错值)',
    files: [[KERNEL, (s) => rep(s,
      "    const zhiWuxing = typeof nz.wuxing === 'string' ? nz.wuxing : null;",
      "    const zhiWuxing = (function () { try {\n"
      + "      const _m = require(path.join(__dirname, 'wuxing_map.js'));\n"
      + "      const _r = _m.getWuxing(zhi);\n"
      + "      return (_r && _r.wuxing) || null;\n"
      + "    } catch (_) { return null; } })();")]],
  },
  // ---- M6: 两把尺子只给一列 ----
  {
    name: 'M6 渲染: 两把尺子只给一列 (模型会把京房六亲当「这个人的六亲」)',
    files: [[PROD, (s) => rep(s,
      "  lines.push('  两把尺子: 六亲那列的「我」= ' + bridge.measures.liuQin.self\n"
      + "    + '(' + bridge.measures.liuQin.note + '); 生泄克耗那列的「我」= '\n"
      + "    + bridge.measures.relationToDayMaster.self + '(' + bridge.measures.relationToDayMaster.note + ')。');",
      "  lines.push('  六亲口径: 京房宫五行。');")]],
  },
  // ---- M7: 桥接失败时不 return, 把桥整个吞掉 ----
  {
    name: 'M7 接线: 桥接失败时把整个起卦结果吞掉 (主人连卦都看不到)',
    files: [[TOOLS, (s) => rep(s,
      "    if (bridge) {\n"
      + "      return { ok: true, data: Object.assign({}, gua, { najia_bridge: bridge }) };\n"
      + "    }\n"
      + "    return { ok: true, data: gua };",
      "    if (!bridge) return { ok: false, data: null, error: { code: 'NO_BRIDGE', message: '没桥' } };\n"
      + "    return { ok: true, data: Object.assign({}, gua, { najia_bridge: bridge }) };")]],
  },
  // ---- M8: 干支那一头不按 tool 过滤 ----
  {
    name: 'M8 接线: 干支那头不按 tool 过滤 (拿 gua_cast 的条目当盘)',
    files: [[TOOLS, (s) => rep(s,
      "        const _baziCharts = (_charts || []).filter((c) => c && c.tool === 'bazi_calc' && c.pillars);",
      "        const _baziCharts = (_charts || []).filter((c) => c && c.pillars);")]],
  },
  // ---- M9: 桥给了用神爻结论 ----
  {
    name: 'M9 边界: 桥自己给出用神爻结论 (没给的判据自己编)',
    files: [[KERNEL, (s) => rep(s,
      "    yao.push({\n      pos,\n      ganzhi,\n      zhi,\n      zhiWuxing,\n      liuQin: lq,",
      "    yao.push({\n      pos,\n      ganzhi,\n      zhi,\n      zhiWuxing,\n      yongShenYao: pos === 3 ? pos : null,\n      liuQin: lq,")]],
  },
  // ---- M10: 出处台账把「组合」那条从 interpretive 改成 sourced ----
  {
    name: 'M10 出处: 把「串起来这个组合」那条从 interpretive 改成 sourced (拿自己的设计冒充典籍)',
    files: [[PROVENANCE, (s) => rep(s,
      "        field: '「串起来」这个组合(卦接干支=纳甲搭桥)本身 + 桥产出的两把尺子(六亲的我=京房宫五行 / 生泄克耗的我=日主)',\n"
      + "        status: 'interpretive',",
      "        field: '「串起来」这个组合(卦接干支=纳甲搭桥)本身 + 桥产出的两把尺子(六亲的我=京房宫五行 / 生泄克耗的我=日主)',\n"
      + "        status: 'sourced',")]],
  },
  // ---- M11: bridge 层的入口工具清空 (回到「桥没有入口」的老形状) ----
  {
    name: 'M11 分层: bridge 层的入口工具清空 (回到「桥有判据没入口」的老形状)',
    files: [[LAYER_PLAN, (s) => rep(s,
      "    tools: ['gua_cast'],\n    basisLayers: ['bagua_annotations:najia', 'bagua_annotations:liu_qin'],",
      "    tools: [],\n    basisLayers: ['bagua_annotations:najia', 'bagua_annotations:liu_qin'],")]],
  },
];

function main() {
  const orig = new Map();
  for (const f of [KERNEL, PROD, TOOLS, LAYER_PLAN, PROVENANCE]) {
    orig.set(f, fs.readFileSync(f, 'utf8'));
  }

  let killed = 0;
  const blanks = [];
  const errors = [];

  for (const m of MUTANTS) {
    let files = [];
    try {
      files = m.files.map(([f, fn]) => {
        const src = orig.get(f);
        return [f, fn(src)];
      });
    } catch (e) {
      errors.push({ name: m.name, detail: '打变异时炸了: ' + e.message });
      continue;
    }

    const syn = syntaxOk(files.map(([f]) => f));
    if (!syn.ok) {
      // 语法错误的变异 = **假咬住**, 不计入成功数。
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
