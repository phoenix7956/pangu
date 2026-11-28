'use strict';
/**
 * tests/helpers/wuxing_color.js —— 五行配色唯一真源 (第 128 批)
 *
 * ## 这套配色是什么
 *   老板 10-27 拿 macOS 取色器, 在**课件《喜用忌必查詢表》正文那五个五行字**上
 *   逐个采的色, 一个值都不许改 (我自作主张调明暗被当场打回过两次):
 *
 *       木 #00FF1D   火 #FF0000   土 #B28C21   金 #FFEE00   水 #0E70F2
 *
 *   第 127 批: 这套色当**色块底色**用 (五行身份色, 三套主题完全一致)。
 *   第 128 批: 老板说「不用块直接用颜色的字」⇒ 五行改成**字色**;
 *   紧接着又把字色打回: 「第一张浅色的字体颜色不对, 第二张黑色字体颜色对」——
 *   我上一版自己压暗 (#0F9E38/#7A4A1E/#B8860B) 是「自己定的规矩」, 课件没这色。
 *   老板最后拍板: 「木 #00FF1D / 火 #FF0000 / 土 #B28C21 / 金 #FFEE00 / 水 #0E70F2。
 *   **全都按这个, 别搞了**」⇒ **三套主题的字色一律 = 这五个原值**, 不许有变体。
 *
 *   三档各司其职 (这是第 127 批的核心, 别再混):
 *     --xxx     色块底色 = 老板原值 (五行身份色, 三套主题完全一致)
 *     --on-xxx  写在这个块上面的字色 (对自己的块 ≥ 4.5:1)
 *     --xxx-ink **文字档**: 直接写在卡底上的五行字 (第 128 批起排盘表五行就是字色)
 *               = 老板原值, 三套主题完全一致 (不许按主题另调一版)
 *
 * ## 为什么把色板放这里
 *   三个守卫文件 (material / solid / xiji) 都要算同一套颜色:
 *     对比度 (WCAG 相对亮度)、CIELAB ΔE (颜色差多少的真口径)、主题令牌解析。
 *   各抄一份 ⇒ 改一次色板要改三处, 迟早漏一处, 漏的那处会静悄悄地放行。
 */

const fs = require('fs');
const path = require('path');

const WEB = path.join(__dirname, '..', '..', 'web', 'app');
const THEMES = path.join(WEB, 'themes.css');
const BAZI_CSS = path.join(WEB, 'views', 'bazi.css');

const WX_VAR = { 木: 'wood', 火: 'fire', 土: 'earth', 金: 'metal', 水: 'water' };
const NAMES = ['木', '火', '土', '金', '水'];

/**
 * 第 127 批色板 —— 老板在课件上采的五原值。
 *
 * **色块色三套主题完全一样**: 五行身份不随主题漂, 页面上下更不会差一档。
 * 只有 ink (文字档) 随主题的卡片底色走 —— 那是「写在白底上的字」, 不是五行身份。
 */
const BOSS = {
  木: '#00FF1D', 火: '#FF0000', 土: '#B28C21', 金: '#FFEE00', 水: '#0E70F2',
};

/** 块上字色: 木/火/土/金 用黑字, 水用白字 (实测 4.95/4.95/6.28/16.48/4.55)。 */
const ON = {
  木: '#0A0A0A', 火: '#0A0A0A', 土: '#0A0A0A', 金: '#0A0A0A', 水: '#FFFFFF',
};

/**
 * 第 180-193 批 (2026-11-18, 老板 8 连拍): 四个 ui 主题五行色统一成**可读值**,
 * 修「浅色主题下五行色看不清」。:root 仍守老板 10-27 采的五原值 (BOSS), 但
 *   [data-theme] 的 themed 块 (dark/light/iron/gold) 全用这套可读值。
 * 五行底色 = ink 字色同值 (可读版把 ink 也拉平到本色, 不再压暗/提亮)。
 */
const THEMED = {
  木: '#0B7A3B', 火: '#C22A1E', 土: '#6E5A4A', 金: '#C99700', 水: '#0E5FD8',
};

