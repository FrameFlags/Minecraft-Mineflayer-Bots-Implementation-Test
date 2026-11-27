'use strict';

/**
 * Eye of Ender money loop.
 *
 * The shop sells Ender Pearls ($7.00) and Blaze Powder ($2.63); one of each
 * crafts into an Eye of Ender, which the shop buys for $55.00. Each pair
 * returns $45.37. The loop:
 *   1. read the balance from the shop GUI,
 *   2. work out how many pairs fit the balance AND the inventory
 *      (pearls stack 16, powder 64, eyes 16),
 *   3. buy that many pearls + powder, craft, sell, repeat.
 *
 * Every GUI step verifies the window title, and the shop GUI is closed
 * before crafting/selling (a shop window swallows inventory clicks).
 */

const items = require('./items');
const bus = require('./bus');
const config = require('../config');
const { goals } = require('mineflayer-pathfinder');

const PAYOUT = config.payout || { to: 'player', amount: 10000, threshold: 10000 };

// Shop layout (ESGUI): main menu -> category -> item -> confirm GUI.
const CAT_MOBS = 21;
const PEARL_SLOT = 4;
const POWDER_SLOT = 1;
const BTN_BUY = 13;   // "Click to purchase"
const BTN_STACKS = 31; // chest: switches the Buying GUI to whole stacks
const BTN_PLUS_1 = 23;
const BTN_PLUS_16 = 24;
const BTN_PLUS_32 = 25;

// Items sell in different stack sizes, so "N stacks" means different counts.
const STACK_SIZE = { ender_pearl: 16, blaze_powder: 64 };

async function guiClick(slot) {
  await bot.clickWindow(slot, 0, 0);
  await new Promise(r => setTimeout(r, opts.navMs));
}

/** The window title arrives before its items — wait for the slot data too. */
async function waitForSlot(slot, timeout = 4000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (bot.currentWindow?.slots?.[slot]) return true;
    await new Promise(r => setTimeout(r, 100));
  }
  return false;
}

const PEARL_PRICE = 7.0;
const POWDER_PRICE = 2.63;
const PAIR_COST = PEARL_PRICE + POWDER_PRICE;
const EYE_SELL = 55.0;

const PEARL_STACK = 16;
const POWDER_STACK = 64;
const EYE_STACK = 16;

let bot = null;

const state = {
  running: false,
  phase: 'idle',
  message: '',
  cycles: 0,
  balance: 0,
  eyesCrafted: 0,
  eyesSold: 0,
  spent: 0,
  earned: 0,
  payments: 0,
  paid: 0,
  lastPayAttemptAt: 0,
  // Health counters — these ride along in publishMoney so a timing change can
  // be judged by more than just the average cycle time.
  buyRetries: 0,
  navFailures: 0,
  craftFallbacks: 0,
  startedAt: null
};

const opts = {
  navMs: 600,
  buyMs: 500,
  craftMs: 200,
  sellMs: 2500,
    moveMs: 120,
    retryMs: 10000,
    payRetryMs: 60000,
    // A failed /pay (recipient offline) costs a 2.5s sleep plus a full shop
    // GUI round-trip. Back off hard on failure; keep it short on success.
    payFailRetryMs: 300000,
  // Buy in one armed GUI session per material: the plus buttons are the slow
  // part, so a big chunk means one long quantity build + one buy click instead
  // of a buy click every 50 items.
  chunk: 256
};

// What the money loop must keep; everything else is junk taking up slots.
const KEEP = new Set(['ender_pearl', 'blaze_powder', 'ender_eye']);

/** The only drops worth walking over for. */
function dropName(ent) {
  if (!ent) return null;
  if (ent.itemName) return ent.itemName;
  if (ent.item && ent.item.name) return ent.item.name;
  return null;
}

function publish(feed = true) {
  bus.publishMoney({ ...state });
  if (feed && state.message) bus.publish('system', `[eye] ${state.message}`);
}

