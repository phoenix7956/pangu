'use strict';

// PANGU_MODEL —— 用环境变量定盘古的认知模型 (2026-10-26 立)
//
// 背景: 盘古跑哪个模型, 原来只有一个入口 —— 改配置文件里的 llm.current_model_id。
//   部署时这很难受: 同一套代码要按机器换模型, 只能改文件 + 重启; 而
//   「改了没重启」在盘古身上有前科 (2026-10-25 踩坑日志: 改完代码记得重启服务 ——
//   复验跑的是旧码, 白跑一整轮)。
//   环境变量是这里最自然的旋钮: launchd 的 EnvironmentVariables 里本来就有一排
//   PANGU_* (PANGU_SILENT_FAIL_FALLBACK / PANGU_ROUTER_DEMOTE / PANGU_ROUND_TIMEOUT_MS …),
//   PANGU_MODEL 跟它们是同一路数。
//
// 名字别搞混:
//   PANGU_MODEL       = 模型 id (本文件管的)
//   PANGU_MODELS_PATH = router 的 models.json 文件路径 (smart_router / pangu_helpers 管)
//   两个名字长得像, 但一个是「用哪个模型」, 一个是「模型清单在哪」。
//
// 口径 (单一真源, 不搞第二套):
//   PANGU_MODEL  >  配置文件 llm.current_model_id  >  enabled+priority 兜底
//
// 三条铁律 (每条都对应一个真踩过的坑):
//
//   ① 查不到就是查不到 —— PANGU_MODEL 指向池里没有 / 被停用的模型时,
//      不许悄悄退化成「enabled 第一个」再照跑。那是 2026-10-14 踩过的坑:
//      配的模型不在池里 → 静默跑成另一个模型 → 云端付费端点, 全程零提示。
//      这里的选择是启动就报错: 盘古宁可起不来, 也不能用另一个模型装没事。
//
//   ② 不落盘 —— PANGU_MODEL 是运行时的钉子, 不是配置改写。把它写回
//      your-mac.json 会让「撤销钉子」变成「手改文件」, 钉子的语义就丢了。
//      所以落盘时保留文件自己的选择 (见 pangu_helpers.saveConfig)。
//
//   ③ 偏离要出声 —— 运行时切模型 (主人点 UI) 会临时盖掉钉子, 那是主人的
//      显式动作, 允许; 但每次偏离都要在日志里说清楚, 不许闷掉。

const ENV_KEY = 'PANGU_MODEL';

// 进程内的钉子状态。applyEnvOverride 在启动时写一次, 之后只读。
// _pin = { id: '模型id', at: 时间戳 }
let _pin = null;

function readEnvModelId(env = process.env) {
  const raw = env ? env[ENV_KEY] : undefined;
  if (raw == null) return null;
  const id = String(raw).trim();
  // 空串 = 没设。plist / launchctl 里写个空值不该让盘古起不来。
  return id ? id : null;
}

function _pool(cfg) {
  return (cfg && cfg.llm && Array.isArray(cfg.llm.models)) ? cfg.llm.models : [];
}

// 只列可用的 (enabled !== false) —— 与运行时选模型的判据完全一致
// (pangu_helpers._isModelUsable 就是这一条)。口径不许两套。
function usableIds(cfg) {
  return _pool(cfg).filter(m => m && m.id != null && m.enabled !== false).map(m => String(m.id));
}

/**
 * 解析 PANGU_MODEL。纯函数, 不改任何东西。
 * @returns {{requested:string|null, ok:boolean, id:string|null, reason:string, available:string[]}}
 *   reason: 'unset' | 'ok' | 'no_pool' | 'not_in_pool' | 'disabled'
 */
