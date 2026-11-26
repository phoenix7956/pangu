/**
 * Pangu · 64i Layer
 * symbol_table.js - 64卦通用本体映射
 *
 * 架构：
 * ┌─────────────────────────────────────────────┐
 * │  LAYER 1: HEXAGRAM_ONTOLOGY（通用本体）        │
 * │  64卦 → 64种基本存在状态（不变，永远正确）       │
 * │  刚/柔/动/静/明/暗/升/降/聚/散/...            │
 * ├─────────────────────────────────────────────┤
 * │  LAYER 2: DOMAIN_ADAPTERS（领域适配器）        │
 * │  通用状态 → 具体领域信号（可配置，可扩展）        │
 * │  stock_market / team / writing / health ...   │
 * ├─────────────────────────────────────────────┤
 * │  LAYER 3: 应用层（encoder/decoder使用适配器）   │
 * └─────────────────────────────────────────────┘
 *
 * 所有领域共用同一套 64 卦本体，任何领域都可以扩展
 */

'use strict';

// ============================================================
// LAYER 1: 通用本体映射（64卦 → 基本存在状态）
// ============================================================

/**
 * 64卦的通用本体义
 * 不绑定任何具体领域，只定义最底层的存在状态
 */
const HEXAGRAM_ONTOLOGY = {
  // ---- 上卦: 乾(☰) 宫 ----
  // 1: 乾 - 纯阳，刚健创造
  1: {
    name: '乾', symbol: '☰',
    essence: '刚健',       // 根本属性
    polarity: '阳',
    trigram: '☰', trigram_name: '乾',
    nature: '创造、领导、进取、纯粹',
    yin_yang: '纯阳',
    // 通用状态向量（用于向量化检索）
    vector: {
      energy: 1.0,    // 能量级别
      direction: 'up',  // 方向：up/down/stable
      stability: 1.0,  // 稳定性
      adaptability: 0.0, // 适应性
    },
    keywords: ['刚健', '创造', '领导', '进取', '纯粹', '顶点', '完美'],
  },

  // 44: 姤 - 柔遇刚，机遇与风险并存
  44: {
    name: '姤', symbol: '姤',
    essence: '相遇', polarity: '阴',
    trigram: '☴', trigram_name: '巽',
    nature: '相遇、邂逅、小人、柔遇刚',
    yin_yang: '阴承阳',
    vector: { energy: 0.5, direction: 'up', stability: 0.3, adaptability: 0.8 },
    keywords: ['相遇', '机遇', '风险', '小人', '柔遇刚', '警觉'],
  },

  // 33: 遯 - 退避，明智选择
  33: {
    name: '遯', symbol: '遯',
    essence: '退避', polarity: '阴',
    trigram: '☶', trigram_name: '艮',
    nature: '退避、隐忍、明智、待机',
    yin_yang: '阴主阳从',
    vector: { energy: 0.3, direction: 'down', stability: 0.7, adaptability: 0.2 },
    keywords: ['退避', '隐忍', '明智', '待机', '保守', '离开'],
  },

  // 6: 讼 - 争讼，冲突与秩序
  6: {
    name: '讼', symbol: '讼',
    essence: '争讼', polarity: '阴',
    trigram: '☵', trigram_name: '坎',
    nature: '争讼、冲突、秩序、契约',
    yin_yang: '阴从阳变',
    vector: { energy: 0.4, direction: 'stable', stability: 0.2, adaptability: 0.6 },
    keywords: ['争讼', '冲突', '秩序', '契约', '争议', '裁决'],
  },

  // 13: 同人 - 和同众人
  13: {
    name: '同人', symbol: '同人',
    essence: '和同', polarity: '阳',
    trigram: '☲', trigram_name: '离',
    nature: '和同、聚合、光明、君子',
    yin_yang: '阳主阴从',
    vector: { energy: 0.7, direction: 'up', stability: 0.6, adaptability: 0.9 },
    keywords: ['和同', '聚合', '光明', '君子', '协作', '共鸣'],
  },

  // 25: 无妄 - 无妄而得
  25: {
    name: '无妄', symbol: '无妄',
    essence: '正道', polarity: '阳',
    trigram: '☳', trigram_name: '震',
    nature: '无妄、正道、行动、天雷',
    yin_yang: '阳动阴顺',
    vector: { energy: 0.8, direction: 'up', stability: 0.5, adaptability: 0.4 },
    keywords: ['无妄', '正道', '行动', '天雷', '诚实', '意外收获'],
  },

  // ---- 上卦: 坤(☷) 宫 ----
  // 2: 坤 - 纯阴，柔顺承载
  2: {
    name: '坤', symbol: '☷',
    essence: '柔顺', polarity: '阴',
    trigram: '☷', trigram_name: '坤',
    nature: '柔顺、承载、收藏、厚重',
    yin_yang: '纯阴',
    vector: { energy: 1.0, direction: 'down', stability: 1.0, adaptability: 0.0 },
    keywords: ['柔顺', '承载', '收藏', '厚重', '包容', '终焉'],
  },

  // 23: 剥 - 剥落，群阴消阳
  23: {
    name: '剥', symbol: '剥',
    essence: '剥落', polarity: '阴',
    trigram: '☶', trigram_name: '艮',
    nature: '剥落、侵蚀、虚弱、崩塌',
    yin_yang: '纯阴',
    vector: { energy: 0.2, direction: 'down', stability: 0.1, adaptability: 0.3 },
    keywords: ['剥落', '侵蚀', '虚弱', '崩塌', '损失', '退潮'],
  },

  // ---- 上卦: 震(☳) 宫 ----
  51: {
    name: '震', symbol: '☳',
    essence: '震动', polarity: '阳',
    trigram: '☳', trigram_name: '震',
    nature: '震动、行动、起始、惊雷',
    yin_yang: '阳动',
    vector: { energy: 0.9, direction: 'up', stability: 0.2, adaptability: 0.5 },
    keywords: ['震动', '行动', '起始', '惊雷', '突发', '唤醒'],
  },

  // 16: 豫 - 豫悦安乐
  16: {
    name: '豫', symbol: '豫',
    essence: '豫悦', polarity: '阴',
    trigram: '☳', trigram_name: '震',
    nature: '豫悦、安乐、跟随、准备',
    yin_yang: '阴从阳动',
    vector: { energy: 0.5, direction: 'up', stability: 0.4, adaptability: 0.8 },
    keywords: ['豫悦', '安乐', '跟随', '准备', '乐观', '松懈'],
  },

  // ---- 上卦: 坎(☵) 宫 ----
  29: {
    name: '坎', symbol: '☵',
    essence: '险陷', polarity: '阳',
    trigram: '☵', trigram_name: '坎',
    nature: '险陷、周期、等待、困境',
    yin_yang: '阳陷阴中',
    vector: { energy: 0.3, direction: 'stable', stability: 0.6, adaptability: 0.7 },
    keywords: ['险陷', '周期', '等待', '困境', '陷阱', '耐性'],
  },

  // 60: 节 - 节制，约束
  60: {
    name: '节', symbol: '节',
    essence: '节制', polarity: '阳',
    trigram: '☵', trigram_name: '坎',
    nature: '节制、约束、规则、限度',
    yin_yang: '阳主阴从',
    vector: { energy: 0.4, direction: 'stable', stability: 0.8, adaptability: 0.3 },
    keywords: ['节制', '约束', '规则', '限度', '自律', '节俭'],
  },

  // ---- 上卦: 艮(☶) 宫 ----
  52: {
    name: '艮', symbol: '☶',
    essence: '静止', polarity: '阳',
    trigram: '☶', trigram_name: '艮',
    nature: '静止、阻碍、终了、坚守',
    yin_yang: '阳止阴进',
    vector: { energy: 0.2, direction: 'stable', stability: 1.0, adaptability: 0.1 },
    keywords: ['静止', '阻碍', '终了', '坚守', '专注', '顽固'],
  },

  // 22: 贲 - 文饰美化
  22: {
    name: '贲', symbol: '贲',
    essence: '文饰', polarity: '阴',
    trigram: '☲', trigram_name: '离',
    nature: '文饰、装饰、礼仪、文华',
    yin_yang: '阴美阳守',
    vector: { energy: 0.4, direction: 'stable', stability: 0.5, adaptability: 0.6 },
    keywords: ['文饰', '装饰', '礼仪', '文华', '美观', '外表'],
  },

  // ---- 上卦: 巽(☴) 宫 ----
  57: {
    name: '巽', symbol: '☴',
    essence: '渗入', polarity: '阴',
    trigram: '☴', trigram_name: '巽',
    nature: '渗入、渐变、柔性、长养',
    yin_yang: '阴长阳消',
    vector: { energy: 0.3, direction: 'down', stability: 0.4, adaptability: 1.0 },
    keywords: ['渗入', '渐变', '柔性', '长养', '渗透', '潜移默化'],
  },

  // 37: 家人 - 家庭和合
  37: {
    name: '家人', symbol: '家人',
    essence: '和合', polarity: '阴',
    trigram: '☲', trigram_name: '离',
    nature: '家庭、和合、秩序、温暖',
    yin_yang: '阴丽阳中',
    vector: { energy: 0.6, direction: 'stable', stability: 0.7, adaptability: 0.5 },
    keywords: ['家庭', '和合', '秩序', '温暖', '内务', '规矩'],
  },

  // ---- 上卦: 离(☲) 宫 ----
  30: {
    name: '离', symbol: '☲',
    essence: '光明', polarity: '阳',
    trigram: '☲', trigram_name: '离',
    nature: '光明、显现、依附、文明',
    yin_yang: '阳丽阴附',
    vector: { energy: 0.8, direction: 'up', stability: 0.6, adaptability: 0.7 },
    keywords: ['光明', '显现', '依附', '文明', '智慧', '外露'],
  },

  // 14: 大有 - 大有收获
  14: {
    name: '大有', symbol: '大有',
    essence: '收获', polarity: '阳',
    trigram: '☰', trigram_name: '乾',
    nature: '收获、富足、太阳、拥有',
    yin_yang: '阳尊阴柔',
    vector: { energy: 0.9, direction: 'up', stability: 0.8, adaptability: 0.5 },
    keywords: ['收获', '富足', '太阳', '拥有', '充实', '繁荣'],
  },

  // 26: 大畜 - 大畜待发
  26: {
    name: '大畜', symbol: '大畜',
    essence: '蓄聚', polarity: '阳',
    trigram: '☶', trigram_name: '艮',
    nature: '蓄聚、积累、止健、储备',
    yin_yang: '阳止阴养',
    vector: { energy: 0.7, direction: 'stable', stability: 0.9, adaptability: 0.3 },
    keywords: ['蓄聚', '积累', '储备', '止健', '蓄势', '厚积薄发'],
  },

  // ---- 上卦: 兑(☱) 宫 ----
  58: {
    name: '兑', symbol: '☱',
    essence: '喜悦', polarity: '阴',
    trigram: '☱', trigram_name: '兑',
    nature: '喜悦、决断、交换、言说',
    yin_yang: '阴悦阳决',
    vector: { energy: 0.6, direction: 'up', stability: 0.4, adaptability: 0.8 },
    keywords: ['喜悦', '决断', '交换', '言说', '说服', '谈判'],
  },

  43: {
    name: '夬', symbol: '夬',
    essence: '决断', polarity: '阳',
    trigram: '☱', trigram_name: '兑',
    nature: '决断、刚决、清除、公布',
    yin_yang: '阳决阴散',
    vector: { energy: 0.9, direction: 'up', stability: 0.3, adaptability: 0.4 },
    keywords: ['决断', '刚决', '清除', '公布', '决裂', '独立'],
  },

  // ============================================================
  // 以下为自动补全的44卦（基于先天序+五行推算）
  // ============================================================

  // 3: 屯 - 万物始生，艰难创业
  3: {
    name: '屯', symbol: '☵☳',
    essence: '初生', polarity: '阳',
    trigram: '☵', trigram_name: '坎',
    nature: '初生、艰难、积累、萌芽',
    yin_yang: '阳陷阴承',
    vector: { energy: 0.4, direction: 'up', stability: 0.5, adaptability: 0.6 },
    keywords: ['初生', '艰难', '创业', '萌芽', '积累', '奠基'],
  },

  // 4: 蒙 - 蒙昧幼稚，教育启发
  4: {
    name: '蒙', symbol: '☶☲',
    essence: '蒙昧', polarity: '阴',
    trigram: '☶', trigram_name: '艮',
    nature: '蒙昧、幼稚、教育、启发',
    yin_yang: '阴止阳发',
    vector: { energy: 0.3, direction: 'stable', stability: 0.3, adaptability: 0.8 },
    keywords: ['蒙昧', '幼稚', '教育', '启发', '无知', '求知'],
  },

  // 5: 需 - 等待需求，蓄势待发
  5: {
    name: '需', symbol: '☰☵',
    essence: '等待', polarity: '阳',
    trigram: '☰', trigram_name: '乾',
    nature: '等待、需求、蓄势、耐心',
    yin_yang: '阳刚阴柔',
    vector: { energy: 0.5, direction: 'stable', stability: 0.6, adaptability: 0.5 },
    keywords: ['等待', '需求', '蓄势', '耐心', '饮食', '谋望'],
  },

  // 7: 师 - 军队组织，纪律领导
  7: {
    name: '师', symbol: '☷☵',
    essence: '统帅', polarity: '阴',
    trigram: '☷', trigram_name: '坤',
    nature: '统帅、纪律、组织、领导',
    yin_yang: '阴柔阳刚',
    vector: { energy: 0.5, direction: 'down', stability: 0.4, adaptability: 0.5 },
    keywords: ['军队', '纪律', '领导', '征战', '组织', '统帅'],
  },

  // 8: 比 - 比邻亲附，协作联盟
  8: {
    name: '比', symbol: '☵☷',
    essence: '亲附', polarity: '阴',
    trigram: '☵', trigram_name: '坎',
    nature: '亲附、协作、联盟、亲近',
    yin_yang: '阴从阳比',
    vector: { energy: 0.5, direction: 'down', stability: 0.5, adaptability: 0.7 },
    keywords: ['比邻', '亲附', '协作', '联盟', '亲近', '服从'],
  },

  // 9: 小畜 - 小的蓄积，积累准备
  9: {
    name: '小畜', symbol: '☴☰',
    essence: '积累', polarity: '阴',
    trigram: '☴', trigram_name: '巽',
    nature: '积累、储蓄、准备、小成',
    yin_yang: '阴承阳畜',
    vector: { energy: 0.4, direction: 'up', stability: 0.7, adaptability: 0.4 },
    keywords: ['积累', '储蓄', '小畜', '准备', '蓄养', '小成'],
  },

  // 10: 履 - 履行实践，礼仪秩序
  10: {
    name: '履', symbol: '☱☰',
    essence: '履行', polarity: '阳',
    trigram: '☱', trigram_name: '兑',
    nature: '履行、实践、礼仪、秩序',
    yin_yang: '阳刚阴悦',
    vector: { energy: 0.5, direction: 'stable', stability: 0.5, adaptability: 0.6 },
    keywords: ['履行', '实践', '礼仪', '秩序', '合规', '谨慎'],
  },

  // 11: 泰 - 天地交泰，通畅顺达
  11: {
    name: '泰', symbol: '☷☰',
    essence: '通泰', polarity: '阳',
    trigram: '☷', trigram_name: '坤',
    nature: '通泰、顺畅、亨通、协调',
    yin_yang: '阳交阴',
    vector: { energy: 0.6, direction: 'up', stability: 0.6, adaptability: 0.6 },
    keywords: ['通泰', '顺畅', '亨通', '协调', '吉祥', '交流'],
  },

  // 12: 否 - 天地不交，闭塞阻碍
  12: {
    name: '否', symbol: '☰☷',
    essence: '闭塞', polarity: '阴',
    trigram: '☰', trigram_name: '乾',
    nature: '闭塞、阻碍、否塞、背离',
    yin_yang: '阴隔阳',
    vector: { energy: 0.3, direction: 'down', stability: 0.4, adaptability: 0.4 },
    keywords: ['闭塞', '阻碍', '否塞', '背离', '不通', '分离'],
  },

  // 15: 谦 - 谦逊低调，蓄德待发
  15: {
    name: '谦', symbol: '☶☷',
    essence: '谦逊', polarity: '阴',
    trigram: '☶', trigram_name: '艮',
    nature: '谦逊、低调、退让、蓄德',
    yin_yang: '阴止阳发',
    vector: { energy: 0.4, direction: 'stable', stability: 0.8, adaptability: 0.3 },
    keywords: ['谦逊', '低调', '退让', '蓄德', '礼仪', '美德'],
  },

  // 17: 随 - 随从变通，以变为常
  17: {
    name: '随', symbol: '☳☱',
    essence: '随从', polarity: '阳',
    trigram: '☳', trigram_name: '震',
    nature: '随从、变通、创新、跟随',
    yin_yang: '阳动阴悦',
    vector: { energy: 0.6, direction: 'up', stability: 0.4, adaptability: 0.8 },
    keywords: ['随从', '变通', '创新', '跟随', '灵活', '随机应变'],
  },

  // 18: 蛊 - 腐败治理，拨乱反正
  18: {
    name: '蛊', symbol: '☴☶',
    essence: '整饬', polarity: '阴',
    trigram: '☴', trigram_name: '巽',
    nature: '腐败、整饬、治理、改革',
    yin_yang: '阴长阳消',
    vector: { energy: 0.4, direction: 'stable', stability: 0.5, adaptability: 0.5 },
    keywords: ['腐败', '整饬', '治理', '改革', '除弊', '整顿'],
  },

  // 19: 临 - 临在督导，接近指导
  19: {
    name: '临', symbol: '☷☳',
    essence: '督导', polarity: '阳',
    trigram: '☷', trigram_name: '坤',
    nature: '督导、接近、指导、监视',
    yin_yang: '阳临阴顺',
    vector: { energy: 0.6, direction: 'up', stability: 0.5, adaptability: 0.6 },
    keywords: ['督导', '接近', '指导', '监视', '临在', '关怀'],
  },

  // 20: 观 - 观察审视，静观待变
  20: {
    name: '观', symbol: '☴☷',
    essence: '观察', polarity: '阴',
    trigram: '☴', trigram_name: '巽',
    nature: '观察、审视、静观、等待',
    yin_yang: '阴观阳示',
    vector: { energy: 0.3, direction: 'stable', stability: 0.4, adaptability: 0.7 },
    keywords: ['观察', '审视', '静观', '等待', '示现', '警示'],
  },

  // 21: 噬嗑 - 咬合冲突，依法裁决
  21: {
    name: '噬嗑', symbol: '☲☳',
    essence: '裁决', polarity: '阳',
    trigram: '☲', trigram_name: '离',
    nature: '咬合、冲突、裁决、法制',
    yin_yang: '阳明阴动',
    vector: { energy: 0.6, direction: 'up', stability: 0.4, adaptability: 0.5 },
    keywords: ['咬合', '冲突', '裁决', '法制', '断狱', '强制'],
  },

  // 22: 贲 - 文饰美化，礼仪外表
  22: {
    name: '贲', symbol: '☶☲',
    essence: '文饰', polarity: '阴',
    trigram: '☶', trigram_name: '艮',
    nature: '文饰、装饰、礼仪、美化',
    yin_yang: '阴美阳止',
    vector: { energy: 0.4, direction: 'stable', stability: 0.5, adaptability: 0.6 },
    keywords: ['文饰', '装饰', '礼仪', '美化', '外表', '典礼'],
  },

  // 24: 复 - 回复复苏，一元复始
  24: {
    name: '复', symbol: '☷☳',
    essence: '回复', polarity: '阴',
    trigram: '☷', trigram_name: '坤',
    nature: '回复、复苏、重启、回归',
    yin_yang: '阴承阳动',
    vector: { energy: 0.3, direction: 'up', stability: 0.3, adaptability: 0.7 },
    keywords: ['回复', '复苏', '重启', '回归', '复始', '更新'],
  },

  // 27: 颐 - 颐养养育，食养生命
  27: {
    name: '颐', symbol: '☳☶',
    essence: '颐养', polarity: '阳',
    trigram: '☳', trigram_name: '震',
    nature: '颐养、养育、保护、食养',
    yin_yang: '阳动阴养',
    vector: { energy: 0.6, direction: 'stable', stability: 0.6, adaptability: 0.4 },
    keywords: ['颐养', '养育', '保护', '食养', '自养', '养生'],
  },

  // 28: 大过 - 太过异常，大变将至
  28: {
    name: '大过', symbol: '☱☴',
    essence: '太过', polarity: '阴',
    trigram: '☱', trigram_name: '兑',
    nature: '太过、异常、过度、破常规',
    yin_yang: '阴悦阳覆',
    vector: { energy: 0.4, direction: 'stable', stability: 0.3, adaptability: 0.7 },
    keywords: ['太过', '异常', '过度', '破常规', '大变革', '危机'],
  },

  // 31: 咸 - 感应交心，主动吸引
  31: {
    name: '咸', symbol: '☶☱',
    essence: '感应', polarity: '阴',
    trigram: '☶', trigram_name: '艮',
    nature: '感应、交心、吸引、恋爱',
    yin_yang: '阴止阳悦',
    vector: { energy: 0.5, direction: 'stable', stability: 0.6, adaptability: 0.5 },
    keywords: ['感应', '交心', '吸引', '恋爱', '情感', '心动'],
  },

  // 32: 恒 - 恒久持久，坚持常态
  32: {
    name: '恒', symbol: '☴☳',
    essence: '恒久', polarity: '阳',
    trigram: '☴', trigram_name: '巽',
    nature: '恒久、持久、坚持、常态',
    yin_yang: '阳刚阴柔',
    vector: { energy: 0.5, direction: 'stable', stability: 0.7, adaptability: 0.4 },
    keywords: ['恒久', '持久', '坚持', '常态', '稳定', '永恒'],
  },

  // 34: 大壮 - 壮大强壮，强势自信
  34: {
    name: '大壮', symbol: '☳☰',
    essence: '壮大', polarity: '阳',
    trigram: '☳', trigram_name: '震',
    nature: '壮大、强壮、强势、自信',
    yin_yang: '阳动刚健',
    vector: { energy: 0.8, direction: 'up', stability: 0.6, adaptability: 0.3 },
    keywords: ['壮大', '强壮', '强势', '自信', '膨胀', '力量'],
  },

  // 35: 晋 - 晋升前进，积极发展
  35: {
    name: '晋', symbol: '☲☷',
    essence: '晋升', polarity: '阴',
    trigram: '☲', trigram_name: '离',
    nature: '晋升、前进、发展、积极',
    yin_yang: '阴丽阳进',
    vector: { energy: 0.7, direction: 'up', stability: 0.4, adaptability: 0.6 },
    keywords: ['晋升', '前进', '发展', '积极', '日出', '光明'],
  },

  // 36: 明夷 - 明入地中，明伤隐藏
  36: {
    name: '明夷', symbol: '☷☲',
    essence: '明伤', polarity: '阴',
    trigram: '☷', trigram_name: '坤',
    nature: '明伤、隐藏、伤痛、逆境',
    yin_yang: '阴覆阳明',
    vector: { energy: 0.3, direction: 'down', stability: 0.3, adaptability: 0.6 },
    keywords: ['明伤', '隐藏', '伤痛', '逆境', '日落', '韬光'],
  },

  // 38: 睚 - 违和冲突，差异对立
  38: {
    name: '睚', symbol: '☱☲',
    essence: '违和', polarity: '阴',
    trigram: '☱', trigram_name: '兑',
    nature: '违和、冲突、差异、对立',
    yin_yang: '阴悦阳丽',
    vector: { energy: 0.4, direction: 'stable', stability: 0.4, adaptability: 0.7 },
    keywords: ['违和', '冲突', '差异', '对立', '细末', '分歧'],
  },

  // 39: 蹇 - 蹇难险阻，停止阻碍
  39: {
    name: '蹇', symbol: '☶☵',
    essence: '蹇难', polarity: '阳',
    trigram: '☶', trigram_name: '艮',
    nature: '蹇难、险阻、停止、阻碍',
    yin_yang: '阳止阴陷',
    vector: { energy: 0.3, direction: 'stable', stability: 0.5, adaptability: 0.4 },
    keywords: ['蹇难', '险阻', '停止', '阻碍', '困境', '不前'],
  },

  // 40: 解 - 解除分散，缓解灾难
  40: {
    name: '解', symbol: '☵☳',
    essence: '解除', polarity: '阴',
    trigram: '☵', trigram_name: '坎',
    nature: '解除、分散、缓解、解决',
    yin_yang: '阴陷阳动',
    vector: { energy: 0.5, direction: 'up', stability: 0.4, adaptability: 0.7 },
    keywords: ['解除', '分散', '缓解', '解决', '雷雨', '雨过天晴'],
  },

  // 41: 损 - 减少损失，节俭克制
  41: {
    name: '损', symbol: '☶☱',
    essence: '减少', polarity: '阴',
    trigram: '☶', trigram_name: '艮',
    nature: '减少、损失、节俭、克制',
    yin_yang: '阴减阳增',
    vector: { energy: 0.4, direction: 'down', stability: 0.6, adaptability: 0.5 },
    keywords: ['减少', '损失', '节俭', '克制', '自律', '修身'],
  },

  // 42: 益 - 增加收益，利义兼得
  42: {
    name: '益', symbol: '☳☴',
    essence: '增加', polarity: '阳',
    trigram: '☳', trigram_name: '震',
    nature: '增加、收益、利益、增长',
    yin_yang: '阳增阴受',
    vector: { energy: 0.6, direction: 'up', stability: 0.5, adaptability: 0.6 },
    keywords: ['增加', '收益', '利益', '增长', '利他', '增益'],
  },

  // 45: 萃 - 聚集汇合，团结整合
  45: {
    name: '萃', symbol: '☱☷',
    essence: '聚集', polarity: '阴',
    trigram: '☱', trigram_name: '兑',
    nature: '聚集、汇合、团结、整合',
    yin_yang: '阴聚阳散',
    vector: { energy: 0.5, direction: 'up', stability: 0.5, adaptability: 0.6 },
    keywords: ['聚集', '汇合', '团结', '整合', '荟萃', '沼泽'],
  },

  // 46: 升 - 上升发展，突破进取
  46: {
    name: '升', symbol: '☴☷',
    essence: '上升', polarity: '阴',
    trigram: '☴', trigram_name: '巽',
    nature: '上升、发展、突破、进取',
    yin_yang: '阴随阳升',
    vector: { energy: 0.5, direction: 'up', stability: 0.5, adaptability: 0.6 },
    keywords: ['上升', '发展', '突破', '进取', '生长', '木在地中'],
  },

  // 47: 困 - 围困贫乏，资源匮乏
  47: {
    name: '困', symbol: '☵☱',
    essence: '围困', polarity: '阴',
    trigram: '☵', trigram_name: '坎',
    nature: '围困、束缚、贫乏、艰难',
    yin_yang: '阴陷阳悦',
    vector: { energy: 0.3, direction: 'stable', stability: 0.3, adaptability: 0.5 },
    keywords: ['围困', '束缚', '贫乏', '艰难', '资源匮乏', '困境'],
  },

  // 48: 井 - 汲取水源，探索资源
  48: {
    name: '井', symbol: '☴☵',
    essence: '汲取', polarity: '阳',
    trigram: '☴', trigram_name: '巽',
    nature: '汲取、水源、资源、探索',
    yin_yang: '阴入阳出',
    vector: { energy: 0.5, direction: 'stable', stability: 0.6, adaptability: 0.5 },
    keywords: ['汲取', '水源', '资源', '探索', '井养', '恒定'],
  },

  // 49: 革 - 变革创新，破旧立新
  49: {
    name: '革', symbol: '☲☱',
    essence: '变革', polarity: '阳',
    trigram: '☲', trigram_name: '离',
    nature: '变革、革新、破旧、更新',
    yin_yang: '阳丽阴悦',
    vector: { energy: 0.7, direction: 'up', stability: 0.5, adaptability: 0.6 },
    keywords: ['变革', '革新', '破旧', '更新', '改革', '去旧'],
  },

  // 50: 鼎 - 烹饪冶炼，育成成就
  50: {
    name: '鼎', symbol: '☲☴',
    essence: '育成', polarity: '阳',
    trigram: '☲', trigram_name: '离',
    nature: '烹饪、冶炼、育成、成就',
    yin_yang: '阳丽阴入',
    vector: { energy: 0.7, direction: 'up', stability: 0.7, adaptability: 0.4 },
    keywords: ['烹饪', '冶炼', '育成', '成就', '权柄', '稳定'],
  },

  // 53: 渐 - 循序渐进，次序发展
  53: {
    name: '渐', symbol: '☴☶',
    essence: '渐进', polarity: '阴',
    trigram: '☴', trigram_name: '巽',
    nature: '渐进、次序、步骤、流程',
    yin_yang: '阴入阳止',
    vector: { energy: 0.4, direction: 'stable', stability: 0.6, adaptability: 0.5 },
    keywords: ['渐进', '次序', '步骤', '流程', '循序渐进', '嫁娶'],
  },

  // 54: 归妹 - 归宿归属，嫁娶回归
  54: {
    name: '归妹', symbol: '☱☳',
    essence: '归宿', polarity: '阴',
    trigram: '☱', trigram_name: '兑',
    nature: '归宿、归属、嫁娶、回归',
    yin_yang: '阴悦阳动',
    vector: { energy: 0.4, direction: 'stable', stability: 0.4, adaptability: 0.7 },
    keywords: ['归宿', '归属', '嫁娶', '回归', '女归', '期待'],
  },

  // 55: 丰 - 丰富盛大，丰收繁荣
  55: {
    name: '丰', symbol: '☲☳',
    essence: '丰富', polarity: '阳',
    trigram: '☲', trigram_name: '离',
    nature: '丰富、盛大、丰收、繁荣',
    yin_yang: '阳丽阴动',
    vector: { energy: 0.8, direction: 'up', stability: 0.5, adaptability: 0.5 },
    keywords: ['丰富', '盛大', '丰收', '繁荣', '日食', '盛大光明'],
  },

  // 56: 旅 - 旅行漂泊，不定探索
  56: {
    name: '旅', symbol: '☶☲',
    essence: '旅行', polarity: '阴',
    trigram: '☶', trigram_name: '艮',
    nature: '旅行、漂泊、不定、探索',
    yin_yang: '阴止阳丽',
    vector: { energy: 0.4, direction: 'stable', stability: 0.4, adaptability: 0.7 },
    keywords: ['旅行', '漂泊', '不定', '探索', '旅馆', '羁旅'],
  },

  // 59: 涣 - 涣散离散，扩散传播
  59: {
    name: '涣', symbol: '☴☵',
    essence: '涣散', polarity: '阴',
    trigram: '☴', trigram_name: '巽',
    nature: '涣散、离散、扩散、传播',
    yin_yang: '阴入阳散',
    vector: { energy: 0.3, direction: 'stable', stability: 0.4, adaptability: 0.8 },
    keywords: ['涣散', '离散', '扩散', '传播', '风行水上', '散而远'],
  },

  // 61: 中孚 - 诚信忠信，信任约定
  61: {
    name: '中孚', symbol: '☴☱',
    essence: '诚信', polarity: '阴',
    trigram: '☴', trigram_name: '巽',
    nature: '诚信、信任、约定、守信',
    yin_yang: '阴心中实',
    vector: { energy: 0.5, direction: 'stable', stability: 0.7, adaptability: 0.4 },
    keywords: ['诚信', '信任', '约定', '守信', '中空', '信及豚鱼'],
  },

  // 62: 小过 - 小有过失，矫枉过正
  62: {
    name: '小过', symbol: '☶☳',
    essence: '小过', polarity: '阳',
    trigram: '☶', trigram_name: '艮',
    nature: '小过、偏差、过度、修正',
    yin_yang: '阳止阴动',
    vector: { energy: 0.4, direction: 'stable', stability: 0.4, adaptability: 0.6 },
    keywords: ['小过', '偏差', '过度', '修正', '飞鸟遗音', '小事可行'],
  },

  // 63: 既济 - 既定成就，完成圆满
  63: {
    name: '既济', symbol: '☲☵',
    essence: '完成', polarity: '阴',
    trigram: '☲', trigram_name: '离',
    nature: '完成、成功、终结、圆满',
    yin_yang: '阳丽阴险',
    vector: { energy: 0.7, direction: 'stable', stability: 0.7, adaptability: 0.3 },
    keywords: ['完成', '成功', '终结', '圆满', '水火既济', '万事亨通'],
  },

  // 64: 未济 - 未竟之业，继续探索
  64: {
    name: '未济', symbol: '☵☲',
    essence: '未完成', polarity: '阳',
    trigram: '☵', trigram_name: '坎',
    nature: '未完成、过渡、探索、继续',
    yin_yang: '阳陷阴丽',
    vector: { energy: 0.4, direction: 'up', stability: 0.4, adaptability: 0.8 },
    keywords: ['未完成', '过渡', '探索', '继续', '火水未济', '未知前路'],
  },
};

