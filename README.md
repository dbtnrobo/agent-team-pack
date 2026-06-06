# agent-team-pack

Claude Code 等の CLI エージェントチームを **サブスク枠内（LLM API を直接叩かない・追加コストゼロ）** で運用するための基盤一式パッケージ。

すべての構成要素が **LLM を呼ばない**（ファイル読み・SQLite・grep・tmux のみ）ため、常時動かしても追加課金は発生しない。

![ダッシュボードのデモ（サンプルデータ）](docs/demo.gif)

> 監視ダッシュボードのデモ（表示はすべてサンプルデータ）。`dashboard/demo.html` をブラウザで開けば単体で確認できる。

## 収録物

```
agent-team-pack/
├ memory_system/   記憶層: Markdown 真実源 ＋ ローカル FTS5 検索インデックス
├ dashboard/       監視ダッシュボード: タスク/プロジェクト/セッション/検索 などを読み取り表示
└ scripts/         運用スクリプト: セッションのアーカイブ/復元 など
```

固有設定（ホスト・パス・チーム名）は `dashboard/config.json`（`.gitignore` 済み）に置く。
テンプレートは `dashboard/config.example.json`。

今後この器に **連携層(agmsg)** 等を順次追加していく。

## 導入（Claude Code プラグイン）

このリポジトリ自体が「マーケットプレイス＋プラグイン」になっている。クローンして bootstrap を実行：

```bash
git clone <this-repo> && cd agent-team-pack
bash install.sh         # 依存チェック → marketplace 登録 → plugin 導入
```

`install.sh` は `claude plugin marketplace add .` と `claude plugin install agent-team-pack@doubutuen-agent-tools` を行う。
プラグインは以下を提供する：

- **hooks**（`hooks/hooks.json`）: SessionStart/Stop で記憶を再索引＋CONTEXT ローテ（LLM非依存）。設定は環境変数 `MEMORY_DIRS` / `MEMORY_CONTEXT`（任意・未設定なら `~/.claude`）。
- **monitor**（experimental）: 監視ダッシュボードを背景プロセスで起動。既に tmux 等で `:8080` を起動している場合は `claude plugin disable agent-team-pack` で競合回避。

## 公開前チェック

固有情報の混入を防ぐガードを同梱。公開・スクショ・配布の前に必ず実行：

```bash
bash scripts/check_no_secrets.sh   # git追跡ファイルに APIキー/固有名 等が無いか検査
```

---

## 記憶層 (memory_system/)

CLI エージェントに永続記憶を与える軽量ライブラリ。**LLM を一切呼ばない**。

- **真実の源は Markdown**。SQLite + FTS5 は md から再構築可能な検索インデックス（影）。
- **日本語対応**: FTS5 trigram トークナイザ ＋ 2文字以下は LIKE フォールバック。
- **差分再索引**: SHA-256 ハッシュで変更チャンクだけ更新、消えた節は索引からも削除。
- **CONTEXT.md ローテーション**: 先頭（新しい）N ブロックを残し、古いブロックをアーカイブへ退避（肥大防止）。
- 依存は Python 標準 `sqlite3` のみ（FTS5 が有効な SQLite が必要）。

```bash
export MEMORY_DIRS="$HOME/.claude/memory:/path/to/workspace/memory"

python3 memory_system/index_memory.py reindex          # md を索引（差分のみ）
python3 memory_system/index_memory.py search "クエリ"    # 記憶を想起（日本語OK）
python3 memory_system/index_memory.py search "クエリ" --json   # ダッシュボード等から使う JSON 出力
python3 memory_system/rotate_context.py path/to/CONTEXT.md -n 5 # 先頭5ブロックを残す
```

Stop フック統合（任意）: セッション終了時に「ローテ＋再索引」を自動実行する。**フックは LLM を呼ばない**こと（要約等が必要なら常駐エージェント本体が pull 型で行う）。

## 監視ダッシュボード (dashboard/)

ブラウザでチーム状況を一望する read-only サーバー（Node 標準のみ・`GET`/`HEAD` 限定・**LLM 非依存**）。

