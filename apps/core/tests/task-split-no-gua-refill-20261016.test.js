// 2026-10-16 —— 子 agent "全量重填": 每一刀都被塞一整块 300 字的【盘古起卦】模板
//
// 老板原话: "全量重填肯定是大问题, 乾就应该把任务拆了, 分下去, 子 agent 只做自己相关的,
//            做好汇报, 这个跟你应该是一样的"。
//
// 实跑取证 (subagent-runs.jsonl, 6 个唯一样本, live-1792146487916 那轮 3 个并行 analyzer):
//   切出真正的 subTask.task (剥掉服务端自己拼的 summaryHint 尾巴) 后, 三刀是:
//     [0] analyzer len=332  【盘古起卦 · 先于推理…】\n本卦: 大畜 ䷙…\n—— 回答顺序…\n请分别分析… —— 只做这一项: /…/j2_loop_shared.js
//     [1] analyzer len=328  【盘古起卦 · 先于推理…】…                —— 只做这一项: /…/model_cost.js
//     [2] analyzer len=328  【盘古起卦 · 先于推理…】…                —— 只做这一项: /…/checkpoint.js
//   每刀 ~330 字里, **前 300 字逐字相同** —— 那是同一块卦块模板被复制了三遍。
//
// 根因: splitClauses() 在自己函数里调 _stripNoise (task_split.js:134), 而并列清单那条路
// (_splitEnumeratedParallel) 拿的是**没剥过的原始 input** → head = 整个卦块 + 主人真问题,
// 原样复制进每一刀。第二个根因: _stripNoise 里的正则 `^【盘古起卦[\s\S]*?\n(?=\S)` 是
// 非贪婪的, 卦块 300 字只被吃掉**首行** (收尾句在第 3 行才出现)。
//
// 修完: 每刀 62/58/58 字 (5.4× 缩水), 三刀末尾各自带自己的"只做这一项", 前端三张卡
// 一眼能分。卦意不丢 —— j2_dispatcher 拼 taskText 时会用 _guaLine 单独补一行紧凑卦提示。
//
// 这里全部走真函数 (task_split 是纯函数, 不需要 HTTP 上游), 所以断言是真的跑出来的,
// 不是源码级护栏。T7 反查 HEAD 版本, 确认老代码会被这些断言抓住。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const splitTask = require(path.join(ROOT, 'modules', 'task_split.js')).splitTask;

// 现场真实形状: 服务端注入的卦块模板 (收尾句恒为 "不要复述本块原文。")
// 卦象字用码点转义写死 (大畜 ䷙ = U+4DD9, 损 ䷨ = U+4DE8), 免得手打卦象写歪。
const GUA_BLOCK = [
  '【盘古起卦 · 先于推理 (梅花易数, 64i 真卦辞爻辞)】',
  '本卦: 大畜 ䷙ (艮上乾下)「大畜，利贞。不家食吉，利涉大川。」 | 动爻: 九三「九三：良马逐，利艰贞，日闲舆卫，利有攸往」 | 之卦: 损 ䷨「损，有孚元吉无咎，可贞，利有攸往。曷之用，二簋可用享。」',
  '五行: 土 | 动爻五行: 金 (土生金) | 六亲: 子孙 | 爻位性质: 变机',
  '—— 回答顺序 (2026-10-09 老板定): **第一段先给已核实的事实/结论**(工具返回的数字与证据); 本块卦象随后作补充视角, 引用时引真卦辞/爻辞原文里的一句。',
].join('\n');

const OWNER_ASK = '请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点: '
  + '1) /Users/you/Desktop/pangu/apps/core/modules/j2_loop_shared.js '
  + '2) /Users/you/Desktop/pangu/apps/core/modules/router/model_cost.js '
  + '3) /Users/you/Desktop/pangu/apps/core/modules/checkpoint.js';

const guaPrefixed = GUA_BLOCK + '\n' + OWNER_ASK;

