'use strict';

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const fsp = fs.promises;
const os = require('node:os');
const path = require('node:path');
const {
  sessionHead, toSessionRow, scanSessions, findSessionFile, moveSessionFile, UUID_RE
} = require('../lib/sessions');

let TMP;
const UUID_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

before(async () => {
  TMP = await fsp.mkdtemp(path.join(os.tmpdir(), 'sess-test-'));
});
after(async () => {
  await fsp.rm(TMP, { recursive: true, force: true });
});

// JSONL レコード配列を 1 ファイルに書く。
async function writeTranscript(name, records) {
  const fp = path.join(TMP, name);
  await fsp.writeFile(fp, records.map((r) => JSON.stringify(r)).join('\n') + '\n');
  return fp;
}

test('UUID_RE: 正しい UUID のみ一致', () => {
  assert.equal(UUID_RE.test(UUID_A), true);
  assert.equal(UUID_RE.test('not-a-uuid'), false);
  assert.equal(UUID_RE.test('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaa'), false); // 1 桁不足
});

test('sessionHead: タイトル無しなら最初のユーザー発話', async () => {
  const fp = await writeTranscript('t1.jsonl', [
    { cwd: '/work/alpha/workspace' },
    { type: 'user', message: { role: 'user', content: '最初の発話です' } }
  ]);
  const r = await sessionHead(fp);
  assert.equal(r.cwd, '/work/alpha/workspace');
  assert.equal(r.first, '最初の発話です');
  assert.equal(r.title, '最初の発話です');
});

test('sessionHead: ai-title があれば first より優先', async () => {
  const fp = await writeTranscript('t2.jsonl', [
    { cwd: '/w' },
    { type: 'user', message: { role: 'user', content: '発話' } },
    { type: 'ai-title', aiTitle: '自動タイトル' }
  ]);
  const r = await sessionHead(fp);
  assert.equal(r.aiTitle, '自動タイトル');
  assert.equal(r.title, '自動タイトル');
});

test('sessionHead: custom-title(手動命名) が最優先', async () => {
  const fp = await writeTranscript('t3.jsonl', [
    { cwd: '/w' },
    { type: 'user', message: { role: 'user', content: '発話' } },
    { type: 'ai-title', aiTitle: '自動' },
    { type: 'custom-title', customTitle: '手動の名前' }
  ]);
  const r = await sessionHead(fp);
  assert.equal(r.customTitle, '手動の名前');
  assert.equal(r.title, '手動の名前');
});

test('sessionHead: 複数 ai-title は最後（最新）を採用', async () => {
  const fp = await writeTranscript('t4.jsonl', [
    { type: 'user', message: { role: 'user', content: 'x' } },
    { type: 'ai-title', aiTitle: '古い' },
    { type: 'ai-title', aiTitle: '新しい' }
  ]);
  const r = await sessionHead(fp);
  assert.equal(r.aiTitle, '新しい');
});

test('sessionHead: head 側の custom-title も tail から外れていれば拾う', async () => {
  // 先頭付近で /rename → その後 ai-title を大量に積んで tail から custom-title を押し出す。
  const records = [
    { cwd: '/w' },
    { type: 'user', message: { role: 'user', content: '発話' } },
    { type: 'custom-title', customTitle: '先頭で付けた名前' }
  ];
  // tail 64KB を超える充填（各行を十分大きく）
  const filler = 'x'.repeat(2000);
  for (let i = 0; i < 60; i++) records.push({ type: 'ai-title', aiTitle: `t${i}`, pad: filler });
  const fp = await writeTranscript('t5.jsonl', records);
  const stat = await fsp.stat(fp);
  assert.ok(stat.size > 65536, 'fixture は tail サイズを超えるべき');
  const r = await sessionHead(fp);
  assert.equal(r.customTitle, '先頭で付けた名前'); // head 走査で救えている
  assert.equal(r.title, '先頭で付けた名前');
});

test('sessionHead: 存在しないファイルでも例外を投げず空を返す', async () => {
  const r = await sessionHead(path.join(TMP, 'nope.jsonl'));
  assert.deepEqual(r, { cwd: '', first: '', aiTitle: '', customTitle: '', title: '' });
});

