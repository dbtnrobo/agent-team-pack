const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { URL } = require('url');
const { execFile } = require('child_process');

const BASE_DIR = __dirname;
const CONFIG_PATH = path.join(BASE_DIR, 'config.json');

const PUBLIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/style.css', 'style.css'],
  ['/app.js', 'app.js'],
  ['/README.md', 'README.md'],
  ['/demo.html', 'demo.html']
]);

const CONTENT_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8'
};

function nowIso() {
  return new Date().toISOString();
}

function readConfig() {
  const raw = fs.readFileSync(CONFIG_PATH, 'utf8');
  return JSON.parse(raw);
}

function resolveSafe(baseDir, relativePath) {
  const resolved = path.resolve(baseDir, relativePath);
  const baseResolved = path.resolve(baseDir);
  const withSep = baseResolved.endsWith(path.sep) ? baseResolved : baseResolved + path.sep;
  if (resolved !== baseResolved && !resolved.startsWith(withSep)) {
    throw new Error(`path_outside_base: ${relativePath}`);
  }
  return resolved;
}

function sanitizePublicConfig(config) {
  const agents = {};
  for (const [agentId, agent] of Object.entries(config.agents || {})) {
    agents[agentId] = {
      label: agent.label || agentId,
      color: agent.color || '#6B7280'
    };
  }

  return {
    siteTitle: config.siteTitle || 'Dashboard',
    teamName: config.teamName || 'Team',
    timezone: config.timezone || 'Asia/Tokyo',
    polling: config.polling || { taskIntervalSec: 30 },
    heartbeat: config.heartbeat || { enabled: true, excludeBlocked: true },
    ui: config.ui || { mobileBreakpoint: 768, showCopyButtonsOnMobile: false, desktopColumns: 3, completedPreviewCount: 8 },
    agents
  };
}

function json(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
    Pragma: 'no-cache',
    Expires: '0'
  });
  res.end(body);
}

async function serveStatic(res, fileName) {
  const filePath = path.join(BASE_DIR, fileName);
  const ext = path.extname(filePath);
  try {
    const content = await fsp.readFile(filePath);
    res.writeHead(200, {
      'Content-Type': CONTENT_TYPES[ext] || 'application/octet-stream',
      'Cache-Control': 'no-store, no-cache, must-revalidate, proxy-revalidate',
      Pragma: 'no-cache',
      Expires: '0'
    });
    res.end(content);
  } catch (_error) {
    json(res, 404, {
      error: 'static_file_not_found',
      message: `${fileName} を読み取れません。`,
      timestamp: nowIso()
    });
  }
}

async function listTaskFiles(config) {
  const taskDirRel = config.taskDir || '../tasks';
  const taskDir = path.resolve(BASE_DIR, taskDirRel);
  const entries = await fsp.readdir(taskDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'ja'));

  const results = [];
  for (const name of files) {
    let safePath;
    try {
      safePath = resolveSafe(taskDir, name);
    } catch (_error) {
      continue;
    }
    const [content, stat] = await Promise.all([
      fsp.readFile(safePath, 'utf8'),
      fsp.stat(safePath)
    ]);
    results.push({
      name,
      modifiedAt: stat.mtime.toISOString(),
      size: stat.size,
      content
    });
  }
  return results;
}

// 指定ディレクトリ内の prefix*.md を読む（resolveSafeでディレクトリ内に限定・read-only）
async function listMarkdownIn(dir, prefix) {
  const entries = await fsp.readdir(dir, { withFileTypes: true });
  const files = entries
    .filter((e) => e.isFile() && e.name.endsWith('.md') && (!prefix || e.name.startsWith(prefix)))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'ja'));
  const results = [];
  for (const name of files) {
    let safePath;
    try { safePath = resolveSafe(dir, name); } catch (_e) { continue; }
    const [content, stat] = await Promise.all([fsp.readFile(safePath, 'utf8'), fsp.stat(safePath)]);
    results.push({ name, modifiedAt: stat.mtime.toISOString(), content });
  }
  return results;
}

// skillsDir/*/SKILL.md を読む
async function listSkillsIn(skillsDir) {
  const entries = await fsp.readdir(skillsDir, { withFileTypes: true });
  const results = [];
  for (const dir of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const skillFile = path.join(skillsDir, dir.name, 'SKILL.md');
    try {
      const content = await fsp.readFile(skillFile, 'utf8');
      results.push({ name: dir.name, content });
    } catch (_e) { /* SKILL.md無しはスキップ */ }
  }
  return results;
}

