// 2026-10-16 确定性任务拆分 —— planner 被打挂时的兜底
//
// 为什么需要它 (现场: 本地 qwen3.8-27b, planner 300s LLM timeout):
// planner 是**非流式阻塞**调用, 本地模型没配 max_tokens → outputTokenCap 兜底给 32768,
// 而 27B 解码 ~20 tok/s, 光生成就能跑 27 分钟。300s 的墙在第 6000 token 处砍掉它。
// 砍掉之后旧码走的是: 关键词路由 (对"建 3 个文件"这种没有关键词的活必空) →
// 退回 j2 主循环**单线程硬啃整件事**。这就是"跟死了一样"最纯的一种形态:
// 活能干完, 但没人拆、没人并行、没人汇报, 全程看不见进度。
//
// 所以这里补一层: 模型来不及拆的时候, 我们自己拆。规则式, 不猜, 只做两件事:
//   ① 按**动作顺序**切句 (然后/之后/再/最后 这些连接词就是顺序的明文)
//   ② 按**动词**派角色 (写=executor, 读/验/列=checker, 分析=analyzer)
//
// 边界 (必须诚实):
//   - 这是兜底, 不是替代。LLM planner 能用时优先用它 —— 规则拆不出隐含依赖。
//   - 拆不出 ≥2 刀就返回 null, 让上层退回原路径。宁可少拆, 也不要错拆。
//   - 不切 "、" 和文件名内部 (a.txt、b.txt 是一个动作里的三个宾语)。
'use strict';

// 卦块的收尾锚点 —— 唯一真源 (别在这里抄第二份, 见 _stripNoise 里的注释)
const { findGuaBlockEnd } = require('./gua_block');

// 顺序连接词: 这些词出现就说明"上一刀做完才轮到这一刀"。
const SEQ_MARKERS = [
  '然后', '接着', '之后', '再然后', '随后', '紧接着',
  '最后', '最终', '做完之后', '建完之后', '完成后', '写完之后', '改完之后',
  '改完', '写完', '做完', '建完', '弄完', '全部完成', '都建好',
  '全部完成后', '都建完之后', 'all done after',
];

// 角色判定: 先命中先算。写在前, 因为"读回确认"里也含"确认",
// 而"创建...然后读回确认"应该按出现顺序拆成两刀, 不是一刀。
const ROLE_RULES = [
  {
    agent: 'kun',
    // 动手的动词 —— 这些刀真的要写盘/跑命令
    kws: ['创建', '新建', '建立', '生成', '写入', '写一个', '写个', '编写', '搭建', '部署',
      '安装', '配置', '修改', '改动', '重写', '重构', '优化', '修复', '修好', '改一下',
      '删掉', '删除', '移动', '重命名', '填充', '导出', '导入', '上传',
      'create', 'write', 'build', 'make', 'implement', 'generate', 'install', 'setup',
      'modify', 'refactor', 'fix', 'optimize', 'update', 'patch', 'delete', 'move',
      'rename', 'deploy', 'export', 'import'],
  },
  {
    agent: 'li',
    // 只读的思考型动词 —— 要结论但不动手
    kws: ['分析', '对比', '比较', '研究', '调查', '排查', '定位', '找出', '梳理', '总结一下',
      '为什么', '怎么回事', '有没有问题', '哪个更', '优缺点',
      'analyze', 'research', 'investigate', 'diagnose', 'compare', 'why', 'find out'],
  },
  {
    agent: 'dui',
    // 验收型动词 —— 这一刀存在的意义是"别相信上面那刀的自述"
    kws: ['验证', '确认', '检查', '核对', '校验', '复核', '读回', '回读', '读取', '查看',
      '看看', '列出', '列一下', '统计', '数一下', '测试', '跑一下测试',
      'verify', 'confirm', 'check', 'validate', 'read back', 'list', 'count', 'test',
      'review', 'audit'],
  },
];

// 纯搬运动词, 不单独成刀 (它们依附在别的刀上)
const ATTACHED_VERBS = ['汇报', '报告', '告诉我', '说一下', '说明', '答复', '回答我', '给个结论'];

