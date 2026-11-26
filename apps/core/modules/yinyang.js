/**
 * 阴阳判势模块
 *
 * 判断用户输入的阴阳属性：
 * - 阳（yang）：主动、进攻、索取、急迫（要/立刻/干/买/卖/做/执行）
 * - 阴（yin）：被动、沉稳、给予、缓释（想/了解/看看/等/问/能否）
 * - 中（neutral）：分析、平衡
 *
 * 对应响应策略：
 * - 阳刚（force）：直接给答案，高确定性
 * - 阴柔（gentle）：引导式，分步骤
 * - 中正（balanced）：分析为主，正反两面
 * - 玄览（mysterious）：启示式，不给答案给方向
 */

'use strict';

const YANG_INDICATORS = [
  // 语气急迫
  '立刻', '马上', '赶紧', '立即', '现在', '快', '赶紧的',
  // 动作词
  '买', '卖', '干', '做', '执行', '下单', '建仓', '平仓', '止损', '止盈',
  '入场', '离场', '加仓', '减仓', '清仓', '追', '抢', '押', '全押',
  // 态度强硬
  '要', '必须', '一定', '给我', '给我弄', '直接', '就买', '就卖', '开干',
  '搞', '整', '弄', '搞进去', '打', '冲', '满上'
];

const YIN_INDICATORS = [
  // 缓释词
  '慢慢', '等', '先看看', '考虑一下', '想一下', '不急', '再说', '观望',
  // 疑问词
  '能不能', '会不会', '要不要', '可以吗', '是不是', '为什么', '会不会涨',
  '能不能买', '要不要卖', '是不是该', '该不该', '可不可以',
  // 了解意图
  '了解', '看看', '研究', '分析', '判断', '感觉', '好像', '似乎', '大概',
  '估', '预计', '预测', '估计', '推测',
  // 过去/将来时
  '以前', '以前会', '以后', '将来', '曾经', '过往',
  // 询问/征询
  '问', '咨询', '请教', '请问', '打听', '查询'
];

const NEUTRAL_INDICATORS = [
  '分析', '研究', '判断', '对比', '评估', '为什么', '怎么回事',
  '有什么区别', '哪个好', '如何', '怎么样', '什么区别',
  '对比', '比较', '权衡', '利弊', '优缺点', '差距',
  '怎么看', '如何看', '哪种更好', '哪个更强'
];

// Response strategy mapping
const STRATEGY_MAP = {
  yang: 'force',
  yin: 'gentle',
  neutral: 'balanced'
};

/**
 * 判断输入文本的阴阳属性及响应策略
 * @param {string} input - 用户输入文本
 * @returns {{ type: string, intensity: number, strategy: string, yangScore: number, yinScore: number }}
 */
function judge(input) {
  if (!input || typeof input !== 'string') {
    return {
      type: 'neutral',
      intensity: 0,
      strategy: 'balanced',
      yangScore: 0,
      yinScore: 0
    };
  }

  const lower = input.toLowerCase();

  let yangScore = 0;
  let yinScore = 0;

  YANG_INDICATORS.forEach(k => {
    if (lower.includes(k)) yangScore++;
  });

  YIN_INDICATORS.forEach(k => {
    if (lower.includes(k)) yinScore++;
  });

  let type, intensity, strategy;

  if (yangScore > yinScore) {
    type = 'yang';
    intensity = Math.min(yangScore / 3, 1.0);
    strategy = 'force';
  } else if (yinScore > yangScore) {
    type = 'yin';
    intensity = Math.min(yinScore / 3, 1.0);
    strategy = yinScore > 2 ? 'gentle' : 'balanced';
  } else {
    // 检查是否含中性分析词
    const hasNeutral = NEUTRAL_INDICATORS.some(k => lower.includes(k));
    type = hasNeutral ? 'neutral' : 'yang'; // 无明显倾向默认为阳（主动）
    intensity = 0.5;
    strategy = hasNeutral ? 'balanced' : 'force';
  }

  return {
    type,
    intensity,
    strategy,
    yangScore,
    yinScore
  };
}

module.exports = { judge, YANG_INDICATORS, YIN_INDICATORS, STRATEGY_MAP };