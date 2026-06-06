"""記憶層の核（md→索引→想起）の振る舞いテスト。

公開インターフェース（connect / index_markdown_file / search）越しに検証する。
内部実装（FTS5テーブル構造など）には依存しない。
"""

import pathlib
import sys

sys.path.insert(0, str(pathlib.Path(__file__).resolve().parent.parent))

from fts_index import connect, index_markdown_file, search


def _make_md(tmp_path):
    md = tmp_path / "mem.md"
    md.write_text(
        "# 図書館\n"
        "図書館は本を貸し出す公共施設で、静かに調べ物ができる場所。\n\n"
        "# 公園\n"
        "公園は遊具やベンチがあり、子どもが安全に遊べる広場。\n",
        encoding="utf-8",
    )
    return md


def test_japanese_recall(tmp_path):
    """日本語の語で、その語を含むセクションを想起できる。"""
    db = connect()
    index_markdown_file(db, _make_md(tmp_path))
    hits = search(db, "貸し出す")
    assert any("図書館" in h["content"] for h in hits)


def test_recall_other_section(tmp_path):
    """別セクションの語でも、正しくそのセクションを想起する。"""
    db = connect()
    index_markdown_file(db, _make_md(tmp_path))
    hits = search(db, "遊具")
    assert any("公園" in h["content"] for h in hits)


def test_no_false_match(tmp_path):
    """存在しない語では何も想起しない。"""
    db = connect()
    index_markdown_file(db, _make_md(tmp_path))
    assert search(db, "宇宙ステーション建設計画") == []


def test_reindex_is_idempotent(tmp_path):
    """同じmdを再索引してもチャンクは増えない（差分同期）。"""
    db = connect()
    md = _make_md(tmp_path)
    index_markdown_file(db, md)
    n1 = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    added = index_markdown_file(db, md)
    n2 = db.execute("SELECT COUNT(*) FROM chunks").fetchone()[0]
    assert added == 0
    assert n1 == n2


def test_edit_removes_stale_chunk(tmp_path):
    """mdからセクションを消すと、索引からもそのチャンクが消える。"""
    db = connect()
    md = _make_md(tmp_path)
    index_markdown_file(db, md)
    assert search(db, "遊具")  # 最初はヒット

    md.write_text("# 図書館\n図書館は本を貸し出す施設。\n", encoding="utf-8")  # 公園節を削除
    index_markdown_file(db, md)
    assert search(db, "遊具") == []  # もう想起されない


def test_reindex_directory(tmp_path):
    """ディレクトリ内の複数mdをまとめて索引し、横断検索できる。"""
    import index_memory

    (tmp_path / "a.md").write_text("# 動物A\nアルパカはふわふわした動物。\n", encoding="utf-8")
    (tmp_path / "b.md").write_text("# 動物B\nラクダは砂漠を歩く動物。\n", encoding="utf-8")
    db = connect()
    files, added = index_memory.reindex(db, tmp_path)
    assert files == 2
    assert added >= 2
    assert any("アルパカ" in h["content"] for h in search(db, "アルパカ"))
    assert any("ラクダ" in h["content"] for h in search(db, "ラクダ"))


def test_short_japanese_recall(tmp_path):
    """2文字の日本語（trigram不可）もLIKEフォールバックで想起できる。"""
    db = connect()
    md = tmp_path / "m.md"
    md.write_text("# 寿司\n寿司は酢飯に魚介をのせた日本料理。\n", encoding="utf-8")
    index_markdown_file(db, md)
    assert any("酢飯" in h["content"] for h in search(db, "寿司"))
