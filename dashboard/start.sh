#!/usr/bin/env bash
# ダッシュボード起動。config.json が無ければテンプレから作る（初回導入をスムーズに）。
set -uo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[ -f config.json ] || cp config.example.json config.json
exec node server.js
