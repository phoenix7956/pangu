'use strict';
// 2026-10-21 现场 (老板实跑取证, E2E 第 24 卦那道题):
//   问「第24卦是哪一卦？请给出卦名、卦辞、上下卦」——
//   ① 服务端给这道**查表题**起了梅花卦 (时间起卦 → 小过 id=62), 跟主人问的 24 卦毫无关系。
//      模型最后答对了 (复卦), 但得自己排除干扰, 原话「不受起卦所示"小过"干扰」。
//   ② 答案第一行是「卦象定调: 此问只做编号核准, 宜"宜下不宜上"」—— 事实 (第24卦=复卦) 排在后面。
//      老板的抱怨「为什么每次都是卦象定调」在这里第二次现身。
//   ③ 工具轨迹: 派了 2 个子 agent, 22 次 exec_command/read_file 去 grep 本地源文件, ~80 秒 ——
//      本地 hexagram_lookup 一次调用就能答。
//
// 三个独立病因, 三个独立修法, 本文件逐条锁死:
//   ① 起卦门缺「问卦本身的资料」这一档 → 查表题被当谋断题, 白起一卦 (pangu-single.js)
//   ② dispatcher 门里 '卦' 是唯一保留的单字词条 → 「第24卦」一撞就进编排 (pangu-single.js)
//   ③ 顺序指令自相矛盾: 块里写"先给事实", dispatcher 综合提示词却强制"先以卦象定调" (j2_dispatcher.js)
//
// 判据方向: **宁滥勿缺** —— 误杀谋断 (少一次卦象) 比 多起一次卦 (有噪声) 贵得多。
// 老板 2026-08-02「卦先于人」的核心场景一条都不许被削掉。
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CORE = path.join(__dirname, '..');
const SINGLE = fs.readFileSync(path.join(CORE, 'pangu-single.js'), 'utf8');
const DISPATCHER = require(path.join(CORE, 'modules', 'j2_dispatcher'));

// pangu-single.js 不能 require (它 main() 里 listen(18901), 端口在用就 EADDRINUSE 退出),
// 所以判定函数只能抽源码求值。
// 2026-10-23 第 58 批: 词表搬去了 modules/gua_gate_kws.js, 原先「在 pangu-single.js
// 源码文本里切一段求值」取词表的方式已经切不到了 ⇒ 统一走共享装载器
// (词表从唯一真源取, 判定函数仍从 pangu-single.js 抽)。
const { shouldCastGua, shouldUseDispatcher, isGuaFactLookup } = require('./helpers/gua_gate_load.js');

const cast = shouldCastGua();
const dispatch = shouldUseDispatcher();
const isFact = isGuaFactLookup();

test('卦资料查询 → 不起卦 (查表题不配梅花卦)', () => {
  const CASES = [
    ['第24卦是哪一卦？请给出卦名、卦辞、上下卦', '现场原题'],
    ['雷风恒卦的卦辞是什么', '某卦卦辞'],
    ['讼卦的爻辞有哪些', '某卦爻辞'],
    ['第3卦叫什么', '第N卦'],
    ['64卦的卦序是怎么排的', '卦序'],
    ['六十四卦里哪一卦是纯阳', '六十四卦'],
    ['震卦的纳甲是什么', '纳甲'],
  ];
  for (const [input, why] of CASES) {
    assert.equal(isFact(input), true, `没认出卦资料查询 (${why}): 「${input}」`);
    assert.equal(cast(input), false, `卦资料查询不该起卦 (${why}): 「${input}」`);
  }
});

test('谋断 / 明确要卦 / 卦+启示 → 仍然起卦 (不许误杀老板的核心场景)', () => {
  const CASES = [
    ['这个项目该不该继续做', '谋断'],
    ['帮我分析下风险', '谋断'],
    ['算一卦看看第24卦的卦辞', '明确要卦'],
    ['用易经看这个项目该怎么做', '明确要卦'],
    ['第24卦对我这项目有什么启示', '卦 + 谋断语义'],
    ['第24卦对我意味着什么', '卦 + 谋断语义'],
    ['这卦对我该怎么办', '卦 + 谋断语义'],
  ];
  for (const [input, why] of CASES) {
    assert.equal(isFact(input), false, `不该当成卦资料查询 (${why}): 「${input}」`);
    assert.equal(cast(input), true, `谋断场景被误杀了 (${why}): 「${input}」`);
  }
});

