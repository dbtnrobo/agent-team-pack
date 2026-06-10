'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const http = require('node:http');

// fetch は Host を禁止ヘッダ扱いで上書きできないため、host ガード検証は生 http で打つ。
function rawGet(pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method: 'GET', headers }, (res) => {
      res.resume();
      resolve({ status: res.statusCode });
    });
    req.on('error', reject);
    req.end();
  });
}

const SERVER = path.join(__dirname, '..', 'server.js');
const UUID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PORT = 20000 + (process.pid % 9000);
const BASE = `http://127.0.0.1:${PORT}`;

let TMP, child, projectsRoot, archiveRoot, folder;

// 子プロセスが /api/health を返すまで待つ。
async function waitReady(timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch (_e) { /* まだ起動中 */ }
    await new Promise((res) => setTimeout(res, 100));
  }
  throw new Error('server did not become ready');
}

before(async () => {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'intg-test-'));
  projectsRoot = path.join(TMP, 'projects');
  archiveRoot = path.join(TMP, 'projects-archive');
  folder = '-proj-intg';
  const liveDir = path.join(TMP, 'live');
  await fsp.mkdir(path.join(projectsRoot, folder), { recursive: true });
  await fsp.mkdir(archiveRoot, { recursive: true });
  await fsp.mkdir(liveDir, { recursive: true });
  await fsp.writeFile(
    path.join(projectsRoot, folder, `${UUID}.jsonl`),
    JSON.stringify({ cwd: '/w', type: 'user', message: { role: 'user', content: 'intg session' } }) + '\n'
  );

  const config = {
    siteTitle: 'Intg', agents: {},
    serverOnly: {
      host: '127.0.0.1',
      allowedHosts: ['127.0.0.1', 'localhost'],
      dataSources: {
        sessions: { projectsRoot, liveRegistryDir: liveDir, limit: 50 },
        archive: { root: archiveRoot, limit: 50 }
      }
    }
  };
  const configPath = path.join(TMP, 'config.json');
  await fsp.writeFile(configPath, JSON.stringify(config));

  child = spawn(process.execPath, [SERVER], {
    env: { ...process.env, DASHBOARD_CONFIG: configPath, PORT: String(PORT), HOST: '127.0.0.1' },
    stdio: 'ignore'
  });
  await waitReady();
});

after(async () => {
  if (child) child.kill('SIGKILL');
  await fsp.rm(TMP, { recursive: true, force: true });
});

test('GET /api/health: 200', async () => {
  const r = await fetch(`${BASE}/api/health`);
  assert.equal(r.status, 200);
  assert.equal((await r.json()).status, 'ok');
});

test('GET /api/config: serverOnly が漏れない', async () => {
  const r = await fetch(`${BASE}/api/config`);
  const body = await r.json();
  assert.equal('serverOnly' in body.config, false);
});

test('GET /: index.html を配信（200）', async () => {
  const r = await fetch(`${BASE}/`);
  assert.equal(r.status, 200);
  assert.match(r.headers.get('content-type'), /text\/html/);
});

test('許可リスト外の静的パスは 404', async () => {
  const r = await fetch(`${BASE}/secret.env`);
  assert.equal(r.status, 404);
});

test('method ガード: 非 mutating への POST は 405', async () => {
  const r = await fetch(`${BASE}/api/health`, { method: 'POST' });
  assert.equal(r.status, 405);
});

test('host ガード: 許可外 Host は 403', async () => {
  const r = await rawGet('/api/health', { Host: 'evil.example.com' });
  assert.equal(r.status, 403);
});

test('アーカイブ往復: sessions → archive-session → archive → restore-session', async () => {
  // 初期: projects に 1 件見える
  let r = await fetch(`${BASE}/api/sessions`);
  let body = await r.json();
  assert.equal(body.total, 1);
  assert.equal(body.sessions[0].sessionId, UUID);

  // アーカイブ（POST 許可）
  r = await fetch(`${BASE}/api/archive-session?id=${UUID}`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal((await r.json()).ok, true);
  assert.equal(fs.existsSync(path.join(projectsRoot, folder, `${UUID}.jsonl`)), false);
  assert.equal(fs.existsSync(path.join(archiveRoot, folder, `${UUID}.jsonl`)), true);

  // sessions から消え、archive に出る
  body = await (await fetch(`${BASE}/api/sessions`)).json();
  assert.equal(body.total, 0);
  body = await (await fetch(`${BASE}/api/archive`)).json();
  assert.equal(body.total, 1);

  // 復元
  r = await fetch(`${BASE}/api/restore-session?id=${UUID}`, { method: 'POST' });
  assert.equal(r.status, 200);
  assert.equal(fs.existsSync(path.join(projectsRoot, folder, `${UUID}.jsonl`)), true);
});

test('archive-session: 不正 id は 400', async () => {
  const r = await fetch(`${BASE}/api/archive-session?id=bad`, { method: 'POST' });
  assert.equal(r.status, 400);
});

test('HEAD /api/health: 200 かつ本文は空', async () => {
  const r = await fetch(`${BASE}/api/health`, { method: 'HEAD' });
  assert.equal(r.status, 200);
  assert.equal(await r.text(), '');
});
