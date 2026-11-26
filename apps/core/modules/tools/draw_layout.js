// draw_layout.js — 确定性平面图出图工具 (2026-08-02 老板拍: "盘古为啥不出图")
// 2026-08-03 画质大升级 (老板拍: "freecad 出的图这么差"):
//   SVG 从裸色块 → 建筑平面图标准: 墙体双线(可设厚度) / 尺寸链(箭头+标注) / 房间面积㎡ /
//   比例尺 / 标题栏 / 建筑配色 / 家具真实比例圆角。
//   FCStd 从平板块 → 真三维: 墙体 2800mm 高带厚度(外盒减内盒) / 地板 / 家具按名称推真实高度。
// 反幻觉硬结构不变: 返回前逐文件 fs.statSync 验证, 只报验证过的文件+字节数。

const fs = require('fs');
const path = require('path');
const os = require('os');

function _esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

// 家具默认真实高度 (mm), 按名称猜
function _guessHeight(name) {
  const n = String(name || '');
  if (/床/.test(n)) return 450;
  if (/桌|案|几|台/.test(n)) return 750;
  if (/椅|凳/.test(n)) return 450;
  if (/柜|架|橱/.test(n)) return 1800;
  if (/冰箱|洗衣机/.test(n)) return 850;
  if (/沙发/.test(n)) return 700;
  return 400;
}

