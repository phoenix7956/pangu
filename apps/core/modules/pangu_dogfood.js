// modules/pangu_dogfood.js — N5 refactor batch B7
// _handlePanguDogfood — Pangu self-dogfood (8 子 agent 串联, 自动扫+修自己)
// 依赖: 通过 init(deps) 注入 (_recordEvolution, _agentRegistry)

const fs = require('fs');
const path = require('path');

let _deps = null;

function init(deps) {
  _deps = deps;
}

async function _handlePanguDogfood(req, res) {
  const t0 = Date.now();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  function emit(event, data) {
    res.write('event: ' + event + '\n');
    res.write('data: ' + JSON.stringify(data) + '\n\n');
  }

 // 修: 真正调用 agents/ 下 8 子 agent 模块
  const agents = _agentRegistry;
  if (!agents || !agents.xun) {
    emit('error', { ok: false, error: 'Agent registry not initialized' });
    return res.end();
  }

// 修 (2026-10-14): 原来写的是 modules/pangu-single.js —— 那个文件从来不存在,
// 真的在 apps/core/pangu-single.js (modules/ 下只有 pangu-single/ 目录)。
// 旧路径的 ENOENT 被下面那个 try 吃掉, dogfood 模式一直静默地什么都没扫。
const targetFile = path.join(__dirname, '..', 'pangu-single.js');
  const fileContent = fs.readFileSync(targetFile, 'utf8');

  try {
    emit('start', { ts: new Date().toISOString(), message: 'Pangu self-dogfood 开始 (真实 agent 模块)' });

    emit('step', { agent: 'xun', status: 'running', message: '静态扫描代码...' });
// 传 file/root → 走 finding_gate 接地校验, 只用能回真实文件复核过的发现
const bugResult = await agents.xun.execute({
code: fileContent,
language: 'javascript',
file: path.relative(path.resolve(__dirname, '..', '..', '..'), targetFile),
root: path.resolve(__dirname, '..', '..', '..'),
});
    emit('step_done', { agent: 'xun', bugs_found: bugResult.total || 0, sample: (bugResult.bugs || []).slice(0, 3) });

    emit('step', { agent: 'zhen', status: 'running', message: '评估严重性...' });
    const reflection = await agents.zhen.execute({ output: bugResult, context: { total: bugResult.total, by_severity: bugResult.by_severity } });
    emit('step_done', { agent: 'zhen', score: reflection.score, strengths: reflection.strengths, weaknesses: reflection.weaknesses });

    emit('step', { agent: 'kan', status: 'running', message: '拆修复任务...' });
    const plan = await agents.kan.execute({ type: 'decompose', goal: `修复 ${bugResult.total || 0} 个 bug` });
    emit('step_done', { agent: 'kan', strategy: plan.strategy || '按 severity 优先级修复', subTasks: (plan.subTasks || []).length });

    emit('step', { agent: 'kun', status: 'running', message: '实际改文件...' });
    let executorResult = { fixed: 0, skipped: 0, details: [] };
    if (bugResult.bugs && bugResult.bugs.length > 0) {
      // 简单修复:把前 3 个 console.log 改成条件 logger
      const fixes = bugResult.bugs.slice(0, 3).filter(b => b.type === 'console_in_prod');
      for (const b of fixes) {
        try {
          const line = fileContent.split('\n')[b.line - 1] || '';
          const oldText = line;
          const newText = line.replace(/console\.(log|debug|info)\s*\(/, 'if (process.env.PANGU_DEBUG) console.$1(');
          if (oldText !== newText) {
            const edit = await agents.kun.execute({
              type: 'edit_file',
              path: targetFile,
              oldText,
              newText
            });
            executorResult.details.push({ line: b.line, result: edit });
            if (edit.ok) executorResult.fixed++;
            else executorResult.skipped++;
          } else {
            executorResult.skipped++;
          }
        } catch (e) {
          executorResult.skipped++;
        }
      }
    }
    emit('step_done', { agent: 'kun', fixed: executorResult.fixed, skipped: executorResult.skipped, details: executorResult.details.slice(0, 5) });

    emit('step', { agent: 'dui', status: 'running', message: '验证修复...' });
    const checkerResult = await agents.dui.execute({ type: 'review_code', filePath: targetFile });
    emit('step_done', { agent: 'dui', ok: checkerResult.ok, issues: (checkerResult.data && checkerResult.data.issues) || [] });

    const totalDurationMs = Date.now() - t0;
    const fullReport = {
      bugs_found: bugResult.total || 0,
      by_severity: bugResult.by_severity || {},
      reflection_score: reflection.score,
      plan_subtasks: (plan.subTasks || []).length,
      fixed: executorResult.fixed,
      skipped: executorResult.skipped,
      checker_ok: checkerResult.ok,
      total_duration_ms: totalDurationMs
    };

    emit('step', { agent: 'gen', status: 'running', message: '记录到 evolution...' });
    const learnerResult = await agents.gen.execute({ type: 'learn', experience: { task: 'dogfood', ...fullReport, synthesis: { pass: checkerResult.ok } } });
    emit('step_done', { agent: 'gen', recorded: learnerResult.experience_recorded, total: learnerResult.total_experiences });

    emit('step', { agent: 'qian', status: 'running', message: '终结...' });
    const dispatchResult = await agents.qian.execute({ goal: '总结 dogfood 结果', context: fullReport });
    emit('step_done', { agent: 'qian', task_done: true, summary: (dispatchResult && dispatchResult.summary) || 'Dogfood 完成' });

    emit('done', {
      ok: true,
      ts: new Date().toISOString(),
      total_duration_ms: totalDurationMs,
      full_report: fullReport
    });
    res.end();
  } catch (e) {
    emit('error', { ok: false, error: e.message, stack: (e.stack || '').slice(0, 500) });
    res.end();
  }
}
module.exports = {
  init,
  _handlePanguDogfood,
};