function setPhase(phase, message, feed = true) {
  state.phase = phase;
  state.message = message;
  publish(feed);
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

/**
 * Walk to nearby dropped items and pick them up. When the connection drops
 * with a GUI open, the server spills the GUI/cursor items on the ground.
 */
async function collectDrops() {
  if (!bot || !bot.entity || !bot.pathfinder) return 0;
  // Only chase our own valuables. A busy server is littered with other
  // players' drops, and hoovering those up just fills the inventory with junk
  // that then has to be cleared every cycle.
  const drops = Object.values(bot.entities)
    .filter(e => e && e.name === 'item' && e.position && KEEP.has(dropName(e)))
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
  let collected = 0;
  for (const ent of drops.slice(0, 8)) {
    if (ent.position.distanceTo(bot.entity.position) > 40) break;
    try {
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalNear(ent.position.x, ent.position.y, ent.position.z, 1)),
        5000
      );
      collected++;
    } catch { /* ignore */ }
  }
  return collected;
}

// When no GUI is open, serializeWindow appends the player-only slots: armor
// (5-8) and offhand (45). Those are equipped gear, not inventory — counting
// them as junk made clearInventory try to throw the bot's own armour away
// every single cycle.
const EQUIPPED_SLOTS = new Set([5, 6, 7, 8, 45]);

function inv() {
  if (!bot) return [];
  const win = items.serializeWindow(bot);
  if (win.open) return win.inventory;
  return win.inventory.filter(i => !i || !EQUIPPED_SLOTS.has(i.slot));
}

/** First empty main-inventory slot, or -1 when the inventory is full. */
function findFreeSlot() {
  for (let i = 9; i <= 44; i++) if (!bot.inventory.slots[i]) return i;
  return -1;
}

function countItem(name) {
  return inv().filter(i => i && i.name === name).reduce((sum, i) => sum + i.count, 0);
}

function freeSlots() {
  return inv().filter(i => !i).length;
}

function findBalance() {
  if (!bot || !bot.currentWindow) return null;
  const win = items.serializeWindow(bot);
  const head = [...win.container, ...win.inventory]
    .find(i => i && (i.lore || []).some(line => /Balance/.test(line)));
  if (!head) return null;
  const match = head.lore.join(' ').match(/Balance:\s*\$([0-9,]+(?:\.[0-9]+)?)/);
  return match ? Number(match[1].replace(/,/g, '')) : null;
}

/** Window titles are chat components (JSON or object) — flatten to text. */
function titleText(title) {
  if (!title) return '';
  let value = title;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{')) {
      try { value = JSON.parse(trimmed); } catch { return trimmed; }
    } else {
      return trimmed;
    }
  }
  if (Array.isArray(value)) return value.map(titleText).join('');
  if (typeof value === 'object') {
    return (value.text || '') + (Array.isArray(value.extra) ? value.extra.map(titleText).join('') : '');
  }
  return String(value);
}

async function waitForTitle(pattern, timeout = 4000) {
  // Accepts a RegExp or a predicate on the flattened title.
  const test = typeof pattern === 'function' ? pattern : (t => pattern.test(t));
  const start = Date.now();
  while (Date.now() - start < timeout) {
    if (bot.currentWindow && test(titleText(bot.currentWindow.title))) return true;
    await new Promise(r => setTimeout(r, 150));
  }
  return false;
}

async function closeWindows() {
  if (!bot.currentWindow) return;
  const win = bot.currentWindow;
  try { bot.closeWindow(win); } catch { /* ignore */ }
  const start = Date.now();
  while (bot.currentWindow && Date.now() - start < 2500) {
    await new Promise(r => setTimeout(r, 150));
  }
}

async function openShop() {
  // Always re-open. A window titled "Shop" can be mid-transition (or a stale
  // GUI from the previous buy), and clicking its category then gets swallowed
  // — that was the cause of the ~5-11s cycles that bought nothing.
  await closeWindows();
  await new Promise(r => setTimeout(r, 400));
  bot.chat('/shop');
  const ok = await waitForTitle(/^Shop$/, 5000);
  if (ok) {
    await waitForSlot(CAT_MOBS, 3000);
    // The GUI keeps settling after the items arrive; clicking inside that
    // window is what makes the category click get swallowed.
    await new Promise(r => setTimeout(r, 600));
  }
  return ok;
}

