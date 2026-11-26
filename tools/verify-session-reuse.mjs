// 2026-10-19: 验证「一个会话连问两件事」在真实浏览器里的表现。
//
// 为什么不用 agent-browser: 它的 eval 在这台机器上挂死 (连 1+1 都不返回),
// 而 AGENTS.md 的规矩是「不能就说不能」—— 不拿一个跑不通的工具硬凑证据。
// 这里直接开一个独立 headless Chrome 走 CDP, 不碰主人正在用的浏览器,
// 而且 Node 22 自带 WebSocket, 零依赖。
//
// 判据只有一条, 就是老板盯着的那条:
//   **第二轮跑完之后, 界面上不许还有任何一行写着「运行中」, 且「发送」按钮可点。**
//   之前就是这两条同时不成立 —— 答复出齐了, 两张卡还开着, 按钮锁着。
//
// 用法: node tools/verify-session-reuse.mjs [问题1] [问题2]

import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const URL_BASE = process.env.PANGU_URL || 'http://127.0.0.1:18901/';
const Q1 = process.argv[2] || '现在几点';
const Q2 = process.argv[3] || '全面介绍你自己';
const ROUND_TIMEOUT_MS = 8 * 60 * 1000;

const profile = mkdtempSync(join(tmpdir(), 'pangu-verify-'));
const PORT = 9333 + (process.pid % 200);

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  // 少了这一条, Chrome 会**静默丢弃**所有 CDP 命令: WebSocket 握手能过,
  // 但 Runtime.evaluate 发出去石沉大海, 表现就是本脚本第一版那样卡死、
  // 一行日志都没有。踩了 20 分钟才定位, 写在这里免得下次再踩。
  '--remote-allow-origins=*',
  '--no-first-run',
  '--no-default-browser-check',
  '--disable-gpu',
  '--window-size=1600,1100',
  URL_BASE,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
// 走 stderr 且每行落盘: 这个脚本第一版把日志写 stdout 再重定向到文件,
// 卡死时看到的是 **0 字节日志**, 分不清是「没跑到」还是「跑到一半卡住」。
const trace = (m) => { process.stderr.write(`[verify] ${m}\n`); };

async function cdpTarget() {
  for (let i = 0; i < 60; i++) {
    try {
      const r = await fetch(`http://127.0.0.1:${PORT}/json/list`);
      const list = await r.json();
      const page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch (_) { /* 还没起来 */ }
    await sleep(500);
  }
  throw new Error('Chrome 没起来 (端口 ' + PORT + ')');
}

function connect(url) {
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (ev) => {
    let m;
    try { m = JSON.parse(ev.data); } catch (_) { return; }
    if (m.id && pending.has(m.id)) {
      const { resolve, reject } = pending.get(m.id);
      pending.delete(m.id);
      m.error ? reject(new Error(m.error.message)) : resolve(m.result);
    } else if (m.method) {
      events.push(m);
    }
  });
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', () => reject(new Error('CDP 连接失败')));
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    const myId = ++id;
    pending.set(myId, { resolve, reject });
    ws.send(JSON.stringify({ id: myId, method, params }));
    // 不设上限的话, Chrome 那边不回就永远挂着 —— 而挂着的表现和「在正常跑」一模一样。
    setTimeout(() => {
      if (!pending.has(myId)) return;
      pending.delete(myId);
      reject(new Error(`CDP ${method} 15s 没回 —— Chrome 静默丢弃命令? `
        + '(检查 --remote-allow-origins)'));
    }, 15000);
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', {
      expression: expr, returnByValue: true, awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception
        ? r.exceptionDetails.exception.description
        : '页面里报错了');
    }
    return r.result.value;
  };
  return { ready, send, evaluate, events, close: () => ws.close() };
}

// 直接注入 React 受控 textarea —— agent-browser 的 fill/type 会挂, 这里自己来。
const ASK = (q) => `(() => {
  const ta = document.querySelector('textarea');
  if (!ta) return 'no-textarea';
  const proto = Object.getPrototypeOf(ta);
  const set = Object.getOwnPropertyDescriptor(proto, 'value').set;
  const setter = set || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
  setter.call(ta, ${JSON.stringify(q)});
  ta.dispatchEvent(new Event('input', { bubbles: true }));
  return 'typed';
})()`;

const CLICK_SEND = `(() => {
  const b = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '发送');
  if (!b) return 'no-send';
  if (b.disabled) return 'send-disabled';
  b.click();
  return 'sent';
})()`;

// 这一段就是判据本体: 界面上还有几行写着「运行中」, 以及发送键能不能点。
const READ_STATE = `(() => {
  const rows = [...document.querySelectorAll('button')]
    .filter(b => b.getAttribute('aria-expanded') !== null)
    .map(b => (b.innerText || '').replace(/\\s+/g, ' ').trim());
  const running = rows.filter(t => t.includes('运行中'));
  const sendBtn = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '发送');
  const busyBtn = [...document.querySelectorAll('button')].find(x => x.textContent.trim().startsWith('推演中'));
  const answers = [...document.querySelectorAll('.pangu-chat-message')]
    .filter(e => e.querySelector('.rounded-2xl'))
    .map(e => (e.innerText || '').slice(0, 40));
  return JSON.stringify({
    running, rows, rowCount: rows.length, sendEnabled: sendBtn ? !sendBtn.disabled : null,
    busy: !!busyBtn, answers,
  });
})()`;

