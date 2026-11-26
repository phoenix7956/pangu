// settings/agent.mjs —— 设置 · 将灵 (8 个 sub-agent)
//
// 从原版 `apps/desktop/src/views/settings/AgentList.jsx` (git 110661d^) 搬过来。
// 原版 2026-09-14 老板拍: 详情页的配置**内联到列表** —— 点卡片就地展开调, 不跳页。
// 老路由 `#/settings/agent/<code>` 仍然能进 (单独一个将灵的详情视图)。
// 第 141 批起路由是 `/settings?tab=agent&code=<code>` —— 路径必须单段,
//   否则相对资源路径会被解析到子目录里去 (样式全丢)。老的多段地址服务端 301 过来。

import { el, elHTML, page, toast, guaSeal, flatSection } from '../../lib/util.mjs';
import { iconHTML } from '../../lib/icons.mjs';
import { api } from '../../lib/api.mjs';
import { GUA_ROSTER, GENERAL_TOOLS } from '../../lib/gua-roster.mjs';
import { SUB_AGENT_DEFAULTS } from '../../lib/sub-agent-defaults.mjs';
import {
  slider, toggle, actionBar, relativizePaths,
} from '../../components/settings-widgets.mjs';
import { routeParams } from '../../lib/route.mjs';

const EFFORT_LABELS = { auto: '自动', low: '低', medium: '中', high: '高' };

