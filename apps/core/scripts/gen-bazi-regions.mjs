// 生成 web/app/lib/bazi/regions.mjs —— 全国省 → 市 → 区县 三层区划数据。
//
// 2026-10-27 (第 120 批) 老板: 「选，不要填」—— 区县不许自由文本, 必须下拉选。
//
// 数据源: npm 包 china-division (MIT), dist/pca-code.json (省→市→区 三层)。
//   npm i china-division && node scripts/gen-bazi-regions.mjs \
//     node_modules/china-division/dist/pca-code.json
//
// 规则 (都写在下面, 不靠人脑记):
//   1. 省名去掉「省/自治区/特别行政区/市」尾巴 —— 跟旧版 PROVINCES 的短名一致。
//   2. 市名去掉「市」尾巴; 自治州/地区/盟 走白名单映射(短名更好认, 也对得上 CITY_LONG)。
//   3. 直辖市(京沪津渝): 第二层本来就是区县 —— 合成一个「市」= 自己, 第三层是它的区县。
//   4. 「省直辖县级行政区划」/「自治区直辖县级行政区划」= 县级市/林区, 提到「市」层,
//      自己没有下一层 ⇒ 区县只有一个选项(它自己)。
//   5. 直筒子市(东莞/中山/儋州/嘉峪关/三沙…): 数据里的子节点是镇/街道, 不是区县 ⇒
//      不许拿镇当区县, 区县只列它自己。

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MUNICIPALITIES, stripProv, shortCity } from './bazi-city-short-names.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(HERE, '..', 'web', 'app', 'lib', 'bazi', 'regions.mjs');

// 开发区/新区/园区 不是行政区 —— 不许当区县列出来。
const isRealDistrict = (n) =>
  (n.endsWith('区') && !/(新区|开发区|园区|工业区)$/.test(n))
  || n.endsWith('县') || n.endsWith('旗');

const main = () => {
  const src = process.argv[2];
  if (!src) {
    console.error('用法: node scripts/gen-bazi-regions.mjs <pca-code.json>');
    process.exit(1);
  }
  const tree = JSON.parse(fs.readFileSync(src, 'utf8'));

  const provinces = {};   // 省 → [市]
  const districts = {};   // 省 → 市 → [区县]
  const notes = [];

  for (const p of tree) {
    const prov = stripProv(p.name);
    const isMuni = MUNICIPALITIES.includes(prov);
    const cities = [];
    const dmap = {};

    // 直辖市: 「市辖区」+「县」两个分组节点合成一个市(自己)。
    let muniKids = [];
    for (const c of p.children || []) {
      if (c.name === '市辖区' || c.name === '县') {
        muniKids = muniKids.concat((c.children || []).map((k) => k.name));
        continue;
      }
      // 「省/自治区直辖县级行政区划」= 县级市/林区, 提到市层, 自己没有下一层。
      if (/行政区划$/.test(c.name)) {
        for (const k of c.children || []) {
          const name = k.name;
          const short = shortCity(name);
          cities.push(short);
          dmap[short] = [name];
        }
        continue;
      }
      // 普通地级市
      const kids = (c.children || []).map((k) => k.name);
      const real = kids.filter(isRealDistrict);
      const short = shortCity(c.name);
      if (real.length >= 2) {
        cities.push(short);
        dmap[short] = real;
      } else if (real.length === 1 && kids.length === 1) {
        cities.push(short);
        dmap[short] = real;
      } else {
        // 直筒子市: 子节点是镇/街道, 不是区县 ⇒ 区县只有它自己。
        notes.push(`直筒子市 ${c.name} → 区县只列自己`);
        cities.push(short);
        dmap[short] = [c.name];
      }
    }

    if (isMuni) {
      // 直辖市: 市 = 自己, 区县 = 它自己的区县。
      const list = muniKids.filter(isRealDistrict);
      provinces[prov] = [prov];
      districts[prov] = { [prov]: list };
    } else {
      provinces[prov] = cities;
      districts[prov] = dmap;
    }
  }

  const q = (s) => "'" + String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'") + "'";
  const arr = (a) => '[' + a.map(q).join(', ') + ']';

  let out = '';
  out += '// 全国行政区划 (省 → 市 → 区县) —— 纯数据, 无逻辑。\n';
  out += '//\n';
  out += '// 数据源: npm 包 china-division (MIT) 的 dist/pca-code.json, 用\n';
  out += '//   apps/core/scripts/gen-bazi-regions.mjs 生成。改数据改脚本, 别手改这里。\n';
  out += '// 生成时间: ' + new Date().toISOString().slice(0, 10) + '\n';
  out += '//\n';
  out += '// 省/市用短名(河南/郑州), 区县用全名(金水区) —— 短名对得上后端真太阳时\n';
  out += '// 经度表 CITY_LONG, 全名是行政通名。\n';
  out += '\n';
  out += 'export const PROVINCES = {\n';
  for (const [p, cs] of Object.entries(provinces)) {
    out += '  ' + q(p) + ': ' + arr(cs) + ',\n';
  }
  out += '};\n';
  out += '\n';
  out += 'export const DISTRICTS = {\n';
  for (const [p, cmap] of Object.entries(districts)) {
    out += '  ' + q(p) + ': {\n';
    for (const [c, ds] of Object.entries(cmap)) {
      out += '    ' + q(c) + ': ' + arr(ds) + ',\n';
    }
    out += '  },\n';
  }
  out += '};\n';
  out += '\n';
  out += 'export const MUNICIPALITIES = ' + arr(MUNICIPALITIES) + ';\n';

  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, out);

  const nProv = Object.keys(provinces).length;
  const nCity = Object.values(provinces).reduce((a, b) => a + b.length, 0);
  const nDist = Object.values(districts)
    .flatMap((m) => Object.values(m)).reduce((a, b) => a + b.length, 0);
  console.log(`写出 ${OUT}`);
  console.log(`省 ${nProv} · 市 ${nCity} · 区县 ${nDist}`);
  for (const n of notes) console.log('  注: ' + n);
};

main();
