'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const { resolveAgentKey, cleanText, extractUserText, parseTitleLine, pickSessionTitle } = require('../lib/titles');

const KEYS = ['alpha', 'bravo', 'charlie', 'lead'];

test('resolveAgentKey: <key>/workspace の親ディレクトリを採用', () => {
  assert.equal(resolveAgentKey('/work/proj/alpha/workspace', KEYS), 'alpha');
  assert.equal(resolveAgentKey('/x/lead/workspace', KEYS), 'lead');
});

test('resolveAgentKey: workspace の親を見るので配下のサブディレクトリでも解決できる', () => {
  // lastIndexOf('workspace') の親 = alpha。cwd が workspace 配下でも親が key なら解決する。
  assert.equal(resolveAgentKey('/x/alpha/workspace/src', KEYS), 'alpha');
});

test('resolveAgentKey: 末尾セグメントが key の場合', () => {
  assert.equal(resolveAgentKey('/some/path/bravo', KEYS), 'bravo');
});

test('resolveAgentKey: どの key にも当たらなければ null', () => {
  assert.equal(resolveAgentKey('/tmp/random/place', KEYS), null);
  assert.equal(resolveAgentKey('', KEYS), null);
  assert.equal(resolveAgentKey(null, KEYS), null);
});

test('resolveAgentKey: workspace 親が優先（包含より厳密一致が勝つ）', () => {
  // パスに alpha と charlie 両方が含まれても、workspace の親が charlie なら charlie。
  assert.equal(resolveAgentKey('/alpha/sub/charlie/workspace', KEYS), 'charlie');
});

test('cleanText: system-reminder ブロックを空白に置換', () => {
  // SR ブロックは ' ' に置換され、内部空白は保持される（collapse しない）。
  assert.equal(cleanText('hello <system-reminder>secret\nblock</system-reminder> world'), 'hello   world');
});

test('cleanText: タグ除去と trim', () => {
  assert.equal(cleanText('  <b>hi</b>  '), 'hi');
  assert.equal(cleanText('<x>a</x>b'), 'a b');
});

test('extractUserText: user ロールの文字列 content を返す', () => {
  assert.equal(extractUserText({ type: 'user', message: { role: 'user', content: 'やあ' } }), 'やあ');
  assert.equal(extractUserText({ role: 'user', content: 'hi' }), 'hi');
});

test('extractUserText: user 以外は空', () => {
  assert.equal(extractUserText({ type: 'assistant', message: { role: 'assistant', content: 'no' } }), '');
  assert.equal(extractUserText({ type: 'ai-title', aiTitle: 'x' }), '');
});

test('extractUserText: 配列 content からタグ始まりブロックを除外して結合', () => {
  const obj = { role: 'user', content: [
    { type: 'text', text: '<system-reminder>ctx</system-reminder>' },
    { type: 'text', text: '本題です' }
  ] };
  assert.equal(extractUserText(obj), '本題です');
});

test('parseTitleLine: ai-title / custom-title を抽出', () => {
  assert.deepEqual(parseTitleLine('{"type":"ai-title","aiTitle":"自動名"}'), { aiTitle: '自動名' });
  assert.deepEqual(parseTitleLine('{"type":"custom-title","customTitle":"手動名"}'), { customTitle: '手動名' });
});

test('parseTitleLine: 関係ない行・壊れた JSON は null', () => {
  assert.equal(parseTitleLine('{"type":"user","message":{}}'), null);
  assert.equal(parseTitleLine('これは title という語を含むが JSON ではない'), null);
  assert.equal(parseTitleLine('{"type":"ai-title" 壊れ'), null);
});

test('pickSessionTitle: custom > ai > first の優先順', () => {
  assert.equal(pickSessionTitle({ customTitle: 'C', aiTitle: 'A', first: 'F' }), 'C');
  assert.equal(pickSessionTitle({ aiTitle: 'A', first: 'F' }), 'A');
  assert.equal(pickSessionTitle({ first: 'F' }), 'F');
  assert.equal(pickSessionTitle({}), '');
  assert.equal(pickSessionTitle(), '');
});
