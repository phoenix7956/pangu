#!/usr/bin/env python3
"""
scripts/agent_essence_dumper.py — 跨 agent 借鉴协议 (2026-09-03 Codex 立)

每个 agent (codex / openclaw / marvis / hermes / pangu) 每天 dump 一份
"今日精华" 到 ~/Documents/Codex/shared/agent-essence/<self>/<date>.md。

盘古定时 scan shared/agent-essence/, 提炼 → 写入 ~/.pangu/borrowed/。

借鉴 = 观察 + 提炼, 不是照抄。

用法:
  python3 agent_essence_dumper.py [agent_name]
  # 默认 agent_name = 'pangu'
  # 从 stdin 读 content, 写一份 <date>.md

  echo "今日做了什么:..." | python3 agent_essence_dumper.py codex

  # 或者 -c 传字符串:
  python3 agent_essence_dumper.py codex -c "今天帮老板修了 mc3 quick-start host upsert"
"""
import argparse
import datetime
import os
import pathlib
import sys

SHARED = pathlib.Path.home() / "Documents" / "Codex" / "shared" / "agent-essence"


def dump(agent: str, content: str, date: str) -> pathlib.Path:
    out_dir = SHARED / agent
    out_dir.mkdir(parents=True, exist_ok=True)
    out_file = out_dir / f"{date}.md"
    header = f"""# {agent} 今日精华 — {date}

> 自动生成, agent 自己 dump。盘古读这个文件提炼借鉴点, 不照抄。

## 做了什么
"""
    out_file.write_text(header + content + "\n", encoding="utf-8")
    return out_file


def main():
    p = argparse.ArgumentParser()
    p.add_argument("agent", nargs="?", default="pangu")
    p.add_argument("-c", "--content", help="content string (or read stdin)")
    p.add_argument("--date", default=datetime.date.today().isoformat())
    args = p.parse_args()

    content = args.content or sys.stdin.read()
    if not content.strip():
        print("ERR: 空 content (stdin 或 -c)", file=sys.stderr)
        sys.exit(1)

    out = dump(args.agent, content, args.date)
    print(f"[agent-essence] {args.agent} {args.date} → {out}")


if __name__ == "__main__":
    main()
