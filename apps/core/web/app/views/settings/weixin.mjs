// settings/weixin.mjs —— 设置 · 微信
//
// 第 172 批 (2026-10-30): 老板「我需要你连微信」。
//   这一页是盘古自己那条微信通道的**可见面**:
//     · 绑没绑 (凭据在不在)
//     · 守护进程活没活 (长轮询那个, 活了才收得到消息)
//     · 最近收发记录 (真发生过的事, 不是"应该能行")
//     · 一个测试按钮 —— 点一下当场知道通没通 (比任何说明都有说服力)
//
// 设计: 复用设计系统零件 (page / tiles / flatSection / formRow),
//   不自造第四套卡片样式。

import { el, elHTML, page, tiles, flatSection, formRow, toast } from '../../lib/util.mjs';
import { iconHTML } from '../../lib/icons.mjs';
import { api } from '../../lib/api.mjs';

function icoLine(name, text, cls) {
  const s = el('span', { class: 'pg-ico-line ' + (cls || '') });
  s.appendChild(elHTML('span', {}, iconHTML(name, 13)));
  s.appendChild(el('span', {}, text));
  return s;
}

function fmtTime(ts) {
  if (!ts) return '—';
  try {
    const d = new Date(ts);
    return d.toLocaleString('zh-CN', {
      month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
    });
  } catch (e) { return String(ts); }
}

const KIND_TEXT = {
  inbound: '收到消息',
  send: '发出消息',
  send_failed: '发送失败',
  poll_failed: '收信失败',
  bridge_handle: '处理中',
  bridge_answered: '已作答',
  bridge_failed: '作答失败',
  bridge_send_failed: '回信失败',
};

export async function render(root) {
  const host = page();
  host.classList.add('pg-settings-col');
  root.appendChild(host);

  let data = null;
  let loading = true;
  let error = null;
  let sending = false;

  const paint = () => {
    host.innerHTML = '';
    if (loading) {
      host.appendChild(el('div', { class: 'pg-hint' }, '加载中…'));
      return;
    }
    if (error) {
      host.appendChild(icoLine('alert-triangle', error, 'pg-ico-warn pg-err-line'));
      return;
    }

    const st = (data && data.status) || {};
    const daemon = (data && data.daemon) || {};
    const recent = ((data && data.recent) || []).slice().reverse();

    // 状态磁贴 —— 设计系统的 `.pg-tiles`
    host.appendChild(tiles([
      {
        k: '账号',
        v: st.configured ? '已绑定' : '未绑定',
        cls: st.configured ? 'is-ok' : 'is-bad',
        h: st.accountId || '还没有绑微信账号',
      },
      {
        k: '守护进程',
        v: daemon.running ? '在跑' : '没跑',
        cls: daemon.running ? 'is-ok' : 'is-bad',
        h: daemon.pid ? 'pid ' + daemon.pid : '通道没在收消息',
      },
      {
        k: '最近收到',
        v: st.lastInboundAt ? fmtTime(st.lastInboundAt) : '还没收到过',
        h: st.contextTokens ? '会话 ' + st.contextTokens + ' 个' : '还没有会话',
      },
    ]));

    // 发一条试试
    const body = el('div', {});
    const btn = el('button', { class: 'pg-btn', type: 'button' }, sending ? '发送中…' : '发一条测试消息');
    btn.disabled = sending || !st.configured;
    btn.addEventListener('click', sendTest);
    body.appendChild(formRow('收件人', el('span', { class: 'pg-hint' },
      st.defaultRecipientPresent ? '绑定的默认会话 (主人本人)' : '没记默认会话')));
    body.appendChild(formRow('操作', btn));
    host.appendChild(flatSection('发一条试试', '点一下当场知道这条链路通没通', body));

    // 最近收发
    const list = el('div', {});
    if (!recent.length) {
      list.appendChild(el('div', { class: 'pg-hint' }, '还没有收发记录'));
    } else {
      for (const r of recent) {
        const line = el('div', { class: 'pg-list-row' });
        const main = el('div', { class: 'pg-list-main' });
        main.appendChild(el('div', { class: 'pg-list-title' }, KIND_TEXT[r.kind] || r.kind));
        const d = r.detail || {};
        const extra = d.error || (d.chars != null ? d.chars + ' 字' : '') || (d.agentStatus || '');
        if (extra) main.appendChild(el('div', { class: 'pg-list-desc' }, String(extra).slice(0, 80)));
        line.appendChild(main);
        line.appendChild(el('span', { class: 'pg-list-meta' }, fmtTime(r.ts)));
        list.appendChild(line);
      }
    }
    host.appendChild(flatSection('最近收发', '盘古自己记的, 不是猜的', list));

    // 通道位置
    const loc = el('div', {});
    loc.appendChild(formRow('凭据位置', el('span', { class: 'pg-hint' }, st.dir || '—')));
    loc.appendChild(formRow('接入方式', el('span', { class: 'pg-hint' },
      '直连 iLink 微信通道 (不走别的桌面端)')));
    host.appendChild(flatSection('通道', null, loc));
  };

  const sendTest = async () => {
    if (sending) return;
    sending = true;
    paint();
    const res = await api.weixinSend({
      text: '【盘古 · 微信通道自检】这条是从盘古设置页发出来的。收到即链路正常。',
    });
    sending = false;
    if (res && res.ok) toast('已发出, 看微信');
    else toast('发送失败: ' + ((res && (res.message || res.error)) || '未知原因'), true);
    await load();
  };

  const load = async () => {
    loading = true;
    error = null;
    paint();
    const res = await api.weixinStatus();
    loading = false;
    if (!res || !res.ok) {
      error = (res && (res.message || res.error)) || '读不到微信通道状态';
    } else {
      data = res.result || {};
    }
    paint();
  };

  await load();
  return { destroy() {} };
}
