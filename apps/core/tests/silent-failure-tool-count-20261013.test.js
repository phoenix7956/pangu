const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

// ===========================================================================
// 2026-10-13 现场证据 (probe ar2-0009, SSE 全量 dump + 磁盘核对):
//   主人: "创建 5 个文件…要求每一步都真读真写,不许只说。"
//   盘古真的干了活: 20+ 次 exec_command, 5 个文件 + summary.txt 全部真实落盘,
//                   内容互不相同的中文, 逐个 read_file 读回。
//   但中途推给主人一条 warning:
//     "⚠️ [Silent Failure / 本轮未收口] 我跑了 2 轮没调 task_done…
//      已做工具: 0 (无)"
//   —— 与同一轮的 tools_used(20+ 个 exec_command) 直接矛盾。
//
// 根因: 代码里**已经算好了**正确变量 effectiveRealToolsCalled
//   (3120 行, 注释明写 toolsUsed 在 native 轮"会滞后", 要用 toolHistory 兜底),
//   而且它在 3136/3140/3275/3406/3527 等 7 处都被正确使用 ——
//   唯独 3194 行那句**用户可见的文案**用了错误的 realToolsCalled。
//   典型的"修复算对了, 却没接到出口"。
// 危害: 主人刚看到一堆工具在跑, 紧接着被告知"已做工具: 0 (无)" ——
//       进度显示自相矛盾, 主人无法判断该不该说"继续", 断点续跑也就无从判断。
// ===========================================================================
const SRC = fs.readFileSync(require.resolve('../modules/j2_agent_loop.js'), 'utf8');

// 2026-10-13 更新: 文案已抽成纯函数 _buildSilentFailureMsg(rounds, toolsUsed, planSnapshot),
// 工具计数与名清单都由这个入参渲染。形式变了, **意图不变**:
// 用户可见的工具计数必须来自 effectiveRealToolsCalled (toolsUsed/realToolsCalled 在 native 轮滞后, 用它会报 0),
// 否则主人会看到"已做工具: 0 (无)"。现在这个约束落在调用点的传参上。
test('Silent Failure 的"已做工具"必须由 effectiveRealToolsCalled 驱动', () => {
  const m = SRC.match(/_buildSilentFailureMsg\(rounds, [^,]+, _planSnapshot\)/);
  assert.ok(m, '应能找到 Silent Failure 文案的构造调用');
  assert.match(m[0], /effectiveRealToolsCalled/,
    '已做工具必须用 effectiveRealToolsCalled (toolsUsed/realToolsCalled 在 native 轮滞后, 用它会报 0)');
  assert.doesNotMatch(m[0], /realToolsCalled(?!\s*[,)])/,
    '不得在用户可见文案里用会滞后的 realToolsCalled');
});

test('工具名清单也必须由同一个入参渲染 (不得恒为"无")', () => {
  const fn = SRC.match(/function _buildSilentFailureMsg[\s\S]{0,2000}?\n}/);
  assert.ok(fn, '应能找到文案构造函数');
  assert.match(fn[0], /'已做工具: ' \+ tools\.length/,
    '计数必须用传入的 tools');
  assert.match(fn[0], /tools\.slice\(0, 6\)\.join/,
    '名清单必须也来自同一个入参, 否则清单恒为"无"');
});

test('effectiveRealToolsCalled 必须在该文件里被真正使用(不是算了就扔)', () => {
  assert.match(SRC, /const effectiveRealToolsCalled =/,
    '必须定义 effectiveRealToolsCalled');
  const uses = (SRC.match(/effectiveRealToolsCalled/g) || []).length;
  assert.ok(uses >= 3, `effectiveRealToolsCalled 应多处使用, 实际只出现 ${uses} 次`);
});
