'use strict';
/**
 * tests/gua-gate-concrete-target-20261024.test.js
 * 第 76 批: 「具名对象」档 —— 取数任务不许被无端起卦
 *
 * 现场 (2026-10-24 08:34, 桌面端真主路 /api/pangu/agent/stream 实跑探针):
 *   主人原话: 「读一下 /tmp/probe76_target.txt 这个文件, 把我给你的编号原样告诉我, 一句话就行。」
 *   现象:     **起了卦** (梅花易数·时间起卦 → 颐 ䷚, 上九动, 之卦复),
 *             卦块被 prepend 进子 agent 的任务, 于是答复尾巴挂了一段:
 *             「(卦象补充: 本卦颐「自求口实」, 动爻上九「由颐厉吉, 利涉大川」…)」
 *   ⇒ 一个「读文件报编号」的活, 卦象成了主角。
 *
 * 这是老板 10-24 原话「术数的部分跟盘古主体不需要强联系」的**实例**:
 *   盘古主体在干「取事实」的活, 术数不该插队。
 *
 * 根因 (不是"漏了几个词"):
 *   抑制表是**开放集** —— 它有「看一下 / 看看 / 告诉我数据」, 唯独没有「读取 / 读一下」;
 *   补上「读一下」, 下个月还会漏「念一下」「把第 3 行贴给我」。
 *   (「白名单永远漏词」这句话就是 2026-10-13 那版的原话, 本批把它落成结构判据。)
 *   ⇒ 新增一档**封闭集**判据: 主人点名了一个**已经存在的东西**
 *      (路径 / 文件名 / URL / 盘古自己的取数工具名) ⇒ 这题要的是事实, 不是判断。
 *
 * 判据方向: **宁滥勿缺** (与 2026-10-21 测试同一条纪律) ——
 *   误杀谋断 (少一次卦象) 比 多起一次卦 (有噪声) 贵得多。
 *   所以术数语境 (卦/爻/占/断/八字/风水…) 一律**放行**, 卦象照常出现。
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const { shouldCastGua } = require('./helpers/gua_gate_load.js');
const GATE = require(path.join(CORE, 'modules', 'gua_gate_kws.js'));

const cast = shouldCastGua();

// ============================================================
// ① 现场原话 —— 这一条红了就是没修
// ============================================================

test('现场: 「读一下文件告诉我编号」不许起卦 (2026-10-24 08:34 实跑)', () => {
  const INPUT = '读一下 /tmp/probe76_target.txt 这个文件, 把我给你的编号原样告诉我, 一句话就行。';
  assert.equal(cast(INPUT), false,
    '取数任务被起了卦 = 卦象进了答复尾巴 (实跑: 「(卦象补充: 本卦颐…)」)');
});

// ============================================================
// ② 真实流量抽样 —— 全部取自 ~/.pangu/memory/memory/sessions/ 的真会话记录
// ============================================================

test('真实流量里的取数任务 (逐字) 都不起卦', () => {
  const CASES = [
    ['读一下 /tmp/roundcap_proof.md 的第一行, 告诉我第 2 行是什么, 只回答内容本身', '读+路径'],
    ['用 read_file 读 /Users/you/Desktop/pangu/package.json 的前 3 行内容并告诉我 name 字段是什么。一句话回答。', '点名工具'],
    ['帮我看一眼 /tmp/b59_e2e_out.md 这个文件在不在，在的话读第一行告诉我。', '看一眼+路径'],
    ['请读取 /Users/you/Desktop/pangu/apps/core/modules/subagent_runs.js 的前20行，使用工具后只给一句简短结论。', '读取+路径'],
    ['请读取 /Users/you/Desktop/pangu/package.json，并列出其中的 scripts；必须使用真实工具读取后再回答。', '读取+列出'],
    ['读一下 /Users/you/Desktop/pangu/apps/core/package.json 的前 5 行，然后一句话告诉我这个项目的 test 脚本是什么', '读取+路径'],
    ['读一下 /Users/you/Desktop/pangu/IDENTITY.md 第一行', '读取+路径'],
    ['读 apps/core/modules/pangu_dogfood.js，回答：这个文件实际串联了几个将灵？', '相对路径+文件名'],
    ['http://127.0.0.1:18901/#/settings/agent和三 · 8 个子 agent(权威清单,已实调 list_pangu_agents 核实)', 'URL+工具名'],
    ['查看 /Users/you/Desktop/course-source 目录最近修改的 3 个文件，只报告文件名。', '目录+文件名'],
  ];
  for (const [input, why] of CASES) {
    assert.equal(cast(input), false, `取数任务被起了卦 (${why}): 「${input}」`);
  }
});

// ============================================================
// ③ 反面 —— 老板的核心场景一条都不许被削掉
// ============================================================

test('谋断 / 明确要卦 / 卦资料查询 → 仍然起卦 (不许误杀)', () => {
  const CASES = [
    ['这个项目该不该继续做', '谋断'],
    ['帮我分析下风险', '谋断'],
    ['这个项目该不该上，值不值', '谋断'],
    ['算一卦看今年财运', '明确要卦'],
    ['用易经看这个项目该怎么做', '明确要卦'],
    ['这个项目该不该继续做，做的话帮我写成方案', '谋断优先于执行'],
    ['读一下 /tmp/plan.md, 帮我判断这个方案该不该做', '有路径但仍是谋断'],
    ['算一卦看看第24卦的卦辞', '明确要卦优先于查表'],
  ];
  for (const [input, why] of CASES) {
    assert.equal(cast(input), true, `谋断场景被误杀了 (${why}): 「${input}」`);
  }
});

test('卦资料查询 → 不起卦 (2026-10-21 裁定: 答案在 64i 真源里, 不该靠起卦猜)', () => {
  // 这一档排在「术数语境」**之前** (pangu-single.js 的判定顺序, 已定死):
  //   主人问「第24卦的卦辞是什么」是**查表**不是占问 ⇒ 不起卦。
  //   术数语境不能把它翻回来 —— 否则「查资料」和「求判断」又混成一档了。
  const CASES = [
    ['第24卦的卦辞是什么', '卦辞'],
    ['读一下 /tmp/gua.md 里的卦辞', '卦辞 + 路径 (仍是查表)'],
    ['把 /tmp/najia.txt 的纳甲贴给我', '纳甲'],
  ];
  for (const [input, why] of CASES) {
    assert.equal(cast(input), false, `卦资料查询被起了卦 (${why}): 「${input}」`);
  }
});

test('术数语境放行 —— 主人真在问术数, 卦象是主角不是噪声', () => {
  // 这条锁的是 isConcreteTargetTask 的第一道门:
  //   主人句子里出现术数词 ⇒ 这题本来就在术数线上 ⇒ 卦象是主角不是噪声。
  // ⚠️ 样本**必须避开卦资料查询词** (卦辞/爻辞/纳甲/卦序/哪一卦…):
  //   那些是「查表」, 由上一条测 (不起卦); 混进来会让这一条变成空枪。
  const CASES = [
    ['看一下 /tmp/bazi.txt 里的八字', '八字'],
    ['/tmp/fengshui.txt 这份风水资料讲了什么', '风水'],
    ['读一下 /tmp/liuqin.md 的六亲', '六亲'],
    ['帮我看下 1991、11、23 这天的八字', '八字占问 (真实流量原话)'],
    ['这两���属八字能合吗', '合婚'],
  ];
  for (const [input, why] of CASES) {
    assert.equal(cast(input), true, `术数语境被当成取数误杀了 (${why}): 「${input}」`);
  }
});

test('术数词不许乱命中普通词 (具体用户 / 具体用途 / 打断语句)', () => {
  // 2026-10-24 实测: 词表初版用裸词 '体用' 和 '断语' ⇒
  //   '体用' 命中「具体用**户**」「具体用**途**」
  //   '断语' 命中「打**断语句**」
  // ⇒ 术数语境档会把**普通取数任务**当成占问放行 ⇒ 又把卦象塞回答复尾巴
  //   (方向正好反了: 这一档存在的意义是别误杀真占问, 不是乱放行)。
  const t = GATE.isShushuContext;
  assert.equal(t('统计具体用户数 /tmp/a.csv'), false, '「具体用户」被当成术数');
  assert.equal(t('这个具体用途说明一下'), false, '「具体用途」被当成术数');
  assert.equal(t('分析打断语句的处理逻辑'), false, '「打断语句」被当成术数');
  // 反向: 收窄之后, 真术数词还得认
  assert.equal(t('体用神是什么'), true, '「体用神」被误杀了');
  assert.equal(t('卦辞断语怎么说'), true, '「断语」被误杀了');
});

// ============================================================
// ④ 词表那一档也要修好 (不是只靠结构判据)
// ============================================================

test('取数动词族进了抑制表 (读/读取/念/抄… 这一族整族)', () => {
  // 这些**不带路径** —— 结构判据接不住, 只能靠词表。
  // 实跑流量里就有这种: 「读一下今天的运行日志, 概括盘古现在状态」。
  const CASES = [
    ['读一下今天的运行日志', '读一下'],
    ['读取当前目录名', '读取'],
    ['念一下这段话', '念一下'],
    ['抄一下第一行', '抄一下'],
    ['读一遍这个文件', '读一遍'],
  ];
  for (const [input, why] of CASES) {
    assert.equal(cast(input), false, `取数动词没被识别 (${why}): 「${input}」`);
  }
});

test('故意**不**收「告诉我」: 「告诉我今年财运如何」是占问, 不是取数', () => {
  // 这一条是「宁滥勿缺」纪律的具体化:
  //   「告诉我」语义有歧义 —— 「告诉我编号」是取数, 「告诉我财运」是占问。
  //   收进抑制表 = 把老板的核心场景误杀 ⇒ 不能收。
  assert.equal(cast('告诉我今年财运如何'), true,
    '「告诉我财运」被当成取数 ⇒ 老板明说要判断却没卦');
  assert.equal(GATE.GUA_SUPPRESS_KWS.includes('告诉我'), false,
    '「告诉我」进了抑制表 —— 会误杀「告诉我今年财运如何」');
  assert.equal(GATE.GUA_SUPPRESS_KWS.includes('告诉我数据'), true,
    '「告诉我数据」是取数, 该留着');
});

// ============================================================
// ⑤ 判据本身的行为 (不依赖 pangu-single.js 的接线)
// ============================================================

test('isConcreteTargetTask: 四类封闭信号各自认得出来', () => {
  const t = GATE.isConcreteTargetTask;
  assert.equal(t('看看 /tmp/a.txt'), true, '路径');
  assert.equal(t('把 README.md 贴出来'), true, '文件名');
  assert.equal(t('https://example.com/x'), true, 'URL');
  assert.equal(t('用 read_file 读一下'), true, '工具名');
  assert.equal(t('随便聊聊'), false, '没有具名对象');
  assert.equal(t(''), false, '空输入');
  assert.equal(t('和/或'), false, '单个斜杠不算路径 (「和/或」这种普通句子不该中招)');
});

test('isConcreteTargetTask: 路径判据的两头都得有约束 (中文目录名 vs 比值写法)', () => {
  // 这条锁的是 2026-10-24 探针查出的**两次**误判:
  //   第一版漏: 「读一下 <course-source>/<course-file>.md 的第三行」—— 主人桌面真有「易经」文件夹,
  //     中文目录名前面是**汉字**, 不是空白 ⇒ 漏判 ⇒ 取数任务被无端起卦。
  //   第二版过宽: 「A/B 测试」「和/或的关系」全中招 ⇒ 方向反了
  //     (普通句子被当路径 ⇒ 该压的没压, 不该起的起了)。
  // ⇒ 现在判据两头都约束: 斜杠前允许汉字, 斜杠后必须像路径 (含点/扩展名/目录形态)。
  const t = GATE.isConcreteTargetTask;
  // 认得出 (真取数任务)
  assert.equal(t('读一下 <course-source>/<course-file>.md 的第三行'), true, '中文目录名 + 相对路径');
  assert.equal(t('读一下 /tmp/sub/dir/file.txt'), true, '多级绝对路径');
  assert.equal(t('~/Desktop/x.md'), true, '家目录');
  assert.equal(t('./rel/f.txt'), true, '显式相对路径');
  // 认不出 (普通句子, 不能因为有斜杠就当路径)
  assert.equal(t('A/B 测试是什么'), false, '比值写法');
  assert.equal(t('和/或的关系'), false, '连接词');
  assert.equal(t('sub/dir'), false, '光秃秃两个词, 不是路径');
  assert.equal(t('这个 目录/子目录 怎么建'), false, '泛指的目录概念');
});

test('isConcreteTargetTask: 术数语境一律不认 (留后门给卦先于人)', () => {
  const t = GATE.isConcreteTargetTask;
  assert.equal(t('读一下 /tmp/x.md 里的卦辞'), false, '卦辞');
  assert.equal(t('把 /tmp/x.txt 的纳甲贴出来'), false, '纳甲');
  assert.equal(t('看下 /tmp/x.txt 的八字'), false, '八字');
  assert.equal(t('把 /tmp/x.txt 的风水讲一下'), false, '风水');
});

test('isConcreteTargetTask: 窄词不许乱命中 (占用/判断/断点续传 都不是占问)', () => {
  const t = GATE.isConcreteTargetTask;
  // 裸 '占' 会命中「占用」; 裸 '断' 会命中「判断/断点续传」。
  // 那会把两个纯取数任务误判成占问 ⇒ 反而把卦象塞回去 (方向反了)。
  //
  // ⚠️ 这里验的是 **isShushuContext** (术数语境那档), 不是 isConcreteTargetTask ——
  //   「统计一下磁盘占用情况 /tmp/du.txt」**带路径**, 所以 isConcreteTargetTask
  //   返回 true 是**对的** (它确实是取数任务) ⇒ 用 isConcreteTargetTask 断言
  //   「不是取数」是自己把两个语义混成一锅 (上一版就犯了这个错)。
  const s = GATE.isShushuContext;
  assert.equal(s('统计一下磁盘占用情况 /tmp/du.txt'), false, '「占用」不是占问');
  assert.equal(s('读一下 /tmp/a.txt 的中断记录'), false, '「中断」不是占问');
  assert.equal(s('判断一下断点续传的状态'), false, '「判断/断点」不是占问');
  // 具名对象那档仍要认这条 (它是取数任务 ⇒ 不起卦)
  assert.equal(t('统计一下磁盘占用情况 /tmp/du.txt'), true, '带路径 ⇒ 取数任务');
  assert.equal(cast('统计一下磁盘占用情况 /tmp/du.txt'), false, '取数任务被起了卦');
});

// ============================================================
// ⑥ 接线不许断 (装载器/别名)
// ============================================================

test('装载器把 isConcreteTargetTask 真的注进去了 (别让它成空枪)', () => {
  // 装载器的注入段在源码里; 这里验的是「线上那份 _shouldCastGua 里这一档真的生效」。
  // 判据: 若注入漏了, ①里的现场原话会红 —— 这一条是第二道网, 防止将来有人改了装载器。
  assert.equal(cast('读一下 /tmp/probe76_target.txt 这个文件, 把我给你的编号原样告诉我, 一句话就行。'), false,
    '这一档没生效 ⇒ 装载器或别名断了');
  // 反向: 术数语境必须还能起卦 (证明不是「一律 return false」)
  assert.equal(cast('算一卦看今年财运'), true, '不许把这一档写成一律不起卦');
});

test('档位顺序是契约: 术数语境必须在取数/执行词表**之前**', () => {
  // 2026-10-24 变异测试查出来的空枪:
  //   把 `_isShushuContext` 那一档从「词表之前」挪到「词表之后」, 测试**照样全绿** ——
  //   因为 isConcreteTargetTask **内部**也短路了术数语境, 双保险把顺序错误盖住了。
  //   ⇒ 双保险没错, 但**顺序本身是契约**(线上 _shouldCastGua 的判定次序),
  //     必须有一条测试在源码层把它钉死, 否则将来有人调顺序没人拦。
  const SINGLE = fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');
  const body = SINGLE.slice(SINGLE.indexOf('function _shouldCastGua('));
  const at = (needle) => {
    const i = body.indexOf(needle);
    assert.ok(i > 0, '源码里找不到: ' + needle);
    return i;
  };
  const iShushu = at('if (_isShushuContext(text)) return true;');
  const iConcrete = at('if (_isConcreteTargetTask(text)) return false;');
  const iSuppress = at('if (_GUA_SUPPRESS_KWS.some');
  const iExec = at('if (_GUA_EXEC_KWS.some');
  assert.ok(iShushu < iConcrete,
    '术数语境档必须排在具名对象档之前 (词表是「在做什么动作」, 术数语境是「属于哪条线」)');
  assert.ok(iConcrete < iSuppress && iConcrete < iExec,
    '具名对象档必须排在取数/执行词表之前 (封闭集要在开放集前面生效)');
  assert.ok(iShushu < iSuppress && iShushu < iExec,
    '术数语境档必须排在取数/执行词表之前 (「读一下易经这卦怎么看」不能被词表压掉)');
});

test('四类信号职责不许重叠 (URL 不许被路径判据顺手吃掉)', () => {
  // 2026-10-24 变异测试查出来的空枪:
  //   'https://example.com/x' 里的 '//' 会被路径判据匹配 ⇒ URL 判据成了**冗余档**,
  //   变异「清空 URL 判据」时测试不红 ⇒ 将来改一条会连累另一条, 没人拦得住。
  // ⇒ 断言 URL 判据**自己**就能认出 URL (清空它就会红)。
  const src = fs.readFileSync(path.join(CORE, 'modules', 'gua_gate_kws.js'), 'utf8');
  const body = src.slice(src.indexOf('function isConcreteTargetTask('));
  assert.ok(body.includes('if (!/:\\/\\//.test(t))'),
    '路径判据没排除 URL 形式 ⇒ URL 档是冗余的 (变异清空 URL 判据时测试不红)');
});

