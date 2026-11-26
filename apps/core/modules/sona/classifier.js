'use strict';

// R40 SONA Theme Classifier — 本地 hash, 不调 LLM (避免递归依赖)
// spec §阶段 3 红线: themeHint 必须快 + 不依赖网络

const THEMES = {
  case_response: ['被告', '原告', '上诉', '应诉', '答辩', '案号', '管辖', '诉讼', '判决', '反诉', '证据', '庭审', 'lawyer'],
  code_review: ['PR', 'review', 'diff', 'commit', 'func', 'class', 'code', 'bug', 'refactor', '写代码', '修复', '改', '重构'],
  architecture: ['架构', '设计', '图', 'RPC', 'API', 'gateway', 'system', '拓扑', '部署', '模块'],
  marketing: ['老板', '营销', '增长', '心智', '品牌', 'ROI', '投放', '用户', '转化'],
  bug_investigate: ['bug', '报错', 'failed', 'error', 'crash', 'panic', 'exception', '500', '404', 'timeout', '失败', '异常'],
  data_query: ['schema', 'table', 'sql', 'query', 'fetch', 'count', 'select', '查', '统计', '导出'],
};

function normalize(text) {
  return String(text || '').toLowerCase().replace(/[,。、\s]+/g, ' ').trim();
}

function themeHint(text) {
  const norm = normalize(text);
  if (!norm) return 'general';
  let bestTheme = 'general';
  let bestScore = 0;
  for (const [theme, keywords] of Object.entries(THEMES)) {
    let score = 0;
    for (const kw of keywords) {
      const kwLower = kw.toLowerCase();
      if (norm.includes(kwLower)) {
        score += kwLower.length > 2 ? 1 : 0.5;
        try {
          const re = new RegExp(`\\b${kwLower.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`);
          if (re.test(norm)) score += 0.3;
        } catch (_) {}
      }
    }
    if (score > bestScore) { bestScore = score; bestTheme = theme; }
  }
  return bestScore > 0 ? bestTheme : 'general';
}

module.exports = { themeHint, normalize, THEMES };
