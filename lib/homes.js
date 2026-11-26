'use strict';

/**
 * Home / AFK role.
 *
 * A bot with `mode: 'afk'` does not run the money loop. Instead it answers
 * whispers (and dashboard commands) from its owner:
 *
 *   /tell <bot> sethome <name>   teleport to the owner, record the home there,
 *                                run /sethome, then go back to /spawn
 *   /tell <bot> home list        list the homes it knows
 *   /tell <bot> afkhome <name>   teleport to a saved home and sneak for good
 *
 * The home list is kept in a plain JSON file in the repo bus so it survives
 * runner restarts.
 */

const remote = require('./remote');

let api = null;

function attach(bot, opts) {
  const {
    owner,
    repo,
    branch = 'bus',
    token,
    file = 'bus/homes.json',
    log = console.log
  } = opts || {};

  if (api) return api;
  const state = { bot, owner, homes: {}, sneak: false, _sneakTimer: null };

  api = {
    get homes() { return state.homes; },
    get sneaking() { return state.sneak; },
    handleText,
    stopSneak
  };

  async function load() {
    try {
      const f = await remote.readContents(token, repo, branch, file);
      if (f) state.homes = JSON.parse(f.buffer.toString('utf8')) || {};
    } catch (err) {
      state.homes = {};
      log(`[homes] could not read the saved list (${err.message}) — continuing with an empty list`);
    }
    return state.homes;
  }

  async function save() {
    try {
      await remote.writeContents(token, repo, branch, file, JSON.stringify(state.homes), 'homes: update');
    } catch (err) {
      log(`[homes] save failed: ${err.message}`);
    }
  }

  function reply(to, msg) {
    try { bot.whisper(to, msg); } catch { bot.chat(`/tell ${to} ${msg}`); }
  }

  function pos() {
    const p = bot.entity && bot.entity.position;
    return p ? { x: p.x, y: p.y, z: p.z } : null;
  }

  /** Wait until the bot has actually moved (a /tpa or /home takes effect). */
  async function waitTeleport(timeoutMs = 60000) {
    const from = pos();
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      await new Promise(r => setTimeout(r, 500));
      const now = pos();
      if (now && (!from || Math.hypot(now.x - from.x, now.y - from.y, now.z - from.z) > 8)) return true;
    }
    return false;
  }

  async function setHome(name) {
    if (!name) return 'usage: sethome <name>';
    await bot.chat(`/tpa ${owner}`);
    log(`[homes] tpa sent, waiting for the teleport…`);
    const moved = await waitTeleport();
    if (!moved) return `could not reach ${owner} (teleport not completed)`;
    await new Promise(r => setTimeout(r, 800)); // let the chunk load
    const p = pos();
    if (!p) return 'no position — aborting';
    state.homes[name] = { ...p, world: String(bot.game?.gameMode || ''), ts: Date.now() };
    await save();
    await bot.chat(`/sethome ${name}`);
    await new Promise(r => setTimeout(r, 500));
    await bot.chat('/spawn');
    return `home '${name}' saved at ${p.x.toFixed(0)}, ${p.y.toFixed(0)}, ${p.z.toFixed(0)}`;
  }

  async function afkHome(name) {
    await load(); // the store starts empty on a fresh runner
    // The server holds the authoritative list (/sethome), so even if our local
    // copy is missing we still try /home <name> rather than refusing.
    if (!state.homes[name]) log('[homes] not in the local list — asking the server anyway');
    log('[homes] afkhome: teleporting');
    await bot.chat(`/home ${name}`);
    const moved = await waitTeleport();
    startSneak();
    return moved ? `afk at '${name}' (sneaking)` : `sent /home ${name} — no move detected, still sneaking`;
  }

  /** Send the sneak packet for real. */
  function forceSneak(on) {
    try {
      // mineflayer's setControlState returns early when its LOCAL flag already
      // matches, so re-calling it after the server cleared the sneak (knockback,
      // plugin teleport, chunk reload) sent nothing at all. Toggle it so the
      // packet actually goes out.
      bot.setControlState('sneak', !on);
      bot.setControlState('sneak', on);
    } catch { /* not spawned yet */ }
  }

  function startSneak() {
    state.sneak = true;
    forceSneak(true);
    log('[homes] sneaking — re-asserted every 1.5s so a server reset cannot stand the bot up');
    clearInterval(state._sneakTimer);
    state._sneakTimer = setInterval(() => {
      if (!state.sneak) return clearInterval(state._sneakTimer);
      forceSneak(true);
    }, 1500);
  }

  function stopSneak() {
    state.sneak = false;
    clearInterval(state._sneakTimer);
    try { bot.setControlState('sneak', false); } catch { /* ignore */ }
  }

  /**
   * Run a home command. The answer is ALWAYS delivered by /tell to `to` (the
   * owner) — never to public chat, and never returned in a way the caller
   * could echo into the public bus feed.
   */
  async function handleText(text, to) {
    const [cmd, ...rest] = String(text || '').trim().split(/\s+/);
    const arg = rest.join(' ').trim();
    let res = null;
    switch (cmd.toLowerCase()) {
      case 'sethome': res = await setHome(arg); break;
      case 'home':
        if (arg.toLowerCase() !== 'list') res = 'usage: home list';
        else {
          await load();
          const names = Object.keys(state.homes);
          res = names.length
            ? names.map(n => {
                const h = state.homes[n];
                return `${n} (${h.x.toFixed(0)}, ${h.y.toFixed(0)}, ${h.z.toFixed(0)})`;
              }).join(' | ')
            : 'no homes yet — use sethome <name>';
        }
        break;
      case 'afkhome': res = await afkHome(arg); break;
      case 'afkstop': stopSneak(); res = 'stopped sneaking'; break;
      default: res = null;
    }
    if (res && to) reply(to, res);
    return res;
  }

  bot.on('whisper', async (username, message) => {
    if (owner && username !== owner) return; // only the owner commands this bot
    await handleText(message, username);     // answer by /tell, never in public
  });

  log('[homes] attached (whisper commands: sethome, home list, afkhome, afkstop)');
  // Pull the persisted list now, so the first command after a restart works.
  load().then(() => log(`[homes] loaded ${Object.keys(state.homes).length} saved home(s)`));
  return api;
}

module.exports = { attach, get attached() { return api; } };
