'use strict';

// セッション/エージェントのタイトル・識別に関する純粋関数群。
// I/O を一切持たず、入力（文字列・parse済みオブジェクト）だけから結果を返す。
// → 副作用が無いので単体テストしやすく、表示ロジックの仕様をここに集約する。

/**
 * tmux ペインの cwd からエージェントキーを解決する。
 * Claude Code はペインタイトルを自分のもので上書きするため title では識別できない。
 * 各エージェントは <agentKey>/workspace で起動する前提で、workspace の親ディレクトリ名を
 * 最優先で採用する（厳密・誤識別しにくい）。無ければ末尾セグメント、最後にパス内一致へ
 * フォールバック。どれにも当たらなければ null（cd で作業ディレクトリを離れた場合など）。
 * @param {string} cwdPath ペインの現在ディレクトリ（絶対パス）
 * @param {string[]} keys config.agents のキー一覧
 * @returns {string|null} 解決したエージェントキー
 */
function resolveAgentKey(cwdPath, keys) {
  const segs = String(cwdPath || '').split('/').filter(Boolean);
  const wi = segs.lastIndexOf('workspace');
  if (wi > 0 && keys.includes(segs[wi - 1])) return segs[wi - 1];
  if (segs.length && keys.includes(segs[segs.length - 1])) return segs[segs.length - 1];
  return keys.find((k) => segs.includes(k)) || null;
}

/**
 * system-reminder ブロックや HTML/XML 風タグを除去して本文だけを残す。
 * @param {string} str 生テキスト
 * @returns {string} タグ除去後・trim 済みの本文
 */
function cleanText(str) {
  return String(str)
    .replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .trim();
}

/**
 * transcript の 1 レコード（parse 済み）から最初のユーザー発話本文を取り出す。
 * user ロール以外、または本文が無ければ空文字を返す。
 * 配列 content はタグ始まり（system-reminder 等）のブロックを除いて結合する。
 * @param {object} obj JSONL の 1 行を JSON.parse したオブジェクト
 * @returns {string} クリーンなユーザー発話（無ければ ''）
 */
function extractUserText(obj) {
  const m = (obj && obj.message) || obj || {};
  const role = m.role || (obj && obj.type);
  if (role !== 'user') return '';
  let c = m.content;
  if (Array.isArray(c)) {
    c = c.filter((x) => x && typeof x.text === 'string')
      .map((x) => x.text)
      .filter((t) => !t.trim().startsWith('<'))
      .join(' ');
  }
  if (typeof c !== 'string') return '';
  return cleanText(c);
}

/**
 * JSONL の 1 行からタイトルレコードを抽出する。
 * 先に安価な文字列マーカーで弾き、一致した行だけ JSON.parse する。
 * @param {string} line JSONL の 1 行
 * @returns {{aiTitle:string}|{customTitle:string}|null}
 */
function parseTitleLine(line) {
  if (!line.includes('"type":"ai-title"') && !line.includes('"type":"custom-title"')) return null;
  let o;
  try { o = JSON.parse(line); } catch (_e) { return null; }
  if (o.type === 'ai-title' && o.aiTitle) return { aiTitle: o.aiTitle };
  if (o.type === 'custom-title' && o.customTitle) return { customTitle: o.customTitle };
  return null;
}

/**
 * 表示タイトルの優先順位を決める。手動命名（/rename = custom）が最優先、
 * 次に Claude 自動生成（ai）、最後に最初のユーザー発話。
 * @param {{customTitle?:string, aiTitle?:string, first?:string}} parts
 * @returns {string}
 */
function pickSessionTitle({ customTitle, aiTitle, first } = {}) {
  return customTitle || aiTitle || first || '';
}

module.exports = { resolveAgentKey, cleanText, extractUserText, parseTitleLine, pickSessionTitle };
