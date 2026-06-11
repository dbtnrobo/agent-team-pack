---
name: memory-gc
description: Review and consolidate persistent memory using the LLM-free inventory report (stale blocks, near-duplicate pairs, oversized files). Use when the user asks to clean up/organize memory ("記憶を整理して"), when remember is rejected for file size, or periodically (e.g. monthly).
---

# Memory GC（記憶の棚卸し）

溜まった記憶の重複・陳腐化を整理し、検索品質を保つ。**候補列挙はローカルツール（課金ゼロ）、統合の判断と実行だけをこのセッション内で行う**。

## いつ使うか
- ユーザーが「記憶を整理して」と言ったとき
- remember がファイル上限で保存を拒否したとき
- 月1回程度の定期メンテナンス

## 手順

### 1. レポートを取得
```bash
python3 "${CLAUDE_PLUGIN_ROOT}/memory_system/memory_report.py" --stale-days 90
```
（`MEMORY_DIRS` 未設定なら `MEMORY_DIRS="${user_config.memory_dirs}"` を付ける）

### 2. 候補ごとに判断する
| カテゴリ | 対応 |
|---|---|
| **重複候補ペア** | 内容を読み比べ、新しい方に統合して古い方を消す（memory_write.py の replace で新しい方を更新 → 古いブロックは Edit で削除可） |
| **stale（90日以上未更新）** | まだ正しい→そのまま。状況が変わった→replace で更新。もう不要→削除 |
| **肥大ファイル** | テーマ別に分割するか、ブロックを統合して圧縮 |

### 3. 整理の原則
- **削除より統合を優先**（情報を失わずに圧縮する）
- 迷ったら削除せず、ユーザーに「この記憶はまだ有効か」を確認する
- 矛盾する2つの記憶を見つけたら、必ずどちらが現在正しいかを確認してから片方に寄せる

### 4. 最後に再索引
```bash
python3 "${CLAUDE_PLUGIN_ROOT}/memory_system/index_memory.py" reindex
```

### 5. ユーザーに報告
統合・更新・削除した件数と内容の要約を伝える。
