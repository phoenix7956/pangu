// 2026-10-12 (现场 probe-art3-2143): planner 拆任务时凭空编造"今天日期",
//   把错的日期写进 task 当权威指令传给 executor, executor 忠实执行并伪造字节级证据自证。
//   根因: 任何提示层都没告诉模型"现在是几号" —— 模型只能凭训练语料猜。
// 这里给出唯一真源: 进程时钟。所有需要事实锚点的角色提示都从这里取, 不各自 new Date。
// 设计要点: 时间是个"事实", 不是"指令" —— 所以只提供事实 + 明确"不许猜", 不代模型下结论。

const TZ = process.env.PANGU_TZ || 'Asia/Shanghai';

function _fmt(offsetMs) {
  const d = new Date(Date.now() + (offsetMs || 0));
  const parts = new Intl.DateTimeFormat('zh-CN', {
    timeZone: TZ,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false, weekday: 'long',
  }).formatToParts(d);
  const g = (t) => (parts.find(p => p.type === t) || {}).value || '';
  return {
    date: `${g('year')}-${g('month')}-${g('day')}`,
    time: `${g('hour')}:${g('minute')}:${g('second')}`,
    weekday: g('weekday'),
    iso: d.toISOString(),
    stamp: `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`,
    timestamp_ms: d.getTime(),
  };
}

// 2026-10-13 修: 原先是模块加载时冻结的 const —— 盘古是常驻服务, 跨天后
// 任何读 NOW 的人都会拿到"昨天", 而页面/提示看着完全正常(没有报错, 只是日期错了),
// 是最难查的一类静默错误。改成惰性 getter: 每次读都重算, 常驻进程也不会过期。
let _nowCache = null;
let _nowCacheDay = null;
function now() {
  const probe = new Date();
  const dayKey = probe.getTime() - (probe.getTime() % 60000); // 每分钟失效一次
  if (_nowCache === null || _nowCacheDay !== dayKey) {
    _nowCache = _fmt(0);
    _nowCacheDay = dayKey;
  }
  return _nowCache;
}

// 供提示层直接嵌入的文本块
function timeAnchorBlock() {
  const _n = now();
  return `【当前真实时间 — 唯一真源, 不许猜】\n现在: ${_n.date} ${_n.time} ${_n.weekday} (${TZ})\n`
    + `今天是 ${_n.date}。任何"今天/现在/当前"的判断一律以此为准, `
    + `**严禁凭记忆或训练语料编造日期、时间、时区**。拿不准就先调工具取真实时间。`;
}

// 供判重/逻辑使用的结构化值 (带偏移, 便于测昨天/明天这类相对日期)
function timeAnchor(offsetMs) { return _fmt(offsetMs || 0); }

module.exports = { timeAnchor, timeAnchorBlock, now, TZ, get NOW() { return now(); } };