/** Left-click a slot in the current window. */
async function click(slot) {
  await bot.clickWindow(slot, 0, 0);
  await new Promise(r => setTimeout(r, opts.navMs));
}

async function readBalance(forceRefresh = false) {
  // The shop GUI caches its balance line; reopen it so a fresh /pay shows up.
  if (forceRefresh) await closeWindows();
  await openShop();
  for (let i = 0; i < 8; i++) {
    const balance = findBalance();
    if (balance != null) return balance;
    await new Promise(r => setTimeout(r, 300));
  }
  return null;
}

/** Quantity currently shown in the "Buying >" confirm GUI (slot 22). */
function readQuantity() {
  if (!bot.currentWindow) return null;
  const win = items.serializeWindow(bot);
  const item = win.container.find(i => i && i.slot === 22);
  const match = (item?.lore || []).join(' ').match(/x\s*(\d+)/);
  return match ? Number(match[1]) : null;
}

/**
 * Buy `qty` of a shop item. Opens the confirm GUI once and reuses it for
 * every chunk — re-opening the shop per chunk was the slow part.
 */
/**
 * Buy by whole stacks: the chest button (31) opens "Buying stacks > X", where
 * the quantity is counted in stacks and the buttons add 1 / 16 / 32 of them.
 * Two or three clicks replace the old per-item +1 hammering.
 */
async function buyItemStacks(categorySlot, itemSlot, qty, itemName) {
  if (qty <= 0) return 0;
  // In "Buying stacks" the +1/+16/+32 buttons add that many STACKS, and the
  // lore on slot 22 shows the total in ITEMS (stackSize * stacks). Compare in
  // stacks, and re-read after every click because rapid clicks get swallowed.
  const stackSize = STACK_SIZE[itemName] || 16;
  const targetStacks = Math.ceil(qty / stackSize);
  const before = countItem(itemName);

  const dbg = m => bus.publish('system', `[eye] buy ${itemName} ${m}`);
  dbg(`target=${targetStacks} stacks`);

  // The shop GUI swallows clicks under load, and a half-finished navigation
  // used to burn ~10s and buy nothing. Redo the whole navigation up to three
  // times before giving up.
  for (let attempt = 1; attempt <= 3; attempt++) {
    await openShop();
    if (!await navigateToStacks(categorySlot, itemSlot, dbg, attempt)) continue;

    const stacks = () => Math.floor((readQuantity() ?? 0) / stackSize);
    dbg(`qty in GUI=${readQuantity() ?? stackSize} = ${stacks()} stacks (target ${targetStacks})`);
    for (let guard = 0; guard < 60; guard++) {
      const need = targetStacks - stacks();
      if (need <= 0) break;
      await guiClick(need >= 32 ? BTN_PLUS_32 : need >= 16 ? BTN_PLUS_16 : BTN_PLUS_1);
    }
    dbg(`final ${stacks()} stacks target=${targetStacks}`);

    await guiClick(BTN_BUY);
    await new Promise(r => setTimeout(r, opts.buyMs));
    await closeWindows();

    const got = Math.max(0, countItem(itemName) - before);
    if (got > 0) return got;
    state.buyRetries++;
    dbg(`bought 0 — retrying (${attempt}/3)`);
  }
  return 0;
}

/** Dump the open window's layout — used to see why a shop click was lost. */
function dumpWindow(tag) {
  const w = bot.currentWindow;
  if (!w) { bus.publish('system', `[eye] ${tag}: no window open`); return; }
  const names = [];
  for (const [i, it] of Object.entries(w.slots || {})) {
    if (it && Number(i) < 54) names.push(`${i}:${it.name}`);
  }
  bus.publish('system', `[eye] ${tag}: title="${titleText(w.title)}" n=${names.length} ${names.join(',')}`);
}

