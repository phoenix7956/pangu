'use strict';
// 2026-10-15 — soul prompt 被拼两遍: 39% 的 token 是纯重复, prefill 93 秒 → "跟死了一样"
//
// 现场 (真 UI 端点, 主人原话 "只回一个词: 盘古", 编排 bug 修完之后仍然转圈 92 秒):
//
//   [prompt-profile] total=26655 gar_dup=1 at[8]
//    0:system=3063 # 你是盘古 (Pangu) … 127 个工具
//    1:system=178  # L3 自适应提示
//    2:system=1462 # 主人长期记忆
//    3:system=4291 # 工具清单
//    4:system=221  # 自身源码地图
//    5:system=518  # 连续改进
//    6:system=152  # 持久目标
//    7:system=28   [推理预算: 中]
//    8:system=5990 [运行环境 — 路径铁律]        ← 这条是 j2_agent_loop 传的, 不是 soul 块
//    9:system=3063 # 你是盘古 (Pangu) … 127 个工具   ┐
//   10:system=178  …                                   │  整份 soul prompt
//   11:system=1462 …                                  │  逐字重复了一遍
//   12:system=4291 …                                  │
//   13:system=347  # Pangu 自我进化数据                │
//   14:system=221 …                                   │
//   15:system=518 …                                   │
//   16:system=152 …                                  ┘
//   17:system=45   # 当前时间 (权威) 23:17
//   18:system=347  # Pangu 自我进化数据
//   19:system=45   # 当前时间 (权威) 23:18
//   20:user=95     【盘古起卦 …】
//
// 主人那句话 **95 token**, 实际送进模型 **26,655**。约 10,300 (39%) 是纯重复。
// 本地 27B prefill ~285 tok/s → 光 prefill 就 ~93 秒, 实测 duration_ms=92554,
// 一个 token 还没生成就超时 → 界面表现就是"跟死了一样 / 没反应"。
//
// 成因: pangu_agent_stream.js:139 已经拼过一遍 soul messages, llm_caller 的
// _injectSoulSysMsgs 又拼一遍, 而原实现把**所有** system 消息都当"调用方自己传的"
// 原样留下 —— 上一步刚拼进去的那份也被留下, 于是叠成两份。
//
// 为什么不去删 pangu_agent_stream 那次注入: 那条链路里 (auto-resume / prior-turns /
// 落盘) messages 是**唯一**副本, 删了就是静默削指令 —— 正是这批 bug 同一族的错法。
// 所以在 _injectSoulSysMsgs 里去重: 谁注入的不管, 保证最终请求里每块只有一份。

const test = require('node:test');
const assert = require('node:assert/strict');

function init() {
  for (const k of Object.keys(require.cache)) {
    if (k.includes('/pangu/apps/core/modules/llm_caller.js')) delete require.cache[k];
  }
  const lc = require('../modules/llm_caller');
  lc.init({
    _config: { llm: { models: [{}] }, memory: {} },
    fs: require('fs'), path: require('path'), os: require('os'),
    https: require('https'), http: require('http'),
    PRESETS: {}, PANGU_SYSTEM_PROMPT: 'SOUL_BASE',
    _getPromptFacts: () => ({ toolCount: 127, skillCount: 0, skillManifest: '(空)', mcp: { tools: 0, servers: 0 } }),
  });
  return lc;
}

const idOf = (m) => String((m || {}).content || '').trim().split('\n')[0].replace(/\s+/g, ' ').trim().slice(0, 24);

/**
 * 剥掉 `NODE_TEST_CONTEXT` 再 spawn。
 *
 * 2026-10-22 (这把尺子当天犯的第三个错, 前两个是 `\\d` 正则转义 + `__filename` 相对路径):
 *   `node --test` 会给**被测进程**注入 `NODE_TEST_CONTEXT=child-v8`。子进程继承它之后,
 *   node 认为自己正在跑一个测试子进程, 而不是 runner —— 于是**不产 TAP 输出**,
 *   外层数到的 not ok 恒为 0, 负例于是「通过」。
 *   症状极具欺骗性: 同一个命令在终端手跑是 3 条红, 放进测试里就是 0 条。
 *
 * 教训: **断言报错先怀疑尺子** —— 尤其是「负例没咬人」这种, 先怀疑尺子没测到,
 *   别急着改被测代码。
 */
function _cleanEnv() {
  const e = { ...process.env };
  delete e.NODE_TEST_CONTEXT;
  return e;
}

