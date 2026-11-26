"""
ComfyUI 辅助调用脚本 - 盘古 Pangu + 本地 ComfyUI

默认假设 ComfyUI 跑在 http://127.0.0.1:8000,client_id 走 pangu。
输出目录默认 $COMFYUI_OUTPUT_ROOT/<YYYY-MM-DD>/ (可用环境变量覆盖)。

输出契约(2026-07-30 改,防 base64 进 context):
  - stdout  永远只输出 `file://...` 路径,每行一张图。调用方直接粘给用户即可。
  - stderr  进度日志(`[comfyui] ...`)、调试信息,调用方必须忽略(2>/dev/null)。
  - sidecar 完整 metadata 写到 `--sidecar` 指定的 JSON 文件,默认 /tmp/pangu-comfyui/<ts>.json。
  - --quiet 关闭所有 stderr 进度(留给自动化流水线用)。

调用方铁律:helper 返回后,禁止把图当消息再发。只贴 file:// 路径。

用法:
    python3 comfyui_helper.py "<prompt>" [--model NAME] [--steps N] [--cfg F]
                               [--w W] [--h H] [--seed S] [--negative T]
                               [--prefix PREFIX] [--out DIR]
                               [--sidecar PATH] [--quiet]

示例:
    python3 comfyui_helper.py "a cat on a windowsill, soft light"
    python3 comfyui_helper.py "1girl, white dress" --model animagineXLV3_v30 --steps 28 --w 832 --h 1216
    python3 comfyui_helper.py "studio photo of a red apple" --model sd_xl_turbo_1.0_fp16 --steps 4 --cfg 1.0
"""

import argparse, json, os, sys, time, urllib.request, urllib.error, urllib.parse
from datetime import date

BASE = "http://127.0.0.1:8188"
CLIENT_ID = "pangu"
# 2026-10-30: 输出根默认值从 ~/ComfyUI_Output 改成
#   ~/Desktop/workspace/ComfyUI_Output —— 前者跟 AGENTS.md §6 规定的
#   「ComfyUI 输出落点」不一致, 也不跟 ComfyUI 服务端的 --output-directory
#   (同一个根) 对齐 ⇒ 产物散在两处。
#   仍可用 COMFYUI_OUTPUT_ROOT 环境变量覆盖 (pangu 的 launchd plist 已设)。
_DEFAULT_OUTPUT_ROOT = os.path.join(
    os.path.expanduser("~"), "Desktop", "workspace", "ComfyUI_Output"
)
DEFAULT_OUT = os.path.join(
    os.environ.get("COMFYUI_OUTPUT_ROOT", _DEFAULT_OUTPUT_ROOT),
    date.today().isoformat(),
)

_QUIET = {"on": False}

def log(*a, **kw):
    """状态/进度日志,走 stderr。调用方 2>/dev/null 屏蔽。"""
    if _QUIET["on"]:
        return
    print(*a, file=sys.stderr, **kw)

MODEL_DEFAULTS = {
    "sd_xl_turbo_1.0_fp16": {"steps": 4, "cfg": 1.0, "scheduler": "sgm_uniform"},
    "animagineXLV3_v30": {"steps": 28, "cfg": 7.0, "scheduler": "karras"},
    "animagine_xl_4.0_opt": {"steps": 28, "cfg": 7.0, "scheduler": "karras"},
    "juggernautXL_v8Rundiffusion": {"steps": 30, "cfg": 7.0, "scheduler": "karras"},
    "sd_xl_base_1.0": {"steps": 30, "cfg": 7.0, "scheduler": "karras"},
    "AbsoluteReality_v1.8.1": {"steps": 25, "cfg": 7.0, "scheduler": "karras"},
    "Counterfeit-V2.5": {"steps": 25, "cfg": 7.0, "scheduler": "karras"},
    "v1-5-pruned": {"steps": 25, "cfg": 7.0, "scheduler": "karras"},
}

DEFAULT_NEG = ("lowres, bad anatomy, bad hands, text, error, "
               "missing fingers, extra digit, fewer digits, "
               "cropped, worst quality, low quality, jpeg artifacts, "
               "signature, watermark, username, blurry")


def build_workflow(prompt, negative, model, steps, cfg, w, h, seed, scheduler, prefix):
    if not model.endswith(".safetensors"):
        model = f"{model}.safetensors"
    return {
        "1": {"class_type": "CheckpointLoaderSimple", "inputs": {"ckpt_name": model}},
        "2": {"class_type": "CLIPTextEncode", "inputs": {"text": prompt, "clip": ["1", 1]}},
        "3": {"class_type": "CLIPTextEncode", "inputs": {"text": negative, "clip": ["1", 1]}},
        "4": {"class_type": "EmptyLatentImage", "inputs": {"width": w, "height": h, "batch_size": 1}},
        "5": {"class_type": "KSampler", "inputs": {
            "seed": seed, "steps": steps, "cfg": cfg,
            "sampler_name": "euler", "scheduler": scheduler, "denoise": 1.0,
            "model": ["1", 0], "positive": ["2", 0], "negative": ["3", 0], "latent_image": ["4", 0],
        }},
        "6": {"class_type": "VAEDecode", "inputs": {"samples": ["5", 0], "vae": ["1", 2]}},
        "7": {"class_type": "SaveImage", "inputs": {"filename_prefix": prefix, "images": ["6", 0]}},
    }