// ============================================================
// 身份字段: 一律从 hexagrams.js 真源挂上来, 本表一个字都不手抄
// ============================================================
//
// 2026-10-23 第 50 批实测(逐条对 64/64, 数字全部从表算):
//   `name`        与真表不一致 **2** 条(33 遯≠遁, 38 睚≠睽 —— 异体字)
//   `trigram_name`≠真表上卦 **29** 条; 其中 37 条等于**下卦**
//                 ⇒ 这个字段**没有一致的定义**(有的按上卦、有的按下卦、有的都不是)
//   `symbol`      **0** 条是卦符; 44 条塞两个八卦符、20 条塞卦名
//                 ⇒ 而 hexagrams.js 的 `symbol` 就是卦符(U+4DC0+id-1)
//                 **同名字段, 两层两义** —— 这正是「同一样东西两套编号/两套口径」
//                 那类坑的温床。
//
// 为什么敢直接改: 本表**零生产调用者**(台账 symbol_table 条目已记:
//   "modules/ 零引用; skill_runtime.autoRegisterTools 里是 `void symbolTable`")。
//   skill_runtime 的两个消费者 resolveToolByGua / autoRegisterTools
//   已在 P1-5 退役成no-op。⇒ 改它不会动任何生产输出。
//
// 为什么还要改: 表是术数知识, 错的就是错的(第 33 批处理 najia 的同一条道理)。
//   而且**留着比修掉更坏** —— 下一个人拿它当真源, 会把 29 条错的带上卦讲出去。
//
// 手抄的字段(essence/nature/keywords/vector/yin_yang)保持原样:
//   那些是**盘古自己的归纳**, 不是典籍原话, 台账按 interpretive 记着。
//   本块只接管**身份**(卦名/卦符/上下卦), 身份只有一个答案, 答案在真源里。
const { HEXAGRAMS: _HEXAGRAMS } = require('./hexagrams');

