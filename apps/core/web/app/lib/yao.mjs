// yao.mjs —— 爻题(爻位标签)的解析
//
// 从原版 `apps/desktop/src/lib/yao.js` (git 110661d^) 原样搬过来。
//
// 为什么单独一个模块: 「爻题怎么写」是**术数规则**, 不是界面样式。
// 老板 2026-10-22 原话「我感觉64卦卦序有点问题」, 查出来的三处真 bug:
//   ① 爻位阴阳判错 —— 旧代码扫**整条爻辞正文**找「九」字判断阴阳,
//      震卦六二「震来厉, 亿丧贝, 跻于九陵」正文有个「九」⇒ 六二爻被标成「九」。
//   ② 爻题排列规则错 —— 旧代码按 `['初','二',…][i] + (九|六)` 拼, 于是「二九」;
//      通行爻题是**二至五爻阴阳在前**(九二/六二/…), 只有初爻与上爻位置在前(初九/上九)。
//   ③ 爻题前缀剥不掉 —— 旧正则 `/^[初九|初六|…][：:]/` 里的 `|` 是字面竖线,
//      于是详情页显示成「二九九二：见龙在田」。
//
// 修法: **爻题从数据里读**。64i 的 384 条爻辞本来就以标准爻题开头(「初九：」…),
// 前端只要按标准规则切出来, 标签与正文永远一致。

/** 六个爻位的位置字(自下而上: 初、二、三、四、五、上)。 */
export const YAO_POSITIONS = ['初', '二', '三', '四', '五', '上'];

/**
 * 三画卦的爻位 (自下而上, 1 = 阳) —— 跟《周易》后天八卦一致。
 *   乾 111 / 兑 110 / 离 101 / 震 100 / 巽 011 / 坎 010 / 艮 001 / 坤 000
 *
 * 为什么放在这儿 (术数模块) 而不是界面里: 「坎卦是哪三爻」是**卦理**,
 * 不是画法。画法归 design-system.css 的 .pg-yao, 卦理归这儿。
 * 第 149 批: 首屏的八卦将灵盘要用它, 六十四卦页的上下卦也要用它 ——
 * 一份卦理, 两处用, 不各写一份。
 */
export const TRIGRAM_BITS = {
  '乾': '111', '兑': '110', '离': '101', '震': '100',
  '巽': '011', '坎': '010', '艮': '001', '坤': '000',
};

/**
 * 三画卦 → 五行: 乾兑金 / 离火 / 震巽木 / 坎水 / 艮坤土。
 * 跟 TRIGRAM_BITS 同理 —— 「乾属金」是卦理, 不是界面样式, 放术数模块。
 * 2026-11-04: 原来在 meihua.mjs 里私有一份, 六十四卦页也要用 ⇒ 下沉到这里。
 */
export const TRIGRAM_WX = {
  '乾': '金', '兑': '金', '离': '火', '震': '木',
  '巽': '木', '坎': '水', '艮': '土', '坤': '土',
};

/**
 * 爻题的两种排法:
 *   初爻 / 上爻 → 位置在前: 初九 · 初六 · 上九 · 上六
 *   二~五爻     → 阴阳在前: 九二 · 六二 · 九三 · 六三 · 九四 · 六四 · 九五 · 六五
 */
const YAO_TITLE_RE = /^(初[九六]|[九六][二三四五]|上[九六])/;

/**
 * 切一条爻辞 → { title, body }。
 * title 为 null = 这条没带爻题。
 */
export function parseYao(yaoCi) {
  const text = typeof yaoCi === 'string' ? yaoCi : '';
  const m = YAO_TITLE_RE.exec(text);
  if (!m) return { title: null, body: text };
  const title = m[1];
  // 爻题后面的冒号和空白一并去掉(原文是全角「：」, 也可能是半角)
  const body = text.slice(title.length).replace(/^[：:]\s*/, '');
  return { title, body };
}

/**
 * 第 i 爻的阴阳。binary 自**初爻**起, 1 = 阳(九), 0 = 阴(六)。
 * @returns {boolean|null} null = 没有 binary 可依据
 */
export function yaoYinYang(binary, i) {
  if (typeof binary !== 'string' || !binary.length) return null;
  if (i < 0 || i >= binary.length) return null;
  return binary[i] === '1';
}

/**
 * 某卦第 i 爻(0 = 初爻)要显示成什么。
 * @returns {{label: string, body: string}} label = 爻题(初九/九二/…), body = 正文
 */
export function yaoEntry(yaoCi, binary, i) {
  const parsed = parseYao(yaoCi);
  if (parsed.title) return { label: parsed.title, body: parsed.body };

  // 数据里没带爻题 ⇒ 按 binary 推一个
  const pos = YAO_POSITIONS[i];
  const yang = yaoYinYang(binary, i);
  if (!pos || yang === null) return { label: '', body: parsed.body };
  const yy = yang ? '九' : '六';
  const label = (i === 0 || i === 5) ? pos + yy : yy + pos;
  return { label, body: parsed.body };
}

export default yaoEntry;
