const test = require('node:test');
const assert = require('node:assert/strict');

const { TOOLS } = require('../modules/tools/index.js');

// ─────────────────────────────────────────────────────────────────────────────
// 实案 diag-raw-20261012 第 1 轮 SSE [05]/[06]:
//   analyzer 发 {"raw":"{\"year\":1986,\"month\":3,\"day\":15,\"hour\":12,\"minute\":0}"}
//   bazi_calc 回 {"code":"MISSING_DATE","message":"需要 year/month/day 三个参数"}
//   —— 参数一个不缺, 工具却说没收到。模型不笨, 是归一化挂错了地方:
//   _normalizeToolParams 只在 2 个 handler 里各自记得调, 其余 127 个工具
//   + 7 个 dispatch 点 (agent_loop 6 处 + pangu-single 1 处) 全都绕过。
//   这就是"子 agent 调用一直有问题"的机制: 只要模型把参数包成 {raw:"..."},
//   工具就报缺参 → 子 agent 判"无法核实" → 长任务反复重试同一个坏形状。
// ─────────────────────────────────────────────────────────────────────────────
const DATE = { year: 1986, month: 3, day: 15, hour: 12, minute: 0 };

test('模型把参数包成 {raw:"{...}"} 时, 工具必须收到真参数而不是空对象', async () => {
  const r = await TOOLS.bazi_calc({ context: { user: 'feng' }, params: { raw: JSON.stringify(DATE) } });
  assert.equal(r.ok, true, `{raw:...} 形状应被归一化后正常排盘, 实际: ${JSON.stringify(r.error)}`);
  assert.ok(r.data && r.data.pillars, '应真的排出四柱, 不是空壳');
});

test('模型真实吐出的脏尾巴形状 (raw 结尾带 ">") 必须也能解出来', async () => {
  // 实测 diag-bazi-fix2-20261012: arguments 是**合法** JSON, 但它的值是被坏工具标签
  // 污染过的文本, 结尾带一个 '>'。严格 JSON.parse 抛异常被 catch 掉, 归一化静默失效,
  // 于是 bazi_calc 收到空 params 回 MISSING_DATE —— 参数一个不缺。
  // 这条比上面的干净 raw 更重要: 干净形状能过不代表模型真会那么发。
  const liveShape = '{"year":1986,"month":3,"day":15,"hour":12,"minute":0,"gender":"male","use_solar_time":true,"is_lunar":false,"is_leap_month":false}>';
  assert.throws(() => JSON.parse(liveShape), '前提: 这个形状对严格 JSON.parse 本来就是坏的');
  const r = await TOOLS.bazi_calc({ context: { user: 'feng' }, params: { raw: liveShape } });
  assert.equal(r.ok, true, `脏尾巴形状应照样排盘成功, 实际: ${JSON.stringify(r.error)}`);
  assert.ok(r.data && r.data.pillars, '应真的排出四柱');
});

test('raw 里夹着散文也要能解出 JSON 片段', async () => {
  const r = await TOOLS.bazi_calc({
    context: { user: 'feng' },
    params: { raw: '好的, 我这就排盘: {"year":1986,"month":3,"day":15} 请查收。' },
  });
  assert.equal(r.ok, true, '模型爱在 JSON 前后加话, 不该因此丢参数');
});

test('归一化对所有真工具生效, 不只是当初记得调的那两个', () => {
  // 之前只有 2 个 handler 自己调 _normalizeToolParams; 现在统一在出口裹。
  // 真工具 = TOOLS_SCHEMA 登记的那些 (TOOLS 里混着 3 个内部 helper, 见下一条)。
  const schema = require('../modules/tools_schema').TOOLS_SCHEMA;
  const total = Object.keys(schema).filter((k) => typeof TOOLS[k] === 'function').length;
  const wrapped = Object.keys(schema).filter((k) => TOOLS[k] && TOOLS[k].__panguParamsNormalized).length;
  // 2026-10-22: 127 → 128, 因为加了 wuxing_judge (六格判局, 老板「这用在项目上」那个入口)。
  // 2026-10-23: 128 → 129, 因为加了 fengshui_calc (风水排盘, 第 69 批把风水门接进生产)。
  //   金丝雀照常响: 加真工具就得改这个数, 顺手核一遍下面那句 wrapped === total 没被带漏。
  //   ⚠️ 改数字之前**必须**核过下面那句: 加了工具却没被归一化出口裹住,
  //   那个工具的参数就永远收不到归一化(模型爱在 JSON 前后加话 ⇒ 参数丢)。
  assert.equal(total, 129, '真工具数变了, 先核对 tools_schema 再改这条断言');
  assert.equal(wrapped, total, `只有 ${wrapped}/${total} 个真工具被归一化 —— 又有工具漏了`);
});

test('TOOLS 里的内部 helper 不能被归一化裹坏', () => {
  // TOOLS 命名空间混着 3 个内部 helper, 它们吃裸参数, 不是 {context, params}。
  // write_file 里就有 TOOLS._expandHome(params.path) —— 裹了以后 path.isAbsolute(params.path)
  // 收到一个对象直接抛 TypeError, write_file 返回 EXEC_FAILED, S4/S5 守卫测试挂掉。
  for (const h of ['_castGua', '_guaData', '_expandHome']) {
    assert.equal(typeof TOOLS[h], 'function', `${h} 应存在`);
    assert.ok(!TOOLS[h].__panguParamsNormalized, `${h} 是内部 helper, 不该被归一化裹`);
  }
  // 真调用一次确认没被弄坏 (write_file 内部依赖它)
  assert.equal(typeof TOOLS._expandHome('/tmp/x.md'), 'string', '_expandHome 应仍接受裸字符串路径');
});

test('_concurrency 标记必须跟着裹过去的函数一起活下来', () => {
  // streaming_tool_executor.js:34 靠 fn._concurrency 判并发安全;
  // 换函数对象会让它读到 undefined, 并发闸门静默失效。
  assert.equal(TOOLS.bazi_calc._concurrency, 'safe');
  assert.equal(TOOLS.read_file._concurrency, 'safe');
  assert.equal(TOOLS.list_directory._concurrency, 'safe');
  assert.equal(TOOLS.web_search._concurrency, 'safe');
});

test('正常形状不能被归一化弄坏', async () => {
  const a = await TOOLS.bazi_calc({ context: { user: 'feng' }, params: { ...DATE } });
  assert.equal(a.ok, true, '本来就正确的调用不能被这次改动影响');
});

test('真缺参仍要老实报 MISSING_DATE (别把守卫修成万能兜底)', async () => {
  const r = await TOOLS.bazi_calc({ context: { user: 'feng' }, params: {} });
  assert.equal(r.ok, false);
  assert.equal(r.error.code, 'MISSING_DATE');
});

test('raw 不是合法 JSON 时不炸, 原样传下去让工具自己判', async () => {
  const r = await TOOLS.bazi_calc({ context: { user: 'feng' }, params: { raw: '这不是 JSON' } });
  assert.equal(r.ok, false, '解析不了的 raw 不该被当成合法参数');
});

test('工具名 (TOOLS 的键) 与函数名不能被归一化改坏', () => {
  for (const name of ['bazi_calc', 'read_file', 'task_done']) {
    assert.equal(typeof TOOLS[name], 'function', `${name} 应仍是函数`);
    assert.equal(TOOLS[name].name, name, `${name} 的函数名被改掉了`);
  }
});
