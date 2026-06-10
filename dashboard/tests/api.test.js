'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { URL } = require('node:url');
const { handleApi } = require('../lib/api');

let TMP, taskDir, config;

before(async () => {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'api-test-'));
  taskDir = path.join(TMP, 'tasks');
  await fsp.mkdir(taskDir, { recursive: true });
  await fsp.writeFile(path.join(taskDir, 'task_001.md'), '# task one');
  await fsp.writeFile(path.join(taskDir, 'task_002.md'), '# task two');
  await fsp.writeFile(path.join(taskDir, 'ignore.txt'), 'not md');
  config = {
    siteTitle: 'T', agents: { alpha: { label: 'Alpha', color: '#111' } },
    taskDir, // baseDir からの相対 or 絶対。ここは絶対。
    serverOnly: { startCommands: { alpha: 'echo hi' }, dataSources: { docs: [{ label: 'D', path: '/allowed/doc.md' }] } }
  };
});
after(async () => { await fsp.rm(TMP, { recursive: true, force: true }); });

function mockRes() {
  return {
    statusCode: null, body: null,
    writeHead(code) { this.statusCode = code; },
    end(body) { this.body = body; }
  };
}
async function call(pathname, search = '') {
  const res = mockRes();
  const url = new URL(`http://x${pathname}${search}`);
  await handleApi({ method: 'GET', headers: {} }, res, config, url, TMP);
  return { status: res.statusCode, json: JSON.parse(res.body) };
}

test('/api/config: サニタイズ済み（serverOnly を含まない）', async () => {
  const r = await call('/api/config');
  assert.equal(r.status, 200);
  assert.equal('serverOnly' in r.json.config, false);
  assert.deepEqual(r.json.config.agents.alpha, { label: 'Alpha', color: '#111' });
});

test('/api/tasks: .md のみ・名前順', async () => {
  const r = await call('/api/tasks');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.files.map((f) => f.name), ['task_001.md', 'task_002.md']);
});

test('/api/start-command: 既知 agent は command・未知は 404', async () => {
  const ok = await call('/api/start-command', '?agent=alpha');
  assert.equal(ok.status, 200);
  assert.equal(ok.json.command, 'echo hi');
  const ng = await call('/api/start-command', '?agent=unknown');
  assert.equal(ng.status, 404);
});

test('/api/agents: panes 配列を返す（tmux 無し環境でも壊れない）', async () => {
  const r = await call('/api/agents');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.json.panes));
});

test('/api/docs: 一覧はパスとラベルのみ', async () => {
  const r = await call('/api/docs');
  assert.equal(r.status, 200);
  assert.deepEqual(r.json.docs, [{ label: 'D', path: '/allowed/doc.md' }]);
});

test('/api/docs: 許可リスト外のパスは 404', async () => {
  const r = await call('/api/docs', '?path=/etc/passwd');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'doc_not_allowed');
});

test('検索系: 空クエリは 400', async () => {
  for (const p of ['/api/memory-search', '/api/session-search', '/api/log-search']) {
    const r = await call(p, '?q=');
    assert.equal(r.status, 400, `${p} should 400 on empty q`);
    assert.equal(r.json.error, 'empty_query');
  }
});

test('/api/archive-session: 不正な id は 400', async () => {
  const r = await call('/api/archive-session', '?id=not-a-uuid');
  assert.equal(r.status, 400);
  assert.equal(r.json.error, 'bad_id');
});

test('/api/restore-session: 不正な id は 400', async () => {
  const r = await call('/api/restore-session', '?id=xxx');
  assert.equal(r.status, 400);
});

test('/api/health: ok', async () => {
  const r = await call('/api/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.status, 'ok');
});

test('未知の /api/* は 404', async () => {
  const r = await call('/api/does-not-exist');
  assert.equal(r.status, 404);
  assert.equal(r.json.error, 'api_not_found');
});

test('/api/archive-session: root 未設定なら config_missing(500)', async () => {
  // config に sessions/archive の root が無いので、有効な UUID でも 500 config_missing。
  const r = await call('/api/archive-session', '?id=dddddddd-dddd-4ddd-8ddd-dddddddddddd');
  assert.equal(r.status, 500);
  assert.equal(r.json.error, 'config_missing');
});