const _HEX_BY_ID = new Map(_HEXAGRAMS.map((h) => [h.id, h]));

for (const [idKey, entry] of Object.entries(HEXAGRAM_ONTOLOGY)) {
  const src = _HEX_BY_ID.get(Number(idKey));
  if (!src) continue;                    // 真表没有的 id ⇒ 原样留着(该报红, 由测试抓)
  entry.name = src.name;                                        // 卦名(文王序用字)
  entry.symbol = src.symbol;                                    // 卦符 U+4DC0+id-1
  entry.trigram = src.trigrams.upper;                           // 上卦卦符
  entry.trigram_name = src.trigrams.upper_name;                 // 上卦名
  entry.lower_trigram = src.trigrams.lower;                     // 下卦卦符(新增, 原来混在 symbol 里)
  entry.lower_trigram_name = src.trigrams.lower_name;           // 下卦名
}

// ============================================================
// LAYER 2: 领域适配器（通用状态 → 具体领域信号）
// ============================================================

/**
 * 领域适配器
 * 每个领域定义自己的信号映射规则
 * 可以新增任何领域，只需实现 DOMAIN_ADAPTER 接口
 */
const DOMAIN_ADAPTERS = {

  // ===== 通用适配器（所有领域共享的底层逻辑）=====
  _common: {
    // 通用的极值状态
    EXTREME_HIGH: { hexagrams: [1, 30], essence: '刚健顶点', polarity: '阳极' },
    EXTREME_LOW: { hexagrams: [2, 23], essence: '柔顺极底', polarity: '阴极' },
    STABLE: { hexagrams: [52, 60], essence: '静止稳定', polarity: '止' },
    ACTIVE: { hexagrams: [51, 16], essence: '震动活跃', polarity: '动' },
    TRANSITION: { hexagrams: [57, 37], essence: '渐变过渡', polarity: '化' },
  },

  // ===== 股市适配器 =====
  stock_market: {
    name: '股票市场',
    signalSpace: {
      // 方向信号
      TREND_UP: { hexagrams: [1, 14, 26, 30], essence: '刚健上升', domain: 'direction' },
      TREND_DOWN: { hexagrams: [2, 23, 33], essence: '柔顺下降', domain: 'direction' },
      TREND_STABLE: { hexagrams: [52, 60], essence: '静止横盘', domain: 'direction' },
      TREND_VOLATILE: { hexagrams: [6, 44, 16], essence: '争讼波动', domain: 'direction' },

      // 能量/动力信号
      ENERGY_HIGH: { hexagrams: [1, 51, 43], essence: '能量充沛', domain: 'energy' },
      ENERGY_LOW: { hexagrams: [2, 23, 52], essence: '能量衰竭', domain: 'energy' },
      ENERGY_BUILDING: { hexagrams: [26, 57], essence: '蓄势积累', domain: 'energy' },

      // 市场情绪
      SENTIMENT_POSITIVE: { hexagrams: [14, 30, 58], essence: '乐观喜悦', domain: 'sentiment' },
      SENTIMENT_NEGATIVE: { hexagrams: [6, 23, 33], essence: '悲观忧虑', domain: 'sentiment' },
      SENTIMENT_FEAR: { hexagrams: [51, 25], essence: '恐慌震动', domain: 'sentiment' },

      // 机会与风险
      OPPORTUNITY: { hexagrams: [14, 44, 25], essence: '机遇出现', domain: 'opportunity' },
      RISK_HIGH: { hexagrams: [6, 23, 43], essence: '高风险', domain: 'risk' },
      RISK_CONSOLIDATION: { hexagrams: [52, 26], essence: '风险消化', domain: 'risk' },

      // 决策信号
      ACTION_BUY: { hexagrams: [14, 26, 1], essence: '买入信号', domain: 'action' },
      ACTION_SELL: { hexagrams: [43, 23, 33], essence: '卖出信号', domain: 'action' },
      ACTION_WAIT: { hexagrams: [52, 29, 57], essence: '观望等待', domain: 'action' },
    },
  },

  // ===== 团队管理适配器 =====
  team_management: {
    name: '团队管理',
    signalSpace: {
      LEADERSHIP_STRONG: { hexagrams: [1, 43], essence: '强势领导', domain: 'leadership' },
      LEADERSHIP_WEAK: { hexagrams: [2, 52], essence: '领导力弱', domain: 'leadership' },
      TEAM_HARMONY: { hexagrams: [37, 14, 58], essence: '团队和谐', domain: 'team' },
      TEAM_CONFLICT: { hexagrams: [6, 23], essence: '团队冲突', domain: 'team' },
      TEAM_GROWTH: { hexagrams: [51, 26, 57], essence: '团队成长', domain: 'team' },
      TEAM_STABLE: { hexagrams: [52, 60], essence: '团队稳定', domain: 'team' },
      DECISION_ACTION: { hexagrams: [1, 43], essence: '果断决策', domain: 'decision' },
      DECISION_WAIT: { hexagrams: [29, 33, 57], essence: '谨慎决策', domain: 'decision' },
    },
  },

  // ===== 内容创作适配器 =====
  content_creation: {
    name: '内容创作',
    signalSpace: {
      STYLE_DIRECT: { hexagrams: [1, 43], essence: '直抒胸臆', domain: 'style' },
      STYLE_INDIRECT: { hexagrams: [2, 22, 37], essence: '委婉含蓄', domain: 'style' },
      STYLE_METAPHOR: { hexagrams: [29, 57, 52], essence: '托物言志', domain: 'style' },
      TONE_POSITIVE: { hexagrams: [14, 30, 58], essence: '积极乐观', domain: 'tone' },
      TONE_NEGATIVE: { hexagrams: [23, 2], essence: '消极悲观', domain: 'tone' },
      TONE_MYSTERY: { hexagrams: [6, 29, 44], essence: '悬疑神秘', domain: 'tone' },
      CREATIVITY_HIGH: { hexagrams: [1, 51, 30], essence: '创意充沛', domain: 'creativity' },
      CREATIVITY_LOW: { hexagrams: [2, 52], essence: '创意枯竭', domain: 'creativity' },
    },
  },

  // ===== 决策分析适配器（通用决策框架）=====
  decision_analysis: {
    name: '决策分析',
    signalSpace: {
      DECISION_STRONG_YES: { hexagrams: [1, 14, 43], essence: '强烈肯定', domain: 'decision' },
      DECISION_STRONG_NO: { hexagrams: [2, 23, 33], essence: '强烈否定', domain: 'decision' },
      DECISION_CONDITIONAL: { hexagrams: [57, 26, 60], essence: '有条件肯定', domain: 'decision' },
      DECISION_UNCERTAIN: { hexagrams: [6, 29, 44], essence: '不确定', domain: 'decision' },
      RISK_HIGH: { hexagrams: [6, 23], essence: '高风险决策', domain: 'risk' },
      RISK_LOW: { hexagrams: [14, 26, 60], essence: '低风险决策', domain: 'risk' },
      OPPORTUNITY_LARGE: { hexagrams: [14, 1, 30], essence: '大机会', domain: 'opportunity' },
      OPPORTUNITY_SMALL: { hexagrams: [37, 57, 22], essence: '小机会', domain: 'opportunity' },
    },
  },

  // ===== 健康适配器 =====
  health: {
    name: '健康管理',
    signalSpace: {
      ENERGY_HIGH: { hexagrams: [1, 30], essence: '阳气充足', domain: 'energy' },
      ENERGY_LOW: { hexagrams: [2, 29], essence: '阳气不足', domain: 'energy' },
      BALANCE: { hexagrams: [14, 26, 37], essence: '阴阳平衡', domain: 'balance' },
      IMBALANCE: { hexagrams: [23, 6], essence: '阴阳失衡', domain: 'balance' },
      RECOVERY: { hexagrams: [57, 37, 51], essence: '恢复期', domain: 'state' },
      DETERIORATION: { hexagrams: [23, 33], essence: '恶化期', domain: 'state' },
    },
  },

  // ===== 技能执行适配器（pangu64core Agent 工具层）=====
  // 将卦象语义映射为可执行工具的信号空间
  skill_execution: {
    name: 'pangu64core技能执行',
    description: '将64卦的语义信号映射为具体工具调用',
    signalSpace: {
      // ---- 乾宫（启动/授权/系统控制）----
      SYS_START: { hexagrams: [1], essence: '启动系统', domain: 'system', tool: 'permission_check' },
      SYS_STOP: { hexagrams: [33], essence: '停止系统', domain: 'system', tool: 'exec_command' },
      SYS_RESTART: { hexagrams: [1, 51], essence: '重启系统', domain: 'system', tool: 'exec_command' },
      AUTH_GRANT: { hexagrams: [1, 43], essence: '授予权限', domain: 'permission', tool: 'permission_grant' },
      AUTH_CHECK: { hexagrams: [1], essence: '权限校验', domain: 'permission', tool: 'permission_check' },
      BATCH_EXEC: { hexagrams: [1, 43], essence: '批量执行', domain: 'execution', tool: 'batch_execute' },
      TEAM_DISPATCH: { hexagrams: [1, 57], essence: '分发任务', domain: 'coordination', tool: 'team_dispatch' },

      // ---- 坤宫（存储/数据/持久化）----
      DATA_READ: { hexagrams: [2, 30], essence: '读取数据', domain: 'storage', tool: 'read_file' },
      DATA_WRITE: { hexagrams: [2, 49], essence: '写入数据', domain: 'storage', tool: 'write_file' },
      DATA_QUERY: { hexagrams: [2, 30], essence: '数据查询', domain: 'storage', tool: 'search_files' },
      DATA_PERSIST: { hexagrams: [2, 63], essence: '持久化存储', domain: 'storage', tool: 'write_file' },
      FILE_LIST: { hexagrams: [2], essence: '文件列表', domain: 'storage', tool: 'list_directory' },

      // ---- 屯宫（初始化/项目/构建）----
      PROJ_INIT: { hexagrams: [3, 53], essence: '初始化项目', domain: 'project', tool: 'exec_command' },
      PROJ_BUILD: { hexagrams: [3, 26], essence: '构建项目', domain: 'project', tool: 'exec_command' },
      PROJ_DEPEND: { hexagrams: [3, 57], essence: '依赖安装', domain: 'project', tool: 'exec_command' },
      PROJ_SCAFFOLD: { hexagrams: [3, 22], essence: '搭建骨架', domain: 'project', tool: 'exec_command' },

      // ---- 蒙宫（学习/分析/研究）----
      LEARN_ANALYZE: { hexagrams: [4, 30], essence: '分析研究', domain: 'cognition', tool: 'search_files' },
      MEMORY_STORE: { hexagrams: [4, 2], essence: '记忆存储', domain: 'memory', tool: 'memory_write' },
      MEMORY_RETRIEVE: { hexagrams: [4, 30], essence: '记忆检索', domain: 'memory', tool: 'memory_search' },

      // ---- 需宫（等待/需求/缓存）----
      CACHE_LOOKUP: { hexagrams: [5, 29], essence: '缓存查询', domain: 'cache', tool: 'cache_get' },
      CACHE_STORE: { hexagrams: [5, 9], essence: '缓存写入', domain: 'cache', tool: 'cache_put' },
      CACHE_PREHEAT: { hexagrams: [5, 26], essence: '缓存预热', domain: 'cache', tool: 'cache_preheat' },
      RESOURCE_POOL: { hexagrams: [5, 9], essence: '资源池管理', domain: 'resource', tool: 'resource_pool' },

      // ---- 讼宫（争讼/合规/合约）----
      DISPUTE_DETECT: { hexagrams: [6, 38], essence: '冲突检测', domain: 'compliance', tool: 'search_files' },
      CONTRACT_CHECK: { hexagrams: [6, 60], essence: '合规审计', domain: 'compliance', tool: 'permission_check' },
      AUDIT_TRAIL: { hexagrams: [6, 30], essence: '审计追踪', domain: 'compliance', tool: 'read_file' },

      // ---- 师宫（军队/纪律/调度）----
      TEAM_ORCHESTRATE: { hexagrams: [7, 51], essence: '团队调度', domain: 'coordination', tool: 'team_dispatch' },
      SCHEDULE_PLAN: { hexagrams: [7, 53], essence: '排程计划', domain: 'planning', tool: 'exec_command' },
      RESOURCE_ALLOC: { hexagrams: [7, 26], essence: '资源分配', domain: 'resource', tool: 'resource_pool' },

      // ---- 比宫（比邻/协作/联盟）----
      COLLABORATE: { hexagrams: [8, 37], essence: '协作工作', domain: 'coordination', tool: 'team_dispatch' },
      SYNC_DATA: { hexagrams: [8, 59], essence: '数据同步', domain: 'storage', tool: 'read_file' },
      MERGE_RESULT: { hexagrams: [8, 45], essence: '合并结果', domain: 'coordination', tool: 'batch_execute' },

      // ---- 小畜宫（积累/预热/加速）----
      RESOURCE_CACHE: { hexagrams: [9, 5], essence: '资源缓存', domain: 'cache', tool: 'cache_put' },
      PRELOAD_DATA: { hexagrams: [9, 26], essence: '预加载数据', domain: 'cache', tool: 'cache_preheat' },
      ACCELERATE: { hexagrams: [9, 30], essence: '加速响应', domain: 'performance', tool: 'cache_get' },
      CACHE_EVICT: { hexagrams: [9, 23], essence: '缓存淘汰', domain: 'cache', tool: 'cache_evict' },
      CACHE_STATS: { hexagrams: [9, 30], essence: '缓存统计', domain: 'cache', tool: 'cache_stats' },

      // ---- 履宫（履行/合规/礼仪）----
      COMPLIANCE_CHECK: { hexagrams: [10, 6], essence: '合规检查', domain: 'compliance', tool: 'permission_check' },
      AUDIT_EXEC: { hexagrams: [10, 6], essence: '执行审计', domain: 'compliance', tool: 'read_file' },
      RULE_ENFORCE: { hexagrams: [10, 43], essence: '规则执行', domain: 'compliance', tool: 'batch_execute' },

      // ---- 泰宫（通泰/时机/协调）----
      TIMING_OPTIMAL: { hexagrams: [11, 14], essence: '最佳时机', domain: 'timing', tool: 'cache_stats' },
      COORDINATE: { hexagrams: [11, 8], essence: '协调行动', domain: 'coordination', tool: 'team_dispatch' },
      BALANCE_LOAD: { hexagrams: [11, 60], essence: '负载均衡', domain: 'resource', tool: 'resource_pool' },

      // ---- 否宫（阻断/失败/背离）----
      BLOCK_DETECT: { hexagrams: [12, 23], essence: '阻断检测', domain: 'fault', tool: 'exec_command' },
      FAILURE_RECOVERY: { hexagrams: [12, 64], essence: '失败恢复', domain: 'fault', tool: 'cache_evict' },
      CIRCUIT_BREAK: { hexagrams: [12, 52], essence: '熔断机制', domain: 'fault', tool: 'permission_check' },

      // ---- 同人宫（和同/协作/聚合）----
      CODE_COLLAB: { hexagrams: [13, 37], essence: '代码协作', domain: 'coding', tool: 'read_file' },
      MERGE_RESOLVE: { hexagrams: [13, 21], essence: '合并冲突解决', domain: 'coding', tool: 'exec_command' },
      PEER_SYNC: { hexagrams: [13, 8], essence: '节点同步', domain: 'coordination', tool: 'team_dispatch' },

      // ---- 大有宫（收获/富足/实现）----
      HARVEST_RESULT: { hexagrams: [14, 63], essence: '收获成果', domain: 'outcome', tool: 'read_file' },
      VALUE_DELIVER: { hexagrams: [14, 50], essence: '价值交付', domain: 'outcome', tool: 'exec_command' },
      PROFIT_REALIZE: { hexagrams: [14, 26], essence: '利润实现', domain: 'outcome', tool: 'batch_execute' },

      // ---- 谦宫（谦逊/设计/架构）----
      SYSTEM_DESIGN: { hexagrams: [15, 52], essence: '系统设计', domain: 'architecture', tool: 'read_file' },
      ARCH_PLAN: { hexagrams: [15, 26], essence: '架构规划', domain: 'architecture', tool: 'exec_command' },
      API_DESIGN: { hexagrams: [15, 30], essence: 'API设计', domain: 'architecture', tool: 'write_file' },

      // ---- 豫宫（豫悦/体验/娱乐）----
      USER_EXP: { hexagrams: [16, 30], essence: '用户体验优化', domain: 'ux', tool: 'cache_get' },
      FEEDBACK_COLLECT: { hexagrams: [16, 37], essence: '反馈收集', domain: 'ux', tool: 'write_file' },
      ENGAGEMENT_TRACK: { hexagrams: [16, 51], essence: '用户参与追踪', domain: 'ux', tool: 'search_files' },

      // ---- 遁宫（退避/取消/中断）----
      PROCESS_KILL: { hexagrams: [33], essence: '终止进程', domain: 'process', tool: 'exec_command' },
      TASK_ABORT: { hexagrams: [33, 40], essence: '中止任务', domain: 'process', tool: 'team_dispatch' },
      SESSION_ABORT: { hexagrams: [33, 6], essence: '中止会话', domain: 'process', tool: 'team_dispatch' },
      RESOURCE_FREE: { hexagrams: [33, 2], essence: '释放资源', domain: 'resource', tool: 'cache_evict' },

      // ---- 大壮宫（壮大/强势/扩展）----
      SCALE_UP: { hexagrams: [34, 26], essence: '规模扩张', domain: 'resource', tool: 'resource_pool' },
      THROUGHPUT_BOOST: { hexagrams: [34, 9], essence: '吞吐量提升', domain: 'performance', tool: 'cache_preheat' },

      // ---- 晋宫（晋升/光明/上升）----
      PROMOTE_ENTITY: { hexagrams: [35, 14], essence: '推广实体', domain: 'growth', tool: 'batch_execute' },
      INSIGHT_GAIN: { hexagrams: [35, 30], essence: '获得洞察', domain: 'cognition', tool: 'search_files' },

      // ---- 明夷宫（明伤/隐藏/逆境）----
      RISK_HIDE: { hexagrams: [36, 2], essence: '风险隐藏', domain: 'risk', tool: 'search_files' },
      FAULT_TOLERATE: { hexagrams: [36, 29], essence: '容错处理', domain: 'fault', tool: 'permission_check' },

      // ---- 家人宫（家庭/内务/温暖）----
      CONTEXT_LOAD: { hexagrams: [37, 4], essence: '加载上下文', domain: 'context', tool: 'memory_search' },
      CONTEXT_SAVE: { hexagrams: [37, 2], essence: '保存上下文', domain: 'context', tool: 'memory_write' },
      STATE_RESTORE: { hexagrams: [37, 24], essence: '恢复状态', domain: 'context', tool: 'memory_search' },

      // ---- 睚宫（差异/比对/冲突）----
      DIFF_COMPARE: { hexagrams: [38, 21], essence: '差异比对', domain: 'diff', tool: 'exec_command' },
      CONFLICT_RESOLVE: { hexagrams: [38, 6], essence: '冲突解决', domain: 'diff', tool: 'exec_command' },
      PATCH_APPLY: { hexagrams: [38, 49], essence: '应用补丁', domain: 'diff', tool: 'exec_command' },

      // ---- 蹇宫（蹇难/阻碍/停止）----
      DEADLOCK_DETECT: { hexagrams: [39, 29], essence: '死锁检测', domain: 'fault', tool: 'exec_command' },
      BLOCK_ANALYZE: { hexagrams: [39, 6], essence: '阻塞分析', domain: 'fault', tool: 'search_files' },
      WAIT_RESOLVE: { hexagrams: [39, 40], essence: '等待解决', domain: 'fault', tool: 'resource_pool' },

      // ---- 解宫（解除/缓解/解决）----
      DEADLOCK_RESOLVE: { hexagrams: [40, 6], essence: '解决死锁', domain: 'fault', tool: 'exec_command' },
      BLOCK_CLEAR: { hexagrams: [40, 59], essence: '清除阻塞', domain: 'fault', tool: 'batch_execute' },
      FLOW_RELEASE: { hexagrams: [40, 5], essence: '释放流量', domain: 'resource', tool: 'cache_evict' },

      // ---- 损宫（损失/节俭/克制）----
      COST_CUT: { hexagrams: [41, 60], essence: '成本削减', domain: 'resource', tool: 'cache_evict' },
      THROTTLE: { hexagrams: [41, 5], essence: '节流限制', domain: 'resource', tool: 'cache_stats' },

      // ---- 益宫（增益/收益/增长）----
      GAIN_MOMENTUM: { hexagrams: [42, 51], essence: '增益动能', domain: 'growth', tool: 'cache_preheat' },
      THROUGHPUT_GROW: { hexagrams: [42, 34], essence: '增长吞吐量', domain: 'growth', tool: 'resource_pool' },
      BENEFIT_ACCRUE: { hexagrams: [42, 26], essence: '利益积累', domain: 'resource', tool: 'cache_put' },

      // ---- 夬宫（决断/清除/公布）----
      DECISION_MAKE: { hexagrams: [43, 1], essence: '做决策', domain: 'decision', tool: 'batch_execute' },
      CLEAR_OUTDATED: { hexagrams: [43, 23], essence: '清除过时', domain: 'cleanup', tool: 'cache_evict' },
      ANNOUNCE: { hexagrams: [43, 30], essence: '公布决定', domain: 'communication', tool: 'team_dispatch' },

      // ---- 姤宫（相遇/机遇/警觉）----
      OPPORTUNITY_DETECT: { hexagrams: [44, 14], essence: '发现机遇', domain: 'opportunity', tool: 'search_files' },
      RISK_ALERT: { hexagrams: [44, 6], essence: '风险警报', domain: 'risk', tool: 'permission_check' },
      EVENT_HOOK: { hexagrams: [44, 57], essence: '事件挂钩', domain: 'event', tool: 'team_dispatch' },

      // ---- 萃宫（聚集/团结/整合）----
      AGGREGATE: { hexagrams: [45, 8], essence: '聚合数据', domain: 'aggregation', tool: 'search_files' },
      COLLECTIVE_EXEC: { hexagrams: [45, 7], essence: '集体执行', domain: 'coordination', tool: 'batch_execute' },
      REPORT_GEN: { hexagrams: [45, 30], essence: '生成报告', domain: 'reporting', tool: 'write_file' },

      // ---- 升宫（上升/进取/突破）----
      ESCALATE: { hexagrams: [46, 34], essence: '升级处理', domain: 'escalation', tool: 'team_dispatch' },
      BREAKTHROUGH: { hexagrams: [46, 1], essence: '突破限制', domain: 'growth', tool: 'batch_execute' },
      PROGRESS_TRACK: { hexagrams: [46, 51], essence: '进度追踪', domain: 'tracking', tool: 'search_files' },

      // ---- 困宫（围困/贫乏/资源匮乏）----
      RESOURCE_EXHAUSTED: { hexagrams: [47, 2], essence: '资源耗尽', domain: 'resource', tool: 'cache_evict' },
      DEADLOCK_WAIT: { hexagrams: [47, 29], essence: '死锁等待', domain: 'fault', tool: 'resource_pool' },
      POOL_EXHAUST: { hexagrams: [47, 5], essence: '连接池耗尽', domain: 'resource', tool: 'cache_stats' },

      // ---- 井宫（汲取/水源/探索）----
      FETCH_RESOURCE: { hexagrams: [48, 30], essence: '获取资源', domain: 'resource', tool: 'read_file' },
      WELL_EXPLORE: { hexagrams: [48, 38], essence: '探索深井', domain: 'exploration', tool: 'search_files' },
      PUMP_DATA: { hexagrams: [48, 5], essence: '泵取数据', domain: 'storage', tool: 'cache_get' },

      // ---- 革宫（变革/破旧/更新）----
      REFACTOR: { hexagrams: [49, 21], essence: '重构代码', domain: 'coding', tool: 'exec_command' },
      UPDATE_VERSION: { hexagrams: [49, 14], essence: '版本更新', domain: 'lifecycle', tool: 'batch_execute' },
      TRANSFORM_DATA: { hexagrams: [49, 30], essence: '数据转换', domain: 'data', tool: 'read_file' },

      // ---- 鼎宫（烹饪/冶炼/育成）----
      COMPILE_BUILD: { hexagrams: [50, 49], essence: '编译构建', domain: 'build', tool: 'exec_command' },
      NURTURE_PROCESS: { hexagrams: [50, 26], essence: '育成流程', domain: 'process', tool: 'resource_pool' },
      TEST_SUITE: { hexagrams: [50, 21], essence: '测试套件', domain: 'testing', tool: 'exec_command' },

      // ---- 震宫（震动/行动/起始）----
      TRIGGER_EVENT: { hexagrams: [51, 44], essence: '触发事件', domain: 'event', tool: 'team_dispatch' },
      ACTION_START: { hexagrams: [51, 1], essence: '开始行动', domain: 'action', tool: 'batch_execute' },
      NOTIFY_ALL: { hexagrams: [51, 59], essence: '通知所有', domain: 'communication', tool: 'team_dispatch' },
      HEARTBEAT: { hexagrams: [51, 29], essence: '心跳检测', domain: 'health', tool: 'exec_command' },

      // ---- 艮宫（静止/终了/坚守）----
      HALT_PROCESS: { hexagrams: [52, 33], essence: '停止进程', domain: 'process', tool: 'exec_command' },
      STATE_FREEZE: { hexagrams: [52, 2], essence: '冻结状态', domain: 'context', tool: 'memory_write' },
      GUARD_LIMIT: { hexagrams: [52, 60], essence: '守护边界', domain: 'security', tool: 'permission_check' },

      // ---- 巽宫（渗入/渐变/配置）----
      CONFIG_UPDATE: { hexagrams: [57, 41], essence: '配置更新', domain: 'config', tool: 'write_file' },
      TUNING_PARAM: { hexagrams: [57, 26], essence: '参数调优', domain: 'performance', tool: 'cache_stats' },
      DEPLOY_STAGE: { hexagrams: [57, 53], essence: '分阶段部署', domain: 'deployment', tool: 'exec_command' },
      HOOK_REGISTER: { hexagrams: [57, 44], essence: '注册钩子', domain: 'event', tool: 'team_dispatch' },

      // ---- 兑宫（喜悦/言说/交换）----
      INTERACT_USER: { hexagrams: [58, 30], essence: '用户交互', domain: 'interaction', tool: 'team_dispatch' },
      NEGOTIATE: { hexagrams: [58, 6], essence: '谈判协商', domain: 'communication', tool: 'search_files' },
      FEEDBACK_LOOP: { hexagrams: [58, 42], essence: '反馈循环', domain: 'communication', tool: 'write_file' },
      EXCHANGE_DATA: { hexagrams: [58, 8], essence: '数据交换', domain: 'storage', tool: 'read_file' },

      // ---- 涣宫（涣散/广播/传播）----
      BROADCAST_MSG: { hexagrams: [59, 51], essence: '广播消息', domain: 'communication', tool: 'team_dispatch' },
      DISPERSE_DATA: { hexagrams: [59, 45], essence: '分发数据', domain: 'distribution', tool: 'batch_execute' },
      CACHE_INVALIDATE: { hexagrams: [59, 23], essence: '缓存失效', domain: 'cache', tool: 'cache_evict' },

      // ---- 节宫（节制/流控/配额）----
      RATE_LIMIT: { hexagrams: [60, 41], essence: '限流控制', domain: 'resource', tool: 'cache_stats' },
      QUOTA_ENFORCE: { hexagrams: [60, 10], essence: '配额执行', domain: 'resource', tool: 'permission_check' },
      FLOW_CONTROL: { hexagrams: [60, 5], essence: '流量控制', domain: 'resource', tool: 'cache_evict' },

      // ---- 中孚宫（诚信/约定/事务保障）----
      TRANSACTION_BEGIN: { hexagrams: [61, 26], essence: '事务开始', domain: 'transaction', tool: 'exec_command' },
      TRANSACTION_COMMIT: { hexagrams: [61, 63], essence: '事务提交', domain: 'transaction', tool: 'write_file' },
      TRANSACTION_ROLLBACK: { hexagrams: [61, 12], essence: '事务回滚', domain: 'transaction', tool: 'cache_evict' },
      PROMISE_KEEP: { hexagrams: [61, 15], essence: '守约执行', domain: 'trust', tool: 'batch_execute' },

      // ---- 小过宫（偏差/小补/修正）----
      HOTFIX_APPLY: { hexagrams: [62, 49], essence: '热修复', domain: 'repair', tool: 'exec_command' },
      PATCH_MINOR: { hexagrams: [62, 22], essence: '小修补漏', domain: 'repair', tool: 'write_file' },
      ADJUST_TINY: { hexagrams: [62, 57], essence: '微调参数', domain: 'tuning', tool: 'write_file' },

      // ---- 既济宫（完成/交付/成功）----
      DELIVER_COMPLETE: { hexagrams: [63, 50], essence: '完整交付', domain: 'outcome', tool: 'read_file' },
      MILESTONE_REACH: { hexagrams: [63, 14], essence: '达成里程碑', domain: 'outcome', tool: 'batch_execute' },
      SUCCESS_WRAP: { hexagrams: [63, 1], essence: '圆满收尾', domain: 'outcome', tool: 'team_dispatch' },

      // ---- 未济宫（未完成/探索/继续）----
      EXPLORE_CONTINUE: { hexagrams: [64, 51], essence: '继续探索', domain: 'exploration', tool: 'search_files' },
      RETRY_ATTEMPT: { hexagrams: [64, 25], essence: '重试尝试', domain: 'fault', tool: 'exec_command' },
      ITERATE_NEXT: { hexagrams: [64, 42], essence: '迭代下一步', domain: 'process', tool: 'batch_execute' },
      ONGOING_MONITOR: { hexagrams: [64, 29], essence: '持续监控', domain: 'health', tool: 'exec_command' },

      // ---- 随宫（随从/变通/灵活）----
      FOLLOW_ADAPT: { hexagrams: [17, 57], essence: '跟随适应', domain: 'coordination', tool: 'team_dispatch' },
      FLEXIBLE_CHANGE: { hexagrams: [17, 49], essence: '灵活变更', domain: 'process', tool: 'batch_execute' },

      // ---- 蛊宫（腐败/整饬/治理）----
      GOVERN_REPAIR: { hexagrams: [18, 50], essence: '治理修复', domain: 'maintenance', tool: 'exec_command' },
      LEGACY_REFACTOR: { hexagrams: [18, 49], essence: '旧系统重构', domain: 'coding', tool: 'exec_command' },

      // ---- 临宫（督导/接近/关怀）----
      OVERSEE_APPROVE: { hexagrams: [19, 43], essence: '审批督导', domain: 'governance', tool: 'permission_check' },
      MONITOR_TRACK: { hexagrams: [19, 51], essence: '监控追踪', domain: 'health', tool: 'exec_command' },

      // ---- 观宫（观察/审视/静观）----
      OBSERVE_INSPECT: { hexagrams: [20, 30], essence: '观察审视', domain: 'inspection', tool: 'search_files' },
      PREVIEW_CHECK: { hexagrams: [20, 38], essence: '预览检查', domain: 'inspection', tool: 'read_file' },

      // ---- 颐宫（颐养/养育/保护）----
      NOURISH_SUSTAIN: { hexagrams: [27, 2], essence: '滋养持续', domain: 'resource', tool: 'resource_pool' },
      HEALTH_CHECK: { hexagrams: [27, 51], essence: '健康检查', domain: 'health', tool: 'exec_command' },

      // ---- 大过宫（太过/异常/破常规）----
      EXCESSIVE_CHECK: { hexagrams: [28, 60], essence: '过度检查', domain: 'validation', tool: 'permission_check' },
      LIMIT_TEST: { hexagrams: [28, 1], essence: '极限测试', domain: 'testing', tool: 'batch_execute' },

      // ---- 咸宫（感应/吸引/心动）----
      SENSE_DETECT: { hexagrams: [31, 30], essence: '感应检测', domain: 'sensing', tool: 'search_files' },
      HEARTBEAT_DETECT: { hexagrams: [31, 51], essence: '心跳感应', domain: 'health', tool: 'exec_command' },

      // ---- 恒宫（恒久/持久/坚持）----
      DURATION_MONITOR: { hexagrams: [32, 29], essence: '持久监控', domain: 'health', tool: 'exec_command' },
      TIMEOUT_WATCH: { hexagrams: [32, 60], essence: '超时守护', domain: 'fault', tool: 'exec_command' },

      // ---- 归妹宫（归宿/嫁娶/回归）----
      RETURN_PROCESS: { hexagrams: [54, 24], essence: '回归处理', domain: 'lifecycle', tool: 'exec_command' },
      CLEANUP_TASK: { hexagrams: [54, 23], essence: '清理任务', domain: 'cleanup', tool: 'cache_evict' },

      // ---- 丰宫（丰富/盛大/繁忙）----
      BATCH_GATHER: { hexagrams: [55, 45], essence: '批量收集', domain: 'aggregation', tool: 'batch_execute' },
      AGGREGATE_DATA: { hexagrams: [55, 30], essence: '数据汇总', domain: 'aggregation', tool: 'read_file' },

      // ---- 旅宫（旅行/漂泊/探索）----
      TIMEOUT_RETRY: { hexagrams: [56, 64], essence: '超时重试', domain: 'fault', tool: 'exec_command' },
      TRAVEL_EXPLORE: { hexagrams: [56, 38], essence: '探索发现', domain: 'exploration', tool: 'search_files' },
    },
  },
};

