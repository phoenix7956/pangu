// agents/gua-identity.js — 8 将灵的身份真源 (**零依赖**, 2026-10-18)
//
// 老板原话: 「这8个就应该是乾坎艮震巽离坤兑, 英文一个、中文一个」「应该统一」
//            「还有英文 code 要换成拼音」
//
// 为什么单独一个文件, 而不是继续住在 sub-agent.js 里:
//   身份表被抄了 7 遍, 而且在"乾是谁"上互相矛盾 (synthesizer vs dispatcher)。
//   上一版收进了 sub-agent.js 的 GUA_ROLES, 但**收晚了**: action_policy 也需要这张表 ——
//   只读角色名单 (READ_ONLY_ROLES) 就是"乾坎艮震巽离坤兑"里哪几个不许写盘。
//   让 action_policy 去 require sub-agent.js 就成了循环依赖 (sub-agent 反过来也 require
//   action_policy), 那种依赖在 Node 里半边是 undefined, 哪天 require 顺序一变就炸。
//   所以这张表必须是**叶子模块**: 谁都能引, 引谁都安全。
//
// ===== 身份约定 (2026-10-18 定死) =====
//   **只有拼音一个名字** (qian/kan/gen/zhen/xun/li/kun/dui)。没有别名。
//   老板原话: 「不要别名, 越多越乱」。
//
//   为什么拼音不是新造的名词: 它本来就是 config.agent.role_configs 的键
//   (pangu-single.js SUB_AGENT_DEFAULTS 实测 keys = qian..gen), 这层一直在用拼音,
//   只有 ROLES 和日志用英文 —— 同一个角色有两个真名, 于是"乾是谁"在五个地方
//   互相矛盾 (synthesizer vs dispatcher)。这次砍到只剩一个。
//
//   **本文件零英文。** 老板 2026-10-18 原话:「说了全部换, 还留着干嘛」。
//   上一版还留着 parseAgentName() 专门把模型吐的英文读成拼音, 理由是
//   「模型先验里全是英文」。那张表已删, 三个解析函数并成 resolveRole 一个。
//   旧数据 (subagent-runs.jsonl 里 3963 行英文 code) 的翻译表不在这儿 ——
//   翻译数据不是身份, 搬到读那份文件的那一侧去了, 本文件不导出。
//
// 卦象是**比喻**, 职责以 role 字段为准 —— 别拿卦象当职责说明。
//
// 2026-10-19: 意象层 (身体部位) 已砍, 一行只剩两层 —— 别再加第三层:
//   gua   它是谁   「坎」
//   role  它干什么  「拆」—— 唯一权威, 职责只在这里定义
//   zh    派生    gua · role = 「坎 · 拆」, 不手写
// 原来的第三层是意象 (`part`: 手指/眼/手), 纯比喻, 不含新信息 ——
// 每个将灵的 system prompt 第一行本来就自述了身份。详见下面那段注释。
//   乾 ☰ 调度      坎 ☵ 拆         艮 ☶ 记         震 ☳ 复盘
//   巽 ☴ 找雷      离 ☲ 读         坤 ☷ 做         兑 ☱ 验
'use strict';

// 一行一个将灵。拼音 (code) 是唯一身份, 不再有第二列。
//
// 2026-10-18: 这里原来每行同时写 `pinyin` 和 `code`, 两个字段值永远一样。
// 跟上一轮删掉的 roster `id` 字段是同构 bug —— 同一个角色两个名字, 改一处忘另一处
// 就静默漂移 (roster 那次是 24 处调用点读到 undefined)。所以只留 `code` 一个,
// 并且 GUA_BY_PY / GUA_BY_GUA / GUA_BY_CODE 三张同值表收成 GUA_BY_CODE 一张
// (拼音 + 卦名都在里面, 前两张是它的子集, 同一个对象引用)。
const GUA_ROLES = [
  { gua: '乾', code: 'qian', icon: '☰', role: '调度' },
  { gua: '坎', code: 'kan',  icon: '☵', role: '拆'   },
  { gua: '艮', code: 'gen',  icon: '☶', role: '记'   },
  { gua: '震', code: 'zhen', icon: '☳', role: '复盘' },
  { gua: '巽', code: 'xun',  icon: '☴', role: '找雷' },
  { gua: '离', code: 'li',   icon: '☲', role: '读'   },
  { gua: '坤', code: 'kun',  icon: '☷', role: '做'   },
  { gua: '兑', code: 'dui',  icon: '☱', role: '验'   },
];

