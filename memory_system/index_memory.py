#!/usr/bin/env python3
"""実際の記憶(memory/*.md)を索引し、検索で想起するCLI（記憶層のエントリポイント）。

  python index_memory.py reindex          # memory/*.md を全索引（差分のみ更新）
  python index_memory.py search "クエリ"   # 記憶を想起（日本語OK）

真実源は md。このDB(memory_index.db)は md から再構築可能な索引。
LLMを一切呼ばない＝サブスク枠内・課金ゼロ。
"""

import argparse
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

from fts_index import connect, index_markdown_file, prune_missing_sources
from fts_index import search as fts_search

# 索引対象の記憶ディレクトリは環境変数 MEMORY_DIRS（os.pathsep 区切り）で指定する。
# 環境固有の絶対パスはコードに埋め込まない（README参照）。未設定時は ~/.claude を使う。
_env_dirs = os.environ.get("MEMORY_DIRS", "").strip()
DEFAULT_MEMORY_DIRS = (
    [Path(p) for p in _env_dirs.split(os.pathsep) if p]
    if _env_dirs
    else [Path.home() / ".claude"]
)
# 索引DBは再構築可能なので非コミット。場所は MEMORY_INDEX_DB で上書き可。
DB_PATH = Path(
    os.environ.get("MEMORY_INDEX_DB", Path(__file__).resolve().parent / "memory_index.db")
)


def reindex(db, dirs=None) -> tuple[int, int]:
    """指定ディレクトリ群の *.md を全て差分索引する。戻り値: (ファイル数, 追加チャンク数)。

    dirs は単一のパスでもリストでも可（テストは単一ディレクトリを渡す）。
    """
    if dirs is None:
        dirs = DEFAULT_MEMORY_DIRS
    if isinstance(dirs, (str, Path)):
        dirs = [dirs]
    files = 0
    added = 0
    for d in dirs:
        for md in sorted(Path(d).glob("*.md")):
            added += index_markdown_file(db, md)
            files += 1
    prune_missing_sources(db)
    return files, added


def _print_hits(hits) -> None:
    if not hits:
        print("（該当なし）")
        return
    for h in hits:
        src = Path(h["source"]).name
        snippet = h["content"].replace("\n", " ")[:120]
        print(f"[{src}] {h['heading'] or '（前文）'}")
        print(f"  {snippet}...")


def main() -> None:
    ap = argparse.ArgumentParser(description="記憶の索引・想起")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("reindex", help="memory/*.md を索引")
    sp = sub.add_parser("search", help="記憶を想起")
    sp.add_argument("query")
    sp.add_argument("-n", type=int, default=5, help="最大件数")
    sp.add_argument("--json", action="store_true", help="JSON配列で出力（ダッシュボード用）")

    args = ap.parse_args()
    db = connect(str(DB_PATH))

    if args.cmd == "reindex":
        files, added = reindex(db)
        print(f"indexed {files} files, {added} new chunks → {DB_PATH.name}")
    elif args.cmd == "search":
        # クラッシュ後でも最新を引けるよう、検索前に差分reindex（変更分だけ＝高速）。
        # Stopフックはクラッシュ時に発火しないため、索引の鮮度は検索時に担保する。
        try:
            reindex(db)
        except Exception as e:
            # 検索自体は古い索引で続行できるため落とさないが、無言にはしない
            print(f"warning: reindex failed, results may be stale: {e}", file=sys.stderr)
        hits = fts_search(db, args.query, args.n)
        if args.json:
            import json as _json

            print(_json.dumps(hits, ensure_ascii=False))
        else:
            _print_hits(hits)


if __name__ == "__main__":
    main()
