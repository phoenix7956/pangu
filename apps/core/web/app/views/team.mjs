// team.mjs —— 自动化: 定时任务实况 + 增删 (原版 TeamFlow 的同一份逻辑)
//
// 数据: GET /api/teamflow/tasks (launchctl + plist 实时读)
// 新增: POST /api/teamflow/tasks {label, program, args, schedule_type, schedule_value, env}
// 删除: DELETE /api/teamflow/tasks/:label
import {
  el, elHTML, esc, iconHTML, json, send, flatSection, section, formGrid,
  page, list, listRow, footband,
} from '../lib/util.mjs';

export async function render(root) {
  const box = page();
  root.appendChild(box);

  // 第 170 批: 这一页原来的表单是**一竖条六个裸输入框** + 行内样式对齐,
  //   跟别的页的表单长得不一样。现在: 表单区 = 一个有框区块 (section),
  //   字段用统一的 formGrid 排 (标签在上、控件在下、列数自适应),
  //   动作按钮在区块头 —— 全站表单只有这一种画法。
  const formFields = el('div');
  const mkInput = (label, ph, val) => {
    const wrap = el('label', { class: 'pg-field' });
    wrap.appendChild(el('span', { class: 'pg-label' }, label));
    const i = el('input', { type: 'text', class: 'pg-input', placeholder: ph });
    if (val) i.value = val;
    wrap.appendChild(i);
    return { wrap, i };
  };
  const fLabel = mkInput('任务标识', 'local.pangu.my-task', 'local.pangu.');
  const fProgram = mkInput('执行程序', '/path/to/script.sh', '');
  const fArgs = mkInput('参数', 'arg1 arg2 (空格分隔)', '');
  const fSched = mkInput('执行计划', '每天 HH:MM 或每 N 秒', '04:00');
  const fPath = mkInput('PATH', '冒号分隔', '/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin');
  const fHome = mkInput('HOME', '可留空 (留空则不写进 plist)', '');
  const errLine = el('div', { class: 'errbox', hidden: true });
  const cancelBtn = el('button', { class: 'pg-btn', type: 'button' }, '取消');
  const submitBtn = el('button', { class: 'pg-btn pg-btn-primary', type: 'button' }, '创建');
  formFields.appendChild(formGrid([
    fLabel.wrap, fProgram.wrap, fArgs.wrap, fSched.wrap, fPath.wrap, fHome.wrap,
  ], { cols: 2 }));
  formFields.appendChild(errLine);
  const formBtns = el('div', { class: 'pg-btn-row' });
  formBtns.appendChild(cancelBtn); formBtns.appendChild(submitBtn);
  formFields.appendChild(formBtns);

  // 表单块: 有框区块 (页面上唯一一个有框的东西 —— 它是「要装东西的表单」)。
  const formBlock = section('新建定时任务', '任务标识必须含 pangu', formFields,
    [cancelBtn, submitBtn]);
  formBlock.hidden = true;
  // 按钮已经在区块头里, 不再在表单体里放一份。
  formFields.removeChild(formBtns);

  const count = el('span', { class: 'hint' }, '读任务…');
  const newBtn = elHTML('button', { class: 'pg-btn', type: 'button' },
    iconHTML('plus', 14) + '<span>新建</span>');
  const refreshBtn = elHTML('button', { class: 'pg-btn', type: 'button' },
    iconHTML('refresh', 14) + '<span>刷新</span>');

  const body = el('div');
  const wrap = flatSection('定时任务', count, [body], [newBtn, refreshBtn]);
  box.appendChild(wrap);
  box.appendChild(formBlock);
  // 第 150 批: 收口带 —— 一行任务读数 (总数/运行中/上次失败), 死黑收住。
  const footEl = footband([], 'launchd 每分钟自动刷新');
  box.appendChild(footEl);

  /** load() 每次重画任务列表, 收口带读数跟着一起刷 (不重造带子, 只换内容)。 */
  function paintFoot(tasks) {
    footEl.innerHTML = '';
    const running = (tasks || []).filter((t) => t.running).length;
    const failed = (tasks || []).filter((t) => t.state === 'last_failed').length;
    const stats = [
      { k: '任务', v: String((tasks || []).length) },
      { k: '运行中', v: String(running) },
    ];
    if (failed) stats.push({ k: '上次失败', v: String(failed) });
    for (const s of stats) {
      const cell = el('span', { class: 'pg-footband-stat' });
      cell.appendChild(el('b', {}, s.k));
      cell.appendChild(el('span', {}, s.v));
      footEl.appendChild(cell);
    }
    footEl.appendChild(el('span', { class: 'pg-footband-end' }, 'launchd 每分钟自动刷新'));
  }

  function showForm(on) {
    formBlock.hidden = !on;
    errLine.hidden = true;
  }
  newBtn.addEventListener('click', () => showForm(formBlock.hidden));
  cancelBtn.addEventListener('click', () => showForm(false));

  async function load() {
    try {
      const j = await json('api/teamflow/tasks');
      const tasks = j.tasks || [];
      count.textContent = tasks.length + ' 个';
      body.innerHTML = '';
      paintFoot(tasks);
      if (!tasks.length) {
        body.appendChild(el('div', { class: 'pg-empty' }, '没读到任务'));
        return;
      }
      const rows = [];
      for (const t of tasks) {
        // 第 147 批: 状态用**药丸** (设计系统的 .pg-pill), 不用手画的 ●/✗/✓ 字符 ——
        //   以前三个字符各是一种颜色, 跟别处的状态药丸完全不是一套。
        const stateText = t.running ? '运行中'
          : t.state === 'last_failed' ? '上次失败'
            : (t.last_exit !== null && t.last_exit !== undefined ? '已跑过' : '未跑过');
        const pill = el('span', {
          class: 'pg-pill ' + (t.running ? 'pg-pill-ok'
            : t.state === 'last_failed' ? 'pg-pill-off' : 'pg-pill-idle'),
        }, stateText);
        const st = t.running ? ('pid ' + t.pid)
          : t.state === 'last_failed' ? ('上次 exit ' + t.last_exit)
            : (t.last_exit !== null && t.last_exit !== undefined ? ('exit ' + t.last_exit) : '未跑过');
        const main = el('div', { class: 'pg-list-main' });
        main.appendChild(el('div', { class: 'pg-list-title', title: t.label }, t.name || t.label));
        main.appendChild(el('div', { class: 'pg-list-desc' }, (t.schedule || '') + ' · ' + st));
        const row = listRow({ extra: main, actions: [pill] });
        rows.push(row);
        // 第 143 批: 日志路径 (/tmp/local.pangu-*.log) 原来直接印在列表里 ——
        //   那是运维细节, 对用户没意义。改成只在 hover 时给 (排障照样拿得到)。
        const log = el('span', {
          class: 'pg-list-desc pg-team-log',
          title: t.log || '',
        }, t.log ? t.log.replace(/\/[^\s]*\/([^\/]+)$/, '$1') : '');
        log.style.overflow = 'hidden';
        log.style.textOverflow = 'ellipsis';
        log.style.whiteSpace = 'nowrap';
        row.querySelector('.pg-list-actions').appendChild(log);
        if (String(t.label || '').includes('pangu')) {
          // 列表里一排「带边框的红方块」太吵 —— 删改成无边框的图标按钮,
          // 平时是灰的, 悬停才变朱砂。
          const del = elHTML('button', {
            class: 'pg-act-del', type: 'button', title: '删除这个定时任务', 'aria-label': '删除定时任务',
          }, iconHTML('trash', 14));
          del.addEventListener('click', async () => {
            if (!confirm('确认删除定时任务 ' + t.label + ' ?')) return;
            del.disabled = true;
            try {
              await send('api/teamflow/tasks/' + encodeURIComponent(t.label), undefined, 'DELETE');
              load();
            } catch (e) {
              alert('删除失败: ' + (e.message || e));
              del.disabled = false;
            }
          });
          row.querySelector('.pg-list-actions').appendChild(del);
        }
      }
      body.appendChild(list(rows));
    } catch (e) {
      count.textContent = '读不到';
      paintFoot([]);
      body.innerHTML = '';
      body.appendChild(el('div', { class: 'errbox' }, '加载失败: ' + esc(e.message || e)));
    }
  }

  // HOME 留空就不写进 plist (写死本机路径在开源版里是脏的)
  function envOf() {
    const env = {};
    const home = fHome.i.value.trim();
    const path = fPath.i.value.trim();
    if (home) env.HOME = home;
    if (path) env.PATH = path;
    return env;
  }

  submitBtn.addEventListener('click', async () => {
    errLine.hidden = true;
    const label = fLabel.i.value.trim();
    const program = fProgram.i.value.trim();
    const sched = fSched.i.value.trim();
    if (!/^(local|com)\.[a-z0-9.-]*pangu[a-z0-9.-]*$/i.test(label)) {
      errLine.textContent = 'Label 必须是 local./com. 开头且包含 pangu';
      errLine.hidden = false;
      return;
    }
    if (!program) {
      errLine.textContent = 'Program 不能为空';
      errLine.hidden = false;
      return;
    }
    if (!/^\d{1,2}:\d{2}$/.test(sched) && !/^\d+$/.test(sched)) {
      errLine.textContent = 'Schedule 格式应为 HH:MM 或 N (秒)';
      errLine.hidden = false;
      return;
    }
    const isDaily = /^\d{1,2}:\d{2}$/.test(sched);
    submitBtn.disabled = true;
    try {
      await send('api/teamflow/tasks', {
        label,
        program,
        args: fArgs.i.value.split(/\s+/).filter(Boolean),
        schedule_type: isDaily ? 'daily' : 'interval',
        schedule_value: sched,
        env: envOf(),
      });
      showForm(false);
      fProgram.i.value = ''; fArgs.i.value = '';
      load();
    } catch (e) {
      errLine.textContent = '创建失败: ' + (e.message || e);
      errLine.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  });

  refreshBtn.addEventListener('click', load);
  await load();
  const timer = setInterval(load, 60000);
  return { destroy() { clearInterval(timer); } };
}

export default render;