// 2026-10-19: 意象层 (身体部位) 砍掉。
//
// 起因是它把两层手写进了同一个字段: `zh` 原来是 '手指 · 求解' / '心 · 破局' ——
// 身体部位(意象) 和职责动词各一份, 于是 8 个里 7 个在提示词里被告知的职责
// 跟真职责对不上 (`zh` 会流进 sub-agent.js:1523 的 `你作为 ${role.name} …`)。
//
// 但真正该砍的是意象本身, 理由是它**不含任何新信息**:
//   · 8 个 system prompt 第一行已经自述了完整身份
//     ('你是 Pangu 的 Analyzer。职责：分析需求、读取文件…'), 意象是纯冗余
//   · 它是仓库自己那条规矩 ('显示格式跟后端一致: 卦 · 职责') 执行不下去的
//     唯一原因 —— ChatRoom / ProgressBar 渲染「卦 · 意象」, SubAgentPanel 渲染
//     「卦 · 职责」, 同一个将灵三种长相
//   · 前端 roster 还为它手抄了第二份 zhName ('坎·手指'), 又一个会漂的地方
// 砍掉之后只剩两层: gua (它是谁) + role (它干什么), 显示格式全局统一成
// 「卦 · 职责」, 跟 SubAgentPanel 早就写着的那条规矩对上。
for (const _r of GUA_ROLES) {
  _r.zh = `${_r.gua} · ${_r.role}`;
}

const GUA_CODES = Object.freeze(GUA_ROLES.map((r) => r.code));

// 拼音 / 卦名 → 卦条目 (一张表, 不再拆成 GUA_BY_PY + GUA_BY_GUA 两张同值表)
const GUA_BY_CODE = Object.freeze(
  GUA_ROLES.reduce((m, r) => { m[r.code] = r; m[r.gua] = r; return m; }, Object.create(null)));

// 只读角色。
// 这是安全边界, 不是偏好 —— analyzer/li 这类角色一旦能写盘, "只验不修"当场失效。
const READ_ONLY_CODES = Object.freeze(new Set(['li', 'xun', 'dui', 'zhen']));

/**
 * 把一个**站内**身份写法归一成拼音。认拼音和中文卦名 (大小写/空格容错)。
 * 不认: 空值、不知道的名字 → 返回 null (调用方据此拒, 不许猜)。
 * @param {*} input 拼音 / 中文卦名
 * @returns {string|null} 规范拼音名
 */
function resolveRole(input) {
  const k = String(input == null ? '' : input).trim().toLowerCase();
  if (!k) return null;
  const hit = GUA_BY_CODE[k];
  return hit ? hit.code : null;
}

// 2026-10-18 老板: 「说了全部换, 还留着干嘛」。
//
// 上一版这里还留着一张 LEGACY_INPUT (dispatcher→qian / planner→kan / analyzer→li …),
// 理由是「模型先验里全是英文, 入口得读得懂」。老板明确不接受, 删。
// 跟着一起删的还有 AGENT_NAME_TOKENS / parseAgentName / parseAgentToken ——
// 删掉英文之后它们跟 resolveRole 完全是同一个函数, 留着就是三个名字干一件事。
//
// 代价是模型再吐英文角色名会被判"未知角色"。这是**故意**的:
//   提示词教的就是拼音 (sub-agent.js 的 kan 提示词明写"只写上面这 6 个拼音"),
//   模型吐英文说明它没照做 —— 那是一个该被发现的错误, 而不是该被悄悄兜住的细节。
//   兜住的代价是: 身份表里永远躺着第二个名字, 而下一个照着它 grep 的人
//   又会抄出第三份。这就是「不统一就出错」的字面含义。
//
// 历史数据怎么办 (那才是真问题, 而且跟身份无关):
//   ~/.pangu/subagent-runs.jsonl 躺着 3963 行 2026-09-16 起的英文 code 记录。
//   那不是"第二套身份", 是**已经写下去的数据** —— 数据迁移必须知道旧名字长什么样,
//   否则就是把一个月的实跑记录静默清零。所以那张翻译表搬到了读那份文件的
//   subagent_runs.js 里, 局部、只读侧、且**不从这里导出**。
//   规矩: 本文件零英文。想要翻译旧数据的人自己去数据那一侧拿。