// ============================================================
// 核心查询函数
// ============================================================

/**
 * 通过领域+信号名获取对应卦象
 * @param {string} domain - 领域名，如 'stock_market', 'team_management'
 * @param {string} signal - 信号名，如 'TREND_UP', 'LEADERSHIP_STRONG'
 * @returns {{ hexagrams: number[], essence: string, domain: string, confidence: number }}
 */
function getHexagramsByDomainSignal(domain, signal) {
  const adapter = DOMAIN_ADAPTERS[domain];
  if (!adapter) {
    // 未知领域，返回通用
    return { hexagrams: [1], essence: '默认刚健', domain, confidence: 0.3 };
  }
  const entry = adapter.signalSpace[signal];
  if (!entry) {
    return { hexagrams: [], essence: '未知信号', domain, confidence: 0 };
  }
  return { ...entry, confidence: 0.8 };
}

/**
 * 通过信号名在所有领域搜索
 * @param {string} signal - 信号名
 * @returns {Array<{ domain: string, entry: object }>}
 */
function searchSignalAcrossDomains(signal) {
  const results = [];
  for (const [domain, adapter] of Object.entries(DOMAIN_ADAPTERS)) {
    if (domain === '_common' || !adapter.signalSpace) continue;
    const entry = adapter.signalSpace[signal];
    if (entry) {
      results.push({ domain, entry });
    }
  }
  return results;
}

