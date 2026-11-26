// 复现「1991 被吃了」。
//
// 现场 (会话 18689788): 用户原话是
//   「1991、11、23 20时05分 女 江苏盐城，做八字排盘」
// 后端存盘记录逐字一致 (已用 jq 核过 session API), 所以**不是输入丢了**。
// 但界面上那两行用户气泡显示成「11. 23 20时05分 …」—— 开头「1991、」没了。
//
// 嫌疑: Markdown.jsx 的有序列表分支
//     while (... /^\s*\d+[.、)]\s*/.test(lines[i])) items.push(lines[i++].replace(...))
// 「1991、11、23 …」以 `1991、` 开头 → `\d+[.、)]` 命中 → 整段被当成列表编号剥掉。
// 中文顿号 `、` 也在字符类里, 于是任何「1991、…」开头的句子都会被吃头。
//
// 本脚本只验「渲染层把字吃了」这一件事, 不发请求、不调模型:
// 把原话塞进页面里的同一个 Markdown 渲染路径, 然后读回 DOM 文本。
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const profile = mkdtempSync(join(tmpdir(), 'pangu-1991-'));
const PORT = 9800 + (process.pid % 150);
const CASES = [
  '1991、11、23 20时05分 女 江苏盐城，做八字排盘',
  '1991.11.23 20时05分 女 江苏盐城，做八字排盘',
  '1985、3、7 早上六点 男 北京，做八字',
  '帮我看下 1991、11、23 这天的八字',
];

const chrome = spawn(CHROME, [
  '--headless=new',
  `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${profile}`,
  '--remote-allow-origins=*',
  '--no-first-run', '--no-default-browser-check', '--disable-gpu',
  process.env.PANGU_URL || 'http://127.0.0.1:18901/',
], { stdio: 'ignore' });

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
let ws;
try {
  let page = null;
  for (let i = 0; i < 60 && !page; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      page = list.find(t => t.type === 'page' && t.webSocketDebuggerUrl);
    } catch (_) { /* 等 */ }
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
      pend.delete(my); rej(new Error('CDP ' + method + ' 超时'));
    }, 15000);
  });
  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) {
      // exceptionDetails.text 只会给一句 "Uncaught", 真话在 exception.description 里。
      // 第一版只取 text, 结果整轮只印出「复现失败: Uncaught」, 白跑。
      const d = r.exceptionDetails;
      throw new Error((d.exception && d.exception.description) || d.text || '页面报错');
    }
    return r.result.value;
  };
  await send('Runtime.enable');
  await send('Page.enable');

  // 固定 sleep(3500) 不够稳: 刷新/冷启动时页面可能还没挂好, 于是 querySelector 返回 null,
  // 后面那一串全是 "Cannot convert undefined or null to object" —— 看着像脚本坏了。
  // 改成真等: 轮询到输入框出现为止。
  const waitTextarea = async () => {
    for (let i = 0; i < 60; i++) {
      const ok = await evaluate(
        `!!document.querySelector('textarea')
         && [...document.querySelectorAll('button')].some(b => b.textContent.trim() === '发送')`);
      if (ok) return;
      await sleep(500);
    }
    throw new Error('等 30s 都没等到输入框 —— 页面没起来?');
  };
  await waitTextarea();

  // 借 React 自己的 setState 把这段字塞进输入框, 再点发送 —— 走的是**真实渲染路径**
  // (MessageContent → Markdown), 不是另写一份渲染来测。
  console.log('原文 → 界面上显示的文本 / 是否被改写\n');
  for (const text of CASES) {
    const shown = await evaluate(`(() => {
      const ta = document.querySelector('textarea');
      // 直接取 HTMLTextAreaElement.prototype 的 setter 会 Illegal invocation ——
      // React 受控组件把 value 定义在**实例自己的原型链上**。这段取值方式跟
      // verify-session-reuse.mjs 里那份逐字一致(那边实测能注进去), 不另创一套。
      const proto = Object.getPrototypeOf(ta);
      const own = Object.getOwnPropertyDescriptor(proto, 'value');
      const setter = (own && own.set)
        || Object.getOwnPropertyDescriptor(window.HTMLTextAreaElement.prototype, 'value').set;
      setter.call(ta, ${JSON.stringify(text)});
      ta.dispatchEvent(new Event('input', { bubbles: true }));
      const send = [...document.querySelectorAll('button')].find(b => b.textContent.trim() === '发送');
      if (!send || send.disabled) return 'SEND_UNAVAILABLE';
      window.__probeText = ${JSON.stringify(text)};
      send.click();
      return 'SENT';
    })()`);
    if (shown !== 'SENT') { console.log(`发送失败(${shown}): ${text}`); continue; }

    // 用户气泡是 send() 里同步塞进 messages 的, **不等这一轮跑完**就能读。
    // 第一版老老实实等收工, 4 个用例要十几分钟; 而被改的是渲染, 发出去那一瞬就定了。
    // 等收工还有个副作用: 中途盘古自己又发一轮, 会把下一个用例的输入挤到 busy 里发不出去。
    let bubble = null;
    for (let i = 0; i < 20; i++) {
      await sleep(400);
      const r = await evaluate(`(() => {
        const users = [...document.querySelectorAll('.pangu-chat-message')]
          .filter(e => e.querySelector('.bg-primary'))
          .map(e => (e.innerText || '').split('\\n')[0].trim());
        return JSON.stringify({ users });
      })()`);
      const s = JSON.parse(r);
      if (s.users.length) { bubble = s.users[s.users.length - 1]; break; }
    }
    // 下一句会被 busy 挡住。与其等盘古把八字算完 (几分钟), 直接刷新页面:
    // 被验的是**渲染**, 刷新后走的是同一段代码, 而消息和 busy 一起清空。
    // 第一版在这里死等收工, 四个用例十几分钟 —— 等的是一件跟判据无关的事。
    await send('Page.reload', { ignoreCache: true });
    await sleep(800);
    await waitTextarea();
    const kept = bubble != null && bubble.replace(/\s+/g, '') === text.replace(/\s+/g, '');
    console.log(`${kept ? 'OK  ' : '改写!'} 输入: ${text}`);
    console.log(`     显示: ${bubble === null ? '(没抓到)' : bubble}`);
    console.log(`     原样保留: ${kept}\n`);
  }
} catch (e) {
  console.log('复现失败: ' + e.message);
} finally {
  try { ws && ws.close(); } catch (_) {}
  try { chrome.kill('SIGKILL'); } catch (_) {}
  try { rmSync(profile, { recursive: true, force: true }); } catch (_) {}
  process.exit(0);
}