async function waitRound(c, label) {
  const t0 = Date.now();
  let last = '';
  while (Date.now() - t0 < ROUND_TIMEOUT_MS) {
    await sleep(5000);
    const s = JSON.parse(await c.evaluate(READ_STATE));
    const line = `[${label}] ${Math.round((Date.now() - t0) / 1000)}s `
      + `行数=${s.rowCount} running=${JSON.stringify(s.running)} `
      + `send=${s.sendEnabled} busy=${s.busy} 答案数=${s.answers.length}`;
    if (line !== last) { console.log(line); last = line; }
    // 判据不许是空的: rowCount 一次都没大于 0, 说明选择器根本没匹配到将灵行,
    // 这时 running=[] 是**假绿**而不是通过。宁可报错, 也不能拿一个量不到东西的
    // 检查交差 —— 「grep 匹配到 ≠ 证据」的同一个教训, 用在选择器上。
    if (s.rowCount > 0) sawAnyRow = true;
    // 收工判据: 不再推演, 且界面上没有一行还写着「运行中」。
    // 注意**不看** sendEnabled —— 输入框空着时按钮本来就该是灰的, 那是对的。
    // 第一版把它算进收工条件, 结果永远不会满足, 白等 8 分钟。
    // 「这一轮之后还能不能再发下一句」由 CLICK_SEND 真正验: 它灰着就会
    // 返回 send-disabled 并当场报错, 那才是「会话只能做一件事」。
    if (!s.busy && s.running.length === 0 && s.answers.length > 0) {
      return s;
    }
  }
  throw new Error(`[${label}] 等了 ${Math.round(ROUND_TIMEOUT_MS / 1000)}s 没收工`);
}

let exitCode = 1;
let cdp = null;
let sawAnyRow = false;
try {
  trace('等 Chrome 起来…');
  cdp = connect(await cdpTarget());
  await cdp.ready;
  trace('CDP 已连上');
  await cdp.send('Runtime.enable');
  trace('Runtime.enable ok');
  await cdp.send('Page.enable');
  trace('Page.enable ok');
  await sleep(3000);

  // 不用去点「新对话」: 它前面挂着一句原生 confirm()
  // (ChatRoom.jsx:1192 startNewSession), 而原生弹窗一开, 渲染进程就是**阻塞**的 ——
  // Runtime.evaluate 发过去石沉大海, 15s 超时。第一版就是这么卡死的, 看着像 CDP 坏了。
  // 何况每次都新建临时 profile, 本来就是干净会话, 点了反而多余。
  trace('全新 profile = 全新会话, 准备发第一问');

  for (const [i, q] of [Q1, Q2].entries()) {
    const label = `Q${i + 1}`;
    const typed = await cdp.evaluate(ASK(q));
    if (typed !== 'typed') throw new Error(`[${label}] 输入框没找到: ${typed}`);
    await sleep(600);
    const sent = await cdp.evaluate(CLICK_SEND);
    if (sent !== 'sent') throw new Error(`[${label}] 没发出去: ${sent}`);
    trace(`${label} 已发出: ${q}`);
    console.log(`--- ${label}: ${q} ---`);
    const s = await waitRound(cdp, label);
    console.log(`[${label}] 收工 → 运行中残留 ${s.running.length} 条 / 发送键可点=${s.sendEnabled}`);
  }

  const final = JSON.parse(await cdp.evaluate(READ_STATE));
  console.log('\n=== 结论 ===');
  console.log('曾出现过将灵行:', sawAnyRow ? '是 (判据有效)' : '否 —— 这次是假绿, 不算通过');
  console.log('收工时将灵行原文:', JSON.stringify(final.rows));
  console.log('运行中残留行:', final.running.length ? final.running : '(无)');
  console.log('发送键可点:', final.sendEnabled);
  console.log('同会话内答案条数:', final.answers.length);
  if (!sawAnyRow) {
    console.log('FAIL: 整轮都没匹配到任何将灵行 —— running=[] 是量不到东西, 不是没问题。');
  } else if (final.running.length === 0 && final.answers.length >= 2) {
    console.log('PASS: 一个会话连问两件事, 两件都交付, 界面没有悬空的「运行中」。');
    exitCode = 0;
  } else {
    console.log('FAIL: 见上, 仍有不该有的状态。');
  }
} catch (e) {
  console.error('验证失败:', e.message);
} finally {
  try { cdp && cdp.close(); } catch (_) {}
  try { chrome.kill('SIGKILL'); } catch (_) {}
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(exitCode);
}