/**
 * 通过卦象 ID 获取通用本体
 * @param {number} hexagramId
 * @returns {object|null}
 */
function getHexagramOntology(hexagramId) {
  return HEXAGRAM_ONTOLOGY[hexagramId] || null;
}

/**
 * 通过领域和信号获取本体向量（用于向量化计算）
 * @param {string} domain
 * @param {string} signal
 * @returns {object|null}
 */
function getSignalVector(domain, signal) {
  const result = getHexagramsByDomainSignal(domain, signal);
  if (!result.hexagrams.length) return null;

  // 合并多个卦象的向量
  const vectors = result.hexagrams
    .map(id => HEXAGRAM_ONTOLOGY[id]?.vector)
    .filter(Boolean);

  if (!vectors.length) return null;

  return {
    energy: vectors.reduce((s, v) => s + v.energy, 0) / vectors.length,
    direction: vectors[0].direction,
    stability: vectors.reduce((s, v) => s + v.stability, 0) / vectors.length,
    adaptability: vectors.reduce((s, v) => s + v.adaptability, 0) / vectors.length,
    hexagrams: result.hexagrams,
    essence: result.essence,
  };
}

/**
 * 获取两卦象的相似度（基于向量距离）
 * @param {number} id1
 * @param {number} id2
 * @returns {number} 0-1 相似度
 */