test('核心回归: 模拟"调用方已拼过 soul"再进 _injectSoulSysMsgs, 每块只剩一份', () => {
  const lc = init();
  // 第一次: 调用方(pangu_agent_stream)拼 soul + 自己的运行环境块, 这就是它的产物原样
  const callerPass = lc._injectSoulSysMsgs(
    [{ role: 'system', content: '[运行环境 — 路径铁律] 主机: x.local' }, { role: 'user', content: 'hi' }], {});
  // 第二次: 这份 messages 一路流到 llm_caller, 又被拼一遍 —— 修之前就是这样
  const assembled = lc._injectSoulSysMsgs(callerPass, {});

  const sysIdx = assembled.map((m, i) => (m.role === 'system' ? i : -1)).filter(i => i >= 0);
  const ids = sysIdx.map(i => idOf(assembled[i]));
  const dups = ids.filter((id, i) => ids.indexOf(id) !== i);
  assert.equal(dups.length, 0,
    '还有 ' + dups.length + ' 块重复: ' + [...new Set(dups)].join(' | ') +
    ' —— soul prompt 被拼了两遍, 每遍都按全文重新 prefill');
});

test('时间块跨分钟也要折叠 (按全文去重抓不到这一类)', () => {
  const lc = init();
  // 两次构建跨了分钟 → 「当前时间」内容不同但**块首相同**。实测日志里就是
  // 17:system=45 23:17 与 19:system=45 23:18 同一次请求里各一份。
  const stale = { role: 'system', content: '# 当前时间 (权威)\n\n2026/10/15 23:17 (Asia/Shanghai)' };
  const assembled = lc._injectSoulSysMsgs(
    [stale, { role: 'system', content: '[运行环境]' }, { role: 'user', content: 'hi' }], {});
  const timeIdx = assembled.map((m, i) => (m.role === 'system' && idOf(m) === '# 当前时间 (权威)') ? i : -1)
    .filter(i => i >= 0);
  assert.equal(timeIdx.length, 1, '时间块必须只剩一份, 实得 ' + timeIdx.length);
  // 留的必须是最新的那份
  assert.notEqual(String(assembled[timeIdx[0]].content).includes('23:17'), true,
    '留下的是过期的 23:17, 应该保留刚构建的那份');
});

