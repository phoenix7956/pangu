'use strict';
// hexagram-keywords-alignment-20261021.test.js
//
// 64i 的 keywords 整条链错位了一格, 而且**不报错**: 27/64 卦拿到的是隔壁卦的词。
// 它不像 id/binary/symbol 那样有 assertBaseIntegrity 兜着, 所以一直没被发现。
//
// 怎么发现的: 2026-10-21 修完"第24卦"那道题后, 模型自己在答案里写了
//   "工具的 keywords 字段返回的是'无妄/无望/不妄/真诚/天道',
//     与卦名'复'的字面义略有出入, 疑为该数据源字段错位"
// —— 模型看出数据不对, 但没人告诉它到底哪儿不对。
//
// 为什么危险: 64i **自己不消费** keywords (它只原样透给 LLM),
// 所以错位不会让任何代码报错, 只会让模型带着别人的卦义去答本题的题。

const path = require('path');

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { console.log('  ✅ ' + msg); pass++; }
  else { console.log('  ❌ ' + msg); fail++; }
}

const idx = require('../64i/index.js');
const L = idx.listHexagrams();

// 乾/坤 的 keywords 讲天地定位(天道/地道), 本来就不含卦名 —— 显式放行, 不放宽规则。
const NAME_OPTIONAL = new Set(['乾', '坤']);

console.log('--- keywords 必须属于本卦 (2026-10-21 实跑发现 27/64 错位) ---');
ok(L.length === 64, '64 卦齐全');

const misaligned = [];
for (const h of L) {
  ok(Array.isArray(h.keywords) && h.keywords.length > 0, h.name + ' keywords 非空');
  if (NAME_OPTIONAL.has(h.name)) continue;
  const kw0 = String((h.keywords || [])[0] || '');
  if (!kw0.startsWith(h.name)) {
    const owner = L.find(x => x.id !== h.id && x.name !== h.name && kw0.startsWith(x.name));
    misaligned.push(h.name + '(id=' + h.id + ') 首项 "' + kw0 + '" 实属 ' + (owner ? owner.name : '?') + ' 的词');
  }
}
ok(misaligned.length === 0,
  '零错位 (实得 ' + misaligned.length + (misaligned.length ? ': ' + misaligned.join('; ') : '') + ')');

// 抽样: 那条错位链的两端 + 中间, 钉死具体值, 免得"改回去"以后没人发现
const expect = {
  20: '观', 21: '噬嗑', 22: '贲', 23: '剥', 24: '复', 25: '无妄', 26: '大畜',
  42: '益', 48: '井', 49: '革', 59: '涣', 61: '中孚', 62: '小过', 63: '既济', 64: '未济',
};
for (const [id, name] of Object.entries(expect)) {
  const h = idx.getHexagram(Number(id));
  ok(h && h.name === name, '卦序 ' + id + ' = ' + name + ' (实得 ' + (h && h.name) + ')');
  ok(h && String(h.keywords[0]).startsWith(name),
    name + ' 的 keywords 首项 "' + (h && h.keywords[0]) + '" 对得上本卦');
}

// keywords 内部不该有重复项 (剥卦原来就有 "剥落" 写两遍)
const dupes = L.filter(h => {
  const s = new Set();
  return (h.keywords || []).some(k => { if (s.has(k)) return true; s.add(k); return false; });
});
ok(dupes.length === 0,
  'keywords 无重复项 (实得 ' + dupes.length + (dupes.length ? ': ' + dupes.map(h => h.name + '=' + JSON.stringify(h.keywords)).join('; ') : '') + ')');

// keywords 应当与 nature 同向 (错位那一版里 复卦 nature=回复 但首项是 无妄)
const offNature = L.filter(h => {
  if (NAME_OPTIONAL.has(h.name)) return false;
  const kw0 = String((h.keywords || [])[0] || '');
  return h.nature && !kw0.startsWith(h.name) && !kw0.startsWith(String(h.nature).slice(0, 2));
});
ok(offNature.length === 0,
  'keywords 首项与 nature 同向 (实得 ' + offNature.length + (offNature.length ? ': ' + offNature.map(h => h.name).join(',') : '') + ')');

console.log('\n--- 自检必须真能抓 (负例: 把复卦的词换回无妄的, require 就该炸) ---');
// 直接把错数据喂给断言, **不改真文件** —— 断言自己没被负例检验过, 就不知道它会不会真炸。
const { assertKeywordsAligned } = require('../64i/hexagrams.js');
ok(typeof assertKeywordsAligned === 'function', 'assertKeywordsAligned 已导出 (能直接喂负例)');

const clone = () => L.map(h => ({ id: h.id, name: h.name, keywords: h.keywords.slice() }));

// 负例 1: 复卦的词换回无妄的 —— 这次实跑踩的就是这个
try {
  const bad = clone();
  bad.find(h => h.name === '复').keywords = ['无妄', '无望', '不妄', '真诚', '天道'];
  assertKeywordsAligned(bad);
  ok(false, '负例1 竟然通过了 —— 自检没抓到错位');
} catch (e) {
  ok(/keywords 与本卦脱钩/.test(String(e && e.message)) && /无妄/.test(String(e && e.message)),
    '负例1 抓到了并指名道姓: ' + String(e && e.message).slice(0, 100));
}

// 负例 2: keywords 为空
try {
  const bad = clone();
  bad.find(h => h.name === '乾').keywords = [];
  assertKeywordsAligned(bad);
  ok(false, '负例2 竟然通过了 —— 空 keywords 没抓到');
} catch (e) {
  ok(/keywords 为空/.test(String(e && e.message)), '负例2 抓到了空 keywords');
}

// 负例 3: 组内重复 (剥卦历史上就写了两遍"剥落")
try {
  const bad = clone();
  bad.find(h => h.name === '剥').keywords = ['剥落', '剥蚀', '剥落'];
  assertKeywordsAligned(bad);
  ok(false, '负例3 竟然通过了 —— 组内重复没抓到');
} catch (e) {
  ok(/keywords 内部重复/.test(String(e && e.message)), '负例3 抓到了组内重复');
}

// 正例: 真数据喂进去必须安静过 (别把自检写成永远在响的噪音)
try {
  assertKeywordsAligned(clone());
  ok(true, '正例: 64 卦真数据安静通过');
} catch (e) {
  ok(false, '正例竟然报错: ' + String(e && e.message));
}

console.log('\n============================================================');
console.log('测试结果：' + (fail === 0 ? '✅ 全部通过' : '❌ ' + fail + ' 项失败'));
console.log('============================================================');
if (fail > 0) process.exit(1);
