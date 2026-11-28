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
  const { shop } = require('./money');
  const out = [];
  const categories = {
    'Enchanting': 22,
    'Potions + Tipped Arrows': 29,
    'Miscellaneous': 24,
    'Ores': 33
  };
  reply(null, '[kitscan] starting read-only shop recon');
  for (const [catName, catSlot] of Object.entries(categories)) {
    try {
      if (!(await shop.openShop())) { out.push(`${catName}: could not open shop`); continue; }
      await shop.click(catSlot);
      await shop.waitForTitle(new RegExp(catName, 'i'), 4000);
      const win = items.serializeWindow(bot);
      out.push(`== ${catName} (${win.container.filter(Boolean).length} items) ==`);
      for (const it of win.container) {
        if (!it) continue;
        const extra = it.enchantments?.length
          ? ` ENCH:${it.enchantments.map(e => `${e.name}:${e.level}`).join(',')}`
          : '';
        const nbtKeys = Object.keys(it.nbt?.value || {}).join(',');
        const lore = (it.lore || []).join(' / ').replace(/Buy Price|Sell Price|Usage|╚»/g, '').slice(0, 80);
        out.push(`slot${it.slot}|${it.name}|disp=${it.displayName}|nbt=${nbtKeys}${extra}|${lore}`);
      }
      await shop.closeWindows();
    } catch (err) {
      out.push(`${catName}: ERROR ${err.message}`);
      try { await shop.closeWindows(); } catch { /* ignore */ }
    }
  }
  const text = out.join('\n');
  log(`[kitscan]\n${text}`);
  // Publish to the bus feed in chunks (the feed tolerates long lines but
  // splitting keeps each entry readable).
  for (let i = 0; i < text.length; i += 900) reply(null, text.slice(i, i + 900));
  return out;
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
