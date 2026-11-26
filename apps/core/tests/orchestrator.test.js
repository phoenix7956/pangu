'use strict';

const assert = require('node:assert/strict');
const Orchestrator = require('../agents/orchestrator');

async function main() {
  const source = 'code review: const value = eval(input);';
  const review = new Orchestrator();
  let scannedCode = '';
  review.roles.li = { execute: async () => ({ ok: true }) };
  review.roles.kan = {
    execute: async () => ({ ok: true, subTasks: [
      { agent: 'li', task: '分析代码结构' },
      { agent: 'xun', task: '安全/bug扫描' },
      { agent: 'dui', task: '代码规范检查' },
    ] }),
  };
  review.roles.xun = {
    execute: async input => {
      scannedCode = input.code;
      return { status: 'success', bugs: [{ type: 'eval_usage' }] };
    },
  };
  review.roles.dui = { execute: async () => ({ ok: true }) };
  const reviewResult = await review.execute(source, {});
  assert.equal(scannedCode, source);
  assert.equal(reviewResult.success, true);

  const general = new Orchestrator();
  let executorCalls = 0;
  general.roles.li = { execute: async () => ({ ok: true }) };
  general.roles.kan = {
    execute: async () => ({ ok: true, subTasks: [
      { agent: 'li', task: '分析需求' },
      { agent: 'kun', task: '执行任务' },
      { agent: 'dui', task: '验证结果' },
    ] }),
  };
  general.roles.kun = { execute: async () => { executorCalls++; return { ok: true }; } };
  general.roles.dui = { execute: async () => ({ ok: true }) };
  const generalResult = await general.execute('implement a feature', {});
  assert.equal(executorCalls, 0, 'natural-language placeholder must not run as echo or shell command');
  assert.equal(generalResult.success, false, 'missing executable command must not report task success');
  // 2026-10-18 拼音统一: results 的键跟角色名同源 (原 executor)。
  assert.equal(generalResult.results.kun.error, 'EXECUTABLE_COMMAND_MISSING');

  process.stdout.write('orchestrator.test.js: PASS\n');
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