/** Click `slot` until the window title satisfies `test`. */
async function clickUntilTitle(slot, test, tries = 6) {
  for (let i = 0; i < tries; i++) {
    if (!(await waitForSlot(slot, 1500))) return false;
    await guiClick(slot);
    if (await waitForTitle(test, 1200)) return true;
    await new Promise(r => setTimeout(r, 250)); // let the GUI settle, then re-click
  }
  return false;
}

/** openShop → category → item → "Buying stacks". False if any click was lost. */
async function navigateToStacks(categorySlot, itemSlot, dbg, attempt) {
  // The shop GUI swallows clicks while it is still settling, so click until
  // the title actually changes instead of giving up after one try.
  if (!await clickUntilTitle(categorySlot, t => !/^Shop/.test(t))) {
    state.navFailures++;
    dbg(`attempt ${attempt}: category never opened`);
    dumpWindow('after category clicks');
    await closeWindows();
    return false;
  }
  if (!await clickUntilTitle(itemSlot, /^Buying/)) {
    state.navFailures++;
    dbg(`attempt ${attempt}: item never opened`);
    await closeWindows();
    return false;
  }
  if (!await clickUntilTitle(BTN_STACKS, /^Buying stacks/)) {
    state.navFailures++;
    dbg(`attempt ${attempt}: stacks view never opened`);
    await closeWindows();
    return false;
  }
  return true;
}

async function buyItem(categorySlot, itemSlot, qty, itemName) {
  if (qty <= 0) return 0;
  // Count before/after: the GUI can cap the quantity, and over-reporting the
  // purchase would corrupt the books.
  const before = itemName ? countItem(itemName) : null;
  let bought = 0;
  let remaining = qty;
  let armed = false;

  while (remaining > 0) {
    if (!armed) {
      if (!await openShop()) break;
      await new Promise(r => setTimeout(r, 200));
      await click(categorySlot);
      if (!await waitForTitle(/^(?!Shop$).*/, 3000)) break;
      await click(itemSlot);
      if (!await waitForTitle(/^Buying/, 3000)) break;
      armed = true;
    }

    const chunk = Math.min(opts.chunk, remaining);
    const current = readQuantity() ?? 1;
    const need = chunk - current;
    if (need > 0) {
      const steps = [
        [BTN_PLUS_32, Math.floor(need / 32)],
        [BTN_PLUS_16, Math.floor((need % 32) / 16)],
        [BTN_PLUS_1, need % 16]
      ];
      for (const [slot, times] of steps) {
        for (let i = 0; i < times; i++) await click(slot);
      }
      // Under lag the big plus clicks get swallowed (a 256 target was landing
      // on 11). Top up with +1 until the GUI actually shows the target.
      for (let guard = 0; guard < 64; guard++) {
        const q = readQuantity();
        if (q == null || q >= chunk) break;
        await click(BTN_PLUS_1);
      }
    }
    await click(BTN_BUY);
    await new Promise(r => setTimeout(r, opts.buyMs));
    bought += chunk;
    remaining -= chunk;

    // If the confirm GUI closed or changed, re-open it for the next chunk.
    if (!bot.currentWindow || !/^Buying/.test(titleText(bot.currentWindow.title))) armed = false;
  }
  if (before == null) return bought;
  return Math.max(0, countItem(itemName) - before);
}

/** Move anything left in the 2x2 crafting grid back into the inventory. */
async function clearGrid() {
  for (const s of [0, 1, 2, 3, 4]) {
    if (bot.inventory.slots[s]) {
      const free = bot.inventory.slots.findIndex((x, i) => i >= 9 && i <= 44 && !x);
      if (free >= 0) {
        try { await bot.moveSlotItem(s, free); } catch { /* ignore */ }
        await new Promise(r => setTimeout(r, 150));
      }
    }
  }
}

