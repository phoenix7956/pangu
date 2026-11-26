// 生成 modules/tools/bazi/city_long.json —— 真太阳时用的**全国市/区县经度表**。
//
// 2026-10-28 第 131 批 (起因: 消费面审计):
//   前端下拉给 369 个市, 后端 CITY_LONG 只有 41 个 ⇒ 331 个市 (89.7%) 命中不了,
//   **静默**退回 120°E (东八区中心)。喀什差 176 分钟、和田差 160 分钟 ——
//   2~3 小时的真太阳时误差, 足以把时柱排错, 而输出看起来跟正确盘一模一样。
//   (前端只在页面上给一句提示, 走工具/agent 的那条路**连提示都没有**。)
//
// 数据源: 阿里 DataV 行政区划边界 (areas_v3), 每级带 center(经纬度)。
//   .../100000_full.json  → 省
//   .../{省adcode}_full.json → 市
//   .../{市adcode}_full.json → 区县
//
// 关键约束: **覆盖率必须 100%** —— 本脚本拿前端真源
//   web/app/lib/bazi/regions.mjs 的 PROVINCES 当清单, 逐个查经度;
//   查不到就**报错退出**, 不写半张表。(半张表 = 又一次静默降级。)
//
// 用法: node scripts/gen-bazi-city-long.mjs [--offline]
//   --offline: 只用 /tmp/datav-cache 的缓存, 不发网络请求。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVINCES } from '../web/app/lib/bazi/regions.mjs';
import { MUNICIPALITIES, shortCity, stripProv } from './bazi-city-short-names.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'modules', 'tools', 'bazi', 'city_long.json');
const CACHE = '/tmp/datav-cache';
const BASE = 'https://geo.datav.aliyun.com/areas_v3/bound';

const OFFLINE = process.argv.includes('--offline');
fs.mkdirSync(CACHE, { recursive: true });

async function getGeo(adcode) {
  const file = path.join(CACHE, `${adcode}.json`);
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf-8'));
  if (OFFLINE) throw new Error(`离线模式且无缓存: ${adcode}`);
  const url = `${BASE}/${adcode}_full.json`;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(30000) });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const txt = await res.text();
      fs.writeFileSync(file, txt);
      return JSON.parse(txt);
    } catch (e) {
      if (attempt === 2) throw new Error(`${adcode} 取经度失败: ${e.message}`);
      await new Promise((r) => setTimeout(r, 800 * (attempt + 1)));
    }
  }
}

// 小并发池: 别把 DataV 打挂, 也别串行等 375 个请求
async function pool(items, limit, worker) {
  const out = new Array(items.length);
  let idx = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (idx < items.length) {
      const i = idx++;
      out[i] = await worker(items[i], i);
    }
  });
  await Promise.all(runners);
  return out;
}

const lngOf = (feat) => {
  const c = feat.properties?.center || feat.center;
  return Array.isArray(c) ? Number(c[0]) : null;
};

