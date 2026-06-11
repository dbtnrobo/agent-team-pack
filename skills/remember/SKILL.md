---
name: remember
description: Save a durable fact, design decision, or user preference to persistent memory (markdown + auto reindex, zero API cost). Use when the user says "覚えておいて"/"メモして", when a design decision is made, or when you learn something future sessions will need. Searches first and updates in place instead of duplicating.
---

# Remember（記憶の保存）

恒久的に残すべき事実を記憶mdに保存する。**書き込みは必ず CLI 経由**（重複拒否・字数上限・日付規約を機械的に強制するため、mdを直接編集しない）。

## 何を残すか / 残さないか
| 残す | 残さない |
|---|---|
| 設計・方針の決定と**その理由** | 一時的な作業状態（→ CONTEXT.md へ） |
| ユーザーの好み・作業スタイル | コードやgit履歴から分かること |
| 恒久的な事実・制約・環境情報 | 秘密情報（トークン・パスワード等）**絶対禁止** |

## 手順

### 1. 必ず先に検索する（重複防止の要）
```bash
python3 "${CLAUDE_PLUGIN_ROOT}/memory_system/index_memory.py" search "保存したい内容のキーワード" -n 5 --json
```
- **既存ブロックが同じテーマを扱っていたら、新規追加せず手順3の replace で更新する**
- 既存と矛盾する場合も replace（古い記述を残さない）

### 2. 新規なら append
```bash
python3 "${CLAUDE_PLUGIN_ROOT}/memory_system/memory_write.py" append \
  --file <記憶ディレクトリ>/<トピック>.md \
  --heading "YYYY-MM-DD <トピックの要約>" \
  --body "<事実。決定なら理由も1行で>"
```
- 保存先: `MEMORY_DIRS`（または `${user_config.memory_dirs}`）の先頭ディレクトリ。テーマ別の md があればそこへ、なければ新ファイル可
- **日付は絶対表記（YYYY-MM-DD）のみ。本文中も「昨日」「来週」禁止**（見出しに日付が無いと保存は拒否される）

### 3. 既存の更新なら replace
```bash
python3 "${CLAUDE_PLUGIN_ROOT}/memory_system/memory_write.py" replace \
  --file <既存md> --match "<既存見出しの一部>" \
  --heading "YYYY-MM-DD <更新後の要約>" --body "<更新後の内容>"
```

### 4. 拒否されたら従う（error-driven consolidation）
- 「同一内容が既に存在」→ 保存不要。終了
- 「ファイルが上限超過」→ 提示されたブロック一覧から古い・重複したものを replace で統合してから保存し直す。**上限を理由に保存を諦めない**

## 運用ルール
- 1事実 = 1ブロック。複数の事実を1ブロックに詰め込まない
- 保存したら、ユーザーへの返答で「○○を記憶に保存した」と一言触れる
