#!/usr/bin/env bash
# agent-team-pack ブートストラップ。
# このリポジトリをローカルマーケットプレイスとして登録し、プラグインを導入する。
#   git clone <repo> && cd agent-team-pack && bash install.sh
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

cat <<'MSG'

✅ 導入完了。

次の一歩:
  - ダッシュボードを使う場合は設定をコピーして値を編集:
      cp dashboard/config.example.json dashboard/config.json
  - 記憶ディレクトリを指定する場合は環境変数:
      export MEMORY_DIRS="$HOME/.claude/memory:/path/to/workspace/memory"

注意: 既にダッシュボードを別手段(tmux等)で :8080 起動している場合は、
プラグインの監視(monitor)を無効化してポート競合を避けてください:
      claude plugin disable agent-team-pack
MSG
