'use strict';
// 2026-10-16 (老板: "子 agent 只做自己相关的, 做好汇报, 这个跟你应该是一样的")
// 第二刀: 全局铁律按作用域分档。
//
// 第一刀 (7b5f088) 把 llm_caller 里的 soul 分了档, 子 agent 每轮 ~16400 → ~9700。
// 剩下的 9700 里最大一块是 `[运行环境 — 路径铁律]` (~5900 tk), 主体是
// GLOBAL_AGENT_RULES —— 27 条铁律, **不分角色**全量下发。
//
// 分档依据不是"哪条重要", 是**这条约束的是谁**:
//   worker 留 —— 诚实与工具纪律。一个跑 `df -h` 的 executor 最容易犯、也最该有的,
//     恰恰就是这些: 失败要明说 / 必须调工具 / 未完成禁止说完成 / 别重试同一个失败工具。
//   主 agent 独占 —— 讲的是**盘古怎么面对主人**、以及盘古怎么管自己:
//     自我修改授权 / 卦先于推理 / 对话风格(老板) / 按顺序一个来 / 自我认知 64i /
//     大体量任务自拆 …… 子 agent 不面对主人, 也不该拿到"可以改盘古代码"的授权。
//
// 其中 #24「大体量任务必须自拆」尤其该留在主 agent: 拆分是乾的活, 乾拆完才轮到
// 将灵各干各的。让子 agent 也去拆, 就等于让八个都掉一样的工具 —— 正是 tool_role_map
// 开头那句"没意义"。

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const GAR = require('../modules/global_agent_rules');
const LOOP_SRC = fs.readFileSync(path.join(__dirname, '..', 'modules', 'j2_agent_loop.js'), 'utf8');
const GAR_SRC = fs.readFileSync(path.join(__dirname, '..', 'modules', 'global_agent_rules.js'), 'utf8');

const approxTok = (s) => Math.ceil((String(s).length + 20) * 0.35);

const WORKER_MUST_KEEP = ['失败要明说', '必须调工具', '不能嘴上说', 'Pangu 沙箱自治', '不要重试同一个失败工具',
  '任务未完成禁止说', '连续失败熔断', '禁止伪造系统级状态', '禁止装饰性输出', '禁止循环调用 permission_apply',
  '空响应优先级', '验证状态用工具'];

const MAIN_ONLY = ['自我修改授权', '卦先于推理', '对话风格 — 老板', '按顺序一个来', '自我认知 — 你有 64i',
  '大体量任务必须自拆', '问什么答什么', '主人拍板'];

test('RULES 里每一条都必须显式标 worker (漏标 = 子 agent 白背一条, 没人会发现)', () => {
  assert.ok(Array.isArray(GAR.RULES), '必须导出 RULES 数组, 否则作用域藏在渲染逻辑里看不见');
  assert.equal(GAR.RULES.length, 27, '规则条数变了 (' + GAR.RULES.length + '), 复核分档');
  for (const r of GAR.RULES) {
    assert.strictEqual(typeof r.worker, 'boolean',
      '第 ' + r.n + ' 条没标 worker —— 靠"忘了就默认 main"是这类 bug 的温床');
    assert.ok(typeof r.text === 'string' && r.text.trim(), '第 ' + r.n + ' 条正文丢了');
  }
});

test('主 agent 的铁律必须与拆分前逐字相同 (这次只改"发给谁", 不改"写的是什么")', () => {
  // 这是整个改动最硬的约束: 重排 10513 字符的模板字符串, 手打必错。
  // 生成时按规则边界机械切分, 这里把长度和导出一致性都钉住。
  //
  // 2026-10-21: 原来第一行钉的是"主档 10513 字符"这个**魔数** ——
  // 规则 19 改了措辞 (老板 10-09「事实在前」裁定落到提示词) 它当场红。
  // 那个魔数防的是"有人手改了导出的字符串"; 而导出**现在是从 RULES 现渲染的**
  // (GLOBAL_AGENT_RULES = renderGlobalAgentRules('main')), 手改导出已经不可能。
  // 魔数只会在"有人合法改了某条规则"时红 —— 那是假雷, 顶两次就没人看这个测试了。
  // 换成结构断言: 条数不变 + 每条非空 + 导出 === 现渲染 (真正的守卫, 下面那句)。
  assert.equal(GAR.RULES.length, 27, '规则条数变了, 复核分档');
  for (const r of GAR.RULES) {
    assert.ok(r.text && r.text.trim(), '第 ' + r.n + ' 条正文空了');
  }
  const main = GAR.renderGlobalAgentRules('main');
  assert.equal(main, GAR.GLOBAL_AGENT_RULES,
    '导出的 GLOBAL_AGENT_RULES 必须就是主档渲染结果 (agents/qian.js 用的就是它)');
  assert.equal(GAR.renderGlobalAgentRules(), main, '默认档必须是 main');
});