test('工具清单计数变了也要折叠 (127 → 129, 计数正好落在截断位上)', () => {
  // 实测踩到的第二个坑: 第一版只截前 24 字, 而工具清单首行是
  //   "# 工具清单 (Pangu 拥有的 127 个 in-process 工具,可调 sandbox 执行)"
  // 那个计数落在第 21 位 —— 截 24 字把 "127" 包进去了, 于是 127 与 129 成了两个身份,
  // 4291 token 的工具清单照样叠两份。实测 total 只从 26655 降到 20540, 漏的就是它。
  // 修法: 身份先把数字归一化, 代表"这是哪一块", 不代表"这一块的第几版"。
  const lc = init();
  const stale = { role: 'system', content: '# 工具清单 (Pangu 拥有的 127 个 in-process 工具,可调 sandbox 执行)\n- old_tool' };
  const assembled = lc._injectSoulSysMsgs(
    [stale, { role: 'system', content: '[运行环境]' }, { role: 'user', content: 'hi' }], {});
  const toolIdx = assembled.map((m, i) =>
    (m.role === 'system' && /# 工具清单/.test(String(m.content || ''))) ? i : -1).filter(i => i >= 0);
  const _fresh = assembled.find(m => /# 工具清单/.test(String(m.content || '')));
  assert.equal(toolIdx.length, 1,
    '工具清单叠了 ' + toolIdx.length + ' 份 —— 一份说 127 个一份说 129 个, 身份判定把计数算进去了');
  assert.notEqual(String(_fresh.content), stale.content, '留下的必须是刚构建的那份, 不是过期的');
});

test('★ 工具清单**措辞**改了也不许叠两份 (第 79 批实测: 改头部文案 → 叠两份 4291 token)', () => {
  // 2026-10-24 (第 79 批) 实测踩到的第三个坑, 跟前两个同一个病:
  //   身份函数当时是「首行归一化后截 24 字」, 而**截的是措辞**。
  //   第 79 批把工具清单首行从
  //     「# 工具清单 (Pangu 拥有的 127 个 in-process 工具,可调 sandbox 执行)」
  //   改成
  //     「# 工具清单 (这一轮你**实际能调**的 38 个 in-process 工具,可调 sandbox 执行)」
  //   前 24 字随之变了 ⇒ 同一块的新旧两份判成两块 ⇒ 工具清单**叠两份**,
  //   每份按全文重新 prefill (4291 token) —— 正是那批要治的 prefill 病。
  //   (整链实测: prompt-soul-dedup 的两条身份测试当场变红。)
  //
  // 修法: 身份认**标题** (第一个括号之前), 不认括号里的措辞。
  // 这条测试把"措辞是措辞、标题才是身份"钉死 —— 以后谁再改头部文案, 不会再叠两份。
  const lc = init();
  const stale = {
    role: 'system',
    content: '# 工具清单 (Pangu 拥有的 127 个 in-process 工具,可调 sandbox 执行)\n- OLD_MARKER',
  };
  const assembled = lc._injectSoulSysMsgs(
    [stale, { role: 'system', content: '[运行环境]' }, { role: 'user', content: 'hi' }], {});
  const manifests = assembled.filter(m => /# 工具清单/.test(String(m.content || '')));
  assert.ok(manifests.length >= 1, '工具清单块一块都不剩 = 折叠过头, 把调用方的内容删了');
  assert.equal(manifests.filter(m => /OLD_MARKER/.test(String(m.content))).length, 0,
    '工具清单叠了两份 —— 头部措辞改了就被当成另一块, 4291 token 按全文重新 prefill');
  // 身份函数必须直接判: 旧措辞与新措辞是同一块 (别只靠折叠后的块数间接推断)
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');
  const fnSrc = src.slice(
    src.indexOf('function _sysBlockIdentity'),
    src.indexOf('function _sysBlockIdentity') + 600);
  const end = fnSrc.indexOf('\n}');
  // eslint-disable-next-line no-new-func
  const _id = new Function(fnSrc.slice(0, end + 2) + '\nreturn _sysBlockIdentity;')();
  assert.equal(
    _id('# 工具清单 (Pangu 拥有的 127 个 in-process 工具,可调 sandbox 执行)'),
    _id('# 工具清单 (这一轮你**实际能调**的 38 个 in-process 工具,可调 sandbox 执行)'),
    '旧措辞与新措辞必须判成同一块 —— 身份认标题, 不认括号里的措辞');
});

test('★ 身份函数: 数字归一化是折叠的**前置条件**, 直接断言它 (别靠折叠后块数间接推断)', () => {
  // 2026-10-22 (查「偶发 1/7 失败、零复现」时挖出来的):
  //   上一条测试里写着 `if (toolIdx.length < 2) return;  // 本机没有工具清单时跳过, 不给假绿`
  //   —— 而折叠**成功**时块数**正好是 1** (< 2 成立) → 每一次都提前 return,
  //   断言从不执行。健康机器上它恒假绿, 只有折叠坏掉(块数=2)时才跑断言。
  //   所以「零复现」不是没病, 是这个测法在健康状态下根本不测。
  //
  // 修法: 直接测**前置条件**本身 —— 身份函数必须把 127 与 129 判成同一块。
  // 这个断言与折叠后的块数无关, 健康与否都会跑, 也就不会假绿。
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');
  // 取真实的身份函数体跑, 不重抄一份 —— 重抄一份就是「尺子自己也要校」的反面
  const fnSrc = src.slice(
    src.indexOf('function _sysBlockIdentity'),
    src.indexOf('function _sysBlockIdentity') + 600);
  const end = fnSrc.indexOf('\n}');
  // eslint-disable-next-line no-new-func
  const _sysBlockIdentity = new Function(fnSrc.slice(0, end + 2) + '\nreturn _sysBlockIdentity;')();

  const A = '# 工具清单 (Pangu 拥有的 127 个 in-process 工具,可调 sandbox 执行)';
  const B = '# 工具清单 (Pangu 拥有的 129 个 in-process 工具,可调 sandbox 执行)';
  assert.equal(_sysBlockIdentity(A), _sysBlockIdentity(B),
    '127 与 129 必须判成同一块 —— 那个计数就在第 21 位, 截 24 字会把它包进去');
  // 跨分钟的时间块同理 (按全文去重抓不到这一类)
  assert.equal(
    _sysBlockIdentity('# 当前时间 (权威)\n\n2026/10/15 23:17 (Asia/Shanghai)'),
    _sysBlockIdentity('# 当前时间 (权威)\n\n2026/10/15 23:18 (Asia/Shanghai)'),
    '时间块跨分钟必须判成同一块');
  // 反向: 不同块不许被判成同一块 (归一化过头会把两块叠成一块, 那是另一种错)
  assert.notEqual(
    _sysBlockIdentity('# 工具清单 (Pangu 拥有的 127 个 …)'),
    _sysBlockIdentity('# 主人长期记忆 (自动加载 ~/.pangu/memory/MEMORY.md)'),
    '两块不同的 soul 块被归一成同一个身份 —— 会被误折叠');
  // 多模态数组不参与去重 (宁可不删)
  assert.equal(_sysBlockIdentity([{ type: 'text', text: '# 当前时间' }]), '');
});

test('★ 折叠真发生 (不许用「块数<2 就跳过」把断言跳没)', () => {
  // 上一条修的是判据, 这一条钉住**折叠行为本身**。
  // 造两份明确同身份的工具清单 (127 / 129), 断言最终只剩一份且是新的那份。
  // 任何 `if (结果符合预期) return;` 都会让这条测试在健康时假绿 —— 所以这里
  // 断言的是**否定命题**: 折叠前的两份, 折叠后必须不等于两份。
  const lc = init();
  const oldOne = { role: 'system', content: '# 工具清单 (Pangu 拥有的 127 个 in-process 工具)\n- OLD_MARKER' };
  const assembled = lc._injectSoulSysMsgs(
    [oldOne, { role: 'system', content: '[运行环境]' }, { role: 'user', content: 'hi' }], {});
  const manifests = assembled.filter(m => /# 工具清单/.test(String(m.content || '')));
  assert.ok(manifests.length >= 1, '工具清单块一块都不剩 = 折叠过头, 把调用方的内容删了');
  assert.equal(manifests.filter(m => /OLD_MARKER/.test(String(m.content))).length, 0,
    '过期那份没被折叠掉 —— 工具清单叠了两份, 每份按全文重新 prefill (4291 token)');
});

test('★ 负例: 拆坏数字归一化, 这几条必须咬人 (守卫不许是永真)', () => {
  // 「守卫在不在」和「守卫会不会咬人」是两件事。
  // 上一批 (2026-10-22) 就是**在但不咬**: 断言被 `if (... < 2) return` 跳过,
  // 健康机器上恒绿。这条把身份函数改回旧版 (只截 24 字, 不归一化数字),
  // 断言至少两条会红 —— 咬人证据, 不是「跑一下没报错」。
  const fs = require('fs');
  const path = require('path');
  const sp = require('child_process').spawnSync;
  const LC = path.join(__dirname, '..', 'modules', 'llm_caller.js');
  // ⚠️ 必须绝对化: `node --test <file>` 跑整个文件时 __filename 是**相对路径**,
  //   而下面 spawnSync 的 cwd 被设成 apps/core —— 相对路径在新 cwd 下解析到别处,
  //   子进程跑了个别的文件, 于是 out 里 0 条 not ok, 负例永远「通过」。
  //   (这已是这把尺子当天犯的第二个错: 第一个是 `\\d` 正则转义。断言报错先怀疑尺子。)
  const SELF = path.resolve(__filename);
  const orig = fs.readFileSync(LC, 'utf8');
  try {
    // ⚠️ 用**字符串**替换, 不用正则:
    //   正则字面量里 `\\d` 是「反斜杠 + d」两个字符, 而源码里是 `\d` (一个转义),
    //   两者不等 → 正则永不匹配。这不是被测代码的问题, 是**尺子自己错了**
    //   (踩坑日志铁律: 断言报错先怀疑尺子)。
    //
    // 2026-10-24 (第 79 批): 针脚跟着判据一起搬家。
    //   身份函数从「首行归一化后截 24 字」改成「标题 + 归一化计数」——
    //   归一化那一行现在是 `return _id.replace(/\d+/g, '#')`。
    //   **判据变了, 变异针脚必须跟着变**, 否则这条负例会变成「找不到针脚」的假红,
    //   而它本来的职责是证明「守卫生效时真的会咬人」——那才是尺子的尺子。
    const NEEDLE = "return _id.replace(/\\d+/g, '#')";
    assert.ok(orig.includes(NEEDLE),
      '没找到身份函数里的数字归一化 —— 写法可能变了, 先核 llm_caller.js 的 _sysBlockIdentity');
    const broken = orig.replace(NEEDLE, 'return _id');
    fs.writeFileSync(LC, broken, 'utf8');
    // ⚠️ 必须用 --test-name-pattern 隔开**本条自己**:
    //   子进程跑整个文件时, 第 6 条会再跑一遍负例 → 无限套娃,
    //   外层读到的是内层的结果, 判据变得不可靠 (实测 0 条红的假通过)。
    //   只跑「折叠 | 身份函数」那几条, 它们才是被拆坏后该红的。
    const r = sp(process.execPath,
      ['--test', '--test-name-pattern', '折叠|身份函数', SELF],
      { encoding: 'utf8', env: _cleanEnv() });
    const out = (r.stdout || '') + (r.stderr || '');
    const reds = (out.match(/^not ok /gm) || []).length;
    assert.ok(reds >= 2,
      '拆坏数字归一化后只有 ' + reds + ' 条红 —— 断言不够咬人, 或又写成了提前 return');
  } finally {
    // 尺子自己也要校: 真源必须还原
    fs.writeFileSync(LC, orig, 'utf8');
  }
  // ⚠️ 还原检查**直接比字节**, 不重跑整份测试文件:
  //   重跑会让本条再次进入 → 又 spawn 整份文件 → 无限套娃(实测卡死 2 分钟以上)。
  //   「真源还原了」这件事, 比字节比跑测试更直接也更可信。
  assert.equal(fs.readFileSync(LC, 'utf8'), orig, '真源没还原干净');
});

test('去重和诊断必须用同一个身份函数 (两套标准 = 诊断等于没有)', () => {
  // [prompt-profile] 是发现这类 bug 的唯一入口 (gar_dup=0 才敢放心)。
  // 它若按自己的标准算重复、去重按另一套算, 就会报"没有重复"而实际还在叠。
  const fs = require('fs');
  const path = require('path');
  const src = fs.readFileSync(path.join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');
  const occurrences = src.match(/_sysBlockIdentity\(/g) || [];
  // 定义 1 + 调用若干; 关键是**没有第二份实现** (内联 arrow function 那种)
  assert.equal((src.match(/function _sysBlockIdentity/g) || []).length, 1,
    '身份函数出现多份定义 —— 去重和诊断迟早会用不同标准');
  assert.ok(occurrences.length >= 3,
    '身份函数调用点太少: ' + occurrences.length + ' 处 (应为: 去重 + 诊断 + 测试外至少两处)');
  // 诊断那段不许自己再实现一遍
  const prof = src.slice(src.indexOf('if (inputTokens > 12000)'), src.indexOf('[prompt-profile] sid='));
  assert.match(prof, /_sysBlockIdentity\(/, 'prompt-profile 必须复用 _sysBlockIdentity, 不许自己再算一套');
});

test('调用方自己的 system 块一个字都不能少 (不能改成"清空所有 system")', () => {
  const lc = init();
  // prompt-assembled-order 钉着这条: 调用方传进来的每条 system 必须原样保留。
  // 去重只能删"确实是 soul 块副本"的, 不许顺手把调用方的内容清掉。
  const a = { role: 'system', content: '[运行环境 — 路径铁律] 主机: x.local' };
  const b = { role: 'system', content: '[自查纪律 · 系统强制] 这是关于你自己的问题。' };
  const c = { role: 'system', content: '[CALLER_UNIQUE]' };
  const assembled = lc._injectSoulSysMsgs([a, b, c, { role: 'user', content: 'hi' }], {});
  for (const orig of [a, b, c]) {
    assert.ok(assembled.some(m => m.content === orig.content),
      '调用方的 system 被误删: ' + idOf(orig));
  }
});

test('非字符串 content (多模态数组) 不参与去重, 宁可不删', () => {
  const lc = init();
  const multimodal = {
    role: 'system',
    content: [{ type: 'text', text: '# 当前时间 (权威)\n\n2026/10/15 23:17' }],
  };
  const assembled = lc._injectSoulSysMsgs([multimodal, { role: 'user', content: 'hi' }], {});
  assert.ok(assembled.some(m => m === multimodal || m.content === multimodal.content),
    '多模态 system 块被误删 —— 没有可比首行就不该按身份折叠');
});

test('prompt-profile 诊断要能看见这类重复 (原来只数 [运行环境], 于是 gar_dup=1 全是漏的)', () => {
  // 诊断不是装饰: 这个 bug 之所以藏了半天, 就是因为 gar_dup 看不见 soul 块重复。
  // 修完去重后它应该恒为 0; 万一哪天又有人注入两次, 画像里会直接报出来。
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');
  const prof = src.slice(src.indexOf('if (inputTokens > 12000)'), src.indexOf('[prompt-profile] sid='));
  assert.ok(!/indexOf\('\[运行环境 — 路径铁律\]'\)/.test(prof),
    '画像还在只数 [运行环境] —— soul 块重复会继续隐身');
  assert.match(prof, /_seenIds/, '画像必须按块首身份统计重复');
});

