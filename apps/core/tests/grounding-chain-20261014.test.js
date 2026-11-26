// 2026-10-14 溯源链强校验
//
// 缺口: run_trace 原来只有一条 claim, 内容是 "调用 exec_command"。
// 那说的是"我调过工具", 不是"答案里的数字来自工具" —— 溯源链断在工具这一层。
// 子 agent 凭空写 "共 40 个文件", trace 里照样一片 grounded, 事后查无实据。
//
// 这些断言锁的是**判定质量**, 尤其是误报: 接地核查一旦撒谎就没人再信它,
// 所以"不该抓的别抓"和"该抓的抓住"一样重要。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const fs = require('fs');

const M = (p) => require(path.join(__dirname, '..', p));
const gc = M('modules/grounding_check.js');

test('G1 数字对不上必须判未接地 (这正是要抓的那类编造)', () => {
  const r = gc.check('共 40 个文件需要改', [{ ok: true, result: 'found 37 files' }]);
  assert.strictEqual(r.total, 1);
  assert.strictEqual(r.ungrounded_count, 1, '答案说 40、证据是 37, 必须报未接地');
  assert.strictEqual(r.grounded, 0);
});

test('G2 对得上的必须放行 (否则守卫天天误报, 等于没有)', () => {
  const r = gc.check('共 40 个文件需要改', [{ ok: true, result: 'found 40 files' }]);
  assert.strictEqual(r.ungrounded_count, 0);
  assert.strictEqual(r.grounded, 1);
});

test('G3 中文量纲后面不能有 \\b —— 否则一条计数都抓不到', () => {
  // 回归: JS 的 \b 只认 [A-Za-z0-9_], 中文不是 \w。
  // "40 个文件" 里 个 后面紧跟 文, 没有边界 → 用 \b 的版本永远匹配失败,
  // 整条计数断言静默失效, 看起来"全接地"其实根本没检查。
  const c = gc.extractClaims('共 40 个文件');
  assert.strictEqual(c.length, 1, '中文单位必须能抓到, 实测 ' + JSON.stringify(c));
  assert.strictEqual(c[0].kind, 'count');
  assert.strictEqual(c[0].norm, '40');
});

test('G4 日期两边写法不同也要能对上 (规范化两边, 不是只切 claim)', () => {
  const r = gc.check('2026-10-14 的报告显示异常', [{ ok: true, result: '2026年10月14日: 报告已出' }]);
  assert.strictEqual(r.ungrounded_count, 0, '日期格式不同不该误报');
});

test('G5 列表序号不是断言 (否则每条建议都变成未接地)', () => {
  const c = gc.extractClaims('1. 第一条建议\n2. 第二条建议\n3. 第三条建议');
  assert.strictEqual(c.length, 0, '纯序号不该算断言, 实测 ' + JSON.stringify(c));
});

test('G6 没有断言的答案不许判失败 (无话可说 ≠ 编造)', () => {
  const r = gc.check('我没查到任何数据，无法回答。', [{ ok: true, result: 'nothing' }]);
  assert.strictEqual(r.total, 0);
  assert.strictEqual(r.grounded_ratio, 1, '没有断言就不该有未接地率');
});

test('G7 没调过工具却报一堆数字 = 最强编造信号', () => {
  const r = gc.check('共 12 个文件全部通过检查', []);
  assert.strictEqual(r.evidence_chars, 0);
  assert.ok(r.total > 0 && r.ungrounded_count > 0,
    '零证据 + 有数字必须全部落在未接地, 实测 total=' + r.total);
});

test('G8 失败的工具结果不算证据 (报错信息不能拿来当依据)', () => {
  const r = gc.check('共 5 个文件已确认', [{ ok: false, error: 'command failed: 5 files' }]);
  assert.strictEqual(r.evidence_chars, 0, '失败结果不该进证据池');
  assert.strictEqual(r.ungrounded_count, 1);
});

test('G9 各种量纲都要抓, 且千分位不影响匹配', () => {
  const text = '耗时 2.5 秒, 占用 87% 内存, 涉及 1,240 个文件, 花费 320 元, 版本 1.2.3';
  const ev = 'took 2.5s, 87% mem, 1240 files, cost 320元, v1.2.3';
  const r = gc.check(text, [{ ok: true, result: ev }]);
  assert.ok(r.total >= 5, '五种量纲都该抓到, 实测 total=' + r.total + ' ' + JSON.stringify(r.ungrounded));
  assert.strictEqual(r.ungrounded_count, 0, '千分位 1,240 应与证据里的 1240 等价');
});

test('G10 必须真的接到 trace 上 (导出函数没人调等于没做)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'agents', 'sub-agent.js'), 'utf8');
  assert.ok(src.includes('grounding_check'), 'sub-agent.js 必须 require grounding_check');
  assert.ok(src.includes('_trace.event(\'grounding\''), '必须把接地统计写进 trace, 否则查不到');
  assert.ok(src.includes('fabricated_signal'), '零证据+有数字 要单独标出来');
  // 只留痕不改答案: 文本判定有误报, 拿它拦答案会把真结论判死
  assert.ok(!/grounding[\s\S]{0,400}finalText\s*=/.test(src), '不许用接地结果去改写/替换答案');
});

