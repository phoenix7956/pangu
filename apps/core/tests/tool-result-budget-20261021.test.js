'use strict';
// 2026-10-21 E2E 实跑第 9 轮抓到的原凶。
//
// 现场那条答复原话:
//   「bazi_calc 返回内容较长被截断, 约 **15208 字节**仅见前 **3000**,
//     其原文"大运/流年/藏干/纳音"字段我未直接读到」
//   然后它拿手上仅有的五行统计**反推时柱**, 推出 壬子 (真值 己未)。
//
// 15208 和 3000 两个数字都是**准的** —— 模型没有编, 它如实报告了。
// 真凶是 run_trace.js 里的 `const DEFAULT_MAX_BYTES = 3000`:
//   子 agent 路径上这道是**唯一**一道 (主循环那 24,000 字符只管主循环),
//   而四柱落在第 3,592 字节, 正好在被砍掉的 12% 那一段里。
//
// 教训写在这里是为了防重犯:
//   「把静默截断改成可观测截断」解决的是**静默**, 不解决**砍太狠**。
//   砍掉的量本身就是错误答案的来源 —— 边界必须在砍之前就定对。
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const RT = require('../modules/run_trace.js');
const { TOOLS } = require('../modules/tools');

let pass = 0, fail = 0;
async function t(name, fn) {
  try { await fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + '  →  ' + e.message); fail++; }
}

// 扫代码前先剥注释 —— 这批断言量的都是"代码里还有没有"。
// 不剥的话, 一句「原来这里是 .slice(0, 3000)」的历史说明就会把断言顶红,
// 顶两次之后人就懒得看这个测试了, 守卫自己先失效。
// (注释里该留历史还得留 —— 该改的是量它的尺子, 不是把历史擦掉。)
function code(file) {
  return fs.readFileSync(file, 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '')
    .replace(/\/\/.*$/gm, '');
}

// 1990-7-22 14:00 女 —— 就是实跑那一天
const ARGS = { year: 1990, month: 7, day: 22, hour: 14, minute: 0, gender: 'female' };

(async () => {
  const r = await TOOLS.bazi_calc({ params: ARGS });
  const s = JSON.stringify(r);
  const bytes = Buffer.byteLength(s, 'utf8');
  const byteOf = (needle) => Buffer.byteLength(s.slice(0, s.indexOf(needle)), 'utf8');

  console.log('\n--- 现场数字 (r9 实测) ---');
  console.log('  bazi_calc 默认返回: ' + bytes + ' 字节');
  console.log('  四柱落在第 ' + byteOf('庚午(年柱)') + ' 字节');
  console.log('  trace 默认额度:     ' + RT.DEFAULT_MAX_BYTES + ' 字节');

  console.log('\n--- 额度本身 ---');
  await t('默认额度必须装得下 bazi_calc 的默认返回 (否则四柱又落在外面)', () => {
    assert.ok(RT.DEFAULT_MAX_BYTES >= bytes,
      '额度 ' + RT.DEFAULT_MAX_BYTES + ' < 返回 ' + bytes + ' 字节 —— 四柱照样看不见');
  });
  await t('★ 四柱必须落在额度之内 (这条是本次事故的直接判据)', () => {
    assert.ok(byteOf('庚午(年柱)') < RT.DEFAULT_MAX_BYTES,
      '四柱在第 ' + byteOf('庚午(年柱)') + ' 字节, 额度只有 ' + RT.DEFAULT_MAX_BYTES);
  });
  await t('额度不得低于旧值 3000 (回退保护: 改预算的人不许把它改回去)', () => {
    assert.ok(RT.DEFAULT_MAX_BYTES > 3000,
      '额度回到 ' + RT.DEFAULT_MAX_BYTES + ' —— 现场那个坑原样复现');
  });
  await t('中文结果按字节换算过 (1 字符 = 3 字节, 不换算中文天生少拿三分之二)', () => {
    assert.ok(RT.DEFAULT_MAX_BYTES >= RT.TOOL_RESULT_MAX_CHARS * 2,
      '额度 ' + RT.DEFAULT_MAX_BYTES + ' vs 字符预算 ' + RT.TOOL_RESULT_MAX_CHARS
      + ' —— 纯中文内容按 3 字节/字符算, 2 倍都不够');
  });
  await t('env 旋钮还在 (PANGU_TOOL_RESULT_MAX_CHARS 仍是总闸)', () => {
    assert.ok(RT.TOOL_RESULT_MAX_CHARS >= 4000, '字符预算被调到不合理值: ' + RT.TOOL_RESULT_MAX_CHARS);
  });

  console.log('\n--- 单一真源 (两份常量已经漂过一次) ---');
  await t('j2_agent_loop 的额度必须取自 run_trace, 不再自己抄一份', () => {
    const src = code(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'));
    assert.ok(/const TOOL_RESULT_MAX_CHARS = require\('\.\/run_trace'\)\.TOOL_RESULT_MAX_CHARS;/.test(src),
      '主循环又自己 parse 了一份 env');
  });
  await t('子 agent 无 trace 的兜底路径不许再硬编码 3000', () => {
    const src = code(path.join(__dirname, '..', 'agents', 'sub-agent.js'));
    assert.ok(!/slice\(0, 3000\)/.test(src), 'sub-agent.js 里还留着 slice(0, 3000)');
    assert.ok(/DEFAULT_MAX_BYTES/.test(src), '兜底路径没接 run_trace 的额度');
  });
  await t('⚠️ 观测开关不许改变答案 (开 trace / 不开 trace 看到的量必须一样)', () => {
    // 这条是本次事故最深的一层: 额度曾挂在 trace 上,
    // 于是"开不开观测"决定了模型看见多少盘 —— 答案本身随观测开关漂移。
    const src = code(path.join(__dirname, '..', 'agents', 'sub-agent.js'));
    assert.ok(!/raw\.length > 3000/.test(src), '兜底仍按字符数 3000 判, 与 trace 那条按字节 → 两路视野不同');
  });

  console.log('\n============================================================');
  console.log('测试结果：' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
  console.log('============================================================');
  if (fail > 0) process.exit(1);
})();