// ---- SVG: 建筑平面图标准 ----
function _buildSVG(spec) {
  const scale = 0.15; // 1mm = 0.15px
  const padL = 110, padT = 90, padR = 90, padB = 90;
  const wallT = (spec.wall_thickness || 200) * scale; // 默认 200mm 墙
  let maxX = 0, maxY = 0;
  for (const r of [...(spec.rooms || []), ...(spec.items || [])]) {
    maxX = Math.max(maxX, (r.x || 0) + (r.w || 0));
    maxY = Math.max(maxY, (r.y || 0) + (r.d || 0));
  }
  const W = maxX * scale + padL + padR, H = maxY * scale + padT + padB;
  const X = v => padL + v * scale, Y = v => padT + v * scale;
  let s = `<?xml version="1.0" encoding="UTF-8"?>\n<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}" font-family="PingFang SC, Hiragino Sans GB, sans-serif">\n`;
  s += `<rect width="${W}" height="${H}" fill="#ffffff"/>\n`;
  // 标题栏
  s += `<text x="${padL}" y="40" font-size="20" font-weight="bold" fill="#1a1a1a">${_esc(spec.title || '平面图')}</text>\n`;
  s += `<text x="${padL}" y="62" font-size="11" fill="#888">比例 1:50 · 单位 mm · ${new Date().toISOString().slice(0, 10)} · Pangu draw_layout</text>\n`;

  // 房间: 墙体双线 + 面积标注
  for (const r of (spec.rooms || [])) {
    const rx = X(r.x || 0), ry = Y(r.y || 0), rw = (r.w || 0) * scale, rh = (r.d || 0) * scale;
    // 地板填充
    s += `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="${r.fill || '#f7f5f0'}"/>\n`;
    // 外墙 (粗)
    s += `<rect x="${rx - wallT / 2}" y="${ry - wallT / 2}" width="${rw + wallT}" height="${rh + wallT}" fill="none" stroke="#1a1a1a" stroke-width="${wallT}"/>\n`;
    // 内轮廓 (细, 出双线效果)
    s += `<rect x="${rx}" y="${ry}" width="${rw}" height="${rh}" fill="none" stroke="#1a1a1a" stroke-width="1"/>\n`;
    const area = (((r.w || 0) * (r.d || 0)) / 1e6).toFixed(1);
    if (r.name) {
      s += `<text x="${rx + rw / 2}" y="${ry + rh / 2 - 8}" font-size="16" font-weight="bold" text-anchor="middle" fill="#333">${_esc(r.name)}</text>\n`;
      s += `<text x="${rx + rw / 2}" y="${ry + rh / 2 + 12}" font-size="11" text-anchor="middle" fill="#999">${r.w}×${r.d} · ${area}㎡</text>\n`;
    }
  }

  // 家具: 圆角浅填充 + 名称
  for (const it of (spec.items || [])) {
    const ix = X(it.x || 0), iy = Y(it.y || 0), iw = (it.w || 0) * scale, ih = (it.d || 0) * scale;
    const cx = ix + iw / 2, cy = iy + ih / 2;
    s += `<rect x="${ix}" y="${iy}" width="${iw}" height="${ih}" fill="${it.color || '#dce6f0'}" stroke="#7a8a99" stroke-width="1" rx="6"/>\n`;
    if (it.name) {
      s += `<text x="${cx}" y="${cy - 2}" font-size="12" text-anchor="middle" dominant-baseline="middle" fill="#334455">${_esc(it.name)}</text>\n`;
      s += `<text x="${cx}" y="${cy + 13}" font-size="9" text-anchor="middle" fill="#8a97a5">${it.w}×${it.d}</text>\n`;
    }
  }

  // 文字标注 (带小圆点引线感)
  for (const n of (spec.notes || [])) {
    s += `<circle cx="${X(n.x || 0)}" cy="${Y(n.y || 0) - 4}" r="2.5" fill="${n.color || '#c0392b'}"/>\n`;
    s += `<text x="${X((n.x || 0) + 60)}" y="${Y(n.y || 0)}" font-size="12" fill="${n.color || '#c0392b'}">${_esc(n.text)}</text>\n`;
  }

  // 尺寸链: 顶部 (X 向) + 左侧 (Y 向) — 按房间边界取标注点
  const xCuts = [...new Set((spec.rooms || []).flatMap(r => [r.x || 0, (r.x || 0) + (r.w || 0)]))].sort((a, b) => a - b);
  const yCuts = [...new Set((spec.rooms || []).flatMap(r => [r.y || 0, (r.y || 0) + (r.d || 0)]))].sort((a, b) => a - b);
  const dimY = padT - 35, dimX = padL - 45;
  s += `<g stroke="#555" stroke-width="0.8" fill="#555" font-size="10">\n`;
  for (let i = 0; i < xCuts.length - 1; i++) {
    const x1 = X(xCuts[i]), x2 = X(xCuts[i + 1]);
    s += `<line x1="${x1}" y1="${dimY}" x2="${x2}" y2="${dimY}"/>`;
    s += `<line x1="${x1}" y1="${dimY - 4}" x2="${x1}" y2="${dimY + 4}"/><line x1="${x2}" y1="${dimY - 4}" x2="${x2}" y2="${dimY + 4}"/>`;
    s += `<line x1="${x1}" y1="${dimY + 4}" x2="${x1}" y2="${padT - 2}" stroke-dasharray="2,3" stroke="#bbb"/>`;
    s += `<text x="${(x1 + x2) / 2}" y="${dimY - 6}" text-anchor="middle" stroke="none">${xCuts[i + 1] - xCuts[i]}</text>\n`;
  }
  for (let i = 0; i < yCuts.length - 1; i++) {
    const y1 = Y(yCuts[i]), y2 = Y(yCuts[i + 1]);
    s += `<line x1="${dimX}" y1="${y1}" x2="${dimX}" y2="${y2}"/>`;
    s += `<line x1="${dimX - 4}" y1="${y1}" x2="${dimX + 4}" y2="${y1}"/><line x1="${dimX - 4}" y1="${y2}" x2="${dimX + 4}" y2="${y2}"/>`;
    s += `<line x1="${dimX + 4}" y1="${y1}" x2="${padL - 2}" y2="${y1}" stroke-dasharray="2,3" stroke="#bbb"/>`;
    s += `<text x="${dimX - 8}" y="${(y1 + y2) / 2}" text-anchor="middle" stroke="none" transform="rotate(-90 ${dimX - 8} ${(y1 + y2) / 2})">${yCuts[i + 1] - yCuts[i]}</text>\n`;
  }
  s += `</g>\n`;

  // 比例尺 (左下, 1000mm 一段)
  const sbY = H - 40, sbX = padL;
  s += `<g font-size="9" fill="#666"><rect x="${sbX}" y="${sbY}" width="${1000 * scale}" height="5" fill="#1a1a1a"/><rect x="${sbX + 1000 * scale}" y="${sbY}" width="${1000 * scale}" height="5" fill="none" stroke="#1a1a1a" stroke-width="1"/><text x="${sbX}" y="${sbY + 18}">0</text><text x="${sbX + 1000 * scale - 6}" y="${sbY + 18}">1m</text><text x="${sbX + 2000 * scale - 6}" y="${sbY + 18}">2m</text></g>\n`;

  // 指北针
  if (spec.compass) {
    s += `<g transform="translate(${W - 55},${padT - 10})"><circle r="22" fill="#fff" stroke="#1a1a1a" stroke-width="1.2"/><path d="M0,-17 L6,9 L0,4 L-6,9 Z" fill="#c0392b"/><text y="-27" font-size="12" font-weight="bold" text-anchor="middle" fill="#1a1a1a">N</text></g>\n`;
  }
  return s + '</svg>\n';
}