const main = async () => {
  const country = await getGeo('100000');
  const provFeats = (country.features || []).filter((f) => f.properties?.level === 'province');

  const cities = {};
  const districts = {};
  const provLong = {};

  for (const pf of provFeats) {
    const pName = stripProv(pf.properties.name);
    const pLng = lngOf(pf);
    if (pLng != null) provLong[pName] = pLng;
  }

  // 只取前端真源里**真的有**的省 —— DataV 的台湾(710000)没有边界数据, 会 404。
  // 前端 PROVINCES 里本来就没有台湾/香港/澳门, 所以这里跳过它们是对的,
  // 不是"少做了"。
  const wantedProvs = provFeats.filter((pf) => PROVINCES[stripProv(pf.properties.name)]);

  await pool(wantedProvs, 6, async (pf) => {
    const adcode = pf.properties.adcode;
    const pName = stripProv(pf.properties.name);
    const isMuni = MUNICIPALITIES.includes(pName);
    const geo = await getGeo(adcode);
    const feats = (geo.features || []).filter((f) => f.properties?.level === 'city');

    // 直辖市: DataV 的省级文件里**直接就是区县**, 没有 city 层。
    //   所以直辖市自己就是那个「市」⇒ 用省中心点当市经度, 区县照抄下层。
    if (isMuni) {
      const pLng = lngOf(pf);
      if (pLng != null) cities[pName] = pLng;
      const m = {};
      for (const df of (geo.features || []).filter((f) => f.properties?.level === 'district')) {
        const dl = lngOf(df);
        if (dl != null) m[df.properties.name] = dl;
      }
      if (Object.keys(m).length) districts[pName] = m;
      return;
    }

    for (const cf of feats) {
      const raw = cf.properties.name;
      const name = shortCity(raw);
      const lng = lngOf(cf);
      if (lng == null) continue;
      if (cities[name] == null) cities[name] = lng;

      const cad = cf.properties.adcode;
      if (!cad) continue;
      try {
        const cgeo = await getGeo(cad);
        const dfs = (cgeo.features || []).filter((f) => f.properties?.level === 'district');
        const m = {};
        for (const df of dfs) {
          const dl = lngOf(df);
          if (dl != null) m[df.properties.name] = dl;
        }
        if (Object.keys(m).length) districts[name] = m;
      } catch (e) {
        console.warn('  区县经度取不到(不影响市): ' + name + ' — ' + e.message);
      }
    }
  });

  // ── 覆盖率自检: 前端能选的市, 必须**全部**有经度 ──
  const wanted = [];
  const cityProv = {};
  for (const [p, cs] of Object.entries(PROVINCES)) {
    for (const c of cs) { wanted.push({ p, c }); cityProv[c] = p; }
  }
  const missing = wanted.filter(({ c }) => cities[c] == null);
  const extra = Object.keys(cities).filter((c) => !wanted.some((w) => w.c === c));

  // 数据源没收录的城市(目前只有新疆兵团的 新星/白杨, 2021 年才设市, DataV 没有):
  //   用**省中心点**兜底, 但**必须记进 cities_approx** —— 后端拿到这个标记会
  //   当面告诉模型"这个城市用的是省级参考值", 不许悄悄用。
  const citiesApprox = {};
  for (const { p, c } of missing) {
    const lng = provLong[p];
    if (lng == null) {
      console.error('✗ 经度表缺 ' + c + '(在 ' + p + '), 且没有省级参考值可用:');
      console.error('→ 不写半张表(半张表 = 又一次静默降级)。先修数据源或短名规则。');
      process.exit(1);
    }
    cities[c] = lng;
    citiesApprox[c] = { lng, basis: p + '省中心点参考值', error_note: '该城市数据源未收录, 经度为省级参考值, 误差可能达 1~2 小时' };
    console.warn('  ! ' + p + '/' + c + ' 数据源未收录 → 用' + p + '省中心点参考值, 已在表里标记');
  }

  const out = {
    _generated: new Date().toISOString().slice(0, 10),
    _source: '阿里 DataV areas_v3 行政区划 center (经度)',
    _note: '经度 = 行政中心点经度; 真太阳时 = 北京时间 + (经度 - 120) * 4 分钟',
    provinces: provLong,
    cities,
    cities_approx: citiesApprox,
    districts,
  };
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 0));

  console.log('写出 ' + OUT);
  console.log('市 ' + Object.keys(cities).length
    + ' (前端清单 ' + wanted.length + ', 覆盖率 100%)'
    + ' · 区县 ' + Object.values(districts).reduce((a, m) => a + Object.keys(m).length, 0)
    + ' · 省 ' + Object.keys(provLong).length);
  if (extra.length) console.log('  注: 表里多出(前端没列的): ' + extra.join('、'));
};

main().catch((e) => { console.error(e); process.exit(1); });
