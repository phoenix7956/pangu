// 2026-10-16 子 agent 的零产出闸门 —— "跟死了一样"的机制
//
// 现场 lt2-1792137648743: planner 想满 500 秒, thinking 从 0 涨到 11280 字,
// 正文**一个字都没有**, 屏幕上什么也没有, 而请求永远不超时:
//   sub-agent.js 的 http.request `timeout` 是**空闲**超时 (注释里写明是刻意的:
//   "正在生成的本地模型不会被砍, 只有真卡死才熔断"), 而 runaway 每秒都在吐
//   thinking delta —— 空闲计时器被无限重置, 于是那条取舍漏掉了这一类:
//   **持续吐字节、却零产出**的长考。
//
// 为什么按"零产出时长"判, 不按 thinking 字符数判 —— 实测四轮:
//   正常那轮  峰值 thinking 11567, 73.3s 出正文, planner 118s 出计划
//   runaway   峰值 thinking 11280, 500s+ 仍是 0
// 量级几乎一样, 字符数区分不出来; 能区分的只有"多久没吐过正文"。
// 正常最晚的一轮 182.4s 出正文, 阈值给 300s, 对最坏健康样本 1.6 倍余量。
//
// 一旦吐出正文或调了工具, 闸门立刻撤掉 —— 之后由空闲超时接管。
'use strict';

const test = require('node:test');
const assert = require('node:assert');
const http = require('http');
const path = require('node:path');

const M = (p) => require(path.join(__dirname, '..', p));
const { callLLM } = M('agents/sub-agent.js');

function _sse(obj) { return 'data: ' + JSON.stringify(obj) + '\n\n'; }
function _delta(patch) { return { choices: [{ delta: patch }] }; }

// 起一个假上游。handler(res) 自己决定吐什么、吐多久。
function _upstream(handler) {
  return new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      req.on('data', () => {});
      req.on('end', () => {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        handler(res);
      });
    });
    srv.listen(0, '127.0.0.1', () => {
      resolve({
        model: { id: 'fake-mlx', provider: 'lmstudio', endpoint: 'http://127.0.0.1:' + srv.address().port },
        close: () => new Promise((r) => srv.close(r)),
      });
    });
  });
}

const MSGS = [{ role: 'user', content: '拆一下这个任务' }];

test('T1 runaway 长考必须熔断: 有流量但零正文, 不能挂到天荒地老', async () => {
  process.env.PANGU_SUBAGENT_ZERO_CONTENT_MS = '700';
  const up = await _upstream((res) => {
    // 只吐 thinking, 正文恒 0 —— 这正是现场的形状
    const iv = setInterval(() => res.write(_sse(_delta({ reasoning_content: '长考中'.repeat(12) }))), 40);
    res.on('close', () => clearInterval(iv));
  });
  try {
    const t0 = Date.now();
    await assert.rejects(
      () => callLLM(MSGS, up.model, [], { stream: true, mode: 'planner' }),
      /ZERO_CONTENT_TIMEOUT_\d+s/,
      '零正文的上游必须被熔断, 不能只靠空闲超时 (delta 一直在来, 空闲永不触发)');
    const cost = Date.now() - t0;
    assert.ok(cost < 5000, `应在阈值附近熔断, 实际 ${cost}ms`);
  } finally {
    await up.close();
    delete process.env.PANGU_SUBAGENT_ZERO_CONTENT_MS;
  }
});

test('T2 正常慢生成不许被砍: 一出正文闸门就撤, 之后归空闲超时管', async () => {
  process.env.PANGU_SUBAGENT_ZERO_CONTENT_MS = '700';
  const up = await _upstream((res) => {
    // 先想 500ms (超过阈值的一半), 然后开始出正文, 再慢慢吐 2.5s
    setTimeout(() => {
      res.write(_sse(_delta({ content: '结论: ' })));
      let n = 0;
      const iv = setInterval(() => {
        n++;
        res.write(_sse(_delta({ content: '证据'.repeat(10) })));
        if (n >= 12) { clearInterval(iv); res.write(_sse(_delta({}))); res.write('data: [DONE]\n\n'); res.end(); }
      }, 200);
      res.on('close', () => clearInterval(iv));
    }, 500);
  });
  try {
    const r = await callLLM(MSGS, up.model, [], { stream: true, mode: 'analyzer' });
    assert.ok(String(r && r.text || '').includes('结论'),
      '出了正文就不该再被零产出闸门拦下 — 慢生成是合法的');
  } finally {
    await up.close();
    delete process.env.PANGU_SUBAGENT_ZERO_CONTENT_MS;
  }
});

test('T3 调了工具也算干活 —— 子 agent 第一件事常常就是调工具, 不是出正文', async () => {
  process.env.PANGU_SUBAGENT_ZERO_CONTENT_MS = '700';
  const up = await _upstream((res) => {
    setTimeout(() => {
      res.write(_sse({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'read_file', arguments: '{}' } }] } }] }));
      setTimeout(() => { res.write(_sse(_delta({ content: '读完了' }))); res.write('data: [DONE]\n\n'); res.end(); }, 200);
    }, 400);
  });
  try {
    const r = await callLLM(MSGS, up.model, [{ name: 'read_file' }], { stream: true, mode: 'analyzer' });
    assert.ok(r, '调了工具就该算有产出, 不该被熔断');
  } finally {
    await up.close();
    delete process.env.PANGU_SUBAGENT_ZERO_CONTENT_MS;
  }
});

test('T4 没有 tick 消费者时闸门照样工作 (活性计原来被 _onTick 挡着)', async () => {
  process.env.PANGU_SUBAGENT_ZERO_CONTENT_MS = '700';
  const up = await _upstream((res) => {
    const iv = setInterval(() => res.write(_sse(_delta({ reasoning_content: '闷头想'.repeat(20) }))), 40);
    res.on('close', () => clearInterval(iv));
  });
  try {
    // 不传 onTick —— 以前活性计整段被 `if (!_onTick) return` 跳过,
    // 闸门看不到"已经出过正文", 会把正常的慢生成误当成 runaway。
    await assert.rejects(
      () => callLLM(MSGS, up.model, [], { stream: true, mode: 'planner' }),
      /ZERO_CONTENT_TIMEOUT_\d+s/,
      '无 tick 消费者时闸门仍须生效');
  } finally {
    await up.close();
    delete process.env.PANGU_SUBAGENT_ZERO_CONTENT_MS;
  }
});

