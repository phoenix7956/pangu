'use strict';

// 2026-10-19 老板: 「是出来了, 但是还是两个agent在跑」
//                  「这就是修的? 会话只能做一件事?」
//
// 现场 (会话 15764258, 浏览器实拍) —— 答复已经完整上屏, 下面那排将灵却永远停在
// 「坎·拆 运行中 组织回答中」/「乾·调度 运行中 组织回答中」, 发送键锁在「推演中…」。
//
// 本地实测复现 (probe3-1792416217, curl 抓原始 SSE, 不是猜):
//   3 条 sub_agent_start (li/kun/dui) + 3 条 sub_agent_done  —— 真刀, 收支平衡 ✔
//   14 条 sub_agent_progress{agent:"kan"}                      —— **0 条 start / 0 条 done**
//   综合阶段还有 sub_agent_progress{agent:"qian", task:""}      —— 同样 0 start / 0 done
//
// 根因: sub_agent_progress 被当**两件事**在用。
//   ① 真子 agent 的活性 (li/kun/dui) —— 被 sub_agent_start/done 包着, 收支平衡, 没事。
//   ② 主循环自己的两个**阶段**的活性:
//        坎 = 主 agent 拆解刀 (j2_dispatcher.js:1606 `_makeSinkRes(res,'kan',userInput)`)
//        乾 = 综合收口刀   (j2_dispatcher.js:934 `_synthesizeStreamText(..., 'qian')`)
//      这两处只发 progress 帧, **从来不发 start/done** ——
//      而前端的建卡逻辑挂在 sub_agent_start 上, 认不到卡时的兜底是"按角色建一张 progressOnly 卡"。
//      于是凭空多出两张 status:'running' 的卡, 而**没有任何事件能让它们离开 running**。
//
// 代价不只是两行字: 面板据此报「已派 5 路」, 而 dispatcher 实际只派了 3 刀
// (日志原文: 「主 agent 自拆 3 刀 (跳过坎·kan): li → kun → dui」) ——
// 老板盯的「盘古是不是活着, 是不是能交付」在这里**说谎**: 虚报 2 路, 且那 2 路永远不收工。
//
// 修法两层:
//   服务端 —— 给这两个阶段补上真正的收尾事件 (它们确实干了活, 该记完成)。
//   前端   —— 一条**结构不变量**: 本轮流结束时, 不许还有 status==='running' 的卡。
//            这层是兜底, 因为「每处 progress 都记得配一个 done」是口头约定, 不是机制;
//            下一处再漏一个, 界面又会卡成上次那样 (同一个坑 2026-10-19 已踩两次)。
//            教训: 注释 ≠ 隔离, 约定 ≠ 机制。

const { test } = require('node:test');
const assert = require('node:assert');
const path = require('node:path');
const fs = require('node:fs');

const DISPATCHER = fs.readFileSync(
  path.join(__dirname, '..', 'modules', 'j2_dispatcher.js'), 'utf8');

// 注释会骗过文本断言 —— 踩坑日志 2026-10-19: 扫源码前必须剥注释。
function stripComments(src) {
  return String(src)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1 ');
}
const DISP = stripComments(DISPATCHER);

// ⚠ 2026-10-26 第 107 批 (桌面端下线): 这条守卫原来有**两半**。
//   前端那一半 (S0~S5: 前端收尾模块 `closeStrandedAgents` + ChatRoom 必须在 finally 里调它)
//   随 `apps/desktop` 一起下线了 —— 前端兜底已**过时**: 服务端早就给每个
//   `sub_agent_progress` 补了对应的 `sub_agent_done` / `sub_agent_error`
//   (见下面 S6~S8, 它们守的就是这件事)。
//   ⇒ 服务端那一半**必须留** —— 它守的是「每个 progress 都有 done」这条真不变量,
//   而这条不变量跟有没有界面**无关**。
//
// ⚠⚠ 删掉前端那一半时踩过的坑, 记在这里防止下一个人再犯:
//   「文件不存在就跳过」是最阴的写法 —— 守卫会**静默失去作用**而自己还是绿的。
//   本文件现在是「服务端那一半原样保留」, 不是「前端那半改成条件跳过」。
//   ⇒ 凡是靠读某个文件来守的守卫, 那个文件消失时必须**让守卫报红**, 不许静默放过。

// ---- 接线测试: 服务端两个阶段补上真收尾 ------------------------------
test('S6 拆解刀 (坎) 收工必须发 sub_agent_done, 不许只发 progress', () => {
  // 锚在真实结构上, 不用定长字符窗口 (教训: 加几行注释窗口就自己炸了)。
  const m = DISP.match(
    /主 agent 自拆[\s\S]{0,900}?sub_agent_(done|error)'\s*,\s*\{\s*agent:\s*'kan'/);
  assert.ok(m,
    '主 agent 自拆这条路发完 progress 就走了, 没有 sub_agent_done —— 坎·拆 那张卡永远收不了工');
});

test('S7 综合刀 (乾) 收工必须发 sub_agent_done —— 收尾事件要盖住 progress', () => {
  // _synthesizeStreamText 里的 qian progress 帧是唯一给主人报「还在写」的信号,
  // 删它等于回到「跟死了一样」。所以要求的是**补收尾**, 不是删活性。
  const qianTick = DISP.indexOf("agent: label || 'qian'");
  assert.ok(qianTick > -1, '综合阶段的 progress 帧找不到了 —— 判据位置变了, 重新对');
  const after = DISP.slice(qianTick, qianTick + 3000);
  assert.ok(/sub_agent_done'\s*,\s*\{\s*agent:\s*(label|'qian')/.test(after),
    '综合结束必须发 sub_agent_done(qian) —— 否则乾·调度 那张卡永远收不了工');
});

test('S8 拆解刀失败也要收口 (error), 不能只记账本不发事件', () => {
  // 第一版写成 /sub_agent_(done|error)'\s*,\s*\{\s*agent:'kan'/ —— 结果 S6 那条
  // **成功**路径的 done 也照样命中, 于是把失败路径的收尾整段删掉, 测试依然全绿
  // (反向锁 D 抓出来的: 断言写了, 但它没在守自己声称要守的那件事)。
  // 现在锚在**失败分支的记账本那一行**上, 并要求它附近必须有 error 事件 ——
  // 「记账了但界面不知道」正是 2026-10-19 已经付过一次代价的那个坑。
  const rec = DISP.indexOf("record({ kind: 'error', code: 'kan'");
  assert.ok(rec > -1, 'planner 失败分支的记账本记录找不到了 —— 判据位置变了, 重新对');
  const after = DISP.slice(rec, rec + 700);
  assert.ok(/sub_agent_error'\s*,\s*\{\s*agent:\s*'kan'/.test(after),
    'planner 炸了必须发 sub_agent_error(kan) —— 只记账本不发事件的话, '
    + '前端那张坎·拆的卡还开着, 「炸了」和「还在跑」在界面上长得一模一样');
});
