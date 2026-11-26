'use strict';

/**
 * Repo-backed control bus — runner side.
 *
 * The bot runs on a GitHub Actions runner, so the local dashboard talks to it
 * through files in the repo:
 *
 *   bus/state/<bot>.json   runner → dashboard (PLAIN state, encrypted chat blob)
 *   bus/cmd/<bot>.json     dashboard → runner (plain command queue)
 *
 * Everything is public except the chat log, which is encrypted and embedded in
 * the state file as `feedBlob` — no .enc filenames advertise it. Account names
 * and passwords never enter the repo; the bus identifies bots by slot index.
 * The log passphrase comes from BUS_KEY/STATE_KEY (a repo secret on the runner)
 * or the local key file the dashboard uses.
 */

const buscrypto = require('./buscrypto');

const API = 'https://api.github.com';

function authHeaders(token, extra = {}) {
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'Content-Type': 'application/json',
    ...extra
  };
}

/**
 * Bus files hold base64 TEXT, never raw ciphertext: GitHub re-encodes
 * non-UTF-8 file content (corrupting binary blobs), and raw.githubusercontent
 * is cached for minutes — which made the runner re-read a stale command queue
 * and execute the same command over and over. ASCII round-trips cleanly.
 */
async function readContents(token, repo, branch, path) {
  const res = await fetch(`${API}/repos/${repo}/contents/${path}?ref=${branch}`, {
    headers: authHeaders(token)
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`read ${path}: ${res.status}`);
  const data = await res.json();
  // writeContents stores base64 TEXT, so one decode returns exactly what the
  // writer passed (our plain JSON).
  const text = Buffer.from(data.content || '', 'base64').toString('utf8');
  return { buffer: Buffer.from(text, 'utf8') };
}

/** Blob sha, needed by the contents API to update an existing file. */
async function getSha(token, repo, branch, path) {
  const res = await fetch(`${API}/repos/${repo}/contents/${path}?ref=${branch}`, {
    headers: authHeaders(token)
  });
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`stat ${path}: ${res.status}`);
  const data = await res.json();
  return data.sha;
}

async function writeContents(token, repo, branch, path, contentB64, message) {
  // The contents API can hand back a stale sha; refetch and retry on a 409.
  let lastErr = '';
  for (let attempt = 0; attempt < 3; attempt++) {
    const sha = await getSha(token, repo, branch, path);
    // Store the base64 text itself (see readContents) — binary blobs get
    // re-encoded by GitHub and no longer decrypt.
    const body = { message, content: Buffer.from(contentB64, 'utf8').toString('base64'), branch };
    if (sha) body.sha = sha;
    const res = await fetch(`${API}/repos/${repo}/contents/${path}`, {
      method: 'PUT',
      headers: authHeaders(token),
      body: JSON.stringify(body)
    });
    if (res.ok) return true;
    if (res.status === 409) { lastErr = 'conflict'; continue; }
    throw new Error(`write ${path}: ${res.status} ${(await res.text()).slice(0, 200)}`);
  }
  throw new Error(`write ${path}: ${lastErr || 'failed'}`);
}

// The state file is plain and public: balance, phase, status, inventory.
// Only the chat feed is encrypted, and it lives inline as `feedBlob` so there
// is no .enc filename advertising that anything is hidden.
const statePath = bot => `bus/state/${bot}.json`;
const cmdPath = bot => `bus/cmd/${bot}.json`;

/**
 * Start the bridge. `snapshot()` returns the plain object to publish;
 * `onCommand(text)` runs a dashboard command through the normal command
 * registry.
 */
function start(opts = {}) {
  const {
    botName, repo, branch = 'main', token,
    intervalMs = 5000, stateIntervalMs = 20000, cmdIntervalMs = 15000,
    snapshot, onCommand
  } = opts;

  if (!botName || !repo || !token) {
    throw new Error('remote bus needs botName, repo and token');
  }

  let running = true;
  let inFlight = Promise.resolve();
  let lastState = 0;
  let lastCmd = 0;

  async function tick() {
    // 1) publish state — this costs API calls, so not every tick
    if (Date.now() - lastState >= stateIntervalMs) {
      lastState = Date.now();
      try {
        const snap = await Promise.resolve(snapshot());
        const key = buscrypto.readKey();
        if (!key) throw new Error('no log key — set BUS_KEY (or STATE_KEY)');
        // Everything except the chat log is public and readable.
        const { feed, ...publicState } = snap || {};
        const out = {
          ...publicState,
          feedBlob: buscrypto.encryptJSON(feed || [], key)
        };
        await writeContents(
          token, repo, branch, statePath(botName),
          JSON.stringify(out),
          `bus: ${botName} state`
        );
      } catch (err) {
        console.log(`[bus] state publish failed: ${err.message}`);
      }
    }

    // 2) drain commands — each poll is an API call, so not every tick
    if (Date.now() - lastCmd < cmdIntervalMs) return;
    lastCmd = Date.now();
    try {
      const file = await readContents(token, repo, branch, cmdPath(botName));
      const doc = file && JSON.parse(file.buffer.toString('utf8'));
      const pending = (doc && Array.isArray(doc.commands)) ? doc.commands : [];
      if (pending.length && typeof onCommand === 'function') {
        for (const c of pending) {
          try { await onCommand(c.text); } catch (err) {
            console.log(`[bus] command failed: ${err.message}`);
          }
        }
        await writeContents(
          token, repo, branch, cmdPath(botName),
          JSON.stringify({ commands: [], cleared: Date.now() }),
          `bus: ${botName} commands cleared`
        );
      }
    } catch (err) {
      console.log(`[bus] command poll failed: ${err.message}`);
    }
  }

  function loop() {
    if (!running) return;
    inFlight = inFlight.then(tick).catch(err => console.log(`[bus] ${err.message}`));
    setTimeout(loop, intervalMs);
  }
  loop();

  console.log(`[bus] remote control bus on (${repo}, state ${stateIntervalMs}ms, commands ${cmdIntervalMs}ms)`);
  return {
    stop() { running = false; },
    async now() { await tick(); }
  };
}

module.exports = { start, readContents, writeContents, statePath, cmdPath };
