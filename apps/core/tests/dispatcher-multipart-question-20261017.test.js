'use strict';

// 2026-10-17: 真长任务被当成"问句", 拆解整个跳过 —— 老板「乾就应该把任务拆了, 分下去」
// 那条诉求的直接反例。
//
// 现场 (session q-1792191100275):
//   「查清楚盘古现在的模型池里有哪些模型, 各自的 provider 是什么、哪些是本地端点、
//     哪些是云端, 以及当前默认用哪个。读配置文件取证, 不要猜。最后给我一张表。」
//   → **一个子 agent 都没派**。主 agent 自己跑了 10 轮 / 52.6s
//     (loop:main tools=35, inputTokens 16252→20203 触发压缩, taskDoneCalled:false,
//      撞满 10 轮才停), session 文件里主 agent 串行 5 个 exec_command 后自己收口。
//   → 无 q-1792191100275_sub-*.json, 佐证确实没派工。
//
// 路径: 一个词都不命中 DISPATCHER_KWS → 落到 isQuestion → 它含 哪些/哪个/是什么
//      → true → return false → 整道题被当成"问句"。
//
// isQuestion 那道门**本身是对的**, 它防的是"盘古是谁"/"学校在哪"白起 200 秒编排
// (2026-10-15 那次 200 秒零进展)。区别在句法:
//   单问句 = 一个疑问小句、一件事 ("这个 bug 什么根因")
//   这道题 = 五个疑问小句五件事 (列模型 / 各自的 provider / 哪些本地 / 哪些云端 /
//           当前默认), 外加"读配置文件取证"和"给我一张表"两个交付要求
// → 判据: 疑问**小句** ≥2 且剥块后够长 → 这是活, 不是问句。
//
// Q4 是这一刀最容易复发的地方: 第一版按 [?？。；;！!] 切小句, 现场那句切出来只有 3 段
// —— 五个疑问**全挤在第 1 段**, 句号只隔开了尾部两句交付要求。于是疑问小句数恒为 1,
// 判据自己把自己否掉, 现场用例原样跑仍然一个子 agent 都不派。
// 中文长任务的小句几乎全靠**逗号顿号**分隔, 所以分隔符必须含它们 (Q4 钉死这一点)。

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const SINGLE = fs.readFileSync(path.join(ROOT, 'pangu-single.js'), 'utf8');
// 闸门内部按相对路径 require('./modules/j2_dispatcher') 来剥卦块 —— 基准必须是
// pangu-single.js 本身。以本测试文件为基准会解析到 tests/ 下面去, 找不到 → 静默
// 退回旧行为 → 测试全绿而线上照旧坏。基准错了, 这类测试等于没写。
// 2026-10-23 第 58 批: 词表搬去 modules/gua_gate_kws.js 后, 「在 pangu-single.js
// 源码文本里切一段求值」取词表的方式切不到了 ⇒ 改走共享装载器 (基准仍由它保证)。
const { shouldUseDispatcher } = require('./helpers/gua_gate_load.js');
const dispatch = shouldUseDispatcher();

const FIELD = '查清楚盘古现在的模型池里有哪些模型, 各自的 provider 是什么、哪些是本地端点、'
  + '哪些是云端, 以及当前默认用哪个。读配置文件取证, 不要猜。最后给我一张表。';

test('Q1 现场那道长任务必须派工 —— 五个疑问小句是活, 不是问句', () => {
  assert.strictEqual(dispatch(FIELD), true,
    '长任务被判成问句 → 拆解整个跳过 → 一个子 agent 都不派, 主 agent 自己撞满 10 轮');
});

test('Q1b 换个形状也得派 —— 别把判据调成只认现场那一句', () => {
  // 今天栽过: "跑通了"≠"对" (21 个工具塌成 4 个那次)。判据是句法的, 就该对
  // 不同措辞的同一形状都成立 —— 顿号版、逗号版、问号结尾版各来一道。
  const cases = [
    '盘古的模型池里现在有哪些模型, 各自属于哪个 provider, 哪些是本地端点, 哪些走云端, 默认用的是哪个, 最近一次切换是什么时候?',
    '把这三个仓库的构建脚本、依赖版本和测试覆盖率分别列出来, 哪些是 CI 在跑, 哪些已经没人维护了, 给我一张对比表',
    '盘古现在有几个入口, 各自的端口是多少, 哪些走本地端点, 哪些走云端, 默认命中哪一条',
  ];
  for (const q of cases) {
    assert.strictEqual(dispatch(q), true, `同样是多小句调研, 却被当成问句放过了: ${q}`);
  }
});

test('Q2 单问句仍然不许起编排 —— 2026-10-15 那 200 秒零进展就靠这道门', () => {
  // 这道门不能为了救长任务被拆掉: 2026-10-15 现场"只回一个词: 盘古"被拖进
  // 9 次子 agent 全量编排, 200 秒只有 keepalive。
  const cases = ['盘古是谁', '学校在哪', '现在几点了', '为什么这么慢', '有哪些文件', '下棋吗', '好了吧'];
  for (const q of cases) {
    assert.strictEqual(dispatch(q), false, `单问句被当派活: ${q}`);
  }
});

test('Q3 关键词优先级不许被反 —— 含动作词的问句仍该派', () => {
  // "复盘是什么" 是让盘古去复盘, 不是问"复盘"二字怎么定义。这条闸门在多小句
  // 判据**之前** return true, 所以改动不能把它挪到后面去。
  for (const q of ['复盘是什么', '这个 bug 是什么根因?', '这个方案怎么走']) {
    assert.strictEqual(dispatch(q), true, `关键词优先级被破坏: ${q}`);
  }
});

test('Q4 小句切分必须含逗号和顿号 —— 第一版就是漏了它们, 判据自己把自己否掉', () => {
  // 这是本刀最容易复发的一处。现场那句按句号切只有 3 段, 五个疑问全挤在第 1 段,
  // 疑问小句数恒为 1 → 判据失效 → 现场用例原样跑仍然零派工。
  const code = SINGLE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const split = code.match(/_qParts\s*=\s*\w+\.split\(\/\[([^\]]+)\]\/\)/);
  assert.ok(split, '要能找到 _qParts 的切分正则 (小句边界)');
  const seps = split[1];
  for (const sep of ['，', ',', '、', '。', '？']) {
    assert.ok(seps.includes(sep),
      `小句分隔符少了 ${JSON.stringify(sep)} —— 中文长任务靠逗号顿号分句, `
      + '漏掉它疑问小句数会恒为 1, 这道判据等于没写。实际: [' + seps + ']');
  }
});

test('Q5 起卦块前缀不许污染 —— 剥不掉装饰时, 多小句判定也不能跟着乱', () => {
  // 2026-10-15 那条约束依然成立: 服务端自己 prepend 的卦块里含"卦",
  // 而 '卦' 是 DISPATCHER_KWS 里唯一保留的单字词条, 不剥就会命中关键词门。
  const GUA = '【盘古起卦 · 先于推理 (梅花易数, 64i 真卦辞爻辞)】\n'
    + '本卦: 蹇 ䷦ (坎上艮下)「蹇，利西南，不利东北。」\n'
    + '—— 回答顺序: **先给已核实的事实/结论**。引用上面的真卦辞爻辞时不要复述本块原文。\n'
    + '主人问题: ';
  assert.strictEqual(dispatch(GUA + FIELD), true,
    '剥完卦块之后真长任务被误放回 legacy');
  assert.strictEqual(dispatch(GUA + '盘古是谁'), false,
    '起卦块前缀把单问句推进编排了');
});

