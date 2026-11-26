'use strict';
/**
 * 第 65 批判据 —— dispatcher 的「唯一出口」
 *
 * ## 这条判据在守什么
 *   dispatcher 有 8 个出口。2026-10-12 修过一次「会话跑完刷新就没了」,
 *   2026-10-16 又来一次(「Planner failed: LLM timeout 300s」→ 走关键词兜底 →
 *   答完了、上屏了, 父会话没落盘 ⇒ 刷新/重启整轮消失)。
 *
 *   同一族事故修了两次还在长新的, 根因不是「谁忘了写落盘」, 是
 *   **「要落盘」这件事靠每处各自记性**。两份抄本各自都漏了同一个修复,
 *   因为抄一遍就多一处会漏的地方。
 *
 *   所以第 65 批把落盘从「各处记得」改成「出口只有一处」:
 *   · `modules/dispatcher_closeout.js` —— 唯一出口的实现(叶子模块, 可行为级验)
 *   · dispatcher 里 `resDone(` / `_persistParent(` 的直接调用点必须为 0
 *
 * ## 三层判据
 *   ① 行为层(叶子模块): 落盘内容 = result 原文 / 默认 completed /
 *      不落盘必须写理由 / 没写理由必须 warn
 *   ② 接线层(AST): 直接调用点 0 / makeCloseOut 恰好 1 / 每个出口都有落盘规格
 *   ③ 回归层: 关键词兜底那条出口**必须落盘**(本次那个 bug 的直接锁)
 *
 * ## 为什么用 AST 而不是 grep
 *   `_persistParent` 的注释白纸黑字写着「6 处调用覆盖 … 关键词兜底 … 全部路径」,
 *   而代码里关键词兜底一处都没有 —— **注释会撒谎, 语法树不会**。
 *   判据必须跑在真解析出来的结构上, 否则一句注释就能买到假绿。
 */

const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const { parseJsFile, callSites, hasSyntaxError } = require('./helpers/js_ast');

const CORE = path.join(__dirname, '..');
const DISPATCHER = path.join(CORE, 'modules', 'j2_dispatcher.js');

const VALID_STATES = ['completed', 'partial', 'failed', 'active'];

// --------------------------------------------------------------------------
// 小工具
// --------------------------------------------------------------------------

/** 取对象字面量的 { key: value } 表(值是 AST 节点) */
function objProps(node) {
  const props = {};
  if (!node || node.type !== 'object') return props;
  for (let i = 0; i < node.childCount; i++) {
    const c = node.child(i);
    if (c.type === 'pair') {
      const k = c.childForFieldName('key');
      const v = c.childForFieldName('value');
      if (k) props[k.text] = v;
    } else if (c.type === 'shorthand_property_identifier') {
      props[c.text] = c;
    }
  }
  return props;
}