// tmux のペイン稼働状態を取得（LLMを呼ばない・read-only）
function tmuxPanes() {
  return new Promise((resolve) => {
    execFile('tmux',
      ['list-panes', '-s', '-t', 'agents', '-F', '#{window_name}|||#{pane_title}|||#{pane_current_command}'],
      { timeout: 3000 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const panes = stdout.trim().split('\n').filter(Boolean).map((line) => {
          const [window, title, command] = line.split('|||');
          return { window, title, command };
        });
        resolve(panes);
      });
  });
}

// 稼働中セッションID集合（pid 生存で判定）
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

// jsonl 先頭16KBから cwd と最初のユーザー発話を抽出（共通）
async function sessionHead(fp) {
  let cwd = '';
  let first = '';
  try {
    const HEAD = 262144; // 256KB: 先頭ユーザー発話は CLAUDE.md/記憶の自動注入込みで大きいことがある
    const fd = await fsp.open(fp, 'r');
    const buf = Buffer.alloc(HEAD);
    const { bytesRead } = await fd.read(buf, 0, HEAD, 0);
    await fd.close();
    for (const line of buf.slice(0, bytesRead).toString('utf8').split('\n')) {
      if (!line.trim()) continue;
      let obj;
      try { obj = JSON.parse(line); } catch (_e) { continue; }
      if (!cwd && obj.cwd) cwd = obj.cwd;
      if (!first) {
        const m = obj.message || obj;
        const role = m.role || obj.type;
        if (role === 'user') {
          let c = m.content;
          if (Array.isArray(c)) {
            // system-reminder 等のタグ始まりブロックは除いて本文だけ拾う
            c = c.filter((x) => x && typeof x.text === 'string')
              .map((x) => x.text)
              .filter((t) => !t.trim().startsWith('<'))
              .join(' ');
          }
          if (typeof c === 'string') {
            const t = c.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ')
              .replace(/<[^>]+>/g, ' ')
              .trim();
            if (t) first = t;
          }
        }
      }
      if (cwd && first) break;
    }
  } catch (_e) { /* skip */ }
  return { cwd, first };
}

// 本物のセッション（プロジェクト直下の UUID 名 *.jsonl）だけに絞った検索。サブエージェント/ツール結果を除外。
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
  const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
  const seen = new Set();
  const matched = [];
  for (const fp of files) {
    const base = path.basename(fp).replace(/\.jsonl$/, '');
    const parent = path.basename(path.dirname(fp));
    if (!UUID.test(base) || !parent.startsWith('-')) continue; // 本セッション かつ プロジェクト直下のみ
    if (seen.has(base)) continue;
    seen.add(base);
    let mtime = 0;
    try { mtime = (await fsp.stat(fp)).mtimeMs; } catch (_e) { /* skip */ }
    matched.push({ fp, base, parent, archived: fp.includes('/projects-archive/'), mtime });
  }
  matched.sort((a, b) => b.mtime - a.mtime); // 新しい順
  const matchedTotal = matched.length;
  const picked = matched.slice(0, limit || 40);
  const hits = [];
  for (const p of picked) {
    const { cwd, first } = await sessionHead(p.fp);
    hits.push({
      sessionId: p.base,
      project: p.parent,
      cwd,
      first: first.slice(0, 160),
      archived: p.archived,
      modifiedAt: p.mtime ? new Date(p.mtime).toISOString() : '',
      resumeCmd: (cwd ? `cd "${cwd}" && ` : '') + `claude --resume ${p.base} --dangerously-skip-permissions`,
      restoreCmd: (p.archived && restoreScript) ? `bash "${restoreScript}" restore ${p.base}` : ''
    });
  }
  return { hits, total: matchedTotal, shown: hits.length };
}

// 指定 root 配下の *.jsonl を走査し、先頭から cwd と最初のユーザー発話を抽出。read-only・LLM非依存。
async function scanSessions(root, limit, live) {
  const empty = { sessions: [], total: 0, liveCount: 0, shown: 0 };
  if (!root) return empty;
  const entries = [];
  let projDirs = [];
  try { projDirs = (await fsp.readdir(root, { withFileTypes: true })).filter((d) => d.isDirectory()); } catch (_e) { return empty; }
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

  const out = [];
  for (const e of top) {
    const { cwd, first } = await sessionHead(e.fp);
    out.push({
      sessionId: e.sessionId,
      cwd,
      project: e.project,
      modifiedAt: e.mtime.toISOString(),
      sizeKB: Math.round(e.size / 1024),
      live: live ? live.has(e.sessionId) : false,
      first: first.slice(0, 160),
      resumeCmd: (cwd ? `cd "${cwd}" && ` : '') + `claude --resume ${e.sessionId} --dangerously-skip-permissions`
    });
  }
  return { sessions: out, total: entries.length, liveCount: live ? live.size : 0, shown: out.length };
}