test('worker 档必须摘掉主 agent 专属的那几条', () => {
  const w = GAR.renderGlobalAgentRules('worker');
  const main = GAR.renderGlobalAgentRules('main');
  for (const k of MAIN_ONLY) {
    assert.ok(!w.includes(k), 'worker 档不该带「' + k + '」');
    assert.ok(main.includes(k), '主档丢了「' + k + '」—— 收窄不能收掉主 agent 自己的纪律');
  }
});

test('worker 档必须保住诚实与工具纪律那几条 (这是分档的全部意义)', () => {
  const w = GAR.renderGlobalAgentRules('worker');
  for (const k of WORKER_MUST_KEEP) {
    assert.ok(w.includes(k), 'worker 档丢了「' + k + '」—— 动手的人最该有的就是这些');
  }
  assert.ok(w.includes('我搞不定, 你来'), '结尾那段总结是给所有 agent 的, 两档都要留');
});

test('worker 档必须明显更小 (省 token 是这层存在的理由)', () => {
  const w = approxTok(GAR.getGlobalRules('worker'));
  const m = approxTok(GAR.getGlobalRules('main'));
  assert.ok(w / m < 0.55, 'worker/main = ' + (w / m).toFixed(2) + ', 预期 <0.55');
});

test('环境铁律两档都在 (真 home/用户名是所有 agent 都要的, 跟角色无关)', () => {
  for (const scope of ['main', 'worker']) {
    const g = GAR.getGlobalRules(scope);
    assert.ok(g.includes('[运行环境 — 路径铁律]'), scope + ' 档丢了环境块');
    assert.ok(g.includes(os.homedir()), scope + ' 档没有真 home —— 子 agent 拼绝对路径必幻觉');
  }
  assert.match(GAR_SRC, /function getGlobalRules\(scope\)/);
  assert.equal(GAR.getGlobalRules(), GAR.getGlobalRules('main'), '无参调用必须等于 main (agents/qian.js:368)');
});

test('j2_agent_loop 注入这一段时必须带 scope (不带 = 子 agent 照旧全量)', () => {
  // 只认真调用点: 排除注释行和模块加载失败的兜底 (_getGlobalRules = () => '...')
  const garCalls = LOOP_SRC.split('\n')
    .filter(l => !/catch\s*\(\s*_\s*\)\s*\{/.test(l) && !/^\s*\/\//.test(l))
    .join('\n').match(/_getGlobalRules\([^)]*\)/g) || [];
  const garNoScope = garCalls.filter(c => !/_soulScope|_scope/.test(c));
  assert.equal(garNoScope.length, 0,
    garNoScope.length + ' 处 _getGlobalRules 没传 scope: ' + garNoScope.join(' | '));
  const skCalls = LOOP_SRC.match(/_readSelfKnowledge\([^)]*\)/g) || [];
  const skNoScope = skCalls.filter(c => !/scope/i.test(c));
  assert.equal(skNoScope.length, 0,
    skNoScope.length + ' 处 _readSelfKnowledge 没传 scope: ' + skNoScope.join(' | '));
});

test('worker 身份行必须走在 _injectGlobalRulesOnce 这条路上 (实机走的就是它)', () => {
  // 现场取证: 上面两个 unshift 只是兜底分支。executor 实跑的路径是
  // "messages 里已经有 system 消息" → 走 _injectGlobalRulesOnce。
  // 身份行原来只接在兜底分支上, 于是 worker 只看到「你是盘古」+「你是 Executor」。
  const LOOP = require('../modules/j2_agent_loop');
  const mk = () => [{ role: 'system', content: 'ORIGINAL' }];

  const wMsgs = mk();
  assert.equal(LOOP._injectGlobalRulesOnce(wMsgs, 0, '', 'TAIL', 'worker', 'executor'), true);
  const wTxt = wMsgs[0].content;
  assert.ok(wTxt.includes('你是 Pangu 的子 agent · executor'),
    'worker 身份行没下发 —— 子 agent 会以为自己是主 agent');
  assert.ok(wTxt.includes('只负责被派给你的这一件事'), '缺少"只做被派的那件事"边界');
  assert.ok(wTxt.includes('完成或失败都要如实上报'), '缺少"如实上报"边界');
  assert.ok(wTxt.includes('ORIGINAL') && wTxt.includes('TAIL'),
    '注入不能吃掉原内容或 buildTail');

  // main 必须逐字不变 —— 它的身份本来就由 soul 块首行声明, 这里不能动
  const mMsgs = mk();
  LOOP._injectGlobalRulesOnce(mMsgs, 0, '', 'TAIL', 'main', 'main');
  assert.ok(!mMsgs[0].content.includes('你是 Pangu 的子 agent'),
    'main 档被塞了子 agent 身份行 —— 改了主 agent 的提示词');
});

