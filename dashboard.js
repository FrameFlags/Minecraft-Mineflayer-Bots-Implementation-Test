'use strict';

/**
 * Local dashboard server.
 *
 * The bots run on GitHub Actions runners and talk to this machine through plain
 * JSON files in the repo (see lib/remote.js). This server:
 *   - serves the web UI (web/dashboard.html + the existing pages),
 *   - reads bus/state/<id>.json for the sidebar,
 *   - appends commands you type to bus/cmd/<id>.json.
 *
 * Bots are identified by slot index (slot0, slot1, …), never by account name.
 *
 * Run:  node dashboard.js
 * Env:  BUS_REPO (default Sekai0NI0itamio/serverbots)
 *       BUS_TOKEN — defaults to `gh auth token`
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const remote = require('./lib/remote');
const bus = require('./lib/buscrypto');

const API = 'https://api.github.com';
const PORT = Number(process.env.DASH_PORT || process.env.WEB_PORT || 3000);
const HOST = process.env.DASH_HOST || '127.0.0.1';
const REPO = process.env.BUS_REPO || 'Sekai0NI0itamio/serverbots';
const BRANCH = process.env.BUS_BRANCH || 'bus';
const KEY = bus.readKey();

function ghToken() {
  try { return execFileSync('gh', ['auth', 'token'], { encoding: 'utf8' }).trim(); } catch { return ''; }
}

const TOKEN = process.env.BUS_TOKEN || ghToken();

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}

async function ghJson(url, opts = {}) {
  const res = await fetch(`${API}${url}`, {
    ...opts,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
      ...(opts.headers || {})
    }
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* not json */ }
  if (!res.ok) throw new Error((json && json.message) || `${res.status} ${text.slice(0, 160)}`);
  return json;
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;

  try {
    if (p === '/api/bots') {
      const list = await ghJson(`/repos/${REPO}/contents/bus/state?ref=${BRANCH}`);
      const bots = (Array.isArray(list) ? list : [])
        .filter(f => f.name.endsWith('.json'))
        .map(f => f.name.replace(/\.json$/, ''));
      return send(res, 200, { bots, repo: REPO });
    }

    if (p === '/api/state') {
      const bot = url.searchParams.get('bot');
      if (!bot) return send(res, 400, { error: 'bot is required' });
      const file = await remote.readContents(TOKEN, REPO, BRANCH, `bus/state/${bot}.json`);
      if (!file) return send(res, 404, { error: 'no state yet for ' + bot });
      let state;
      try {
        state = JSON.parse(file.buffer.toString('utf8'));
      } catch (err) {
        return send(res, 500, { error: 'could not parse state: ' + err.message });
      }
      // The published file is plain; only its embedded chat log is encrypted.
      const { feedBlob, ...rest } = state;
      let feed = [];
      if (feedBlob) {
        if (!KEY) return send(res, 500, { error: 'no log key — run scripts/make-key.sh' });
        try { feed = bus.decryptJSON(feedBlob, KEY); }
        catch (err) { return send(res, 500, { error: 'could not decrypt chat log: ' + err.message }); }
      }
      return send(res, 200, { ...rest, feed });
    }

    if (p === '/api/command' && req.method === 'POST') {
      const body = await new Promise(resolve => {
        let data = '';
        req.on('data', c => { data += c; if (data.length > 1e5) req.destroy(); });
        req.on('end', () => { try { resolve(JSON.parse(data || '{}')); } catch { resolve({}); } });
      });
      const bot = String(body.bot || '').trim();
      const text = String(body.text || '').trim();
      if (!bot || !text) return send(res, 400, { error: 'bot and text are required' });
      if (!/^[a-zA-Z0-9_]{3,16}$/.test(bot)) return send(res, 400, { error: 'bad bot name' });

      // Append to the queue, then let the runner drain it.
      const file = await remote.readContents(TOKEN, REPO, BRANCH, `bus/cmd/${bot}.json`);
      const doc = (file && JSON.parse(file.buffer.toString('utf8'))) || { commands: [] };
      doc.commands = Array.isArray(doc.commands) ? doc.commands : [];
      doc.commands.push({ id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`, text, ts: Date.now() });
      await remote.writeContents(
        TOKEN, REPO, BRANCH, `bus/cmd/${bot}.json`,
        JSON.stringify(doc),
        `bus: command for ${bot}`
      );
      return send(res, 200, { ok: true, queued: doc.commands.length });
    }

    // static files
    const rel = p === '/' ? 'dashboard.html' : p.replace(/^\/+/, '');
    const file = path.join(__dirname, 'web', rel);
    if (!file.startsWith(path.join(__dirname, 'web') + path.sep)) {
      return send(res, 403, 'forbidden', 'text/plain');
    }
    fs.readFile(file, (err, data) => {
      if (err) return send(res, 404, 'not found', 'text/plain');
      send(res, 200, data, MIME[path.extname(file)] || 'application/octet-stream');
    });
  } catch (err) {
    send(res, 502, { error: err.message });
  }
});

server.listen(PORT, HOST, () => {
  console.log(`[dashboard] http://${HOST}:${PORT}/  (repo ${REPO}, branch ${BRANCH})`);

});
