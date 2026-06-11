#!/usr/bin/env bash
# 汎用 Stop フック: CONTEXT ローテ ＋ 記憶の差分再索引（LLM非依存・追加課金ゼロ）。
# 設定（任意・すべて環境変数）:
#   MEMORY_DIRS    記憶md(.md)のあるディレクトリ。os.pathsep区切り。
#                  未設定なら plugin userConfig（memory_dirs）→ ~/.claude。
#   MEMORY_CONTEXT ローテ対象の CONTEXT.md パス（指定時のみローテ）。
#   MEMORY_KEEP_N  ローテで残す先頭ブロック数（既定 5）。
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# userConfig（プラグイン設定 GUI）→ 環境変数の配線。明示的な MEMORY_DIRS が優先。
if [ -z "${MEMORY_DIRS:-}" ] && [ -n "${CLAUDE_PLUGIN_OPTION_memory_dirs:-}" ]; then
  export MEMORY_DIRS="${CLAUDE_PLUGIN_OPTION_memory_dirs}"
fi
export MEMORY_INDEX_DB="${MEMORY_INDEX_DB:-${CLAUDE_PLUGIN_DATA:-$ROOT/memory_system}/memory_index.db}"

if [ -n "${MEMORY_CONTEXT:-}" ] && [ -f "${MEMORY_CONTEXT}" ]; then
  python3 "$ROOT/memory_system/rotate_context.py" "${MEMORY_CONTEXT}" -n "${MEMORY_KEEP_N:-5}" >/dev/null 2>&1 || true
fi
python3 "$ROOT/memory_system/index_memory.py" reindex >/dev/null 2>&1 || true
exit 0
