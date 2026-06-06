#!/usr/bin/env bash
# セッションのアーカイブ/復元。
# 実体 jsonl を projects <-> projects-archive で移動するだけ（中身は不変・完全可逆）。
# 稼働中(pid生存)のセッションは archive-all の対象から自動除外する。
set -uo pipefail

PROJ_ROOT="$HOME/.claude/projects"
ARC_ROOT="$HOME/.claude/projects-archive"
FOLDER="-mnt-c-Users-dbtnrobo-Desktop-AI-workspace-agent-setup-secretary-workspace"
PROJ="$PROJ_ROOT/$FOLDER"
ARC="$ARC_ROOT/$FOLDER"

live_ids() {
  for f in "$HOME"/.claude/sessions/*.json; do
    [ -f "$f" ] || continue
    python3 - "$f" <<'PY'
import json, os, sys
try:
    d = json.load(open(sys.argv[1]))
    pid, sid = d.get("pid"), d.get("sessionId")
    if pid and sid and os.path.exists(f"/proc/{pid}"):
        print(sid)
except Exception:
    pass
PY
  done
}

case "${1:-}" in
  archive-all)
    mkdir -p "$ARC"
    mapfile -t LIVE < <(live_ids)
    moved=0
    for f in "$PROJ"/*.jsonl; do
      [ -f "$f" ] || continue
      id=$(basename "$f" .jsonl)
      skip=0
      for l in "${LIVE[@]:-}"; do [ "$id" = "$l" ] && skip=1; done
      [ "$skip" -eq 1 ] && continue
      mv "$f" "$ARC/" && moved=$((moved + 1))
    done
    echo "archived $moved files → $ARC"
    echo "active残: $(ls "$PROJ"/*.jsonl 2>/dev/null | wc -l) / archive計: $(ls "$ARC"/*.jsonl 2>/dev/null | wc -l)"
    ;;
  restore)
    id="${2:?usage: $0 restore <sessionId>}"
    src="$ARC/$id.jsonl"
    [ -f "$src" ] || { echo "not in archive: $id"; exit 1; }
    mv "$src" "$PROJ/"
    echo "restored $id → active"
    echo "resume: claude --resume $id --dangerously-skip-permissions"
    ;;
  *)
    echo "usage: $0 {archive-all | restore <sessionId>}"
    exit 1
    ;;
esac
