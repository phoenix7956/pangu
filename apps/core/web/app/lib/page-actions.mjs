// page-actions.mjs —— 页面级动作的落脚点 (第 170 批)
//
// 起因: 设置页的「保存」按钮原来住在**页脚槽**里, 右对齐浮在内容区底部 ——
//   一眼像后台管理系统的悬浮操作条, 而且页面一长就离内容很远。
//   主流 agent (ChatGPT / Linear / Vercel) 的做法: **页面级动作放页头右上角**,
//   页头吸顶, 动作永远看得见、也永远在内容旁边。
//
// 跟 footer-host 是同一类东西 (壳开一个槽, 子页往里放东西), 只是位置不同。
// 为什么不合并: footer-host 的槽在滚动区**外面** (页脚), 这个在滚动区**里面**
//   (页头, 靠 sticky 吸住)。两件事, 两个模块。

let host = null;

/** 设置页的壳在渲染子页面前调一次, 把页头动作槽交出来。 */
export function setPageActionHost(el) {
  host = el || null;
}

/** 拿页头动作槽; 没有 (子页面被单独预览) 时返回 null。 */
export function getPageActionHost() {
  return host;
}

export default { setPageActionHost, getPageActionHost };
