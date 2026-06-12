"""SessionStart 自動注入テキスト（session_context.py）の振る舞いテスト。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from session_context import build_context


def _setup(tmp_path):
    (tmp_path / "CONTEXT.md").write_text(
        "# CONTEXT\n\n## 2026-06-11 ダッシュボード改善\n最新の作業。\n\n"
        "## 2026-06-01 古い作業\n以前の作業。\n",
        encoding="utf-8",
    )
    (tmp_path / "project_x.md").write_text("# X\n## 2026-05-01 決定\n内容。\n", encoding="utf-8")
    return tmp_path


def test_includes_header_and_newest_context_block(tmp_path):
    """ヘッダ（スキル案内）と CONTEXT.md の先頭ブロックだけが入る。"""
    out = build_context(dirs=[_setup(tmp_path)])
    assert "recall" in out and "remember" in out
    assert "ダッシュボード改善" in out
    assert "古い作業" not in out  # 先頭1ブロックのみ


def test_inventory_lists_md_files(tmp_path):
    """記憶ファイル一覧（目次）が入る。本文は入らない。"""
    out = build_context(dirs=[_setup(tmp_path)])
    assert "project_x.md" in out
    assert "内容。" not in out  # 目次方式: 本文は注入しない


def test_max_chars_truncates(tmp_path):
    """注入上限を超えたら切り詰める。"""
    d = _setup(tmp_path)
    (d / "CONTEXT.md").write_text(
        "## 2026-06-11 長文\n" + "あ" * 9000 + "\n", encoding="utf-8"
    )
    out = build_context(dirs=[d], max_chars=500)
    assert len(out) < 600
    assert "省略" in out


def test_no_context_md_still_works(tmp_path):
    """CONTEXT.md が無くてもヘッダ＋目次は返す（落ちない）。"""
    (tmp_path / "note.md").write_text("# n\n## 2026-01-01 メモ\nx\n", encoding="utf-8")
    out = build_context(dirs=[tmp_path])
    assert "recall" in out
    assert "note.md" in out


def test_empty_dir_returns_header_only(tmp_path):
    """空ディレクトリでもヘッダは返す。"""
    out = build_context(dirs=[tmp_path])
    assert "recall" in out


def test_brief_skips_context_and_inventory(tmp_path):
    """brief（compact直後）はヘッダのみ。"""
    out = build_context(dirs=[_setup(tmp_path)], brief=True)
    assert "recall" in out
    assert "ダッシュボード改善" not in out
    assert "project_x.md" not in out
