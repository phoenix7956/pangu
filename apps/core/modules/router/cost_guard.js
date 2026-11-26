'use strict';

// R42 Cost Guard — 月预算追踪 + 超限降级
// 月切换自动复位, 不阻塞 call, 只 warn

const fs = require('fs');
const path = require('path');
const os = require('os');

const COST_DIR = process.env.PANGU_COST_DIR || path.join(os.homedir(), '.pangu-data', 'router');
const COST_FILE = path.join(COST_DIR, 'cost-log.json');
// 成本字段判定单一真源 (2026-10-16)
const _modelCost = require('./model_cost');

function ensureDir() {
  try { fs.mkdirSync(COST_DIR, { recursive: true }); } catch (_) {}
}

function loadCostLog() {
  ensureDir();
  try {
    if (!fs.existsSync(COST_FILE)) return { month: currentMonth(), spent_usd: 0, calls: [] };
    const log = JSON.parse(fs.readFileSync(COST_FILE, 'utf8'));
    if (log.month !== currentMonth()) return { month: currentMonth(), spent_usd: 0, calls: [] };
    return log;
  } catch (_) {
    return { month: currentMonth(), spent_usd: 0, calls: [] };
  }
}

function saveCostLog(log) {
  ensureDir();
  try {
    fs.writeFileSync(COST_FILE, JSON.stringify(log, null, 2));
  } catch (e) {
    console.warn('[cost-guard] save failed:', e.message);
  }
}

function currentMonth() {
  return new Date().toISOString().slice(0, 7);
}

function recordSpend(modelConfig, tokensIn, tokensOut) {
  const log = loadCostLog();
  // 2026-10-16: 原来是 `(cost || 0)` —— 配置里没填价时算出 0, 于是每一次调用都记成
  // "花了 0 美元"。实测池里 8 个模型 cost 字段全是 0 (含 minimax-m3 / k3 / agnes 这些
  // 真计费的云端), 所以 spent_usd 恒为 0, **预算墙从来没有响过**, 而 checkBudget 报出来的
  // 还是一句斩钉截铁的 "spent: 0" —— 它不是没花钱, 是它不知道花了多少。
  // 现在: 配了价照算; 没配价就**记下来这次算不准**, 不再假装是 0。
  // 注意: 本地模型没配价是正常的 (本地不按 token 计费), 所以单独归一类, 不算漏配。
  const _mc = _modelCost.modelCost(modelConfig);
  const costKnown = _mc.known;
  const cost = costKnown ? (tokensIn / 1000) * (Number(modelConfig.cost_per_1k_input) || 0)
    + (tokensOut / 1000) * (Number(modelConfig.cost_per_1k_output) || 0) : 0;

  const month = currentMonth();
  if (log.month !== month) {
    log.month = month;
    log.spent_usd = 0;
    log.calls = [];
  }

  log.spent_usd = (log.spent_usd || 0) + cost;
  log.calls.push({
    ts: Date.now(),
    model: modelConfig.id,
    tokensIn: tokensIn || 0,
    tokensOut: tokensOut || 0,
    cost,
    // 这条要留痕: cost=0 有两种完全不同的含义 —— "本地不花钱" 和 "云端漏配了价"
    cost_known: costKnown,
    ...(costKnown ? {} : { cost_unknown_reason: _mc.reason }),
  });

  if (log.calls.length > 10000) log.calls = log.calls.slice(-5000);
  saveCostLog(log);
  return log.spent_usd;
}

function checkBudget(threshold = 0.9) {
  const log = loadCostLog();
  const budget = parseFloat(process.env.MONTHLY_BUDGET_USD || '5');
  const ratio = budget > 0 ? log.spent_usd / budget : 0;
  const calls = Array.isArray(log.calls) ? log.calls : [];
  const unpriced = calls.filter(c => c && c.cost_known === false).length;
  const unpricedCloud = calls.filter(c => c && c.cost_known === false
    && c.cost_unknown_reason === 'cloud-price-missing').length;
  return {
    spent: log.spent_usd,
    budget,
    ratio,
    over_threshold: ratio >= threshold,
    month: log.month,
    // 预算墙的自陈: 有多少笔账算不准。其中 unpriced_cloud 才是真漏配 (云端模型没填价),
    // 本地模型不计费是正常的, 不算在里面。
    unpriced_calls: unpriced,
    unpriced_cloud_calls: unpricedCloud,
    // spent 是不是一个能当真的数字。false 时 ratio/over_threshold 不可信 ——
    // 上层要报"账算不准", 而不是报"本月只花了 0 美元"。
    cost_accounting_trustworthy: unpricedCloud === 0,
  };
}

module.exports = { recordSpend, checkBudget, loadCostLog };
