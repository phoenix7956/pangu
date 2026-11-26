/**
 * 64i/yao_title.js —— 爻题(爻位标签)的解析。
 *
 * ── 为什么它住在 core 而不是界面层 (2026-10-26 第 107 批) ──────────
 *   这条规则原本住在 `apps/desktop/src/lib/yao.js`。桌面端下线时它被搬到这里,
 *   理由是它自己的文件头就写着:「「爻题怎么写」是**术数规则**, 不是界面样式。」
 *   —— 而且六爻层的职责表(`modules/yao_layer_boundary.js` LAYER_BOUNDARY)
 *   明确写着六爻层管「爻位编号防错 + 爻值 6/7/8/9 + **引用爻辞原文**」。
 *   ⇒ 爻题规则属于**六爻层**, 归 64i 管; 界面只是它的一个消费者。
 *
 * ── 它修的是什么(2026-10-22 第 48 批, 老板 10-22 原话「我感觉64卦卦序有点问题」) ──
 *   ① 爻位阴阳判错 —— 旧代码扫**整条爻辞正文**找「九」字判断这爻是阳是阴:
 *        {yc.includes('九') ? '九' : '六'}
 *      震卦六二「震来厉, 亿丧贝, **跻于九陵**, 勿逐七日得」——
 *      正文里有个「九」, 于是六二爻被标成「九」。(全库 1/384 处, 就这一处。)
 *
 *   ② 爻题排列规则错 —— 旧代码按 `['初','二',…,'上'][i] + (九|六)` 拼:
 *        二爻拼成「二九」、三爻拼成「三九」……
 *      但通行爻题是**二至五爻阴阳在前**(九二/六二/九三/六三/九四/六四/九五/六五),
 *      只有**初爻与上爻**是位置在前(初九/初六/上九/上六)。(256/384 处全错。)
 *
 *   ③ 爻题前缀剥不掉 —— 旧代码用
 *        yc.replace(/^[初九|初六|九二|…][：:]/, '')
 *      字符类里的 `|` 是**字面竖线**不是「或」, 而且要求前缀后紧跟冒号;
 *      实际数据是「初九：潜龙勿用」这种两字前缀 ⇒ 一条也剥不掉。
 *      结果详情页显示成「二九九二：见龙在田」。(384/384 处全错。)
 *
 * 修法: **爻题从数据里读**。
 *   64i 的 384 条爻辞本来就以标准爻题开头(「初九：」「九二：」……),
 *   这部分已逐条核过(0 条不符)。按标准规则把它切出来,
 *   标签与正文就永远一致 —— 标签跟正文打架的那种错, 结构上就出不来了。
 *
 * 兜底: 万一某条爻辞没带爻题, 按 `binary` 推 —— binary 的第 i 位就是第 i 爻
 *   (0=初爻, 1=阳), 这条对 384 爻核过, 0 条不符。
 */

/** 六个爻位的位置字(自下而上: 初、二、三、四、五、上)。 */
const YAO_POSITIONS = ['初', '二', '三', '四', '五', '上'];

/**
 * 爻题的两种排法:
 *   初爻 / 上爻 → 位置在前: 初九 · 初六 · 上九 · 上六
 *   二~五爻     → 阴阳在前: 九二 · 六二 · 九三 · 六三 · 九四 · 六四 · 九五 · 六五
 */
const YAO_TITLE_RE = /^(初[九六]|[九六][二三四五]|上[九六])/;

/**
 * 切一条爻辞 → { title, body }。
 * @param {string} yaoCi 爻辞原文, 如「九二：见龙在田, 利见大人」
 * @returns {{title: string|null, body: string}} title 为 null = 这条没带爻题
 */
function parseYao(yaoCi) {
  const text = typeof yaoCi === 'string' ? yaoCi : '';
  const m = YAO_TITLE_RE.exec(text);
  if (!m) return { title: null, body: text };
  const title = m[1];
  // 爻题后面跟着的冒号和空白一并去掉(原文是全角「：」, 也可能是半角)
  const body = text.slice(title.length).replace(/^[：:]\s*/, '');
  return { title, body };
}

/**
 * 第 i 爻的阴阳。binary 自**初爻**起, 1 = 阳(九), 0 = 阴(六)。
 * @returns {boolean|null} null = 没有 binary 可依据
 */
function yaoYinYang(binary, i) {
  if (typeof binary !== 'string' || !binary.length) return null;
  if (i < 0 || i >= binary.length) return null;
  return binary[i] === '1';
}

/**
 * 某卦第 i 爻(0 = 初爻)要显示成什么。
 *
 * @param {string} yaoCi   爻辞原文
 * @param {string} binary  六位卦码(0=初爻), 兜底用
 * @param {number} i       爻位序号, 0=初爻 … 5=上爻
 * @returns {{label: string, body: string}} label = 爻题(初九/九二/…), body = 正文
 */
function yaoEntry(yaoCi, binary, i) {
  const { title, body } = parseYao(yaoCi);
  if (title) return { label: title, body };

  // 数据里没带爻题 ⇒ 按 binary 推一个
  const pos = YAO_POSITIONS[i];
  const yang = yaoYinYang(binary, i);
  if (!pos || yang === null) return { label: '', body };
  const yy = yang ? '九' : '六';
  const label = (i === 0 || i === 5) ? pos + yy : yy + pos;
  return { label, body };
}

module.exports = { YAO_POSITIONS, YAO_TITLE_RE, parseYao, yaoYinYang, yaoEntry };
