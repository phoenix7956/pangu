#!/usr/bin/env python3
"""
fit_svg.py — Pixel2Motion Step 1 (像素 logo PNG/JPG → SVG 拟合)

简化版:
- 读图 (PIL)
- 缩小到 max_size
- 颜色量化 (median cut)
- 边缘检测 / 连通区域分析
- 检测 3 种基本形状: 圆 / 矩形 / 三角形
- 输出 SVG 用 <circle> / <rect> / <polygon> 元素 (不用 <path d="...">)

CLI:
  python3 fit_svg.py <input.png|jpg|webp> <output.svg> [max_size] [detail_level]

  detail_level: low | mid | high  (默认 mid)
  - low  : 3 colors, 忽略 < 30px 区域
  - mid  : 6 colors, 忽略 < 20px 区域
  - high : 10 colors, 忽略 < 10px 区域

JSON 输出模式 (给 Node 包装调用):
  python3 fit_svg.py --json <input.png> [max_size] [detail_level]
  → stdout 打 {"ok": true, "svg": ..., ...} 或 {"ok": false, "error": ...}

依赖: pillow, numpy (Mac 自带或 pip install)
"""

import sys
import os
import json
import time
from collections import deque

try:
    import numpy as np
    from PIL import Image, ImageFilter
except ImportError as e:
    sys.stderr.write(f"fit_svg.py: missing dependency: {e}\n")
    sys.stderr.write("run: pip3 install pillow numpy\n")
    sys.exit(2)


# ============================================================
# 常量
# ============================================================

DETAIL_PARAMS = {
    "low":  {"num_colors": 3,  "min_region_px": 30, "max_shapes": 20},
    "mid":  {"num_colors": 6,  "min_region_px": 20, "max_shapes": 40},
    "high": {"num_colors": 10, "min_region_px": 10, "max_shapes": 80},
}

SUPPORTED_EXT = {".png", ".jpg", ".jpeg", ".webp", ".bmp", ".gif"}


# ============================================================
# 颜色辅助
# ============================================================

def rgb_to_hex(rgb):
    """rgb tuple (r,g,b) -> '#rrggbb'"""
    r, g, b = [int(c) for c in rgb[:3]]
    return "#{:02x}{:02x}{:02x}".format(max(0, min(255, r)),
                                        max(0, min(255, g)),
                                        max(0, min(255, b)))


def is_background_like(rgb, threshold=240):
    """判断是不是接近白色/透明的背景色"""
    r, g, b = rgb[:3]
    return r >= threshold and g >= threshold and b >= threshold


# ============================================================
# 形状检测 (简化版)
# ============================================================

def find_connected_components(mask):
    """
    4-邻接连通区域标记
    mask: 2D bool/int array
    返回: labels (HxW int array), num_components
    """
    h, w = mask.shape
    labels = np.zeros((h, w), dtype=np.int32)
    next_label = 0
    # BFS
    for sy in range(h):
        for sx in range(w):
            if mask[sy, sx] and labels[sy, sx] == 0:
                next_label += 1
                q = deque([(sy, sx)])
                labels[sy, sx] = next_label
                while q:
                    y, x = q.popleft()
                    for dy, dx in ((-1, 0), (1, 0), (0, -1), (0, 1)):
                        ny, nx = y + dy, x + dx
                        if 0 <= ny < h and 0 <= nx < w and mask[ny, nx] and labels[ny, nx] == 0:
                            labels[ny, nx] = next_label
                            q.append((ny, nx))
    return labels, next_label


