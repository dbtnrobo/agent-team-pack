#!/usr/bin/env python3
"""記憶の棚卸しレポート CLI（memory-gc スキルの入力）。

LLM を呼ばずに、記憶 md 群の「劣化候補」を機械的に列挙する:

  - stale:      N 日以上更新されていないブロック（既定 90 日）
  - duplicates: 内容が酷似するブロックのペア（統合候補）
  - oversized:  字数上限（MEMORY_FILE_MAX_CHARS）の 80% を超えたファイル

整理（統合・書き換え・アーカイブ）の判断と実行はエージェントがセッション内で
行う＝サブスク枠内。このツールは候補を出すだけで何も変更しない（read-only）。

  python3 memory_report.py [--stale-days 90] [--json]
"""

import difflib
import os
import sys
from datetime import date, timedelta
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fts_index import _chunk_date
from memory_write import DEFAULT_MAX_CHARS
from rotate_context import split_blocks

DEFAULT_STALE_DAYS = 90
SIMILARITY_THRESHOLD = 0.7
MAX_PAIRWISE_BLOCKS = 300  # O(n^2) 比較の上限（記憶mdは通常これより遥かに小さい）


def _memory_dirs():
    env = os.environ.get("MEMORY_DIRS", "").strip()
    if env:
        return [Path(p) for p in env.split(os.pathsep) if p]
    return [Path.home() / ".claude"]


def _collect_blocks(dirs):
    """全記憶 md のブロックを [{file, heading, content, date}] で集める。"""
    out = []
    for d in dirs:
        d = Path(d)
        if not d.is_dir():
            continue
        for md in sorted(d.glob("*.md")):
            try:
                _, blocks = split_blocks(md.read_text(encoding="utf-8"))
            except OSError:
                continue
            for b in blocks:
                lines = b.splitlines()
                heading = lines[0] if lines else ""
                out.append({
                    "file": str(md),
                    "heading": heading,
                    "content": b,
                    "date": _chunk_date(str(md), heading),
                })
    return out


def _stale(blocks, days):
    cutoff = (date.today() - timedelta(days=days)).isoformat()
    return [
        {"file": b["file"], "heading": b["heading"], "date": b["date"]}
        for b in blocks
        if b["date"] and b["date"] < cutoff
    ]


def _duplicates(blocks):
    """内容が酷似するブロックのペアを列挙する（統合候補）。"""
    pairs = []
    target = blocks[:MAX_PAIRWISE_BLOCKS]
    for i in range(len(target)):
        for j in range(i + 1, len(target)):
            a, b = target[i], target[j]
            ratio = difflib.SequenceMatcher(
                None, a["content"], b["content"]
            ).ratio()
            if ratio >= SIMILARITY_THRESHOLD:
                pairs.append({
                    "a": {"file": a["file"], "heading": a["heading"], "date": a["date"]},
                    "b": {"file": b["file"], "heading": b["heading"], "date": b["date"]},
                    "similarity": round(ratio, 2),
                })
    return pairs


def _oversized(dirs):
    limit = int(os.environ.get("MEMORY_FILE_MAX_CHARS", DEFAULT_MAX_CHARS))
    out = []
    for d in dirs:
        d = Path(d)
        if not d.is_dir():
            continue
        for md in sorted(d.glob("*.md")):
            try:
                n = len(md.read_text(encoding="utf-8"))
            except OSError:
                continue
            if n > limit * 0.8:
                out.append({"file": str(md), "chars": n, "limit": limit})
    return out


def build_report(dirs=None, stale_days=DEFAULT_STALE_DAYS) -> dict:
    dirs = dirs if dirs is not None else _memory_dirs()
    blocks = _collect_blocks(dirs)
    return {
        "blocks_total": len(blocks),
        "stale": _stale(blocks, stale_days),
        "duplicates": _duplicates(blocks),
        "oversized": _oversized(dirs),
    }


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="記憶の棚卸しレポート")
    ap.add_argument("--stale-days", type=int, default=DEFAULT_STALE_DAYS)
    ap.add_argument("--json", action="store_true")
    args = ap.parse_args()

    r = build_report(stale_days=args.stale_days)
    if args.json:
        import json as _json

        print(_json.dumps(r, ensure_ascii=False, indent=1))
        return

    print(f"記憶ブロック総数: {r['blocks_total']}")
    print(f"\n■ {args.stale_days}日以上未更新（{len(r['stale'])}件）")
    for s in r["stale"]:
        print(f"  [{s['date']}] {Path(s['file']).name}: {s['heading']}")
    print(f"\n■ 重複候補（{len(r['duplicates'])}ペア）")
    for p in r["duplicates"]:
        print(f"  類似度{p['similarity']}: {Path(p['a']['file']).name}「{p['a']['heading']}」"
              f" ↔ {Path(p['b']['file']).name}「{p['b']['heading']}」")
    print(f"\n■ 肥大ファイル（{len(r['oversized'])}件）")
    for o in r["oversized"]:
        print(f"  {o['file']}: {o['chars']}字 / 上限{o['limit']}字")


if __name__ == "__main__":
    main()