test('T1 带卦块的并列清单必须拆出 3 刀, 刀里不许再有卦块', () => {
  const r = splitTask(guaPrefixed, { maxSubTasks: 6 });
  assert.ok(r, '现场这轮明明拆出了 3 刀, 不该拆不动');
  assert.strictEqual(r.pattern, 'enumerated_parallel');
  assert.strictEqual(r.subTasks.length, 3);
  for (const st of r.subTasks) {
    assert.ok(!/【盘古起卦/.test(st.task),
      '刀里还留着卦块 —— 这就是"全量重填": 现场三刀各 328~332 字, 前 300 字逐字相同');
    assert.ok(!/本卦:|爻位性质|不要复述本块原文/.test(st.task),
      '卦块内容(卦辞/五行/回答顺序/不要复述本块原文)还整块留在刀里');
  }
});

test('T2 每刀必须短下来 —— 老板说的"全量重填"就是 prompt 里全是重复的卦块', () => {
  const r = splitTask(guaPrefixed, { maxSubTasks: 6 });
  for (const st of r.subTasks) {
    assert.ok(st.task.length < 120,
      `刀文本 ${st.task.length} 字 —— 现场是 328~332 字, 其中 300 字是复制的卦块`);
  }
});

test('T3 每刀必须带上自己的"只做这一项", 否则三张卡看起来一模一样', () => {
  const r = splitTask(guaPrefixed, { maxSubTasks: 6 });
  const items = r.subTasks.map((st) => (st.task.match(/只做这一项[:：]\s*(\S+)/) || [])[1]);
  assert.deepStrictEqual(items, [
    '/Users/you/Desktop/pangu/apps/core/modules/j2_loop_shared.js',
    '/Users/you/Desktop/pangu/apps/core/modules/router/model_cost.js',
    '/Users/you/Desktop/pangu/apps/core/modules/checkpoint.js',
  ], '三刀必须各带各的那一项 —— 这是"子 agent 只做自己相关的"的唯一可见证据');
  // 公共 head 还在 (它是"干什么"的要求), 但不许长过刀本身
  for (const st of r.subTasks) assert.ok(st.task.includes('分别分析'), '公共 head 不能被误伤');
});

test('T4 顺序拆分路径也走同一个 _stripNoise, 必须一起剥干净', () => {
  // 顺序型任务走 splitClauses, 它在 134 行调 _stripNoise —— 修 _stripNoise 的边界锚点
  // 是为了让**两条路**都干净, 不能只让并列清单这条路好看。
  const seq = GUA_BLOCK + '\n'
    + '1. 先读 /tmp/a.md 并总结要点, 2. 再读 /tmp/b.md 并总结要点, 3. 最后合并两份总结成一份报告';
  const r = splitTask(seq, { maxSubTasks: 6 });
  if (r && r.subTasks && r.subTasks.length) {
    for (const st of r.subTasks) {
      assert.ok(!/【盘古起卦/.test(st.task), '顺序路径的刀里也还留着卦块');
    }
  }
});

test('T5 卦块就是全部输入 (纯卦象问句) 时不许剥成空 —— 剥空 = 拆出 0 刀 = 静默退回原路', () => {
  // 这是 _stripNoise 刻意保守的原因 (踩过的坑: 贪婪正则一路吃到末尾, 把主人的活也吃掉)。
  // 加了收尾句锚点之后更要守住: 收尾句之后没有真活, 就当没剥。
  const pureGua = GUA_BLOCK;
  const r = splitTask(pureGua, { maxSubTasks: 6 });
  assert.strictEqual(r, null, '纯卦块拆不出刀是对的, 但不能靠"剥成空"来实现');
});

test('T6 卦块 + 主人问题: 标记的形状也要剥 (另一条实测形状)', () => {
  const withMarker = GUA_BLOCK + '\n主人问题: ' + OWNER_ASK;
  const r = splitTask(withMarker, { maxSubTasks: 6 });
  assert.ok(r && r.subTasks.length === 3, '带"主人问题:"标记的形状也要能拆出 3 刀');
  for (const st of r.subTasks) assert.ok(!/【盘古起卦/.test(st.task));
});