def classify_shape(pixel_mask):
    """
    给定一个形状的像素 mask (2D bool array), 判断是 圆 / 矩形 / 三角形
    返回: ("circle", {cx, cy, r, fill_ratio})
          | ("rect", {x, y, w, h, fill_ratio})
          | ("triangle", {points: [(x1,y1), (x2,y2), (x3,y3)], fill_ratio})
          | ("skip", reason)

    简化启发式:
    - fill_ratio = pixel_count / bbox_area
    - aspect = w / h
    - roundness = 1 - (std(dist_to_centroid) / mean(dist_to_centroid))
    """
    ys, xs = np.where(pixel_mask)
    if len(ys) == 0:
        return ("skip", "empty")

    pixel_count = len(ys)
    min_y, max_y = int(ys.min()), int(ys.max())
    min_x, max_x = int(xs.min()), int(xs.max())
    bbox_h = max_y - min_y + 1
    bbox_w = max_x - min_x + 1
    bbox_area = bbox_w * bbox_h
    fill_ratio = pixel_count / max(1, bbox_area)

    cx = float(xs.mean())
    cy = float(ys.mean())

    # 关键修正: roundness 只看边界像素距离 — 填充圆内部像素会让距离分布偏斜
    # 边界像素距离对圆 → 全部 = R, std = 0, roundness = 1.0
    # 对矩形 → 边界距离变化大, roundness ~ 0.6
    h, w = pixel_mask.shape
    pad = np.pad(pixel_mask, 1, mode="constant", constant_values=False)
    is_boundary = pixel_mask & ~(pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:])
    bys, bxs = np.where(is_boundary)
    if len(bys) > 0:
        bdists = np.sqrt((bxs - cx) ** 2 + (bys - cy) ** 2)
        bmean = float(bdists.mean())
        if bmean > 0:
            roundness = 1.0 - (float(bdists.std()) / bmean)
        else:
            roundness = 0.0
        roundness = max(0.0, min(1.0, roundness))
        mean_d = bmean  # 用边界平均距离作为半径
    else:
        roundness = 0.0
        dists = np.sqrt((xs - cx) ** 2 + (ys - cy) ** 2)
        mean_d = float(dists.mean())

    aspect = bbox_w / max(1, bbox_h)
    is_squareish = 0.50 <= aspect <= 2.0  # 宽容以处理不完美缩放

    # 主判据: fill_ratio
    # - 完美圆 fill = π/4 ≈ 0.785 (中心填充图)
    # - 完美矩形 fill ≈ 1.0
    # - 完美三角形 fill ≈ 0.5
    # AA 让圆 fill 降到 ~0.74, 矩形 ~0.97, 三角形 ~0.40
    if fill_ratio >= 0.90:
        # 接近 1.0 = 几乎填满 bbox → 矩形
        return ("rect", {"x": min_x, "y": min_y, "w": bbox_w, "h": bbox_h, "fill_ratio": fill_ratio})

    if 0.55 <= fill_ratio <= 0.88 and is_squareish:
        # fill ~ π/4 → 圆
        r = max(1.0, mean_d)
        return ("circle", {"cx": cx, "cy": cy, "r": r, "fill_ratio": fill_ratio})

    # 三角形: 找 3 个边界顶点

    # 三角形: 找 3 个边界顶点
    # 简单策略: 找相对质心角度均匀分布的 3 个最远点 (按 0°, 120°, 240° 取最远点)
    # boundary pixels: mask 边界 (有 0 邻居的 True 像素)
    h, w = pixel_mask.shape
    pad = np.pad(pixel_mask, 1, mode="constant", constant_values=False)
    is_boundary = pixel_mask & ~(pad[:-2, 1:-1] & pad[2:, 1:-1] & pad[1:-1, :-2] & pad[1:-1, 2:])
    bys, bxs = np.where(is_boundary)
    if len(bys) < 3:
        # 退化: 当矩形
        return ("rect", {"x": min_x, "y": min_y, "w": bbox_w, "h": bbox_h, "fill_ratio": fill_ratio})

    # 角度
    angles = np.arctan2(bys - cy, bxs - cx)
    dists_b = np.sqrt((bxs - cx) ** 2 + (bys - cy) ** 2)

    # 三个候选角度
    target_angles = [0.0, 2 * np.pi / 3, 4 * np.pi / 3]
    points = []
    used_angles = set()
    for ta in target_angles:
        # 找在 ta ± 60° 范围内最远的点
        diffs = np.abs(np.arctan2(np.sin(angles - ta), np.cos(angles - ta)))
        in_range = diffs <= np.pi / 3
        if not in_range.any():
            in_range = np.ones(len(angles), dtype=bool)
        candidates = np.where(in_range)[0]
        if len(candidates) == 0:
            continue
        # 取最远点
        best = candidates[dists_b[candidates].argmax()]
        # 去重 (角度太近)
        pa = angles[best]
        too_close = False
        for ua in used_angles:
            d = np.abs(np.arctan2(np.sin(pa - ua), np.cos(pa - ua)))
            if d < np.pi / 6:
                too_close = True
                break
        if too_close:
            continue
        used_angles.add(float(pa))
        points.append((float(bxs[best]), float(bys[best])))

    if len(points) < 3:
        return ("rect", {"x": min_x, "y": min_y, "w": bbox_w, "h": bbox_h, "fill_ratio": fill_ratio})

    # 取前 3 个
    return ("triangle", {"points": points[:3], "fill_ratio": fill_ratio})