async function craftEyes(target) {
  await closeWindows(); // the shop GUI swallows crafting clicks
  await clearGrid();    // leftover ingredients make recipesFor() return nothing
  const item = bot.registry.itemsByName.ender_eye;
  const recipes = item ? (bot.recipesFor(item.id) || []) : [];
  const recipe = recipes.find(r => !r.requiresTable);
  if (!recipe) {
    setPhase('error', 'no 2x2 recipe for Eye of Ender (ingredients missing?)');
    return 0;
  }

  let crafted = 0;
  while (crafted < target) {
    const pearl = inv().find(i => i && i.name === 'ender_pearl');
    if (!pearl) break;

    // A shift-click with a full powder stack (64) and a pearl stack (16)
    // consumes 16 of each and leaves ~48 powder in grid slot 2. Reusing that
    // residue avoids 15 pointless clearGrid + move back-and-forth per cycle.
    const residue = bot.inventory.slots[2];
    const reusePowder = residue && residue.name === 'blaze_powder' && residue.count >= 16;
    if (crafted === 0) bus.publish('system', `[eye] craft residue slot2=${residue ? residue.name + ' x' + residue.count : 'empty'} (reuse=${!!reusePowder})`);
    if (!reusePowder) {
      const powder = inv().find(i => i && i.name === 'blaze_powder');
      if (!powder) break;
      if (bot.inventory.slots[2]) await bot.moveSlotItem(2, findFreeSlot());
      await bot.moveSlotItem(powder.slot, 2);
      await new Promise(r => setTimeout(r, 250));
    }

    // Top up the pearl slot; the residue above already covers the powder.
    await bot.moveSlotItem(pearl.slot, 1);
    await new Promise(r => setTimeout(r, 150));

    const before = countItem('ender_eye');
    await bot.clickWindow(0, 0, 1); // mode 1 = shift-click (quick craft)
    // Wait for the inventory to actually reflect the craft rather than a
    // fixed sleep: safe on lag, and usually much faster than 400ms.
    let made = 0;
    for (let poll = 0; poll < 20; poll++) {
      await new Promise(r => setTimeout(r, 50));
      made = countItem('ender_eye') - before;
      if (made > 0) break;
    }
    if (made > 0) {
      crafted += made;
      continue;
    }
    state.craftFallbacks++;

    // Fallback: one craft at a time.
    try {
      await bot.craft(recipe, 1, null);
      crafted++;
      await new Promise(r => setTimeout(r, opts.craftMs));
    } catch {
      await clearGrid();
      break;
    }
  }
  await clearGrid();
  return crafted;
}

/**
 * Move everything in the open container back into the inventory. Closing a
 * virtual GUI can void its contents, so recover first if a sell did not land.
 */
async function retrieveContainer() {
  const win = bot.currentWindow;
  if (!win) return;
  const invStart = win.inventoryStart ?? 54;
  const slots = win.slots || {};
  const free = [];
  for (let s = invStart; s < invStart + 36; s++) if (!slots[s]) free.push(s);

  for (let s = 0; s < invStart; s++) {
    if (!slots[s]) continue;
    const dest = free.shift();
    if (dest == null) break;
    try { await bot.moveSlotItem(s, dest); } catch { break; }
    await new Promise(r => setTimeout(r, opts.moveMs));
  }
}

/**
 * Sell the whole inventory of Eyes of Ender through the SellGUI: one GUI, all
 * the stacks loaded at once, one click on the star. Under lag this is a lot
 * cheaper than /sellall hand once per stack (which costs ~3s a stack).
 *
 * Returns { sold, ok } — ok is false when the GUI is unavailable or the click
 * produced no sale, so the caller can fall back and recover the items.
 */
/**
 * Sell everything matching `predicate` through the SellGUI: one GUI, all the
 * stacks loaded at once, one click on the star. Under lag this is a lot
 * cheaper than /sellall hand once per stack (~3s a stack).
 *
 * Returns { sold, ok } — ok is false when the GUI is unavailable or the click
 * produced no sale, so the caller can fall back and recover the items.
 */
