/**
 * stop_point.js —— 六格判局的**过程侧**出口
 *
 * 老板 2026-10-21 原话, 一字不改:
 *   「就拿八字排盘, 其实都是规律结合变化形成的生彼泻克耗, 但是这用在项目上,
 *     加强了停顿, 走一步判断一步, 而且挂永远没有100%」
 *
 * ## 这层补的是哪一半
 *
 * 六格判局 (`64i/bagua_annotations/task_judge.js`) 已经有**答案侧**入口:
 * 主人问「这事该继续还是该停」, 模型调 `wuxing_judge`, 拿到停点, 写进答复。
 * 但**过程侧**一直是空的 —— 盘古干一件长活时, 停点只存在于模型的记忆和措辞里,
 * `wuxing_judge` 判完就蒸发 (它是纯函数, 不落盘)。于是:
 *
 *   - 盘古在 auto-resume 里机械续跑, 判过「停」也照跑
 *   - 「走一步判断一步」退化成「走完一步再说」
 *
 * 所以这层做一件事: **把判过的停点落成进程可读的状态, 让续跑决策看得到它**。
 *
 * ## 分工纪律 (跟全项目一致)
 *
 *   `task_judge.js` 负责**判据** —— 分档、定性、给停点 (停 / 换向 / 续)。
 *   本模块负责**传递与作用域** —— 停点写哪儿、活多久、谁能读、过期了怎么办。
 *   续跑循环 (`j2_agent_loop._tryAutoResume`) 负责**用** —— 读停点决定续不续。
 *
 * 三者都不许自己重新判一遍。「停」这个字只有 `judgeTask` 有权写。
 *
 * ## 为什么必须落盘而不是留在 messages 里
 *
 * 续跑触发点 (`_tryAutoResume`) 是在**模型不接话的时候**跑的 ——
 * 模型甩了句「继续」就 break 了, 或者 maxRounds 到了, 或者 task_done 被拒。
 * 这一刻没有任何模型推理在跑, 只有进程里的变量和磁盘上的文件。
 * 要让「停」在那一刻还拦得住, 它就得在**模型之外**有个落点。
 *
 * ## 作用域: 绑当前请求, 不绑 session
 *
 * 这是本模块最要紧的一条, 而且是**被坑出来的**:
 * 停点若只按 sessionId 存, 老板在同一会话里换一件事问, 上一件事的「停」
 * 会把这一件事的续跑也一起按住 —— 陈旧停点挡住新任务, 比没有停点更坏
 * (它让盘古在该干活时不动, 而且不动得理直气壮)。
 *
 * 所以停点**同时绑 goal 指纹**:
 *   - 写入时记下当时的 goal (`goal_key`)
 *   - 读取时若当前 goal 与写入时不同 → 视为陈旧, **不生效**
 *
 * 指纹取 `goal` 前 200 字的 sha1。截断是因为 goal 本身在 checkpoint 里
 * 就只存 500 字, 而用户输入里的空白/标点抖动不该让指纹失效 ——
 * 指纹要抓的是「这是不是同一件事」, 不是「这串字符一模一样吗」。
 *
 * ## 不锁死用户
 *
 * 停点是**自动续跑**的闸门, 不是**用户**的闸门:
 *   - 自动续跑 (auto-resume) 读到「停」→ 不续跑, 把停点交给用户看
 *   - 用户手动说「继续」→ 新一轮请求, 停点因 goal 指纹不符而失效 → 照样能跑
 *
 * 老板要的是「加强停顿」, 不是「禁止继续」。盘古自己不往下冲, 但人推它一下它还得动。
 *
 * ## 三态的处置
 *
 *   stop      → 不自动续跑; 停点原文写进给用户的收口消息 (不是只进日志)
 *   redirect  → 续跑, 但注入的指令带上换向内容 (先解阻力, 别再堆料)
 *   continue  → 与停点不存在时**一字不差** —— 默认路径零影响
 *
 * 最后这条是硬要求。停点是加法, 不是减法: 没判过六格的长任务必须
 * 走得跟以前一模一样, 否则这层就是纯风险。
 */

'use strict';

const crypto = require('crypto');

/** checkpoint 里的字段名 —— 唯一真源, 读写都从这里取, 别在别处写字面量 */
const FIELD = 'stop_point';

/**
 * 三态 —— 与 task_judge.js 的 verdict 严格同名。
 * 刻意**不**在这里再定义一份判据, 只留档位名的白名单 (用来挡第四个值)。
 */
const VERDICTS = ['stop', 'redirect', 'continue'];

/**
 * 停点有效期 —— 跟「每轮清一次」的机制配套, 是**第二道**保险。
 *
 * 第一道是轮首清理 (轮 N 清 → 判 → 写 → 续跑决策读新鲜的)。
 * 第二道是这个时间戳: 万一某条路径漏了清理, 过期停点也自动失效。
 *
 * 取 30 分钟 —— 与 `task_checkpoint.shouldResumeTaskCheckpoint` 的
 * 「active 心跳窗口」对齐, 不是随手定的数字。
 */
