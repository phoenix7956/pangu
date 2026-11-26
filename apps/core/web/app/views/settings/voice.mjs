// settings/voice.mjs —— 设置 · 语音
//
// 从原版 `apps/desktop/src/views/settings/Voice.jsx` (git 110661d^) 搬过来。

import { el, page, toast, flatSection } from '../../lib/util.mjs';
import { api } from '../../lib/api.mjs';
import { toggle } from '../../components/settings-widgets.mjs';

const DEFAULTS = {
  enabled: true,
  mode: 'toggle',
  stt_provider: 'local_whisper',
  stt_model: 'medium',
  stt_endpoint: 'api/voice/transcribe',
  stt_api_key: '',
  tts_provider: 'macos_say',
  tts_voice: 'Tingting',
  tts_speed: 190,
  auto_play: true,
  camera_device: '',
  microphone_device: '',
  speaker_device: '',
};

export async function render(root) {
  // 第 147 批: 页根 = 设计系统的页面外壳 `.pg-page` (全站页面外壳统一)。
  const host = page();
  host.classList.add('pg-settings-col');
  root.appendChild(host);

  let cfg = { ...DEFAULTS };
  let devices = { audioinput: [], videoinput: [], audiooutput: [] };
  let status = null;

  const paint = () => {
    host.innerHTML = '';

    /* 设备 */
    const b1 = el('div', {});
    /* cfgKey 跟显示名分开: 标签是人话 (「麦克风设备」),
       存的还是配置键 (microphone_device)。以前两样都用配置键,
       界面上直接印着 camera_device / microphone_device ——
       一排英文 snake_case 夹在中文界面里, 一眼就粗糙。 */
    const select = (cfgKey, label, value, list, blank) => {
      const w = el('div', { class: 'pg-field' });
      w.appendChild(el('span', { class: 'pg-label' }, label));
      const s = el('select', { class: 'pg-input pg-input-narrow' });
      s.appendChild(el('option', { value: '' }, blank));
      for (const d of list) s.appendChild(el('option', { value: d.id }, d.label));
      s.value = value || '';
      s.addEventListener('change', () => { cfg[cfgKey] = s.value; });
      w.appendChild(s);
      return w;
    };
    b1.appendChild(select('camera_device', '摄像头设备', cfg.camera_device, devices.videoinput, '自动选择'));
    b1.appendChild(select('microphone_device', '麦克风设备', cfg.microphone_device, devices.audioinput, '自动选择'));
    b1.appendChild(select('speaker_device', '扬声器设备', cfg.speaker_device, devices.audiooutput, '系统默认'));
    const bReload = el('button', { class: 'pg-btn', type: 'button' }, '重新检测设备');
    bReload.addEventListener('click', () => loadDevices(true));
    b1.appendChild(bReload);
    host.appendChild(flatSection('设备', null, b1));

    /* 语音输入 */
    const b2 = el('div', {});
    b2.appendChild(toggle(cfg.enabled, (v) => { cfg.enabled = v; }, '启用语音交流', '聊天窗口显示麦克风切换按钮'));
    const modeWrap = el('div', { class: 'pg-field' });
    modeWrap.appendChild(el('span', { class: 'pg-label' }, '输入方式'));
    const modeSel = el('select', { class: 'pg-input pg-input-narrow' });
    modeSel.appendChild(el('option', { value: 'toggle' }, '点按切换 (再点一次结束本轮)'));
    modeSel.appendChild(el('option', { value: 'continuous' }, '连续对话 (回答后自动继续听)'));
    modeSel.value = cfg.mode || 'toggle';
    modeSel.addEventListener('change', () => { cfg.mode = modeSel.value; });
    modeWrap.appendChild(modeSel);
    b2.appendChild(modeWrap);
    const modelWrap = el('div', { class: 'pg-field' });
    modelWrap.appendChild(el('span', { class: 'pg-label' }, '本地识别模型'));
    const modelSel = el('select', { class: 'pg-input pg-input-narrow' });
    for (const [v, n] of [['tiny', 'Whisper Tiny · 最快'], ['base', 'Whisper Base'], ['small', 'Whisper Small · 较快'], ['medium', 'Whisper Medium · 推荐']]) {
      modelSel.appendChild(el('option', { value: v }, n));
    }
    modelSel.value = cfg.stt_model || 'medium';
    modelSel.addEventListener('change', () => { cfg.stt_model = modelSel.value; });
    modelWrap.appendChild(modelSel);
    b2.appendChild(modelWrap);
    b2.appendChild(el('div', { class: 'pg-hint' }, '使用本机已安装的 Whisper 模型, 语音不离开这台机器, 无需单独启动 8765 服务。'));
    host.appendChild(flatSection('语音输入', null, b2));

    /* 语音回答 */
    const b3 = el('div', {});
    const engWrap = el('div', { class: 'pg-field' });
    engWrap.appendChild(el('span', { class: 'pg-label' }, '合成引擎'));
    const engSel = el('select', { class: 'pg-input pg-input-narrow' });
    engSel.appendChild(el('option', { value: 'macos_say' }, 'macOS 系统语音'));
    engSel.value = 'macos_say';
    engSel.addEventListener('change', () => { cfg.tts_provider = 'macos_say'; });
    engWrap.appendChild(engSel);
    b3.appendChild(engWrap);
    b3.appendChild(el('div', { class: 'pg-hint' }, '当前接入的是本机 macOS 系统语音。'));

    const voiceWrap = el('div', { class: 'pg-field' });
    voiceWrap.appendChild(el('span', { class: 'pg-label' }, '声音'));
    const voiceInp = el('input', { class: 'pg-input pg-input-narrow', type: 'text', value: cfg.tts_voice || '' });
    voiceInp.addEventListener('input', () => { cfg.tts_voice = voiceInp.value; });
    voiceWrap.appendChild(voiceInp);
    b3.appendChild(voiceWrap);

    const speedWrap = el('div', { class: 'pg-field' });
    speedWrap.appendChild(el('span', { class: 'pg-label' }, '语速: ' + (cfg.tts_speed || 190) + ' 字/分钟'));
    const speed = el('input', { class: 'pg-range', type: 'range', min: '120', max: '260', step: '5', value: String(cfg.tts_speed || 190) });
    speed.addEventListener('input', () => {
      cfg.tts_speed = Number(speed.value);
      speedWrap.firstChild.textContent = '语速: ' + cfg.tts_speed + ' 字/分钟';
    });
    speedWrap.appendChild(speed);
    b3.appendChild(speedWrap);

    b3.appendChild(toggle(cfg.auto_play, (v) => { cfg.auto_play = v; }, '自动播放回答', '盘古完成回答后自动朗读'));

    if (status) {
      // 第 147 批: 状态行走设置页统一的那一种消息条 (`.pg-msg-line`),
      //   原来这里私有一份 `.pg-status-line` —— 同一件事两处定义。
      const s = el('div', { class: 'pg-msg-line' });
      s.appendChild(el('div', {}, '语音识别: ' + (status.stt && status.stt.ok ? '可用' : '未接入')
        + ' · 语音朗读: ' + (status.tts && status.tts.ok ? '可用' : '不可用')
        + ' · 麦克风: ' + (status.microphone && status.microphone.ok ? '可用' : '未检测到')));
      if (status.microphone && !status.microphone.display) {
        s.appendChild(el('div', { class: 'pg-warn-text' },
          status.microphone.message || '未检测到指定麦克风输入, 盘古不会静默改用其他麦克风。'));
      }
      b3.appendChild(s);
    }

    const row = el('div', { class: 'pg-btn-row' });
    const bTest = el('button', { class: 'pg-btn', type: 'button' }, '测试语音服务');
    bTest.addEventListener('click', async () => {
      const r = await api.voiceStatus();
      status = r;
      const ok = r && r.stt && r.stt.ok && r.tts && r.tts.ok;
      const msg = ok
        ? '本地识别模型与语音播放环境可用'
        : ((r && r.stt && r.stt.ok)
          ? '语音播放不可用: ' + ((r.tts && r.tts.message) || '未知原因')
          : '本地识别不可用: ' + ((r && r.stt && r.stt.message) || '未知原因'));
      toast(msg, !ok);
      paint();
    });
    row.appendChild(bTest);
    const bSave = el('button', { class: 'pg-btn pg-btn-primary', type: 'button' }, '保存语音配置');
    bSave.addEventListener('click', async () => {
      bSave.disabled = true;
      bSave.textContent = '保存中…';
      try {
        const next = { ...cfg, tts_speed: Number(cfg.tts_speed) || 190 };
        // 后端回的密钥是打码的, 别把它当新值写回去。
        if (next.stt_api_key === '***') delete next.stt_api_key;
        if (next.tts_api_key === '***') delete next.tts_api_key;
        const r = await api.patchConfig({ voice: next });
        toast(r && r.ok ? '语音配置已保存' : ((r && r.error) || '保存失败'), !(r && r.ok));
      } catch (e) {
        toast(e.message || '保存失败', true);
      } finally {
        bSave.disabled = false;
        bSave.textContent = '保存语音配置';
      }
    });
    row.appendChild(bSave);
    b3.appendChild(row);
    host.appendChild(flatSection('语音回答', null, b3));
  };

  async function loadDevices(requestPermission) {
    try {
      const native = await api.voiceDevices();
      if (native && native.ok) devices = native.devices || devices;
      if (requestPermission && navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());
      }
      if (navigator.mediaDevices && navigator.mediaDevices.enumerateDevices) {
        const browser = await navigator.mediaDevices.enumerateDevices();
        const by = (type) => browser.filter((d) => d.kind === type).map((d) => ({
          id: d.deviceId,
          label: d.label || (type === 'videoinput' ? '摄像头' : type === 'audioinput' ? '麦克风' : '扬声器'),
        }));
        const ai = by('audioinput');
        const vi = by('videoinput');
        const ao = by('audiooutput');
        devices = {
          audioinput: ai.some((d) => d.label !== '麦克风') ? ai : devices.audioinput,
          videoinput: vi.some((d) => d.label !== '摄像头') ? vi : devices.videoinput,
          audiooutput: ao.some((d) => d.label !== '扬声器') ? ao : devices.audiooutput,
        };
      }
    } catch (e) { /* 设备枚举失败就用后端给的那份 */ }
    paint();
  }

  try {
    const r = await api.config();
    const config = r && (r.data || r.config);
    if (r && r.ok && config && config.voice) {
      cfg = { ...cfg, ...config.voice };
      if (cfg.stt_endpoint === 'http://127.0.0.1:8765') cfg.stt_endpoint = 'api/voice/transcribe';
    }
  } catch (e) { /* 配置读不到就用默认值 */ }

  paint();
  await loadDevices(false);
  try { status = await api.voiceStatus(); } catch (e) { /* 没有就留着空 */ }
  paint();
  return {};
}

export default render;
