#!/usr/bin/env python3
"""
capture_frames.py — HTML → 帧图 + motion strip

战略定位: Pixel2Motion 5 步流程第 4 步 (QA 截帧)
输入:   HTML 字符串 + times_ms (截帧时间点) + output_dir
输出:   frame_paths (每帧 PNG) + strip_path (motion strip 拼接图)

依赖:
  - playwright (sync API): 用 chromium 渲染 HTML
  - Pillow: 帧拼接 + 时间标签

用法 (作为 module):
  from capture_frames import capture_frames
  result = capture_frames(html="...", times_ms=[0, 500, 1000], output_dir="/tmp/x")

用法 (CLI 自测 / MCP 包装调用):
  python3 capture_frames.py --json '<html_string>' '<times_json>' '<output_dir>' [width] [height]
  - times_json: JSON 数组字符串 (如 '[0,300,700,1000,1500]')
  - 输出: 单行 JSON

错误约定 (与 fit_svg.py / audit_svg 保持一致):
  成功: {"ok": true, "frame_paths": [...], "strip_path": "...", "capture_time_ms": ..., "total_frames": N}
  失败: {"ok": false, "error": "..."}

设计要点:
  1. Playwright headless chromium 渲染 HTML
  2. 写临时 HTML 文件到 output_dir/_capture.html, 用 file:// 加载
  3. 等到 document readyState === 'complete'
  4. 对每个 time_ms:
     - 用 page.evaluate("performance.now()") 算相对时间
     - 等到目标时间点 (短延时就 sleep, 长延时就等动画自然结束)
     - page.screenshot() 截 PNG
  5. Pillow 把帧水平拼接, 顶部加时间标签
"""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
import time
import traceback
from typing import List

# Pillow
try:
    from PIL import Image, ImageDraw, ImageFont
except ImportError:
    print(json.dumps({"ok": False, "error": "Pillow not installed. Run: pip3 install Pillow"}), file=sys.stdout)
    sys.exit(1)

# Playwright
try:
    from playwright.sync_api import sync_playwright
except ImportError:
    print(json.dumps({"ok": False, "error": "playwright not installed. Run: pip3 install playwright && python3 -m playwright install chromium"}), file=sys.stdout)
    sys.exit(1)


# ============================================================
# 常量
# ============================================================

DEFAULT_WIDTH = 800
DEFAULT_HEIGHT = 600
MIN_WIDTH = 16
MAX_WIDTH = 4096
MIN_HEIGHT = 16
MAX_HEIGHT = 4096
MAX_HTML_SIZE = 5 * 1024 * 1024   # 5MB
MAX_FRAMES = 20                    # 防滥用, 超过 20 帧拒绝
MAX_TIME_MS = 30_000               # 超过 30s 的截帧点拒绝
TEMP_HTML_NAME = "_capture.html"
LABEL_HEIGHT = 32                  # 拼接图顶部时间标签条高度
FRAME_PADDING = 8                  # 帧之间的间距
DEFAULT_BG = (255, 255, 255)       # 帧背景 fallback


# ============================================================
# 工具函数
# ============================================================

def is_nonempty_string(v) -> bool:
    return isinstance(v, str) and len(v) > 0


def abs_path(p: str) -> str:
    """确保返回绝对路径, 用 realpath 解析符号链接"""
    return os.path.realpath(os.path.abspath(p))


def try_load_default_font(size: int) -> ImageFont.ImageFont:
    """尝试加载默认字体, 失败时用 PIL 默认"""
    # macOS 系统字体路径 (按优先级)
    candidates = [
        "/System/Library/Fonts/Helvetica.ttc",
        "/System/Library/Fonts/SFNSMono.ttf",
        "/Library/Fonts/Arial.ttf",
        "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
        "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
    ]
    for path in candidates:
        if os.path.exists(path):
            try:
                return ImageFont.truetype(path, size)
            except Exception:
                continue
    return ImageFont.load_default()


# ============================================================
# 核心: capture_frames
# ============================================================

