#!/usr/bin/env bash
# ダッシュボード起動。config.json が無ければテンプレから作る（初回導入をスムーズに）。
# 既に同ポートでダッシュボードが稼働中なら正常終了する（冪等。手動起動や
# tmux 起動と plugin monitor が競合しても二重起動・クラッシュにならない）。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
PORT="${PORT:-8080}"
if curl -sf -o /dev/null --max-time 2 "http://127.0.0.1:${PORT}/api/health" 2>/dev/null; then
  echo "dashboard already running on :${PORT} — nothing to do"
  exit 0
fi
[ -f config.json ] || cp config.example.json config.json
PORT="$PORT" exec node server.js
