/**
 * 五行分类模块
 *
 * 根据用户输入判断任务属于木火土金水哪种五行：
 * - 木（wood）：生发、创造、规划、计划、未来、创业
 * - 火（fire）：速度、爆发、分析、文案、热、燃烧
 * - 土（earth）：存储、信任、沉淀、历史、保存、记录
 * - 金（metal）：变革、收敛、清除、决断、更新、删除
 * - 水（water）：流动、智慧、适应、渗透、学习、变化
 */

'use strict';

const WUXING_KEYWORDS = {
  木: ['规划', '计划', '创建', '安排', '未来', '创业', '布局', '战略', '设计', '草拟', '构思', '策划'],
  火: ['分析', '快速', '立即', '爆发', '燃烧', '热', '上涨', '飙升', '热点', '涨停', '文案的', '写'],
  土: ['保存', '记录', '历史', '沉淀', '信任', '档案', '存储', '积累', '存起来', '记下来', '整理'],
  金: ['改变', '更新', '删除', '清理', '决断', '变革', '换', '改', '止损', '止盈', '卖出', '清仓'],
  水: ['学习', '流动', '适应', '变化', '渗透', '研究', '了解', '看看', '怎么样', '如何', '问', '查询']
};

const WUXING_DESC = {
  木: { name: '木', element: '木', nature: '生发', direction: '东', season: '春' },
  火: { name: '火', element: '火', nature: '爆发', direction: '南', season: '夏' },
  土: { name: '土', element: '土', nature: '承载', direction: '中', season: '长夏' },
  金: { name: '金', element: '金', nature: '收敛', direction: '西', season: '秋' },
  水: { name: '水', element: '水', nature: '流动', direction: '北', season: '冬' }
};

/**
 * 五行分类核心函数
 * @param {string} input - 用户输入
 * @returns {object} - { wuxing, score, desc, allScores }
 */
function classify(input) {
  const lower = input.toLowerCase();
  const scores = { 木: 0, 火: 0, 土: 0, 金: 0, 水: 0 };

  Object.entries(WUXING_KEYWORDS).forEach(([wuxing, keywords]) => {
    keywords.forEach(k => {
      if (lower.includes(k)) scores[wuxing]++;
    });
  });

  // 找最高分
  const sorted = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const top = sorted[0];

  if (top[1] === 0) {
    // 无匹配，按内容猜测
    if (/买|建仓|入场/.test(input)) return { wuxing: '木', score: 0.5, desc: WUXING_DESC['木'] };
    if (/卖|止损|清仓/.test(input)) return { wuxing: '金', score: 0.5, desc: WUXING_DESC['金'] };
    if (/分析|研究|判断/.test(input)) return { wuxing: '火', score: 0.5, desc: WUXING_DESC['火'] };
    return { wuxing: '水', score: 0.5, desc: WUXING_DESC['水'] };
  }

  return {
    wuxing: top[0],
    score: Math.min(top[1] / 3, 1.0),
    desc: WUXING_DESC[top[0]],
    allScores: scores
  };
}

module.exports = { classify, WUXING_KEYWORDS, WUXING_DESC };