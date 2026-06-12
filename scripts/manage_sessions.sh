#!/usr/bin/env bash
# セッションのアーカイブ/復元（CLI）。
# jsonl を projects <-> projects-archive で移動するだけ（中身は不変・完全に可逆）。
# 稼働中(pid生存)のセッションは対象から自動除外する。
# パスは環境変数で上書き可:
#   PROJ_ROOT  既定 ~/.claude/projects
#   ARC_ROOT   既定 ~/.claude/projects-archive
set -uo pipefail

PROJ_ROOT="${PROJ_ROOT:-$HOME/.claude/projects}"
ARC_ROOT="${ARC_ROOT:-$HOME/.claude/projects-archive}"

live_ids() {
  for f in "$HOME"/.claude/sessions/*.json; do
    [ -f "$f" ] || continue
    python3 - "$f" <<'PY'
import json, os, sys

def alive(pid):
    # kill(pid, 0) はシグナルを送らず生存確認のみ（macOS/Linux両対応）
    try:
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True

try:
    d = json.load(open(sys.argv[1])); pid, sid = d.get("pid"), d.get("sessionId")
    if pid and sid and alive(int(pid)):
        print(sid)
except Exception:
    pass
PY
  done
}

is_live() { live_ids | grep -qx "$1"; }

# <root>/*/<id>.jsonl を探してパスを返す
find_file() {
  local root="$1" id="$2" f
  for d in "$root"/*/; do
    f="$d$id.jsonl"
    [ -f "$f" ] && { echo "$f"; return 0; }
  done
  return 1
}

move_one() { # src を <destRoot>/<元フォルダ名>/ へ
  local src="$1" destRoot="$2" folder
  folder=$(basename "$(dirname "$src")")
  mkdir -p "$destRoot/$folder"
  mv "$src" "$destRoot/$folder/"
}

case "${1:-}" in
  archive-all)
    # mapfile は bash 4+ のため、macOS 標準 bash 3.2 でも動く while-read で読む
    LIVE=()
    while IFS= read -r l; do [ -n "$l" ] && LIVE+=("$l"); done < <(live_ids)
    moved=0
    for d in "$PROJ_ROOT"/*/; do
      [ -d "$d" ] || continue
      for f in "$d"*.jsonl; do
        [ -f "$f" ] || continue
        id=$(basename "$f" .jsonl); skip=0
        for l in "${LIVE[@]:-}"; do [ "$id" = "$l" ] && skip=1; done
        [ "$skip" -eq 1 ] && continue
        move_one "$f" "$ARC_ROOT" && moved=$((moved + 1))
      done
    done
    echo "archived $moved files → $ARC_ROOT"
    ;;
  archive)
    id="${2:?usage: $0 archive <sessionId>}"
    is_live "$id" && { echo "refuse: $id は稼働中（退避しない）"; exit 1; }
    src=$(find_file "$PROJ_ROOT" "$id") || { echo "not active: $id"; exit 1; }
    move_one "$src" "$ARC_ROOT"; echo "archived $id"
    ;;
  restore)
    id="${2:?usage: $0 restore <sessionId>}"
    src=$(find_file "$ARC_ROOT" "$id") || { echo "not in archive: $id"; exit 1; }
    move_one "$src" "$PROJ_ROOT"; echo "restored $id → active"
    ;;
  *)
    echo "usage: $0 {archive-all | archive <sessionId> | restore <sessionId>}"
    exit 1
    ;;
esac