def capture_frames(
    html: str,
    times_ms: List[int],
    output_dir: str,
    width: int = DEFAULT_WIDTH,
    height: int = DEFAULT_HEIGHT,
) -> dict:
    """
    截帧核心逻辑.

    Args:
        html: 完整 HTML 字符串 (含 <svg> + CSS @keyframes)
        times_ms: 截帧时间点 (毫秒), 列表, 每个 >= 0
        output_dir: 输出目录 (绝对路径, 不存在则创建)
        width: 视窗宽度 (像素)
        height: 视窗高度 (像素)

    Returns:
        { ok, frame_paths, strip_path, capture_time_ms, total_frames, error? }
    """
    start = time.time()

    # ---- 1. 校验 ----
    if not is_nonempty_string(html):
        return {"ok": False, "error": "html must be a non-empty string"}
    if len(html) > MAX_HTML_SIZE:
        return {"ok": False, "error": f"html too large (>{MAX_HTML_SIZE} bytes)"}
    # 简单 HTML 包含检查
    if not (html.lstrip().lower().startswith("<!doctype") or
            html.lstrip().lower().startswith("<html") or
            "<html" in html[:200].lower() or
            "<body" in html[:200].lower() or
            "<div" in html[:500].lower()):
        return {"ok": False, "error": "html does not look like valid HTML (missing <html>/<body>/<div>)"}

    if not isinstance(times_ms, list) or len(times_ms) == 0:
        return {"ok": False, "error": "times_ms must be a non-empty array"}
    if len(times_ms) > MAX_FRAMES:
        return {"ok": False, "error": f"too many frames ({len(times_ms)} > {MAX_FRAMES})"}
    for i, t in enumerate(times_ms):
        if not isinstance(t, (int, float)) or t < 0:
            return {"ok": False, "error": f"times_ms[{i}] must be a non-negative number, got: {t}"}
        if t > MAX_TIME_MS:
            return {"ok": False, "error": f"times_ms[{i}]={t} exceeds {MAX_TIME_MS}ms limit"}

    if not is_nonempty_string(output_dir):
        return {"ok": False, "error": "output_dir must be a non-empty string"}

    # 视窗尺寸校验
    width = int(width) if isinstance(width, (int, float)) else DEFAULT_WIDTH
    height = int(height) if isinstance(height, (int, float)) else DEFAULT_HEIGHT
    if not (MIN_WIDTH <= width <= MAX_WIDTH):
        return {"ok": False, "error": f"width must be in [{MIN_WIDTH}, {MAX_WIDTH}], got: {width}"}
    if not (MIN_HEIGHT <= height <= MAX_HEIGHT):
        return {"ok": False, "error": f"height must be in [{MIN_HEIGHT}, {MAX_HEIGHT}], got: {height}"}

    # 输出目录
    output_dir_abs = abs_path(output_dir)
    try:
        os.makedirs(output_dir_abs, exist_ok=True)
        # 写权限测试
        test_file = os.path.join(output_dir_abs, ".write_test")
        with open(test_file, "w") as f:
            f.write("ok")
        os.remove(test_file)
    except PermissionError:
        return {"ok": False, "error": f"no write permission for output_dir: {output_dir_abs}"}
    except Exception as e:
        return {"ok": False, "error": f"failed to create output_dir: {e}"}

    # times_ms 排序 (不影响输出顺序, 但方便后续等待逻辑)
    indexed_times = list(enumerate(times_ms))  # [(orig_idx, ms), ...]

    # ---- 2. 写临时 HTML ----
    temp_html_path = os.path.join(output_dir_abs, TEMP_HTML_NAME)
    try:
        with open(temp_html_path, "w", encoding="utf-8") as f:
            f.write(html)
    except Exception as e:
        return {"ok": False, "error": f"failed to write temp HTML: {e}"}

    # ---- 3. Playwright 截帧 ----
    frame_paths: List[str] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(headless=True)
            try:
                context = browser.new_context(
                    viewport={"width": width, "height": height},
                    device_scale_factor=1,
                )
                page = context.new_page()

                # 加载 HTML
                page.goto("file://" + temp_html_path, wait_until="load", timeout=15000)
                # 等到 DOM 完全就绪 (包含动画启动)
                page.wait_for_function("document.readyState === 'complete'", timeout=5000)

                # 记录导航完成时间 (相对基准)
                nav_done_ms = page.evaluate("performance.now()")

                # 对每个时间点截帧
                for orig_idx, t_ms in indexed_times:
                    target_ms = nav_done_ms + t_ms
                    # 用 page.wait_for_function 等到 performance.now() >= target_ms
                    # 超时 30s 兜底
                    try:
                        page.wait_for_function(
                            f"performance.now() >= {target_ms}",
                            timeout=max(5000, int(t_ms) + 5000),
                        )
                    except Exception:
                        # 截帧点可能超过动画时长, 继续截 (用最终态)
                        pass

                    # 截屏
                    frame_filename = f"frame_{orig_idx:03d}_{int(t_ms):05d}ms.png"
                    frame_path = os.path.join(output_dir_abs, frame_filename)
                    page.screenshot(path=frame_path, full_page=False, omit_background=False)
                    frame_paths.append(abs_path(frame_path))

                context.close()
            finally:
                browser.close()
    except Exception as e:
        tb = traceback.format_exc()
        # 清理临时 HTML (失败也保留供调试? 简化: 失败也清理)
        try:
            if os.path.exists(temp_html_path):
                os.remove(temp_html_path)
        except Exception:
            pass
        return {"ok": False, "error": f"playwright error: {e}\n{tb[:500]}"}

    # ---- 4. 清理临时 HTML ----
    try:
        if os.path.exists(temp_html_path):
            os.remove(temp_html_path)
    except Exception:
        pass

    # ---- 5. Pillow 拼 motion strip ----
    strip_path = ""
    try:
        strip_path = build_motion_strip(frame_paths, times_ms, output_dir_abs)
    except Exception as e:
        tb = traceback.format_exc()
        # 拼接失败不算致命 (帧已生成), 但要返回错误
        return {
            "ok": False,
            "error": f"motion strip build failed: {e}\n{tb[:500]}",
            "frame_paths": frame_paths,  # 帧已经生成
            "capture_time_ms": int((time.time() - start) * 1000),
            "total_frames": len(frame_paths),
        }

    # ---- 6. 成功 ----
    return {
        "ok": True,
        "frame_paths": frame_paths,
        "strip_path": strip_path,
        "capture_time_ms": int((time.time() - start) * 1000),
        "total_frames": len(frame_paths),
    }