// ---- DXF: 极简 R12 (LINE + TEXT), LibreCAD/FreeCAD/AutoCAD 通吃 ----
function _buildDXF(spec) {
  let d = '0\nSECTION\n2\nENTITIES\n';
  const line = (x1, y1, x2, y2, layer) => {
    d += `0\nLINE\n8\n${layer}\n10\n${x1}\n20\n${-y1}\n30\n0\n11\n${x2}\n21\n${-y2}\n31\n0\n`;
  };
  const rect = (r, layer) => {
    const x = r.x || 0, y = r.y || 0, w = r.w || 0, h = r.d || 0;
    line(x, y, x + w, y, layer); line(x + w, y, x + w, y + h, layer);
    line(x + w, y + h, x, y + h, layer); line(x, y + h, x, y, layer);
  };
  const text = (x, y, h, str, layer) => {
    d += `0\nTEXT\n8\n${layer}\n10\n${x}\n20\n${-y}\n30\n0\n40\n${h}\n1\n${String(str).replace(/[\r\n]/g, ' ')}\n`;
  };
  const t = spec.wall_thickness || 200;
  for (const r of (spec.rooms || [])) {
    rect(r, 'WALL_IN');
    rect({ x: (r.x || 0) - t, y: (r.y || 0) - t, w: (r.w || 0) + 2 * t, d: (r.d || 0) + 2 * t }, 'WALL_OUT');
    if (r.name) {
      const area = (((r.w || 0) * (r.d || 0)) / 1e6).toFixed(1);
      text((r.x || 0) + (r.w || 0) / 2 - 300, (r.y || 0) + (r.d || 0) / 2, 150, `${r.name} ${r.w}x${r.d} ${area}m2`, 'ROOM_TEXT');
    }
  }
  for (const it of (spec.items || [])) {
    rect(it, 'FURNITURE');
    if (it.name) text((it.x || 0) + ((it.w || 0) / 2) - 150, (it.y || 0) + ((it.d || 0) / 2), 110, it.name, 'FURN_TEXT');
  }
  for (const n of (spec.notes || [])) text(n.x || 0, n.y || 0, 120, n.text, 'NOTE');
  return d + '0\nENDSEC\n0\nEOF\n';
}

