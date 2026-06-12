#!/usr/bin/env bash
# agent-team-pack ブートストラップ。
# このリポジトリをローカルマーケットプレイスとして登録し、プラグインを導入する。
#   git clone <repo> && cd agent-team-pack && bash install.sh [チーム名]
set -euo pipefail

echo "▶ 依存チェック"
for b in node python3 git claude; do
  command -v "$b" >/dev/null 2>&1 || { echo "  ✗ $b が必要です。インストールしてから再実行してください。"; exit 1; }
done
echo "  ✓ node / python3 / git / claude"

# FTS5 有効な SQLite かを確認（記憶層の前提）
python3 - <<'PY' || { echo "  ✗ この python3 の sqlite3 が FTS5 無効です。FTS5 有効な環境が必要です。"; exit 1; }
import sqlite3
sqlite3.connect(":memory:").execute("CREATE VIRTUAL TABLE t USING fts5(x)")
PY
echo "  ✓ SQLite FTS5 有効"

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
echo "▶ マーケットプレイス登録: $DIR"
claude plugin marketplace add "$DIR"
echo "▶ プラグイン導入"
claude plugin install agent-team-pack@doubutuen-agent-tools

echo "▶ タスクディレクトリ作成"
mkdir -p "$DIR/tasks"
echo "  ✓ $DIR/tasks"

# ── dashboard/config.json の自動生成（既存があれば触らない） ──────────────
CONFIG="$DIR/dashboard/config.json"
if [ -f "$CONFIG" ]; then
  echo "▶ dashboard/config.json は既に存在（変更しない）"
else
  echo "▶ dashboard/config.json を自動生成"
  TEAM_NAME="${1:-My Team}"
  # ~/.claude/projects/ から記憶ディレクトリ候補（memory/ を持つもの）を検出
  PROJECTS_DIR=""
  for d in "$HOME"/.claude/projects/*/; do
    [ -d "${d}memory" ] && { PROJECTS_DIR="${d}memory"; break; }
  done
  python3 - "$DIR" "$TEAM_NAME" "$PROJECTS_DIR" <<'PY'
import json, sys
from pathlib import Path

root, team, projects_dir = sys.argv[1], sys.argv[2], sys.argv[3]
home = str(Path.home())
example = json.loads((Path(root) / "dashboard" / "config.example.json").read_text(encoding="utf-8"))

example.pop("_comment", None)
example["teamName"] = team
so = example.setdefault("serverOnly", {})
# ローカル専用の安全側既定（外部公開する場合は手動で allowedHosts に追加）
so["host"] = "127.0.0.1"
so["allowedHosts"] = ["127.0.0.1", "localhost"]
so.pop("startCommands", None)

ds = so.setdefault("dataSources", {})
if projects_dir:
    ds["projectsDir"] = projects_dir
else:
    ds.pop("projectsDir", None)
ds["skillsDir"] = f"{home}/.claude/skills"
ds["docs"] = [{"label": "CLAUDE.md", "path": f"{home}/.claude/CLAUDE.md"}]
ds["sessions"] = {"projectsRoot": f"{home}/.claude/projects",
                  "liveRegistryDir": f"{home}/.claude/sessions", "limit": 60}
ds["archive"] = {"root": f"{home}/.claude/projects-archive", "limit": 60,
                 "restoreScript": f"{root}/scripts/manage_sessions.sh"}
ms = {"python": "python3", "script": f"{root}/memory_system/index_memory.py"}
if projects_dir:
    ms["memoryDirs"] = [projects_dir]
ds["memorySearch"] = ms
ds["logSearch"] = {"transcriptsRoots": [f"{home}/.claude/projects",
                                        f"{home}/.claude/projects-archive"]}

out = Path(root) / "dashboard" / "config.json"
out.write_text(json.dumps(example, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
print(f"  ✓ {out}")
if projects_dir:
    print(f"  ✓ 記憶ディレクトリを検出: {projects_dir}")
else:
    print("  ⚠ 記憶ディレクトリ未検出。config.json の memorySearch.memoryDirs を後で設定してください")
PY
fi

cat <<MSG

✅ 導入完了。

すぐ使える:
  - ダッシュボード起動:  node "$DIR/dashboard/server.js" → http://127.0.0.1:8080
  - チーム名の変更等は dashboard/config.json を編集（再起動不要）

記憶システム（自動想起 + recall / remember / memory-gc スキル）:
  - 記憶ディレクトリの指定はどちらかで:
      a) Claude Code 内で /plugin configure agent-team-pack（GUI・推奨）
      b) export MEMORY_DIRS="\$HOME/.claude/memory:/path/to/workspace/memory"
  - 次のセッション開始から、直近の文脈と記憶の目次が自動注入されます

注意: 既にダッシュボードを別手段(tmux等)で :8080 起動している場合は、
プラグインの監視(monitor)を無効化してポート競合を避けてください:
      claude plugin disable agent-team-pack

アンインストール: bash "$DIR/uninstall.sh"
MSG