function resolveEnvModel(cfg, env = process.env) {
  const requested = readEnvModelId(env);
  const available = usableIds(cfg);
  if (!requested) {
    return { requested: null, ok: false, id: null, reason: 'unset', available };
  }
  const models = _pool(cfg);
  if (!models.length) {
    return { requested, ok: false, id: null, reason: 'no_pool', available };
  }
  const hit = models.find(m => m && String(m.id) === requested);
  if (!hit) {
    return { requested, ok: false, id: null, reason: 'not_in_pool', available };
  }
  if (hit.enabled === false) {
    return { requested, ok: false, id: null, reason: 'disabled', available };
  }
  return { requested, ok: true, id: requested, reason: 'ok', available, model: hit };
}

/**
 * 把 PANGU_MODEL 应用到配置上 (改 llm.current_model_id —— 单一真源, 不另开一路)。
 * 失败时不动 current_model_id: 宁可保持原样并报错, 也不悄悄换一个模型。
 * @returns {{applied:boolean, requested:string|null, ok:boolean, id:string|null, reason:string, available:string[]}}
 */
function applyEnvOverride(cfg, env = process.env) {
  const r = resolveEnvModel(cfg, env);
  if (!r.ok) {
    // 钉不上就没有钉子 —— 别留一个指向空气的 pin。
    _pin = null;
    return {
      applied: false, requested: r.requested, ok: false,
      id: null, reason: r.reason, available: r.available,
    };
  }
  if (!cfg.llm) cfg.llm = {};
  cfg.llm.current_model_id = r.id;
  _pin = { id: r.id, at: Date.now() };
  return {
    applied: true, requested: r.requested, ok: true,
    id: r.id, reason: 'ok', available: r.available,
  };
}

function getPin() {
  return _pin ? { ..._pin } : null;
}

function isPinned() {
  return !!_pin;
}

// 测试用: 把钉子状态清干净, 免得一个用例的钉子影响下一个用例。
function resetPin() {
  _pin = null;
}

// 偏离播报 (铁律 ③)
// 运行时切模型盖掉了钉子 —— 这是主人的显式动作, 允许, 但必须出声。
// 同一次偏离只喊一遍 (换个模型喊一次, 不然每次存配置都刷一遍)。
let _lastWarnedDeviation = null;

function noteRuntimeDeviation(currentId) {
  const pin = _pin;
  if (!pin) return false;
  const cur = currentId == null ? null : String(currentId);
  if (cur === pin.id) {
    _lastWarnedDeviation = null;
    return false;
  }
  if (_lastWarnedDeviation === cur) return false;
  _lastWarnedDeviation = cur;
  console.warn(
    '[model-env] 运行时切模型盖掉了 PANGU_MODEL=' + pin.id
    + ' (现在跑的是 ' + (cur || '(无)') + ') —— 下次启动会回到 ' + pin.id
  );
  return true;
}

// 人类可读的失败原因 —— 报错要能直接告诉主人「怎么改」。
function describeFailure(rep) {
  if (!rep || !rep.requested) return null;
  const avail = (rep.available && rep.available.length)
    ? rep.available.join(' / ')
    : '(池子里一个可用的模型都没有)';
  switch (rep.reason) {
    case 'not_in_pool':
      return 'PANGU_MODEL=' + rep.requested + ' —— 池子里没有这个 id。'
        + '当前可用: ' + avail + '。要么先把这个模型加进模型池, 要么改 PANGU_MODEL。';
    case 'disabled':
      return 'PANGU_MODEL=' + rep.requested + ' —— 这个模型在池子里但 enabled=false。'
        + '当前可用: ' + avail + '。要么启用它, 要么改 PANGU_MODEL。';
    case 'no_pool':
      return 'PANGU_MODEL=' + rep.requested + ' —— 模型池是空的, 没法解析这个 id。';
    default:
      return 'PANGU_MODEL=' + rep.requested + ' 不可用 (原因: ' + rep.reason + ')。';
  }
}

module.exports = {
  ENV_KEY,
  readEnvModelId,
  usableIds,
  resolveEnvModel,
  applyEnvOverride,
  getPin,
  isPinned,
  resetPin,
  noteRuntimeDeviation,
  describeFailure,
};
