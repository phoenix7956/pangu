'use strict';
// 2026-10-16 (老板: "全量重填肯定是大问题, 乾就应该把任务拆了分下去,
// 子 agent 只做自己相关的, 做好汇报, 这个跟你应该是一样的")
//
// 拆解其实是对的 —— `df -h` 被正确拆成 1 个子任务, 工具也按角色收窄到了 17 个
// (j2_dispatcher toolsAllowed → j2_agent_loop _buildRoleToolFilter)。
// 真正的问题在**提示词**: 子 agent 自己的消息列表很精简 (角色提示只有 242 token),
// 但 llm_caller._injectSoulSysMsgs 会把**主 agent 的整套 soul** 扣到它头上。
//
// 实测画像 (一个只跑 `df -h` 的 executor, 抄自 /tmp/pangu-single.log):
//    0-7:system=9918   ← 主 agent 的整套 soul, 其中
//        # 工具清单 (Pangu 拥有的 127 个 …)  4291
//        # 主人长期记忆                       1462
//        # 连续改进 / Continual Harness        518
//        # Pangu 自我进化数据                   347
//        # 自身源码地图                         221
//        # 持久目标                             152
//        # L3 自适应提示                        178
//        基础 soul prompt                     3063
//   10:system=242     ← 它自己的角色提示
//
// **主 agent 的上下文是角色提示的 40 倍。**
//
// 而且工具清单那 4291 不只是贵, 是**错的**: 子 agent 的 API schema 已经被角色
// 白名单收窄到 17 个工具, 提示词却告诉它"Pangu 拥有的 127 个 in-process 工具"。
// 这是在教模型去调它调不到的工具 —— 幻觉出来的调用还会触发 DUPLICATE_TOOL_CALL
// 和重试守门, 白烧好几轮。

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

const first = (m) => String((m || {}).content || '').trim().split('\n')[0];
const has = (msgs, re) => msgs.some(m => re.test(first(m)));
const approxTok = (msgs) => msgs.reduce((s, m) => s + Math.ceil((String(m.content || '').length + 20) * 0.35), 0);