test('toSessionRow: 160 字に切り詰め・resumeCmd 生成', () => {
  const long = 'あ'.repeat(300);
  const row = toSessionRow({ sessionId: 'sid', cwd: '/w', project: 'p', modifiedAt: 'now', sizeKB: 1, live: true, first: long, title: long });
  assert.equal(row.title.length, 160);
  assert.equal(row.first.length, 160);
  assert.equal(row.live, true);
  assert.match(row.resumeCmd, /^cd "\/w" && claude --resume sid /);
});

test('toSessionRow: cwd 無しは cd を付けない', () => {
  const row = toSessionRow({ sessionId: 'sid', cwd: '', project: 'p', modifiedAt: 'now', sizeKB: 1, live: false, first: 'f', title: 't' });
  assert.match(row.resumeCmd, /^claude --resume sid /);
});

test('scanSessions: root 無し / 空は空結果', async () => {
  assert.deepEqual(await scanSessions(null, 10, null), { sessions: [], total: 0, liveCount: 0, shown: 0 });
  const emptyRoot = path.join(TMP, 'empty-root');
  await fsp.mkdir(emptyRoot, { recursive: true });
  assert.deepEqual(await scanSessions(emptyRoot, 10, null), { sessions: [], total: 0, liveCount: 0, shown: 0 });
});

test('scanSessions: project フォルダ配下の jsonl を新しい順・limit で返す', async () => {
  const root = path.join(TMP, 'projects');
  const proj = path.join(root, '-proj-a');
  await fsp.mkdir(proj, { recursive: true });
  await fsp.writeFile(path.join(proj, 's1.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'one' } }) + '\n');
  await fsp.writeFile(path.join(proj, 's2.jsonl'), JSON.stringify({ type: 'user', message: { role: 'user', content: 'two' } }) + '\n');
  const live = new Set(['s1']);
  const r = await scanSessions(root, 10, live);
  assert.equal(r.total, 2);
  assert.equal(r.shown, 2);
  assert.equal(r.liveCount, 1);
  const s1 = r.sessions.find((s) => s.sessionId === 's1');
  assert.equal(s1.live, true);
  assert.equal(s1.project, '-proj-a');
});

test('findSessionFile / moveSessionFile: アーカイブ往復で中身不変・フォルダ維持', async () => {
  const projects = path.join(TMP, 'mv-projects');
  const archive = path.join(TMP, 'mv-archive');
  const folder = '-proj-x';
  await fsp.mkdir(path.join(projects, folder), { recursive: true });
  const body = JSON.stringify({ cwd: '/w', type: 'user', message: { role: 'user', content: 'hi' } }) + '\n';
  await fsp.writeFile(path.join(projects, folder, `${UUID_A}.jsonl`), body);

  // 見つかる
  const found = await findSessionFile(projects, UUID_A);
  assert.equal(found.folder, folder);

  // projects → archive
  const mv1 = await moveSessionFile(UUID_A, projects, archive);
  assert.deepEqual(mv1, { ok: true, id: UUID_A, folder });
  assert.equal(fs.existsSync(path.join(projects, folder, `${UUID_A}.jsonl`)), false);
  assert.equal(fs.readFileSync(path.join(archive, folder, `${UUID_A}.jsonl`), 'utf8'), body); // 中身不変

  // archive → projects（復元）
  const mv2 = await moveSessionFile(UUID_A, archive, projects);
  assert.deepEqual(mv2, { ok: true, id: UUID_A, folder });
  assert.equal(fs.existsSync(path.join(projects, folder, `${UUID_A}.jsonl`)), true);
});

test('moveSessionFile: 無いセッションは not_found', async () => {
  const r = await moveSessionFile('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', path.join(TMP, 'mv-projects'), path.join(TMP, 'mv-archive'));
  assert.deepEqual(r, { error: 'not_found' });
});

test('findSessionFile: root 無しは null', async () => {
  assert.equal(await findSessionFile(null, UUID_A), null);
});