def build_motion_strip(frame_paths: List[str], times_ms: List[int], output_dir: str) -> str:
    """
    把所有帧水平拼接成 1 张 motion_strip.png
    - 顶部 LABEL_HEIGHT 黑色条, 写时间标签 (如 "0ms", "500ms")
    - 帧之间 FRAME_PADDING 间距 (白色)
    - 输出: {output_dir}/motion_strip.png
    """
    if not frame_paths:
        raise ValueError("no frames to strip")

    # 加载所有帧
    images = []
    for p in frame_paths:
        img = Image.open(p).convert("RGB")
        images.append(img)

    # 假设所有帧尺寸一致 (Playwright 视窗固定)
    fw, fh = images[0].size
    # 兜底: 尺寸不一致时统一缩放到第一帧
    for i in range(1, len(images)):
        if images[i].size != (fw, fh):
            images[i] = images[i].resize((fw, fh), Image.LANCZOS)

    total_w = fw * len(images) + FRAME_PADDING * (len(images) - 1)
    total_h = LABEL_HEIGHT + fh

    # 创建白底画布
    canvas = Image.new("RGB", (total_w, total_h), (255, 255, 255))

    # 顶部时间标签 (黑色条 + 白色字)
    label_strip = Image.new("RGB", (total_w, LABEL_HEIGHT), (0, 0, 0))
    draw = ImageDraw.Draw(label_strip)
    font = try_load_default_font(14)

    # 把帧贴上去
    for i, img in enumerate(images):
        x = i * (fw + FRAME_PADDING)
        canvas.paste(label_strip if i == 0 else Image.new("RGB", (fw, LABEL_HEIGHT), (0, 0, 0)),
                     (x, 0))
        canvas.paste(img, (x, LABEL_HEIGHT))

    # 重新画标签 (避免每段画一遍)
    draw_final = ImageDraw.Draw(canvas)
    for i, t_ms in enumerate(times_ms):
        x = i * (fw + FRAME_PADDING)
        label = f"{int(t_ms)}ms"
        # 居中
        bbox = draw_final.textbbox((0, 0), label, font=font)
        text_w = bbox[2] - bbox[0]
        text_h = bbox[3] - bbox[1]
        tx = x + (fw - text_w) // 2
        ty = (LABEL_HEIGHT - text_h) // 2 - bbox[1]
        draw_final.text((tx, ty), label, fill=(255, 255, 255), font=font)

    strip_path = os.path.join(output_dir, "motion_strip.png")
    canvas.save(strip_path, "PNG")
    return abs_path(strip_path)


# ============================================================
# CLI 入口
# ============================================================

def main():
    parser = argparse.ArgumentParser(description="capture_frames: HTML → 帧图 + motion strip")
    parser.add_argument("--json", action="store_true", help="CLI 模式: 解析位置参数, 输出单行 JSON")
    parser.add_argument("html_or_htmlfile", nargs="?", help="(CLI --json 模式) HTML 字符串 或 HTML 文件路径 (以 @ 开头)")
    parser.add_argument("times_json", nargs="?", help="(CLI --json 模式) times_ms JSON 数组字符串")
    parser.add_argument("output_dir", nargs="?", help="(CLI --json 模式) 输出目录")
    parser.add_argument("width", nargs="?", help="(CLI --json 模式) 视窗宽度")
    parser.add_argument("height", nargs="?", help="(CLI --json 模式) 视窗高度")
    args = parser.parse_args()

    if args.json:
        # CLI 模式: 解析位置参数
        html_arg = args.html_or_htmlfile or ""
        if html_arg.startswith("@"):
            # 文件路径
            html_path = html_arg[1:]
            try:
                with open(html_path, "r", encoding="utf-8") as f:
                    html = f.read()
            except Exception as e:
                print(json.dumps({"ok": False, "error": f"failed to read html file {html_path}: {e}"}))
                sys.exit(1)
        else:
            html = html_arg

        try:
            times_ms = json.loads(args.times_json or "[]")
            if not isinstance(times_ms, list):
                raise ValueError("times_json must be a JSON array")
        except Exception as e:
            print(json.dumps({"ok": False, "error": f"failed to parse times_json: {e}"}))
            sys.exit(1)

        output_dir = args.output_dir or ""
        width = int(args.width) if args.width else DEFAULT_WIDTH
        height = int(args.height) if args.height else DEFAULT_HEIGHT

        result = capture_frames(html, times_ms, output_dir, width, height)
        print(json.dumps(result, ensure_ascii=False))
        sys.exit(0 if result.get("ok") else 1)
    else:
        parser.print_help()
        sys.exit(1)


if __name__ == "__main__":
    main()
