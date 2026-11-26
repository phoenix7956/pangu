'use strict';

// 2026-10-19 老板报: 「原来不管什么模型至少能出来, 现在是个什么情况? 比原来还慢什么都有问题?
// 后台还跑出来一条信息, 说 pangu 卡死。」
//
// 现场 (会话 07402764 / 08953709, 浏览器实拍) —— 「全面介绍一下你自己」被拆成 **5 路**:
//   坎·拆 运行中 / 离·读 **失败** / 兑·验 完成 109.2s / 巽·找雷 完成 127.4s / 乾·调度 运行中
// 127 秒, 一路失败, 还报"卡死"。而这只是一句自我介绍。
//
// 根因不在 planner, 在 pangu_agent_stream.js:108 那条**反幻觉取证纪律**的判据。
// 那条纪律本身是对的 (2026-08-02 实案: 盘古凭印象编「沙箱关了/权限开不了」),
// 但旧判据里有一支是**裸的 `你自己`** —— 句子里出现「你自己」三个字就注入 ~150 字纪律,
// 于是把自我介绍撑成重任务, 触发 planner 拆 5 路。
//
// 最荒唐的不一致: 「你是谁」**不命中**(字面没有"你自己") 走轻路径,
// 而「介绍一下你自己」命中 → 127 秒。最该轻松的反而最重。
//
// 修法: 纪律不删, 改**什么时候用**。主人在聊天(介绍/你是谁/能干什么) → 正常答;
// 主人在要证据(排查/检查/有哪些/架构细节) → 纪律照上。区别在动词, 不在主语。
//
// 这条测试钉的是**判据的行为**, 不是源码写法 —— 判据容易改, 行为不能漂。
// 用真源码里抽出来的正则跑, 改任一支都会立刻红。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const SRC = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'pangu_agent_stream.js'), 'utf8');

// 从**真源码**里把两支正则抽出来 —— 测的就是生产用的那一份。
// 抄一份到测试里就等于给了一份可以漂、不受改动影响的假证据, 那比不测更坏。
//
// 抽法: 用 eval 在本地跑那两行声明本身。正则字面量 /.../i 与 new RegExp('a'+'b','i')
// 两种写法都能原样求值, 不用脆弱的正则去解析源码 —— 上一版这么写,
// 被声明里的分号/换行卡住, 测试自己先炸了 (又一次: 测试工具本身成了噪音)。
function extractAll() {
  // 抓 _SELF_CHAT_RE 和 _SELF_PROBE_RE 两行声明 (可能跨行), 到各自的结尾分号。
  const grab = (name) => {
    const i = SRC.indexOf('const ' + name + ' =');
    assert.ok(i > 0, `必须能在 pangu_agent_stream.js 里找到 ${name}`);
    // 从 = 开始, 一路做括号/引号配平, 到顶层分号为止。
    let depth = 0, inStr = null, j = SRC.indexOf('=', i);
    for (; j < SRC.length; j++) {
      const c = SRC[j];
      if (inStr) { if (c === inStr && SRC[j-1] !== '\\') inStr = null; continue; }
      if (c === "'" || c === '"' || c === '`') { inStr = c; continue; }
      if (c === '(' || c === '[') depth++;
      else if (c === ')' || c === ']') depth--;
      else if (c === ';' && depth === 0) { j++; break; }
    }
    return SRC.slice(i, j);
  };
  const chat = grab('_SELF_CHAT_RE');
  const probe = grab('_SELF_PROBE_RE');
  // eslint-disable-next-line no-new-func
  const fn = new Function(chat + '\n' + probe + '\nreturn { chat: _SELF_CHAT_RE, probe: _SELF_PROBE_RE };');
  return fn();
}

const { chat: CHAT, probe: PROBE } = extractAll();

// 与源码里那个放行条件逐字对应 (pangu_agent_stream.js 的注入判定)。
const HARD = /排查|检查|验证|有多少|几个|哪些|怎么配/;
const injects = (q) => PROBE.test(q) && !(CHAT.test(q) && !HARD.test(q));

test('S1 自我介绍是聊天, 不该上取证纪律 —— 这是 127 秒的直接来源', () => {
  // 这四条就是老板实拍的现场。旧判据全部命中, 每条拆 5 路跑 127 秒。
  for (const q of [
    '全面介绍一下你自己',
    '介绍一下你自己',
    '介绍一下你自己都能干什么',
    '自我介绍',
  ]) {
    assert.equal(injects(q), false, `「${q}」是聊天, 不该注入 ~150 字取证纪律`);
  }
});

test('S2 真的在问架构事实, 纪律必须还在 —— 反幻觉的枷不许拆', () => {
  // 纪律的存在意义: 盘古报自己的工具数/沙箱状态必须有出处。
  // 这次修的是"什么时候用", 不是"不用了"。这些一条都不能放过。
  for (const q of [
    '全面分析一下你自己',
    '排查你自己的沙箱配置',
    '全面检查一下你自己',
    '你的架构是怎样的',
    '你有哪些工具',
    '你有多少个工具',
    '你能不能用 MCP',
    '介绍一下你的沙箱怎么配的',   // 既想聊天又要证据 → 留
  ]) {
    assert.equal(injects(q), true, `「${q}」要报事实, 取证纪律必须上 —— 拆了这条就是拆反幻觉`);
  }
});

test('S3 跟自查无关的普通问题, 一条都不许误伤', () => {
  for (const q of [
    '现在几点了',
    '北京天气怎么样',
    '读一下 /Users/you/Desktop/pangu/apps/core/modules/llm_caller.js 里的 _isLocalModel',
    '帮我把这段代码重构一下',
  ]) {
    assert.equal(injects(q), false, `「${q}」跟自查无关, 不该注入纪律`);
  }
});

test('S4 「有哪些」也算取证问法 —— 报数量必须查真源', () => {
  // 这条是回归锁: 我第一版只列了「有没有/多少」, 漏了「有哪些」,
  // 于是「你有哪些工具」反而放行 —— 而报工具数恰恰是最容易编的。
  assert.ok(PROBE.test('你有哪些工具'),
    '「有哪些」必须命中 PROBE —— 报数量只能查真源, 不能凭印象');
  assert.equal(injects('你有哪些工具'), true);
});

test('S5 聊天优先, 但取证词一出现就反超 —— 放行不能变成漏网', () => {
  // 「介绍一下…」本来被聊天规则放行, 但只要句子里同时有取证动词,
  // 必须反超回来上枷。否则「介绍一下, 你排查过自己有多少个工具吗」就能绕过。
  const q = '介绍一下, 你排查过自己有多少个工具吗';
  assert.ok(CHAT.test(q), '这句确实含聊天词');
  assert.ok(HARD.test(q), '这句确实含取证词');
  assert.equal(injects(q), true, '取证词优先 —— 放行规则不许变成漏网通道');
});

test('S6 源码里不许再出现裸的 `你自己` 判据', () => {
  // 反向锁: 那支裸 `你自己` 是这一轮 127 秒的直接元凶。
  // 它一旦被"顺手"加回某个正则, S1~S5 会一起红 —— 这条是为了让那个红来得早。
  const probeBody = SRC.slice(SRC.indexOf('const _SELF_PROBE_RE'));
  const toEnd = probeBody.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
  assert.ok(!/\(你自己/.test(toEnd),
    'PROBE 里不许再有裸的 (你自己 —— 那会让所有"介绍一下你自己"重新上枷');
});
