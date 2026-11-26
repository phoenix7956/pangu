'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');
const analyzer = require('../agents/li');
const bugHunter = require('../agents/xun');
const qian = require('../agents/qian');
const route = require('../pangu-single/routes/agent');

function invoke(pathname) {
  const req = { method: 'GET', url: pathname };
  const res = {
    statusCode: 200,
    setHeader() {},
    end(text) { this.body = JSON.parse(text); },
  };
  return route.handler(req, res, pathname.split('?')[0]).then(() => ({ status: res.statusCode, body: res.body }));
}

function runHarness(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(__dirname, '../tools/agent_test_harness.js'), ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', code => resolve({ code, stdout, stderr }));
  });
}

async function main() {
  const originalExecute = analyzer.execute;
  let receivedTask;
  let receivedContext;
  try {
    analyzer.execute = async (task, context) => {
      receivedTask = task;
      receivedContext = context;
      return { ok: false, error: 'injected agent failure' };
    };
    const routeContext = encodeURIComponent(JSON.stringify({ traceId: 'trace-42', params: { extra: true } }));
    const failed = await invoke(`/api/agent/run/li?goal=inspect%20route%3Da&context=${routeContext}`);
    assert.equal(failed.status, 200);
    assert.equal(receivedTask.type, 'default');
    assert.equal(receivedTask.goal, 'inspect route=a');
    assert.equal(receivedContext.traceId, 'trace-42');
    assert.equal(receivedContext.params.extra, true);
    assert.equal(failed.body.ok, false);
  } finally {
    analyzer.execute = originalExecute;
  }

  const scan = await invoke('/api/agent/run/xun?code=const%20value%20%3D%20eval(input)%3B');
  assert.equal(scan.body.ok, true);
  assert.equal(scan.body.result.status, 'success');
  assert.equal(scan.body.result.bugs.some(bug => bug.type === 'eval_usage'), true);

  const originalBugHunterExecute = bugHunter.execute;
  try {
    bugHunter.execute = async () => ({ agent: 'xun', status: 'failed', error: 'injected scan failure' });
    const failedScan = await invoke('/api/agent/run/xun?code=const%20value%20%3D%20input%3B');
    assert.equal(failedScan.body.ok, false);
  } finally {
    bugHunter.execute = originalBugHunterExecute;
  }

  const invalidContext = await invoke('/api/agent/run/li?goal=inspect&context=%7Bbad-json');
  assert.equal(invalidContext.status, 400);
  assert.equal(invalidContext.body.error, 'INVALID_CONTEXT');

  // 2026-10-18 新契约: URL 段只认拼音/卦名。英文一律 404 —— 不是"兼容一下",
  // 是这套身份里根本没有英文。卦名要能用 (URL 编码), 这条以前恒 404,
  // 因为路由没 decodeURIComponent 就把「%E4%B9%BE」丢给 resolveRole 认。
  for (const legacy of ['analyzer', 'executor', 'checker', 'bug_hunter', 'planner']) {
    const miss = await invoke('/api/agent/run/' + legacy + '?goal=x');
    assert.equal(miss.status, 404, legacy + ' 居然还能被路由到 —— 英文身份没删干净');
    assert.equal(miss.body.error, 'AGENT_NOT_FOUND');
  }
  // ⚠️ 这一步原来**直接跑真调度器**, 会发真实 LLM 请求(2026-10-23 实测:
  //   它把整条 test:chain(220 个文件)挂在这一步上 —— 卡 15 分钟、CPU 0%,
  //   第 49 批前后在同一处都复现 ⇒ 跟那一批无关, 是这条测试自己的老毛病)。
  //
  //   这条断言要验的是**身份解析**(卦名是合法身份, 不能恒 404),
  //   不是验调度器能不能跑通 LLM —— 那是 dispatcher 的测试, 不是路由的。
  //   ⇒ 跟上面 li / xun 两步一样打桩: 桩一打, 断言的**原意**一点没变,
  //     链子也不再依赖外部模型能不能及时回话。
  const originalQianExecute = qian.execute;
  let byGua;
  try {
    qian.execute = async () => ({ ok: false, error: 'injected dispatch failure' });
    byGua = await invoke('/api/agent/run/' + encodeURIComponent('乾') + '?goal=x');
  } finally {
    qian.execute = originalQianExecute;
  }
  assert.notEqual(byGua.status, 404, '卦名(URL 编码)是合法身份, 路由必须先 decode 再认');
  //   路由把 agent 的返回值包在 `result` 里(见 routes/agent.js 的 json(res, {ok, agent, result})),
  //   所以桩的痕迹在 body.result.error, 不在 body.error。
  assert.equal(byGua.body.result && byGua.body.result.error, 'injected dispatch failure',
    '卦名必须真的落到调度器身上(桩被调到了), 不是绕过去直接 404');

  const requests = [];
  const server = http.createServer((req, res) => {
    const parsed = new URL(req.url, 'http://127.0.0.1');
    requests.push(parsed);
    const failed = parsed.searchParams.get('goal') === 'fail task';
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: !failed, result: { ok: !failed } }));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const context = JSON.stringify({ traceId: 'cli-9', options: { verbose: true } });
    const success = await runHarness(['--agent', 'li', '--task', 'inspect route=a', '--context', context, '--execute', '--base', base]);
    assert.equal(success.code, 0, success.stderr);
    const failure = await runHarness(['--agent', 'li', '--task', 'fail task', '--execute', '--base', base]);
    assert.equal(failure.code, 1);
    assert.equal(requests[0].searchParams.get('goal'), 'inspect route=a');
    assert.equal(requests[0].searchParams.has('task'), false);
    assert.deepEqual(JSON.parse(requests[0].searchParams.get('context')), JSON.parse(context));
    assert.equal(requests[1].searchParams.get('goal'), 'fail task');
  } finally {
    await new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  process.stdout.write('agent-routes.test.js: PASS\n');
}

main().catch(error => {
  process.stderr.write(`${error.stack || error}\n`);
  process.exitCode = 1;
});