async function sellViaGui(predicate, maxStacks = Infinity) {
  const count = () => inv().filter(i => i && predicate(i)).reduce((s, i) => s + i.count, 0);
  const before = count();
  if (before === 0) return { sold: 0, ok: false };

  await closeWindows();
  bot.chat('/sellgui');
  if (!await waitForTitle(/^SellGUI/i, 6000)) return { sold: 0, ok: false };

  const win = bot.currentWindow;
  const invStart = win.inventoryStart ?? 54;
  const slots = win.slots || {};
  let starSlot = -1;
  const input = [];
  for (let s = 0; s < invStart; s++) {
    const item = slots[s];
    if (item && /nether_star/i.test(item.name || '')) { starSlot = s; continue; }
    if (!item) input.push(s);
  }
  if (starSlot < 0 || input.length === 0) return { sold: 0, ok: false };

  // Load every matching stack into the empty input slots.
  let placed = 0;
  for (const item of inv().filter(i => i && predicate(i))) {
    if (placed >= input.length || placed >= maxStacks) break;
    try { await bot.moveSlotItem(item.slot, input[placed]); } catch { break; }
    placed++;
    await new Promise(r => setTimeout(r, opts.moveMs));
  }
  if (placed === 0) return { sold: 0, ok: false };

  await bot.clickWindow(starSlot, 0, 0);
  await new Promise(r => setTimeout(r, opts.sellMs));
  await closeWindows();

  const sold = Math.max(0, before - count());
  return { sold, ok: sold > 0 };
}

/** Old path: /sellall hand once per stack. Kept as the fallback. */
async function sellLegacy(predicate) {
  await closeWindows();
  let sold = 0;
  for (let guard = 0; guard < 200; guard++) {
    const items = inv().filter(i => i && predicate(i));
    const before = items.reduce((s, i) => s + i.count, 0);
    if (before === 0) break;
    const item = items[0];
    if (item.slot !== 36) {
      try { await bot.moveSlotItem(item.slot, 36); } catch { /* ignore */ }
    }
    bot.setQuickBarSlot(0);
    await new Promise(r => setTimeout(r, 400));
    if (!bot.heldItem) break; // nothing in hand — don't spam /sellall
    bot.chat('/sellall hand');
    await new Promise(r => setTimeout(r, opts.sellMs));
    const after = inv().filter(i => i && predicate(i)).reduce((s, i) => s + i.count, 0);
    sold += before - after;
    if (after >= before) break; // no progress
  }
  return sold;
}

async function sellAllEyes() {
  const gui = await sellViaGui(i => i.name === 'ender_eye');
  if (gui.ok) return gui.sold;
  await retrieveContainer();
  await closeWindows();
  return sellLegacy(i => i.name === 'ender_eye');
}

/**
 * Fast clear: toss junk straight out, no GUI round trip. The SellGUI path
 * below costs ~20s, which is why this one only drops.
 */
async function clearInventoryFast() {
  let dropped = 0;
  for (let i = 9; i <= 44; i++) {
    const item = bot.inventory.slots[i];
    if (!item || KEEP.has(item.name)) continue;
    try { await bot.tossStack(item); dropped++; } catch { break; }
    await new Promise(r => setTimeout(r, 60));
  }
  if (dropped > 0) {
    // Step aside so the dropped items are not instantly re-collected.
    try {
      const p = bot.entity.position;
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalNear(p.x + 3, p.y, p.z + 3, 0)),
        4000
      );
    } catch { /* ignore */ }
  }
  return dropped;
}

/**
 * Clear the inventory down to just the money-loop materials. Junk in the
 * inventory is what stops the buy from filling every slot, so this runs before
 * a big buy.
 */