// 2026-10-16 (现场 v3-034204 的时间账): 拆分器**过度拆分**是这个快路的拦路虎 ——
//   "在 /tmp/x 创建 m.txt 和 n.txt。确保目录存在后再写入, 写完读回确认内容正确。"
//   本地 planner 要 61.8s, 而这条规则式拆出来的计划是:
//     #0 executor 创建 2 个文件 | #1 executor 确保目录存在后再写入, | #2 checker 读回确认
//   三刀。#1 不是一份独立的活, 它是 #0 的**前置条件**被切成了单独一刀, 于是多付一整次
//   大上下文推理调用 (本模型 ~58s) —— 把省下的 planner 时间又吃回去还倒亏。
//
// 合并判据 (故意只认语法上明确从属的那几种):
//   开头是"确保/其中/另外/同时/也/再" —— 依附于上一刀, 自己不是完整指令
//   或句中含"后再/之后才/完成后/写完后/建完后" —— 时间状语后置, 说明它跟在上一刀后面
// **明确不认"先"**: "先备份数据库, 然后迁移" 里"先备份"是独立的第一刀, 合掉就错了。
// 2026-10-24 (第 78 批, 实跑 probe76-multi) 补第三类: **回指代词 / 分配量词**。
//   现场主话: "在 /tmp/x 创建 3 个文件 a.txt b.txt c.txt, 每个写入不同的中文, 然后逐个读回确认"
//   规则拆分切出 3 刀:
//     #0 kun 「在 /tmp/x 创建 3 个文件 a.txt b.txt c.txt」
//     #1 kun 「每个写入不同的中文」   ← **不自足**: 没说"每个"是指哪三个
//     #2 dui 「逐个读回确认…」
//   #1 的子 agent 只好**自己猜**"每个"是谁 ⇒ 把三个文件**又写了一遍**
//   (现场: 两轮写入内容不同, 第二轮覆盖第一轮 —— 主人看到的是重复劳动)。
//   ⇒ "每个/各个/每一/各自/逐个/分别/它们/这些/那些/该" 这类**回指**开头的小句,
//     不是一份独立的活, 是上一刀的补充 ⇒ 同角色时并进上一刀。
//   "该" 一律当回指 ("该文件"/"该目录" 是主人话里的常见写法)。
//   情态用法 ("该做"/"该有") 在主人的活里极罕见, 不为它牺牲刀的自足性 ——
//   宁可多并一刀 (并了原文还在, 不丢东西), 不可留一刀自足不了的活让子 agent 去猜。
const CONT_PREFIX_RE = /^(确保|其中|另外|同时|也|再|其[余它]|每[个各项条份种]|各[个自]|逐[个项条次]|分别|它们|这些|那些|上述|该)/;
const CONT_SUBORDINATE_RE = /(后再|之后才|之后在|之后$|完成后|写完后|建完后|改完后|做完再)/;

/** 这一句是不是上一刀的附属/前置, 而不是一份独立的活 */
function _isContinuationOf(clause, prev) {
  if (!prev || prev.agent !== clause.agent) return false;
  const c = String(clause.task || '').trim();
  return CONT_PREFIX_RE.test(c) || CONT_SUBORDINATE_RE.test(c);
}

function _stripNoise(text) {
  let s = String(text || '');

  // 服务端在卦块后面拼 "主人问题:" —— 它之后才是真活
  const m = s.match(/主人问题:\s*([\s\S]*)$/);
  if (m && m[1].trim()) s = m[1];

  // 卦块模板的收尾句 —— 唯一真源是 modules/gua_block.js (GUA_BLOCK_END),
  // 这里**不再抄第二份**。2026-10-21 教训: 抄的那份跟生产那份各改各的, 改一次断一次 ——
  // 认不出收尾 → 整块卦象留在刀任务里 → 三刀各背 300 字一模一样的卦块 (就是"全量重填")。
  // 2026-10-16: 只靠下面那条"吃前缀几行"的正则时, 卦块 300 字
  // 只被吃掉**首行** (【盘古起卦 · 先于推理…】\n), 后面「本卦/五行/回答顺序」照样
  // 原样复制进每一刀 —— 三刀各 ~300 字, 仍是一模一样 (见 _splitEnumeratedParallel 现场)。
  // 有收尾句就整块吃掉; 没有就不猜, 交给下面的保守分支。
  if (s.indexOf('【盘古起卦') === 0) {
    const _e = findGuaBlockEnd(s, 0);
    if (_e > 0) {
      let _tail = s.slice(_e);
      // 卦块后面可能跟一行反幻觉提示, 也可能有 "主人问题:" 标记
      const _mk = _tail.match(/主人问题:\s*/);
      if (_mk && _mk.index <= 60) _tail = _tail.slice(_mk.index + _mk[0].length);
      else _tail = _tail.replace(/^\s*若工具没拿到数据[^\n]*\n?/, '');
      if (_tail.trim()) s = _tail;
      // 收尾句之后**什么都没有** → 卦块就是全部输入 (比如纯卦象问句), 保持原样。
    }
  }

  // 卦块只吃**前缀那几行**。刻意保守: 认不出边界就不猜。
  // 踩过的坑: 旧写法 `【盘古起卦】[\s\S]*?(?=【|$)` 在没有收尾标记时会一路吃到
  // 字符串末尾, 把主人的活连同卦块一起吃掉 —— 然后拆出 0 刀, 静默退回原路。
  // 多带几句卦辞反而无害 (只是多了些不在动词表里的词), 吃掉正事才致命。
  const g = s.match(/^【盘古起卦[\s\S]*?\n(?=\S)/);
  if (g && g[0].length < 600) s = s.slice(g[0].length);

  return s.replace(/^[\s,，。;；:：]+/, '').trim();
}

