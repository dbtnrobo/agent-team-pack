#!/usr/bin/env bash
# agent-team-pack のアンインストール。
# プラグインとマーケットプレイス登録を外す。ユーザーデータ（記憶md・セッション・
# アーカイブ）は一切削除しない（場所を案内するだけ・安全側）。
set -uo pipefail

echo "▶ プラグインを無効化・削除"
claude plugin uninstall agent-team-pack@doubutuen-agent-tools 2>/dev/null \
  || claude plugin uninstall agent-team-pack 2>/dev/null \
  || echo "  （プラグインは未導入か、すでに削除済み）"

echo "▶ マーケットプレイス登録を削除"
claude plugin marketplace remove doubutuen-agent-tools 2>/dev/null \
  || echo "  （マーケットプレイスは未登録か、すでに削除済み）"

cat <<'MSG'

✅ アンインストール完了。

以下は削除していません（必要なら手動で）:
  - このリポジトリのディレクトリ自体（git clone したもの）
  - 記憶md（MEMORY_DIRS で指定した場所。あなたのデータです）
  - 索引DB（~/.claude/plugins/data/ 配下の memory_index.db。md から再構築可能な影）
  - セッション・アーカイブ（~/.claude/projects, ~/.claude/projects-archive）
MSG
