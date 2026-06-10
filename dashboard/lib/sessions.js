'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { extractUserText, parseTitleLine, pickSessionTitle } = require('./titles');

// Claude Code セッション（transcript .jsonl）の走査・検索・アーカイブ移動。
// すべて read-only もしくは純粋なファイル移動で、LLM を呼ばない。

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const HEAD_BYTES = 262144; // 256KB: 先頭ユーザー発話は CLAUDE.md/記憶の自動注入込みで大きいことがある
const TAIL_BYTES = 65536;  // 64KB: 末尾のタイトルレコードを拾う範囲

/** ファイル先頭 maxBytes を文字列で読む（無ければ ''）。 */
async function readHead(fp, maxBytes) {
  const fd = await fsp.open(fp, 'r');
  try {
    const buf = Buffer.alloc(maxBytes);
    const { bytesRead } = await fd.read(buf, 0, maxBytes, 0);
    return buf.slice(0, bytesRead).toString('utf8');
  } finally {
    await fd.close();
  }
}

/** ファイル末尾 maxBytes を文字列で読む（無ければ ''）。 */
async function readTail(fp, maxBytes) {
  const st = await fsp.stat(fp);
  const start = Math.max(0, st.size - maxBytes);
  const len = st.size - start;
  if (len <= 0) return '';
  const fd = await fsp.open(fp, 'r');
  try {
    const buf = Buffer.alloc(len);
    await fd.read(buf, 0, len, start);
    return buf.toString('utf8');
  } finally {
    await fd.close();
  }
}

/**
 * transcript から cwd・最初のユーザー発話・表示タイトルを抽出する。
 * タイトル優先順位: 手動命名(custom-title) > 自動生成(ai-title) > 最初の発話。
 * custom-title は head(先頭 256KB) と tail(末尾 64KB) の両方を走査し、tail を最新として
 * 優先する。/rename が「先頭付近」か「末尾付近」にあるケースはこれで救えるが、
 * 256KB 超〜末尾 64KB 未満の中間帯に挟まった custom-title は拾えない（全文走査は
 * セッション数 × ファイルサイズで重いため、ここでは妥協している）。
 * @param {string} fp transcript の絶対パス
 * @returns {Promise<{cwd,first,aiTitle,customTitle,title}>}
 */
async function sessionHead(fp) {
  let cwd = '';
  let first = '';
  let headCustomTitle = '';
  try {
    const lines = (await readHead(fp, HEAD_BYTES)).split('\n');
    for (const line of lines) {
      const t = parseTitleLine(line);
      if (t && t.customTitle) headCustomTitle = t.customTitle; // head 内の最後 = より新しい
    }
    for (const line of lines) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_e) { continue; }
      if (!cwd && obj.cwd) cwd = obj.cwd;
      if (!first) { const t = extractUserText(obj); if (t) first = t; }
      if (cwd && first) break;
    }
  } catch (_e) { /* skip */ }

  let aiTitle = '';
  let tailCustomTitle = '';
  try {
    for (const line of (await readTail(fp, TAIL_BYTES)).split('\n')) {
      const t = parseTitleLine(line);
      if (!t) continue;
      if (t.aiTitle) aiTitle = t.aiTitle;          // 最後 = 最新
      if (t.customTitle) tailCustomTitle = t.customTitle;
    }
  } catch (_e) { /* skip */ }

  const customTitle = tailCustomTitle || headCustomTitle;
  return { cwd, first, aiTitle, customTitle, title: pickSessionTitle({ customTitle, aiTitle, first }) };
}

/** transcript 1 件をダッシュボード表示用の行に整形する（タイトル/発話は 160 字に切る）。 */
function toSessionRow({ sessionId, cwd, project, modifiedAt, sizeKB, live, first, title }) {
  return {
    sessionId,
    cwd,
    project,
    modifiedAt,
    sizeKB,
    live: !!live,
    first: (first || '').slice(0, 160),
    title: (title || first || '').slice(0, 160),
    resumeCmd: (cwd ? `cd "${cwd}" && ` : '') + `claude --resume ${sessionId} --dangerously-skip-permissions`
  };
}

/**
 * 稼働中セッション ID 集合を返す（ライブレジストリの pid 生存で判定）。
 * @param {string} liveRegistryDir <home>/.claude/sessions など
 * @returns {Promise<Set<string>>}
 */
async function liveSessionSet(liveRegistryDir) {
  const live = new Set();
  if (!liveRegistryDir) return live;
  try {
    for (const f of await fsp.readdir(liveRegistryDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const j = JSON.parse(await fsp.readFile(path.join(liveRegistryDir, f), 'utf8'));
        if (j.sessionId && j.pid) {
          try { process.kill(j.pid, 0); live.add(j.sessionId); } catch (_e) { /* 死んでる */ }
        }
      } catch (_e) { /* skip */ }
    }
  } catch (_e) { /* skip */ }
  return live;
}

/**
 * <root>/<projectFolder>/*.jsonl を走査し、新しい順に最大 limit 件を整形して返す。
 * @param {string} root projects ルート
 * @param {number} limit 最大件数
 * @param {Set<string>|null} live 稼働中 ID 集合（null なら live=false）
 * @returns {Promise<{sessions,total,liveCount,shown}>}
 */