# ============================================================
# 形状 → SVG 元素
# ============================================================

def shape_to_svg(shape_type, shape_data, color_hex):
    if shape_type == "circle":
        return f'  <circle cx="{shape_data["cx"]:.1f}" cy="{shape_data["cy"]:.1f}" r="{shape_data["r"]:.1f}" fill="{color_hex}"/>'
    if shape_type == "rect":
        return f'  <rect x="{shape_data["x"]}" y="{shape_data["y"]}" width="{shape_data["w"]}" height="{shape_data["h"]}" fill="{color_hex}"/>'
    if shape_type == "triangle":
        pts = " ".join(f"{x:.1f},{y:.1f}" for x, y in shape_data["points"])
        return f'  <polygon points="{pts}" fill="{color_hex}"/>'
    return None


# ============================================================
# 主流程
# ============================================================

def fit_svg(image_path, max_size=200, detail_level="mid"):
    """
    主入口
    返回: dict { ok, svg?, width?, height?, shapes_detected?, fit_quality?, error?, render_time_ms? }
    """
    start = time.time()

    # 1. 校验文件
    if not os.path.isfile(image_path):
        return {"ok": False, "error": f"image not found: {image_path}", "render_time_ms": int((time.time() - start) * 1000)}
    ext = os.path.splitext(image_path)[1].lower()
    if ext not in SUPPORTED_EXT:
        return {"ok": False, "error": f"unsupported format: {ext} (supported: {sorted(SUPPORTED_EXT)})", "render_time_ms": int((time.time() - start) * 1000)}

    if detail_level not in DETAIL_PARAMS:
        return {"ok": False, "error": f"detail_level must be one of {list(DETAIL_PARAMS.keys())}, got: {detail_level}", "render_time_ms": int((time.time() - start) * 1000)}

    params = DETAIL_PARAMS[detail_level]
    num_colors = params["num_colors"]
    min_region_px = params["min_region_px"]
    max_shapes = params["max_shapes"]

    # 2. 读图
    try:
        img = Image.open(image_path)
        # 统一 RGBA / RGB
        if img.mode in ("RGBA", "LA"):
            # 合成到白底
            bg = Image.new("RGB", img.size, (255, 255, 255))
            bg.paste(img, mask=img.split()[-1])
            img = bg
        elif img.mode != "RGB":
            img = img.convert("RGB")
    except Exception as e:
        return {"ok": False, "error": f"failed to open image: {e}", "render_time_ms": int((time.time() - start) * 1000)}

    orig_w, orig_h = img.size

    # 3. 缩小
    scale = min(max_size / orig_w, max_size / orig_h, 1.0)
    new_w = max(1, int(orig_w * scale))
    new_h = max(1, int(orig_h * scale))
    if (new_w, new_h) != (orig_w, orig_h):
        img = img.resize((new_w, new_h), Image.LANCZOS)

    # 4. 颜色量化
    # 先做 median cut, 然后把原图 map 到调色板
    quantized = img.quantize(colors=num_colors, method=Image.Quantize.MEDIANCUT)
    palette = quantized.getpalette()  # 768 ints (256 * 3)
    # 找非背景调色板
    counts = quantized.getcolors()  # [(count, idx), ...]
    if not counts:
        return {"ok": False, "error": "image has no pixels (empty?)", "render_time_ms": int((time.time() - start) * 1000)}

    # 按 count 降序, 跳过背景色 (前 1 个常常是白色)
    counts_sorted = sorted(counts, key=lambda c: -c[0])

    # 取调色板项 + 颜色
    palette_colors = []  # [(idx, rgb, count)]
    for cnt, idx in counts_sorted:
        rgb = tuple(palette[idx * 3:idx * 3 + 3])
        if is_background_like(rgb, threshold=235):
            # 背景跳过
            continue
        palette_colors.append((idx, rgb, cnt))
        if len(palette_colors) >= num_colors:
            break

    if not palette_colors:
        # 全是背景 → 返回一个透明 SVG
        svg = (
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {new_w} {new_h}" '
            f'width="{new_w}" height="{new_h}">\n'
            f'  <rect width="{new_w}" height="{new_h}" fill="#ffffff"/>\n'
            f'</svg>'
        )
        return {
            "ok": True,
            "svg": svg,
            "width": new_w,
            "height": new_h,
            "shapes_detected": 0,
            "fit_quality": 1.0,
            "render_time_ms": int((time.time() - start) * 1000),
        }

    arr = np.array(quantized)  # H x W, 值是调色板 idx

    # 5. 对每个调色板颜色, 找连通区域 + 分类
    svg_elements = []
    shapes_detected = 0
    total_fill_ratio = 0.0

    for idx, rgb, cnt in palette_colors:
        mask = (arr == idx)
        labels, n = find_connected_components(mask)
        for comp_id in range(1, n + 1):
            if shapes_detected >= max_shapes:
                break
            comp_mask = (labels == comp_id)
            comp_count = int(comp_mask.sum())
            if comp_count < min_region_px:
                continue
            shape_type, shape_data = classify_shape(comp_mask)
            if shape_type == "skip":
                continue
            svg_str = shape_to_svg(shape_type, shape_data, rgb_to_hex(rgb))
            if svg_str is None:
                continue
            svg_elements.append(svg_str)
            shapes_detected += 1
            total_fill_ratio += shape_data.get("fill_ratio", 0.0)
        if shapes_detected >= max_shapes:
            break

    # 6. 构造 SVG (按 z-order: 后画的在前; 当前顺序 = 从大到小, 视觉合理)
    fit_quality = (total_fill_ratio / max(1, shapes_detected)) if shapes_detected > 0 else 0.0

    svg_lines = [
        f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {new_w} {new_h}" '
        f'width="{new_w}" height="{new_h}">',
    ]
    # 加背景白底 (可选)
    # svg_lines.append(f'  <rect width="{new_w}" height="{new_h}" fill="#ffffff"/>')
    svg_lines.extend(svg_elements)
    svg_lines.append('</svg>')
    svg = "\n".join(svg_lines)

    return {
        "ok": True,
        "svg": svg,
        "width": new_w,
        "height": new_h,
        "shapes_detected": shapes_detected,
        "fit_quality": round(fit_quality, 3),
        "render_time_ms": int((time.time() - start) * 1000),
    }