test('worker 档必须把主 agent 专属的块全部摘掉', () => {
  const lc = init();
  const w = lc._buildSystemMessages({}, 'worker');
  // 这些块描述的是**主 agent** 的世界, 子 agent 只知道自己被派的那一件事
  const mainOnly = [
    [/^# 工具清单/, '工具清单 —— 对 worker 是错的: schema 已收窄到 17 个, 这里却说 127 个'],
    [/^# 主人长期记忆/, '主人的偏好/历史是主 agent 的上下文'],
    [/^# 自身源码地图/, '盘古自述用的, worker 不自述盘古是谁'],
    [/^# 连续改进/, '主 agent 的反馈闭环'],
    [/^# 持久目标/, '主 agent 跨轮目标'],
    [/^# L3 自适应提示/, '主 agent 的今日异常聚合'],
    [/^# Pangu 自我进化数据/, '主 agent 的自我进化快照'],
  ];
  for (const [re, why] of mainOnly) {
    assert.ok(!has(w, re), `worker 档不该带 ${re} —— ${why}`);
  }
});

test('worker 档必须保住两样: 基础提示词(工具协议) + 当前时间', () => {
  const lc = init();
  const w = lc._buildSystemMessages({}, 'worker');
  assert.ok(w.length >= 1, 'worker 档不能是空的');
  assert.ok(has(w, /^SOUL_BASE|^# 你是盘古/),
    '基础 soul prompt 没了 —— 它定义工具调用协议/输出格式, 拿掉风险太大');
  assert.ok(has(w, /^# 当前时间 \(权威\)/),
    '当前时间没了 —— worker 答"现在几点/今天几号"会开始用记忆里的旧时间');
});

test('main 档一个字都不能少 (别为了省 token 削主 agent 的记忆)', () => {
  const lc = init();
  const m = lc._buildSystemMessages({}, 'main');
  // 不传 soulScope 必须等价于 main —— 老调用方 (探测/摘要/主循环) 靠这个默认值
  const d = lc._buildSystemMessages({});
  assert.deepEqual(m.map(first), d.map(first), '默认档必须和显式 main 完全一致');
  for (const re of [/^# 工具清单/, /^# 主人长期记忆/, /^# 自身源码地图/]) {
    assert.ok(has(m, re), 'main 档丢了 ' + re + ' —— 主 agent 才是那个需要它的人');
  }
});

test('worker 档必须明显小于 main 档 (省 token 是这层的存在理由)', () => {
  const lc = init();
  const w = lc._buildSystemMessages({}, 'worker');
  const m = lc._buildSystemMessages({}, 'main');
  const ratio = approxTok(w) / Math.max(1, approxTok(m));
  assert.ok(ratio < 0.5,
    `worker/main = ${ratio.toFixed(2)} —— 预期 <0.5, 说明主 agent 的块还在漏进 worker`);
});

test('worker 档是 allowlist: 新加的 soul 块默认不进 worker (漏配的最坏结果只是少一块)', () => {
  // 这条是防回归的设计约定, 不是测当前行为: 用 blocklist 的话, 以后每次加 soul 块
  // 都要记得同步一份黑名单, 忘了就是每个子 agent 每轮白背一遍 —— 而且没人会发现,
  // 因为提示词"看起来是完整的"。
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'modules', 'llm_caller.js'), 'utf8');
  // ⚠ 这里只用来**定位函数体**, 不是钉签名 —— 参数会随需求加 (2026-10-24 第 80 批
  // 加了 callableTools), 钉死参数列表会让这条守卫因为无关的签名变动而失效。
  // 意图是「worker 档是 allowlist」, 定位方式不该比意图更脆。
  const fnMatch = src.match(/function _buildSystemMessages\s*\([^)]*\)/);
  const fnStart = fnMatch ? fnMatch.index : -1;
  assert.ok(fnStart > 0, '找不到 _buildSystemMessages 的 scope 版本');
  const body = src.slice(fnStart, src.indexOf('\n}', src.indexOf('return _finish();', fnStart)));
  // 每个 _push(...) 都要显式给档位掩码, 不许靠默认值
  // ⚠ 只数**调用点**, 不数函数定义 (`const _push = (msg, mask) => {`)。
  //   原来数 /_push\(/g 时函数定义也被算进去, 但那时候的判据是
  //   /,\s*(true|false)\);/ —— 定义行不含这个模式, 于是定义算进分母、
  //   不进分子, 恰好抵消, 看不出来。
  //   换成掩码字符串后定义行的 `, mask)` 依然不匹配 `, 'xxx');`,
  //   抵消就消失了 —— 变成"有 1 处 _push 没标掩码"的假雷。
  //   判据的**意图**是"每个调用都显式标档", 所以数法必须对齐意图:
  //   排除 `const _push = (` 这个定义形态。
  const pushes = (body.match(/_push\(/g) || []).length - (body.match(/const\s+_push\s*=/g) || []).length;
  // 2026-10-25 (第 82 批): 掩码从布尔 (keepForWorker) 换成三档字符串
  //   ('main' / 'main worker' / 'main worker planner' …) —— 布尔表达不了
  //   「main 要、worker 不要、planner 要」这种三选二。
  //   守卫的**意图不变** (每块必须显式写出它进哪几档), 只是数法跟着变:
  //   数末尾那个字符串字面量, 不数 true/false。
  // 仍然不能用 /_push\([^;]*?,\s*(true|false)\)/ —— 源码地图那块内容里有个带 ; 的 IIFE,
  // [^;]* 跨不过去, 会把"其实带了 flag"的判成"没带"。数结尾标志更稳。
  const withMask = body.match(/,\s*'[^']*'\s*\);/g) || [];
  assert.equal(pushes, withMask.length,
    `有 ${pushes - withMask.length} 处 _push 没显式标档位掩码 —— ` +
    '新块会静默按"不进 worker"处理, 必须把意图写出来');
  // 2026-10-25 (第 82 批): **每个掩码都必须含 'main'**。
  //   main 档是"一个字节都不少"的契约 (主 agent 才是那个需要全部记忆的人),
  //   掩码漏掉 'main' = 那一块从主 agent 的上下文里静默消失了 —— 比多给 worker
  //   严重得多: 多给只是贵, 漏给是"主 agent 忘了自己有什么"。
  const masks = body.match(/,\s*'[^']*'\s*\);/g) || [];
  for (const m of masks) {
    const _letters = (m.match(/'([^']*)'/) || ['', ''])[1];
    assert.ok(_letters.indexOf('main') >= 0,
      `掩码 '${_letters}' 缺 'main' —— main 档会丢这块`);
  }
  assert.ok(body.includes('_finish()'), 'worker 档必须真的过滤, 不能只是收集起来');
});

test('j2_agent_loop 的每一处 LLM 调用都要带 soulScope (漏一处 = 那条路径白修)', () => {
  // 和 runtime_verdict 的 user_input 一个教训: 判定逻辑挂在 opts 上, **调用点**才决定
  // 它生不生效。少带一处, 那条路径上就还是全量 soul。
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
  // 数法改成"找出每一个调用点, 看它自己带没带 soulScope" —— 原来靠 `await ` 前缀数,
  // 结果调用一旦被包进 Promise.race(带预算) 这种正当写法, 计数就漏掉它, 守卫反而失灵。
  // 意图是"一处都不许漏", 那就按意图查, 不按写法查。
  const re = /(?:await\s+)?_deps\._callLLMForAgent\(|await _callLLMWithTimeout\(/g;
  const sites = [...src.matchAll(re)];
  const callSites = sites.map(m => m[0]);
  // 范围按**括号配对**取这次调用的实参, 不取固定字符数, 也不跨到下一个调用点 ——
  // 前者会漏判 (首 token 打点那处把几百字注释写在 opts 里), 后者会串味
  // (把后一处的 soulScope 算到前一处头上, 真漏一处反而守卫不响)。两种都试过, 都不行。
  const argSpan = (from) => {
    let i = src.indexOf('(', from), depth = 0;
    for (; i < src.length; i++) {
      if (src[i] === '(') depth++;
      else if (src[i] === ')' && --depth === 0) return src.slice(from, i + 1);
    }
    return src.slice(from);
  };
  const scoped = sites.filter(m => argSpan(m.index).includes('soulScope'));
  assert.ok(callSites.length >= 7, '调用点数量变了 (' + callSites.length + '), 复核一遍');
  assert.equal(scoped.length, callSites.length,
    `${scoped.length}/${callSites.length} 处 LLM 调用带了 soulScope —— 漏掉的那些 ` +
    '在子 agent 里仍然会收到全量 soul 提示词');
});

