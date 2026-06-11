"""md真実源を検索可能にする索引（記憶層の核）。

真実は Markdown(memory/*.md)。このSQLite索引は md から再構築可能な「影」。
- index_markdown_file(): md を chunk 化し、変更分だけ差分で索引更新
- search():            記憶を想起。日本語は trigram、英数字は unicode61 で検索

--- 流用元（MIT・出所明示）---
* FTS5スキーマ/トリガ（unicode61 + CJK用trigramの2テーブル構成）と
  CJK判定・trigramルーティングの発想:
    NousResearch/hermes-agent (MIT, (c) 2025 Nous Research) commit b4b9a93
    hermes_state.py FTS_SQL / FTS_TRIGRAM_SQL を chunks テーブル向けに改変流用。
    -> THIRD_PARTY_LICENSES/hermes-agent-LICENSE.txt
* 差分再索引（content_hashで変更分だけupsert・stale削除）のフロー:
    zilliztech/memsearch (MIT) core.py _index_file を参考に自作。
* チャンク分割: vendored_chunker.py（memsearch 無改変コピー）
"""

import sqlite3
from pathlib import Path

from vendored_chunker import chunk_markdown

_SCHEMA = """
CREATE TABLE IF NOT EXISTS chunks (
    chunk_hash TEXT PRIMARY KEY,
    source     TEXT NOT NULL,
    heading    TEXT,
    content    TEXT NOT NULL,
    start_line INTEGER,
    end_line   INTEGER
);
CREATE INDEX IF NOT EXISTS idx_chunks_source ON chunks(source);
"""

# adapted from hermes-agent hermes_state.py FTS_SQL / FTS_TRIGRAM_SQL (MIT, b4b9a93).
# 2テーブル: unicode61(語単位・英数字向け) と trigram(CJK部分一致向け)。
# trigram を別建てする理由は hermes と同じ — 既定unicode61はCJKを1文字ずつ割り、
# フレーズ検索が壊れるため。トリガで chunks への INSERT/DELETE を両FTSに反映する。
_FTS = """
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(content);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts_trigram USING fts5(content, tokenize='trigram');

CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
    INSERT INTO chunks_fts(rowid, content)         VALUES (new.rowid, new.content);
    INSERT INTO chunks_fts_trigram(rowid, content) VALUES (new.rowid, new.content);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
    DELETE FROM chunks_fts         WHERE rowid = old.rowid;
    DELETE FROM chunks_fts_trigram WHERE rowid = old.rowid;
END;
"""


def connect(db_path: str = ":memory:") -> sqlite3.Connection:
    """索引DBを開く（無ければスキーマ作成）。"""
    db = sqlite3.connect(db_path)
    db.executescript(_SCHEMA + _FTS)
    return db


def _contains_cjk(text: str) -> bool:
    """日本語/中国語/韓国語の文字を含むか（hermesのCJK判定を簡素化流用）。"""
    for ch in text:
        o = ord(ch)
        if 0x3040 <= o <= 0x30FF or 0x4E00 <= o <= 0x9FFF or 0xAC00 <= o <= 0xD7AF:
            return True
    return False


def _as_phrase(query: str) -> str:
    """ユーザクエリをFTS5フレーズ化し、特殊文字によるSQLエラーを防ぐ。"""
    return '"' + query.replace('"', '""') + '"'


def index_markdown_file(db: sqlite3.Connection, path) -> int:
    """md を chunk 化し、変更分だけ索引を更新する（差分同期）。

    既存と同じ content_hash のチャンクは再処理しない。mdから消えたチャンクは
    索引からも削除する。戻り値: 新規に追加したチャンク数。
    """
    path = str(path)
    text = Path(path).read_text(encoding="utf-8")
    chunks = chunk_markdown(text, source=path)
    new_hashes = {c.content_hash for c in chunks}
    old_hashes = {
        row[0]
        for row in db.execute("SELECT chunk_hash FROM chunks WHERE source = ?", (path,))
    }

    for stale in old_hashes - new_hashes:
        db.execute("DELETE FROM chunks WHERE chunk_hash = ?", (stale,))

    added = 0
    for c in chunks:
        if c.content_hash in old_hashes:
            continue
        db.execute(
            "INSERT OR IGNORE INTO chunks"
            " (chunk_hash, source, heading, content, start_line, end_line)"
            " VALUES (?, ?, ?, ?, ?, ?)",
            (c.content_hash, c.source, c.heading, c.content, c.start_line, c.end_line),
        )
        added += 1
    db.commit()
    return added


def prune_missing_sources(db: sqlite3.Connection) -> int:
    """実体ファイルが消えた source のチャンクを索引から削除する。戻り値: 削除チャンク数。

    mdをセクション単位で消した場合は index_markdown_file の差分同期が拾うが、
    ファイルごと削除した場合はそのファイルが再走査されないため、ここで掃除する。
    """
    removed = 0
    sources = [r[0] for r in db.execute("SELECT DISTINCT source FROM chunks")]
    for src in sources:
        if not Path(src).exists():
            cur = db.execute("DELETE FROM chunks WHERE source = ?", (src,))
            removed += cur.rowcount
    if removed:
        db.commit()
    return removed


def _fts_match(db, table, query, limit):
    rows = db.execute(
        f"SELECT c.source, c.heading, c.content"
        f" FROM {table} f JOIN chunks c ON c.rowid = f.rowid"
        f" WHERE {table} MATCH ? ORDER BY rank LIMIT ?",
        (_as_phrase(query), limit),
    ).fetchall()
    return [{"source": r[0], "heading": r[1], "content": r[2]} for r in rows]


def _like_search(db, query, limit):
    """trigramが使えない短いCJK語の部分一致フォールバック（決定的）。"""
    rows = db.execute(
        "SELECT source, heading, content FROM chunks WHERE content LIKE ? LIMIT ?",
        (f"%{query}%", limit),
    ).fetchall()
    return [{"source": r[0], "heading": r[1], "content": r[2]} for r in rows]


def search(db: sqlite3.Connection, query: str, limit: int = 10) -> list[dict]:
    """記憶を想起する。

    英数字は unicode61、日本語は trigram。trigram は3文字以上必要なため、
    2文字以下のCJK語や trigram 空振り時は LIKE にフォールバックする
    （hermes の「短いCJKは LIKE」方針を踏襲）。戻り値: [{"source","heading","content"}]。
    """
    q = query.strip()
    if not q:
        return []
    if _contains_cjk(q):
        if len(q) >= 3:
            hits = _fts_match(db, "chunks_fts_trigram", q, limit)
            if hits:
                return hits
        return _like_search(db, q, limit)
    return _fts_match(db, "chunks_fts", q, limit)
