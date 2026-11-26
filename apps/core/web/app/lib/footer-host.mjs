// footer-host.mjs —— 设置页那条「保存」操作栏的落脚点 (第 138 批)
//
// 起因: 原来的操作栏是 `position: sticky; bottom: 0` **贴在滚动区里**的。
//   它浮在内容上面 ⇒ 实时状态卡片最后两行 (工具加载 / 降级) 被它整段盖住,
//   界面看起来像"表格被切了一刀"。而且 sticky 悬浮条天然要盖内容 ——
//   想不盖, 就得让它**不在滚动流里**。
//
// 做法: 设置页的壳 (views/settings.mjs) 额外开一条**页脚槽**,
//   滚动区归滚动区, 页脚归页脚, 两者互不重叠。
//   子页面 (connect / ui / agent) 通过本模块拿到那条页脚槽, 把操作栏放进去。
//
// 为什么用一个小模块而不是让子页面 import settings.mjs:
//   settings.mjs 动态 import 子页面, 子页面再 import settings.mjs = 循环依赖。
//   这个模块两边都不依赖, 谁都能进。

let host = null;

/** 设置页的壳在渲染子页面前调一次, 把页脚槽交出来。 */
export function setFooterHost(el) {
  host = el || null;
}

/** 拿页脚槽; 没有 (比如子页面被单独预览) 时返回 null。 */
export function getFooterHost() {
  return host;
}

export default { setFooterHost, getFooterHost };
