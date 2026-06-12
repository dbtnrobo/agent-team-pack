#!/usr/bin/env python3
"""SessionStart フックでコンテキストに自動注入するテキストを組み立てる。

Claude Code の SessionStart フックは stdout がそのままセッションコンテキストに
注入される。これを使い、LLM を呼ばずに「自動想起」を再現する:

  1. 固定ヘッダ — 記憶システムの使い方（recall / remember / memory-gc）の常設指示
  2. CONTEXT.md の先頭 N ブロック — 直近の作業文脈（新しいものが先頭の運用）
  3. 記憶ディレクトリの md ファイル一覧 — 「何の記憶があるか」の目次

本文は注入しない（目次方式）。記憶の総量が増えても注入量はほぼ一定に保たれ、
詳細は recall スキル（FTS5 検索）で必要なときだけ引く。

  python3 session_context.py [--max-chars N] [--blocks N] [--context PATH] [--brief]

失敗時は何も出力せず exit 0（セッション開始をブロックしない）。
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from rotate_context import split_blocks

DEFAULT_MAX_CHARS = 4000
DEFAULT_BLOCKS = 1

HEADER = """\
[永続記憶システム]
- 過去の決定・文脈が必要なとき・作業を始める前は recall スキルで記憶を検索する。
- 設計決定・ユーザーの好み・恒久的な事実が会話に出たら、その場で remember スキルで保存する（後回しにしない）。
- 日付は必ず絶対表記（YYYY-MM-DD）。「昨日」「来週」は禁止。
"""


def _memory_dirs():
    env = os.environ.get("MEMORY_DIRS", "").strip()
    if env:
        return [Path(p) for p in env.split(os.pathsep) if p]
    return [Path.home() / ".claude"]


def _find_context_md(dirs, explicit=None):
    """CONTEXT.md の場所を解決する。明示指定 > 各記憶ディレクトリ直下の探索。"""
    if explicit:
        p = Path(explicit)
        return p if p.is_file() else None
    for d in dirs:
        p = Path(d) / "CONTEXT.md"
        if p.is_file():
            return p
    return None


def _context_section(context_md, blocks_n):
    if not context_md:
        return ""
    try:
        _, blocks = split_blocks(context_md.read_text(encoding="utf-8"))
    except OSError:
        return ""
    if not blocks:
        return ""
    head = "".join(blocks[:blocks_n]).strip()
    return f"[直近の作業文脈 — {context_md.name} より]\n{head}\n"

def _inventory_section(dirs):
    lines = []
    for d in dirs:
        d = Path(d)
        if not d.is_dir():
            continue
        names = sorted(p.name for p in d.glob("*.md"))
        if names:
            lines.append(f"{d}:")
            lines.extend(f"  - {n}" for n in names)
    if not lines:
        return ""
    return "[記憶の目次 — 詳細は recall で検索]\n" + "\n".join(lines) + "\n"


def build_context(dirs=None, context_path=None, max_chars=DEFAULT_MAX_CHARS,
                  keep_blocks=DEFAULT_BLOCKS, brief=False) -> str:
    """注入テキストを組み立てる。brief=True はヘッダのみ（compact 直後用）。"""
    dirs = dirs if dirs is not None else _memory_dirs()
    parts = [HEADER]
    if not brief:
        ctx = _context_section(_find_context_md(dirs, context_path), keep_blocks)
        if ctx:
            parts.append(ctx)
        inv = _inventory_section(dirs)
        if inv:
            parts.append(inv)
    text = "\n".join(parts).strip()
    if len(text) > max_chars:
        text = text[:max_chars].rstrip() + "\n…（注入上限により省略。続きは recall で検索）"
    return text


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="SessionStart 注入テキストの組み立て")
    ap.add_argument("--max-chars", type=int,
                    default=int(os.environ.get("MEMORY_INJECT_MAX_CHARS", DEFAULT_MAX_CHARS)))
    ap.add_argument("--blocks", type=int,
                    default=int(os.environ.get("MEMORY_INJECT_BLOCKS", DEFAULT_BLOCKS)))
    ap.add_argument("--context", default=os.environ.get("MEMORY_CONTEXT") or None)
    ap.add_argument("--brief", action="store_true", help="ヘッダのみ（compact 直後用）")
    args = ap.parse_args()
    try:
        print(build_context(context_path=args.context, max_chars=args.max_chars,
                            keep_blocks=args.blocks, brief=args.brief))
    except Exception:
        pass  # 注入失敗でセッション開始を止めない


if __name__ == "__main__":
    main()
