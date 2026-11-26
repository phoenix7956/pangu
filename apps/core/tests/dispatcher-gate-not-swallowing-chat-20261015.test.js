'use strict';

/**
 * 2026-10-15 — 闲聊/问句/格式指令不许被拖进 dispatcher 全量编排
 *
 * 现场 (用户原话"跟死了一样", 在真 UI 主路径 /api/pangu/agent/stream 上复现):
 *
 *   POST {"input":"只回一个词: 盘古"}
 *   → event: gua      水山蹇 (起卦了)
 *   → event: status   {"stage":"planner","message":"盘古正在规划任务..."}
 *   → 之后 190 秒只有 : keepalive
 *   → curl EXIT=28 (200s 超时), 全文只有 2 个事件, final/done 一个都没有
 *
 * daemon 日志显示它没挂死, 是被拉进了完整编排:
 *   planner → executor → checker(判定未通过) → executor(验收补救第2轮) → checker → …
 *   每个 agent 都回 "⚠️ [Silent Failure / 本轮未收口] 我跑了 1 轮没调 task_done,
 *   这一轮什么都没产出", 一直重试到超时。
 *   补救循环本身**有上限** (`while (_failHit && _remedyRound < 2)`), 不是死循环 ——
 *   是 ~9 次子 agent 全量编排 × 每个多轮 LLM, 本地 27B 每次十几秒, 200 秒就烧完了。
 *
 * 根因两层:
 *
 *  ① DISPATCHER_KWS 里有 13 个**单字**词条, 判定又是 `text.includes(k)`。
 *     中文没有词边界, 单字等于自瞄: '盘'→盘古/棋盘/楼盘, '跑'→跑步,
 *     '测'→观测/预测, '复'→复习/恢复/复杂, '学'→学校/数学, '改'→改天。
 *     连"盘古是谁"这种自我介绍都被判成派活。
 *
 *  ② 就算词条全清了, 底下还有一句 `// 其他默认走 dispatcher（保守）`。
 *     "盘古是谁"/"学校在哪" 仍然返回 true —— 它们不是被词条命中, 是掉进这个默认值。
 *     问的是信息 vs 派的是活, 是两回事, 白名单永远漏词, 漏了都往编排那边倒。
 *
 * 修法: 关键词全部换多字 (短指令在中文里几乎都是"动词+一下": 改一下/跑一下/写一下),
 * 再加两道**在关键词之前**的短路: 回答格式指令、问句。
 * 顺序不能反: "复盘是什么" 含动作词 复盘, 仍该派 (那是让盘古去复盘, 不是问定义)。
 */

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');

const SINGLE = fs.readFileSync(path.join(__dirname, '..', 'pangu-single.js'), 'utf8');

// 用**和 pangu-single.js 同一个基准**的 require: 闸门内部按相对路径找模块
// (require('./modules/j2_dispatcher')), 若以本测试文件为基准就会解析到 tests/ 下面去,
// 找不到 → 静默退回旧行为 → 测试全绿而线上照旧坏。基准错了, 这类测试等于没写。
// 2026-10-23 第 58 批: 词表搬去 modules/gua_gate_kws.js 后, 「在 pangu-single.js
// 源码文本里切一段求值」取词表的方式切不到了 ⇒ 改走共享装载器 (它保证同一个基准)。
const { shouldUseDispatcher } = require('./helpers/gua_gate_load.js');
const dispatch = shouldUseDispatcher();

function kws() {
  // 先剥注释 —— 说明文字里带引号的单字 (如 "'盘' → 盘古") 不是词条
  const src = SINGLE
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '');
  const body = src.slice(src.indexOf('const DISPATCHER_KWS'), src.indexOf('// 策略'));
  return [...body.matchAll(/'([^']+)'/g)].map((m) => m[1]);
}

