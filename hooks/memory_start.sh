#!/usr/bin/env bash
# 汎用 SessionStart フック: 記憶索引を最新に保つ（差分のみ・LLM非依存）。
#   MEMORY_DIRS 未設定なら ~/.claude を索引。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
python3 "$ROOT/memory_system/index_memory.py" reindex >/dev/null 2>&1 || true
exit 0