test('卦资料查询 → 不进 dispatcher (查表题不是长任务, 主循环一个工具调用就够)', () => {
  assert.equal(dispatch('第24卦是哪一卦？请给出卦名、卦辞、上下卦'), false,
    '查表题被派进编排 = 2 个子 agent + 22 次 shell 去 grep 本地源文件');
  assert.equal(dispatch('雷风恒卦的卦辞是什么'), false);
  // 反面: 谋断题照旧进编排
  assert.equal(dispatch('这个项目该不该继续做'), true, '谋断题不该被踢出编排');
});

test('卦块不许再出现"卦象定调"字样, 也不许用禁令式措辞', () => {
  const { _formatGuaFirstBlock } = require(path.join(CORE, 'modules', 'pangu_agent_stream'));
  const block = _formatGuaFirstBlock({
    gua_name: '小过', symbol: '䷽', upper_trigram: '震', lower_trigram: '艮',
    gua_ci: '小过，亨利贞。', yao_name: '九三', moving_yao_ci: '九三：弗过防之。',
    wuxing: '木', yao_wuxing: '金', wuxing_rel: '木耗金', liu_qin: '官鬼', position_nature: '变机',
  });
  assert.ok(!block.includes('卦象定调'),
    '块里出现"卦象定调"这四个字, 模型就会把它当答案的开篇标签 (实跑: 「卦象定调: 此问只做编号核准…」)');
  assert.ok(!block.includes('不要复述'),
    '禁令式措辞: 写"不要说什么"等于亲手把那个词喂给模型');
  assert.ok(block.includes('第一段先给已核实的事实/结论'),
    '块内必须写明第一段先给事实 (老板 2026-10-09 裁定)');
});

test('dispatcher 综合提示词: 事实/结论在前, 卦象在后 (不再强制"先以卦象定调")', () => {
  //
  // 2026-10-23 第 63 批 —— 这条测试当时只验了 4 条综合路径里的 1 条。
  //
  // 病根: `j2_dispatcher.js` 的综合 system prompt 被抄了**四遍**
  // (_buildSynthesisMessages + 三处内联), 10-21 只修了 `_buildSynthesisMessages` 这一份,
  // 测试也只调这一份 ⇒ **修了 1/4, 测试只验那 1/4, 全绿**,
  // 另外三条路径继续在让模型拿卦象开篇 (老板明令禁止的那件事)。
  //
  // 所以这条测试现在只保留**它真正能证明的那一件事**:
  // 10-21 那次现场修的那份路径确实是「事实在前」。
  // **全部 4 条路径的覆盖面已交给 synth-prompt-single-20261023.test.js**
  // (T6 扫全部拼装点 + T8 扫全库抄本 + T9 真调 dispatcher 导出路径)。
  // 别再在这里加第 2 条、第 3 条同义的扫源码断言 —— 那正是这个坑的成因。
  const msgs = DISPATCHER._buildSynthesisMessages('nonexistent-session-gua-fact-test', '第24卦是哪一卦', '', [], 12000);
  const sys = msgs.map(m => m.content || '').join('\n');
  assert.ok(sys.length > 0, '综合提示词没拿到');
  assert.ok(!/必须先以卦象定调/.test(sys),
    '综合提示词还在强制"先以卦象定调" —— 老板抱怨的"每次都是卦象定调"就是它造成的');
  assert.ok(/第一段先给已核实的事实/.test(sys), '综合提示词应写明第一段先给事实/结论');
});

test('系统提示词与规则 19 与块口径一致 (都必须是"事实优先")', () => {
  assert.ok(!/卦象定调放在事实之后/.test(SINGLE),
    '系统提示词里还留着"卦象定调"这个短语 (模型会照着它开篇)');
  const rules = fs.readFileSync(path.join(CORE, 'modules', 'global_agent_rules.js'), 'utf8');
  assert.ok(/第一段先给已核实的事实\/结论/.test(rules), '规则 19 应写明第一段先给事实');
  assert.ok(/用卦 ≠ 用卦开头/.test(rules), '规则 19 应说清"用卦 ≠ 用卦开头"');
  assert.ok(/hexagram_lookup/.test(rules), '规则 19 应指向 hexagram_lookup 取 64i 真源');
});