async function clearInventory() {
  const gui = await sellViaGui(i => !KEEP.has(i.name));
  if (gui.ok) return gui.sold;
  await retrieveContainer();
  await closeWindows();

  // The shop does not buy tools/armor/etc ("No items found which can be sold"),
  // and /sellall hand costs ~3s an item. Drop the unsellable remainder so the
  // slots free up immediately.
  let dropped = 0;
  for (let i = 9; i <= 44; i++) {
    const item = bot.inventory.slots[i];
    if (!item || KEEP.has(item.name)) continue;
    try { await bot.tossStack(item); dropped++; } catch { break; }
    await new Promise(r => setTimeout(r, 80));
  }
  if (dropped > 0) {
    // Tossed items land at the bot's feet and get re-collected a moment later,
    // which made the clear fire forever. Step away so they stay dropped.
    try {
      const p = bot.entity.position;
      await withTimeout(
        bot.pathfinder.goto(new goals.GoalNear(p.x + 5, p.y, p.z + 5, 0)),
        5000
      );
    } catch { /* ignore */ }
  }
  return dropped;
}

/**
 * Cash out everything above the reserve. If the recipient is offline the
 * payment fails — we keep earning and retry later, so the next successful pay
 * is one bigger batch that lands all the accumulated money at once.
 */
async function maybePay() {
  if (state.balance < PAYOUT.threshold) return false;
  const since = Date.now() - state.lastPayAttemptAt;
  // Back off much harder after a failed pay (offline recipient): each failure
  // costs a 2.5s sleep plus a full shop-GUI balance read.
  const retry = state.lastPayOk === false ? opts.payFailRetryMs : opts.payRetryMs;
  if (state.lastPayAttemptAt && since < retry) return false;

  const before = state.balance;
  const amount = Math.floor(before - PAYOUT.reserve);
  if (amount <= 0) return false;

  state.lastPayAttemptAt = Date.now();
  setPhase('paying', `paying $${amount} to ${PAYOUT.to}…`, false);
  bot.chat(`/pay ${PAYOUT.to} ${amount}`);
  await sleep(2500);
  const after = await readBalance(true);
  if (after != null) state.balance = after;

  if (after != null && after < before - amount * 0.5) {
    state.payments++;
    state.lastPayOk = true;
    state.paid += amount;
    bus.publish('system', `[eye] paid $${amount} to ${PAYOUT.to} (total $${state.paid})`);
    setPhase('paid', `paid $${amount} to ${PAYOUT.to}`);
    return true;
  }
  state.lastPayOk = false;
  bus.publish('error', `[eye] payment of $${amount} to ${PAYOUT.to} failed (offline?) — kept it, will retry in ${Math.round(opts.payFailRetryMs / 60000)}min`);
  return false;
}

/**
 * Decide how many pearls/powder to buy. We want to end with N pairs, buying
 * only whichever material is short, and paying `7*(N-P) + 2.63*(N-W)`.
 * Pick the largest N that fits the balance and the free inventory slots.
 */
function planPurchase(balance, pearls, powder, free) {
  const start = Math.min(pearls, powder);
  let best = { buyP: 0, buyW: 0, n: start };
  for (let n = start; n <= start + 400; n++) {
    const cost = PEARL_PRICE * Math.max(0, n - pearls) + POWDER_PRICE * Math.max(0, n - powder);
    if (cost > balance + 1e-9) break;
    const slots = Math.ceil(n / PEARL_STACK) + Math.ceil(n / POWDER_STACK) + Math.ceil(n / EYE_STACK);
    if (slots > free) break;
    best = { buyP: Math.max(0, n - pearls), buyW: Math.max(0, n - powder), n };
  }
  return best;
}

