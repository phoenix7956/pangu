const test = require('node:test');
const assert = require('node:assert/strict');
const { wantsDirectAnswer } = require('../modules/j2_loop_shared');
const fs = require('node:fs');

// ===========================================================================
// 2026-10-13 现场证据 (probe ar-0006, SSE 全量 dump):
//   主人: "在 /tmp/pangu_ar/ 目录下创建 5 个文件 f1.txt 到 f5.txt,每个文件写入
//          不同的中文内容,然后逐个读回确认,最后汇总成一份清单写进 summary.txt。
//          要求每一步都真读真写,不许只说。"
//   盘古: mode=direct_answer, tools_used=[], 2.0 秒, 什么都没干。
//         答复原话: "当前环境未提供可用的文件写入工具调用能力,因此本次未能实际
//                    创建文件、逐个读回或生成 summary.txt。"
//         终态却是 status=completed, success=true。   ← 两处都是 bug
//
// Bug A (既有正则缺陷, 被直答短路放大成灾难):
//   DIRECT_ANSWER_RE 里有 只(回答|答|输出|说), 于是命中 "不许只说" / "不要只说明"。
//   但 "不许只说" = "别光说, 去干活", 意思与直答**相反**。
//   修复前这类误判只是白烧编排; commit b8864a7 的直答短路让它直接不干活。
//   → 正则必须识别否定辖域: 只X 前面有 不许/不要/别/禁止/不能 时不判直答。
//
// Bug B (b8864a7 引入的回归):
//   resDone 的 direct_answer 豁免只看"是不是占位文案", 没看"答复是否自认失败"。
//   "本次未能实际创建文件" 这种如实交代没干活的答复, 被判成 success:true ——
//   比原 bug 更坏: 主人看到绿勾, 实际一个文件都没建。
// ===========================================================================

test('Bug A: "不许只说"/"不要只说明" 是要干活, 绝不能判成直答', () => {
  const mustWork = [
    '创建 5 个文件然后读回确认,要求每一步都真读真写,不许只说。',
    '把剩下的活干完,不许只说不做',
    '写个脚本,不要只说明',
    '别只说,直接动手',
    '不要只说不做,先去把文件建出来',
  ];
  for (const t of mustWork) {
    assert.equal(wantsDirectAnswer(t), false, `这是要干活, 不该判直答: ${t}`);
  }
});

test('Bug A: 真正的直答请求仍必须判直答 (别修过头)', () => {
  const really = [
    '只回答我的名字,不要调用任何工具',
    '只回答这两个,不要调用任何工具',
    '别调用工具,直接说结论',
    '2+2 等于几?直接答。',
    '我叫什么?只答这一项。',
  ];
  for (const t of really) {
    assert.equal(wantsDirectAnswer(t), true, `应判直答: ${t}`);
  }
});

test('Bug B: 直答轮答复自认"没干活"时, 绝不能判 success', () => {
  const src = fs.readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
  // direct_answer 豁免必须同时要求: 有实质答复 且 未自认失败
  assert.match(src, /mode === 'direct_answer'[\s\S]{0,900}?_answerAdmitsIncomplete/,
    'direct_answer 判分豁免必须检查 _answerAdmitsIncomplete (答复自认失败就不算成功)');
});

test('Bug B: "未能X" 这种如实交代必须被识别为自认未完成', () => {
  const src = fs.readFileSync(require.resolve('../modules/j2_dispatcher.js'), 'utf8');
  const m = src.match(/_INCOMPLETE_ADMISSION_RE = \/([\s\S]*?)\/;/);
  assert.ok(m, '应能找到 _INCOMPLETE_ADMISSION_RE');
  const rx = new RegExp(m[1]);
  const admissions = [
    '当前环境未提供可用的文件写入工具调用能力,因此本次未能实际创建文件、逐个读回或生成 summary.txt。',
    '本次未能写入任何文件。',
    '未能完成全部 5 个文件的创建。',
    '我没有实际执行写盘。',
  ];
  for (const t of admissions) {
    assert.ok(rx.test(t), `自认未完成应被识别: ${t}`);
  }
});