function getHexagramSimilarity(id1, id2) {
  const h1 = HEXAGRAM_ONTOLOGY[id1];
  const h2 = HEXAGRAM_ONTOLOGY[id2];
  if (!h1 || !h2) return 0;

  const v1 = h1.vector;
  const v2 = h2.vector;

  // 欧氏距离
  const dist = Math.sqrt(
    Math.pow(v1.energy - v2.energy, 2) +
    (v1.direction === v2.direction ? 0 : 1) +
    Math.pow(v1.stability - v2.stability, 2) +
    Math.pow(v1.adaptability - v2.adaptability, 2)
  );

  // 转换为 0-1 相似度
  return Math.max(0, 1 - dist / 2);
}

/**
 * 获取所有可用领域
 * @returns {string[]}
 */
function getAvailableDomains() {
  return Object.keys(DOMAIN_ADAPTERS).filter(k => k !== '_common');
}

/**
 * 获取某领域的所有信号
 * @param {string} domain
 * @returns {string[]}
 */
function getSignalsByDomain(domain) {
  const adapter = DOMAIN_ADAPTERS[domain];
  if (!adapter || !adapter.signalSpace) return [];
  return Object.keys(adapter.signalSpace);
}

// ============================================================
// encoder/decoder 辅助
// ============================================================