const PALETTE = {
  light: {
    card: '#FBFCFB',
    木: '#00FF1D', 火: '#FF0000', 土: '#B28C21', 金: '#FFEE00', 水: '#0E70F2',
    on: { 木: '#0A0A0A', 火: '#0A0A0A', 土: '#0A0A0A', 金: '#0A0A0A', 水: '#FFFFFF' },
    // 文字档 (第 128 批): = 老板原值, 一个字都不许改。
    // ⚠ 木对浅卡底只有 1.33:1 / 金 1.17:1 —— **老板知情拍板**:
    //   「全都按这个, 别搞了」。课件《喜用忌必查詢表》《排盘样例》自己就这画法。
    //   ⇒ **不许再自作主张压暗/提亮** (前两版都被打回过)。
    ink: { 木: '#00FF1D', 火: '#FF0000', 土: '#B28C21', 金: '#FFEE00', 水: '#0E70F2' },
  },
  dark: {
    card: '#192421',
    木: '#00FF1D', 火: '#FF0000', 土: '#B28C21', 金: '#FFEE00', 水: '#0E70F2',
    on: { 木: '#0A0A0A', 火: '#0A0A0A', 土: '#0A0A0A', 金: '#0A0A0A', 水: '#FFFFFF' },
    ink: { 木: '#00FF1D', 火: '#FF0000', 土: '#B28C21', 金: '#FFEE00', 水: '#0E70F2' },
  },
  gold: {
    card: '#20241F',
    木: '#00FF1D', 火: '#FF0000', 土: '#B28C21', 金: '#FFEE00', 水: '#0E70F2',
    on: { 木: '#0A0A0A', 火: '#0A0A0A', 土: '#0A0A0A', 金: '#0A0A0A', 水: '#FFFFFF' },
    ink: { 木: '#00FF1D', 火: '#FF0000', 土: '#B28C21', 金: '#FFEE00', 水: '#0E70F2' },
  },
};

// 老板点名的那一对: 火-土 ≥ 40 (以前深底上只有 13), 土-金 ≥ 30。
const MIN_DELTA_HUO_TU = 40;
const MIN_DELTA_TU_JIN = 30;
const MIN_DELTA_ANY = 25;
const MIN_CONTRAST = 4.5;

function hexToRgb(hex) {
  const h = String(hex).trim().replace('#', '');
  if (!/^[0-9A-Fa-f]{6}$/.test(h)) throw new Error('颜色必须是 6 位 hex: ' + hex);
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

function relLum(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG 对比度。 */
function contrastRatio(a, b) {
  const l1 = relLum(a), l2 = relLum(b);
  const hi = Math.max(l1, l2), lo = Math.min(l1, l2);
  return (hi + 0.05) / (lo + 0.05);
}

// sRGB → CIELAB (D65)。ΔE 才是「颜色差多少」的真口径 ——
// RGB 距离会把「深赭褐」和「深金黄」算成差不多, 实际上一眼就分得出。
function hexToLab(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : Math.pow((s + 0.055) / 1.055, 2.4);
  });
  const X = r * 0.4124 + g * 0.3576 + b * 0.1805;
  const Y = r * 0.2126 + g * 0.7152 + b * 0.0722;
  const Z = r * 0.0193 + g * 0.1192 + b * 0.9505;
  const f = (t) => (t > 0.008856 ? Math.cbrt(t) : 7.787 * t + 16 / 116);
  const fx = f(X / 0.95047), fy = f(Y / 1.0), fz = f(Z / 1.08883);
  return [116 * fy - 16, 500 * (fx - fy), 200 * (fy - fz)];
}

function deltaE(a, b) {
  const l = hexToLab(a), m = hexToLab(b);
  return Math.sqrt((l[0] - m[0]) ** 2 + (l[1] - m[1]) ** 2 + (l[2] - m[2]) ** 2);
}