/**
 * 这个字符串能不能当"角色"派出去 —— **只认 8 将灵的规范拼音**。
 *
 * 为什么单独有这个"否定式"的判据 (2026-10-18): 仓库里到处是**按角色名索引**的东西
 * —— config/dispatch_rules.json 的键、config/tool_role_map.json 的键、registry、
 * 前端 roster。这些表里混着"不是角色"的东西:
 *   - `_meta` / `_comment` 这类下划线开头的元字段
 *   - **self_checker**: dispatch_rules.json 里的一个**关键词分组**, weight 1.5,
 *     「排查」「自查」「体检」全都命中它。后端从来没注册过这个角色。
 *
 * 一旦某个非将灵的名字被当成 role 发出去, 下游 `ROLES[role]` 恒为 undefined →
 * **空角色**: 子 agent 拿不到将灵提示词, 也拿不到工具白名单 → 只读边界当场失效,
 * 而日志只有一行"将灵上场", 看不出任何异常。
 *
 * 所以"这个键是不是角色"不能靠"表里有这个键"回答, 只能问是不是 8 将灵之一。
 * 放在这里是因为这是身份问题, 而身份真源只有这一个文件。
 */
function isGuaRole(input) {
  const k = String(input == null ? '' : input).trim();
  // 用 GUA_CODES 而不是 GUA_BY_CODE: 后者含卦名键 (乾/坎/...), 拿它判会把中文卦名
  // 也算成"规范角色"。这里的契约是"**只认规范拼音**" —— 卦名归 resolveRole /
  // parseAgentName 管, 派发出口只放拼音过。
  return GUA_CODES.includes(k);
}

/**
 * 是不是只读角色 —— 拼音 / 卦名都认, **认不出来的非空名字一律按只读处理**。
 *
 * 守卫必须用这个, 不能直接 `READ_ONLY_CODES.has(role)`: role 从模型、日志、配置、
 * 旧 checkpoint 各种地方流进来, 用哪种写法不由守卫决定。归一在这一处做。
 *
 * 为什么**认不出来要往严了判**, 而不是往松了判 (2026-10-18 实测):
 * checkRoleAction 的失败方向只有一个 —— checkRoleAction 对**非只读**角色返回 ok:true,
 * 也就是"不认识的角色"默认是**放行**的。而守卫以前靠"也认英文"兜住:
 * 守卫生效期间 checkRoleAction('analyzer','write_file') 返回 ok:true, 因为守卫查的是
 * 拼音集合、英文名恒不相等 —— 只读角色静默拿到写盘权, 不报错不留痕。
 *
 * 英文解析表删掉之后, 那个兜底没了。所以把失败方向**拧过来**: 认不出来的非空
 * 角色名按只读处理。空名字除外 —— 那是主循环 (`_roleForThisLoop = opts.role || 'main'`),
 * 本来就不该受将灵的只读边界约束。
 *
 * 认错一个名字 = 挡错一次调用 (owner 一看就知道, 有 reason 文案);
 * 认漏一个名字 = 只读角色静默拿到写盘权, **日志里什么都没有**。
 * 两个方向的代价差着量级, 所以宁可误伤, 不可漏放。
 *
 * 另一侧漏过一次: 第一版只认拼音+英文, `isReadOnlyRole('离')` 返回 false → 只读角色
 * 离拿到 write_file 直接放行。中文卦名在前端和提示词里到处都是 (「离·眼」),
 * 守卫不认它 = 一个真实的绕过面。
 */
// 元层角色: 不是将灵, 不受将灵只读边界约束。主循环传的就是它。
const NON_GUA_ROLES = Object.freeze(new Set(['main']));

function isReadOnlyRole(input) {
  const k = String(input == null ? '' : input).trim();
  if (!k) return false;                       // 没传角色 = 主循环, 不受限
  const canonical = resolveRole(k);           // 拼音 / 卦名 → 拼音
  if (canonical) return READ_ONLY_CODES.has(canonical);
  if (NON_GUA_ROLES.has(k.toLowerCase())) return false;
  // 认不出来的非空角色名 (旧 checkpoint / 磁盘历史 / 模型乱写): 按只读处理。
  return true;
}

module.exports = {
  GUA_ROLES, GUA_CODES, GUA_BY_CODE,
  READ_ONLY_CODES, NON_GUA_ROLES,
  resolveRole, isGuaRole, isReadOnlyRole,
};
