#!/usr/bin/env bash
# 公開前ガード: git 追跡ファイルに「秘密・固有情報」が混入していないか検査する。
# 公開/スクショ/配布の前、および CI で実行する。混入を検出したら exit 1。
#
# パターンは2系統:
#   1) 汎用（このスクリプトに同梱）: APIキー・秘密鍵など、どの組織でも秘密になるもの。
#   2) 組織固有（scripts/secret_patterns.local）: 自社のプロダクト名・人物名・固有IP等。
#      このファイルは .gitignore 済み（公開リポにはコミットしない）。1行1正規表現・# でコメント。
# ※ 会社名（LICENSE / author の著作権表示）は意図的に許容する。
set -uo pipefail
cd "$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

# 1) 汎用パターン（秘密鍵・各種APIトークン）
PATTERNS='sk-ant-[A-Za-z0-9_-]{8,}|AKIA[0-9A-Z]{16}|ghp_[A-Za-z0-9]{30,}|xox[baprs]-[0-9A-Za-z-]{10,}|-----BEGIN [A-Z ]*PRIVATE KEY-----'

# 2) 組織固有パターン（あれば追加）
LOCAL="scripts/secret_patterns.local"
if [ -f "$LOCAL" ]; then
  extra=$(grep -vE '^[[:space:]]*(#|$)' "$LOCAL" | paste -sd '|' -)
  [ -n "$extra" ] && PATTERNS="$PATTERNS|$extra"
fi

hits=$(git ls-files -z 2>/dev/null \
  | grep -zv 'scripts/check_no_secrets.sh' \
  | xargs -0 grep -nEI "$PATTERNS" 2>/dev/null || true)

if [ -n "$hits" ]; then
  echo "❌ 公開不可: 秘密/固有情報が追跡ファイルに混入しています:"
  echo "$hits"
  exit 1
fi
echo "✅ クリーン: 追跡ファイルに秘密/固有情報は検出されませんでした。"
