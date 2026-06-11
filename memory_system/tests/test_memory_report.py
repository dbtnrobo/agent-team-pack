"""棚卸しレポート（memory_report.py）の検出ロジックのテスト。"""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from memory_report import build_report


def test_stale_detects_old_blocks(tmp_path):
    (tmp_path / "m.md").write_text(
        "# m\n## 2020-01-01 大昔の決定\n古い。\n\n## 2099-01-01 未来の決定\n新しい。\n",
        encoding="utf-8",
    )
    r = build_report(dirs=[tmp_path], stale_days=90)
    headings = [s["heading"] for s in r["stale"]]
    assert any("大昔" in h for h in headings)
    assert not any("未来" in h for h in headings)


def test_duplicates_detects_similar_blocks(tmp_path):
    (tmp_path / "a.md").write_text(
        "# a\n## 2026-06-01 デプロイ手順\nmainにマージするとCIが自動デプロイする。確認はSlack。\n",
        encoding="utf-8",
    )
    (tmp_path / "b.md").write_text(
        "# b\n## 2026-06-05 デプロイ手順\nmainにマージするとCIが自動デプロイする。確認はSlackで。\n",
        encoding="utf-8",
    )
    r = build_report(dirs=[tmp_path])
    assert len(r["duplicates"]) >= 1
    assert r["duplicates"][0]["similarity"] >= 0.7


def test_no_false_duplicates(tmp_path):
    (tmp_path / "m.md").write_text(
        "# m\n## 2026-06-01 デプロイ\nCIが自動デプロイ。\n\n"
        "## 2026-06-02 朝会\n毎朝10時にZoomで開催。\n",
        encoding="utf-8",
    )
    r = build_report(dirs=[tmp_path])
    assert r["duplicates"] == []


def test_oversized_detects_big_files(tmp_path, monkeypatch):
    monkeypatch.setenv("MEMORY_FILE_MAX_CHARS", "100")
    (tmp_path / "big.md").write_text(
        "# big\n## 2026-06-01 長い\n" + "あ" * 200 + "\n", encoding="utf-8"
    )
    r = build_report(dirs=[tmp_path])
    assert len(r["oversized"]) == 1
    assert "big.md" in r["oversized"][0]["file"]


def test_empty_dir_reports_zero(tmp_path):
    r = build_report(dirs=[tmp_path])
    assert r["blocks_total"] == 0
    assert r["stale"] == [] and r["duplicates"] == [] and r["oversized"] == []