async function loop() {
  while (state.running) {
    try {
      const balance = await readBalance();
      if (balance == null) {
        // Never spend against a stale balance.
        setPhase('error', 'could not read the balance — retrying');
        await sleep(opts.retryMs);
        continue;
      }
      state.balance = balance;

      // cash out once we hit the threshold
      if (await maybePay()) continue;

      await closeWindows();
      await clearGrid(); // don't let materials sit in the crafting grid

      // Other players' drops picked up at spawn eat the slots the buy needs.
      // Cheap toss when there are enough to matter; /clearinv sells instead.
      const junkCount = inv().filter(i => i && !KEEP.has(i.name)).length;
      if (junkCount >= 6) {
        const dropped = await clearInventoryFast();
        if (dropped > 0) bus.publish('system', `[eye] dropped ${dropped} junk item(s) to free slots`);
      }


      let pearls = countItem('ender_pearl');
      let powder = countItem('blaze_powder');

      // 16 pearls = one slot but 64 powder = one slot, so a pearl surplus locks
      // up 4x the room and starves the powder buy. Sell the surplus down.
      if (pearls > powder && freeSlots() < 12) {
        const stacksToFree = Math.min(pearls - powder, 12 - freeSlots());
        if (stacksToFree > 0) {
          const sold = await sellViaGui(i => i.name === 'ender_pearl', stacksToFree);
          if (sold > 0) {
            pearls = countItem('ender_pearl');
            bus.publish('system', `[eye] sold ${sold} pearls to free slots for powder`);
          }
        }
      }

      const tCycle = Date.now();

      // 1) buy ALL the material the balance + inventory allow
      const freeBefore = freeSlots();
      const plan = planPurchase(state.balance, pearls, powder, freeBefore);
      let boughtP = 0, boughtW = 0;
      const tBuy0 = Date.now();
      if (plan.buyP > 0 || plan.buyW > 0) {
        setPhase('buying', `buying ${plan.buyP} pearls + ${plan.buyW} powder (have ${pearls}p/${powder}w)`, false);
        boughtP = await buyItemStacks(CAT_MOBS, PEARL_SLOT, plan.buyP, 'ender_pearl');
        boughtW = await buyItemStacks(CAT_MOBS, POWDER_SLOT, plan.buyW, 'blaze_powder');
        state.spent += boughtP * PEARL_PRICE + boughtW * POWDER_PRICE;
      }
      const tBuy = (Date.now() - tBuy0) / 1000;

      // 2) craft ALL of it
      const craftable = Math.min(countItem('ender_pearl'), countItem('blaze_powder'));
      const tCraft0 = Date.now();
      if (craftable > 0) {
        setPhase('crafting', `crafting ${craftable} Eyes of Ender`, false);
        state.eyesCrafted += await craftEyes(craftable);
      }
      const tCraft = (Date.now() - tCraft0) / 1000;

      // 3) sell ALL the eyes
      const eyes = countItem('ender_eye');
      const tSell0 = Date.now();
      if (eyes > 0) {
        setPhase('selling', `selling ${eyes} Eyes of Ender`, false);
        const sold = await sellAllEyes();
        state.eyesSold += sold;
        state.earned += sold * EYE_SELL;
        state.cycles++;
      }
      const tSell = (Date.now() - tSell0) / 1000;

      bus.publish('system',
        `[eye] cycle ${((Date.now() - tCycle) / 1000).toFixed(1)}s | buy ${tBuy.toFixed(1)} craft ${tCraft.toFixed(1)} sell ${tSell.toFixed(1)}` +
        ` | plan ${plan.buyP}p+${plan.buyW}w got ${boughtP}p+${boughtW}w | free ${freeBefore} eyes ${eyes}`);

      if (plan.buyP === 0 && plan.buyW === 0 && craftable === 0 && eyes === 0) {
        setPhase('waiting', `balance $${state.balance.toFixed(2)} — no materials, need $${PAIR_COST.toFixed(2)} for a pair`);
        await sleep(opts.retryMs);
      }
    } catch (err) {
      setPhase('error', `loop error: ${err.message}`);
      await sleep(opts.retryMs);
    }
  }
  setPhase('idle', 'stopped');
}

function start(botInstance) {
  if (state.running) return false;
  bot = botInstance;
  state.running = true;
  state.startedAt = Date.now();
  setPhase('starting', 'starting');
  loop();
  return true;
}

function stop() {
  if (!state.running) return false;
  state.running = false;
  setPhase('stopping', 'stopping');
  return true;
}

function setBot(botInstance) {
  bot = botInstance;
  // A reconnect happens after a drop; collect anything that spilled.
  if (state.running) collectDrops();
}

module.exports = { start, stop, setBot, state, collectDrops, sellAllEyes, clearInventory, clearInventoryFast, sellViaGui };