test('T7 卦块对拆分必须是 no-op —— 差分性质断言 (不依赖 git 历史)', () => {
  // 写法说明: 早先这里反查 `git show HEAD:<file>`, 结果修复一提交, HEAD 就成了修好的代码,
  // 护栏自己把自己作废了。改成**性质断言**: 服务端拼的卦块对"怎么拆"没有任何影响 ——
  // 带卦块和裸题必须拆出逐字相同的刀。这条无论谁改、什么时候改都成立。
  const withGua = splitTask(guaPrefixed, { maxSubTasks: 6 });
  const bare = splitTask(OWNER_ASK, { maxSubTasks: 6 });
  assert.ok(withGua && bare, '两个形状都得拆得动');
  assert.deepStrictEqual(
    withGua.subTasks.map(s => s.task), bare.subTasks.map(s => s.task),
    '卦块必须对拆分完全无影响 —— 它只是服务端拼的上下文, 不该进任何一刀');
  assert.deepStrictEqual(
    withGua.subTasks.map(s => s.agent), bare.subTasks.map(s => s.agent));
  assert.deepStrictEqual(
    withGua.subTasks.map(s => (s.depends_on || []).join()), bare.subTasks.map(s => (s.depends_on || []).join()),
    '依赖关系也不能被卦块带偏');
});

test('T8 牙齿检查: T1/T2 的断言真的抓得住老逻辑 (内联复现, 不查 git)', () => {
  // 光有断言不算数 —— 得证明断言有牙齿。这里内联复现修复前的那条剥块逻辑
  // (非贪婪正则只吃卦块首行, 且并列清单那条路压根不调 _stripNoise),
  // 然后拿 T1/T2 的判据去量它: 必须两条都挂。
  const oldStripNoise = (text) => {
    let s = String(text || '');
    const m = s.match(/主人问题:\s*([\s\S]*)$/);
    if (m && m[1].trim()) s = m[1];
    const g = s.match(/^【盘古起卦[\s\S]*?\n(?=\S)/);   // 修复前: 只吃首行
    if (g && g[0].length < 600) s = s.slice(g[0].length);
    return s.replace(/^[\s,，。;；:：]+/, '').trim();
  };
  // 修复前 _splitEnumeratedParallel 拿的是原始 input (没剥), head 整块带走卦块模板
  const oldFound = (() => {
    const s = guaPrefixed;                              // ← 注意: 没剥
    const re = /(?:^|[\s，,、;；:：])(?:\(?([0-9]{1,2})\)|([0-9]{1,2})[.、:：])(?![\w.])/g;
    const marks = [];
    let m;
    while ((m = re.exec(s)) !== null) marks.push({ at: m.index, len: m[0].length });
    if (marks.length < 2) return null;
    return { head: s.slice(0, marks[0].at).trim() };    // head = 卦块 + 主人问题全文
  })();
  assert.ok(oldFound && /【盘古起卦/.test(oldFound.head),
    '老逻辑的 head 确实带着整块卦块');
  const oldKnife = oldFound.head + ' —— 只做这一项: /a/checkpoint.js';
  // T1 的判据
  assert.ok(/【盘古起卦/.test(oldKnife), 'T1 (刀里不许有卦块) 对老逻辑必须红');
  // T2 的判据
  assert.ok(oldKnife.length >= 120,
    `T2 (刀文本 <120 字) 对老逻辑必须红, 实际 ${oldKnife.length} 字`);
  // 而只剥首行 (老正则) 也不够 —— 证明第二个根因是独立的
  const onlyFirstLine = oldStripNoise(guaPrefixed);
  assert.ok(/本卦:/.test(onlyFirstLine),
    '只吃卦块首行不够, 「本卦/五行/回答顺序」那两行仍会复制进每一刀');
});

