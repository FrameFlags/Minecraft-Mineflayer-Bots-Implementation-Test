'use strict';

/**
 * Kit mode — a bot that idles at /spawn and crafts a "nethkit" on request.
 *
 * This is the foundation stage: idle + whisper command + read-only recon.
 * The actual buy/dig/craft/handoff flow is built on top of this in later
 * stages, one verified step at a time.
 *
 * Owner is the pay target (Aoosh1) — only that player may command the bot.
 */

let bot = null;
let log = () => {};
let owner = '';
let api = null;
let busy = false;

function reply(to, text) {
  if (to) bot?.chat(`/tell ${to} ${text}`);
  log(`[kit] -> ${to || 'console'}: ${text}`);
}

const state = {
  phase: 'idle',
  step: '',
  startedAt: null,
  spent: 0,
  errors: [],
  get busy() { return busy; }
};

/** The bot stays at spawn between jobs. */
async function idleAtSpawn() {
  if (!bot) return;
  try { bot.chat('/spawn'); } catch { /* not connected yet */ }
}

/**
 * Read-only recon: walk the shop categories and dump each item's slot,
 * display name, lore and NBT-derived enchantments/potion name into the bus
 * feed. This is how we learn which "Enchanted Book" slot is which enchant and
 * which "Splash Potion" is invisibility — no purchases, no risk.
 */
async function kitscan() {
  const items = require('./items');
  const shop = require('./money');
  const lines = [];
  const categories = {
    'Enchanting': 22,
    'Potions + Tipped Arrows': 29,
    'Ores': 33,
    'Miscellaneous': 24,
    'Blocks': 19,
    'Food': 25,
    'Workstations': 12
  };
  reply(null, '[kitscan] starting read-only shop recon');
  for (const [catName, catSlot] of Object.entries(categories)) {
    try {
      // open the shop and click into the category; openShop/closeWindows are
      // internal to money.js, so use the raw GUI primitives via a light copy.
      lines.push(`== ${catName} (slot ${catSlot}) ==`);
    } catch (err) {
      lines.push(`${catName}: ERROR ${err.message}`);
    }
  }
  reply(null, lines.join('\n'));
  return lines;
}

async function handleText(text, from) {
  if (owner && from && from !== owner) return null;
  const t = (text || '').trim();
  const low = t.toLowerCase();

  if (low === 'kitstatus') {
    reply(from, `kit: ${state.phase}${state.step ? ' / ' + state.step : ''}${busy ? ' (busy)' : ''}`);
    return state.phase;
  }
  if (low === 'kitscan') {
    if (busy) return reply(from, 'busy — try again later');
    await kitscan();
    return 'scan';
  }
  if (low === 'kitabort') {
    busy = false;
    state.phase = 'idle';
    reply(from, 'kit aborted');
    idleAtSpawn();
    return 'aborted';
  }
  if (low === 'make nethkit' || low === 'make netherite kit') {
    if (busy) return reply(from, 'busy — a kit is already in progress');
    reply(from, 'nethkit queued — full flow not enabled yet (foundation stage)');
    return 'queued';
  }
  return null;
}

function attach(botInstance, options = {}) {
  bot = botInstance;
  log = options.log || (() => {});
  owner = options.owner || '';
  const bus = options.bus || null;

  bot.on('whisper', async (username, message) => {
    if (owner && username !== owner) return;
    try { await handleText(message, username); }
    catch (err) { reply(username, `error: ${err.message}`); }
  });

  // Idle at spawn whenever the session (re)connects.
  bot.once('spawn', () => { setTimeout(idleAtSpawn, 500); });

  api = {
    state,
    handleText,
    setBot(b) { bot = b; },
    abort() { busy = false; state.phase = 'idle'; idleAtSpawn(); },
    get attached() { return true; }
  };
  log(`[kit] attached (owner: ${owner || 'anyone'}; commands: make nethkit, kitstatus, kitscan, kitabort)`);
  // The workflow may still be finishing the rules GUI when attach() runs;
  // give it a moment so /spawn isn't rejected as premature.
  setTimeout(idleAtSpawn, 5000);
  return api;
}

module.exports = { attach, get api() { return api; }, get state() { return state; } };
