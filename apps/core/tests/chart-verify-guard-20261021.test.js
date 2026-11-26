'use strict';
// 2026-10-21 E2E 实跑 r7/r8 的现场调用逐条喂进来。
//
// 这批测试的性质和 chart-fidelity 那批一样: **误报比漏报贵**。
// 拦错了 = 主人问"查一下我笔记里的八字"被按住不让查, 那比多烧两轮模型更糟。
const G = require('../modules/chart_verify_guard.js');
const fs = require('node:fs');
const path = require('node:path');

let pass = 0, fail = 0;
function t(name, fn) {
  try { fn(); console.log('  ✅ ' + name); pass++; }
  catch (e) { console.log('  ❌ ' + name + '  →  ' + e.message); fail++; }
}
function ok(v, msg) { if (!v) throw new Error(msg || '断言失败'); }
function eq(a, b, msg) { if (a !== b) throw new Error((msg || '') + ' 期望 ' + JSON.stringify(b) + ', 实得 ' + JSON.stringify(a)); }
function blocked(name, args) { return G.inspect(name, args).blocked; }

// 现场原样 (r7 / r8)
const R7 = [
  ['exec_command', { command: 'python3 -c "import sxtwl;d=sxtwl.fromSolar(1990,7,22);print(d.getYearGZ().tg,d.getDayGZ().dz)"' }],
  ['exec_command', { command: 'find / -iname "*sxtwl*" -o -iname "*bazi*" 2>/dev/null | head -30' }],
  ['web_search', { q: '1990年7月22日 干支 壬午日 八字' }],
  ['web_fetch', { url: 'https://www.huangli.com/ganzhi/1990-07-22.html' }],
  ['web_fetch', { url: 'https://api.vvhan.com/api/ganzhi?date=1990-07-22' }],
];
const R8 = [
  ['list_pangu_agents', { reason: '确认将灵分工，看看是否有专门排盘/术数 agent 或可获取完整命盘数据' }],
  ['file_grep', { path: '/tmp', pattern: 'bazi_calc' }],
  ['exec_command', { command: 'find / -maxdepth 4 -name "*bazi*" -newermt "-1 hour" 2>/dev/null' }],
];

console.log('\n--- 闸门: 没有盘就一律不拦 ---');
t('toolHistory 里没有成功的排盘 → 一律放行', () => {
  eq(G.succeededChartTools([]).length, 0);
  eq(G.succeededChartTools(undefined).length, 0);
  eq(G.succeededChartTools([{ name: 'bazi_calc', ok: false }]).length, 0, '失败的排盘不算数');
  eq(G.succeededChartTools([{ name: 'exec_command', ok: true }]).length, 0);
});
t('bazi_calc 成功 → 闸门开', () => {
  eq(G.succeededChartTools([{ name: 'bazi_calc', ok: true }]).join(), 'bazi_calc');
  eq(G.succeededChartTools([{ name: 'gua_cast', ok: true }]).join(), 'gua_cast');
});
t('★ bazi_calc 本身永远不拦 —— 换日期重排是正当且 schema 明写的能力', () => {
  eq(blocked('bazi_calc', { year: 1984, month: 3, day: 15 }), false);
  eq(blocked('bazi_calc', { year: 1990, month: 7, day: 22, liunian_months: true }), false);
  eq(blocked('gua_cast', { question: '八字怎么样' }), false);
});

console.log('\n--- 该拦的 (r7/r8 原样) ---');
for (const [name, args] of [...R7, ...R8]) {
  t('拦: ' + name + ' ' + String(args.command || args.q || args.url || args.reason || args.pattern).slice(0, 58), () => {
    ok(blocked(name, args), '未拦');
  });
}
t('r8 的 printf 重算脚本也拦', () => {
  eq(blocked('exec_command', { command: "printf 'import sxtwl\\nd=sxtwl.fromSolar(1990,7,22)\\n'" }), true);
});

