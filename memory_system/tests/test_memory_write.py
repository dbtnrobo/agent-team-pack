"""記憶保存 CLI（memory_write.py）の品質ルール強制のテスト。"""

import sys
from pathlib import Path

import pytest

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

import memory_write
from memory_write import append_block, replace_block


@pytest.fixture(autouse=True)
def _isolate_db(tmp_path, monkeypatch):
    """索引DBをテスト毎に隔離する。"""
    monkeypatch.setenv("MEMORY_INDEX_DB", str(tmp_path / "idx.db"))


def test_append_creates_block_with_date(tmp_path):
    md = tmp_path / "m.md"
    append_block(md, "2026-06-11 決定: テスト方針", "pytest を使う。")
    text = md.read_text(encoding="utf-8")
    assert "## 2026-06-11 決定: テスト方針" in text
    assert "pytest を使う。" in text


def test_append_rejects_heading_without_date(tmp_path):
    with pytest.raises(SystemExit):
        append_block(tmp_path / "m.md", "日付なしの見出し", "本文")


def test_append_rejects_exact_duplicate(tmp_path):
    md = tmp_path / "m.md"
    append_block(md, "2026-06-11 事実", "ラクダは砂漠を歩く。")
    with pytest.raises(SystemExit):
        append_block(md, "2026-06-11 事実", "ラクダは砂漠を歩く。")


def test_append_rejects_over_limit(tmp_path, monkeypatch):
    monkeypatch.setenv("MEMORY_FILE_MAX_CHARS", "200")
    md = tmp_path / "m.md"
    append_block(md, "2026-06-11 短い", "x")
    with pytest.raises(SystemExit):
        append_block(md, "2026-06-12 長い", "あ" * 300)
    # 拒否後もファイルは壊れていない
    assert "短い" in md.read_text(encoding="utf-8")


def test_replace_updates_matching_block(tmp_path):
    md = tmp_path / "m.md"
    append_block(md, "2026-06-01 方針: 旧", "古い内容。")
    replace_block(md, "方針", "2026-06-11 方針: 新", "新しい内容。")
    text = md.read_text(encoding="utf-8")
    assert "新しい内容。" in text
    assert "古い内容。" not in text


def test_replace_rejects_ambiguous_match(tmp_path):
    md = tmp_path / "m.md"
    append_block(md, "2026-06-01 方針A", "a")
    append_block(md, "2026-06-02 方針B", "b")
    with pytest.raises(SystemExit):
        replace_block(md, "方針", "2026-06-11 方針", "c")


def test_context_md_prepends_newest_first(tmp_path):
    md = tmp_path / "CONTEXT.md"
    md.write_text("# CONTEXT\n\n## 2026-06-01 古い\nx\n", encoding="utf-8")
    append_block(md, "2026-06-11 新しい", "y")
    text = md.read_text(encoding="utf-8")
    assert text.index("新しい") < text.index("古い")  # 先頭挿入


def test_saved_block_is_searchable(tmp_path):
    """保存後に自動reindexされ、すぐ検索できる。"""
    from fts_index import connect, search

    md = tmp_path / "m.md"
    append_block(md, "2026-06-11 動物", "カピバラは温泉に入る動物。")
    db = connect(str(Path(tmp_path / "idx.db")))
    assert any("カピバラ" in h["content"] for h in search(db, "カピバラ"))
