'use strict';
const assert = require('node:assert/strict');
const { classifyRuntimeVerdict } = require('../modules/runtime_verdict');

assert.deepEqual(classifyRuntimeVerdict({ tools_used: ['task_done'], final_text: '已完成' }), { status: 'failed', success: false, real_tool_calls_total: 0 });
assert.equal(classifyRuntimeVerdict({ tools_used: ['exec_command'], final_text: '已执行命令并完成了真实核验。' }).status, 'completed');
assert.equal(classifyRuntimeVerdict({ tools_used: ['exec_command'], final_text: '已执行命令并完成了真实核验。', alignment_blocked: true }).status, 'failed');
assert.equal(classifyRuntimeVerdict({ tools_used: ['exec_command'], final_text: '本轮只完成部分核验，后续仍需继续。', task_done_status: 'failed' }).status, 'partial');
assert.equal(classifyRuntimeVerdict({ tools_used: ['exec_command', 'task_done'], final_text: '已完成真实核验，结果已经确认。', task_done_status: 'completed', task_done_accepted: false }).status, 'completed');
console.log('runtime verdict tests: ok');
