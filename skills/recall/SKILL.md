---
name: recall
description: Search persistent memory (local FTS5 index, Japanese OK, zero API cost) before starting work, when the user references past decisions/projects ("前にどう決めた?", "覚えてる?"), or when context seems missing. Falls back to grepping session transcripts when memory has no hit.
---

# Recall（記憶の想起）

永続記憶を検索して過去の決定・文脈を取り戻す。**ローカルFTS5のみ＝追加課金ゼロ**。

## いつ使うか
- 作業を始める前に、関連する過去の決定・経緯がないか確認するとき
- ユーザーが過去の話題・決定・プロジェクトに言及したとき（「前にどう決めた？」「覚えてる？」）
- セッションをまたいで文脈が欠けていると感じたとき

## 手順

### 1. 記憶を検索する
```bash
python3 "${CLAUDE_PLUGIN_ROOT}/memory_system/index_memory.py" search "クエリ" -n 5 --json
```
- `MEMORY_DIRS` が環境に無い場合のみ、プラグイン設定値を付ける:
  `MEMORY_DIRS="${user_config.memory_dirs}"`（空なら付けない＝既定 `~/.claude`）
- クエリは固有名詞・プロジェクト名・決定事項のキーワードを使う。日本語は3文字以上が高精度（2文字でも部分一致で動く）

### 2. 結果を評価する
- 各ヒットの `date` を確認し、**古い記憶（数ヶ月前）は現状と食い違う可能性を前提に扱う**。矛盾を見つけたら remember で更新する
- 必要なら `source` の md を Read で全文確認する
- 0件なら**言い換えて1回だけ再検索**（例:「認証」→「ログイン」）

### 3. 記憶に無ければセッションログを掘る
記憶mdに保存されていない過去の会話は、transcript を直接検索できる:
```bash
grep -rliF --include='*.jsonl' -- "キーワード" ~/.claude/projects/ | head -5
```
ヒットした sessionId（ファイル名）は `claude --resume <sessionId>` で再開できる旨をユーザーに伝える。

## 運用ルール
- 検索結果は事実として盲信せず、日付と文脈を確認してから使う
- 想起した内容が今の判断に効いた場合、その旨をユーザーへの返答で一言触れる（透明性）