/**
 * 将原始数据映射到信号（通用接口，由具体领域实现）
 * @param {string} domain
 * @param {object} rawData
 * @returns {string|null} signalName
 */
/**
 * 将文本直接编码为卦象序列
 * 算法：UTF-8字节流 → 6位/爻 → 卦象
 * 
 * "读" (E8 9B 85) = 1110 1000 1001 1011 1000 0101
 * 取6位: 111010(58), 001001(9), 101110(46), 000101(5)
 * → 卦58, 卦9, 卦46, 卦5
 */
function encodeTextToHexagrams(text) {
  if (!text) return [];
  
  // UTF-8 编码 → 字节数组
  const bytes = [];
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code <= 0x7F) {
      bytes.push(code);
    } else if (code <= 0x7FF) {
      bytes.push(0xC0 | (code >> 6));
      bytes.push(0x80 | (code & 0x3F));
    } else if (code <= 0xFFFF) {
      bytes.push(0xE0 | (code >> 12));
      bytes.push(0x80 | ((code >> 6) & 0x3F));
      bytes.push(0x80 | (code & 0x3F));
    } else {
      bytes.push(0xF0 | (code >> 18));
      bytes.push(0x80 | ((code >> 12) & 0x3F));
      bytes.push(0x80 | ((code >> 6) & 0x3F));
      bytes.push(0x80 | (code & 0x3F));
    }
  }
  
  // 位流展开（LSB优先，6位一组）
  const hexagrams = [];
  let bitBuffer = 0;
  let bitCount = 0;
  
  for (const byte of bytes) {
    for (let i = 0; i < 8; i++) {
      const bit = (byte >> i) & 1;
      bitBuffer |= (bit << bitCount);
      bitCount++;
      
      if (bitCount === 6) {
        hexagrams.push(bitBuffer);  // 0-63
        bitBuffer = 0;
        bitCount = 0;
      }
    }
  }
  
  // 处理剩余位（不足6位用随机填充，但标记不可信）
  const hasRemainder = bitCount > 0;
  
  return hexagrams;
}

