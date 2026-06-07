---
name: codex-review
description: Run a second-opinion code review (or image/screenshot review) via the OpenAI Codex CLI. Use when the user wants an independent review of a diff, files, or a screenshot from a different model, asks to "codexにレビューさせて", or wants to cross-check work with a non-Claude engine.
---

# Codex Review — 別エンジンのセカンドオピニオン

OpenAI Codex CLI を「別の頭脳のレビュアー」として呼ぶ。Claude（自分）とは違う視点が欲しいとき、画像（スクショ）レビューをしたいときに使う。

## 前提
- `codex` が PATH にあり、`codex login`（ChatGPT認証）済みであること。未認証なら `codex login` をユーザーに案内する。
- コスト: ChatGPT アカウントの枠を消費する（無料枠の外＝別財布）。乱用しない・対象を絞る。

## 使い方

### diff のレビュー
```bash
git diff | codex exec --sandbox read-only "このdiffをレビュー。バグ・設計・改善点を重要度順に簡潔に。"
```

### コードレビュー専用サブコマンド（非対話）
```bash
codex review
```

### 特定ファイル / 画像（スクショ）のレビュー
```bash
codex exec --sandbox read-only "<ファイルパスや画像パス> を見てレビュー: <観点>"
```
Codex は画像入力(vision)対応。UIスクショを渡して見た目/UXレビューも可能。

## 運用ルール
- レビューは書き換え不要なので必ず `--sandbox read-only`。
- Codex の生出力をそのまま貼らず、要点を整理してユーザーへ渡す。
- 入力が大きすぎる場合は対象ファイル/範囲を絞る。
- 「無料で済む軽い処理」は ask-local（ローカルLLM）へ、質・別視点・画像は本skillへ。
