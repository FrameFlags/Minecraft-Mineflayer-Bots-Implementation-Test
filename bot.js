'use strict';

// Tiny bot entry point. Everything reusable lives in lib/workflow.js and
// lib/commands.js — add future bots to config.js and they stay this small.
const { spawn } = require('node:child_process');
const config = require('./config');
const workflow = require('./lib/workflow');
const webui = require('./lib/webui');
const bus = require('./lib/bus');
const money = require('./lib/money');

// Self-heal: a slow memory leak shouldn't kill a bot that's earning. If the
// heap grows past the limit, re-exec this same process (same bot name, same
// env — so WEB_PORT and friends carry over) and let the workflow rejoin.
const MAX_HEAP_MB = Number(process.env.MAX_HEAP_MB || 3072);
setInterval(() => {
  const heap = process.memoryUsage().heapUsed / (1024 * 1024);
  if (heap < MAX_HEAP_MB) return;
  console.log(`[watchdog] heap ${heap.toFixed(0)}MB > ${MAX_HEAP_MB}MB — restarting`);
  try {
    const child = spawn(process.execPath, [__filename, ...process.argv.slice(2)], {
      stdio: 'inherit',
      // The watchdog re-exec must not pay the join stagger a second time.
      env: { ...process.env, BOT_STAGGER_DONE: '1' },
      detached: true
    });
    child.unref();
  } catch (err) {
    console.log(`[watchdog] re-exec failed: ${err.message}`);
    return;
  }
  process.exit(0);
}, 30000).unref();

// The runner passes a slot index (MC_SLOT) and the name list (MC_BOTS) through
// secrets, so no bot name is ever printed to the logs.
function pickBotName() {
  if (process.argv[2]) return process.argv[2];
  const list = (process.env.MC_BOTS || '').split(',').map(s => s.trim()).filter(Boolean);
  return list[Number(process.env.MC_SLOT) || 0] || list[0];
}
const botName = pickBotName();
const botOptions = config.bots[botName] || { username: botName };

if (!botName) {
  console.error('No bot selected: pass a name or set MC_BOTS + MC_SLOT.');
  process.exit(1);
}
console.log(`starting bot slot ${process.env.MC_SLOT ?? '-'}`);

// Random join slot assigned by the workflow (rank x 85s + jitter, re-rolled
// every run). Blocking here keeps the very first join spread out instead of
// all the bots landing in the same second.
const staggerMs = Number(process.env.BOT_STAGGER_MS || 0);
if (staggerMs > 0 && process.env.BOT_STAGGER_DONE !== '1') {
  console.log(`[stagger] holding the first join for ${staggerMs}ms`);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, staggerMs);
  console.log('[stagger] joining now');
}

const state = workflow.start({
  ...config.server,
  ...botOptions,
  workflow: config.workflow,
  accountsFile: config.accountsFile,
  registerPassword: config.registerPassword
});

// REMOTE_BUS=1 publishes this bot's state to (and takes commands from) plain
// JSON files in the repo — used by the GitHub Actions runners. The bus id is
// the slot index, never the account name, so the filenames stay anonymous.
const busId = `slot${process.env.MC_SLOT ?? '0'}`;
if (process.env.REMOTE_BUS === '1') {
  const remote = require('./lib/remote');
  remote.start({
    botName: busId,
    repo: process.env.BUS_REPO,
    branch: process.env.BUS_BRANCH || 'main',
    token: process.env.BUS_TOKEN || process.env.GITHUB_TOKEN,
    intervalMs: Number(process.env.BUS_INTERVAL_MS || 5000),
    stateIntervalMs: Number(process.env.BUS_STATE_INTERVAL_MS || 20000),
    cmdIntervalMs: Number(process.env.BUS_CMD_INTERVAL_MS || 15000),
    onCommand: text => state.executeCommand(text),
    snapshot: () => {
      const b = state.bot;
      return {
        bot: busId,
        ts: Date.now(),
        connected: !!(b && b.entity),
        phase: state.phase,
        feed: bus.recent().slice(-200),
        money: money.state,
        // AFK/home role: expose the live sneak flag so the panel can confirm it.
        afk: (() => {
          const h = require('./lib/homes').attached;
          return h ? { sneaking: h.sneaking } : null;
        })(),
        status: b && b.entity
          ? { health: b.health, food: b.food, pos: b.entity.position.toString() }
          : null
      };
    }
  });
}

// NO_WEBUI=1 runs headless (used by the GitHub Actions runners).
if (!process.env.NO_WEBUI) {
  webui.start({
    host: config.web.host,
    port: config.web.port,
    openBrowser: config.web.openOnStart,
    username: botOptions.username,
    getBot: () => state.bot,
    getPhase: () => state.phase,
    executeCommand: state.executeCommand
  });
}

// GitHub sends SIGTERM when a run is cancelled or hits its 3h timeout. Leave
// the server cleanly and give it a moment to process the disconnect, so the
// next run doesn't collide with a "already connected to this proxy" ghost.
const { staggeredQuit } = require('./lib/quit');

// Self-stop: leave on our own terms at the 3h mark (a little before the job
// timeout) so the disconnect is graceful and the next scheduled run starts
// from a clean slate.
const RUN_LIMIT_MS = Number(process.env.RUN_LIMIT_MS || 170 * 60 * 1000);
setTimeout(() => {
  console.log(`\n[run] ${Math.round(RUN_LIMIT_MS / 60000)} min reached — stopping for the next run`);
  staggeredQuit(state.bot, console.log);
  setTimeout(() => process.exit(0), 120000);
}, RUN_LIMIT_MS);

for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    console.log(`\n${signal} — leaving the server cleanly...`);
    staggeredQuit(state.bot, console.log);
  });
}
