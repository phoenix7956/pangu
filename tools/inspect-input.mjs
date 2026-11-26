// 临时取证: 看输入框此刻的真实状态 (值 / 占位符 / 可点性 / 上层有没有盖住它)。
// 复用 verify-session-reuse.mjs 里那套 CDP 连法 —— 那套踩过的坑都在注释里:
//   ① 必须 --remote-allow-origins=* ② 别去点挂 confirm() 的按钮。
// 只读, 不点发送, 不发请求。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'pangu-inspect-'));
const PORT = 9700 + (process.pid % 200);

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  '--window-size=1600,1100',
  process.env.PANGU_URL || 'http://127.0.0.1:18901/',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const out = (m) => console.log(m);

let ws;
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (_) { /* 还没起来 */ }
    if (!page) await sleep(500);
  }
  if (!page) throw new Error('Chrome 没起来');

  ws = new WebSocket(page.webSocketDebuggerUrl);
  let id = 0;
  const pend = new Map();
  ws.addEventListener('message', ev => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.id && pend.has(m.id)) {
      const p = pend.get(m.id); pend.delete(m.id);
      m.error ? p.rej(new Error(m.error.message)) : p.res(m.result);
    }
  });
  await new Promise(r => ws.addEventListener('open', r));
  const send = (method, params = {}) => new Promise((res, rej) => {
    const my = ++id;
    pend.set(my, { res, rej });
    ws.send(JSON.stringify({ id: my, method, params }));
    setTimeout(() => {
      if (!pend.has(my)) return;
      pend.delete(my); rej(new Error('CDP ' + method + ' 15s 没回'));
    }, 15000);
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.text || '页面报错');
    return r.result.value;
  };

  await send('Runtime.enable');
  await sleep(3500);

  out(await evaluate(`(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return 'NO TEXTAREA';
    const r = ta.getBoundingClientRect();
    const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    const sendBtn = [...document.querySelectorAll('button')].find(x => x.textContent.trim() === '发送' || x.textContent.trim().startsWith('推演中'));
    const br = sendBtn ? sendBtn.getBoundingClientRect() : null;
    // 输入区最上层是谁 —— 被别的层盖住时, 用户看着「点不动」其实是它盖住了
    const topAtSend = br ? document.elementFromPoint(br.left + br.width / 2, br.top + br.height / 2) : null;
    return JSON.stringify({
      value: ta.value,
      valueLen: ta.value.length,
      placeholder: ta.getAttribute('placeholder'),
      disabled: ta.disabled,
      readOnly: ta.readOnly,
      focused: document.activeElement === ta,
      rect: { w: Math.round(r.width), h: Math.round(r.height), top: Math.round(r.top) },
      hitAtCenter: top ? (top.tagName + '.' + String(top.className).slice(0, 40)) : null,
      isTopAtCenter: top === ta,
      sendBtn: sendBtn ? { text: sendBtn.textContent.trim(), disabled: sendBtn.disabled } : null,
      hitAtSend: topAtSend ? (topAtSend.tagName + '.' + String(topAtSend.className).slice(0, 40)) : null,
      banner: (() => { const b = document.querySelector('.pangu-chat-toolbar'); return b ? b.innerText.replace(/\\s+/g, ' ').trim() : null; })(),
    }, null, 2);
  })()`));
} catch (e) {
  out('inspect 失败: ' + e.message);
} finally {
  try { ws && ws.close(); } catch (_) {}
  try { chrome.kill('SIGKILL'); } catch (_) {}
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
}

