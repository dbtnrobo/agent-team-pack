'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const { execFile } = require('child_process');
const { resolveSafe } = require('./util');

// 各種データソースの読み取り（すべて read-only・LLM を一切呼ばない）。
// タスク/プロジェクト/skills は Markdown を、エージェント稼働状況は tmux を、
// 記憶/生ログ検索は既存の CLI/grep を呼ぶだけ。課金が乗る経路は持たない。

/**
 * タスクディレクトリ内の *.md を読み込む。
 * @param {object} config 設定（taskDir を参照）
 * @param {string} baseDir 相対パス解決の基準（dashboard ディレクトリ）
 * @returns {Promise<Array<{name,modifiedAt,size,content}>>}
 */
async function listTaskFiles(config, baseDir) {
  const taskDirRel = config.taskDir || '../tasks';
  const taskDir = path.resolve(baseDir, taskDirRel);
  const entries = await fsp.readdir(taskDir, { withFileTypes: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith('.md'))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b, 'ja'));

  const results = [];
  for (const name of files) {
    let safePath;
    try { safePath = resolveSafe(taskDir, name); } catch (_error) { continue; }
    const [content, stat] = await Promise.all([fsp.readFile(safePath, 'utf8'), fsp.stat(safePath)]);
    results.push({ name, modifiedAt: stat.mtime.toISOString(), size: stat.size, content });
  }
  return results;
}

/**
 * 指定ディレクトリ内の prefix*.md を読む（resolveSafe でディレクトリ内に限定）。
 * @param {string} dir
 * @param {string} prefix 先頭一致（空なら全 .md）
 * @returns {Promise<Array<{name,modifiedAt,content}>>}
 */
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

/**
 * skillsDir/<name>/SKILL.md を一覧する。SKILL.md の無いディレクトリはスキップ。
 * @param {string} skillsDir
 * @returns {Promise<Array<{name,content}>>}
 */
async function listSkillsIn(skillsDir) {
  const entries = await fsp.readdir(skillsDir, { withFileTypes: true });
  const results = [];
  for (const dir of entries.filter((e) => e.isDirectory()).sort((a, b) => a.name.localeCompare(b.name))) {
    const skillFile = path.join(skillsDir, dir.name, 'SKILL.md');
    try {
      const content = await fsp.readFile(skillFile, 'utf8');
      results.push({ name: dir.name, content });
    } catch (_e) { /* SKILL.md 無しはスキップ */ }
  }
  return results;
}

/**
 * tmux の "agents" セッションのペイン稼働状況を取得する。tmux が無ければ空配列。
 * @returns {Promise<Array<{window,title,command,path}>>}
 */
function tmuxPanes() {
  return new Promise((resolve) => {
    execFile('tmux',
      ['list-panes', '-s', '-t', 'agents', '-F', '#{window_name}|||#{pane_title}|||#{pane_current_command}|||#{pane_current_path}'],
      { timeout: 3000 },
      (err, stdout) => {
        if (err || !stdout) return resolve([]);
        const panes = stdout.trim().split('\n').filter(Boolean).map((line) => {
          const [window, title, command, panePath] = line.split('|||');
          return { window, title, command, path: panePath || '' };
        });
        resolve(panes);
      });
  });
}

/**
 * 記憶検索: 既存の FTS5 索引 CLI を JSON モードで呼ぶ。LLM 非依存・課金ゼロ。
 * @param {object} config serverOnly.dataSources.memorySearch を参照
 * @param {string} q クエリ
 * @param {number} n 最大件数
 * @returns {Promise<{hits:any[]}|{error:string}>}
 */
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

/**
 * 生ログ検索: 全 transcript を grep（固定文字列・大小無視・各ファイル最初の1致）。
 * @param {object} config serverOnly.dataSources.logSearch を参照
 * @param {string} q クエリ
 * @param {number} limit 最大件数
 * @returns {Promise<{hits:any[]}|{error:string}>}
 */
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

module.exports = { listTaskFiles, listMarkdownIn, listSkillsIn, tmuxPanes, memorySearch, logSearch };