// 記憶検索: 既存の FTS5 索引CLI を JSON モードで呼ぶ。LLM非依存・課金ゼロ。
function memorySearch(config, q, n) {
  return new Promise((resolve) => {
    const ms = config.serverOnly?.dataSources?.memorySearch;
    if (!ms || !ms.script) return resolve({ error: 'memory_search_not_configured' });
    const env = { ...process.env };
    if (ms.memoryDirs && ms.memoryDirs.length) env.MEMORY_DIRS = ms.memoryDirs.join(path.delimiter);
    execFile(ms.python || 'python3', [ms.script, 'search', q, '-n', String(n || 15), '--json'],
      { timeout: 20000, env, maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => {
        if (err && !stdout) return resolve({ error: 'memory_search_failed', message: String(err.message || err) });
        try { resolve({ hits: JSON.parse(String(stdout || '[]')) }); }
        catch (_e) { resolve({ error: 'memory_search_parse', raw: String(stdout).slice(0, 500) }); }
      });
  });
}

// 生ログ検索: 全 transcript を grep（固定文字列・大小無視・各ファイル最初の1致）。LLM非依存・課金ゼロ。
function logSearch(config, q, limit) {
  return new Promise((resolve) => {
    const ls = config.serverOnly?.dataSources?.logSearch || {};
    const roots = ls.transcriptsRoots || (ls.transcriptsRoot ? [ls.transcriptsRoot] : []);
    if (!roots.length) return resolve({ error: 'log_search_not_configured' });
    execFile('grep', ['-rIiF', '-m1', '--', q, ...roots],
      { timeout: 25000, maxBuffer: 8 * 1024 * 1024 },
      (err, stdout) => {
        // grep の exit 1 は「該当なし」で正常
        if (err && err.code !== 1 && !stdout) return resolve({ error: 'log_search_failed', message: String(err.message || err) });
        const lines = String(stdout || '').split('\n').filter(Boolean).slice(0, limit || 40);
        const hits = lines.map((ln) => {
          const i = ln.indexOf(':');
          const fp = i >= 0 ? ln.slice(0, i) : ln;
          const snip = i >= 0 ? ln.slice(i + 1) : '';
          return {
            sessionId: path.basename(fp).replace(/\.jsonl$/, ''),
            project: path.basename(path.dirname(fp)),
            snippet: snip.slice(0, 240)
          };
        });
        resolve({ hits });
      });
  });
}

async function handleApi(req, res, config, url) {
  if (url.pathname === '/api/config') {
    return json(res, 200, {
      config: sanitizePublicConfig(config),
      generatedAt: nowIso()
    });
  }

  if (url.pathname === '/api/tasks') {
    try {
      const tasks = await listTaskFiles(config);
      return json(res, 200, {
        files: tasks,
        generatedAt: nowIso()
      });
    } catch (error) {
      return json(res, 500, {
        error: 'task_read_failed',
        message: error.message,
        generatedAt: nowIso()
      });
    }
  }

  if (url.pathname === '/api/start-command') {
    const agentId = url.searchParams.get('agent');
    const commands = config.serverOnly?.startCommands || {};
    const command = agentId && Object.prototype.hasOwnProperty.call(commands, agentId)
      ? commands[agentId]
      : null;
    if (!command) {
      return json(res, 404, {
        error: 'start_command_not_found',
        message: '起動コマンドが設定されていません。',
        generatedAt: nowIso()
      });
    }
    return json(res, 200, {
      agent: agentId,
      command,
      generatedAt: nowIso()
    });
  }

  if (url.pathname === '/api/projects') {
    try {
      const dir = config.serverOnly?.dataSources?.projectsDir;
      const files = dir ? await listMarkdownIn(dir, 'project_') : [];
      return json(res, 200, { files, generatedAt: nowIso() });
    } catch (error) {
      return json(res, 500, { error: 'projects_read_failed', message: error.message, generatedAt: nowIso() });
    }
  }

  if (url.pathname === '/api/skills') {
    try {
      const dir = config.serverOnly?.dataSources?.skillsDir;
      const skills = dir ? await listSkillsIn(dir) : [];
      return json(res, 200, { skills, generatedAt: nowIso() });
    } catch (error) {
      return json(res, 500, { error: 'skills_read_failed', message: error.message, generatedAt: nowIso() });
    }
  }

  if (url.pathname === '/api/docs') {
    const docs = config.serverOnly?.dataSources?.docs || [];
    const wantPath = url.searchParams.get('path');
    if (wantPath) {
      const doc = docs.find((d) => d.path === wantPath);
      if (!doc) {
        return json(res, 404, { error: 'doc_not_allowed', message: '許可されていないパスです。', generatedAt: nowIso() });
      }
      try {
        const content = await fsp.readFile(doc.path, 'utf8');
        return json(res, 200, { label: doc.label, path: doc.path, content, generatedAt: nowIso() });
      } catch (error) {
        return json(res, 500, { error: 'doc_read_failed', message: error.message, generatedAt: nowIso() });
      }
    }
    return json(res, 200, { docs: docs.map((d) => ({ label: d.label, path: d.path })), generatedAt: nowIso() });
  }

  if (url.pathname === '/api/agents') {
    const panes = await tmuxPanes();
    return json(res, 200, { panes, generatedAt: nowIso() });
  }

  if (url.pathname === '/api/sessions') {
    try {
      const cfg = config.serverOnly?.dataSources?.sessions || {};
      const live = await liveSessionSet(cfg.liveRegistryDir);
      const r = await scanSessions(cfg.projectsRoot, cfg.limit, live);
      return json(res, 200, { ...r, generatedAt: nowIso() });
    } catch (error) {
      return json(res, 500, { error: 'sessions_failed', message: error.message, generatedAt: nowIso() });
    }
  }

  if (url.pathname === '/api/archive') {
    try {
      const acfg = config.serverOnly?.dataSources?.archive || {};
      const r = await scanSessions(acfg.root, acfg.limit, null);
      const script = acfg.restoreScript;
      const sessions = r.sessions.map((s) => ({
        ...s,
        restoreCmd: script ? `bash "${script}" restore ${s.sessionId}` : ''
      }));
      return json(res, 200, { ...r, sessions, generatedAt: nowIso() });
    } catch (error) {
      return json(res, 500, { error: 'archive_failed', message: error.message, generatedAt: nowIso() });
    }
  }

  if (url.pathname === '/api/memory-search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return json(res, 400, { error: 'empty_query', generatedAt: nowIso() });
    const r = await memorySearch(config, q, 15);
    return json(res, r.error ? 500 : 200, { ...r, query: q, generatedAt: nowIso() });
  }

  if (url.pathname === '/api/session-search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return json(res, 400, { error: 'empty_query', generatedAt: nowIso() });
    const r = await sessionSearch(config, q, 40);
    return json(res, r.error ? 500 : 200, { ...r, query: q, generatedAt: nowIso() });
  }

  if (url.pathname === '/api/log-search') {
    const q = (url.searchParams.get('q') || '').trim();
    if (!q) return json(res, 400, { error: 'empty_query', generatedAt: nowIso() });
    const r = await logSearch(config, q, 40);
    return json(res, r.error ? 500 : 200, { ...r, query: q, generatedAt: nowIso() });
  }

  if (url.pathname === '/api/health') {
    return json(res, 200, {
      status: 'ok',
      timestamp: nowIso()
    });
  }

  return json(res, 404, {
    error: 'api_not_found',
    message: 'API エンドポイントが存在しません。',
    generatedAt: nowIso()
  });
}

function isHostAllowed(hostHeader, allowedHosts) {
  if (!allowedHosts || allowedHosts.length === 0) return true;
  if (!hostHeader) return false;
  const hostname = String(hostHeader).split(':')[0].toLowerCase();
  return allowedHosts.map((h) => String(h).toLowerCase()).includes(hostname);
}

const config0 = readConfig();
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || config0.serverOnly?.host || '127.0.0.1';
const allowedHosts = config0.serverOnly?.allowedHosts || ['localhost', '127.0.0.1'];

const server = http.createServer(async (req, res) => {
  try {
    const config = readConfig();
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    if (!['GET', 'HEAD'].includes(req.method || 'GET')) {
      return json(res, 405, {
        error: 'method_not_allowed',
        message: 'GET / HEAD のみ利用できます。',
        generatedAt: nowIso()
      });
    }

    if (!isHostAllowed(req.headers.host, allowedHosts)) {
      return json(res, 403, {
        error: 'host_not_allowed',
        message: 'この Host ヘッダからのアクセスは許可されていません。config.json の serverOnly.allowedHosts を確認してください。',
        generatedAt: nowIso()
      });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(req, res, config, url);
    }

    if (PUBLIC_FILES.has(url.pathname)) {
      return serveStatic(res, PUBLIC_FILES.get(url.pathname));
    }

    return json(res, 404, {
      error: 'not_found',
      message: '指定されたリソースは存在しません。',
      generatedAt: nowIso()
    });
  } catch (error) {
    console.error('[server-error]', error);
    return json(res, 500, {
      error: 'internal_server_error',
      message: error.message,
      generatedAt: nowIso()
    });
  }
});

server.listen(port, host, () => {
  console.log(`Dashboard server is running at http://${host}:${port}`);
  console.log(`Base directory: ${BASE_DIR}`);
  console.log(`Allowed Host headers: ${allowedHosts.join(', ')}`);
});