/**
 * 找第一个可切点。返回 {at, len} (len = 连接词长度, 逗号切点为 0) 或 null。
 *
 * 切点只在"**后半段自己带动作**"时才成立, 否则那半句是同一刀的补充说明。
 * 这条判据是这类拆分的全部难点:
 *   "创建 a.txt、b.txt、c.txt" —— 顿号绝不能切 (三个宾语属于同一刀,
 *     切成三刀后两刀就找不到"建目录"这个前提了)
 *   "创建文件，读回确认" —— 逗号能切 (两个独立动作, 有顺序)
 *   "重构超时逻辑，改完跑测试" —— "改完"能切 (完成副词是顺序的明文)
 */
function _findCut(p) {
  let best = null;
  for (const mk of SEQ_MARKERS) {
    const idx = p.indexOf(mk);
    if (idx <= 0) continue;
    const tail = p.slice(idx + mk.length);
    if (tail.trim().length < 4 || !_hasAction(tail)) continue;
    if (!best || idx < best.at) best = { at: idx, len: mk.length };
  }
  if (best) return best;

  // 逗号级: 只有后半段是独立动作才切。顿号/斜杠不在此列 (那是枚举)。
  const re = /[,，]/g;
  let m;
  while ((m = re.exec(p)) !== null) {
    const tail = p.slice(m.index + 1);
    if (tail.trim().length >= 4 && _hasAction(tail)) return { at: m.index + 1, len: 0 };
  }
  return null;
}

/**
 * 切成有序子句。绝不在顿号/文件名内部切。
 */
function splitClauses(input) {
  const text = _stripNoise(input);
  if (!text) return [];

  // 第一刀: 句号 / 分号 / 换行 —— 天然的顺序边界
  const rough = text
    .split(/[。;；!?！？\n]+/)
    .map(s => s.trim())
    .filter(Boolean);

  const out = [];
  const LEAD = new RegExp('^(\\s|[,，。;；:：]|' + SEQ_MARKERS.join('|') + ')+');
  for (const raw of rough) {
    let parts = [raw];
    // 反复切, 直到这一轮切不动 (一句里可能有多个顺序标记)
    for (let guard = 0; guard < 8; guard++) {
      const next = [];
      let cut = false;
      for (const p of parts) {
        const c = _findCut(p);
        if (c && c.at > 0) {
          const head = p.slice(0, c.at).trim();
          const tail = p.slice(c.at + c.len).trim();
          if (head && tail) { next.push(head, tail); cut = true; continue; }
        }
        next.push(p);
      }
      parts = next;
      if (!cut) break;
    }
    for (const p of parts) {
      const clean = p.replace(LEAD, '').trim();
      if (clean.length >= 4) out.push(clean);
    }
  }
  return out;
}

function _hasAction(s) {
  const t = String(s || '').toLowerCase();
  for (const rule of ROLE_RULES) {
    for (const kw of rule.kws) {
      if (t.includes(kw)) return true;
    }
  }
  return ATTACHED_VERBS.some(v => t.includes(v));
}

