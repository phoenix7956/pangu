'use strict';
/**
 * _gua_roles.js —— 8 将灵身份真源 → 提示词片段 (第 97 批从 tools_schema.js 抽出)
 *
 * 2026-10-18: 下面 plan_create 的 agent 字段描述原来**手抄**了一份角色清单, 而且抄的
 * 是上一代英文 code。这段字符串会进 LLM 提示词, 所以它不是注释 —— 它是教模型输出
 * 一套运行时永远丢弃的名字 ("模型明明选对了, 却判成 null 退回关键词兜底"的同源坑)。
 * 手抄的清单迟早跟真源漂移, 所以从真源生成。
 *
 * require 写在函数体内: tools_schema 是叶子模块, 被几乎所有模块 require。
 * 顶层 require gua-identity 会在它跟 gua-identity 互相引用时成环, 那种依赖在 Node 里
 * 半边是 undefined —— 跟 action_policy 当年不能 require sub-agent 是同一个理由。
 */
function _GUA_ROLE_PROMPT() {
  try {
    const {GUA_ROLES} = require('../../agents/gua-identity');
    return GUA_ROLES.map((r) => `${r.code}(${r.gua}${r.role})`);
  } catch (_) {
    return ['qian(乾调度)', 'kan(坎拆)', 'gen(艮记)', 'zhen(震复盘)',
            'xun(巽找雷)', 'li(离读)', 'kun(坤做)', 'dui(兑验)'];
  }
}

module.exports = { _GUA_ROLE_PROMPT };
