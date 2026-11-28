'use strict';

/**
 * Universal join workflow — shared by every bot.
 *
 * Bot files stay tiny: pick a config entry and call start().
 *
 *   const workflow = require('./lib/workflow');
 *   workflow.start({ host, port, version, username, workflow, accountsFile });
 *
 * Steps:
 *   1. join the server
 *   2. disconnect after firstJoinHoldMs (or as soon as the server drops us)
 *   3. rejoin after reconnectDelayMs
 *   4. /register <pw> <pw> on first ever join (password saved), else /login <pw>
 *   5. select the hotbar compass and right-click it
 *   6. wait for the GUI, take the TNT / lifesteal items
 * Then: WORKFLOW COMPLETE + interactive command mode.
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const mineflayer = require('mineflayer');
const commands = require('./commands');
const bus = require('./bus');
const items = require('./items');
const snow = require('./snow');
const money = require('./money');
const config = require('../config');

const DEFAULT_SERVER = {
  host: '127.0.0.1',
  port: 25565,
  version: '1.20.1',
  auth: 'offline',
  username: 'bot'
};

const DEFAULT_WORKFLOW = {
  firstJoinHoldMs: 2000,
  reconnectDelayMs: 1000,
  authDelayMs: 1200,
  compassSettleMs: 1000,
  compassTimeoutMs: 10000,
  guiTimeoutMs: 8000,
  connectTimeoutMs: 20000,
  maxReconnectAttempts: 10, // per phase, then it stops and waits for /reconnect
  autoAcceptRules: true, // click the rules/accept item when a GUI opens
  rulesAcceptMatch: ['accept', 'agree', 'confirm', 'allow', 'yes'],
  lootExact: ['tnt'],
  lootIncludes: ['lifesteal'],
  logChat: true
};

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function start(options = {}) {
  const cfg = {
    ...DEFAULT_SERVER,
    ...options,
    workflow: { ...DEFAULT_WORKFLOW, ...(options.workflow || {}) }
  };
  const wf = cfg.workflow;

  const state = {
    phase: 'initial',
    workflowDone: false,
    everCompleted: false,
    reconnecting: false,
    stopped: false,
    bot: null,
    rl: null,
    sessionId: 0,
    stop() {
      state.stopped = true;
      state.reconnecting = false;
      try { state.rl?.close(); } catch { /* already closed */ }
      try { state.bot?.quit(); } catch { /* already gone */ }
    }
  };

  // Retry counters, one per phase. Reset when a phase succeeds.
  const attempts = { initial: 0, workflow: 0, resume: 0 };
  // Window ids we already tried to accept the rules on (avoids double clicks).
  const acceptedWindows = new Set();
  let restartWatchStarted = false;

  const log = (...args) => {
    const text = args.join(' ');
    console.log(`[${cfg.username}]`, text);
    bus.publish('system', text);
  };
  const step = (n, text) => {
    const line = `[STEP ${n}/6] ${text}`;
    console.log(`[${cfg.username}] ${line}`);
    bus.publish('step', line);
  };

  /** Click the rules/accept item if the open window looks like a rules GUI. */
  function tryAcceptRules(bot, window) {
    if (!wf.autoAcceptRules || !window) return null;
    if (acceptedWindows.has(window.id)) return null;
    const slot = items.findRuleSlot(window, wf.rulesAcceptMatch);
    if (slot === -1) return null;
    acceptedWindows.add(window.id);
    log(`accepting rules (slot ${slot}: ${window.slots[slot].name})`);
    items.clickSlot(bot, slot).catch(err => log('accept failed:', err.message));
    return slot;
  }

  function assertConnected(bot) {
    if (state.stopped || state.bot !== bot || !bot.entity) {
      throw new Error('bot session is no longer active');
    }
  }

  /**
   * Quit the current session and wait until the server has actually dropped it.
   * Creating a new bot while the old one is still connected is exactly what
   * produces the "already connected to this proxy" ghost, which then blocks
   * the replacement for as long as the server keeps the stale session.
   */
  function closeSession(timeoutMs = 4000) {
    const old = state.bot;
    state.sessionId += 1; // invalidate the old session's handlers
    state.bot = null;
    if (!old) return Promise.resolve();
    return new Promise(resolve => {
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      try { old.once('end', finish); old.quit(); } catch { finish(); }
      setTimeout(finish, timeoutMs);
    });
  }

  /** setTimeout that won't fire if a newer session has taken over. */
  function later(fn, ms, sessionId) {
    setTimeout(() => {
      if (!state.stopped && sessionId === state.sessionId) fn();
    }, ms);
  }

  async function createSession(phase) {
    await closeSession();
    const sessionId = ++state.sessionId;
    state.phase = phase;
    state.reconnecting = false;
    if (phase === 'workflow') attempts.initial = 0; // first join succeeded

    if (phase === 'initial') {
      step(1, `joining ${cfg.host}:${cfg.port} (v${cfg.version})...`);
    } else if (phase === 'workflow') {
      step(3, `rejoining ${cfg.host}:${cfg.port} (v${cfg.version})...`);
    } else {
      log(`rejoining ${cfg.host}:${cfg.port} (v${cfg.version})...`);
    }

    const bot = mineflayer.createBot({
      host: cfg.host,
      port: cfg.port,
      version: cfg.version,
      auth: cfg.auth,
      username: cfg.username
    });
    state.bot = bot;

    // Keep the web panel in sync with whatever container/inventory is open.
    const panelTimer = setInterval(() => {
      try { bus.publishPanel(items.serializeWindow(bot)); } catch { /* not spawned yet */ }
    }, 400);

    let ended = false;
    let quitRequested = false;

    const connectTimer = setTimeout(() => {
      if (!bot.entity) {
        log('connection timed out');
        try { bot.quit(); } catch { /* ignore */ }
      }
    }, wf.connectTimeoutMs);

    // Everything the bot sees goes to the web feed. The CLI stays quiet unless
    // logChat is turned on in config.
    bot.on('chat', (username, message) => {
      if (username === bot.username) return;
      bus.publish('chat', message, { username });
      if (wf.logChat) console.log(`[chat] ${username}: ${message}`);
    });
    bot.on('whisper', (username, message) => {
      bus.publish('whisper', message, { username });
      if (wf.logChat) console.log(`[whisper] ${username}: ${message}`);
    });
    // messagestr fires for both player chat and system chat; player chat is
    // already handled above, so skip kind === 'chat'.
    bot.on('messagestr', (msg, kind) => {
      if (kind === 'chat') return;
      const type = kind === 'game_info' ? 'actionbar' : 'server';
      bus.publish(type, msg);
      if (wf.logChat) console.log(`[${type}] ${msg}`);
    });
    bot.on('title', (text, kind) => bus.publish('title', `${kind}: ${text}`));
    bot.on('windowOpen', window => tryAcceptRules(bot, window));

    bot.once('spawn', () => {
      clearTimeout(connectTimer);
      snow.setBot(bot); // keep the snow loop pointed at the live session
      money.setBot(bot); // keep the money loop pointed at the live session
      try { require('./kit').api?.setBot?.(bot); } catch { /* kit not attached */ }

      if (phase === 'initial') {
        step(2, `connected — disconnecting in ${wf.firstJoinHoldMs}ms`);
        setTimeout(() => {
          if (ended || quitRequested) return;
          quitRequested = true;
          try { bot.quit(); } catch { /* ignore */ }
        }, wf.firstJoinHoldMs);
        return;
      }

      if (phase === 'workflow') {
        runWorkflow(bot).catch(err => {
          log('workflow error:', err.message);
          scheduleWorkflowRetry();
        });
        return;
      }

      // phase === 'resume': run the whole workflow again — re-login, use the
      // compass, loot the GUI — so a reconnect leaves the bot fully set up.
      runWorkflow(bot).catch(err => {
        log('workflow error:', err.message);
        scheduleWorkflowRetry();
      });
    });

    bot.once('end', () => {
      clearTimeout(connectTimer);
      clearInterval(panelTimer);
      if (state.stopped || ended) return;
      if (sessionId !== state.sessionId) return; // a newer session took over
      ended = true;

      if (state.reconnecting) return; // requestReconnect() is already handling it

      const postWorkflow = phase === 'workflow' && state.everCompleted;
      const retryPhase = (postWorkflow || phase === 'resume') ? 'resume' : 'workflow';

      // Back off on every attempt: a ghost session ("already connected to
      // this proxy") only clears after the server times it out, so hammering
      // it once a second just makes it worse.
      const attemptNo = (phase === 'initial' ? attempts.initial : attempts[retryPhase]) + 1;
      // Hold the rejoin for a short stagger + fresh jitter, so a mass drop
      // never turns into a mass rejoin in the same minute. Do NOT re-apply the
      // full join slot here: that is an absolute offset from run start (up to
      // ~8min for the last rank), which would leave a kicked bot offline for
      // ages. Only the initial join and the quit use the absolute slot.
      const slot = Math.min(Number(process.env.BOT_STAGGER_MS || 0), 85000);
      const delay = Math.min(
        Math.max(65000, slot, wf.reconnectDelayMs * attemptNo) + Math.floor(Math.random() * 20000),
        wf.maxReconnectDelayMs || 600000
      );

      if (phase === 'initial') {
        if (quitRequested) {
          // The intended 2s disconnect: move on to the real (workflow) join.
          log(`disconnected — rejoining in ${delay}ms`);
          later(() => createSession('workflow'), delay, sessionId);
        } else {
          // Kicked/timed out before the 2s quit: retry the first join. Never
          // give up for good — a server that kicks a crowd should not leave the
          // bot offline for the rest of the run.
          attempts.initial++;
          log(`disconnected — rejoining in ${delay}ms (attempt ${attempts.initial})`);
          later(() => createSession('initial'), delay, sessionId);
        }
        return;
      }

      attempts[retryPhase]++;
      log(`disconnected — ${retryPhase === 'resume' ? 'reconnecting' : 'retrying'} in ${delay}ms (attempt ${attempts[retryPhase]})`);
      later(() => createSession(retryPhase), delay, sessionId);
    });

    bot.on('kicked', reason => {
      const text = reason?.toString?.() ?? String(reason);
      log('kicked:', text);
      // A server restart can roll back the auth database, leaving our saved
      // password stale. Drop it so the next workflow run re-registers.
      if (/wrong password/i.test(text)) {
        const accounts = readAccounts(cfg.accountsFile);
        if (accounts[bot.username]) {
          delete accounts[bot.username];
          writeAccounts(cfg.accountsFile, accounts);
          log('saved password rejected — cleared it, will re-register');
        }
      }
      // A kick normally produces a clean 'end' (handled above), but if the
      // client hangs up without it the bot would sit there offline. Make sure
      // a rejoin gets scheduled either way.
      setTimeout(() => {
        if (!ended && !state.reconnecting && !state.stopped) {
          log('kick did not produce a clean disconnect — forcing a rejoin');
          requestReconnect();
        }
      }, 8000);
    });
    bot.on('error', err => log('error:', err.message));
  }

  /**
   * True when the bot's inventory holds nothing but the compass it keeps in
   * its hotbar — the state a server restart leaves a bot in.
   */
  function inventoryWiped(bot) {
    const inv = bot && bot.inventory;
    if (!inv || !inv.slots) return false;
    let other = 0;
    for (const item of Object.values(inv.slots)) {
      if (!item) continue;
      if (!/compass/i.test(item.name || '')) other++;
    }
    return other === 0;
  }

  /** The join part of the workflow: compass → GUI → take the TNT/lifesteal kit. */
  async function runJoin(bot) {
    log('inventory wiped — re-running the join workflow');
    try {
      if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
    } catch { /* ignore */ }
    const window = await useCompass(bot);
    await lootWindow(bot, window);
    log('join re-run complete');
  }

  /**
   * Watch for a server restart. A restart drops the connection (the normal
   * reconnect already re-runs the workflow) and/or wipes the inventory; if the
   * bot is left with only its compass, redo the join workflow.
   */
  function startRestartWatch() {
    if (restartWatchStarted) return;
    restartWatchStarted = true;
    let lastJoin = Date.now();
    log('restart watcher active');
    setInterval(async () => {
      if (state.stopped || !state.workflowDone || state.phase !== 'active') return;
      const bot = state.bot;
      if (!bot || !bot.entity) return;
      if (Date.now() - lastJoin < wf.restartWatchCooldownMs) return;
      if (!inventoryWiped(bot)) return;
      lastJoin = Date.now();
      try {
        await runJoin(bot);
      } catch (err) {
        log('join re-run failed:', err.message);
      }
    }, wf.restartWatchMs);
  }

  /** A failed workflow shouldn't leave the bot idle — just retry it. */
  function scheduleWorkflowRetry() {
    const sessionId = state.sessionId;
    setTimeout(() => {
      if (state.stopped || state.reconnecting || sessionId !== state.sessionId) return;
      const bot = state.bot;
      if (!bot || !bot.entity) return;
      log('retrying the workflow');
      runWorkflow(bot).catch(err => log('workflow error:', err.message));
    }, wf.workflowRetryMs);
  }

  async function runWorkflow(bot) {
    await sleep(wf.authDelayMs);
    assertConnected(bot);
    await authenticate(bot);
    tryAcceptRules(bot, bot.currentWindow);
    assertConnected(bot);

    const window = await useCompass(bot);
    assertConnected(bot);
    await lootWindow(bot, window);
    assertConnected(bot);

    state.workflowDone = true;
    state.everCompleted = true;
    state.phase = 'active';
    attempts.workflow = 0;
    attempts.resume = 0;
    console.log(`[${cfg.username}] WORKFLOW COMPLETE`);
    startRestartWatch();
    commands.startCli(bot, ctx());
    if (cfg.mode === 'kit') {
      const kit = require('./kit');
      kit.attach(state.bot, { owner: config.kit?.owner, log });
    } else if (cfg.mode === 'afk') {
      const homes = require('./homes');
      homes.attach(bot, {
        owner: config.afk.owner,
        repo: process.env.BUS_REPO,
        branch: process.env.BUS_BRANCH || 'bus',
        token: process.env.BUS_TOKEN || process.env.GITHUB_TOKEN,
        file: config.afk.homesFile,
        log
      });
    } else if (config.money?.autoStart) {
      money.start(bot); // keep earning on its own
    }
  }

  /** Resolve with the first server message matching `re` within `ms`. */
  function watchFor(bot, re, ms) {
    return new Promise(resolve => {
      const timer = setTimeout(() => { bot.off('messagestr', onMsg); resolve(null); }, ms);
      function onMsg(msg) {
        if (re.test(String(msg))) {
          clearTimeout(timer);
          bot.off('messagestr', onMsg);
          resolve(String(msg));
        }
      }
      bot.on('messagestr', onMsg);
    });
  }

  async function authenticate(bot) {
    step(4, 'authenticating');
    const accounts = readAccounts(cfg.accountsFile);
    const saved = accounts[bot.username]?.password;
    const password = process.env.MC_PASSWORD || saved || cfg.registerPassword;

    if (!saved) {
      const pw = password || crypto.randomBytes(9).toString('base64url');
      // Persist first: a failed write must not leave the account registered
      // on the server with no local record of the password.
      accounts[bot.username] = { password: pw, registeredAt: new Date().toISOString() };
      writeAccounts(cfg.accountsFile, accounts);
      bot.chat(`/register ${pw} ${pw}`);
      log('sent /register (new account saved to accounts.json)');
    } else {
      bot.chat(`/login ${password}`);
      log('sent /login (password from accounts.json)');
      // A name can be pre-seeded locally before the server knows it (fresh
      // account, or a wiped auth db). Register with the SAME password so it
      // stays the one recorded in the bundle.
      if (await watchFor(bot, /isn't registered|not registered/i, 2500)) {
        log('server does not know this account — registering with the saved password');
        bot.chat(`/register ${password} ${password}`);
        await sleep(wf.authDelayMs);
      }
    }

    await sleep(wf.authDelayMs);
  }

  async function useCompass(bot) {
    step(5, 'looking for a compass');
    let slot;
    try {
      slot = await waitForCompass(bot);
    } catch (err) {
      // A brand-new account may not have a compass yet. The money loop does
      // not need it, so warn and carry on — failing here used to reconnect
      // every 20s for the rest of the run.
      log(`no compass (${err.message}) — continuing without it`);
      return null;
    }
    const start = bot.inventory.hotbarStart ?? 36;

    // A restart can shuffle the inventory, so the compass may not be in the
    // hotbar — move it there before selecting it.
    let hotbarSlot = slot;
    if (slot < start) {
      await bot.moveSlotItem(slot, start);
      hotbarSlot = start;
      log(`moved the compass from slot ${slot} to hotbar slot 0`);
    }
    const hotbarIndex = hotbarSlot - start;

    bot.setQuickBarSlot(hotbarIndex);
    log(`selected hotbar slot ${hotbarIndex} (inventory slot ${hotbarSlot})`);

    await sleep(wf.compassSettleMs);
    log('right-clicking the compass');

    // Register the listener BEFORE clicking so a fast server response can't be missed.
    const windowPromise = waitForWindow(bot, wf.guiTimeoutMs);
    windowPromise.catch(() => {}); // never leave an unhandled rejection behind
    bot.activateItem();
    return windowPromise;
  }

  async function waitForCompass(bot) {
    const deadline = Date.now() + wf.compassTimeoutMs;

    while (Date.now() < deadline) {
      for (const [slot, item] of Object.entries(bot.inventory.slots)) {
        if (item && /compass/i.test(item.name || '')) return Number(slot);
      }
      await sleep(500);
    }
    throw new Error(`no compass found in the inventory within ${wf.compassTimeoutMs}ms`);
  }

  function waitForWindow(bot, timeout) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`GUI did not open within ${timeout}ms`));
      }, timeout);

      function onOpen(window) {
        cleanup();
        resolve(window);
      }
      function onEnd() {
        cleanup();
        reject(new Error('disconnected while waiting for the GUI'));
      }
      function cleanup() {
        clearTimeout(timer);
        bot.removeListener('windowOpen', onOpen);
        bot.removeListener('end', onEnd);
      }

      bot.once('windowOpen', onOpen);
      bot.once('end', onEnd);
    });
  }

  async function lootWindow(bot, window) {
    if (!window) { log('no GUI to loot — skipped'); return; }
    step(6, 'GUI open — taking TNT / lifesteal items');

    const exact = wf.lootExact.map(n => n.toLowerCase());
    const includes = wf.lootIncludes.map(n => n.toLowerCase());
    const matches = [];

    // Slots before inventoryStart belong to the container/GUI, not the player.
    for (let slot = 0; slot < window.inventoryStart; slot++) {
      const item = window.slots[slot];
      if (!item) continue;
      const names = [item.name, item.displayName]
        .filter(Boolean)
        .map(n => String(n).toLowerCase());
      const hit = names.some(n => exact.includes(n) || includes.some(sub => n.includes(sub)));
      if (hit) matches.push({ slot, name: item.name, count: item.count });
    }

    if (matches.length === 0) log('no matching items found in the GUI');

    for (const match of matches) {
      try {
        if (bot.currentWindow !== window) throw new Error('window changed');
        await bot.putAway(match.slot);
        log(`took ${match.count}x ${match.name} from slot ${match.slot}`);
      } catch (err) {
        log(`failed to take ${match.name} from slot ${match.slot}: ${err.message}`);
      }
    }

    if (bot.currentWindow === window) {
      bot.closeWindow(window);
      log('closed the GUI');
    }
  }

  function requestReconnect() {
    if (state.reconnecting || state.stopped) return;

    state.reconnecting = true;
    state.workflowDone = false;
    attempts.initial = attempts.workflow = attempts.resume = 0;
    try { state.rl?.close(); } catch { /* ignore */ }

    // Quit the old session and wait for the drop before rejoining, so we don't
    // leave a ghost that blocks the new connection.
    closeSession().then(() => {
      if (state.stopped) return;
      setTimeout(() => {
        if (!state.stopped) createSession('resume');
      }, wf.reconnectDelayMs);
    });
  }

  function ctx() {
    return {
      cfg,
      state,
      restart: requestReconnect,
      runJoin,
      reply: (...args) => {
        const text = args.join(' ');
        console.log(text);
        bus.publish('system', text);
      }
    };
  }

  state.executeCommand = text => commands.executeCommand(text, state.bot, ctx());

  function readAccounts(file) {
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if (err.code === 'ENOENT') return {};
      throw new Error(`could not read accounts file ${file}: ${err.message}`);
    }
    try {
      return JSON.parse(raw) || {};
    } catch (err) {
      throw new Error(`accounts file ${file} is not valid JSON: ${err.message}`);
    }
  }

  function writeAccounts(file, accounts) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(accounts, null, 2));
    fs.renameSync(tmp, file);
  }

  createSession('initial');
  return state;
}

module.exports = { start };