/** 取一个表达式里出现的所有字符串字面量(能把三元两支都收进来) */
function stringLits(node) {
  const out = [];
  (function walk(n) {
    if (!n) return;
    if (n.type === 'string' || n.type === 'template_string') {
      out.push(n.text.replace(/^['"`]|['"`]$/g, ''));
      return;
    }
    for (let i = 0; i < n.childCount; i++) walk(n.child(i));
  })(node);
  return out;
}

/** 去引号 */
function unquote(s) {
  return String(s == null ? '' : s).replace(/^['"`]|['"`]$/g, '');
}

/** 记日志的假 log */
function makeLog() {
  const logs = [];
  const warns = [];
  return {
    logs,
    warns,
    log: (...a) => logs.push(a.map(String).join(' ')),
    warn: (...a) => warns.push(a.map(String).join(' ')),
  };
}

// --------------------------------------------------------------------------
// ① 行为层: 叶子模块 dispatcher_closeout.js
// --------------------------------------------------------------------------

test('closeout: resDone 恰好调一次, payload 原样传过去(不是复制一份)', () => {
  const { makeCloseOut } = require('../modules/dispatcher_closeout');
  const seen = [];
  const done = { status: 'completed', result: '答复正文', tools_used: ['bazi_calc'] };
  const closeOut = makeCloseOut({
    resDone: (o) => seen.push(o),
    persistParent: () => {},
    log: makeLog(),
  });
  closeOut(done, { persistState: 'completed' });
  assert.strictEqual(seen.length, 1, 'resDone 必须恰好调一次');
  assert.strictEqual(seen[0], done, 'payload 必须原样传过去');
});

test('closeout: 落盘收到的就是 result 原文, 状态跟着走', () => {
  const { makeCloseOut } = require('../modules/dispatcher_closeout');
  const persisted = [];
  const closeOut = makeCloseOut({
    resDone: () => {},
    persistParent: (answer, state) => persisted.push([answer, state]),
    log: makeLog(),
  });
  closeOut({ result: '答案 A\n第二行' }, { persistState: 'partial' });
  assert.strictEqual(persisted.length, 1);
  assert.strictEqual(persisted[0][0], '答案 A\n第二行', '落盘内容必须 == result 原文');
  assert.strictEqual(persisted[0][1], 'partial');
});

test('closeout: 不给落盘规格 → 默认 completed', () => {
  const { makeCloseOut } = require('../modules/dispatcher_closeout');
  const persisted = [];
  const closeOut = makeCloseOut({
    resDone: () => {},
    persistParent: (answer, state) => persisted.push([answer, state]),
    log: makeLog(),
  });
  closeOut({ result: 'x' });
  assert.deepStrictEqual(persisted, [['x', 'completed']]);
});

test('closeout: persist:false + 写明理由 → 不落盘, 但要留痕', () => {
  const { makeCloseOut } = require('../modules/dispatcher_closeout');
  const persisted = [];
  const log = makeLog();
  const closeOut = makeCloseOut({
    resDone: () => {},
    persistParent: (a, s) => persisted.push([a, s]),
    log,
  });
  closeOut({ result: '拒收语' }, { persist: false, persistWhy: '空输入拒收语, 不是答复' });
  assert.strictEqual(persisted.length, 0, '声明了不落盘就不许落盘');
  assert.ok(log.logs.length >= 1, '不落盘要留痕, 不许默默跳过');
  assert.strictEqual(log.warns.length, 0, '写了理由就不该再 warn');
});

test('closeout: persist:false 但没写理由 → 不落盘, 且必须 warn', () => {
  const { makeCloseOut } = require('../modules/dispatcher_closeout');
  const persisted = [];
  const log = makeLog();
  const closeOut = makeCloseOut({
    resDone: () => {},
    persistParent: (a, s) => persisted.push([a, s]),
    log,
  });
  closeOut({ result: 'x' }, { persist: false });
  assert.strictEqual(persisted.length, 0);
  assert.strictEqual(log.warns.length, 1, '不落盘又不写理由 = 父会话会丢这一轮, 必须让它响');
  assert.match(log.warns[0], /没写理由/);
});

test('closeout: 缺 resDone → warn, 不静默', () => {
  const { makeCloseOut } = require('../modules/dispatcher_closeout');
  const log = makeLog();
  const closeOut = makeCloseOut({ persistParent: () => {}, log });
  closeOut({ result: 'x' }, { persistState: 'completed' });
  assert.strictEqual(log.warns.length, 1);
  assert.match(log.warns[0], /resDone/);
});

test('closeout: 缺 persistParent → warn, 且不落盘', () => {
  const { makeCloseOut } = require('../modules/dispatcher_closeout');
  const log = makeLog();
  const closeOut = makeCloseOut({ resDone: () => {}, log });
  closeOut({ result: 'x' }, { persistState: 'completed' });
  assert.strictEqual(log.warns.length, 1);
  assert.match(log.warns[0], /persistParent/);
});

// --------------------------------------------------------------------------
// ② 接线层: dispatcher 里必须只经 _closeOut 收口
// --------------------------------------------------------------------------

const tree = parseJsFile(DISPATCHER);

test('dispatcher: 源码本身没有语法错(判据不许在读不出结构的源码上假绿)', () => {
  assert.strictEqual(hasSyntaxError(tree), false);
});

test('dispatcher: resDone 的直接调用点 = 0(只能经 _closeOut)', () => {
  const hits = callSites(tree, 'resDone');
  assert.strictEqual(
    hits.length,
    0,
    'resDone 有直接调用点: ' + hits.map((h) => 'L' + h.line).join(', ')
  );
});

test('dispatcher: _persistParent 的直接调用点 = 0(只能经 _closeOut)', () => {
  const hits = callSites(tree, '_persistParent');
  assert.strictEqual(
    hits.length,
    0,
    '_persistParent 有直接调用点: ' + hits.map((h) => 'L' + h.line).join(', ')
  );
});

test('dispatcher: makeCloseOut 调用点恰好 1 个', () => {
  const hits = callSites(tree, 'makeCloseOut');
  assert.strictEqual(hits.length, 1, 'makeCloseOut 调用点: ' + hits.map((h) => 'L' + h.line).join(', '));
});

test('dispatcher: makeCloseOut 必须把 resDone 和 persistParent 都交进去', () => {
  const [site] = callSites(tree, 'makeCloseOut');
  const props = objProps(site.args[0]);
  assert.ok(props.resDone, 'resDone 没交给唯一出口 —— 收口状态不会上报');
  assert.ok(props.persistParent, 'persistParent 没交给唯一出口 —— 父会话不会落盘');
});

test('dispatcher: 每个 _closeOut 调用点都必须显式给落盘规格', () => {
  const sites = callSites(tree, '_closeOut');
  assert.ok(sites.length >= 1, '一个出口都没找到 —— 判据本身坏了');
  for (const s of sites) {
    const spec = s.args[1];
    assert.ok(spec, `L${s.line} 的 _closeOut 没给第 2 个参数(落盘规格)`);
    assert.strictEqual(spec.type, 'object', `L${s.line} 的落盘规格不是对象`);
    const p = objProps(spec);
    if ('persist' in p) {
      assert.strictEqual(p.persist.text, 'false', `L${s.line} 的 persist 只允许 false`);
      assert.ok(p.persistWhy, `L${s.line} 声明不落盘却没给理由`);
      assert.ok(unquote(p.persistWhy.text).trim().length > 0, `L${s.line} 的理由是空的`);
    } else {
      assert.ok(p.persistState, `L${s.line} 没给 persistState`);
      const lits = stringLits(p.persistState);
      assert.ok(lits.length > 0, `L${s.line} 的 persistState 不是字面量`);
      for (const l of lits) {
        assert.ok(VALID_STATES.includes(l), `L${s.line} 的落盘状态非法: ${l}`);
      }
    }
  }
});

test('dispatcher: 兜底摘要只有一份构造(两份抄本必然各自漏掉同一个修复)', () => {
  const hits = callSites(tree, '_buildFallbackSummaries');
  assert.strictEqual(hits.length, 1, '_buildFallbackSummaries 调用点: ' + hits.map((h) => 'L' + h.line).join(', '));
});

test('dispatcher: 两条关键词兜底路走同一个收口', () => {
  const hits = callSites(tree, '_keywordFallbackCloseOut');
  assert.strictEqual(hits.length, 2, '_keywordFallbackCloseOut 调用点: ' + hits.map((h) => 'L' + h.line).join(', '));
});

test('dispatcher: 父会话落盘必须带 final: true', () => {
  const hits = callSites(tree, '_persistSession');
  assert.ok(hits.length >= 1, '没找到 _persistSession 调用点 —— 判据本身坏了');
  const withFinal = hits.filter((s) => {
    const spec = s.args[2];
    if (!spec || spec.type !== 'object') return false;
    const p = objProps(spec);
    return !!(p.final && p.final.text === 'true');
  });
  assert.ok(withFinal.length >= 1, '父会话落盘没带 final: true ⇒ 这轮不算落定');
});

// --------------------------------------------------------------------------
// ③ 回归层: 本次那个 bug 的直接锁
// --------------------------------------------------------------------------

test('回归: 关键词兜底那条出口必须落盘, 不许 persist:false', () => {
  const sites = callSites(tree, '_closeOut').filter((s) =>
    /mode:\s*'keyword_fallback'/.test(s.args[0] ? s.args[0].text : '')
  );
  assert.strictEqual(
    sites.length,
    1,
    '关键词兜底的 _closeOut 调用点应恰好 1 个, 实际 ' + sites.length
  );
  const spec = sites[0].args[1];
  assert.ok(spec, '关键词兜底的 _closeOut 没给落盘规格');
  const p = objProps(spec);
  assert.ok(p.persistState, '关键词兜底不许声明 persist:false —— 2026-10-16 那次就是它没落盘');
  assert.ok(!('persist' in p), '关键词兜底不许出现 persist 字段');
  const lits = stringLits(p.persistState);
  assert.ok(lits.length > 0);
  for (const l of lits) {
    assert.ok(VALID_STATES.includes(l), `关键词兜底的落盘状态非法: ${l}`);
  }
});

test('回归: 空输入拒收是唯一允许不落盘的出口, 且必须带理由', () => {
  const noPersist = callSites(tree, '_closeOut').filter((s) => {
    const spec = s.args[1];
    if (!spec || spec.type !== 'object') return false;
    return 'persist' in objProps(spec);
  });
  assert.strictEqual(noPersist.length, 1, '只有空输入拒收允许不落盘');
  const p = objProps(noPersist[0].args[1]);
  assert.strictEqual(p.persist.text, 'false');
  assert.ok(unquote(p.persistWhy.text).trim().length > 0);
});