test('soul 基础提示词: 主 agent 专属段落剔给 worker, 且 main 渲染逐字不变', () => {
  const PS_SRC = fs.readFileSync(path.join(__dirname, '..', 'pangu-single.js'), 'utf8');
  const grab = (src) => {
    const tag = 'const PANGU_SYSTEM_PROMPT = `';
    const i = src.indexOf(tag);
    assert.ok(i >= 0, 'pangu-single.js 里找不到 PANGU_SYSTEM_PROMPT');
    let j = i + tag.length, k = j;
    while (k < src.length) {
      if (src[k] === '\\') { k += 2; continue; }
      if (src[k] === '`' && src[k - 1] !== '\\') break;
      k++;
    }
    return src.slice(j, k);
  };
  const raw = grab(PS_SRC);
  const mainRender = raw.replace(/<!--\/?pangu:main-only-->\n?/g, '');
  const workerRender = raw
    .replace(/<!--pangu:main-only-->[\s\S]*?<!--\/pangu:main-only-->/g, '')
    .replace(/<!--\/?pangu:main-only-->\n?/g, '');

  // main 一个字节都不能少 —— 它是主 agent 的完整人格定义
  assert.equal(workerRender.length < mainRender.length, true, 'worker 档应该更短, 标记没生效');
  assert.ok(!/pangu:main-only/.test(mainRender), '标记注释漏进 main 渲染');
  assert.ok(!/pangu:main-only/.test(workerRender), '标记注释漏进 worker 渲染');

  // 主 agent 专属: 讲的是盘古怎么面对主人 / 调它调不到的工具
  for (const s of ['你有什么(灵魂基础)', '你能做什么',
    'permission_grant 不触发主人 UI 横幅', '先做原则', '自己调 permission_apply']) {
    assert.ok(!workerRender.includes(s), 'worker 档还在带主 agent 专属段: ' + s);
    assert.ok(mainRender.includes(s), 'main 档被误删: ' + s);
  }
  // worker 真正需要的工具纪律 / 诚实 / 安全 —— 一条都不能跟着掉
  // (第一版按行号圈范围, 误吞了这四段, 就是靠这张表拦下来的)
  for (const s of ['## 运行环境', '## 实体锚定', '## 主人', '时间 / 语言 / 数字',
    '用户问实事必须调工具', '读不出 = 直接说读不出', '高危项目或动作必须走',
    '上下文不可丢', '## 边界', '## 行为准则']) {
    assert.ok(workerRender.includes(s), 'worker 档误删: ' + s);
  }
  // 省下来的量要够本, 少于 1000 tk 不值得引入这套标记
  assert.ok(approxTok(mainRender) - approxTok(workerRender) >= 1000,
    '只省了 ' + (approxTok(mainRender) - approxTok(workerRender)) + ' tk, 不值当');
});

test('worker 的身份行不能再写死"你是 Pangu" (同一个错: 提示词在描述一个它不是的身份)', () => {
  // 原来不管什么角色开头一律 "你是 Pangu" —— 子 agent 读到的是"你是 Pangu, 内部 127 个
  // 工具, 有 64 卦内核, 能改自己的代码", 而它实际是 executor, 手上只有 17 个工具。
  // 和"提示词说有 127 个工具而 schema 只给 17 个"是一类错。
  assert.ok(LOOP_SRC.includes('_identityLineFor'), 'worker 身份必须按角色点名');
  assert.match(LOOP_SRC, /你是 Pangu 的子 agent/);
  assert.match(LOOP_SRC, /_readSelfKnowledge = \(scope\)/, '自我认知必须能按 scope 关掉');
});