const STOP_POINT_TTL_MS = parseInt(
  process.env.PANGU_STOP_POINT_TTL_MS || String(30 * 60 * 1000), 10);

function _sha1(s) {
  return crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 16);
}

/**
 * goal 指纹 —— 「这是不是同一件事」。
 * 空 goal 不参与指纹 (返回 null): 空 goal 时无法区分两件事, 那就不拿指纹说事,
 * 交给 TTL 与轮首清理兜底。
 */
function goalKey(goal) {
  const g = String(goal == null ? '' : goal).trim();
  if (!g) return null;
  return _sha1(g.slice(0, 200));
}

/**
 * 六格 → 停点摘要。只留判局要用的那几项, 不把整个 cells 塞进 checkpoint
 * (那是给模型看的原文, 落盘的是给续跑决策看的**结论**)。
 */
function _summarizeCells(cells) {
  if (!cells || typeof cells !== 'object') return {};
  const out = {};
  for (const [k, v] of Object.entries(cells)) {
    if (!v || typeof v !== 'object') continue;
    out[k] = {
      shuxing: v.shuxing,
      state: v.state,
      state_label: v.state_label,
      count: v.count,
    };
  }
  return out;
}

/**
 * 写停点。
 *
 * @param {string} sessionId
 * @param {object} judgment  judgeTask() 的返回值 (必须是 ok:true 的那份)
 * @param {string} goal      当前目标原文 —— 用来绑作用域
 * @returns {{ok:boolean, verdict?:string, error?:string, path?:string}}
 */
function writeStopPoint(sessionId, judgment, goal) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  if (!judgment || judgment.ok !== true) return { ok: false, error: 'NO_JUDGMENT' };
  const verdict = String(judgment.verdict || '');
  if (!VERDICTS.includes(verdict)) {
    return { ok: false, error: 'BAD_VERDICT:' + verdict };
  }
  try {
    const tc = require('./task_checkpoint');
    const r = tc.saveTaskCheckpoint(sessionId, {
      [FIELD]: {
        verdict,
        verdict_label: judgment.verdict_label || '',
        stop_reason: judgment.stop_reason || '',
        next_step: judgment.next_step || '',
        subject: judgment.subject || '',
        cells: _summarizeCells(judgment.cells),
        disclaimer: judgment.disclaimer || '',
        source: judgment.source || '',
        goal_key: goalKey(goal),
        at: Date.now(),
      },
    });
    if (!r.ok) return { ok: false, error: r.error || 'SAVE_FAILED' };
    return { ok: true, verdict, path: r.path };
  } catch (e) {
    // 写停点失败**不许**把整轮带崩 —— 判局已经给用户了, 落盘只是过程侧增强
    console.warn('[stop-point] write failed:', e.message);
    return { ok: false, error: e.message };
  }
}

/**
 * 读停点 —— 续跑决策的唯一入口。
 *
 * 返回 `{hit:false}` 的五种情形 (全部 = 行为零变化, 走默认路径):
 *   1. checkpoint 没有这个字段 (从没判过六格) —— 最常见
 *   2. 字段是 null (轮首清理过了)
 *   3. 字段结构不对 (别处写了垃圾) —— 不猜, 当没有
 *   4. 档位不在三态里
 *   5. 过期 (超 TTL) 或 goal 指纹不符 (陈旧停点)
 *
 * 返回 `{hit:true, ...}` 时 verdict 必是三态之一。
 *
 * @param {string} sessionId
 * @param {string} goal      当前目标原文 —— 与写入时比对
 */
function readStopPoint(sessionId, goal) {
  const miss = (why) => ({ hit: false, reason: why });
  if (!sessionId) return miss('NO_SESSION_ID');
  let cp;
  try {
    cp = require('./task_checkpoint').loadTaskCheckpoint(sessionId);
  } catch (e) {
    return miss('LOAD_FAILED');
  }
  if (!cp) return miss('NO_CHECKPOINT');
  const sp = cp[FIELD];
  if (sp === undefined || sp === null) return miss('ABSENT');
  if (typeof sp !== 'object' || Array.isArray(sp)) return miss('MALFORMED');
  const verdict = String(sp.verdict || '');
  if (!VERDICTS.includes(verdict)) return miss('BAD_VERDICT');
  // 第二道保险: 过期停点自动失效 (第一道是轮首清理)
  const at = Number(sp.at || 0);
  if (!at || (Date.now() - at) > STOP_POINT_TTL_MS) return miss('EXPIRED');
  // 作用域: 换了一件事 → 上一件事的停点不算数
  const curKey = goalKey(goal);
  if (sp.goal_key && curKey && sp.goal_key !== curKey) return miss('GOAL_CHANGED');
  return { hit: true, ...sp };
}

/**
 * 清停点。
 *
 * 挂在**轮首** (不是读的时候消费) —— 因为 `_tryAutoResume` 的六个调用点是
 * 顺序 if 而非 else-if, 同一轮可能连着调多个。「读一次就消费」会让
 * 第二个调用点看不到停点, 于是「停」被绕过去。所以改成:
 *
 *   轮 N 开头清 → 模型本轮判六格 → 写停点 → 轮末续跑决策读新鲜的
 *   轮 N+1 开头清 → 模型必须**重新判一次**才拦得住
 *
 * 这就是「走一步判断一步」的机制形态: 不是记住上一步的结论一直用,
 * 而是每一步都要重新看一眼。
 */
