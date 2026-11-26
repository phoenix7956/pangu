// settings/model.mjs —— 设置 · 模型
//
// 从原版 `apps/desktop/src/views/settings/Model.jsx` + `_presets.jsx` + `_model_pool_compact.jsx`
// (git 110661d^) 三份一起搬过来。
//
// 原版规矩 (照搬):
//   · 从上游获取模型名, **不自己填** —— 老板 2026-09-16 拍的。
//   · 加进池 ≠ 调得动 —— 加完必须如实说「加进去了但探不通 / 模型名对不上」。
//   · API Key 不在模型条目里编辑 (走环境变量 / ~/.pangu/credentials.json)。

import { el, elHTML, esc, iconHTML, page, toast, flatSection } from '../../lib/util.mjs';
import { api } from '../../lib/api.mjs';
import { label } from '../../lib/labels.mjs';

const PROTOCOLS = [
  ['openai', 'OpenAI 兼容 (/chat/completions) — 默认'],
  ['anthropic', 'Anthropic 兼容 (/messages)'],
  ['ollama', 'Ollama 本地 (/api/chat)'],
  ['custom', '自定义 (填完整 endpoint, 不补路径)'],
];

const EFFORT_LABEL = { auto: '自动', low: '低', medium: '中', high: '高' };

export async function render(root) {
  // 第 147 批: 页根 = 设计系统的页面外壳 `.pg-page` (全站页面外壳统一)。
  const host = page();
  host.classList.add('pg-settings-col');
  root.appendChild(host);

  const cfg = {
    provider: 'openai',
    protocol_for_add: 'openai',
    openai_base_url_for_add: '',
    openai_api_key: '',
    openai_model_for_add: '',
  };

  let presets = [];
  let selectedPreset = '';
  let upstream = [];
  let upstreamMsg = null;
  let upstreamLoading = false;
  let saving = false;
  let testing = false;
  let pool = { models: [], default_model: null, current_model_id: null };
  let editing = null;

  const topBody = el('div', {});
  host.appendChild(flatSection('模型配置 · 从上游获取, 不自己填', null, topBody));

  const poolBody = el('div', {});
  host.appendChild(flatSection('模型池', null, poolBody));

  const modalHost = el('div');
  host.appendChild(modalHost);

  function paintTop() {
    topBody.innerHTML = '';

    const pW = el('div', { class: 'pg-field' });
    pW.appendChild(el('span', { class: 'pg-label' }, '模型厂商预设'));
    const pSel = el('select', { class: 'pg-input' });
    for (const p of presets.filter((x) => !String(x.key).startsWith('custom'))) {
      pSel.appendChild(el('option', { value: p.key }, p.name));
    }
    pSel.appendChild(el('option', { value: 'custom' }, '— 自定义 —'));
    pSel.value = selectedPreset || cfg.provider || 'openai';
    pSel.addEventListener('change', () => applyPreset(pSel.value));
    pW.appendChild(pSel);
    topBody.appendChild(pW);
    const note = presets.find((p) => p.key === selectedPreset);
    if (note && note.note) {
      topBody.appendChild(elHTML('div', { class: 'pg-hint pg-ico-line' },
        iconHTML('info', 13) + '<span>' + note.note + '</span>'));
    }
    if (note && note.api_protocol && note.api_protocol !== 'openai') {
      topBody.appendChild(elHTML('div', { class: 'pg-warn-chip pg-ico-line' },
        iconHTML('alert-triangle', 13) + '<span>接口协议不是 OpenAI 兼容: '
          + esc(label('PROTOCOL', note.api_protocol)) + '</span>'));
    }

    const prW = el('div', { class: 'pg-field' });
    prW.appendChild(el('span', { class: 'pg-label' }, '协议 (决定路径补全方式)'));
    const prSel = el('select', { class: 'pg-input' });
    for (const pair of PROTOCOLS) prSel.appendChild(el('option', { value: pair[0] }, pair[1]));
    prSel.value = cfg.protocol_for_add;
    prSel.addEventListener('change', () => { cfg.protocol_for_add = prSel.value; });
    prW.appendChild(prSel);
    topBody.appendChild(prW);

    const bW = el('div', { class: 'pg-field' });
    bW.appendChild(el('span', { class: 'pg-label' }, '接口地址 (上游获取按这个拉)'));
    const bI = el('input', {
      class: 'pg-input mono',
      type: 'text',
      value: cfg.openai_base_url_for_add,
      placeholder: 'https://api.openai.com/v1 (填简化 URL, 自动补路径)',
    });
    bI.addEventListener('input', () => { cfg.openai_base_url_for_add = bI.value; });
    bW.appendChild(bI);
    topBody.appendChild(bW);

    const kW = el('div', { class: 'pg-field' });
    kW.appendChild(el('span', { class: 'pg-label' }, '密钥 API Key (本地模型可留空)'));
    const kI = el('input', {
      class: 'pg-input mono',
      type: 'password',
      value: cfg.openai_api_key,
      placeholder: '云端填 sk-… / 本地可留空',
    });
    kI.addEventListener('input', () => { cfg.openai_api_key = kI.value; });
    kW.appendChild(kI);
    topBody.appendChild(kW);

    const row = el('div', { class: 'pg-btn-row' });
    const bUp = elHTML('button', { class: 'pg-btn pg-btn-grow pg-btn-ico', type: 'button' },
      upstreamLoading ? '获取中…' : (iconHTML('download', 14) + '<span>从上游获取模型列表</span>'));
    bUp.disabled = upstreamLoading || !cfg.openai_base_url_for_add.trim();
    bUp.addEventListener('click', () => fetchUpstream());
    const bTest = elHTML('button', { class: 'pg-btn pg-btn-grow pg-btn-ico', type: 'button' },
      testing ? '测试中…' : (iconHTML('plug', 14) + '<span>测试连通性</span>'));
    bTest.disabled = testing || !cfg.openai_base_url_for_add.trim() || !cfg.openai_model_for_add.trim();
    bTest.addEventListener('click', () => testConnection());
    row.appendChild(bUp);
    row.appendChild(bTest);
    topBody.appendChild(row);

    if (upstreamMsg) {
      topBody.appendChild(el('div', {
        class: 'pg-msg-line ' + (upstreamMsg.kind === 'success' ? 'is-ok' : 'is-bad'),
      }, upstreamMsg.text));
    }

    if (upstream.length) {
      const box = el('div', { class: 'pg-upstream-list' });
      box.appendChild(el('div', { class: 'pg-upstream-head' },
        '上游模型 (' + upstream.length + ') — 点行加池, 官方 ctx 自动带'));
      for (const um of upstream) {
        const r = el('button', { class: 'pg-upstream-row', type: 'button' });
        r.appendChild(el('span', { class: 'pg-upstream-name' }, um.name || um.id));
        r.appendChild(el('span', { class: 'pg-upstream-id mono' }, um.id));
        r.appendChild(el('span', { class: 'pg-upstream-ctx' },
          um.context_length ? Math.round(um.context_length / 1024) + 'K · 官方' : '未报 · 后端补'));
        r.appendChild(elHTML('span', { class: 'pg-upstream-add' },
          iconHTML('plus', 12) + '<span>加池</span>'));
        r.addEventListener('click', () => addUpstreamModel(um));
        box.appendChild(r);
      }
      topBody.appendChild(box);
    }

    const mRow = el('div', { class: 'pg-field-row' });
    const mW = el('div', { class: 'pg-field pg-field-grow' });
    mW.appendChild(el('span', { class: 'pg-label' }, '模型名 (本地 / 上游没有的, 手填)'));
    const mI = el('input', {
      class: 'pg-input mono',
      type: 'text',
      value: cfg.openai_model_for_add,
      placeholder: 'MiniMax-M3 / qwen-plus / 自定义',
    });
    mI.addEventListener('input', () => { cfg.openai_model_for_add = mI.value; });
    mW.appendChild(mI);
    mRow.appendChild(mW);
    const bAdd = elHTML('button', { class: 'pg-btn pg-btn-primary pg-btn-ico', type: 'button' },
      saving ? '加中…' : (iconHTML('plus', 14) + '<span>加入到模型池</span>'));
    bAdd.disabled = saving || !cfg.openai_model_for_add.trim() || !cfg.openai_base_url_for_add.trim();
    bAdd.addEventListener('click', () => addManual());
    mRow.appendChild(bAdd);
    topBody.appendChild(mRow);
  }

  function paintPool() {
    poolBody.innerHTML = '';

    const head = el('div', { class: 'pg-pool-head' });
    head.appendChild(el('span', { class: 'pg-hint' }, '模型池 (' + pool.models.length + ')'));
    const tools = el('div', { class: 'pg-pool-tools' });

    const bSelf = elHTML('button', {
      class: 'pg-link-btn',
      type: 'button',
      title: '让每个模型自己回答 vision/reasoning/tool/ctx (异步, 不阻塞)',
    }, iconHTML('zap', 13) + '<span>全部自报</span>');
    bSelf.addEventListener('click', async () => {
      if (!window.confirm('让所有模型自报能力 (每个 5-25s)? 已显式配置的不会被覆盖。')) return;
      toast('启动 ' + pool.models.length + ' 个模型自报, 后台跑…');
      for (const m of pool.models) {
        api.selfReport({ model_id: m.id, lang: 'both' }).then((r) => {
          if (r && r.ok) {
            const c = r.capabilities || {};
            toast(m.id + ': v=' + c.vision + ' r=' + c.reasoning + ' t=' + c.tool);
            fetchPool();
          }
        });
      }
    });

    const bSync = elHTML('button', {
      class: 'pg-link-btn',
      type: 'button',
      title: '同步云端模型能力库',
    }, iconHTML('refresh', 13) + '<span>同步云端</span>');
    bSync.addEventListener('click', async () => {
      const r = await api.syncCapabilities();
      if (r && r.ok) toast('云端能力库已同步: ' + ((r && r.count) || 0) + ' 个模型');
      else toast('同步失败: ' + ((r && r.error) || '未知'), true);
      fetchPool();
    });

    const bLm = elHTML('button', {
      class: 'pg-link-btn',
      type: 'button',
      title: '读本机 LM Studio 真源',
    }, iconHTML('cpu', 13) + '<span>同步 LM Studio</span>');
    bLm.addEventListener('click', async () => {
      const d = await api.lmstudioDiscover();
      if (d && d.ok) {
        const matched = (d.matches || []).filter((x) => x.hit).length;
        toast('LM Studio 找到 ' + ((d && d.hub_count) || 0) + ' 个模型, 匹配当前池 ' + matched + ' 个');
        fetchPool();
      } else toast('discover failed', true);
    });

    const bApply = elHTML('button', {
      class: 'pg-link-btn',
      type: 'button',
      title: '用 LM Studio 真源覆盖 vision/reasoning/tool/ctx',
    }, iconHTML('zap', 13) + '<span>一键覆盖</span>');
    bApply.addEventListener('click', async () => {
      if (!window.confirm('用 LM Studio model.yaml 真源覆盖所有模型池的 vision/reasoning/tool 字段?')) return;
      const r = await api.lmstudioApply({ force: true });
      if (r && r.ok) {
        const hits = (r.results || []).filter((x) => x.ok).length;
        toast('已覆盖 ' + hits + ' 个模型');
        fetchPool();
      } else toast('apply failed', true);
    });

    for (const b of [bSelf, bSync, bLm, bApply]) tools.appendChild(b);
    head.appendChild(tools);
    poolBody.appendChild(head);

    if (!pool.models.length) {
      poolBody.appendChild(el('div', { class: 'pg-empty' }, '池子空着。点上方「加入到模型池」添加。'));
      return;
    }

    // 第 147 批: 全站只有一张表的画法 —— `.pg-table`。
    //   以前这里是 `.t` (另一套表: 表头 12px/500 + 发丝线), 跟状态页、
    //   设置页的表并排 ⇒ 三种表格三种样子。
    const t = el('table', { class: 'pg-table pg-pool-table' });
    t.appendChild(el('thead', {
      html: '<tr><th>名称</th><th>上下文</th><th>自动压缩</th><th>接入地址</th><th></th></tr>',
    }));
    const tb = el('tbody');
    for (const m of pool.models) {
      const isCurrent = m.id === pool.current_model_id;
      const tr = el('tr', { class: m.enabled === false ? 'is-dim' : '' });

      const c1 = el('td');
      const nm = el('div', { class: 'pg-pool-name' });
      nm.appendChild(elHTML('span', { class: 'pg-pool-mark' },
        isCurrent ? iconHTML('play', 10) : (m.enabled === false ? iconHTML('pause', 10) : '')));
      nm.appendChild(el('span', {}, m.name || m.id));
      if (m.vision === true) {
        nm.appendChild(elHTML('span', { class: 'pg-ico-dot', title: '支持视觉' }, iconHTML('eye', 12)));
      } else if (m.vision === false) {
        nm.appendChild(elHTML('span', { class: 'pg-ico-dot is-dim', title: '文本模型' }, iconHTML('eye', 12)));
      } else {
        nm.appendChild(elHTML('span', { class: 'pg-ico-dot is-dim', title: '未知 — 点「同步 LM Studio」或编辑探测' },
          iconHTML('help-circle', 12)));
      }
      c1.appendChild(nm);
      c1.appendChild(el('div', { class: 'pg-hint' }, (m.capabilities || []).join(' · ') || '—'));
      tr.appendChild(c1);

      const c2 = el('td', { class: 'mono pg-tiny' });
      c2.appendChild(el('span', {}, m.context_length ? Math.round(m.context_length / 1024) + 'K' : '未探测'));
      if (m._ctx_source_label) c2.appendChild(el('span', { class: 'pg-ctx-tag' }, m._ctx_source_label));
      tr.appendChild(c2);

      tr.appendChild(el('td', { class: 'mono pg-tiny' },
        m._auto_compact_at ? Math.round(m._auto_compact_at / 1024) + 'K (80%)' : '—'));

      tr.appendChild(el('td', { class: 'mono pg-tiny pg-cell-truncate' }, m.endpoint || '—'));

      const c4 = el('td', { class: 'pg-td-right' });
      const acts = el('div', { class: 'pg-act-row' });
      if (!isCurrent && m.enabled !== false) {
        const b = el('button', { class: 'pg-link-btn', type: 'button' }, '使用');
        b.addEventListener('click', () => onUse(m));
        acts.appendChild(b);
      }
      const bT = el('button', { class: 'pg-link-btn', type: 'button' }, m.enabled === false ? '启' : '停');
      bT.addEventListener('click', () => onToggle(m));
      const bE = el('button', { class: 'pg-link-btn', type: 'button' }, '编');
      bE.addEventListener('click', () => { editing = Object.assign({}, m); paintModal(); });
      const bD = el('button', { class: 'pg-link-btn is-danger', type: 'button' }, '删');
      bD.addEventListener('click', () => onDelete(m));
      acts.appendChild(bT);
      acts.appendChild(bE);
      acts.appendChild(bD);
      c4.appendChild(acts);
      tr.appendChild(c4);
      tb.appendChild(tr);
    }
    t.appendChild(tb);
    poolBody.appendChild(t);
  }
  function paintModal() {
    modalHost.innerHTML = '';
    if (!editing) return;
    const back = el('div', { class: 'pg-modal-back' });
    back.addEventListener('click', () => { editing = null; paintModal(); });
    const box = el('div', { class: 'pg-modal-box' });
    box.addEventListener('click', (e) => e.stopPropagation());
    box.appendChild(el('div', { class: 'pg-modal-title' }, '编辑模型'));

    const mk = (label, key, mono) => {
      const w = el('div', { class: 'pg-field' });
      w.appendChild(el('span', { class: 'pg-label' }, label));
      const i = el('input', {
        class: 'pg-input' + (mono ? ' mono' : ''),
        type: 'text',
        value: editing[key] == null ? '' : String(editing[key]),
      });
      i.addEventListener('input', () => { editing[key] = i.value; });
      w.appendChild(i);
      return w;
    };
    box.appendChild(mk('模型名', 'name'));
    box.appendChild(mk('Endpoint', 'endpoint', true));

    const vBox = el('div', { class: 'pg-vision-box' });
    const vTop = el('div', { class: 'pg-vision-top' });
    vTop.appendChild(elHTML('span', { class: 'pg-toggle-label' },
      iconHTML('eye', 13) + '<span>支持视觉 (多模态)</span>'));
    if (editing._vision_probe) {
      vTop.appendChild(el('span', {
        class: 'pg-badge' + (editing._vision_probe.vision ? ' pg-badge-ok' : ''),
      }, editing._vision_probe.vision ? '✓ 探测通过' : '✗ 探测不通过'));
    }
    const vRight = el('div', { class: 'pg-vision-right' });
    const bProbe = elHTML('button', { class: 'pg-btn pg-btn-sm pg-btn-ico', type: 'button' },
      editing._probing ? '探测中…' : (iconHTML('search', 13) + '<span>自动探测</span>'));
    bProbe.disabled = !!editing._probing;
    bProbe.addEventListener('click', async () => {
      if (!editing.endpoint || !editing.id) { toast('缺 endpoint / id', true); return; }
      editing._probing = true;
      paintModal();
      try {
        const r = await api.probeVision(editing);
        if (r && r.ok) {
          editing._vision_probe = r;
          editing.vision = !!r.vision;
          toast(r.vision ? '✓ 多模态 (探测返回颜色词)'
            : '✗ 探测失败, status=' + ((r && r.status) || '?'), !r.vision);
        } else {
          toast('✗ ' + ((r && r.error) || 'probe failed'), true);
        }
      } catch (e) {
        toast('✗ ' + (e.message || 'probe error'), true);
      } finally {
        editing._probing = false;
        paintModal();
      }
    });
    vRight.appendChild(bProbe);
    const cbWrap = el('label', { class: 'pg-check-row' });
    const cb = el('input', { type: 'checkbox' });
    cb.checked = editing.vision === true;
    cb.addEventListener('change', () => { editing.vision = cb.checked; });
    cbWrap.appendChild(cb);
    cbWrap.appendChild(el('span', {}, editing.vision === true ? '开' : '关'));
    vRight.appendChild(cbWrap);
    vTop.appendChild(vRight);
    vBox.appendChild(vTop);
    vBox.appendChild(el('div', { class: 'pg-hint' },
      '三层识别: ① 端点 metadata → ② 自动探测 (真发 1×1 红色 PNG) → ③ 你自己勾。关掉 = 文本模型, vision 任务不会派给它。'));
    if (editing._vision_probe && editing._vision_probe.response_excerpt) {
      vBox.appendChild(el('div', { class: 'pg-hint pg-italic' },
        '模型回: "' + editing._vision_probe.response_excerpt + '"'));
    }
    box.appendChild(vBox);

    box.appendChild(elHTML('div', { class: 'pg-hint pg-note-box pg-ico-line' },
      iconHTML('key', 13) + '<span>API Key 不在此处编辑 (走环境变量 / ~/.pangu/credentials.json)</span>'));

    const effWrap = el('div', { class: 'pg-field' });
    const effHead = el('div', { class: 'pg-slider-top' });
    effHead.appendChild(el('span', { class: 'pg-toggle-label' }, '推理强度'));
    const mode = ['low', 'medium', 'high'].includes(editing.reasoning_effort) ? editing.reasoning_effort : 'auto';
    effHead.appendChild(el('span', { class: 'pg-slider-val' }, EFFORT_LABEL[mode]));
    effWrap.appendChild(effHead);
    const effRow = el('div', { class: 'pg-effort-row' });
    for (const o of ['auto', 'low', 'medium', 'high']) {
      const b = el('button', { class: 'pg-effort-btn' + (mode === o ? ' on' : ''), type: 'button' }, EFFORT_LABEL[o]);
      b.addEventListener('click', () => {
        editing.reasoning_effort = o === 'auto' ? null : o;
        paintModal();
      });
      effRow.appendChild(b);
    }
    effWrap.appendChild(effRow);
    box.appendChild(effWrap);

    const foot = el('div', { class: 'pg-modal-foot' });
    const bCancel = el('button', { class: 'pg-btn', type: 'button' }, '取消');
    bCancel.addEventListener('click', () => { editing = null; paintModal(); });
    const bSave = el('button', { class: 'pg-btn pg-btn-primary', type: 'button' }, '保存');
    bSave.addEventListener('click', async () => {
      const r = await api.modelsUpdate(editing);
      if (r && r.ok) {
        toast('已更新');
        editing = null;
        paintModal();
        await fetchPool();
      } else {
        toast('✗ ' + ((r && r.error) || 'update failed'), true);
      }
    });
    foot.appendChild(bCancel);
    foot.appendChild(bSave);
    box.appendChild(foot);

    back.appendChild(box);
    modalHost.appendChild(back);
  }

  function applyPreset(key) {
    const preset = presets.find((p) => p.key === key);
    selectedPreset = key;
    if (!preset) { paintTop(); return; }
    const endpoint = preset.base_url
      + (preset.default_port && preset.default_port > 0 ? ':' + preset.default_port : '');
    cfg.provider = preset.key;
    cfg.openai_base_url_for_add = endpoint;
    cfg.openai_model_for_add = '';
    cfg.openai_api_key = '';
    paintTop();
  }

  async function fetchUpstream() {
    const provider = cfg.provider || 'openai';
    upstreamLoading = true;
    upstreamMsg = null;
    upstream = [];
    paintTop();
    try {
      const r = await api.providerModelsRefresh(provider, {
        endpoint: (cfg.openai_base_url_for_add || '').trim(),
        api_key: cfg.openai_api_key || '',
        protocol: cfg.protocol_for_add || 'openai',
      });
      if (r && r.ok && Array.isArray(r.models)) {
        upstream = r.models;
        upstreamMsg = {
          kind: 'success',
          text: '✓ 上游获取 ' + r.models.length + ' 个模型 (' + ((r && r.endpoint) || provider) + ')',
        };
      } else {
        upstreamMsg = {
          kind: 'error',
          text: '✗ ' + ((r && r.error) || '上游获取失败, 该 provider 可能没配 key'),
        };
      }
    } catch (e) {
      upstreamMsg = { kind: 'error', text: '✗ ' + (e.message || '上游获取异常') };
    } finally {
      upstreamLoading = false;
      paintTop();
    }
  }

  function showAddResult(r, label) {
    if (r && r.model_mismatch) {
      toast('注意: 加进去了, 但调的不是这个模型: '
        + (((r.probe && r.probe.model_mismatch_hint)) || '模型名对不上'), true);
      return;
    }
    if (r && r.reachable === false) {
      toast('注意: 加进去了, 但探不通: '
        + (((r.probe && r.probe.error_hint)) || (r.warning) || '端点连不上'), true);
      return;
    }
    toast('✓ 已加并测通: ' + label);
  }

  async function addUpstreamModel(um) {
    const m = {
      id: um.id,
      api_model: um.id,
      name: um.name || um.id,
      provider: um.provider || cfg.provider || 'openai',
      protocol: um.protocol || cfg.protocol_for_add || 'openai',
      endpoint: cfg.openai_base_url_for_add || '',
      api_key: cfg.openai_api_key || '',
      tier: um.tier || 'large',
      capabilities: um.capabilities || ['chat'],
      priority: 100,
      enabled: true,
      _ctx_hint: um.context_length || null,
    };
    saving = true;
    paintTop();
    const r = await api.modelsAdd(m);
    saving = false;
    if (r && r.ok) {
      showAddResult(r, m.name
        + (um.context_length ? ' · 官方 ' + Math.round(um.context_length / 1024) + 'K' : ''));
      upstream = upstream.filter((x) => x.id !== um.id);
      await fetchPool();
    } else {
      toast('✗ ' + ((r && r.error) || 'add failed'), true);
    }
    paintTop();
  }

  async function addManual() {
    const m = {
      id: (cfg.openai_model_for_add || 'custom').toLowerCase().replace(/[^a-z0-9._-]/g, '_'),
      api_model: cfg.openai_model_for_add || undefined,
      name: cfg.openai_model_for_add || 'Custom',
      provider: cfg.provider || 'openai',
      protocol: cfg.protocol_for_add || 'openai',
      endpoint: cfg.openai_base_url_for_add || '',
      api_key: cfg.openai_api_key || '',
      tier: 'large',
      capabilities: ['chat', 'reasoning'],
      priority: 100,
      enabled: true,
    };
    saving = true;
    paintTop();
    const r = await api.modelsAdd(m);
    saving = false;
    if (r && r.ok) {
      showAddResult(r, m.name);
      await fetchPool();
      cfg.openai_api_key = '';
    } else {
      toast('✗ ' + ((r && r.error) || 'add failed'), true);
    }
    paintTop();
  }

  async function testConnection() {
    testing = true;
    paintTop();
    try {
      const r = await api.modelsTestConnection({
        base_url: cfg.openai_base_url_for_add,
        api_key: cfg.openai_api_key || '',
        model: cfg.openai_model_for_add,
        protocol: cfg.protocol_for_add || 'openai',
        provider: cfg.provider || 'openai',
      });
      if (r && r.ok) toast('✓ 连通 (HTTP ' + ((r && r.status) || '?') + ')');
      else toast('✗ HTTP ' + ((r && r.status) || '?') + ': '
        + String((r && (r.error || r.data)) || 'unknown').slice(0, 80), true);
    } catch (e) {
      toast('✗ ' + (e.message || 'connect failed'), true);
    } finally {
      testing = false;
      paintTop();
    }
  }

  async function fetchPool() {
    const r = await api.modelsList();
    if (r && r.ok) {
      pool = {
        models: r.models || [],
        default_model: r.default_model,
        current_model_id: r.current_model_id,
      };
    }
    paintPool();
  }

  async function onUse(m) {
    const r = await api.modelsUse(m.id);
    if (r && r.ok) { toast('已切换到: ' + (m.name || m.id)); await fetchPool(); }
    else toast('✗ ' + ((r && r.error) || 'update failed'), true);
  }

  async function onToggle(m) {
    const r = await api.modelsUpdate(Object.assign({}, m, { enabled: m.enabled === false ? true : false }));
    if (r && r.ok) { await fetchPool(); toast(m.enabled === false ? '已启' : '已停'); }
    else toast('✗ ' + ((r && r.error) || 'update failed'), true);
  }

  async function onDelete(m) {
    if (!window.confirm('确定删 ' + m.id + '?')) return;
    const r = await api.modelsDelete(m.id);
    if (r && r.ok) { toast('删了'); await fetchPool(); }
    else toast('✗ ' + ((r && r.error) || 'delete failed'), true);
  }

  try {
    const d = await api.config();
    const config = d && (d.data || d.config);
    if (d && d.ok && config && config.llm) {
      Object.assign(cfg, config.llm);
      cfg.protocol_for_add = cfg.protocol_for_add || 'openai';
    }
  } catch (e) { /* 配置读不到就用默认值 */ }

  try {
    const r = await api.presetsList();
    if (r && r.ok) {
      presets = r.presets || [];
      selectedPreset = cfg.provider || 'openai';
    }
  } catch (e) { /* 预设读不到就空着 */ }

  paintTop();
  await fetchPool();
  return {};
}

export default render;
