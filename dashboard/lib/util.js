'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

// 静的ファイルの拡張子 → Content-Type 対応表。
const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

const NO_CACHE = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0'
};

/** 現在時刻の ISO8601 文字列。 */
function nowIso() {
  return new Date().toISOString();
}

/**
 * JSON レスポンスを返す（キャッシュ無効ヘッダ付き）。
 * @param {http.ServerResponse} res
 * @param {number} statusCode
 * @param {object} payload
 */
function json(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8', ...NO_CACHE });
  res.end(body);
}

/**
 * baseDir 配下に収まるパスだけを許可する（ディレクトリトラバーサル防止）。
 * 解決後のパスが baseDir 自身か、その配下でなければ例外を投げる。
 * @param {string} baseDir 基準ディレクトリ
 * @param {string} relativePath 結合する相対パス
 * @returns {string} 安全に解決した絶対パス
 * @throws {Error} baseDir の外に出る場合
 */
function resolveSafe(baseDir, relativePath) {
  const resolved = path.resolve(baseDir, relativePath);
  const baseResolved = path.resolve(baseDir);
  const withSep = baseResolved.endsWith(path.sep) ? baseResolved : baseResolved + path.sep;
  if (resolved !== baseResolved && !resolved.startsWith(withSep)) {
    throw new Error(`path_outside_base: ${relativePath}`);
  }
  return resolved;
}

/**
 * Host ヘッダが許可リストに含まれるか判定する（DNS リバインディング等への最小防御）。
 * allowedHosts が空なら全許可。hostHeader 未指定は拒否。ポートは無視して比較する。
 * @param {string} hostHeader リクエストの Host ヘッダ
 * @param {string[]} allowedHosts 許可ホスト名一覧
 * @returns {boolean}
 */
function isHostAllowed(hostHeader, allowedHosts) {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  if (!hostHeader) return false;
  const hostname = String(hostHeader).split(':')[0].toLowerCase();
  return allowedHosts.map((h) => String(h).toLowerCase()).includes(hostname);
}

/**
 * baseDir 直下の静的ファイルを配信する。読めなければ 404(JSON)。
 * fileName は呼び出し側で許可済み（PUBLIC_FILES）の固定名のみを渡す前提。
 * @param {http.ServerResponse} res
 * @param {string} baseDir 配信ルート
 * @param {string} fileName 配信するファイル名
 */
async function serveStatic(res, baseDir, fileName) {
  const filePath = path.join(baseDir, fileName);
  const ext = path.extname(filePath);
  try {
    const content = await fsp.readFile(filePath);
    res.writeHead(200, { 'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream', ...NO_CACHE });
    res.end(content);
  } catch (_error) {
    json(res, 404, { error: 'static_file_not_found', message: `${fileName} を読み取れません。`, timestamp: nowIso() });
  }
}

module.exports = { CONTENT_TYPES, nowIso, json, resolveSafe, isHostAllowed, serveStatic };
