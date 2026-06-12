#!/usr/bin/env bash
# SessionStart トリガ: 記憶索引を再構築し、自動想起コンテキストを注入する。
#
# Claude Code の仕様: SessionStart フックの stdout はセッションコンテキストに
# 注入される。LLM を呼ばずに「前回までの文脈」を自動で渡す（hermes の自動想起の再現）。
#
# 設定（環境変数、すべて任意）:
#   MEMORY_DIRS              索引対象（os.pathsep区切り。未設定なら plugin userConfig → ~/.claude）
#   MEMORY_INDEX_DB          索引DBの場所（未設定なら CLAUDE_PLUGIN_DATA 配下 → plugin内）
#   MEMORY_CONTEXT           CONTEXT.md のパス（未設定なら記憶ディレクトリ直下を探索）
#   MEMORY_INJECT            0 で注入を停止（reindex のみ行う）。既定 1
#   MEMORY_INJECT_MAX_CHARS  注入上限（既定 4000）
#   MEMORY_INJECT_BLOCKS     CONTEXT.md から注入する先頭ブロック数（既定 1）
set -uo pipefail
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# userConfig（プラグイン設定 GUI）→ 環境変数の配線。明示的な MEMORY_DIRS が優先。
if [ -z "${MEMORY_DIRS:-}" ] && [ -n "${CLAUDE_PLUGIN_OPTION_memory_dirs:-}" ]; then
  export MEMORY_DIRS="${CLAUDE_PLUGIN_OPTION_memory_dirs}"
fi
# 索引DBは plugin 更新で消えない場所（CLAUDE_PLUGIN_DATA）に置く。再構築可能な「影」。
export MEMORY_INDEX_DB="${MEMORY_INDEX_DB:-${CLAUDE_PLUGIN_DATA:-$ROOT/memory_system}/memory_index.db}"

# stdin の JSON から source（startup/resume/clear/compact）を読む。失敗しても続行。
SOURCE="$(python3 -c 'import json,sys; print(json.load(sys.stdin).get("source",""))' 2>/dev/null || true)"

python3 "$ROOT/memory_system/index_memory.py" reindex >/dev/null 2>&1 || true

if [ "${MEMORY_INJECT:-1}" != "0" ]; then
  BRIEF=""
  # compact 直後はサマリに直近文脈が残っているため、スキル案内のみの短縮注入
  [ "$SOURCE" = "compact" ] && BRIEF="--brief"
  python3 "$ROOT/memory_system/session_context.py" $BRIEF 2>/dev/null || true
fi
exit 0
