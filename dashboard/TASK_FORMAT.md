# タスクファイル フォーマット仕様

ダッシュボードが `shared/tasks/*.md` を読む際の正本仕様。
本書の仕様に外れたファイルはダッシュボードでスキップ／警告される。

## 1. ファイル名

`task_{連番3桁}_{slug}.md`

例: `task_009_nameo_youtube_pipeline.md`

- 連番はゼロ埋め3桁
- slug は半角英数とアンダースコアのみ
- 拡張子は `.md`（小文字）

## 2. 構造

```markdown
---
id: task_009
title: タスクのタイトル
status: pending
assigned_to: jet
priority: medium
created: 2026-04-18
deliverable: nameo/workspace/output/videos/
blocked_by: [task_008]
updated: 2026-04-19T08:30:00+09:00
---

# 本文（Markdown 自由記述）
```

`---` で囲まれた YAML フロントマターと、それ以降の本文Markdownで構成する。

## 3. フィールド仕様

| キー | 必須 | 型 | 値 | 備考 |
|------|------|------|------|------|
| `id` | ◯ | string | `task_NNN` | ファイル名と一致させる |
| `title` | ◯ | string | 自由文 | 一行で完結させる |
| `status` | ◯ | enum | `pending` / `in_progress` / `completed` / `blocked` | これ以外は `pending` 扱い |
| `assigned_to` | ◯ | enum | `jet` / `nameo` / `shark` / `secretary` | `config.json` の `agents` キー |
| `priority` | ◯ | enum | `high` / `medium` / `low` | これ以外は `low` 扱い |
| `created` | ◯ | date | `YYYY-MM-DD` | 作成日 |
| `deliverable` | △ | string | パス文字列 | 設定時のみカードに表示／コピー対象 |
| `blocked_by` | △ | array | `[task_001, task_002]` | 1件でもあれば視覚的にブロック表示 |
| `updated` | △ | datetime | ISO8601 推奨 | 未指定時はファイル mtime をフォールバック |

`◯` = 必須、`△` = 任意。

### 旧フィールドとの互換

- `assignee` は読み込み互換のために許容するが、新規ファイルでは `assigned_to` を使う。
- ログビューア廃止（2026-04-19）に伴い、`logPath` は使用しない。

## 4. ステータス遷移

```
pending ─┬─► in_progress ─► completed
         └─► blocked ─► pending（依存解消後）
```

- `blocked` または `blocked_by` が非空のタスクは heartbeat の起動候補から除外される
- `completed` のタスクはサマリの完了率にカウントされる

## 5. heartbeat 対象判定

ダッシュボードと `heartbeat.sh` は次の条件で「未着手の起動候補」を抽出する。

```
status == "pending"
AND assigned_to が設定済み
AND blocked_by が空
```

## 6. 良い例

```markdown
---
id: task_010
title: ダッシュボードのアクセス制限ドキュメント整備
status: pending
assigned_to: jet
priority: medium
created: 2026-04-19
deliverable: shared/dashboard/README.md
---

# タスク概要

Tailscale 経由のアクセスを README に明記する。
```

## 7. 悪い例とエラー挙動

| 例 | 挙動 |
|-----|------|
| YAML フロントマター欠落 | UI に警告。当該ファイルはスキップ。前回成功時の値があれば継続表示 |
| `status` に未知の値 | `pending` 扱いで描画 |
| `assigned_to` 未設定 | heartbeat 対象から除外、UI では `unassigned` 表示 |
| `priority` に未知の値 | `low` 扱い |
| `deliverable` に絶対パス | そのまま表示／コピー（パス検証はしない） |

## 8. 自動同期との関係（task_008 連携）

`TaskCreate` / `TaskUpdate` フックが整備された後は、本フォーマットに沿った Markdown が自動生成・更新される予定。
それ以前に手動で編集する場合も、本書のフィールド名と enum を守れば矛盾は発生しない。