export async function render(root) {
  const host = page();
  host.classList.add('pg-settings-col');
  root.appendChild(host);

  const only = routeParams().get('code');

  let cfg = null;
  let orig = null;
  let saving = false;
  let expandedId = only || null;
  let runs = null;
  let roleTools = null;
  let bar = null;

  const byCode = () => (runs && runs.by_code) || {};
  const roleCfgOf = (code) => ((cfg && cfg.role_configs) || {})[code] || {};

  const update = (code, k, v) => {
    cfg = Object.assign({}, cfg, {
      role_configs: Object.assign({}, (cfg && cfg.role_configs) || {}, {
        [code]: Object.assign({}, roleCfgOf(code), { [k]: v }),
      }),
    });
    paint();
  };

  const dirty = () => JSON.stringify(cfg) !== JSON.stringify(orig);

  function effortRow(code, eff) {
    const wrap = el('div', { class: 'pg-field' });
    const top = el('div', { class: 'pg-slider-top' });
    top.appendChild(el('span', { class: 'pg-toggle-label' }, '推理强度'));
    top.appendChild(el('span', { class: 'pg-slider-val' }, EFFORT_LABELS[eff] || eff));
    wrap.appendChild(top);
    const row = el('div', { class: 'pg-effort-row' });
    for (const o of ['auto', 'low', 'medium', 'high']) {
      const b = el('button', { class: 'pg-effort-btn' + (eff === o ? ' on' : ''), type: 'button' },
        EFFORT_LABELS[o]);
      b.addEventListener('click', () => update(code, 'reasoning_effort', o));
      row.appendChild(b);
    }
    wrap.appendChild(row);
    return wrap;
  }

  function paint() {
    host.innerHTML = '';

    // 第 147 批: 标题 + 右侧动作 = 设计系统的 `.pg-toolbar`
    //   (工具集/六十四卦用的同一根条)。以前这里是设置页自造的
    //   `.pg-settings-head` —— 一个只在设置页存在的标题条 ⇒ 换个页面就变个样。
    const head = el('div', { class: 'pg-toolbar' });
    const hLeft = el('div', { class: 'pg-list-main' });
    // 第 138 批: emoji (⚔️) 换矢量图标; "sub-agent" 也说人话。
    const hTitle = el('div', { class: 'pg-list-title pg-ico-line' });
    hTitle.appendChild(elHTML('span', {}, iconHTML('bot', 15)));
    hTitle.appendChild(el('span', {}, '8 个将灵 (sub-agent)'));
    hLeft.appendChild(hTitle);
    hLeft.appendChild(el('div', { class: 'pg-list-desc' },
      '点卡片就地展开配置 · 通用工具 (' + GENERAL_TOOLS.length + ') 主对话自动加载'));
    head.appendChild(hLeft);
    head.appendChild(el('div', { class: 'pg-toolbar-spacer' }));
    const bReset = el('button', { class: 'pg-btn pg-btn-ghost pg-ico-line', type: 'button' });
    bReset.appendChild(elHTML('span', {}, iconHTML('rotate', 14)));
    bReset.appendChild(el('span', {}, '一键恢复预设'));
    bReset.addEventListener('click', async () => {
      if (!cfg) return;
      if (!window.confirm('一键把 8 将灵配置恢复到推荐预设?\n\n'
        + '乾·调度 0 步 · 坎·拆 5 步 · 离·读 60 步\n'
        + '坤·做 80 步 · 兑·验 30 步 · 巽·找雷 70 步\n'
        + '震·复盘 25 步 · 艮·记 20 步\n\n(会覆盖你当前改动)')) return;
      const r = await api.patchConfig({ agent: { role_configs: SUB_AGENT_DEFAULTS } });
      if (r && r.ok) { toast('已恢复推荐预设'); await load(); }
      else toast('✗ 失败: ' + ((r && r.error) || ''), true);
    });
    head.appendChild(bReset);
    host.appendChild(head);

    // 第 147 批: 将灵清单 = 设计系统的 `.pg-list` / `.pg-list-row`
    //   (工具集/角色/历史档案共用同一种行)。以前每一行都是一张独立卡片,
    //   八张卡浮在一片空白里 —— 看着像拼的, 也把一张卡的内容撑成了三段。
    const list = el('div', { class: 'pg-list' });
    for (const role of GUA_ROSTER) {
      const roleCfg = roleCfgOf(role.code);
      const live = byCode()[role.code] || {};
      const running = !!live.running;
      const expanded = expandedId === role.code;
      const eff = ['low', 'medium', 'high'].includes(roleCfg.reasoning_effort) ? roleCfg.reasoning_effort : 'auto';

      const row = el('div', { class: 'pg-list-row pg-role-row' + (running ? ' is-live' : '') });
      // 第 161 批: 原来这里是 17px 宋体的 Unicode 卦符 (☰) —— 字体符号,
      // 各系统字形不同、放大发虚、不能跟主题走。换成**卦印** (真爻柱 + 卦名),
      // 跟将灵表、首屏活爻柱是同一套语言。
      // 卦印和职责**在同一个格子里** (爻柱 乾 · 调度) —— 分成两列的话,
      // 中间隔着整行的 gap, 「乾」和「调度」读不成一个词。
      const cell = el('span', { class: 'pg-agent-cell' });
      cell.appendChild(guaSeal(role.gua, running));
      cell.appendChild(el('span', { class: 'pg-agent-cell-t' }, role.role || ''));
      row.appendChild(cell);
      const mid = el('div', { class: 'pg-role-mid' });
      // 徽章 (qian / ● 运行中) 跟**卦名·职责同一行** ——
      // 原来它们在另一个 div 里, 而那 div 只有徽章, 于是徽章贴在最左边,
      // 「乾 · 调度」反而掉到下一行, 一眼像两组不相干的东西。
      cell.appendChild(el('span', { class: 'pg-badge' }, role.code));
      cell.appendChild(el('span', { class: 'pg-badge' + (running ? ' pg-badge-green' : '') },
        running ? '● 运行中' : (live.last_kind === 'done' ? '○ 最近完成' : '○ 待命')));

      const rt = roleTools && roleTools[role.code];
      const toolList = rt && Array.isArray(rt.tools) ? rt.tools : role.tools;
      mid.appendChild(el('div', { class: 'pg-list-desc' },
        // 第 143 批: 原来把 20 个工具名**全列出来** (read_file · file_grep · …),
        //   一张卡底下拖着一长串英文, 界面立刻变成日志。改成只报数量,
        //   清单挪到卡片展开区里。
        role.desc + ' · 可用工具 '
        + (toolList.length ? toolList.length + ' 个' : '无')));
      const liveLine = el('div', { class: 'pg-role-live' });
      // 「今日 N 次」是计数 —— 不许被右边那段长任务描述挤成两行
      //   (中文可以在任意两字之间断行, 一收缩就变成「今日 0」/「次」两行,
      //    清单行凭空高出来一行, 整页看着就毛躁)。所以它是 flex: none。
      liveLine.appendChild(el('span', { class: 'pg-list-desc pg-role-count' + (live.runs_today ? ' pg-strong' : '') },
        '今日 ' + (live.runs_today || 0) + ' 次'));
      if (live.recent_tasks && live.recent_tasks.length) {
        // 最近这次的任务描述里常带绝对路径 (runtime 的原话), 不截断的话
        // 一行能铺三百个字符 —— 清单行被撑成两行三行, 页面立刻变成日志。
        //   路径也顺手改成相对路径: 盘古要开源, 界面里印某台机器的家目录
        //   既难看, 换台机器也对不上号。
        const taskText = relativizePaths(live.recent_tasks[0].task);
        const taskSpan = el('span', { class: 'pg-list-desc pg-role-task' }, '最近: ' + taskText);
        taskSpan.title = taskText;      // 整段太长时, 悬停能看到全文
        liveLine.appendChild(taskSpan);
      }
      mid.appendChild(liveLine);
      row.appendChild(mid);

      const right = el('div', { class: 'pg-list-actions pg-role-right' });
      right.appendChild(el('div', {},
        (roleCfg.max_tool_iterations == null ? 30 : roleCfg.max_tool_iterations)
        + ' 步 · 强度 ' + (EFFORT_LABELS[eff] || eff)));
      if (live.last_ts) {
        right.appendChild(el('div', { class: 'pg-list-desc' },
          new Date(live.last_ts).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })));
      }
      row.appendChild(right);
      row.appendChild(el('div', { class: 'pg-role-caret' }, expanded ? '▾' : '▸'));
      row.addEventListener('click', () => {
        expandedId = expanded ? null : role.code;
        paint();
      });
      list.appendChild(row);
      if (expanded) {
        const inline = el('div', { class: 'pg-role-panel' });
        if (toolList.length) {
          inline.appendChild(el('div', { class: 'pg-hint' },
            '工具清单: ' + toolList.join(' · ')));
        }
        if (role.code === 'qian') {
          inline.appendChild(el('div', { class: 'pg-hint' },
            '乾 · 调度跟盘古主模型走 · 不单独配工具/模型/推理强度，只负责汇总其余七位的结果。'));
        } else {
          inline.appendChild(slider(
            roleCfg.max_tool_iterations == null ? 30 : roleCfg.max_tool_iterations,
            (v) => update(role.code, 'max_tool_iterations', v),
            1, 100, 1, '最大工具调用', ' 步', '单次任务最多调几次工具'));
          inline.appendChild(el('div', { class: 'pg-hint' },
            '模型 = 跟盘古主模型 · 主模型一换, 这个将灵立刻跟着换 (2026-10-17 起不再能单独指定)'));
          inline.appendChild(effortRow(role.code, eff));
          inline.appendChild(toggle(
            roleCfg.parallel_tools == null ? true : !!roleCfg.parallel_tools,
            (v) => update(role.code, 'parallel_tools', v), '并行调工具', '一次发多个工具调用'));
          inline.appendChild(toggle(
            !!roleCfg.auto_approve,
            (v) => update(role.code, 'auto_approve', v), '自动批准',
            '按「替我审批」档执行: 常规免确认, 危险操作仍弹审批; 不超越全局级别'));
          inline.appendChild(toggle(
            roleCfg.sandbox_strict !== false,
            (v) => update(role.code, 'sandbox_strict', v), '严格沙箱', '限制 Agent 写盘/网络范围'));
          inline.appendChild(toggle(
            roleCfg.memory_enabled !== false,
            (v) => update(role.code, 'memory_enabled', v), '记忆', '跨会话记忆用户偏好'));
        }
        list.appendChild(inline);
      }
    }
    host.appendChild(list);

    const gb = el('div', { class: 'pg-tiny' });
    // 第 138 批: 原来这里是 emoji (🛠) —— 换成矢量图标。
    const gt = el('b', { class: 'pg-ico-line' });
    gt.appendChild(elHTML('span', {}, iconHTML('wrench', 13)));
    gt.appendChild(el('span', {}, '通用工具 (盘古 = 8 将灵, 你直接面对乾 · 调度, 它不握工具)'));
    gb.appendChild(gt);
    gb.appendChild(document.createTextNode(': ' + GENERAL_TOOLS.join(' · ')));
    gb.classList.add('pg-hint');
    host.appendChild(flatSection('通用工具', null, gb));

    if (bar) bar.remove();
    bar = actionBar(async () => {
      saving = true;
      const r = await api.patchConfig({ agent: { role_configs: cfg.role_configs } });
      saving = false;
      if (r && r.ok) {
        toast('已保存');
        orig = JSON.parse(JSON.stringify(cfg));
        paint();
      } else {
        toast('✗ 失败: ' + ((r && r.error) || ''), true);
      }
    }, saving, dirty());
  }

  async function load() {
    const [d, rn, rt] = await Promise.all([api.config(), api.subagentRuns(), api.subagentRoles()]);
    if (d && d.ok && d.data && d.data.agent) {
      cfg = d.data.agent;
      orig = JSON.parse(JSON.stringify(d.data.agent));
    } else {
      cfg = { role_configs: {} };
      orig = { role_configs: {} };
    }
    if (rn && rn.ok) runs = rn;
    if (rt && rt.ok && rt.by_code) roleTools = rt.by_code;
    paint();
  }

  paint();
  await load();
  return {};
}

export default render;
