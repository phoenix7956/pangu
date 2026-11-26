// bazi.mjs —— 盘古工作台 · 八字排盘视图
//
// 2026-10-27 (第 119 批) 老板: 「http://127.0.0.1:18901/bazi/ 这个链接还不对,
// 其他的都是 /app/#/」⇒ 八字排盘从**独立静态页** (web/bazi/) 搬进工作台,
// 变成真路由 `#/bazi` —— 跟其它页面同一个 URL 形态。
//
// 数据来源: api.toolTest('bazi_calc', params) ⇒ 确定性引擎 (sxtwl 万年历) 排盘。
// AI 来源:   api.chat(...) —— **一项一次请求** (见 lib/bazi/reading.mjs 的分项规格)。
//            每项自带小预算 + reasoning_effort, 所以不会再出现「思考把预算吃光 ⇒ 正文空」。
//
// 搬过来时改了四处 (其余照搬原版逻辑):
//   1. `$` 改成在 host 内查 —— 工作台是单页, id 是全局的, 不许撞。
//   2. 裸 fetch 换成 api.* —— 端点清单不许自己发挥。
//   3. 顶栏 / 主题开关 / 页脚搬走 —— 工作台外壳已经有了, 不重复一套。
//   4. **不许 `root.innerHTML = ...`** —— 工作台在 render() 之前已经把页标题
//      (H1 + 副标题) 挂进 root 了, 一句 innerHTML 就把它冲掉 (其它视图全是
//      `root.appendChild(host)`)。第 119 批就是这么丢的标题。

import { api } from '../lib/api.mjs';
import { esc, page, sectionHtml, cardHtml } from '../lib/util.mjs';
import { PROVINCES, DISTRICTS, MUNICIPALITIES } from '../lib/bazi/regions.mjs';
import {
  SECTIONS, SPEC, EFFORT, budgetOf,
  buildSectionPrompt, buildNoteTargets, buildNotePrompt,
} from '../lib/bazi/reading.mjs';
import {
  WX_ORDER, GAN_WX, ZHI_WX, wxClass, wxIconHtml, pillarTableHtml,
  wuxingRole, roleClass, yuanZi,
} from '../lib/bazi/pillars.mjs';
import { currentStamp } from '../lib/buildcheck.mjs';

// ── 页面骨架 ────────────────────────────────────────────────────
// 顺序是老板定的: 出生信息 → 排盘结果 → **AI 解读放最下面**。
const SKELETON = `
  ${cardHtml('出生信息', `
    <div>
      <div class="pg-seg bz-tabs" id="bz-cal-tabs">
        <button class="pg-seg-i on" data-cal="solar" type="button">阳历</button>
        <button class="pg-seg-i" data-cal="lunar" type="button">农历</button>
      </div>
      <!-- 2026-10-28 (第 135 批 · 视觉): 表单拆两段 (出生时刻 / 出生地点),
           标签上置, 六个时间框 + 三个地点框各自等宽。
           **只改结构和 class** —— id 一个没动, JS 还是按 id 找, 数据流一个字没动。 -->
      <!-- 第 144 批: 表单卡原来只有 760px 宽, 但下面的排盘结果卡占满 1160px ——
           上下两条边对不齐, 右边还空着一大片, 一眼就是"没排完"。
           现在把**输入**也铺满整条轨, 并拆成两栏:
           左栏「出生时刻」六个框, 右栏「出生地点」三个下拉 + 两个勾选。
           「排盘」按钮跟着右栏最下面 —— 离最后一个字段只有一行, 不再隔半屏。
           id 一个没动, 数据流一个字没动。 -->
      <div class="bz-form-cols">
        <div class="bz-section">
          <div class="bz-section-h"><span class="bz-section-t">出生时刻</span></div>
          <div class="bz-grid-time">
            <label class="bz-f"><span>年</span><input class="pg-input" id="bz-f-year" type="number" placeholder="如 1990" min="1900" max="2100"></label>
            <label class="bz-f"><span>月</span><input class="pg-input" id="bz-f-month" type="number" placeholder="1-12" min="1" max="12"></label>
            <label class="bz-f"><span>日</span><input class="pg-input" id="bz-f-day" type="number" placeholder="1-31" min="1" max="31"></label>
            <label class="bz-f"><span>时</span><input class="pg-input" id="bz-f-hour" type="number" placeholder="0-23" min="0" max="23"></label>
            <label class="bz-f"><span>分</span><input class="pg-input" id="bz-f-minute" type="number" placeholder="0-59" min="0" max="59"></label>
          </div>
          <div class="bz-grid-sex">
            <label class="bz-f"><span>性别</span>
              <span class="pg-seg bz-seg" id="bz-f-gender">
                <button class="pg-seg-i on" data-g="male" type="button">男</button>
                <button class="pg-seg-i" data-g="female" type="button">女</button>
              </span>
            </label>
          </div>
        </div>
        <div class="bz-section">
          <div class="bz-section-h"><span class="bz-section-t">出生地点</span></div>
          <div class="bz-grid-place">
            <label class="bz-f"><span>省</span><span class="bz-sel"><select class="pg-input" id="bz-f-province"></select></span></label>
            <label class="bz-f"><span>市</span><span class="bz-sel"><select class="pg-input" id="bz-f-city" disabled></select></span></label>
            <label class="bz-f"><span>区/县</span><span class="bz-sel"><select class="pg-input" id="bz-f-district" disabled></select></span></label>
            <div class="bz-opts">
              <!-- 第 150 批: 裸系统复选框换成全站唯一的 .pg-switch ——
                   开关是设了按钮, 勾选是设文本, 读法不一样。
                   原来的 class 挂在 label 上 (bz-chk 行内 flex), 现在
                   跟 id 一起挪到开关上; 文案挪到 pg-toggle-label。 -->
              <!-- 第 160 批 · 重写: 文案**从开关里搬出来**。
                   .pg-switch 是 40×24 的旋钮, 把「真太阳时」四个字塞进去
                   ⇒ 旋钮压着字, 画面上是一团糊掉的绿 (原图 x=925 那坨)。
                   现在按钮里只留旋钮, 文案是它**旁边**的字 (同一行, 同一基线) ——
                   开关还是开关, 字还是字, 读法不串。 -->
              <span class="bz-opt">
                <button class="bz-chk pg-switch on" id="bz-f-solar-time" type="button" role="switch" aria-checked="true" aria-label="真太阳时"><span class="pg-switch-knob"></span></button>
                <span class="bz-chk-label">真太阳时</span>
              </span>
              <span class="bz-opt">
                <button class="bz-chk pg-switch" id="bz-f-leap-month" type="button" role="switch" aria-checked="false" aria-label="闰月"><span class="pg-switch-knob"></span></button>
                <span class="bz-chk-label">闰月</span>
              </span>
              <span class="bz-opts-hint">真太阳时按出生地经度校正时柱</span>
            </div>
            <!-- 第 144 批: 「排盘」按钮原来在整张卡最右下角, 离最后一个字段
                 (区县下拉) 隔了半屏 —— 一眼过去像另一个区域的东西。
                 现在跟着右栏走, 右边缘跟「区/县」下拉对齐, 离它只有两行。 -->
            <div class="bz-go-row">
              <button class="pg-btn pg-btn-primary bz-btn-go" id="bz-btn-chart" type="button">排盘</button>
            </div>
          </div>
        </div>
      </div>
      <p class="bz-err" id="bz-form-err" hidden></p>
    </div>`, { cls: 'bz-form-card' })}

  <section id="bz-chart-area" hidden>
    <!-- 2026-11-04 (UI 重写 · 样稿终版): 排盘摘要 = 英雄卡。
         左: 大日主字 (五行色) + 日主·元男/元女;
         中: 标题 + 两行 meta (公历/农历/星期/生肖 · 出生地/真太阳时/月令);
         右: 竖排徽章 身强弱·喜用 / 忌神。
         旧的 bz-chart-summary / bz-chart-strength / bz-solar-hint 三段撤下,
         强弱推导并入「五行与喜忌」卡 (老板: 「日主强弱和五行喜忌重复了」)。 -->
    ${sectionHtml('排盘摘要', '<div id="bz-hero-box"></div>')}

    ${sectionHtml('四柱', `
        <table class="pg-table bz-pillars" id="bz-t-pillars"></table>`,
        { bodyClass: 'bz-table-wrap' })}

    <div class="bz-two">
      ${sectionHtml('五行与喜忌', '<div id="bz-wuxing-box"></div>')}
      ${sectionHtml('命盘精要', '<div id="bz-jingyao-box"></div>')}
    </div>

    ${sectionHtml('神煞与地支关系', `
        <div class="pg-tags bz-tags" id="bz-shensha-box"></div>
        <div class="bz-rels" id="bz-rel-box"></div>`)}

    ${sectionHtml('墓库与开库', `
        <div class="bz-kv" id="bz-muku-box"></div>
        <p class="bz-note" id="bz-muku-note" style="margin-top:8px"></p>
        <div class="bz-kv" id="bz-feixing-box" style="margin-top:12px"></div>
        <p class="bz-note" id="bz-feixing-note" style="margin-top:6px"></p>`)}

    ${sectionHtml('大运', `
        <table class="pg-table bz-strip" id="bz-t-dayun"></table>`, {
      id: 'bz-dayun-card',
      bodyClass: 'bz-table-wrap',
      hintHtml: '<span class="pg-section-hint" id="bz-dayun-hint"></span>',
    })}

    ${sectionHtml('流年', `
        <table class="pg-table bz-strip" id="bz-t-liunian"></table>`, {
      id: 'bz-liunian-card',
      bodyClass: 'bz-table-wrap',
      hintHtml: '<span class="pg-section-hint" id="bz-liunian-hint"></span>',
    })}

    ${sectionHtml('流月', `
        <table class="pg-table bz-strip" id="bz-t-liuyue"></table>`, {
      id: 'bz-liuyue-card',
      bodyClass: 'bz-table-wrap',
      hintHtml: '<span class="pg-section-hint" id="bz-liuyue-hint"></span>',
    })}
  </section>

  <!-- ③ AI 解读 —— 放在最下面 -->
  <section id="bz-ai-area" hidden>
    ${cardHtml('AI 解读', `
        <p class="bz-note">解读按项分次生成，每一项单独请求、单独重试：一项失败不影响其余项。</p>
        <div class="pg-seg bz-tabs" id="bz-ai-tabs">
          <button class="pg-seg-i on" data-aitab="sections" type="button">分段解读</button>
          <button class="pg-seg-i" data-aitab="notes" type="button">逐项批语</button>
        </div>
        <div class="bz-ai-toolbar">
          <button class="pg-btn pg-btn-primary" id="bz-btn-ai-start" type="button">开始解读</button>
          <button class="pg-btn" id="bz-btn-ai-stop" type="button" hidden>停止</button>
          <span class="hint" id="bz-ai-progress"></span>
        </div>
        <div id="bz-ai-sections" class="bz-ai-list"></div>
        <div id="bz-ai-notes" class="bz-ai-list" hidden></div>`, {
      cls: 'bz-ai-card',
      hintHtml: '<span class="hint" id="bz-ai-state">未开始</span>',
    })}
  </section>

  <p class="bz-foot">排盘由确定性历法引擎计算，AI 解读仅供参考，不替代专业判断。</p>
`;

