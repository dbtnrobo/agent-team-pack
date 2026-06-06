"""CONTEXT.md ローテーションの振る舞いテスト。

運用前提: 新しいセッションまとめは先頭に追加される。
よってローテは「先頭 keep_n（新しい）を残し、末尾（古い）を退避」する。
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from rotate_context import rotate_context_md, split_blocks

_FRONT = "# CONTEXT.md\n\n最終更新: 2026-06-04\n\n"


def _doc(n_blocks: int) -> str:
    # ブロック1 が先頭（新しい）, 番号が大きいほど末尾（古い）
    blocks = "".join(f"## ブロック{i}\n本文{i}\n\n" for i in range(1, n_blocks + 1))
    return _FRONT + blocks


def test_keeps_frontmatter_and_newest_n(tmp_path):
    """ブロックが多い時、前文＋先頭（新しい）N個だけ残る。"""
    ctx = tmp_path / "CONTEXT.md"
    ctx.write_text(_doc(8), encoding="utf-8")
    archive = tmp_path / "archive.md"

    moved = rotate_context_md(ctx, keep_n=5, archive_path=archive)

    result = ctx.read_text(encoding="utf-8")
    assert moved == 3
    assert result.startswith("# CONTEXT.md")  # 前文保持
    assert "## ブロック1\n" in result          # 先頭=新しい=残る
    assert "## ブロック5\n" in result
    assert "## ブロック6\n" not in result       # 末尾=古い=退避
    assert "## ブロック8\n" not in result


def test_archived_blocks_are_preserved(tmp_path):
    """退避した古いブロックはアーカイブに保存される（消えない）。"""
    ctx = tmp_path / "CONTEXT.md"
    ctx.write_text(_doc(8), encoding="utf-8")
    archive = tmp_path / "archive.md"

    rotate_context_md(ctx, keep_n=5, archive_path=archive)

    arch = archive.read_text(encoding="utf-8")
    assert "## ブロック6\n" in arch and "## ブロック7\n" in arch and "## ブロック8\n" in arch


def test_idempotent_when_under_keep_n(tmp_path):
    """ブロックがkeep_n以下なら何もしない（不変・冪等）。"""
    ctx = tmp_path / "CONTEXT.md"
    original = _doc(4)
    ctx.write_text(original, encoding="utf-8")
    archive = tmp_path / "archive.md"

    moved = rotate_context_md(ctx, keep_n=5, archive_path=archive)

    assert moved == 0
    assert ctx.read_text(encoding="utf-8") == original
    assert not archive.exists()


def test_archive_appends_not_overwrites(tmp_path):
    """先頭追加→再ローテを繰り返してもアーカイブは追記され続ける。"""
    ctx = tmp_path / "CONTEXT.md"
    archive = tmp_path / "archive.md"

    ctx.write_text(_doc(7), encoding="utf-8")
    rotate_context_md(ctx, keep_n=5, archive_path=archive)  # 古いブロック6,7を退避

    # 運用通り、新しいブロックを先頭(前文の直後)に足して再肥大させる
    preamble, blocks = split_blocks(ctx.read_text(encoding="utf-8"))
    ctx.write_text(preamble + "## 新A\nx\n\n## 新B\ny\n\n" + "".join(blocks), encoding="utf-8")
    rotate_context_md(ctx, keep_n=5, archive_path=archive)  # 古いブロック4,5を退避

    arch = archive.read_text(encoding="utf-8")
    assert "## ブロック6\n" in arch  # 1回目の退避が残っている
    assert "## ブロック4\n" in arch  # 2回目の退避も入っている
    # 新しいブロックは残っている
    assert "## 新A\n" in ctx.read_text(encoding="utf-8")


def test_split_blocks_preamble():
    """前文とブロックが正しく分かれる。"""
    preamble, blocks = split_blocks(_doc(3))
    assert preamble.startswith("# CONTEXT.md")
    assert len(blocks) == 3
    assert all(b.startswith("## ") for b in blocks)
