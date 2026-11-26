/**
 * Pangu · 64i Layer
 * index.js — 统一导出索引（新版）
 *
 * 目录结构：
 *   64i/
 *   ├─ index.js              ← 本文件：统一入口
 *   ├─ yao_models.js         ← 384爻数据
 *   ├─ symbol_table.js       ← 64卦符号表+路由
 *   ├─ yin_yang.js           ← 阴阳基础定义
 *   ├─ hexagrams.js          ← 64卦原始数据（基础）
 *   └─ bagua_annotations/    ← 五行注解层
 *       ├─ index.js           ← 聚合入口
 *       ├─ wuxing_map.js      ← 64卦五行归类
 *       ├─ bagua_positions.js ← 先天/后天八卦方位
 *       └─ jingfang_bagong.js ← 京房八宫64卦表(宫/宫位/世应) —— 卦层占筮结构
 *       ├─ index.js           ← 聚合入口
 *       ├─ wuxing_map.js      ← 64卦五行归类
 *       └─ bagua_positions.js ← 先天/后天八卦方位
 */

'use strict';

// 2026-09-17 全修: 64i 真源直接暴露, 消化任务不许从 extracted/ 推算
const hexagrams = require('./hexagrams');
const hexagramVector = require('./hexagram_vector');

module.exports = {
  // 64卦完整定义 (卦辞/爻辞/八宫/纳甲/五行/nature/keywords)
  hexagrams,
  // 64卦二进制映射
  hexagramVector,
  // 384爻数据
  yaoModels: require('./yao_models'),
  // 64卦符号表+域名信号路由
  symbolTable: require('./symbol_table'),
  // 阴阳基础
  yinYang: require('./yin_yang'),
  // 五行注解层（聚合）
  baguaAnnotations: require('./bagua_annotations'),
  // 京房八宫 64 卦表 (2026-10-22 落: 双源交叉 64/64)
  //   ⚠️ 别跟 hexagrams.js 的 bagong 字段混: 那是「上卦分组」, 这里是京房宫。
  jingfangBagong: require('./bagua_annotations/jingfang_bagong.js'),
  // 便捷接口: 按卦名/卦序查单卦
  //
  // 2026-10-21: 传**数字**查不到时原来静默返回 undefined。
  //   后果不是崩, 是更坏的"答非所问": hexagram_lookup 拿到 undefined 就转去模糊匹配,
  //   匹配不到也照样返回 `{ok:true, data:[]}` —— 主人问"第 0 卦"(0 基那位),
  //   盘古回一句"没找到", 还回得像个正常结论。
  //
  //   现在改成抛错, 而且错认里写清两个基数分别是谁 ——
  //   老板原话「64卦有一个最大的坑, 不是 1~64 是 0~63」, 这个错认正是那一坑的入口。
  //
  //   唯一传数字的调用方 (tools/index.js hexagram_lookup) 本来就在 try/catch 里,
  //   抛错会变成 `{ok:false, error:{code:'LOOKUP_FAILED', message}}` ——
  //   比空数组 + ok:true 诚实得多, 也比 undefined 往下传炸在别处好定位。
  getHexagram(nameOrId) {
    const list = hexagrams.HEXAGRAMS || hexagrams;
    // 2026-10-21: 补数字**字符串**。
    //   hexagram_lookup 的 schema 把 query 声明成 type:'string', 所以模型发过来的一定是
    //   "5" 而不是 5 —— 而老代码只在 typeof === 'number' 时才走 id 分支,
    //   于是 `"5"` 落到按卦名找的分支, 找不到 → 调用方转模糊匹配 → 也匹配不到 →
    //   返回 `{ok:true, data:[]}`。**id 查询这条路在生产里是死的。**
    //   没有任何卦名是纯数字, 所以数字串判成 id 是无歧义的。
    const asNum = (typeof nameOrId === 'number')
      ? nameOrId
      : (typeof nameOrId === 'string' && /^\d+$/.test(nameOrId.trim()) ? Number(nameOrId.trim()) : null);
    if (asNum !== null) {
      const h = list.find(x => x.id === asNum);
      if (!h) {
        throw new RangeError('卦序 ' + asNum + ' 不存在 —— id 是 **1..64**(1 基, 乾=1 坤=2)。'
          + '如果你手上的是 0 基二进制索引 (0..63, 乾=63 坤=0), 请先用 indexToId() 换成卦序, '
          + '别把两套编号混着用 —— 两套在 1..63 上完全重叠, 错一位不会报错, 只会安静地返回另一卦。');
      }
      return h;
    }
    return list.find(h => h.name === nameOrId || h.name_cn === nameOrId);
  },
  // 0 基二进制索引 → 卦序 (1 基)。裸数字进 getHexagram() 是这个坑的主要入口,
  // 所以换算的出口得跟入口挨着放, 用的人才会看见。
  getHexagramByIndex(index) { return hexagrams.getHexagramByIndex(index); },
  idToIndex(id) { return hexagrams.idToIndex(id); },
  indexToId(index) { return hexagrams.indexToId(index); },
  listHexagrams() { return hexagrams.HEXAGRAMS || hexagrams; },
};

// 别名兼容
module.exports.yao_models = module.exports.yaoModels;
module.exports.symbol_table = module.exports.symbolTable;
module.exports.bagua_annotations = module.exports.baguaAnnotations;
