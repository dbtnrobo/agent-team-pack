#!/usr/bin/env python3
"""CONTEXT.md のローテーション（肥大防止）。

CONTEXT.md は H2見出し（## ...）単位の「ブロック」の集まり。
運用ルール: **新しいセッションまとめは先頭（frontmatter直後）に追加する**。
よって先頭 keep_n 個（新しい）を残し、末尾（古い）を logs/context_archive.md へ
退避する（追記＝消さない）。先頭の前文（frontmatter等、最初の ## より前）は常に保持。

LLMは呼ばない＝サブスク枠内・課金ゼロ。Stopフックから自動呼び出しする想定。
"""

import re
from pathlib import Path

DEFAULT_KEEP_N = 5


def split_blocks(text: str) -> tuple[str, list[str]]:
    """テキストを (前文, [H2ブロック...]) に分割する。

    前文 = 最初の "## " 見出しより前（frontmatter・タイトル等）。
    各ブロックは "## " で始まり、次の "## " の直前まで。
    """
    parts = re.split(r"(?m)^(?=## )", text)
    if parts and not parts[0].startswith("## "):
        return parts[0], parts[1:]
    return "", parts


def rotate_context_md(path, keep_n: int = DEFAULT_KEEP_N, archive_path=None) -> int:
    """先頭 keep_n ブロック（新しい）を残し、古いブロックを退避する。

    戻り値: 退避したブロック数。ブロックが keep_n 以下なら何もしない（冪等）。
    """
    path = Path(path)
    text = path.read_text(encoding="utf-8")
    preamble, blocks = split_blocks(text)

    if len(blocks) <= keep_n:
        return 0

    # 新しいものが先頭にある運用なので、先頭 keep_n を残し末尾（古い）を退避。
    kept, archived = blocks[:keep_n], blocks[keep_n:]

    if archive_path is None:
        archive_path = path.parent.parent / "logs" / "context_archive.md"
    archive_path = Path(archive_path)
    archive_path.parent.mkdir(parents=True, exist_ok=True)
    with open(archive_path, "a", encoding="utf-8") as f:
        f.write("".join(archived))

    path.write_text(preamble + "".join(kept), encoding="utf-8")
    return len(archived)


if __name__ == "__main__":
    import argparse

    ap = argparse.ArgumentParser(description="CONTEXT.md ローテーション（先頭=新しいを保持）")
    ap.add_argument("path")
    ap.add_argument("-n", type=int, default=DEFAULT_KEEP_N, help="残すブロック数（先頭から）")
    args = ap.parse_args()
    moved = rotate_context_md(args.path, args.n)
    print(f"archived {moved} old block(s), kept newest {args.n}")