test('DISPATCHER_KWS 不许再含单字词条 (中文没有词边界, 单字=自瞄)', () => {
  // 唯一保留的例外: 卦。起卦/算卦/卦象/转卦 全部语义明确, 不会有无关词撞上。
  const singles = kws().filter((k) => k.length === 1);
  assert.deepEqual(singles, ['卦'],
    `单字词条又回来了: ${singles.join(' ')} —— '盘' 会命中盘古, '学' 会命中学校`);
});

test('现场原话: "只回一个词: 盘古" 不该起编排 (今天修的正主)', () => {
  assert.strictEqual(dispatch('只回一个词: 盘古'), false,
    '格式指令被当派活 → 走满 9 次子 agent 编排 → 200 秒只有 keepalive');
});

test('起卦块前缀不许污染路由判定 —— 这才是"跟死了一样"的真根因', () => {
  // 上面那条单测曾经全绿, 实机却照样 90 秒起编排。差别只有一个: 实机的
  // userInput 不是原话, 是**起完卦之后**被 prepend 过【盘古起卦…】的串
  // (pangu_agent_stream.js: 起卦 → _formatGuaFirstBlock 前缀 → 才送这道闸门)。
  //
  // 下面这段是 _formatGuaFirstBlock 的真实输出形状 (抄自实机日志), 不是编的。
  const GUA_BLOCK = '【盘古起卦 · 先于推理 (梅花易数, 64i 真卦辞爻辞)】\n'
    + '本卦: 蹇 ䷦ (坎上艮下)「蹇，利西南，不利东北。利见大人，贞吉。」'
    + ' | 动爻: 九五「九五：大蹇，朋来」 | 之卦: 谦 ䷎「谦，亨，君子有终。」\n'
    + '五行: 水 | 动爻五行: 火 (水克火) | 六亲: 妻财 | 爻位性质: 极终\n'
    + '—— 回答顺序 (2026-10-09 老板定): **先给已核实的事实/结论**(工具返回的数字与证据), '
    + '本块卦象随后作补充视角, 引用时引真卦辞/爻辞原文里的一句。\n'
    + '   若工具没拿到数据, 先如实说"没拿到"及原因, 不许用卦象顶替缺失的数据。\n\n主人问题: ';

  // 卦块自己就能骗过两道门:
  //   格式指令门只看开头 14 字 → 开头是"【盘古起卦 · 先于推理", 永远不匹配
  //   关键词门 → 卦块里含"卦"字, 而 '卦' 是表里唯一保留的单字词条 → 命中
  // 于是**任何**输入 (闲聊、问句、格式指令) 都被拖进 9 次子 agent 编排。
  assert.strictEqual(dispatch(GUA_BLOCK + '只回一个词: 盘古'), false,
    '起卦块前缀把格式指令又推进编排了');
  assert.strictEqual(dispatch(GUA_BLOCK + '你好'), false,
    '起卦块前缀把闲聊推进编排了');
  assert.strictEqual(dispatch(GUA_BLOCK + '盘古是谁'), false,
    '起卦块前缀把问句推进编排了');

  // 剥掉装饰之后, 真派活必须仍然照派 —— 不能为了修误判把编排整个关掉
  assert.strictEqual(dispatch(GUA_BLOCK + '帮我写一下 README'), true,
    '剥完卦块之后真派活被误放回 legacy');
  assert.strictEqual(dispatch(GUA_BLOCK + '复盘是什么'), true,
    '剥完卦块之后关键词优先级被破坏');
});

test('产品名本身不再触发编排', () => {
  // 不含光秃秃的 "盘古" 两个字 —— 那是歧义输入 (也可能是"盘古, 干活"的唤醒词),
  // 保守默认 true 是对的, 不为它加特判。
  for (const q of ['盘古是谁', '盘古能干什么', '介绍一下盘古这个项目']) {
    assert.strictEqual(dispatch(q), false, `产品名被当派活: ${q}`);
  }
});