// ===== 第二条发射路径 (2026-10-14 现场补) =====
//
// 生产实测 (gc-verify-1): 接完 sub-agent.js 之后跑真实任务, trace 里
// grounding 事件**仍然是 0**。查出来是因为有第二个发射点 ——
// j2_agent_loop.js 的 DAG/role 路径自己开 trace、自己结算 (finally 里发 result+summary),
// 根本不经过 sub-agent.js。session id 形态也不一样:
//   sub-agent.js      → gc-verify-1#sub-fixed-0-analyzer
//   j2_agent_loop.js  → gc-verify-1#sub-0-checker / #sub-1-analyzer
// 只接一条 = 看着接好了, 实际生产那条根本没接。

test('G11 j2_agent_loop 这条路径也必须接上 (生产实际跑的是它)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.ok(src.includes('grounding_check'), 'j2_agent_loop 必须 require grounding_check');
  assert.ok(src.includes('_emitGrounding'), '必须有 _emitGrounding 发射器');
  assert.ok(src.includes('const _emitGrounding'), '必须真的定义发射器');
  // 两条结算路径都要发 (roleTrace + mainTrace)。定义处是 `const _emitGrounding =`,
  // 不带左括号, 所以这里数到的应该正好是 2 个调用点。
  const calls = src.match(/_emitGrounding\(/g) || [];
  assert.strictEqual(calls.length, 2, 'roleTrace + mainTrace 两个调用点, 实测 ' + calls.length);
  assert.ok(/if \(_roleTrace\)[\s\S]{0,200}_emitGrounding/.test(src), '将灵 trace 结算前必须先发接地统计');
  assert.ok(/if \(_mainTrace\)[\s\S]{0,200}_emitGrounding/.test(src), '主 trace 结算前也必须发');
});

test('G12 两条路径的证据形状不同, 收集器必须都认 (否则永远零证据)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  assert.ok(src.includes('tr.tc ? (tr.execResult || {}) : tr'),
    'native 路径是 {tc, execResult}, legacy 是 {ok, result} —— 收集器必须同时认两种');
  // native 的两个塞入点都要收
  const pushes = src.match(/_collectEvidence\(\[\{/g) || [];
  assert.ok(pushes.length >= 2, 'native 两个 toolResults.push 点都要收, 实测 ' + pushes.length);
  assert.ok(src.includes('_collectEvidence(toolResults)'), 'legacy 路径也要收');
  assert.ok(src.includes('_GROUNDING_MAX_CHARS'), '证据必须有上限, 不然长任务把内存吃光');
});

test('G13 盘古工具的载荷在 data 字段, 不是 result (只认 result = 整套空转)', () => {
  // 现场 (gc-verify-2): 事件发了, 但 evidence_chars 恒为 0。
  // 根因: 盘古工具返回 { ok: true, data: {...} }, 证据提取只找 result,
  // 于是证据池永远是空的 —— 校验"跑通了"但什么也没校验, 比不接更坏。
  const tools = require(path.join(__dirname, '..', 'modules', 'tools', 'index.js'));
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'tools', 'index.js'), 'utf8');
  assert.ok(/return\s*\{\s*ok:\s*true,\s*data:/.test(src), '工具成功载荷字段确实是 data');
  const r = gc.check('共 8 个 CPU 核心', [{ ok: true, data: { cores: 8, mem: '61GB' } }]);
  assert.strictEqual(r.evidence_chars > 0, true, 'data 里的内容必须进证据池');
  assert.strictEqual(r.ungrounded_count, 0, '8 在 data 里, 不该判未接地');
  // 反向: 只有 result 的也要认 (两条路径形状不同)
  const r2 = gc.check('共 8 个核心', [{ ok: true, result: '8 cores' }]);
  assert.strictEqual(r2.ungrounded_count, 0, 'legacy 形状也要认');
  assert.ok(typeof tools === 'object', 'tools 模块可加载');
});

// ===== 误报治理 (现场 gc-verify-3) =====
//
// 第一次接上之后跑真实任务, 诚实答案的误报率到了 40-48%:
// 子 agent 把 hw.memsize 的 137438953472 字节写成"128 GiB" —— 这是**如实换算**,
// 不是编造。但字面匹配永远找不到 "128" 这三个字, 于是全判未接地。
// 一个错一半的校验等于没有校验: 看的人只会以为盘古又在瞎报, 然后整体不信。

test('G14 字节↔GiB 如实换算必须算接地 (现场误报 40-48% 的元凶)', () => {
  const ev = [{ ok: true, data: { stdout: '18\n137438953472\n' } }];
  const r = gc.check('内存 128 GiB', ev);           // 137438953472 / 1024^3 = 128
  assert.strictEqual(r.ungrounded_count, 0, '如实换算被判编造 = 校验失去公信力');
  // 反向: 答案写原始字节数, 证据里是换算值
  const r2 = gc.check('内存 137438953472 字节', ev);
  assert.strictEqual(r2.ungrounded_count, 0, '反向换算也要认');
});