console.log('\n--- 不该拦的 (误报区) ---');
t('★ 排完盘之后顺手 grep 一个提到八字的笔记文件 —— 放行', () => {
  eq(blocked('exec_command', { command: 'grep -n "八字" ~/Documents/notes.md' }), false);
  eq(blocked('file_grep', { path: '/Users/you/Documents', pattern: '八字' }), false);
  eq(blocked('exec_command', { command: 'cat /Users/you/Desktop/course-source' }), false);
});
t('跟盘毫无关系的命令放行', () => {
  eq(blocked('exec_command', { command: 'ls -la /Users/you/Desktop/pangu && git log --oneline -3' }), false);
  eq(blocked('web_search', { q: 'macOS launchd 怎么配环境变量' }), false);
  eq(blocked('web_fetch', { url: 'https://nodejs.org/en/docs' }), false);
});
t('查黄历/天气/新闻这类真需求放行 (不是查这张盘)', () => {
  eq(blocked('web_search', { q: '北京 明天天气' }), false);
  eq(blocked('web_search', { q: '今天黄道吉日 宜嫁娶' }), false);
  eq(blocked('news_digest', { keyword: '排盘' }), false);
});
t('非字符串 / 空参数不炸', () => {
  eq(blocked('exec_command', {}), false);
  eq(blocked('exec_command', null), false);
  eq(blocked('web_search', { q: null }), false);
  eq(blocked('exec_command', { command: 12345 }), false);
});
t('exec_command 用 cwd 目录名带 bazi 不该被拦 (路径不是意图)', () => {
  // 命令里出现 "bazi" 这个词不代表在找排盘实现, 关键是要**重算**。
  eq(blocked('exec_command', { command: 'ls ~/Desktop/bazi-notes/' }), false);
});

console.log('\n--- 回灌文案 ---');
t('★ 文案里不许出现"别/不要/验证/核实"这类词', () => {
  // 同一个教训栽了两次: bazi_calc 的 note 上栽过一次, 这里必须一开始就避开。
  // 模型是从提示里**抓词**的, 禁令里的那个名词就是它下一步的素材。
  for (const blocks of [1, 2]) {
    const m = G.message(['bazi_calc'], blocks, '自己去重算');
    for (const w of ['不要', '别', '验证', '核实', '交叉核对']) {
      ok(m.indexOf(w) < 0, '第 ' + blocks + ' 次文案里出现了「' + w + '」: ' + m);
    }
    ok(m.includes('bazi_calc'), '要说清已经有谁算过了');
  }
});
t('第一次拦 = 指路, 第二次拦 = 收口 (只喊两声, 不做无限循环)', () => {
  const m1 = G.message(['bazi_calc'], 1, 'x');
  const m2 = G.message(['bazi_calc'], 2, 'x');
  ok(!/现在就/.test(m1), '第一次不该逼收口: ' + m1);
  ok(/现在就/.test(m2), '第二次该逼收口: ' + m2);
});

console.log('\n--- 接线 (注释不算接线, 铁律一) ---');
t('三条执行路径都要过闸门: 并行 safe / 串行 safe / 串完 unsafe', () => {
  // web_search/web_fetch 走的是 safe 并行那条, exec_command 走 unsafe ——
  // 只在一处挂闸门, 实跑那条路径照样放行。
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  const checks = src.match(/_verifyBlocked\.has\(tc\)/g) || [];
  ok(checks.length >= 3,
    '只有 ' + checks.length + ' 处查了 _verifyBlocked (并行 safe / 串行 safe / unsafe 各要一处)');
});
t('闸门条件必须挂在"本轮已成功排过盘"上, 不是无条件拦', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  ok(/succeededChartTools\(toolHistory\)/.test(src),
    '闸门没接 toolHistory —— 等于所有排盘相关的 exec_command 一律被拦');
});
t('被拦的调用必须仍能配上 tool_result (原生协议不许孤儿)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  ok(/_verifyBlocked\.set\(_tc,/.test(src), '闸门只标记不产出结果 → tool_call 没有配对的 tool_result');
  ok(/_tc,\s*\n\s*\}\);/.test(src) || /_tc\s*\}\s*\)/.test(src),
    '被拦的结果里必须带 _tc, 否则回灌配对会错位');
});
t('拦住 ≠ 失败: ok 必须为 true, 否则会误触发"禁止声称已完成"那套说教', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  const seg = src.slice(src.indexOf('_verifyBlocked.set('), src.indexOf('_verifyBlocked.set(') + 400);
  ok(/ok:\s*true/.test(seg), '被拦结果的 ok 不是 true: ' + seg.slice(0, 200));
  ok(/blocked:\s*true/.test(seg), '被拦结果缺 blocked 标记');
});

console.log('\n============================================================');
console.log('测试结果：' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
console.log('============================================================');
if (fail > 0) process.exit(1);