# ============================================================
# CLI
# ============================================================

def main():
    args = sys.argv[1:]
    json_mode = False
    if "--json" in args:
        json_mode = True
        args.remove("--json")

    if len(args) < 1:
        sys.stderr.write("usage: fit_svg.py [--json] <input.png> [max_size] [detail_level]\n")
        sys.exit(1)

    image_path = args[0]
    max_size = int(args[1]) if len(args) >= 2 else 200
    detail_level = args[2] if len(args) >= 3 else "mid"

    result = fit_svg(image_path, max_size=max_size, detail_level=detail_level)

    if json_mode:
        # 单行 JSON 模式 (给 Node wrapper)
        sys.stdout.write(json.dumps(result, ensure_ascii=False))
        sys.stdout.write("\n")
        sys.exit(0 if result.get("ok") else 1)
    else:
        # 文件输出模式 (CLI 自测)
        if not result.get("ok"):
            sys.stderr.write(f"fit_svg error: {result.get('error')}\n")
            sys.exit(1)
        out_path = args[1] if len(args) >= 2 and not str(args[1]).isdigit() else None
        # 如果第 2 个参数是数字 (max_size), 输出到 stdout
        if len(args) >= 2 and str(args[1]).isdigit():
            sys.stdout.write(result["svg"])
        elif out_path:
            with open(out_path, "w") as f:
                f.write(result["svg"])
            sys.stderr.write(
                f"wrote {out_path}: {result['width']}x{result['height']}, "
                f"{result['shapes_detected']} shapes, "
                f"fit_quality={result['fit_quality']}, "
                f"{result['render_time_ms']}ms\n"
            )
        else:
            sys.stdout.write(result["svg"])
        sys.exit(0)


if __name__ == "__main__":
    main()
