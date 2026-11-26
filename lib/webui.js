'use strict';

/**
 * Local web UI: serves the page and streams the bot's feed over WebSocket.
 *
 * Browser → server:
 *   { type: 'chat',    text }   → bot.chat(text)
 *   { type: 'command', text }   → run through the hot-reloadable command registry
 *
 * Server → browser:
 *   { kind: 'history', events }  (on connect)
 *   { kind: 'feed',    event }   (live)
 *   { kind: 'status',  status }  (every 2s)
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { exec } = require('node:child_process');
const { WebSocketServer } = require('ws');
const bus = require('./bus');

/** Open the page in the default browser (macOS/Linux/Windows). */
function openBrowser(url) {
  const cmd = process.platform === 'darwin'
    ? 'open'
    : process.platform === 'win32'
      ? 'start'
      : 'xdg-open';
  try {
    exec(`${cmd} "${url}"`).on('error', () => {});
  } catch {
    // opening the browser is a convenience only
  }
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml'
};

function start(opts = {}) {
  const host = opts.host || '127.0.0.1';
  const port = opts.port || 3000;
  const getBot = opts.getBot || (() => null);
  const getPhase = opts.getPhase || (() => null);
  const executeCommand = opts.executeCommand || (() => {});
  const webDir = path.join(__dirname, '..', 'web');

  function status() {
    const bot = getBot();
    return {
      username: opts.username || 'bot',
      connected: !!(bot && bot.entity),
      phase: getPhase()
    };
  }

  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const relative = urlPath === '/' ? 'index.html' : urlPath.replace(/^\/+/, '');
    const filePath = path.join(webDir, relative);

    if (!filePath.startsWith(webDir + path.sep)) {
      res.writeHead(403);
      res.end('forbidden');
      return;
    }

    fs.readFile(filePath, (err, data) => {
      if (err) {
        res.writeHead(404, { 'Content-Type': 'text/plain' });
        res.end('not found');
        return;
      }
      res.writeHead(200, { 'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream' });
      res.end(data);
    });
  });

  const wss = new WebSocketServer({ server });

  function broadcast(obj) {
    const data = JSON.stringify(obj);
    for (const ws of wss.clients) {
      if (ws.readyState === ws.OPEN) ws.send(data);
    }
  }

  wss.on('connection', ws => {
    ws.send(JSON.stringify({ kind: 'history', events: bus.recent() }));
    ws.send(JSON.stringify({ kind: 'status', status: status() }));
    if (bus.panel) ws.send(JSON.stringify({ kind: 'panel', state: bus.panel }));
    if (bus.snow) ws.send(JSON.stringify({ kind: 'snow', state: bus.snow }));

    ws.on('message', raw => {
      let msg;
      try {
        msg = JSON.parse(raw);
      } catch {
        return;
      }

      if (msg.type === 'chat') {
        const text = String(msg.text || '').trim();
        if (!text) return;
        const bot = getBot();
        if (!bot || !bot.entity) {
          bus.publish('system', 'not connected to the server yet');
          return;
        }
        bot.chat(text);
        bus.publish('out', text);
        return;
      }

      if (msg.type === 'command') {
        const text = String(msg.text || '').trim();
        if (!text) return;
        bus.publish('command', text);
        Promise.resolve(executeCommand(text)).catch(err => {
          bus.publish('error', `command error: ${err.message}`);
        });
        return;
      }

      // Container/inventory actions all route through the hot-reloadable
      // command registry, so new/changed commands apply immediately.
      const actionMap = {
        click: slot => `/click ${slot}`,
        take: slot => `/takeslot ${slot}`,
        deposit: slot => `/depositslot ${slot}`,
        takeall: () => '/takeall',
        depositall: () => '/depositall',
        accept: () => '/accept',
        closewindow: () => '/close',
        digsnow: () => '/digsnow',
        stopsnow: () => '/stopsnow'
      };

      const action = actionMap[msg.type];
      if (action) {
        const text = action(msg.slot);
        bus.publish('command', text);
        Promise.resolve(executeCommand(text)).catch(err => {
          bus.publish('error', `command error: ${err.message}`);
        });
      }
    });
  });

  bus.on('feed', entry => broadcast({ kind: 'feed', event: entry }));
  bus.on('panel', state => broadcast({ kind: 'panel', state }));
  bus.on('snow', state => broadcast({ kind: 'snow', state }));
  setInterval(() => broadcast({ kind: 'status', status: status() }), 2000);

  server.listen(port, host, () => {
    const url = `http://${host}:${port}/`;
    console.log(`[webui] open ${url}`);
    if (opts.openBrowser !== false) openBrowser(url);
  });

  return { server, wss, broadcast };
}

module.exports = { start };