- タブ: タスク / プロジェクト / skills / エージェント / **セッション** / **アーカイブ** / **検索** / ルール思想。
- **セッション**: resume 可能な会話を新しい順に一覧（resume コマンドをコピー可）。稼働中/過去を判定。
- **アーカイブ**: 退避したセッションを表示（復元コマンドをコピー可）。
- **検索**: 記憶（FTS5）/ セッション / 生ログ を横断検索。セッション検索は本物のセッションだけに絞り、active/archive に応じて resume/復元コマンドを出す。
- 主な API（すべて read-only）: `/api/tasks` `/api/projects` `/api/skills` `/api/agents` `/api/sessions` `/api/archive` `/api/memory-search` `/api/session-search` `/api/log-search`。

セットアップ:

```bash
cd dashboard
cp config.example.json config.json   # <...> の値を自分の環境に置き換える
node server.js                        # 既定 :8080（config.json の serverOnly で host/allowedHosts を制御）
```

### 触って試す（デモ）

サーバーを立てなくても、`dashboard/demo.html` をブラウザで開けば **サンプルデータ入り・各タブに使い方解説つき** の画面で全体像を確認できます（単体で動く自己完結 HTML。サーバー起動後は `http://<host>:8080/demo.html` でも閲覧可）。

### 使い方（タブ別）

| タブ | 何をする | 使い方 |
|---|---|---|
| **タスク** | `shared/tasks/*.md` を 未着手/進行中/完了 のカンバンで表示 | 担当(色チップ)・優先度・集計が一目で分かる |
| **プロジェクト** | `project_*.md` の進行中プロジェクト一覧 | 各カードの「🔍 関連セッションを探す」で、そのプロジェクトの過去セッションを検索タブに一発表示 |
| **skills** | 使える skill 一覧（`SKILL.md` の説明） | 何が呼べるかを一望 |
| **エージェント** | 誰が tmux 上で稼働中か | 稼働中/待機を確認 |
| **セッション** | resume できる会話を新しい順に表示（先頭に総数） | 「コピー」で resume コマンドを取得→貼れば続きから開く。稼働中/過去を判定 |
| **アーカイブ** | 退避済みセッション一覧 | 「復元コマンドをコピー」→実行で active に戻る。古いものは検索から掘る |
| **検索** | 記憶 / セッション / 生ログ を横断検索（LLM 非依存＝コストゼロ） | セッション検索は本物のセッションだけに絞り、active なら resume・archive なら復元コマンドを出す |
| **ルール / 思想** | 会社ルール・思想ドキュメントへの入口 | クリックで本文表示 |

> 操作系（タスク振り・起動ボタン等）は「キューに書くだけ」で LLM を呼ばない設計。read-only を守ることで常時表示しても追加コストはかからない。

## 運用スクリプト (scripts/)

```bash
# 稼働中以外のセッションをアーカイブへ退避（pid 生存セッションは自動除外）
bash scripts/manage_sessions.sh archive-all
# 退避したセッションを active に戻す
bash scripts/manage_sessions.sh restore <sessionId>
```

実体（`~/.claude/projects/<...>/<id>.jsonl`）を `~/.claude/projects-archive/` へ移動するだけ。中身は不変で完全に可逆。

## テスト

```bash
python3 -m pytest memory_system/tests/ -q
```

## ライセンス / 流用元

本体は **MIT**（Copyright (c) 2026 合同会社どうぶつえん）。`LICENSE` 参照。

組み込んでいる MIT ライセンスのコード（`THIRD_PARTY_LICENSES/` に全文）：

| ファイル | 流用元 | 内容 |
|---|---|---|
| `memory_system/vendored_chunker.py` | [zilliztech/memsearch](https://github.com/zilliztech/memsearch) (MIT) | md チャンク分割（無改変コピー） |
| `memory_system/fts_index.py` | [NousResearch/hermes-agent](https://github.com/NousResearch/hermes-agent) (MIT) | FTS5 スキーマ（unicode61＋CJK trigram）と CJK 検索ルーティングを改変流用 |
