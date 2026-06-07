---
name: ask-local
description: Send a quick, cheap, or privacy-sensitive task to the local LLM (Ollama, free/offline). Use for summarization, classification, drafting, or bulk/iterative processing where top quality isn't required and you want zero API cost or to keep data local. Not for tasks needing best quality or critical judgment.
---

# Ask Local LLM (Ollama)

ローカルの無料LLM（Ollama）に軽いタスクを投げる。**コスト0・データを外部APIに出さない・速度不要なバッチ向け**。質が要る/画像/別視点は codex-review か Claude 本体を使う。

## 前提
- `ollama serve` が `127.0.0.1:11434` で稼働していること。落ちていれば起動を案内（`LD_LIBRARY_PATH=$HOME/.local/lib/ollama ollama serve`）。
- 既定モデル: `qwen3:14b`（CPUで約2 tok/s＝遅い）。速度優先なら軽量モデル（`qwen3:8b`/`4b`）に差し替え可。

## 使い方（API・thinking無効が必須）
qwen3 は thinking を切らないと延々と推論して終わらない。**必ず `"think": false`** を付ける:
```bash
curl -s http://127.0.0.1:11434/api/generate -d '{"model":"qwen3:14b","prompt":"<タスク>","think":false,"stream":false}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin)['response'])"
```

## 運用ルール
- 速度不要・低リスクのタスクに限定（要約・分類・下書き・大量反復）。
- 機密データを外部API（Claude/Codex）に出したくないときの選択肢。
- 出力品質は中程度。重要な判断はローカルに委ねない。
- 遅いので大きな入力はチャンクに分けるか、対象を絞る。