test('G15 换算判定必须严 (放宽就变成"什么都能对上")', () => {
  const ev = [{ ok: true, data: { stdout: '18\n137438953472\n' } }];
  // 差得远的数字不许因为"单位一样"就算接地
  const r = gc.check('内存 64 GiB', ev);
  assert.strictEqual(r.ungrounded_count, 1, '64 GiB 和 128 GiB 不是一回事');
});

test('G16 "5.9 GiB" 里的 5.9 不是版本号 (否则同一条断言被抽两遍)', () => {
  const c = gc.extractClaims('实测 5.9 GiB, 版本 v1.2.3 已发布');
  const kinds = c.map(x => x.kind);
  assert.ok(!kinds.includes('version') || c.filter(x => x.kind === 'version').length === 1,
    '5.9 不该被当版本号, 实测 ' + JSON.stringify(c));
  const ver = c.filter(x => x.kind === 'version');
  assert.strictEqual(ver.length, 1, '只有 v1.2.3 该算版本, 实测 ' + JSON.stringify(ver));
  assert.strictEqual(ver[0].norm, '1.2.3');
});

// ===== 误接地比漏报严重得多 (现场 dbg) =====
//
// 接上换算之后测真 vm_stat, 冒出更要命的一条:
//   断言 "7 GiB" → grounded=true
// 根因: 老写法 ev.includes("7") 对上的是证据里的 3814005 —— 只要证据里**任何位置**
// 出现过数字 7, 任何一位数断言就算接地。
// 方向和漏报正好相反: 漏报是没查出来, 误接地是**谎报通过**。校验一旦开始撒谎,
// 它报的所有未接地也会一起被当成噪声 —— 整条链路一起废掉。

test('G17 一位数断言不许靠"证据里碰巧有这一位"蒙混 (谎报通过)', () => {
  const ev = [{ ok: true, data: { stdout: 'Pages free: 3814005.\nPages active: 2084212.\n' } }];
  // 7 出现在 3814005 / 2084212 里, 但没有任何证据支持"7 GiB"
  const r = gc.check('内存 7 GiB', ev);
  assert.strictEqual(r.ungrounded_count, 1, '7 藏在 3814005 里就算接地 = 谎报通过');
  // 反向: 证据里真的有独立的 7 时才算数
  const r2 = gc.check('共 7 项', [{ ok: true, result: 'found 7 items' }]);
  assert.strictEqual(r2.ungrounded_count, 0, '独立出现的 7 应当接地');
});

test('G18 页数换算必须真的接上 (_norm 去空格后 "page size of" 变 "pagesizeof")', () => {
  // 真实 vm_stat 形态: 内存数字是 页数 × page size 算出来的
  const pages = 3821330;
  const stdout = 'Mach Virtual Memory Statistics: (page size of 16384 bytes)\n'
    + 'Pages free: ' + pages + '.\nPages active: 2084212.\n';
  const ev = [{ ok: true, data: { stdout } }];
  const gib = (pages * 16384 / 1024 ** 3).toFixed(1);      // 58.3
  const r = gc.check('内存 ' + gib + ' GiB', ev);
  assert.strictEqual(r.ungrounded_count, 0, '页数换算没接上 (正则没扛住去空格)');
  const r2 = gc.check('内存 7 GiB', ev);
  assert.strictEqual(r2.ungrounded_count, 1, '页数换算不许放宽成什么都蒙得对');
});

test('G19 GB/MB 两种进制都要认 (137438953472 既是 128 GiB 也是 137.44 GB)', () => {
  const ev = [{ ok: true, result: 'hw.memsize = 137438953472' }];
  assert.strictEqual(gc.check('内存 137.44 GB', ev).ungrounded_count, 0, '十进制 GB 要认');
  assert.strictEqual(gc.check('内存 128 GiB', ev).ungrounded_count, 0, '二进制 GiB 要认');
  assert.strictEqual(gc.check('内存 512 GB', ev).ungrounded_count, 1, '差得远的仍要判未接地');
});

test('G20 千分位数字不许被截成 "072" (现场 gc-verify-5 抽出来的脏值)', () => {
  const c = gc.extractClaims('进程占用 1,072 MB 内存');
  assert.strictEqual(c.length, 1);
  assert.strictEqual(c[0].norm, '1072', '应抽到 1072 而不是被逗号切出来的 072, 实测 ' + JSON.stringify(c));
  // 抽对了才谈得上核对: 证据里的 1072 要能对上
  const r = gc.check('占用 1,072 MB', [{ ok: true, result: 'rss 1072 MB' }]);
  assert.strictEqual(r.ungrounded_count, 0, '千分位写法不该导致核不上');
});