function clearStopPoint(sessionId) {
  if (!sessionId) return { ok: false, error: 'NO_SESSION_ID' };
  try {
    const tc = require('./task_checkpoint');
    // 注意: saveTaskCheckpoint 是 `{...prev, ...state}` 合并写,
    // 所以「清」必须显式写 null —— 不写这个 key 的话旧值会活下来。
    const r = tc.saveTaskCheckpoint(sessionId, { [FIELD]: null });
    return r.ok ? { ok: true } : { ok: false, error: r.error };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * 给续跑决策用的净结论 —— 只有真拦住续跑的那一档才有话说。
 *
 * `continue` 与 `hit:false` 都归成 `{stop:false}`: 对续跑循环而言
 * 「判了续」和「没判」是**同一件事** —— 都放行。用一个布尔把
 * 「什么时候该拦」收成一处, 免得六个调用点各写一遍三态判断而漏掉一档。
 *
 * @param {string} sessionId
 * @param {string} goal
 * @returns {{stop:boolean, verdict?:string, verdict_label?:string,
 *            stop_reason?:string, next_step?:string, miss?:string}}
 */
function consultForResume(sessionId, goal) {
  const sp = readStopPoint(sessionId, goal);
  if (!sp.hit) return { stop: false, miss: sp.reason };
  if (sp.verdict === 'stop') return { stop: true, ...sp };
  // redirect / continue: 放行。redirect 的换向内容由调用方从 sp 里取,
  // 这里不塞进返回值 —— 返回值只回答一个问题: 拦不拦。
  return { stop: false, ...sp };
}

// ============================================================
// 装时自检
// ============================================================

/**
 * 装时自检 —— 三条红线, 越界即抛。
 *
 * 这层的全部价值在于「判过的停点真能拦住续跑」。以下任一条被破坏,
 * 它就退化成一段没人看的注释 (项目铁律: 注释 ≠ 隔离):
 *
 *   ① 三态与 task_judge 的 verdict 严格同名 —— 若 task_judge 改了档位名而
 *      这里没跟, `readStopPoint` 会把真停点当 BAD_VERDICT 丢掉, 闸门静默失效。
 *      所以这里**去跑一遍** task_judge 的真源取样验证, 而不是抄一份字符串。
 *   ② 三条自检样本要走齐三档 —— 若 task_judge 的停点规则改了导致某档走不到,
 *      说明档位映射要重新核, 而不是默默继续。
 *   ③ TTL 必须是正数 —— 零或负数会让所有停点当场过期, 闸门恒失效。
 */
function _assertStopPointLayer() {
  const problems = [];

  try {
    const tj = require('../64i/bagua_annotations/task_judge.js');
    if (typeof tj.judgeTask !== 'function') {
      problems.push('task_judge.judgeTask 不是函数 —— 六格判局入口没了');
    } else {
      // 取样: 三条各走出一档的输入, 验证档位名没漂
      const samples = [
        { subject: '自检-停', resources: [], outputs: ['x'], blockers: [], targets: [] },
        { subject: '自检-换向', resources: ['r1'], outputs: [], blockers: ['b1', 'b2', 'b3'], targets: ['t1'] },
        { subject: '自检-续', resources: ['r1'], outputs: ['o1'], blockers: [], targets: ['t1'] },
      ];
      const seen = new Set();
      for (const s of samples) {
        const r = tj.judgeTask(s);
        if (r && r.ok && r.verdict) seen.add(r.verdict);
      }
      for (const v of seen) {
        if (!VERDICTS.includes(v)) {
          problems.push('task_judge 产出了本模块不认识的档位: ' + v);
        }
      }
      if (seen.size < 3) {
        problems.push('三条自检样本没能走齐三态 (只走到 ' + seen.size + ' 档) —— '
          + 'task_judge 的停点规则可能变了, 本模块的档位映射要跟着核');
      }
    }
  } catch (e) {
    problems.push('取 task_judge 真源失败: ' + e.message);
  }

  if (VERDICTS.length !== 3) {
    problems.push('三态应恰为 stop/redirect/continue, 实为 ' + VERDICTS.length + ' 个');
  }
  if (!Number.isFinite(STOP_POINT_TTL_MS) || STOP_POINT_TTL_MS <= 0) {
    problems.push('TTL 必须为正数, 实为 ' + STOP_POINT_TTL_MS);
  }

  if (problems.length) {
    throw new Error('[stop-point] 装时自检失败:\n  - ' + problems.join('\n  - '));
  }
}

_assertStopPointLayer();

module.exports = {
  FIELD,
  VERDICTS,
  STOP_POINT_TTL_MS,
  goalKey,
  writeStopPoint,
  readStopPoint,
  clearStopPoint,
  consultForResume,
};
