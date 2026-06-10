'use strict';

const http = require('http');
const path = require('path');
const { URL } = require('url');
const { nowIso, json, isHostAllowed, serveStatic } = require('./lib/util');
const { readConfig } = require('./lib/config');
const { handleApi } = require('./lib/api');

const BASE_DIR = __dirname;
// 既定は同ディレクトリの config.json。テスト等で DASHBOARD_CONFIG を指定すれば差し替え可能。
const CONFIG_PATH = process.env.DASHBOARD_CONFIG || path.join(BASE_DIR, 'config.json');

// 配信を許可する静的ファイル（許可リスト方式・任意パスは配信しない）。
const PUBLIC_FILES = new Map([
  ['/', 'index.html'],
  ['/index.html', 'index.html'],
  ['/README.md', 'README.md'],
  ['/demo.html', 'demo.html']
]);

// LLM 非依存・純ファイル移動なので POST を許可する例外パス。それ以外は read-only(GET/HEAD)。
const MUTATING_PATHS = ['/api/archive-session', '/api/restore-session'];

function isMethodAllowed(method, pathname) {
  if (method === 'GET' || method === 'HEAD') return true;
  return method === 'POST' && MUTATING_PATHS.includes(pathname);
}

const DEFAULT_ALLOWED_HOSTS = ['localhost', '127.0.0.1'];
const config0 = readConfig(CONFIG_PATH);
// port/host は listen 時に固定（変更には再起動が必要）。allowedHosts は毎リクエストの config から読む。
const port = Number(process.env.PORT || 8080);
const host = process.env.HOST || config0.serverOnly?.host || '127.0.0.1';

const server = http.createServer(async (req, res) => {
  try {
    const config = readConfig(CONFIG_PATH); // 毎リクエストで読み直し、再起動なしで設定変更を反映
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    // HEAD はヘッダのみを返す（本文を書かない）。各ハンドラは res.end(body) を呼ぶため、ここで抑制する。
    if ((req.method || 'GET') === 'HEAD') {
      const end = res.end.bind(res);
      res.end = () => end();
    }

    if (!isMethodAllowed(req.method || 'GET', url.pathname)) {
      return json(res, 405, { error: 'method_not_allowed', message: 'GET / HEAD のみ利用できます（archive/restore のみ POST 可）。', generatedAt: nowIso() });
    }

    const allowedHosts = config.serverOnly?.allowedHosts || DEFAULT_ALLOWED_HOSTS;
    if (!isHostAllowed(req.headers.host, allowedHosts)) {
      return json(res, 403, { error: 'host_not_allowed', message: 'この Host ヘッダからのアクセスは許可されていません。config.json の serverOnly.allowedHosts を確認してください。', generatedAt: nowIso() });
    }

    if (url.pathname.startsWith('/api/')) {
      return handleApi(req, res, config, url, BASE_DIR);
    }

    if (PUBLIC_FILES.has(url.pathname)) {
      return serveStatic(res, BASE_DIR, PUBLIC_FILES.get(url.pathname));
    }

    return json(res, 404, { error: 'not_found', message: '指定されたリソースは存在しません。', generatedAt: nowIso() });
  } catch (error) {
    console.error('[server-error]', error);
    return json(res, 500, { error: 'internal_server_error', message: error.message, generatedAt: nowIso() });
  }
});

// テスト時（require された時）は listen しない。直接起動時のみサーバを立てる。
if (require.main === module) {
  server.listen(port, host, () => {
    console.log(`Dashboard server is running at http://${host}:${port}`);
    console.log(`Base directory: ${BASE_DIR}`);
    console.log(`Allowed Host headers: ${(config0.serverOnly?.allowedHosts || DEFAULT_ALLOWED_HOSTS).join(', ')}`);
  });
}

module.exports = { server, isMethodAllowed, PUBLIC_FILES };
