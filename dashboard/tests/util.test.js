'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { nowIso, json, resolveSafe, isHostAllowed, serveStatic } = require('../lib/util');

// res をモックして writeHead/end の引数を捕捉する。
function mockRes() {
  return {
    statusCode: null, headers: null, body: null, ended: false,
    writeHead(code, headers) { this.statusCode = code; this.headers = headers; },
    end(body) { this.body = body; this.ended = true; }
  };
}

test('nowIso: ISO8601 文字列を返す', () => {
  assert.match(nowIso(), /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
});

test('json: ステータス・Content-Type・no-cache・本文を書く', () => {
  const res = mockRes();
  json(res, 201, { ok: true });
  assert.equal(res.statusCode, 201);
  assert.equal(res.headers['Content-Type'], 'application/json; charset=utf-8');
  assert.match(res.headers['Cache-Control'], /no-store/);
  assert.deepEqual(JSON.parse(res.body), { ok: true });
});

test('resolveSafe: baseDir 配下のパスは許可', () => {
  const base = '/srv/data';
  assert.equal(resolveSafe(base, 'a.md'), path.resolve(base, 'a.md'));
  assert.equal(resolveSafe(base, 'sub/b.md'), path.resolve(base, 'sub/b.md'));
});

test('resolveSafe: baseDir 自身も許可', () => {
  const base = '/srv/data';
  assert.equal(resolveSafe(base, '.'), path.resolve(base));
});

test('resolveSafe: ディレクトリトラバーサルは例外', () => {
  const base = '/srv/data';
  assert.throws(() => resolveSafe(base, '../etc/passwd'), /path_outside_base/);
  assert.throws(() => resolveSafe(base, '../../secret'), /path_outside_base/);
  assert.throws(() => resolveSafe(base, '/etc/passwd'), /path_outside_base/);
});

test('resolveSafe: 接頭辞が一致する別ディレクトリは弾く（/srv/data-evil）', () => {
  // /srv/data の文字列前方一致だが別ディレクトリ。startsWith(base+sep) で正しく拒否されること。
  assert.throws(() => resolveSafe('/srv/data', '../data-evil/x'), /path_outside_base/);
});

test('isHostAllowed: 空リストは全許可', () => {
  assert.equal(isHostAllowed('anything.com', []), true);
  assert.equal(isHostAllowed('anything.com', null), true);
});

test('isHostAllowed: リスト一致を許可・不一致を拒否（ポート無視・大小無視）', () => {
  const allow = ['localhost', '127.0.0.1', 'dash.local'];
  assert.equal(isHostAllowed('localhost:8080', allow), true);
  assert.equal(isHostAllowed('127.0.0.1', allow), true);
  assert.equal(isHostAllowed('DASH.LOCAL:9000', allow), true);
  assert.equal(isHostAllowed('evil.com', allow), false);
  assert.equal(isHostAllowed('', allow), false);
  assert.equal(isHostAllowed(undefined, allow), false);
});

test('serveStatic: 存在しないファイルは 404(JSON)', async () => {
  const res = mockRes();
  await serveStatic(res, '/nonexistent-dir-xyz', 'nope.html');
  assert.equal(res.statusCode, 404);
  assert.equal(JSON.parse(res.body).error, 'static_file_not_found');
});