function hue(hex) {
  const [r, g, b] = hexToRgb(hex).map((v) => v / 255);
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const d = max - min;
  if (d === 0) return -1;
  let h;
  if (max === r) h = 60 * (((g - b) / d) % 6);
  else if (max === g) h = 60 * ((b - r) / d + 2);
  else h = 60 * ((r - g) / d + 4);
  if (h < 0) h += 360;
  return h;
}

/**
 * 解析 themes.css 里三套主题的五行令牌。
 *
 * `--xxx-ink: var(--xxx)` 这种间接引用会被**解引用**成同一个 hex ——
 * 第 126 批的核心契约就是「一个五行一个颜色」, 解析器不认这个就守不住。
 *
 * ⚠ 2026-10-31 第 180 批: 五行色板**不在主题块里**了。
 *   第 166 批 (db7341d, 界面重写) 把 `--wood/--fire/--earth/--metal/--water`
 *   搬进了 `:root` 一处 —— themes.css 自己的铁律①写着:
 *     「五行身份不随主题漂。所以它们只写在 :root 一处。」
 *   旧解析器只扫 `[data-theme="..."]` 块 ⇒ 三套主题一个都认不出 ⇒
 *   三个颜色守卫(119w / 122w / 128w)从第 166 批起**一直红着**,
 *   只是被 test:chain 的 `&&` 短路掩盖了(它在第 301 段之后才轮到这几个文件)。
 *   ⇒ 现在的口径: **主题块里的值优先, 主题块没有就回落 :root** ——
 *     共享的五行色 ⇒ 三套主题解析出**同一个**色板, 守卫照样成立。
 */
function themeWxVars(css) {
  const out = [];
  // :root 里的基础令牌 (第 166 批起五行色在这里)
  const rootMatch = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  const rootBody = rootMatch ? rootMatch[1] : '';
  const re = /\[data-theme="([a-z]+)"\]\s*\{([\s\S]*?)\n\}/g;
  let m;
  while ((m = re.exec(css)) !== null) {
    const b = m[2];
    const grab = (name) => {
      // 主题块优先, 没有就回落 :root (五行色三主题共享, 就走这条)
      for (const body of [b, rootBody]) {
        if (!body) continue;
        const direct = body.match(new RegExp('--' + name + ':\\s*(#[0-9A-Fa-f]{6})'));
        if (direct) return direct[1];
        const ref = body.match(new RegExp('--' + name + ':\\s*var\\(\\s*--([a-z0-9-]+)\\s*\\)'));
        if (!ref) continue;
        const inner = body.match(new RegExp('--' + ref[1] + ':\\s*(#[0-9A-Fa-f]{6})'));
        if (inner) return inner[1];
      }
      return null;
    };
    const wx = {
      木: grab('wood'), 火: grab('fire'), 土: grab('earth'),
      金: grab('metal'), 水: grab('water'),
    };
    const ink = {
      木: grab('wood-ink'), 火: grab('fire-ink'), 土: grab('earth-ink'),
      金: grab('metal-ink'), 水: grab('water-ink'),
    };
    const on = {
      木: grab('on-wood'), 火: grab('on-fire'), 土: grab('on-earth'),
      金: grab('on-metal'), 水: grab('on-water'),
    };
    wx.__ink = ink;
    wx.__on = on;
    wx.__theme = m[1];
    wx.__card = grab('card');
    if (wx.木 && wx.火 && wx.土 && wx.金 && wx.水) out.push(wx);
  }
  return out;
}

/** 取 CSS 里某个选择器的规则块正文 (没有就返回空串)。 */
function ruleBody(css, selector) {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp('(?:^|[}\\s])' + esc + '\\s*\\{([^}]*)\\}', 'm');
  const m = css.match(re);
  return m ? m[1] : '';
}

module.exports = {
  WEB, THEMES, BAZI_CSS, WX_VAR, NAMES, PALETTE, BOSS, ON, THEMED,
  MIN_DELTA_HUO_TU, MIN_DELTA_TU_JIN, MIN_DELTA_ANY, MIN_CONTRAST,
  hexToRgb, relLum, contrastRatio, hexToLab, deltaE, hue,
  themeWxVars, ruleBody,
};