async function scanSessions(root, limit, live) {
  const empty = { sessions: [], total: 0, liveCount: 0, shown: 0 };
  if (!root) return empty;
  let projDirs = [];
  try { projDirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()); } catch (_e) { return empty; }

  const entries = [];
  for (const pd of projDirs) {
    const dir = path.join(root, pd.name);
    let files = [];
    try { files = (await fsp.readdir(dir)).filter((n) => n.endsWith('.jsonl')); } catch (_e) { continue; }
    for (const name of files) {
      const fp = path.join(dir, name);
      let st;
      try { st = await fsp.stat(fp); } catch (_e) { continue; }
      entries.push({ fp, project: pd.name, sessionId: name.replace(/\.jsonl$/, ''), mtime: st.mtime, size: st.size });
    }
  }
  entries.sort((a, b) => b.mtime - a.mtime);
  const top = entries.slice(0, Number(limit) || 60);

  const sessions = [];
  for (const e of top) {
    const { cwd, first, title } = await sessionHead(e.fp);
    sessions.push(toSessionRow({
      sessionId: e.sessionId, cwd, project: e.project,
      modifiedAt: e.mtime.toISOString(), sizeKB: Math.round(e.size / 1024),
      live: live ? live.has(e.sessionId) : false, first, title
    }));
  }
  return { sessions, total: entries.length, liveCount: live ? live.size : 0, shown: sessions.length };
}

/**
 * 本物のセッション（プロジェクト直下の UUID 名 *.jsonl）に絞った全文検索。
 * サブエージェント/ツール結果の jsonl を UUID 名 + 親フォルダ('-' 始まり)で除外する。
 * @returns {Promise<{hits,total,shown}|{error:string}>}
 */
async function sessionSearch(config, q, limit) {
  const ls = config.serverOnly?.dataSources?.logSearch || {};
  const roots = ls.transcriptsRoots || (ls.transcriptsRoot ? [ls.transcriptsRoot] : []);
  if (!roots.length) return { error: 'not_configured' };
  const restoreScript = config.serverOnly?.dataSources?.archive?.restoreScript;

  const files = await new Promise((resolve) => {
    execFile('grep', ['-rIilF', '--include=*.jsonl', '--', q, ...roots],
      { timeout: 25000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        if (err && err.code !== 1 && !stdout) return resolve(null);
        resolve(String(stdout || '').split('\n').filter(Boolean));
      });
  });
  if (files === null) return { error: 'session_search_failed' };

  const seen = new Set();
  const matched = [];
  for (const fp of files) {
    const base = path.basename(fp).replace(/\.jsonl$/, '');
    const parent = path.basename(path.dirname(fp));
    if (!UUID_RE.test(base) || !parent.startsWith('-')) continue; // 本セッション かつ プロジェクト直下のみ
    if (seen.has(base)) continue;
    seen.add(base);
    let mtime = 0;
    try { mtime = (await fsp.stat(fp)).mtimeMs; } catch (_e) { /* skip */ }
    matched.push({ fp, base, parent, archived: fp.includes('/projects-archive/'), mtime });
  }
  matched.sort((a, b) => b.mtime - a.mtime); // 新しい順
  const picked = matched.slice(0, limit || 40);

  const hits = [];
  for (const p of picked) {
    const { cwd, first, title } = await sessionHead(p.fp);
    hits.push({
      sessionId: p.base,
      project: p.parent,
      cwd,
      first: first.slice(0, 160),
      title: (title || first).slice(0, 160),
      archived: p.archived,
      modifiedAt: p.mtime ? new Date(p.mtime).toISOString() : '',
      resumeCmd: (cwd ? `cd "${cwd}" && ` : '') + `claude --resume ${p.base} --dangerously-skip-permissions`,
      restoreCmd: (p.archived && restoreScript) ? `bash "${restoreScript}" restore ${p.base}` : ''
    });
  }
  return { hits, total: matched.length, shown: hits.length };
}

/**
 * <root>/<projectFolder>/<id>.jsonl を探す。
 * @returns {Promise<{fp,folder}|null>}
 */
async function findSessionFile(root, id) {
  if (!root) return null;
  let dirs = [];
  try { dirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()); } catch (_e) { return null; }
  for (const d of dirs) {
    const fp = path.join(root, d.name, `${id}.jsonl`);
    try { await fsp.access(fp); return { fp, folder: d.name }; } catch (_e) { /* next */ }
  }
  return null;
}

/**
 * セッション jsonl を fromRoot → toRoot へ移動（プロジェクトフォルダ名を維持）。中身不変・可逆。
 * @returns {Promise<{ok:true,id,folder}|{error:'not_found'}>}
 */
async function moveSessionFile(id, fromRoot, toRoot) {
  const found = await findSessionFile(fromRoot, id);
  if (!found) return { error: 'not_found' };
  const destDir = path.join(toRoot, found.folder);
  await fsp.mkdir(destDir, { recursive: true });
  await fsp.rename(found.fp, path.join(destDir, `${id}.jsonl`));
  return { ok: true, id, folder: found.folder };
}

module.exports = {
  UUID_RE, sessionHead, toSessionRow, liveSessionSet,
  scanSessions, sessionSearch, findSessionFile, moveSessionFile
};
