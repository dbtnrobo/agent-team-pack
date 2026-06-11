'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { nowIso, json } = require('./util');
const { sanitizePublicConfig } = require('./config');
const { resolveAgentKey } = require('./titles');
const { listTaskFiles, listMarkdownIn, listSkillsIn, tmuxPanes, memorySearch, logSearch } = require('./sources');
const { UUID_RE, liveSessionSet, scanSessions, sessionSearch, moveSessionFile, readPins, togglePin } = require('./sessions');

/** ピン留めサイドカー JSON の場所（config で上書き可・既定は dashboard 直下） */
function pinsFilePath(config, baseDir) {
  return config.serverOnly?.dataSources?.sessions?.pinsFile || path.join(baseDir, 'pins.json');
}

// 検索系エンドポイント共通の前処理: クエリを取り出し、空なら 400 を返す。
function readQuery(url) {
  return (url.searchParams.get('q') || '').trim();
}

// 各 /api/* を処理する。GET/HEAD と一部 POST のみが server 側で許可済みで届く。
const ROUTES = {
  '/api/config': async (_req, res, config) => {
    return json(res, 200, { config: sanitizePublicConfig(config), generatedAt: nowIso() });
  },

  '/api/tasks': async (_req, res, config, _url, baseDir) => {
    try {
      const files = await listTaskFiles(config, baseDir);
      return json(res, 200, { files, generatedAt: nowIso() });
    } catch (error) {
      return json(res, 500, { error: 'task_read_failed', message: error.message, generatedAt: nowIso() });
    }
  },

  '/api/start-command': async (_req, res, config, url) => {
    const agentId = url.searchParams.get('agent');
    const commands = config.serverOnly?.startCommands || {};
    const command = agentId && Object.prototype.hasOwnProperty.call(commands, agentId) ? commands[agentId] : null;
    if (!command) {
      return json(res, 404, { error: 'start_command_not_found', message: '起動コマンドが設定されていません。', generatedAt: nowIso() });
    }
    return json(res, 200, { agent: agentId, command, generatedAt: nowIso() });
  },

  '/api/projects': async (_req, res, config) => {
    try {
      const dir = config.serverOnly?.dataSources?.projectsDir;
      const files = dir ? await listMarkdownIn(dir, 'project_') : [];
      return json(res, 200, { files, generatedAt: nowIso() });
    } catch (error) {
      return json(res, 500, { error: 'projects_read_failed', message: error.message, generatedAt: nowIso() });
    }
  },

  '/api/skills': async (_req, res, config) => {
    try {
      const dir = config.serverOnly?.dataSources?.skillsDir;
      const skills = dir ? await listSkillsIn(dir) : [];
      return json(res, 200, { skills, generatedAt: nowIso() });
    } catch (error) {
      return json(res, 500, { error: 'skills_read_failed', message: error.message, generatedAt: nowIso() });
    }
  },

  '/api/docs': async (_req, res, config, url) => {
    const docs = config.serverOnly?.dataSources?.docs || [];
    const wantPath = url.searchParams.get('path');
    if (wantPath) {
      const doc = docs.find((d) => d.path === wantPath); // 許可リスト一致のみ読む
      if (!doc) return json(res, 404, { error: 'doc_not_allowed', message: '許可されていないパスです。', generatedAt: nowIso() });
      try {
        const content = await fsp.readFile(doc.path, 'utf8');
        return json(res, 200, { label: doc.label, path: doc.path, content, generatedAt: nowIso() });
      } catch (error) {
        return json(res, 500, { error: 'doc_read_failed', message: error.message, generatedAt: nowIso() });
      }
    }
    return json(res, 200, { docs: docs.map((d) => ({ label: d.label, path: d.path })), generatedAt: nowIso() });
  },

  '/api/agents': async (_req, res, config) => {
    const agentDefs = config.agents || {};
    const keys = Object.keys(agentDefs);
    const panes = (await tmuxPanes(config)).map((p) => {
      const agentKey = resolveAgentKey(p.path, keys);
      const def = agentKey ? agentDefs[agentKey] : null;
      return { ...p, agentKey, label: def?.label || agentKey || null, color: def?.color || null };
    });
    return json(res, 200, { panes, generatedAt: nowIso() });
  },

  '/api/sessions': async (_req, res, config, url, baseDir) => {
    try {
      const cfg = config.serverOnly?.dataSources?.sessions || {};
      const live = await liveSessionSet(cfg.liveRegistryDir);
      const pins = await readPins(pinsFilePath(config, baseDir));
      const project = (url?.searchParams.get('project') || '').trim() || null;
      const r = await scanSessions(cfg.projectsRoot, cfg.limit, live, { pins, project });
      return json(res, 200, { ...r, generatedAt: nowIso() });
    } catch (error) {
      return json(res, 500, { error: 'sessions_failed', message: error.message, generatedAt: nowIso() });
    }
  },

  '/api/pin-session': async (_req, res, config, url, baseDir) => {
    const id = (url.searchParams.get('id') || '').trim();
    if (!UUID_RE.test(id)) return json(res, 400, { error: 'bad_id', generatedAt: nowIso() });
    try {
      const pinned = await togglePin(pinsFilePath(config, baseDir), id);
      return json(res, 200, { ok: true, pinned, generatedAt: nowIso() });
    } catch (error) {
      return json(res, 500, { error: 'pin_failed', message: error.message, generatedAt: nowIso() });
    }
  },

  '/api/archive': async (_req, res, config) => {
    try {
      const acfg = config.serverOnly?.dataSources?.archive || {};
      const r = await scanSessions(acfg.root, acfg.limit, null);
      const script = acfg.restoreScript;
      const sessions = r.sessions.map((s) => ({ ...s, restoreCmd: script ? `bash "${script}" restore ${s.sessionId}` : '' }));
      return json(res, 200, { ...r, sessions, generatedAt: nowIso() });
    } catch (error) {
      return json(res, 500, { error: 'archive_failed', message: error.message, generatedAt: nowIso() });
    }
  },

  '/api/memory-search': async (_req, res, config, url) => {
    const q = readQuery(url);
    if (!q) return json(res, 400, { error: 'empty_query', generatedAt: nowIso() });
    const r = await memorySearch(config, q, 15);
    return json(res, r.error ? 500 : 200, { ...r, query: q, generatedAt: nowIso() });
  },

  '/api/session-search': async (_req, res, config, url) => {
    const q = readQuery(url);
    if (!q) return json(res, 400, { error: 'empty_query', generatedAt: nowIso() });
    const r = await sessionSearch(config, q, 40);
    return json(res, r.error ? 500 : 200, { ...r, query: q, generatedAt: nowIso() });
  },

  '/api/log-search': async (_req, res, config, url) => {
    const q = readQuery(url);
    if (!q) return json(res, 400, { error: 'empty_query', generatedAt: nowIso() });
    const r = await logSearch(config, q, 40);
    return json(res, r.error ? 500 : 200, { ...r, query: q, generatedAt: nowIso() });
  },

  '/api/archive-session': async (_req, res, config, url) => {
    const id = (url.searchParams.get('id') || '').trim();
    if (!UUID_RE.test(id)) return json(res, 400, { error: 'bad_id', generatedAt: nowIso() });
    const cfg = config.serverOnly?.dataSources?.sessions || {};
    const live = await liveSessionSet(cfg.liveRegistryDir);
    if (live.has(id)) return json(res, 409, { error: 'session_live', message: '稼働中のセッションは退避できません。', generatedAt: nowIso() });
    const archiveRoot = config.serverOnly?.dataSources?.archive?.root;
    if (!cfg.projectsRoot || !archiveRoot) return json(res, 500, { error: 'config_missing', message: 'projectsRoot / archive.root が未設定です。', generatedAt: nowIso() });
    try {
      const r = await moveSessionFile(id, cfg.projectsRoot, archiveRoot);
      return json(res, r.ok ? 200 : 404, { ...r, generatedAt: nowIso() });
    } catch (error) {
      return json(res, 500, { error: 'archive_move_failed', message: error.message, generatedAt: nowIso() });
    }
  },

  '/api/restore-session': async (_req, res, config, url) => {
    const id = (url.searchParams.get('id') || '').trim();
    if (!UUID_RE.test(id)) return json(res, 400, { error: 'bad_id', generatedAt: nowIso() });
    const projectsRoot = config.serverOnly?.dataSources?.sessions?.projectsRoot;
    const archiveRoot = config.serverOnly?.dataSources?.archive?.root;
    if (!projectsRoot || !archiveRoot) return json(res, 500, { error: 'config_missing', message: 'projectsRoot / archive.root が未設定です。', generatedAt: nowIso() });
    try {
      const r = await moveSessionFile(id, archiveRoot, projectsRoot);
      return json(res, r.ok ? 200 : 404, { ...r, generatedAt: nowIso() });
    } catch (error) {
      return json(res, 500, { error: 'restore_move_failed', message: error.message, generatedAt: nowIso() });
    }
  },

  '/api/health': async (_req, res) => {
    return json(res, 200, { status: 'ok', timestamp: nowIso() });
  }
};

/**
 * /api/* をルーティングして処理する。未知のパスは 404。
 * @param {http.IncomingMessage} req
 * @param {http.ServerResponse} res
 * @param {object} config 設定（リクエスト毎に読み直したもの）
 * @param {URL} url
 * @param {string} baseDir dashboard ディレクトリ（相対パス解決用）
 */
async function handleApi(req, res, config, url, baseDir) {
  const route = ROUTES[url.pathname];
  if (route) return route(req, res, config, url, baseDir);
  return json(res, 404, { error: 'api_not_found', message: 'API エンドポイントが存在しません。', generatedAt: nowIso() });
}

module.exports = { handleApi, ROUTES };