// ── 视图入口 ────────────────────────────────────────────────────
export async function render(root) {
  // 跟其它视图一个写法: 造一个宿主节点 **挂进去**, 不许清空 root
  // (root 里已经有工作台加的页标题了, 清空就没了)。
  // 第 147 批: 页面根统一走设计系统的 page() (.pg-page) ——
  // 全站每一页的根都是它, 换页不跳宽、不跳内缩。
  // .bz-root 只留**这一页专属**的变量与版式 (五行色别名、命盘表格布局)。
  const host = page();
  host.classList.add('bz-root');
  host.innerHTML = SKELETON;
  root.appendChild(host);

  const $ = (id) => host.querySelector('#' + id);

  const state = {
    calendar: 'solar',
    gender: 'male',
    chart: null,
    input: null,           // **完整** input (带 province/district/birthplace)
    strengthConclusion: '',
    selDayun: null,   // 选中的大运序号 (null = 排完盘后按「今年」自动落位)
    selYear: 0,       // 选中的流年序号
    running: false,
    stopped: false,
    sessionId: 'bazi-' + Math.random().toString(36).slice(2, 10),
  };

  // ── 出生信息表单 ─────────────────────────────────────────────
  function initForm() {
    const prov = $('bz-f-province');
    // **起始是空的** (老板 2026-10-27: 「这部分在点进排盘页面的时候是不是应该是空的才对」)
    // 原来这里写死了 1979/5/6/6/56 + 河南/郑州 —— 那是**某一个人的生辰**,
    // 通用工具 (尤其开源导出) 不该替别人填。
    prov.innerHTML = '<option value="">请选择省份</option>' + Object.keys(PROVINCES)
      .map((p) => '<option value="' + esc(p) + '">' + esc(p) + '</option>').join('');
    prov.value = '';
    syncCity('');
    prov.addEventListener('change', () => syncCity(''));
    // 换城市 ⇒ 区县跟着换 (老板 2026-10-27: 「选，不要填」—— 区县是下拉, 不是手打)
    $('bz-f-city').addEventListener('change', (e) => syncDistrict(e.target.value));

    $('bz-cal-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-cal]');
      if (!b) return;
      state.calendar = b.dataset.cal;
      [...$('bz-cal-tabs').children].forEach((x) => x.classList.toggle('on', x === b));
      // 第 150 批: 闰月现在是 .pg-switch (按钮) —— disabled 还在, checked 没了。
      const leap = $('bz-f-leap-month');
      leap.disabled = state.calendar !== 'lunar';
      if (state.calendar !== 'lunar') setSwitch(leap, false);
    });

    // 两个开关的点击接线 (第 150 批) —— 点整行都算点开关。
    for (const id of ['bz-f-solar-time', 'bz-f-leap-month']) {
      const sw = $(id);
      sw.addEventListener('click', () => {
        if (sw.disabled) return;
        setSwitch(sw, !sw.classList.contains('on'));
      });
    }

    function setSwitch(sw, on) {
      sw.classList.toggle('on', on);
      sw.setAttribute('aria-checked', on ? 'true' : 'false');
    }

    $('bz-f-gender').addEventListener('click', (e) => {
      const b = e.target.closest('[data-g]');
      if (!b) return;
      state.gender = b.dataset.g;
      [...$('bz-f-gender').children].forEach((x) => x.classList.toggle('on', x === b));
    });

    $('bz-btn-chart').addEventListener('click', doChart);
  }

  function syncCity(pick) {
    const city = $('bz-f-city');
    const prov = $('bz-f-province').value;
    // 直辖市(京沪津渝)的第二层本来就是**区县**, 不是市。
    // 所以这一层的下拉对直辖市只列它自己 —— 区县在下一层下拉里选。
    // 这样真太阳时拿 city='北京' 能命中 CITY_LONG(116.4),
    // 填成 '东城' 查不到经度就会退到东经 120 度。
    const list = !prov ? [] : (MUNICIPALITIES.includes(prov) ? [prov] : (PROVINCES[prov] || []));
    city.innerHTML = '<option value="">' + (list.length ? '请选择城市' : '—') + '</option>'
      + list.map((c) => '<option value="' + esc(c) + '">' + esc(c) + '</option>').join('');
    city.value = list.includes(pick) ? pick : '';
    city.disabled = !list.length;

    // 换省份 ⇒ 市/区县都得重选(上一个省的区县对不上新省份)
    syncDistrict(city.value);
  }

  // 第三层: 区/县下拉 —— 数据源全国行政区划(省→市→区县三棵树)。
  // 直筒子市(东莞/中山/儋州…)本来就没有区县, 数据里给它自己一个选项。
  function syncDistrict(cityName, pick) {
    const dist = $('bz-f-district');
    const prov = $('bz-f-province').value;
    const list = (prov && cityName && DISTRICTS[prov] && DISTRICTS[prov][cityName]) || [];
    dist.innerHTML = '<option value="">' + (list.length ? '请选择区/县' : '—') + '</option>'
      + list.map((d) => '<option value="' + esc(d) + '">' + esc(d) + '</option>').join('');
    dist.value = list.includes(pick) ? pick : '';
    dist.disabled = !list.length;
  }

  async function doChart() {
    const err = $('bz-form-err');
    err.hidden = true;
    const btn = $('bz-btn-chart');
    // 表单是空的 ⇒ 校验要说人话, 不许弹 " 不是合法取值"
    const num = (id, min, max, label) => {
      const raw = String($(id).value || '').trim();
      if (!raw) throw new Error('请填写出生' + label);
      const v = Number(raw);
      if (!Number.isFinite(v) || v < min || v > max) {
        throw new Error('出生' + label + '填得不对 (要 ' + min + '-' + max + ')');
      }
      return Math.floor(v);
    };
    let params;
    try {
      params = {
        year: num('bz-f-year', 1900, 2100, '年'),
        month: num('bz-f-month', 1, 12, '月'),
        day: num('bz-f-day', 1, 31, '日'),
        hour: num('bz-f-hour', 0, 23, '时'),
        minute: num('bz-f-minute', 0, 59, '分'),
        gender: state.gender,
        province: $('bz-f-province').value.trim(),
        city: $('bz-f-city').value.trim(),
        district: $('bz-f-district').value.trim(),
        use_solar_time: $('bz-f-solar-time').classList.contains('on'),
        is_lunar: state.calendar === 'lunar',
        is_leap_month: state.calendar === 'lunar' && $('bz-f-leap-month').classList.contains('on'),
        // 原版 UI 有「流月」这一段(选中流年 → 那年 12 个月), 所以排盘时把流月明细带回来。
        // AI 解读那一侧不受影响 —— reading.mjs 只取流年那几项字段。
        liunian_months: true,
      };
    } catch (e) {
      err.textContent = '出生信息有误: ' + e.message;
      err.hidden = false;
      return;
    }
    // 出生地必填 —— 真太阳时按经度校正, 没地点算不准
    if (!params.province || !params.city) {
      err.textContent = '出生信息有误: 请选择出生地（省 + 市）';
      err.hidden = false;
      return;
    }
    // 区县也必填 (老板 2026-10-27: 「还有区县不是选填」)
    if (!params.district) {
      err.textContent = '出生信息有误: 请选择区/县';
      err.hidden = false;
      return;
    }
    btn.disabled = true;
    btn.textContent = '排盘中…';
    try {
      const j = await api.toolTest('bazi_calc', params);
      const outer = j && j.result && j.result.data;
      const data = outer && (outer.pillars || outer);
      if (!j || !j.ok || !data || !data.pillars) {
        throw new Error((j && j.result && j.result.error && j.result.error.message) || '排盘工具未返回完整数据');
      }
      state.chart = data;
      // chart 里的 input 是后端裁过的精简版(没有 province/district/birthplace),
      // 完整的在外层 —— 出生地那一行要用它, 不然只显示得出「郑州」。
      state.input = (outer && outer.input) || data.input || null;
      state.strengthConclusion = outer.strengthConclusion || '';
      state.selDayun = null;
      state.selYear = 0;
      renderChart(data);
      $('bz-ai-area').hidden = false;
      resetAI();
    } catch (e) {
      err.textContent = '排盘失败: ' + (e.message || e);
      err.hidden = false;
    } finally {
      btn.disabled = false;
      btn.textContent = '排盘';
    }
  }

  // ── 排盘渲染 ─────────────────────────────────────────────────
  function renderChart(c) {
    $('bz-chart-area').hidden = false;
    renderHero(c);
    renderPillars(c);
    renderWuxing(c);
    renderJingyao(c);
    renderShensha(c);
    renderRels(c);
    renderMuku(c);
    renderFeixing(c);
    renderDayun(c);
    renderLiunian(c);
    renderLiuyue(c);
  }

  /**
   * 排盘摘要英雄卡 —— 样稿 2.0 终版 (老板批准的样稿原样, 不许再发挥)。
   *   左: 大日主字 (五行色) + 「日主 · 元男/元女」;
   *   中: 「丁火日主 · 女命 · 射手座」+ 两行 meta;
   *   右: 竖排徽章「身弱·喜木火 / 忌水土金」。
   *   强弱推导不在这里 —— 并入「五行与喜忌」卡 (老板: 「日主强弱和五行喜忌重复了」)。
   *
   * 信息一项不丢 —— 旧 bz-chart-summary / bz-solar-hint 里的字段全部搬进来:
   *   公历、农历(含闰)、星期、生肖、性别、星座、日主、月令、出生地、真太阳时。
   *
   * ⚠ 性别必须三态 (2026-10-31 第 176 批): 'male'→男 / 'female'→女 / 其它→'未知',
   *   不许 `=== 'male' ? '男' : '女'` (把 unknown 当女 ⇒ 静默错盘)。
   *
   * ⚠ 真太阳时**必须一直说出来** (第 176 批铁律): 精确命中时也要显示 ——
   *   它是时柱的依据, 差几分钟就可能跨时辰边界。命中层级与「是不是近似值」
   *   都随盘一起回来 (solar_time_source), 不许藏。
   */
  function renderHero(c) {
    const lunar = c.lunar || {};
    const inp = state.input || c.input || {};
    const gender = inp.gender === 'male' ? '男命' : inp.gender === 'female' ? '女命' : '性别未知';

    // 生肖 = 年支 (跟命盘精要卡同一把尺子)
    const SX = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
    const yz = (c.pillars && c.pillars['年柱'] || '').slice(1);
    const zodiac = SX['子丑寅卯辰巳午未申酉戌亥'.indexOf(yz)] || '-';

    const dmWx = c.day_master_wuxing || GAN_WX[c.day_master] || '';

    const meta1 = [
      esc(c.public_date || ''),
      '农历 ' + esc(String(lunar['年'] || '')) + '年' + esc(String(lunar['月'] || '')) + '月'
        + esc(String(lunar['日'] || '')) + '日' + (lunar['闰月'] ? '(闰)' : ''),
      esc(c.weekday || ''),
      '生肖 ' + esc(zodiac),
    ].filter(Boolean).join(' · ');

    // 真太阳时段: 启用就显示 (含近似警告), 没启用整段不出现
    let solarTxt = '';
    if (inp.use_solar_time) {
      const st = c.solar_time_source || {};
      const why = st['说明'] || (c.solar_time_city_matched === false
        ? ('没查到「' + (inp.city || '') + '」的经度, 已按东经 120° 估算')
        : '');
      const off = st['合计修正(分钟)'];
      solarTxt = '真太阳时: ' + (c.solar_date || '-')
        + (off != null && off !== '' ? ' (钟表时 ' + String(c.public_date || '').split(' ')[1] + ' ± ' + off + ' 分)' : '')
        + (why ? ' · ' + why : '');
    }
    const meta2 = [
      '出生地 ' + esc(inp.birthplace || inp.city || '-'),
      solarTxt ? esc(solarTxt) : '',
      '月令 ' + esc((c.jieqi || {})['月令'] || '-'),
    ].filter(Boolean).join(' · ');

    // 喜忌徽章: 五行字各染各的色 (老板拍板的五行色, 只染字不铺块)
    const wxb = (w) => '<b class="bz-wxb bz-wx-' + w + '">' + esc(w) + '</b>';
    const xi = (c.xi_yong || []).map(wxb).join('');
    const ji = (c.ji_shell || []).map(wxb).join('');
    const badge = '<span class="bz-hz-badge">身' + esc(c.status || '-')
      + ' · 喜' + (xi || '-')
      + (ji ? '<i>忌' + ji + '</i>' : '')
      + '</span>';

    $('bz-hero-box').innerHTML = '<div class="bz-hero">'
      + '<div class="bz-hz-ch"><b class="bz-wxb ' + wxClass(dmWx) + '">' + esc(c.day_master || '-') + '</b>'
      + '<span>日主 · ' + esc(yuanZi(c)) + '</span></div>'
      + '<div class="bz-hz-main">'
      + '<div class="bz-hz-title">' + esc(c.day_master || '-') + esc(dmWx) + '日主 · ' + esc(gender)
      + (c.constellation ? ' · ' + esc(c.constellation) : '') + '</div>'
      + '<div class="bz-hz-meta">' + meta1 + '</div>'
      + '<div class="bz-hz-meta">' + meta2 + '</div>'
      + '</div>'
      + badge
      + '</div>';
  }

  function renderPillars(c) {
    // 四柱表的取字逻辑住在 lib/bazi/pillars.mjs (纯函数, 有单测盯着) ——
    // 天干行只 1 个字、地支行只 1 个字。老代码两行都印整柱「己未」。
    $('bz-t-pillars').innerHTML = pillarTableHtml(c);
  }

  function renderWuxing(c) {
    const count = c.wuxing_count || {};
    const total = WX_ORDER.reduce((s, w) => s + (Number(count[w]) || 0), 0) || 1;
    const bar = WX_ORDER.map((w) => {
      const v = Number(count[w]) || 0;
      const pct = (v / total) * 100;
      // 第 128 批: 五行条**不再铺五行色块** —— 段底是中性轨, 字走五行色
      // (老板: 「不用块直接用颜色的字」「不要用框, 实线虚线都不要」)。
      // 段宽仍是比例, 所以「多寡」照样读得出; 颜色只表示是哪个五行。
      // 喜忌档位**不再用框表示** —— 下面「五行与喜忌」那行有文字标签就够了。
      const role = wuxingRole(w, c);
      // 窄段放不下「木 2.5」⇒ 放不下就只留五行名, 别整段空着看不出是什么。
      const label = pct > 8 ? w + ' ' + v : (pct >= 4 ? w : '');
      // bz-wx-<五行> 要挂上 (--wx-ink 定义在 .bz-wx-* 上), bz-wxb 要挂上
      // (五行身份 = 粗体彩字)。少了任一个 ⇒ 变量取不到 ⇒ 字色回退成默认色。
      return '<span class="bz-g-' + w + ' bz-wxb bz-wx-' + w + ' ' + roleClass(role) + '" style="width:' + pct.toFixed(1) + '%"'
        + ' title="' + w + ' ' + v + '">' + label + '</span>';
    }).join('');
    // 喜用/忌神/财星 chip 走**跟四柱表同一套语言** (五行彩字), 档位不加框。
    const chip = (arr, role) => (arr || []).map((w) => '<span class="bz-chip bz-wxb bz-wx-' + w
      + ' bz-role-' + role + '">' + esc(w) + '</span>').join(' ') || '-';
    $('bz-wuxing-box').innerHTML =
      '<div class="bz-bar">' + bar + '</div>'
      + '<div class="bz-kv">'
      + '<span>喜用 <b>' + chip(c.xi_yong, 'xi') + '</b></span>'
      + '<span>忌神 <b>' + chip(c.ji_shell, 'ji') + '</b></span>'
      + '<span>财星 <b>' + chip(c.cai_xing, 'cai') + '</b></span>'
      + '</div>'
      + '<p class="bz-note" style="margin-top:8px">依据: ' + esc(c.xi_yong_reason || '-') + '</p>'
      // 2026-11-04 (UI 重写): 强弱推导从排盘摘要撤下、并入本卡
      // (老板: 「日主强弱和五行喜忌重复了」)。
      + strengthDeriveHtml(state.strengthConclusion);
  }

  /**
   * 结构化强弱推导 (2026-11-04 UI 重写 · 样稿终版)。
   *   后端 strengthConclusion 的真实格式 (2026-11-04 从 API 实取核对):
   *     【六格判断·已算好, 直接用】\n
   *     日主: 木·乙(阴)\n
   *       克我者(金): 无力 → 七杀/正官（庚 与日主相合, 不参与克我）（辛 同阴阳, …）\n
   *       同我者(木): 有力 → 比肩/劫财\n  … (共 5 行, 顺序按力量排, 不固定)\n
   *     旺衰: 旺(强)\n
   *     旺衰依据: 得令+得地+得势\n
   *     喜用: 火、土、金\n忌: 水、木
   *   拆成 5 行 (关系 / 五行字带色 / 有力·无力·不成立 / ⇒十神),
   *   全角括号注 (可能连着多条) 降成小字旁注, 一条不丢;
   *   底栏: 日主乙木(阴) · 旺衰 旺(强) · 依从 得令+得地+得势。
   *
   * ⚠ 防格式漂移: 抽不足 5 行就退成原文 bz-note 整段输出 ——
   *   宁可以原文显示, 也不许解析错了少半句 (命理内容一个字不能丢)。
   */
  function strengthDeriveHtml(raw) {
    const fallback = raw
      ? '<p class="bz-note" style="margin-top:8px;white-space:pre-wrap">'
        + esc(String(raw).replace(/^【[^】]*】\s*/, '')) + '</p>'
      : '';
    if (!raw) return '';
    const txt = String(raw).replace(/^【[^】]*】\s*/, '');

    const lines = txt.split('\n');
    const rows = [];
    let dm = null;      // [五行, 干, 阴阳]
    let wangsheng = ''; // 旺(强)
    let yicong = '';    // 得令+得地+得势
    for (const ln of lines) {
      let m = ln.match(/^\s*(我克者|生我者|克我者|同我者|我生者)\(([木火土金水])\)\s*[:：]\s*(有力|无力|不成立)\s*[→⇒]\s*(.+)$/);
      if (m) { rows.push(m); continue; }
      m = ln.match(/^\s*日主\s*[:：]\s*([木火土金水])·([甲乙丙丁戊己庚辛壬癸])\((阴|阳)\)/);
      if (m) { dm = m; continue; }
      m = ln.match(/^\s*旺衰\s*[:：]\s*(.+?)\s*$/);
      if (m && !wangsheng) { wangsheng = m[1]; continue; }
      m = ln.match(/^\s*(?:旺衰依据|依从)\s*[:：]\s*(.+?)\s*$/);
      if (m) { yicong = m[1]; continue; }
    }
    if (rows.length < 5) return fallback;

    const body = rows.map((r) => {
      const rel = r[1];                 // 我克者 …
      const wx = r[2];                  // 金 …
      const verdict = r[3];             // 有力 / 无力 / 不成立
      let gods = r[4].trim();           // 七杀/正官（庚 与日主相合, …）（辛 …）
      // 全角/半角括号注 (可能多条连着) ⇒ 全部抽出来降成小字旁注
      const notes = [];
      gods = gods.replace(/[（(]([^（）()]*)[）)]/g, (_, n) => { notes.push(n.trim()); return ''; }).trim();
      // 十神用 / 或连写分隔 ⇒ 统一成「七杀 · 正官」
      const godsTxt = gods.split(/[\/／]/).map((s) => s.trim()).filter(Boolean).join(' · ') || gods;
      const vCls = verdict === '有力' ? 'up' : (verdict === '无力' ? 'down' : 'no');
      return '<div class="bz-drv-row">'
        + '<span class="d-rel">' + esc(rel) + '</span>'
        + '<span class="d-wx bz-wxb bz-wx-' + wx + '">' + esc(wx) + '</span>'
        + '<span class="d-verdict ' + vCls + '">' + esc(verdict) + '</span>'
        + '<span class="d-gods">⇒ ' + esc(godsTxt)
        + notes.map((n) => '<i class="d-note">' + esc(n) + '</i>').join('')
        + '</span></div>';
    }).join('');

    // 底栏: 日主乙木(阴) · 旺衰 旺(强) · 依从 得令+得地+得势
    const bits = [];
    if (dm) {
      bits.push('日主 <b class="bz-wxb bz-wx-' + dm[1] + '">' + esc(dm[2]) + '</b>'
        + esc(dm[1]) + ' (' + esc(dm[3]) + ')');
    }
    if (wangsheng) bits.push('旺衰 ' + esc(wangsheng));
    if (yicong) bits.push('依从 ' + esc(yicong));
    const foot = bits.length ? '<div class="bz-drv-foot">' + bits.join('<i>·</i>') + '</div>' : '';

    return '<div class="bz-drv"><div class="bz-drv-rows">' + body + '</div>' + foot + '</div>';
  }

  function renderJingyao(c) {
    // 生肖 = 年支。app 的「本命虚空藏菩萨」块第一格就是它。
    const SX = ['鼠', '牛', '虎', '兔', '龙', '蛇', '马', '羊', '猴', '鸡', '狗', '猪'];
    const yz = (c.pillars && c.pillars['年柱'] || '').slice(1);
    const zodiac = SX['子丑寅卯辰巳午未申酉戌亥'.indexOf(yz)] || '-';
    const rows = [['生肖', zodiac], ['胎元', c.taiyuan], ['命宫', c.minggong], ['身宫', c.shengong],
      ['文昌位', c.wenchang_wei]];
    $('bz-jingyao-box').innerHTML = '<div class="bz-kv">'
      + rows.map((r) => '<span>' + r[0] + ' <b>' + esc(r[1] || '-') + '</b></span>').join('')
      + '</div><p class="bz-note" style="margin-top:8px">身旺身弱: ' + esc(c.status || '-') + '　'
      + esc(c.status_reason || '') + '</p>'
      + '<p class="bz-note" style="margin-top:6px">命宫按《三命通会·论坐命官》(生月逆行十二位、生时顺行十二位、逢卯安命); '
      + '身宫为同链逢酉, 本机资料无身宫原文, 属推导; '
      + '文昌位按课件顺口溜「尾数年 → 方位」查公历出生年尾数 (书桌朝向, 非「文昌贵人」地支)。</p>';
  }

  function renderShensha(c) {
    // 按神煞列支 (2026-10-31 第 182 批恢复)
    const sh = c.shensha || {};
    $('bz-shensha-box').innerHTML = '<p class="bz-note" style="margin:0 0 8px">'
      + '按神煞列支（各柱自己命中的神煞见上方四柱表「神煞」行）</p>'
      + Object.keys(sh).map((k) => {
        const v = sh[k];
        const arr = Array.isArray(v) ? v : [v];
        return '<span class="pg-tag">' + esc(k) + ' <b>' + gzWxHtml(arr.join('、')) + '</b></span>';
      }).join('') || '<p class="bz-note">原局无明显神煞。</p>';
  }

  /** 神煞里的干支按五行上色 */
  function gzWxHtml(txt) {
    return String(txt || '').split('、').map((raw) => {
      const t = raw.trim();
      const wx = t.length === 1 ? (ZHI_WX[t] || GAN_WX[t] || '') : '';
      return wx ? '<span class="bz-wxb bz-wx-' + wx + '">' + esc(t) + '</span>' : esc(t);
    }).join('、');
  }

  function renderRels(c) {
    // 地支关系 (冲/合/刑/害/破) —— 原局四支之间的互动。
    const rels = [
      ['chong', '冲', c.chong], ['he', '合', c.he], ['xing', '刑', c.xing],
      ['hai', '害', c.hai], ['po', '破', c.po],
    ];
    $('bz-rel-box').innerHTML = rels.map(([cls, label, arr]) => (arr || [])
      .map((txt) => '<div class="bz-rel ' + cls + '"><span class="k">' + label + '</span><span class="v">' + esc(txt) + '</span></div>')
      .join('')).join('') || '<p class="bz-note">原局无明显冲合刑害。</p>';
  }

  // 墓库与开库 (十神库意: 财才库/官杀库/印库/食伤库):
  // 日元财库 → 原局四支是否带库 → 刑冲开库 → 合局化解 → 十神库意。
  // 查法真源 (私有课程资料, 不随公开版走) 缺失时 → 空规则静默降级, 墓库段不渲染。
  const SI_SHEN_KU = { '财才库': '自己发财', '官杀库': '掌权/官运', '印库': '学术成就/名誉', '食伤库': '才华/子女' };
  const _mukuCache = {};
  function loadMukuRules() {
    if (_mukuCache.rules) return Promise.resolve(_mukuCache.rules);
    if (_mukuCache.p) return _mukuCache.p;
    _mukuCache.rules = {};
    _mukuCache.p = Promise.resolve(_mukuCache.rules);
    return _mukuCache.p;   // 开源版无 bazhai 工具, 墓库查法省略 (私有查法层不随公开内核走)
  }

  async function renderMuku(c) {
    const box = $('bz-muku-box');
    const note = $('bz-muku-note');
    box.innerHTML = '<p class="bz-note">查法真源载入中…</p>';
    note.textContent = '';
    const rules = await loadMukuRules();
    if (!rules || rules['可用'] === false || !rules['财库对应日元']) {
      box.innerHTML = '<p class="bz-note">墓库查法真源未载 (<course-source> 章节略 未入真源)。</p>';
      return;
    }
    const riYuan = c.day_master || '';
    const caiKu = rules['财库对应日元'][riYuan];
    // 原局四支: 年/月/日/时柱的地支
    const zhi = ['年柱', '月柱', '日柱', '时柱']
      .map((p) => ((c.pillars && c.pillars[p]) || '').slice(1, 2))
      .filter(Boolean);
    // 财库地支: 形如「辰(水库)」→ 取库字
    const kuZi = caiKu ? caiKu.slice(0, 1) : '';
    const hasKu = !!kuZi && zhi.indexOf(kuZi) !== -1;
    // 开库刑冲: 原局刑冲该库且未被合局化解
    const heSet = new Set(c.he || []);
    const kuOpen = [];
    for (const rel of (c.chong || [])) {
      if (kuZi && rel.indexOf(kuZi) !== -1 && !heSet.has(rel)) kuOpen.push('冲 ' + rel);
    }
    for (const rel of (c.xing || [])) {
      if (kuZi && rel.indexOf(kuZi) !== -1 && !heSet.has(rel)) kuOpen.push('刑 ' + rel);
    }
    const rows = [];
    if (caiKu) rows.push(['财库 (' + riYuan + ' 日元)', caiKu]);
    rows.push(['四库地支'], Object.entries(rules['四库地支'] || {}).map(([a, b]) => a + '=' + b).join(' '));
    rows.push(['原局带财库'], hasKu ? '是 (' + kuZi + ')' : '否 — 待大运流年遇库');
    rows.push(['开库刑冲'], kuOpen.length ? kuOpen.join(' · ') : '原局未冲开' + (heSet.size ? ' (有合局, 刑冲被化)' : ''));
    rows.push(['十神库'], Object.entries(SI_SHEN_KU).map(([a, b]) => a + ':' + b).join(' '));
    box.innerHTML = '<div class="bz-kv">'
      + rows.map((r) => '<span>' + esc(r[0]) + ' <b>' + esc(r[1]) + '</b></span>').join('')
      + '</div>';
    note.textContent = (rules['流年研判'] || '') + '。' + (rules['注意'] || '');
  }

  // 九宫飞星 (流年: 中宫落星顺飞 动态 × 三元九运 静态):
  // 排盘取「大运/流年」当前年查表。查法真源 (风水查法层, 私有课程资料) 不随公开版走,
  // 缺失时 renderFeixing 显「查法真源未载」静默降级。
  const _feixingCache = {};
  function loadFeixingRules() {
    if (_feixingCache.rules) return Promise.resolve(_feixingCache.rules);
    if (_feixingCache.p) return _feixingCache.p;
    _feixingCache.rules = {};
    _feixingCache.p = Promise.resolve(_feixingCache.rules);
    return _feixingCache.p;   // 开源版无 bazhai 工具, 九宫飞星查法省略 (风水查法层不随公开内核走)
  }

  async function renderFeixing(c) {
    const box = $('bz-feixing-box');
    const note = $('bz-feixing-note');
    box.innerHTML = '<p class="bz-note">查法真源载入中…</p>';
    note.textContent = '';
    const rules = await loadFeixingRules();
    if (!rules || rules['可用'] === false) {
      box.innerHTML = '<p class="bz-note">九宫飞星查法真源未载。</p>';
      return;
    }
    // 流年 = 排盘里当前在走的大运/流年年份; 没有就取当前公历年
    const liunian = (c.dayun && c.dayun['列表'] && c.dayun['列表'].length)
      ? Number(c.dayun['列表'][0]['起始年份'])
      : Number(new Date().getFullYear());
    const fx = _feixingCache.fx || {};
    const rows = [];
    if (rules['中宫落星']) rows.push(['中宫落星 (流年 ' + liunian + ')', rules['中宫落星']]);
    rows.push(['三元九运'], rules['三元九运'] || '—');
    if (fx['叠加规则']) {
      rows.push(['叠加规则'], Object.entries(fx['叠加规则']).map(([a, b]) => a + ':' + b).join(' '));
    }
    if (fx['财位优先级']) rows.push(['财位优先级'], fx['财位优先级']);
    box.innerHTML = '<div class="bz-kv">'
      + rows.map((r) => '<span>' + esc(r[0]) + ' <b>' + esc(r[1]) + '</b></span>').join('')
      + '</div>';
    note.textContent = '九宫飞星: 中宫落星(动态) 配 三元九运(静态) 同看流年。风水结合查法 (九星同宫叠加/财位优先级) 未随公开版, 需配查法真源。';
  }

  // ── 大运 / 流年 / 流月: 横向一排, 点一个联动下一段 ──────────
  // 原版 BaziView.jsx:
  //   大运  —— 上排起始年份 / 中排虚岁 / 下排干支(可点)
  //   流年  —— 选中大运那十年的 10 个流年(可点)
  //   流月  —— 选中流年那年的 12 个流月
  // 这里照搬这个联动, 不改成大表格。

  /** 干支竖排 (原版 GZ 组件): 上天干 + 十神, 下地支 + 十神。 */
  function gzHtml(gz, shishen, zhiShishen) {
    const s = String(gz || '-');
    const gan = s.slice(0, 1);
    const zhi = s.slice(1, 2);
    const row = (ch, wx, ss) => '<span class="bz-gz-row">'
      // 材质图标跟着字的五行色走 (currentColor) —— 第 128 批起没有色块了,
      // 图标跟字同色, 老板要的「带上材质」才真的看得见。
      + '<span class="bz-gz-ch bz-wxb ' + wxClass(wx || '') + '">' + esc(ch) + wxIconHtml(wx, 9) + '</span>'
      + (ss ? '<span class="bz-gz-ss">' + esc(ss) + '</span>' : '')
      + '</span>';
    return '<span class="bz-gz">' + row(gan, GAN_WX[gan], shishen) + row(zhi, ZHI_WX[zhi], zhiShishen) + '</span>';
  }

  function dayunList(c) {
    return (c.dayun && c.dayun['列表']) || [];
  }

  /**
   * 大运那一步的**虚岁** (2026-10-31 第 176 批)。
   *
   * ⚠ 旧写法是 `Math.floor(d['起始年龄'])` —— 把「起运 6.51 岁」截断成 **6岁**。
   *   虚岁不是周岁: 起运 6.51 岁是在**1993 年 6 月**, 那年虚岁 **8**。
   *   老板 2026-10-31 明说: 「年岁是按虚岁算, 按照立春这个节气来订立」,
   *   他上课的 app 给的也是 1993 起运 / 8 虚岁。
   *
   * 后端已经按立春分界算好了 `起始虚岁` ⇒ 直接用。
   * 万一后端没给 (老数据), 退回「起始年 − 出生年 + 1」这个等效式, 不猜。
   */
  function xusuiOf(d) {
    const v = d && d['起始虚岁'];
    if (v !== null && v !== undefined && v !== '') return Number(v);
    const y = Number(d && d['起始年份']);
    const birth = Number(state.chart && state.chart.input && state.chart.input.year) || 0;
    return (y && birth) ? (y - birth + 1) : Math.floor(Number(d && d['起始年龄'] || 0));
  }

  /**
   * 某个公历年的**虚岁** (立春分界)。
   *   基准年 = 立春前出生就减一年 (后端算好, 叫 birth_lichun_year)。
   *   虚岁 = 该年 − 基准年 + 1。
   *   老板 app: 1986 出生、1993 年 → 8 岁、2002 年 → 17 岁 ⇒ 1993−1986+1 = 8 ✓
   */
  function xusuiOfYear(y) {
    const c = state.chart || {};
    const base = Number(c.birth_lichun_year)
      || (Number(c.input && c.input.year) || 0);
    return y - base + 1;
  }

  function renderDayun(c) {
    const list = dayunList(c);
    const now = new Date().getFullYear();
    const birth = Number(c.input.year) || 0;
    $('bz-dayun-hint').textContent = ((c.dayun && c.dayun['排法']) || '')
      + ' · 出生后 ' + ((c.dayun && c.dayun['起运']) || '-') + ' 起运';
    // 交运 (2026-10-31 第 176 批): 起运时刻落在的那一天 + 那一日的日干支 + 节气点。
    //   老板 app: 「交运: 逢癸、戊年, 芒种后15天交大运」
    //   本盘: 交运日 1993-06-21 (癸酉日), 节气 夏至 ⇒ 逢癸日, 芒种后 15 天 ✓
    const _jy = c.dayun || {};
    if (_jy['交运日期']) {
      $('bz-dayun-hint').textContent += ' · 交运 ' + _jy['交运日期']
        + (_jy['交运日干支'] ? ' (' + _jy['交运日干支'] + '日)' : '')
        + (_jy['交运节气'] ? ' ' + _jy['交运节气'] : '');
    }

    // 默认落在「今年所在的那步大运」, 没落在就落第一步
    if (state.selDayun == null) {
      const idx = list.findIndex((d) => {
        const y = Number(d['起始年份']);
        return y && now >= y && now < y + 10;
      });
      state.selDayun = idx >= 0 ? idx : 0;
    }

    let html = '<tbody>';
    html += '<tr class="muted"><th class="rowh"></th>'
      + list.map((d) => '<th>' + esc(d['起始年份'] != null
        ? d['起始年份']
        : birth + Math.floor(Number(d['起始年龄'] || 0))) + '</th>').join('')
      + '</tr>';
    html += '<tr class="muted"><th class="rowh">虚岁</th>'
      + list.map((d) => '<td>' + xusuiOf(d) + '岁</td>').join('')
      + '</tr>';
    html += '<tr><th class="rowh">大运</th>'
      + list.map((d, i) => {
        const on = i === state.selDayun;
        const cur = now >= Number(d['起始年份']) && now < Number(d['起始年份']) + 10;
        return '<td class="bz-pick' + (on ? ' on' : '') + '" data-dayun="' + i + '"'
          + ' id="bz-anchor-dayun-' + esc(d['干支']) + '">'
          + gzHtml(d['干支'], d['十神'], d['地支十神'])
          + (cur ? '<span class="bz-tag-now">当前</span>' : '')
          + '</td>';
      }).join('')
      + '</tr>';
    // 性运 (2026-10-31 第 177 批): 日主坐大运地支的十二长生 —— app 大运表有这行。
    //   跟四柱表的「星运」同一把尺子; 不是大运干坐自己支的「自坐」。
    html += '<tr class="muted"><th class="rowh">性运</th>'
      + list.map((d) => '<td>' + esc(d['性运'] || '-') + '</td>').join('')
      + '</tr>';
    html += '</tbody>';
    $('bz-t-dayun').innerHTML = html;
  }

  /** 选中大运 → 那十年的流年 */
  function flowYearsOf(c) {
    const list = c.liunian || [];
    const birth = Number(c.input.year) || 0;
    const d = dayunList(c)[state.selDayun];
    if (!d) return [];
    const start = Number(d['起始年份']) != null && d['起始年份'] !== ''
      ? Number(d['起始年份'])
      : birth + Math.floor(Number(d['起始年龄'] || 0));
    return list.filter((y) => Number(y['年份']) >= start && Number(y['年份']) < start + 10);
  }

  function renderLiunian(c) {
    const rows = flowYearsOf(c);
    const birth = Number(c.input.year) || 0;
    const d = dayunList(c)[state.selDayun];
    const start = d ? Number(d['起始年份']) : 0;
    $('bz-liunian-hint').textContent = (d ? (d['干支'] || '') + ' ' : '') + (start ? start + '—' + (start + 9) : '');

    if (state.selYear >= rows.length) state.selYear = 0;

    let html = '<tbody>';
    html += '<tr class="muted"><th class="rowh"></th>'
      + rows.map((y) => '<th>' + esc(y['年份']) + '</th>').join('') + '</tr>';
    html += '<tr><th class="rowh">流年</th>'
      + rows.map((y, i) => {
        const on = i === state.selYear;
        return '<td class="bz-pick' + (on ? ' on' : '') + '" data-year="' + i + '"'
          + ' id="bz-anchor-year-' + esc(y['年份']) + '">'
          + gzHtml(y['干支'], y['十神'], y['地支十神'])
          + '<span class="bz-gz-age">' + (birth ? xusuiOfYear(Number(y['年份'])) : '-') + '岁</span>'
          + '</td>';
      }).join('')
      + '</tr>';
    html += '</tbody>';
    $('bz-t-liunian').innerHTML = html;
  }

  /** 选中流年 → 那年的 12 个流月 */
  function renderLiuyue(c) {
    const rows = flowYearsOf(c);
    const y = rows[state.selYear] || rows[0] || null;
    const months = (y && y['流月']) || [];
    $('bz-liuyue-hint').textContent = y ? (y['年份'] || '-') + ' 年' : '';

    let html = '<tbody>';
    html += '<tr class="muted"><th class="rowh"></th>'
      + months.map((m) => '<th>' + esc((m['干支'] || '').slice(1, 2)) + '月</th>').join('') + '</tr>';
    html += '<tr><th class="rowh">流月</th>'
      + months.map((m) => '<td>' + gzHtml(m['干支'], m['十神'], m['地支十神']) + '</td>').join('')
      + '</tr>';
    html += '</tbody>';
    $('bz-t-liuyue').innerHTML = html;
  }

  // ── AI 解读: 一项一次请求 ───────────────────────────────────
  const ai = {
    sections: [],   // {id, title, chip, budget, prompt, el, status}
    notes: [],
  };

  function resetAI() {
    ai.sections = [];
    ai.notes = [];
    $('bz-ai-sections').innerHTML = '';
    $('bz-ai-notes').innerHTML = '';
    $('bz-ai-state').textContent = '未开始';
    $('bz-ai-progress').textContent = '';
    $('bz-btn-ai-start').hidden = false;
    $('bz-btn-ai-stop').hidden = true;
  }

  function aiItemEl(item) {
    const div = document.createElement('div');
    div.className = 'bz-ai-item';
    div.innerHTML = '<div class="bz-ai-h"><span class="t"></span><span class="pg-badge"></span></div>'
      + '<div class="bz-ai-b"></div><div class="bz-ai-m"></div>';
    const t = div.querySelector('.t');
    if (item.anchor) {
      const a = document.createElement('a');
      a.href = '#' + item.anchor;
      a.dataset.anchor = item.anchor;
      a.textContent = item.title;
      a.className = 'bz-anchor-link';
      t.appendChild(a);
    } else {
      t.textContent = item.title;
    }
    if (item.chip) div.querySelector('.pg-badge').textContent = item.chip;
    item.el = div;
    return div;
  }

  async function chat(prompt, budget) {
    const j = await api.chat({
      messages: [{ role: 'user', content: prompt }],
      max_tokens: budget,
      reasoning_effort: EFFORT,
      timeout_ms: 120000,
      session_id: state.sessionId,
    }, { timeoutMs: 150000 });
    if (!j || !j.ok) {
      // 客户端超时是 AbortError, 原文是英文的 "signal is aborted without reason"
      // ⇒ 换成人话, 顺带告诉用户「点重试这一项就行」。
      if (j && j.timeout) throw new Error('这一项超时了, 点「重试这一项」再来一次');
      throw new Error((j && (j.error || j.agent_error)) || '请求失败');
    }
    const text = (((j.choices || [])[0] || {}).message || {}).content || '';
    // 2026-10-31 (老板: 「为什么都会有预算?」): 把**真账**带回来。
    //   服务端现在回 usage (prompt/completion/reasoning) + retried (有没有用过满
    //   预算静默重试) + budget_effective (实际生效的上限)。
    //   旧代码只回字符串 ⇒ 页面只能印「预算 2048 token」那个**请求意图值**,
    //   而实际可能按 32768 跑出来的 —— 假账。
    return {
      text: String(text).trim(),
      usage: (j.usage && typeof j.usage === 'object') ? j.usage : null,
      retried: !!j.retried,
      budgetEffective: Number(j.budget_effective) || null,
      truncated: !!j.answer_truncated,
      // 服务端判定「这答案没跟问题对齐, 用了兜底文案」⇒ 页面不能说这坨字是模型写的,
      // 也不该把那次的 usage 记成「正文花了多少」。
      recovered: !!j.answer_recovered,
    };
  }

  /**
   * 一项一次请求。正文空 **或上游说截断** ⇒ 预算翻倍重试一次。
   *
   * 2026-10-31: 之前只在「正文空」时才重试 —— 但**半截正文**(上游说
   * finish_reason='length', 服务端又没能再补一次)同样不合格, 以前直接上屏,
   * 页面看着像完整的。现在服务端把 `answer_truncated` 交出来 ⇒ 也能判。
   * 任何一次失败只影响这一项 —— 页面上它自己显示失败 + 一个「重试」按钮。
   */
  async function runItem(item) {
    item.status = 'loading';
    paintItem(item);
    let text = '';
    let meta = null;
    let err = null;
    const t0 = Date.now();
    // 2026-10-31 修 (老板: 「预设上限不对」): 翻倍只在这一轮**内部**生效。
    //   旧写法是 `item.budget = Math.min(item.budget * 2, 32000)` —— 就地改写,
    //   于是手动点「重试这一项」会从**已翻倍**的值再翻倍 ⇒ 反复点一路涨到 32000,
    //   而且脚注里的「上限」也开始说谎 (显示的数跟规格算出来的那个不是一回事)。
    //   现在: 规格原值永远留在 item.budget (= item.baseBudget),
    //   每一轮都从规格原值起算, 翻倍只活在这一次调用里。
    const baseBudget = item.baseBudget || item.budget;
    let cap = baseBudget;
    item.cap = cap;
    try {
      const r1 = await chat(item.prompt, cap);
      text = r1.text;
      meta = r1;
      if (!text || r1.truncated) {
        // 正文空或被截断 ⇒ 预算翻倍重试一次 (思考吃光了预算的兜底)。
        // ⚠ 翻倍后仍受服务端 32000 硬上限约束 (inline_router 的 clamp)。
        cap = Math.min(cap * 2, 32000);
        item.cap = cap;
        const r2 = await chat(item.prompt, cap);
        text = r2.text;
        meta = r2;
      }
    } catch (e) {
      err = e;
    }
    if (state.stopped && !text) { item.status = 'idle'; paintItem(item); return; }
    if (text) {
      item.status = 'done';
      item.text = text;
      item.secs = ((Date.now() - t0) / 1000).toFixed(1);
      item.usage = (meta && meta.usage) || null;
      item.retried = !!(meta && meta.retried);
      item.budgetEffective = (meta && meta.budgetEffective) || null;
      item.truncated = !!(meta && meta.truncated);
      item.doubled = cap !== baseBudget;
      item.recovered = !!(meta && meta.recovered);
    } else {
      item.status = 'failed';
      item.error = (err && err.message) || '未返回正文';
    }
    paintItem(item);
  }

  /**
   * 一项的真账 —— 2026-10-31 (老板: 「为什么都会有预算?」)。
   *
   * 旧版印「预算/真账」两行小字。2026-11-02 老板: 「都不用显示」
   * ⇒ 整行撤掉 (加载态的「上限 N token · 推理强度」+ 完成态的
   *   「正文字数 · 思考 · 共 N token」全部不印)。真账数据仍保留在
   *   item 上 (usage/retried/cap), 只是页面不展示 —— 机制还在, 只是闭嘴。
   */
  function paintItem(item) {
    const node = item.el;
    if (!node) return;
    const b = node.querySelector('.bz-ai-b');
    const m = node.querySelector('.bz-ai-m');
    node.classList.toggle('loading', item.status === 'loading');
    node.classList.toggle('failed', item.status === 'failed');
    if (item.status === 'loading') {
      b.innerHTML = '<span class="bz-spin"></span> 生成中…';
      m.textContent = '';
    } else if (item.status === 'done') {
      b.textContent = item.text;
      m.textContent = '';
    } else if (item.status === 'failed') {
      b.textContent = '这一项没出来: ' + item.error;
      m.innerHTML = '<button class="pg-btn pg-btn-sm" type="button" data-retry="' + esc(item.id) + '">重试这一项</button>';
    } else {
      b.textContent = '待生成';
      m.textContent = '';
    }
  }

  async function pool(items, worker, limit) {
    let i = 0;
    const n = Math.max(1, Math.min(limit || 3, items.length));
    await Promise.all(Array.from({ length: n }, async () => {
      while (i < items.length && !state.stopped) {
        const idx = i++;
        await worker(items[idx]);
      }
    }));
  }

  async function startReading() {
    if (!state.chart || state.running) return;
    const c = state.chart;
    state.running = true;
    state.stopped = false;
    $('bz-btn-ai-start').hidden = true;
    $('bz-btn-ai-stop').hidden = false;

    // 分段解读: 九项
    ai.sections = SECTIONS.map((sec) => ({
      id: 'sec-' + sec.key, kind: 'section', title: sec.title, chip: '',
      // 2026-10-31: 每节按**自己**的规格算上限 (九节的思考用量实测差 8 倍:
      // summary 341 → health 2712), 不再共用一个数。
      budget: budgetOf(SPEC.section[sec.key] || SPEC.section.summary),
      prompt: buildSectionPrompt(c, sec),
    }));
    for (const it of ai.sections) it.baseBudget = it.budget;
    for (const it of ai.sections) $('bz-ai-sections').appendChild(aiItemEl(it));


    // 逐项批语: 每一项针对一个具体对象
    const targets = buildNoteTargets(c);
    ai.notes = targets.map((t) => ({
      id: t.id, kind: 'note', title: t.label, chip: (t.chip ? t.chip + ' · ' : '') + t.group,
      budget: t.budget, prompt: buildNotePrompt(c, t),
      anchor: anchorOf(t),
    }));
    for (const it of ai.notes) it.baseBudget = it.budget;
    for (const it of ai.notes) $('bz-ai-notes').appendChild(aiItemEl(it));

    $('bz-ai-state').textContent = '生成中…';
    const all = ai.sections.concat(ai.notes);
    let done = 0;
    const tick = () => {
      done += 1;
      $('bz-ai-progress').textContent = done + ' / ' + all.length + ' 项完成';
    };
    await pool(all, async (item) => {
      if (state.stopped) return;
      await runItem(item);
      tick();
    }, 3);

    state.running = false;
    $('bz-btn-ai-stop').hidden = true;
    $('bz-btn-ai-start').hidden = false;
    $('bz-ai-state').textContent = state.stopped ? '已停止' : '完成';
    if (!state.stopped) $('bz-ai-progress').textContent = done + ' / ' + all.length + ' 项完成';
  }

  function anchorOf(t) {
    if (t.group === '大运') {
      const m = /大运\s*(\S+?)\s/.exec(t.label);
      return m ? 'bz-anchor-dayun-' + m[1] : null;
    }
    if (t.group === '流年') {
      const m = /(\d{4})\s/.exec(t.label);
      return m ? 'bz-anchor-year-' + m[1] : null;
    }
    return null;
  }

  function initAI() {
    $('bz-btn-ai-start').addEventListener('click', startReading);
    $('bz-btn-ai-stop').addEventListener('click', () => {
      state.stopped = true;
      $('bz-ai-state').textContent = '已停止';
    });
    $('bz-ai-tabs').addEventListener('click', (e) => {
      const b = e.target.closest('[data-aitab]');
      if (!b) return;
      [...$('bz-ai-tabs').children].forEach((x) => x.classList.toggle('on', x === b));
      $('bz-ai-sections').hidden = b.dataset.aitab !== 'sections';
      $('bz-ai-notes').hidden = b.dataset.aitab !== 'notes';
    });
    // 事件委托挂在 host 上 —— 视图切换时整棵树被替换, 挂 host 才不会漏。
    host.addEventListener('click', (e) => {
      const btn = e.target.closest('[data-retry]');
      if (btn) {
        const id = btn.dataset.retry;
        const item = ai.sections.concat(ai.notes).find((x) => x.id === id);
        if (item && !state.running) runItem(item);
        return;
      }
      const link = e.target.closest('[data-anchor]');
      if (link) {
        const target = host.querySelector('#' + CSS.escape(link.dataset.anchor));
        if (target) {
          target.scrollIntoView({ behavior: 'smooth', block: 'center' });
          target.classList.add('bz-flash');
          setTimeout(() => target.classList.remove('bz-flash'), 1200);
        }
      }
    });
  }

  // ── 大运 / 流年 联动 (原版就是点一个换下一段) ─────────────────
  // ── 大运 / 流年 联动 (原版就是点一个换下一段) ─────────────────
  function initTimeline() {
    $('bz-t-dayun').addEventListener('click', (e) => {
      const cell = e.target.closest('[data-dayun]');
      if (!cell || !state.chart) return;
      state.selDayun = Number(cell.dataset.dayun);
      state.selYear = 0;
      renderDayun(state.chart);
      renderLiunian(state.chart);
      renderLiuyue(state.chart);
    });
    $('bz-t-liunian').addEventListener('click', (e) => {
      const cell = e.target.closest('[data-year]');
      if (!cell || !state.chart) return;
      state.selYear = Number(cell.dataset.year);
      renderLiunian(state.chart);
      renderLiuyue(state.chart);
    });
  }

  initForm();
  initTimeline();
  initAI();

  // 第 143 批: 构建号原来**明写**在页脚上 (「构建 3c12577e0c22」) ——
  //   那是排障用的内部指纹, 印给用户看只是噪声 (而且源码目录名也不该外露)。
  //   现在挂成页脚的 hover 提示: 排障时鼠标一停就能拿到, 平时看不见。
  const foot = host.querySelector('.bz-foot');
  if (foot) {
    const setStamp = (stamp) => { foot.title = '构建 ' + (stamp || '未知'); };
    setStamp(currentStamp());
    // 指纹是异步拿到的 —— 拿到后补一次
    const onStamp = (e) => { setStamp((e.detail && e.detail.stamp) || ''); };
    window.addEventListener('pangu:buildstamp', onStamp);
    state.onStamp = onStamp;
  }

  return {
    destroy() {
      // 解读跑到一半时切页 ⇒ 停掉, 别让后台继续烧 token。
      state.stopped = true;
      if (state.onStamp) window.removeEventListener('pangu:buildstamp', state.onStamp);
      host.remove();
    },
  };
}

export default render;
