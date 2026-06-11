'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { readPins, togglePin, scanSessions } = require('../lib/sessions');

let TMP;
const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const UUID_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const UUID_C = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';

before(async () => {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'pins-test-'));
});
after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true });
});

async function makeSession(root, project, id, mtimeOffsetSec) {
  const dir = path.join(root, project);
  await fsp.mkdir(dir, { recursive: true });
  const fp = path.join(dir, `${id}.jsonl`);
  await fsp.writeFile(fp, JSON.stringify({ cwd: '/w' }) + '\n'
    + JSON.stringify({ type: 'user', message: { role: 'user', content: `s-${id.slice(0, 4)}` } }) + '\n');
  const t = new Date(Date.now() - mtimeOffsetSec * 1000);
  await fsp.utimes(fp, t, t);
  return fp;
}

test('togglePin: 往復でピン→解除、ファイルに永続化', async () => {
  const pf = path.join(TMP, 'pins1.json');
  assert.equal(await togglePin(pf, UUID_A), true);
  assert.deepEqual([...(await readPins(pf))], [UUID_A]);
  assert.equal(await togglePin(pf, UUID_A), false);
  assert.deepEqual([...(await readPins(pf))], []);
});

test('readPins: ファイル無し・壊れたJSONは空集合', async () => {
  assert.equal((await readPins(path.join(TMP, 'nope.json'))).size, 0);
  const bad = path.join(TMP, 'bad.json');
  await fsp.writeFile(bad, '{not json');
  assert.equal((await readPins(bad)).size, 0);
});

test('scanSessions: ピン留めが先頭に来る', async () => {
  const root = path.join(TMP, 'root1');
  await makeSession(root, '-proj-x', UUID_A, 300); // 古い
  await makeSession(root, '-proj-x', UUID_B, 10);  // 新しい
  const r = await scanSessions(root, 60, null, { pins: new Set([UUID_A]) });
  assert.equal(r.sessions[0].sessionId, UUID_A); // 古くてもピンが先頭
  assert.equal(r.sessions[0].pinned, true);
  assert.equal(r.sessions[1].pinned, false);
});

test('scanSessions: ピン留めは limit から漏れても含まれる', async () => {
  const root = path.join(TMP, 'root2');
  await makeSession(root, '-proj-x', UUID_A, 999); // 一番古い＝limit外
  await makeSession(root, '-proj-x', UUID_B, 10);
  await makeSession(root, '-proj-x', UUID_C, 20);
  const r = await scanSessions(root, 2, null, { pins: new Set([UUID_A]) });
  assert.ok(r.sessions.some((s) => s.sessionId === UUID_A && s.pinned));
});

test('scanSessions: project フィルタで絞り込み・projects 一覧を返す', async () => {
  const root = path.join(TMP, 'root3');
  await makeSession(root, '-proj-x', UUID_A, 10);
  await makeSession(root, '-proj-y', UUID_B, 20);
  const all = await scanSessions(root, 60, null, {});
  assert.deepEqual(all.projects, ['-proj-x', '-proj-y']);
  const only = await scanSessions(root, 60, null, { project: '-proj-y' });
  assert.equal(only.sessions.length, 1);
  assert.equal(only.sessions[0].sessionId, UUID_B);
  assert.deepEqual(only.projects, ['-proj-x', '-proj-y']); // 一覧は全プロジェクト
});
