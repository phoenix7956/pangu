'use strict';
/**
 * plan_verdict —— 拆解轮(主 agent 那一刀)的判据:「拆不动」到底是哪一种
 *
 * ## 起因 (2026-10-24 第 77 批, 实跑 probe76b-decide)
 *   主 agent (乾) 在 planOnly 那一轮只有两个结局: 派 ≥2 刀, 或者说一句「拆不动」。
 *   原来 dispatcher 里 `await j2AgentLoop._runAgentLoopLegacyStream(...)` 的
 *   **返回值没有被接住** —— 拆解轮说了什么, dispatcher 一点都不知道, 于是
 *   「拆不动」这三个字连同它的理由一起消失。
 *   现场代价: 主人问「这个项目该不该继续做, 值不值」, 主 agent 明明回了
 *   「指代不明, 需要主人先点一下是哪个项目」, 盘古却接着买了第二次坎·planner,
 *   派了个 li 去「探索项目全貌」—— 146 帧没有一个 final, 主人这一轮什么都没拿到。
 *
 * ## 三态
 *   B  指代不明 —— 主人这句话本身缺对象, 拆不出自足的子任务。
 *      ⇒ 不派任何子 agent, 把主 agent 的反问交回主人 (这本身就是一次交付)。
 *   A  一件事就完 —— 活是清楚的, 只是不需要拆。
 *      ⇒ **不再买第二次 planner (坎)**, 直接走确定性拆分 / 关键词兜底 / 单 agent。
 *   其它(含空) —— 主 agent 没表态。
 *      ⇒ 原路不变 (规则快路 → 坎·planner → 关键词兜底)。
 *
 * ## 为什么要单独一个模块
 *   ① 这条判据吃的是**主 agent 的原话**, 必须有语料夹具才测得动;
 *     埋在 dispatcher 的闭包里就只能靠实跑验 (一次 9 分钟, 而且只覆盖一种问法)。
 *   ② dispatcher 里要用同一份判据做两件事: 分类(走哪条路) + 放行
 *     (澄清文本不许被「词法对齐门」当成跑题吃掉)。两处两个判据 = 迟早漂。
 *
 * ## 判据为什么写在函数体里
 *   测试装载器注入的是**函数源码**, 模块级依赖不会跟着走
 *   (2026-10-24 踩坑日志: 线上好好的, 测试里整档 ReferenceError, 症状看着像断言写错)。
 *   所以本文件的正则一律内联在函数体内部, 不放模块级常量。
 */

/**
 * 判定拆解轮的结论属于哪一类。
 *
 * @param {string} text 主 agent 那一刀的正文(拆不动 / 反问 / 其它)
 * @returns {{kind: 'B'|'A'|'empty'|'other', reason: string}}
 */
function classifyPlanVerdict(text) {
  const t = String(text == null ? '' : text).trim();
  if (!t) return { kind: 'empty', reason: '拆解轮没有留下正文' };

  // tier1 —— 「主人这句话指向不明」专用的信号。
  //   这些词在正常答复里不会出现, 单个命中即可定案。
  const tier1 = /(指代不明|指代不清|指向不明|指向不明确|不明确指向|没有明确指向|无明确指向|拆不出|哪个项目|是哪个项目|需要主人先点|先点一下)/.test(t);

  // tier2 —— 指代不清的**弱**信号, 必须跟「拆不动」(主 agent 明确表态)一起出现。
  //
  // 为什么不是裸词「哪个」「不确定」: 那两个词在 A 类的解释句里到处都是 ——
  //   「这件事没有哪个子任务能独立完成」(A: 一件事就完)
  //   「不确定的是要不要当场改」(A: 活本身是一件)
  // 用裸词的话, 这两句都会被误判成 B(指代不明) ⇒ 主人被问一句根本没问的澄清。
  // 所以 tier2 只收**带指代语义**的整个说法: 「没说是哪个」「不确定是哪个」…
  const tier2 = /(没(?:有)?说(?:清|清楚)?(?:明白)?(?:是)?哪|不(?:确定|清楚)(?:是)?哪|不知(?:道|晓)(?:是)?哪)/.test(t);

  // tier3 —— **主 agent 在向主人回问**的形态。
  //
  // 为什么单开一档 (2026-10-24 实跑): 给拆解轮的提示词加了一条
  // 「用第二人称把要问主人的话写出来」之后, 模型写的是:
  //     拆不动。
  //     你说的「这个项目」是哪一个? 给个名字或路径我就接着判。
  // 这段话**一个 tier1/tier2 的词都没有**(没有「指代不明」, 没有「没说是哪个」),
  // 但它就是在回问主人 —— 判成 A 就等于「不听这句反问, 自己猜一个项目开干」。
  //
  // 这一档收的是**请求形态**(在问主人要什么), 不是描述形态, 所以不需要跟「拆不动」一起出现。
  // 但也不能只看「是哪一个」—— 那是描述句也会用的词:
  //   「读的是哪一个文件由主人的原话指定, 建议直接 read_file」(A: 在解释怎么干)
  //   「你说的『这个项目』是哪一个? 给个名字或路径」(B: 在回问主人)
  // 所以要么**问的是主人**(你…哪), 要么**在要名字/路径**(给个名字…)。
  const tier3 = /(你(?:说|问|指)[^。？\n]{0,20}哪|给(?:个|一个)?(?:名字|路径|目录|文件名)|说(?:个|一个)?(?:名字|路径)|点一下|指明一?下)/.test(t);

  // A 类的标志 —— 主 agent 明确说「这件事拆不动」。
  const aMark = /拆不动/.test(t);

  if (tier1 || tier3 || (aMark && tier2)) {
    return { kind: 'B', reason: '主人这句话指代不明, 拆不出自足的子任务' };
  }
  if (aMark) return { kind: 'A', reason: '一件事就完, 拆不动' };
  return { kind: 'other', reason: '主 agent 没给拆解结论' };
}