// ---- FCSTD (best-effort): 真三维 — 墙体带厚度高 2800, 地板, 家具真实高度 ----
function _buildFcstdScript(spec, outPath) {
  const t = spec.wall_thickness || 200;
  const wallH = spec.wall_height || 2800;
  const emit = [];
  emit.push('import FreeCAD, Part');
  emit.push('doc = FreeCAD.newDocument("layout")');
  emit.push('def box(name, x, y, z, w, d, h):');
  emit.push('    b = doc.addObject("Part::Box", name[:28].replace(" ", "_") or "box")');
  emit.push('    b.Length, b.Width, b.Height = w, d, h');
  emit.push('    b.Placement.Base = FreeCAD.Vector(x, y, z)');
  emit.push('    return b');
  let i = 0;
  for (const r of (spec.rooms || [])) {
    i++;
    const nm = (_esc(r.name || ('room' + i))).replace(/"/g, '');
    const x = r.x || 0, y = r.y || 0, w = r.w || 0, dd = r.d || 0;
    // 地板
    emit.push(`box("floor_${nm}", ${x - t}, ${y - t}, -100, ${w + 2 * t}, ${dd + 2 * t}, 100)`);
    // 四面墙 (单独 box, 避免 cut 失败)
    emit.push(`box("wallN_${nm}", ${x - t}, ${y - t}, 0, ${w + 2 * t}, ${t}, ${wallH})`);
    emit.push(`box("wallS_${nm}", ${x - t}, ${y + dd}, 0, ${w + 2 * t}, ${t}, ${wallH})`);
    emit.push(`box("wallW_${nm}", ${x - t}, ${y}, 0, ${t}, ${dd}, ${wallH})`);
    emit.push(`box("wallE_${nm}", ${x + w}, ${y}, 0, ${t}, ${dd}, ${wallH})`);
  }
  for (const it of (spec.items || [])) {
    const nm = (_esc(it.name || 'item')).replace(/"/g, '');
    const h = it.h || _guessHeight(it.name);
    emit.push(`box("f_${nm}", ${it.x || 0}, ${it.y || 0}, 0, ${it.w || 0}, ${it.d || 0}, ${h})`);
  }
  emit.push('doc.recompute()');
  emit.push(`doc.saveAs(${JSON.stringify(outPath)})`);
  emit.push('print("FCSTD_OK")');
  return emit.join('\n') + '\n';
}

async function drawLayout(ctx) {
  const { params = {} } = ctx;
  // 2026-08-03 修 (老板实证: SVG 画布 1185 万 px — "出的什么东西"):
  // LLM 传字符串坐标 ("4900") → (r.x||0)+(r.w||0) 变字符串拼接 "4900"+"1200"="49001200"。
  // 所有数字参数入门前强制 Number(), 转不了的一律报清楚是哪个对象哪个字段。
  const _numFields = ['x', 'y', 'w', 'd', 'h'];
  const _coerce = (list, kind) => {
    for (let i = 0; i < list.length; i++) {
      for (const f of _numFields) {
        if (list[i][f] === undefined || list[i][f] === null) continue;
        const n = Number(list[i][f]);
        if (!Number.isFinite(n)) {
          return { err: `${kind}[${i}].${f} = ${JSON.stringify(list[i][f])} 不是数字` };
        }
        list[i][f] = n;
      }
    }
    return null;
  };
  const _c1 = _coerce(Array.isArray(params.rooms) ? params.rooms : [], 'rooms');
  if (_c1) return { ok: false, error: { code: 'BAD_COORD', message: _c1.err } };
  const _c2 = _coerce(Array.isArray(params.items) ? params.items : [], 'items');
  if (_c2) return { ok: false, error: { code: 'BAD_COORD', message: _c2.err } };
  const spec = {
    title: params.title || '平面图',
    wall_thickness: Number(params.wall_thickness) || 200,
    wall_height: Number(params.wall_height) || 2800,
    rooms: Array.isArray(params.rooms) ? params.rooms : [],
    items: Array.isArray(params.items) ? params.items : [],
    notes: Array.isArray(params.notes) ? params.notes : [],
    compass: params.compass !== false,
  };
  if (spec.rooms.length === 0 && spec.items.length === 0) {
    return { ok: false, error: { code: 'EMPTY_SPEC', message: 'rooms/items 至少给一个 (mm 单位, {name,x,y,w,d})' } };
  }
  const outDir = params.out_dir ? String(params.out_dir).replace(/^~/, os.homedir()) : path.join(os.homedir(), 'Desktop');
  const outName = String(params.out_name || 'layout').replace(/[\/\\]/g, '_');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (e) {
    return { ok: false, error: { code: 'MKDIR_FAIL', message: outDir + ': ' + e.message } };
  }

  const files = [];
  const errors = [];
  try {
    const p = path.join(outDir, outName + '.svg');
    fs.writeFileSync(p, _buildSVG(spec), 'utf8');
    files.push(p);
  } catch (e) { errors.push('svg: ' + e.message); }
  try {
    const p = path.join(outDir, outName + '.dxf');
    fs.writeFileSync(p, _buildDXF(spec), 'utf8');
    files.push(p);
  } catch (e) { errors.push('dxf: ' + e.message); }
  // FreeCAD 路径 —— 不写死 macOS 默认安装位置 (第 109 批):
  //   别的平台/别的安装位置用 PANGU_FREECAD_BIN 指过来, 指不到就当没装 (不报错, 只是少一个产物)。
  const freecadcmd = process.env.PANGU_FREECAD_BIN
    || '/Applications/FreeCAD.app/Contents/Resources/bin/freecadcmd';
  if (fs.existsSync(freecadcmd)) {
    try {
      const fcPath = path.join(outDir, outName + '.FCStd');
      const pyPath = path.join(os.tmpdir(), `pangu_draw_${Date.now()}.py`);
      fs.writeFileSync(pyPath, _buildFcstdScript(spec, fcPath), 'utf8');
      const { execFileSync } = require('child_process');
      const out = execFileSync(freecadcmd, [pyPath], { timeout: 120000, encoding: 'utf-8' });
      try { fs.unlinkSync(pyPath); } catch (_) {}
      if (out.includes('FCSTD_OK') && fs.existsSync(fcPath)) files.push(fcPath);
      else errors.push('fcstd: freecadcmd 未确认成功');
    } catch (e) { errors.push('fcstd: ' + String(e.message).slice(0, 120)); }
  } else {
    errors.push('fcstd: freecadcmd 不存在 (SVG/DXF 不受影响)');
  }

  // 反幻觉硬结构: 逐文件 statSync 验证, 只报验证过的
  const verified = [];
  for (const f of files) {
    try {
      const st = fs.statSync(f);
      if (st.size > 0) verified.push({ path: f, bytes: st.size, verified: true });
    } catch (_) {}
  }
  if (verified.length === 0) {
    return { ok: false, error: { code: 'ALL_WRITE_FAIL', message: '所有格式都写失败: ' + errors.join(' | ') } };
  }
  return {
    ok: true,
    data: {
      files: verified,
      partial_errors: errors.length ? errors : undefined,
      note: '以上每个文件都经过 fs.statSync 真实验证 (路径+字节数), 不是嘴炮。汇报时引用本列表, 不许加没验证的文件。'
    }
  };
}

module.exports = drawLayout;
