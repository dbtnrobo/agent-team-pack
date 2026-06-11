#!/usr/bin/env python3
"""記憶 md への保存 CLI（remember スキルの書き込み経路）。

エージェントが md を直接編集する代わりにこの CLI を通すことで、
記憶の品質ルールを機械的に強制する（hermes-agent の memory ツールと同思想）:

  - 完全一致の重複ブロックは保存を拒否する
  - ファイル字数上限（MEMORY_FILE_MAX_CHARS、既定 10000）を超える保存は
    エラーで拒否し、既存ブロックの見出し一覧を提示して「先に統合してから
    保存する」ことを強制する（error-driven consolidation）
  - 見出しに絶対日付（YYYY-MM-DD）が無い保存は拒否する
  - 保存成功時は索引を自動更新する

使い方:
  python3 memory_write.py append  --file <md> --heading "2026-06-11 決定: X" --body "本文"
  python3 memory_write.py replace --file <md> --match "見出しの部分文字列" \
                                  --heading "2026-06-11 決定: X(改)" --body "新本文"

body を省略すると stdin から読む。LLM は呼ばない＝追加課金ゼロ。
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fts_index import _DATE_RE, connect, index_markdown_file
from rotate_context import split_blocks

DEFAULT_MAX_CHARS = 10000


def _max_chars() -> int:
    return int(os.environ.get("MEMORY_FILE_MAX_CHARS", DEFAULT_MAX_CHARS))


def _norm(text: str) -> str:
    """重複判定用の正規化（空白差・末尾改行差を無視）。"""
    return "\n".join(line.strip() for line in text.strip().splitlines())


def _make_block(heading: str, body: str) -> str:
    heading = heading.strip()
    if not heading.startswith("##"):
        heading = "## " + heading
    return f"{heading}\n{body.strip()}\n\n"


def _headings(blocks) -> list[str]:
    return [b.splitlines()[0] if b.splitlines() else "" for b in blocks]


def _fail(msg: str, blocks=None) -> None:
    print(f"refused: {msg}")
    if blocks:
        print("既存ブロック一覧（統合の候補）:")
        for h in _headings(blocks):
            print(f"  {h}")
    sys.exit(1)


def _validate_heading(heading: str) -> None:
    if not _DATE_RE.search(heading):
        _fail("見出しに絶対日付（YYYY-MM-DD）が必要です。相対日付（昨日・来週）は禁止")


def _write_and_reindex(path: Path, text: str) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    db_path = os.environ.get(
        "MEMORY_INDEX_DB", str(Path(__file__).resolve().parent / "memory_index.db")
    )
    index_markdown_file(connect(db_path), path)


def append_block(path: Path, heading: str, body: str) -> None:
    _validate_heading(heading)
    block = _make_block(heading, body)
    text = path.read_text(encoding="utf-8") if path.is_file() else ""
    preamble, blocks = split_blocks(text)

    for b in blocks:
        if _norm(b) == _norm(block):
            _fail("同一内容のブロックが既に存在します（保存不要）")

    # CONTEXT.md は新しいものが先頭の運用。その他の記憶 md は末尾追記。
    if path.name == "CONTEXT.md":
        new_text = preamble + block + "".join(blocks)
    else:
        new_text = text.rstrip() + ("\n\n" if text.strip() else "") + block

    if len(new_text) > _max_chars():
        _fail(
            f"ファイルが上限 {_max_chars()} 字を超えます（現在 {len(text)} 字）。"
            "replace で既存ブロックを統合・更新してから保存してください",
            blocks,
        )
    _write_and_reindex(path, new_text)
    print(f"saved: {path}({heading.strip()})")


def replace_block(path: Path, match: str, heading: str, body: str) -> None:
    _validate_heading(heading)
    if not path.is_file():
        _fail(f"ファイルがありません: {path}")
    preamble, blocks = split_blocks(path.read_text(encoding="utf-8"))
    hits = [i for i, b in enumerate(blocks) if match in _headings([b])[0]]
    if not hits:
        _fail(f"見出しに「{match}」を含むブロックが見つかりません", blocks)
    if len(hits) > 1:
        _fail(f"「{match}」が {len(hits)} 件に一致します。一意になる文字列を指定してください", blocks)

    blocks[hits[0]] = _make_block(heading, body)
    new_text = preamble + "".join(blocks)
    if len(new_text) > _max_chars():
        _fail(f"置換後もファイルが上限 {_max_chars()} 字を超えます。さらに統合が必要です", blocks)
    _write_and_reindex(path, new_text)
    print(f"replaced: {path}({heading.strip()})")


def main() -> None:
    import argparse

    ap = argparse.ArgumentParser(description="記憶mdへの保存（重複拒否・上限つき）")
    sub = ap.add_subparsers(dest="cmd", required=True)
    for name in ("append", "replace"):
        sp = sub.add_parser(name)
        sp.add_argument("--file", required=True)
        sp.add_argument("--heading", required=True, help="ブロック見出し（YYYY-MM-DD 必須）")
        sp.add_argument("--body", default=None, help="本文（省略時は stdin）")
        if name == "replace":
            sp.add_argument("--match", required=True, help="置換対象ブロックの見出し部分文字列")

    args = ap.parse_args()
    body = args.body if args.body is not None else sys.stdin.read()
    if not body.strip():
        _fail("本文が空です")

    path = Path(args.file).expanduser()
    if args.cmd == "append":
        append_block(path, args.heading, body)
    else:
        replace_block(path, args.match, args.heading, body)


if __name__ == "__main__":
    main()