test('hexagram_lookup 描述: 卦序写死 1..64 + 明说"先查这里, 别搜网别 grep"', () => {
  // 2026-10-25 (第 97 批): 改读**运行时注册表**。原来那条源码正则
  //   /hexagram_lookup:[\s\S]*?description:([\s\S]*?),\n/ 的 [\s\S]*? 会跨工具边界跑,
  //   可能抓到**下一个**工具的描述 —— 运行时读法不会。
  const TOOLS_SCHEMA = require(path.join(CORE, 'modules', 'tools_schema')).TOOLS_SCHEMA;
  const def = TOOLS_SCHEMA.hexagram_lookup;
  assert.ok(def && def.function, '取不到 hexagram_lookup 的描述');
  const desc = String(def.function.description || '');
  assert.ok(desc.includes('卦序 1..64'), '必须写死卦序是 1..64 (老板亲口点的坑)');
  assert.ok(/不要搜网/.test(desc), '应明说不要搜网');
  assert.ok(/第一个动作/.test(desc), '应明说第一个动作是调本工具');
});

test('生产代码里, 卦块收尾句只有一份 (别再抄第二份)', () => {
  // 2026-10-21 实况: 块正文改了措辞 → 生产代码里**三处**各抄一份的收尾句有两处没跟上 →
  //   剥离认不出收尾 → 整块卦象留在路由输入/刀任务里 → 卦象里的"推理/分析"替主人投票 →
  //   任务被派给写不了盘的 analyzer, 或者三刀各背 300 字一模一样的卦块。
  //   3 条测试当场红, 但"生产其实是好的"这句话没人说得清。
  // 机制: 收尾句只允许出现在 modules/gua_block.js 一处 (生产者和消费者都从那儿取)。
  const { GUA_BLOCK_END, GUA_LEGACY_BLOCK_ENDS } = require(path.join(CORE, 'modules', 'gua_block'));
  const files = [];
  const walk = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) walk(p);
      else if (e.name.endsWith('.js')) files.push(p);
    }
  };
  walk(path.join(CORE, 'modules'));
  walk(path.join(CORE, 'agents'));
  files.push(path.join(CORE, 'pangu-single.js'));
  // 扫"代码里还有没有"之前先剥注释 —— 否则历史说明(「原来这里是 …」)把自己顶红。
  // (今天的坑: 顶红两次之后没人看这个测试了, 守卫自己先失效。)
  const stripComments = (s) => s.replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
  for (const marker of [GUA_BLOCK_END, ...GUA_LEGACY_BLOCK_ENDS]) {
    const hits = files.filter(f => stripComments(fs.readFileSync(f, 'utf8')).includes(marker));
    assert.deepEqual(hits.map(f => path.basename(f)), ['gua_block.js'],
      `收尾句「${marker}」在生产代码里不止一份: ${hits.join(', ')} —— 抄一份就漂一次`);
  }
});

test('老版本形状的卦块照样剥得干净 (老会话里还存着 2026-10-21 之前的块)', () => {
  const { GUA_LEGACY_BLOCK_ENDS } = require(path.join(CORE, 'modules', 'gua_block'));
  const { _stripGuaBlockForRouting } = require(path.join(CORE, 'modules', 'j2_dispatcher'));
  const legacyTail = GUA_LEGACY_BLOCK_ENDS[0];
  const legacy = '【盘古起卦 · 先于推理 (梅花易数, 64i 真卦辞爻辞)】\n'
    + '本卦: 明夷 (坤上离下)「明夷，利艰贞。」\n'
    + '—— 回答顺序 (2026-10-09 老板定): 先给已核实的事实/结论, 卦象放在事实之后。'
    + '引用上面的真卦辞爻辞时' + legacyTail + '\n\n主人问题: 读一下 a.js';
  assert.equal(_stripGuaBlockForRouting(legacy), '读一下 a.js',
    '老会话的卦块剥不干净 → 卦象会替主人投票 (老句子当年是 2026-10-21 之前的收尾句)');
});