test('字嵌名词不再误命中', () => {
  // 这一组要验的是**路由结果**。"字不再当词条"由上一条直接断言 (表里不许有单字),
  // 这里再从行为侧钉一遍。
  //
  // 只放**可判定为 false** 的: 它们分别靠问句门和纯闲聊门兜住, 与关键词表无关。
  //   学校在哪 → 问句门("在哪")   下棋吗 → 句尾"吗"   改天再说 → 纯闲聊词
  //
  // 曾经放在这里的 '观测数据' / '复习' / '写法不对' / '棋盘布局' 已经挪到下一条测试,
  // 原因见那里的说明 —— 它们**行为层面分不出**词条命中还是保守兜底, 在这里断言
  // 等于断言一个假因果 ("它 false 是因为单字清掉了"), 单字加回去它们照样 true。
  const cases = ['学校在哪', '下棋吗', '改天再说'];
  for (const q of cases) {
    assert.strictEqual(dispatch(q), false, `字嵌名词被当派活: ${q}`);
  }
});

test('孤立名词短语落进保守默认 —— 是设计, 不是漏网', () => {
  // 这几个曾经断言 false, 理由是"单字词条清掉了就不会命中"。实测**分不出来**:
  //   观测数据 → 无关键词命中 → 落进默认 → true
  //   复习     → '复' 已换成 '复验', 同上 → true
  // 把单字加回去, 这几个的结果**也还是 true** —— 所以它们证明不了词表修没修好,
  // 词表的真判据是第一条测试 (直接扫表, 不许单字)。
  //
  // 这里反过来把它们钉成 true: 这是**主动的取舍**, 不是漏网。
  // 依据见 _shouldCastGua 顶上那段: 白名单永远漏词, 漏了要往"起卦/编排"那边倒 ——
  // 宁可多跑一次编排, 不可把真派活当闲聊放过去。
  // 所以**不许**为它们逐个加特判; 要治就治默认分支的整体策略, 而不是打地鼠。
  const cases = ['观测数据', '复习', '写法不对', '棋盘布局'];
  for (const q of cases) {
    assert.strictEqual(dispatch(q), true,
      `保守兜底被改掉了: ${q} —— 若真要改默认策略, 请连同上面几条测试一起改, 并说明依据`);
  }
});

test('问句走 legacy —— 问的是信息, 不是派活', () => {
  const cases = ['盘古是谁', '学校在哪', '现在几点了', '为什么这么慢', '有哪些文件', '下棋吗', '好了吧'];
  for (const q of cases) {
    assert.strictEqual(dispatch(q), false, `问句被当派活: ${q}`);
  }
});

test('真动作不许被误放回 legacy', () => {
  const cases = [
    '改一下', '跑一下', '写一下', '拆一下', '记一下', '测一下', '派活给他', '撤回来', '退一步',
    '创建 40 个文件', '分析一下这段代码的性能', '检查一下有没有漏测', '复盘一下',
    '把 README 改一下', '帮我查一下成交量', '随便说点什么',
  ];
  for (const q of cases) {
    assert.strictEqual(dispatch(q), true, `真动作被误放回 legacy: ${q}`);
  }
});

test('关键词优先级不许被反: 含动作词的问句仍该派', () => {
  // "复盘是什么" 是让盘古去复盘, 不是问"复盘"二字怎么定义。
  // 同理 "这个 bug 是什么根因" 要的是排查动作。
  assert.strictEqual(dispatch('复盘是什么'), true);
  assert.strictEqual(dispatch('这个 bug 是什么根因?'), true);
  // "这个方案怎么走" 命中规划类词条 方案 —— 问的是"这个方案怎么落地", 是要人出方案。
  assert.strictEqual(dispatch('这个方案怎么走'), true);
});

test('格式指令只认句首 —— 正文里偶然出现"直接答"不许把真任务判成闲聊', () => {
  assert.strictEqual(dispatch('分析这段代码, 然后直接答结论'), true,
    '格式指令词在句中出现就短路 = 把真任务判成闲聊, 比原 bug 更隐蔽');
});

test('既有语义不许变: 闲聊 false / 未知输入仍保守 true', () => {
  assert.strictEqual(dispatch('你好'), false);
  assert.strictEqual(dispatch('随便说点什么'), true, '保守默认必须保留 (白名单永远漏词)');
});