/**
 * 这段文字是不是「向主人回问」—— 用来决定要不要放行词法对齐门。
 *
 * 与 classifyPlanVerdict 的 B 判定**同一份判据**:
 *   分类说它是指代不明 ⇒ 放行; 分类说它不是 ⇒ 走原门。
 * 两处如果各写一份词表, 迟早漂 —— 所以这里只调一个真源。
 *
 * @param {string} text
 * @returns {boolean}
 */
function isClarification(text) {
  return classifyPlanVerdict(text).kind === 'B';
}

/**
 * 把主 agent 的内部判断改成能直接上屏给主人看的文字。
 *
 * 只做两件事, 都是**内部标记**, 不是改写模型的意思:
 *   ① 剥掉开头的「拆不动」—— 那是拆解轮提示词要求的**信号词**,
 *      是给 dispatcher 看的, 用户看不懂, 也不该出现在答复第一行。
 *   ② 「主人」→「你」—— 提示词里主人是「主人」, 但答复是写给用户看的。
 *      (顺带解决了词法对齐门: 「主人问…」会被判成编排泄漏, 把整段反问吃掉。)
 *
 * @param {string} text
 * @returns {string}
 */
function toUserFacingClarification(text) {
  return String(text == null ? '' : text)
    .replace(/^\s*拆不动\s*[。.!！,，;；:：—–\-]?\s*/, '')
    .replace(/主人/g, '你')
    .trim();
}

/**
 * 「主 agent 判『一件事就完』」之后, **能不能**再用规则拆分器切一刀?
 *
 * ## 为什么不许 (2026-10-24 第 78 批, 实跑 probe76-multi)
 *   现场主 agent 的原话是:
 *     「拆不动。这是一条线性链（建 3 文件 → 逐个读回 → 写 summary.txt）,
 *       三步互相依赖、同一目录, **拆了反而要排队等依赖, 不如一口气做完**。」
 *   这个判断是**对的**。而 dispatcher 转头用规则拆分器把它切成了 3 刀:
 *     kun「创建 3 个文件」→ kun「每个写入不同的中文」→ dui「逐个读回确认」
 *   ① 第 2 刀**不自足** (没说"每个"是指谁) ⇒ 子 agent 把三个文件**又写了一遍**;
 *   ② 三刀靠 depends_on **串行** ⇒ 并行一分没换到, 只多付两次大上下文推理;
 *   ③ 结论就是主 agent 说的: 不如一口气做完。
 *
 *   规则拆分器 (modules/task_split.js) 的定位是「**planner 被打挂、没人拆**」时的兜底,
 *   不是「有人已经拆过了」的兜底 ⇒ 主 agent 判过「拆不动」, 它就不该上。
 *
 * ## 判据在哪
 *   与 classifyPlanVerdict **同一模块** —— 分类和它的后果不许分家,
 *   否则改了分类忘了改后果, 就会重演第 77 批那个「判据对了、整轮还是白等」。
 *
 * @param {string|{kind?:string}} verdict 分类结果或它的 kind
 * @returns {boolean} true = 允许用规则拆分器
 */
function shouldUseDeterministicSplit(verdict) {
  const kind = (verdict && typeof verdict === 'object') ? (verdict.kind || '') : String(verdict || '');
  if (kind === 'A') return false;
  return true;
}

module.exports = {
  classifyPlanVerdict,
  isClarification,
  toUserFacingClarification,
  shouldUseDeterministicSplit,
};