// 2026-10-16 (现场 live-1792146487916): "请分别分析这三个文件各自解决什么问题, 每个文件给 3 个要点:
// 1) .../j2_loop_shared.js 2) .../model_cost.js 3) .../checkpoint.js"
//
// 这类"编号并列清单"是长任务里最高频的形状, 而 splitClauses 只认句号/分号/换行 + 顺序连接词,
// 于是整个清单被当成**一句**: 拆出来是 analyzer「分析这三个文件」+ checker「给 3 个要点」——
// 角色还派错了 (出要点是 analyzer 的活, 不是 checker 的), 而且 analyzer 那一刀仍然要读全部三个文件,
// 并行一分没兑现。
//
// 编号清单是**并列**的天然证据, 所以按项切、并且**不串 depends_on** ——
// 串了就等于把本该并行的三刀排成一队, 比不拆还慢 (这个坑 2026-10-16 ed01b71 刚踩过)。
// 角色的判据取**清单前面那个动词** ("分别分析" → analyzer), 因为出项的是清单的主语动作,
// 不是每项末尾的修饰词。
function _enumeratedParallel(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  // 至少要有两处 "1)" / "2." / "3、" / "①" 这样的项标记。
  // 标记后必须跟空格/斜杠/汉字之类 —— `(?![\w.])` 是防"文件名伪装成编号":
  // "创建 2 个文件: 1.txt 内容 a, 2.txt 内容 b" 里的 1./2. 是**文件名**, 不是清单项。
  // 不加这道闸, 并列清单规则会把 executor + checker 的顺序活劈成两刀并行 executor,
  // "写完读回确认" 那一步直接消失 (planner-fast-path-20261016 正是这道题)。
  const marks = [];
  const re = /(?:^|[\s，,、;；:：])(?:\(?([0-9]{1,2})\)|([0-9]{1,2})[.、:：])(?![\w.])/g;
  let m;
  while ((m = re.exec(s)) !== null) marks.push({ at: m.index, len: m[0].length, num: Number(m[1] || m[2]) });
  if (marks.length < 2) return null;
  // 编号必须真的是 1,2,3... —— "2026.10" 这种会被误当编号, 宁可不拆
  marks.forEach((k, i) => { if (k.num !== i + 1) marks.length = 0; });
  if (marks.length < 2) return null;

  const head = s.slice(0, marks[0].at).trim().replace(/[，,、;；:：\s]+$/, '');
  const items = [];
  for (let i = 0; i < marks.length; i++) {
    const from = marks[i].at + marks[i].len;
    const to = i + 1 < marks.length ? marks[i + 1].at : s.length;
    const item = s.slice(from, to).trim().replace(/[，,、;；]+$/, '').trim();
    if (item) items.push(item);
  }
  if (items.length < 2) return null;
  // 清单前面必须有个真动作 ("分别分析…"), 否则我们不知道每项要干什么 —— 不猜。
  if (!head || !_hasAction(head)) return null;
  return { head, items };
}

function _splitEnumeratedParallel(input, maxSubTasks) {
  // 2026-10-16 (现场 subagent-runs.jsonl, 6 个样本): 这条路径**漏了 _stripNoise** ——
  // splitClauses 在自己函数里剥卦块 (134 行), 并列清单这条路拿的是没剥的原始 input,
  // 于是 head = 整个【盘古起卦】模板 + 主人真问题, 被原样复制进每一刀:
  //
  //   [0] analyzer len=332  "【盘古起卦 · 先于推理…】\n本卦: 大畜 ䷙…\n—— 回答顺序…\n请分别分析… —— 只做这一项: /a/j2_loop_shared.js"
  //   [1] analyzer len=328  "【盘古起卦 · 先于推理…】… —— 只做这一项: /a/model_cost.js"
  //   [2] analyzer len=328  "【盘古起卦 · 先于推理…】… —— 只做这一项: /a/checkpoint.js"
  //
  // 三个后果, 都是老板亲口点出来的:
  //   1) 三张卡**看起来一模一样** —— 前 300 字逐字相同, 唯一区别 (哪一刀) 在末尾,
  //      UI 的 line-clamp-1 只看得到公共前缀 → "子 agent 只做自己相关的" 完全看不出来;
  //   2) 每个子 agent 白读 300 字卦块模板 = 老板说的"全量重填"。本地 27B 每次
  //      prefill 都要为这 300 字付费, 三刀就是 900 字的重复开销;
  //   3) 卦块里还有一句 "引用…不要复述本块原文" —— 子 agent 拿到的却是整块原文, 自相矛盾。
  //
  // 卦意不会丢: j2_dispatcher 拼 taskText 时会用 _guaLine 单独补一行紧凑卦提示
  // (卦名+卦辞+动爻→之卦), 子 agent 该知道的方向照样知道; 真正的卦象定调是**综合阶段**
  // 的活 (1553/1671/1823 的 system prompt 都写着), 不该让每把刀各复述一遍。
  const found = _enumeratedParallel(_stripNoise(input));
  if (!found) return null;
  const agent = roleForClause(found.head);
  if (!agent) return null;
  const subTasks = found.items.slice(0, maxSubTasks).map((item) => ({
    agent,
    task: found.head + ' —— 只做这一项: ' + item,
    // 并列清单: 各刀互不依赖, 必须真并行 (串起来就白拆了)
    depends_on: [],
  }));
  return subTasks.length >= 2 ? { subTasks, source: 'deterministic', pattern: 'enumerated_parallel' } : null;
}