/**
 * 根据卦象查对应信号（来自 skill_execution 的 signalSpace）
 */
function getSignalByHexagram(hexagramId) {
  const skillAdapter = DOMAIN_ADAPTERS.skill_execution;
  if (!skillAdapter || !skillAdapter.signalSpace) return null;
  
  // 遍历所有信号，找到包含该卦象的
  // 每个信号有多个 hexagrams，取最接近的那个
  const signals = Object.entries(skillAdapter.signalSpace);
  
  let bestSignal = null;
  let bestDistance = 999;
  
  for (const [signalName, entry] of signals) {
    const hexagrams = entry.hexagrams || [];
    for (const h of hexagrams) {
      const dist = Math.abs(h - hexagramId);
      if (dist < bestDistance) {
        bestDistance = dist;
        bestSignal = signalName;
      }
    }
  }
  
  return bestSignal;
}

/**
 * 编码通道辅助：统计卦象→信号投票
 */
function encodeTextToSignals(text, maxSignals = 3) {
  const hexagrams = encodeTextToHexagrams(text);
  if (!hexagrams.length) return [];
  
  const signalCount = {};
  for (const h of hexagrams) {
    const sig = getSignalByHexagram(h);
    if (sig) {
      signalCount[sig] = (signalCount[sig] || 0) + 1;
    }
  }
  
  const sorted = Object.entries(signalCount)
    .sort((a, b) => b[1] - a[1])
    .slice(0, maxSignals)
    .map(([sig, count]) => ({ signal: sig, count, confidence: count / hexagrams.length }));
  
  return sorted;
}

/**
 * 综合入口：语义 + 编码双通道信号分析
 * 
 * 语义通道：mapSkillExecutionSignal（关键词匹配）→ 核心信号
 * 编码通道：encodeTextToHexagrams → 辅助特征（复杂度/密度/节奏）
 * 
 * @param {string} text - 用户输入
 * @returns {{ signal: string, complexity: string, timeSensitive: boolean, confidence: number, hexagramCount: number }}
 */
function analyzeTextSignal(text) {
  // ===== 语义通道（核心）=====
  const semanticSignal = mapSkillExecutionSignal({ text });
  
  // ===== 编码通道（辅助）=====
  const hexagrams = encodeTextToHexagrams(text);
  const hCount = hexagrams.length;
  
  // 复杂度：从字符数/字节数看
  const charCount = text.length;
  let complexity = 'low';
  if (charCount > 30 || hCount > 10) complexity = 'medium';
  if (charCount > 60 || hCount > 20) complexity = 'high';
  
  // 时间敏感：从位密度看（短词高密度 = 可能时间敏感）
  const timeSensitive = charCount <= 10 && hCount >= 5;
  
  // 信号置信度：语义通道有结果 → 高；无结果 → 看编码通道投票
  let confidence = semanticSignal ? 0.8 : 0.3;
  
  // 编码通道投票（增强或削弱语义结果）
  if (!semanticSignal && hCount > 0) {
    const signals = encodeTextToSignals(text, 1);
    if (signals.length > 0 && signals[0].confidence > 0.3) {
      confidence = signals[0].confidence * 0.5;
    }
  }
  
  return {
    signal: semanticSignal,
    complexity,
    timeSensitive,
    confidence,
    hexagramCount: hCount,
    encodingSignals: encodeTextToSignals(text, 2),
  };
}
function mapDataToSignal(domain, rawData) {
  // 具体映射逻辑由领域适配器提供
  // 这里是一个默认实现模板
  const signals = getSignalsByDomain(domain);
  if (!signals.length) return null;

  // skill_execution 域：真正的语义映射
  if (domain === 'skill_execution') {
    return mapSkillExecutionSignal(rawData);
  }

  // 默认返回第一个信号（具体领域应重写此逻辑）
  // 例如 stock_market 应根据 change > 0 判断是 TREND_UP 还是 TREND_DOWN
  return signals[0];
}

/**
 * skill_execution 域的信号映射核心
 * 分析自然语言输入的动作类型+对象类型 → 对应信号
 */
function mapSkillExecutionSignal(rawData) {
  const text = (typeof rawData === 'string' ? rawData : rawData.text || '');

  // ===== 工具函数：匹配关键词（支持中文无空格文本）=====
  const has = (keywords) => {
    for (const kw of keywords) {
      const idx = text.indexOf(kw);
      if (idx >= 0) {
        const prev = idx > 0 ? text[idx - 1] : ' ';
        if (!/[a-zA-Z]/.test(prev)) return kw;
      }
    }
    return null;
  };

  // ===== 动作类型优先级排序（长词优先/复合词优先）=====
  // 0. 天气查询（最具体，优先于"查"）→ DATA_QUERY
  if (/天气|weather|气温|温度|forecast/.test(text)) {
    return 'DATA_QUERY';
  }

  // 1. 构建/编译/构建命令（优先于"运行"，更具体）→ PROJ_BUILD
  if (has(['构建', 'build', 'compile', '打包', 'package', 'npm run', 'npm build', 'npm test'])) {
    return 'PROJ_BUILD';
  }

  // 2. 执行/运行类 → EXEC_CMD
  if (has(['执行', '运行', 'exec', 'execute', 'running', 'launch', 'start'])) {
    return 'EXEC_CMD';
  }

  // 3. Git 命令（优先于通用"执行"，因为"git push"没有"执行"字）→ EXEC_CMD
  if (has(['git push', 'git pull', 'git commit', 'git merge', 'git checkout', 'git branch', 'git clone', 'git status', 'git log', 'git diff'])) {
    return 'EXEC_CMD';
  }
  if (has(['git']) && has(['push', 'pull', 'commit', 'merge', 'checkout', 'branch', 'clone', 'status', 'log', 'diff'])) {
    return 'EXEC_CMD';
  }

  // 3. 读类 → DATA_READ（但"查看目录"是 FILE_LIST）
  if (has(['查看']) && has(['目录', '文件夹', 'dir', 'ls', 'list'])) {
    return 'FILE_LIST';
  }
  if (has(['读', '看', '查看', '查', '浏览', 'cat', 'less', 'head', 'tail', 'type', 'open', 'show', 'display'])) {
    return 'DATA_READ';
  }

  // 4. 写/创建/新建类 → DATA_WRITE
  if (has(['写', '创建', '新建', 'touch', 'write', 'create', 'new', 'add'])) {
    return 'DATA_WRITE';
  }

  // 5. 编辑/修改/改 → PATCH_APPLY
  if (has(['编辑', '修改', '改', 'edit', 'patch', 'sed', 'replace', '改动', '调整'])) {
    return 'PATCH_APPLY';
  }

  // 6. 搜索/找/grep/find → CACHE_LOOKUP
  if (has(['搜索', '找', '查找', 'grep', 'find', 'search'])) {
    return 'CACHE_LOOKUP';
  }

  // 7. 列出/ls/目录列表 → FILE_LIST
  if (has(['列', 'ls', 'list', '目录', '文件夹', 'dir'])) {
    return 'FILE_LIST';
  }

  // 8. 项目初始化/搭建骨架 → PROJ_INIT
  if (has(['初始化', 'init', '搭建', '骨架', 'scaffold'])) {
    return 'PROJ_INIT';
  }

  // 9. 构建/编译/构建 → PROJ_BUILD
  if (has(['构建', 'build', 'compile', '打包', 'package'])) {
    return 'PROJ_BUILD';
  }

  // 10. 网络请求/web fetch → DATA_QUERY
  if (has(['http', 'web', 'fetch', 'request', 'api', 'curl', 'wget', 'download'])) {
    return 'DATA_QUERY';
  }

  // 11. 团队协作/分发任务 → TEAM_DISPATCH
  if (has(['分发', '协作', '团队', 'dispatch', 'delegate', 'assign', 'parallel'])) {
    return 'TEAM_DISPATCH';
  }

  // 12. 差异比对/git diff → DIFF_COMPARE
  if (has(['diff', 'compare', '比对', '差异', 'patch'])) {
    return 'DIFF_COMPARE';
  }

  // 13. 删除/移除 → RESOURCE_FREE
  if (has(['删除', 'remove', 'delete', 'cleanup', 'clear', 'rm'])) {
    return 'RESOURCE_FREE';
  }

  // 14. 配置/设置/写配置 → CONFIG_UPDATE
  if (has(['配置', 'config', 'setting', 'setup', '设置', 'env'])) {
    return 'CONFIG_UPDATE';
  }

  // 15. 重启/重启系统 → SYS_RESTART
  if (has(['重启', 'restart', 'reboot', 'reload'])) {
    return 'SYS_RESTART';
  }

  // 16. 监控/健康检查 → HEALTH_CHECK
  if (has(['健康', '监控', 'health', 'monitor', 'status', 'check'])) {
    return 'HEALTH_CHECK';
  }

  // 17. 权限/授权 → AUTH_CHECK
  if (has(['权限', 'auth', 'permission', '授权', 'verify'])) {
    return 'AUTH_CHECK';
  }

  // 18. 代码协作/Code Review → CODE_COLLAB
  if (has(['pr', 'merge', 'pull', 'commit', '代码协作', 'codereview'])) {
    return 'CODE_COLLAB';
  }

  // 19. 反射/自我分析 → MEMORY_RETRIEVE
  if (has(['反思', '分析', '自我', 'introspect', 'reflect', 'analyze'])) {
    return 'MEMORY_RETRIEVE';
  }

  // 20. 压缩/摘要/会话压缩 → CONTEXT_SAVE
  if (has(['压缩', '摘要', 'summarize', 'compact', 'concis'])) {
    return 'CONTEXT_SAVE';
  }

  // 21. 继续/下一步/迭代 → ITERATE_NEXT
  if (has(['继续', '下一步', '迭代', 'iterate', 'resume'])) {
    return 'ITERATE_NEXT';
  }

  // 无法识别 → 返回 null
  return null;
}

/**
 * 获取默认领域（用于未指定领域时）
 */
const DEFAULT_DOMAIN = 'decision_analysis';

// ============================================================
// 导出
// ============================================================

module.exports = {
  // 常量
  HEXAGRAM_ONTOLOGY,
  DOMAIN_ADAPTERS,
  DEFAULT_DOMAIN,

  // 查询
  getHexagramsByDomainSignal,
  getHexagramOntology,
  getSignalVector,
  getHexagramSimilarity,
  getAvailableDomains,
  getSignalsByDomain,
  searchSignalAcrossDomains,
  mapDataToSignal,

  // 文本→卦象编码
  encodeTextToHexagrams,
  encodeTextToSignals,
  analyzeTextSignal,
};