def submit(workflow, base):
    payload = json.dumps({"prompt": workflow, "client_id": CLIENT_ID}).encode()
    req = urllib.request.Request(f"{base}/prompt", data=payload,
                                 headers={"Content-Type": "application/json"})
    try:
        r = json.loads(urllib.request.urlopen(req, timeout=30).read())
    except urllib.error.HTTPError as e:
        body = e.read().decode("utf-8", "replace")
        raise RuntimeError(f"ComfyUI /prompt {e.code}: {body}") from e
    if "prompt_id" not in r:
        raise RuntimeError(f"ComfyUI 返回无 prompt_id: {r}")
    return r["prompt_id"]


def wait(prompt_id, timeout_s=300, base=BASE):
    deadline = time.time() + timeout_s
    last_err = None
    while time.time() < deadline:
        time.sleep(2)
        try:
            hist = json.loads(urllib.request.urlopen(f"{base}/history/{prompt_id}", timeout=10).read())
            if prompt_id in hist:
                return hist[prompt_id]
        except Exception as e:
            last_err = e
            continue
    raise TimeoutError(f"Prompt {prompt_id} 未在 {timeout_s}s 内完成 (last_err={last_err})")


def download_images(history, out_dir, base=BASE):
    os.makedirs(out_dir, exist_ok=True)
    saved = []
    for node_id, node_out in history.get("outputs", {}).items():
        for img in node_out.get("images", []):
            fn = img["filename"]
            sub = img.get("subfolder", "")
            params = f"filename={urllib.parse.quote(fn)}&type=output"
            if sub:
                params += f"&subfolder={urllib.parse.quote(sub)}"
            url = f"{base}/view?{params}"
            dst = os.path.join(out_dir, fn)
            urllib.request.urlretrieve(url, dst)
            saved.append(dst)
    return saved


def main():
    ap = argparse.ArgumentParser(description="ComfyUI 文本生图 (Pangu 内置)")
    ap.add_argument("prompt", help="正向提示词")
    ap.add_argument("--negative", default=DEFAULT_NEG)
    ap.add_argument("--model", default="juggernautXL_v8Rundiffusion")
    ap.add_argument("--steps", type=int, default=None)
    ap.add_argument("--cfg", type=float, default=None)
    ap.add_argument("--w", type=int, default=1024)
    ap.add_argument("--h", type=int, default=1024)
    ap.add_argument("--seed", type=int, default=42)
    ap.add_argument("--scheduler", default=None)
    ap.add_argument("--prefix", default="pangu")
    ap.add_argument("--out", default=DEFAULT_OUT)
    ap.add_argument("--timeout", type=int, default=300)
    ap.add_argument("--host", default="127.0.0.1", help="ComfyUI host (默认 127.0.0.1, 多机可指向 244)")
    ap.add_argument("--port", type=int, default=8188, help="ComfyUI port (默认 8188, 兼容本机 8000)")
    ap.add_argument("--quiet", action="store_true", help="静默所有 stderr 进度(自动化用)")
    ap.add_argument("--sidecar", default=None, help="metadata JSON 落盘路径,默认 /tmp/pangu-comfyui/<ts>.json")
    args = ap.parse_args()
    _QUIET["on"] = bool(args.quiet)

    base = args.model.replace(".safetensors", "")
    defaults = MODEL_DEFAULTS.get(base, {"steps": 25, "cfg": 7.0, "scheduler": "karras"})
    steps = args.steps if args.steps is not None else defaults["steps"]
    cfg = args.cfg if args.cfg is not None else defaults["cfg"]
    scheduler = args.scheduler or defaults["scheduler"]

    log(f"[comfyui] model={args.model}  size={args.w}x{args.h}  steps={steps} cfg={cfg} scheduler={scheduler} seed={args.seed}")
    log(f"[comfyui] prompt: {args.prompt[:80]}{chr(0x2026) if len(args.prompt) > 80 else ''}")
    log(f"[comfyui] out:    {args.out}")

    base = f"http://{args.host}:{args.port}"
    log(f"[comfyui] base:   {base}")
    wf = build_workflow(args.prompt, args.negative, args.model,
                        steps, cfg, args.w, args.h, args.seed, scheduler, args.prefix)
    pid = submit(wf, base)
    log(f"[comfyui] submitted prompt_id={pid}, waiting for image...")
    t0 = time.time()
    hist = wait(pid, timeout_s=args.timeout, base=base)
    elapsed = time.time() - t0
    saved = download_images(hist, args.out, base=base)
    log(f"[comfyui] OK {elapsed:.1f}s -> {args.out}/")

    if args.sidecar is None:
        sidecar_dir = "/tmp/pangu-comfyui"
        os.makedirs(sidecar_dir, exist_ok=True)
        sidecar_path = os.path.join(sidecar_dir, f"{int(time.time()*1000)}.json")
    else:
        sidecar_path = args.sidecar
    sidecar = {
        "ts": int(time.time()),
        "elapsed_s": round(elapsed, 2),
        "prompt": args.prompt,
        "model": args.model,
        "steps": steps, "cfg": cfg, "scheduler": scheduler, "seed": args.seed,
        "size": [args.w, args.h],
        "out_dir": args.out,
        "files": saved,
        "prompt_id": pid,
    }
    try:
        with open(sidecar_path, "w") as f:
            json.dump(sidecar, f, indent=2, ensure_ascii=False)
    except OSError as e:
        log(f"[comfyui] WARN sidecar write failed: {e}")

    for s in saved:
        print(f"file://{s}")


if __name__ == "__main__":
    main()