function roleForClause(clause) {
  const t = String(clause || '').toLowerCase();
  for (const rule of ROLE_RULES) {
    for (const kw of rule.kws) {
      if (t.includes(kw)) return rule.agent;
    }
  }
  return null;
}

/**
 * 拆成可派发的子任务列表。
 * 返回 { subTasks, source: 'deterministic', clauses } 或 null (拆不动就让上层走原路)。
 *
 * 刻意不加的两样:
 *   - 不发 analyzer 打头。规则拆解拿不到"先看什么才知道该做什么", 硬塞一个
 *     analyzer 只会多一轮 prefill, 而它的结论没人能用。
 *   - 不把"汇报"单独成刀。汇报是**交付动作**, 不是独立工作 —— 单独派一个
 *     checker 去汇报, 它手里没有事实, 只能编。正确做法是焊在最后一刀的尾巴上。
 */
function splitTask(input, opts = {}) {
  const maxSubTasks = typeof opts.maxSubTasks === 'number' ? opts.maxSubTasks : 6;
  // 编号并列清单先判: 它是并列而不是顺序, 走通用切句会被当成一句, 且会串成 depends_on
  const _enum = _splitEnumeratedParallel(input, maxSubTasks);
  if (_enum) return _enum;
  const clauses = splitClauses(input);
  if (clauses.length < 2) return null;

  const subTasks = [];
  for (const clause of clauses) {
    if (subTasks.length >= maxSubTasks) break;
    const agent = roleForClause(clause);
    if (!agent) {
      // 没动词判不出角色 —— 挂到上一刀后面 (它是同一件事的补充条件), 而不是硬派。
      if (subTasks.length) subTasks[subTasks.length - 1].task += '；' + clause;
      continue;
    }
    // 和上一刀同角色且都很短 → 并进上一刀。
    // 判据是"短": 同角色的两刀如果都只做一件事, 拆开只换来一次额外 prefill,
    // 换不到并行 (它们靠 depends_on 串行, 第二个看得见第一个的结论)。
    // 只有两刀都够长、明显是各自独立的事, 才值得各派一个将灵。
    const prev = subTasks[subTasks.length - 1];
    // 2026-10-16: 同角色的**前置条件/附属句**也并进上一刀 (见 _isContinuationOf)。
    // 这条不是省事, 是省钱: 多切一刀就多一次大上下文推理调用 (本模型 ~58s),
    // 而这些刀靠 depends_on 串行, 本来也换不到任何并行。
    if (prev && _isContinuationOf({ agent, task: clause }, prev)) {
      // 原句照留: "创建 2 个文件；确保目录存在后再写入" 读着是一张检查表,
      // 硬把"确保"剥掉会变成 "…；目录存在后再写入", 语义反而糊了。
      prev.task += '；' + clause.replace(/[，,；;、\s]+$/, '').trim();
      continue;
    }
    if (prev && prev.agent === agent && clause.length < 16 && prev.task.length < 16) {
      prev.task += '；' + clause;
      continue;
    }
    subTasks.push({ agent, task: clause, depends_on: subTasks.length ? [subTasks.length - 1] : [] });
  }

  // 合并后只剩一刀 → 拆解没带来任何东西, 如实交回 null 让上层走原路。
  // 这不是失败: 一刀本来就不需要拆, 强行造 plan 只是多一层壳。
  if (subTasks.length < 2) return null;

  // 标点体检: 合并时留下的 ',；' / '；。' 这类脏尾巴会进 prompt, 顺手清掉
  for (const st of subTasks) {
    st.task = st.task.replace(/[,，；;]+(?=[；;]|$)/g, '').replace(/[；;]{2,}/g, '；')
      .replace(/^[，,；;。\s]+/, '').replace(/[，,；;。\s]+$/, '').trim();
  }

  // 末尾的"汇报/告诉我"焊到最后一刀 —— 汇报的人必须是手里有事实的那个人
  const lastClause = clauses[clauses.length - 1];
  const wantsReport = ATTACHED_VERBS.some(v => lastClause.includes(v));
  const tail = subTasks[subTasks.length - 1];
  if (wantsReport && !_hasAction(lastClause)) {
    // 末句只有汇报动词 → 它的内容并进最后一刀
    if (clauses.length > 1) {
      tail.task = clauses.slice(0, -1).join('；') + '；' + lastClause;
    }
  }
  return { subTasks, source: 'deterministic', clauses };
}

module.exports = {
  splitTask,
  splitClauses,
  roleForClause,
  SEQ_MARKERS,
  ROLE_RULES,
  ATTACHED_VERBS,
};

