'use strict';

/**
 * Snow bot: hold a shovel, dig nearby snow layers until 64 snowballs, craft
 * them into snow blocks, then /sellall hand. Repeats until stopped.
 *
 * Start/stop from the CLI (/digsnow, /stopsnow) or the web page.
 */

const { goals, Movements, pathfinder: pathfinderPlugin } = require('mineflayer-pathfinder');
const bus = require('./bus');

const DEFAULTS = {
  targetSnowballs: 64,
  searchRadius: 64,
  digRetryDelayMs: 1500,
  noSnowRetryMs: 3000,
  alarmIntervalMs: 5000,
  repeatMsgMs: 20000,
  craftDelayMs: 200,
  sellDelayMs: 2500
};

const state = {
  running: false,
  phase: 'idle',
  message: 'idle',
  snowballs: 0,
  snowBlocks: 0,
  cycles: 0,
  startedAt: null,
  lastAlarmAt: 0,
  lastNoSnowFeedAt: 0
};

let bot = null;
let opts = { ...DEFAULTS };

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))
  ]);
}

function publish() {
  bus.publishSnow(state);
}

function setPhase(phase, message, feed = true) {
  state.phase = phase;
  state.message = message;
  if (feed) bus.publish('system', `[snow] ${message}`);
  publish();
}

function fmt(pos) {
  return pos ? `${pos.x},${pos.y},${pos.z}` : 'n/a';
}

function isShovel(item) {
  return !!item && /_shovel$/.test(item.name || '');
}

function isSnow(block) {
  return !!block && (block.name === 'snow' || block.name === 'snow_block');
}

function countItem(name) {
  if (!bot) return 0;
  let total = 0;
  for (const item of bot.inventory.slots) {
    if (item && item.name === name) total += item.count;
  }
  return total;
}

function hotbarStart() {
  return bot.inventory.hotbarStart ?? 36;
}

function inventoryStart() {
  return bot.inventory.inventoryStart ?? 9;
}

function inventoryEnd() {
  return bot.inventory.inventoryEnd ?? 45;
}

/** Find the first inventory slot (main first, then hotbar) matching predicate. */
function findInInventory(predicate) {
  for (let i = inventoryStart(); i < hotbarStart(); i++) {
    const item = bot.inventory.slots[i];
    if (item && predicate(item)) return i;
  }
  for (let i = hotbarStart(); i < inventoryEnd(); i++) {
    const item = bot.inventory.slots[i];
    if (item && predicate(item)) return i;
  }
  return null;
}

function hasFreeSlot() {
  for (let i = inventoryStart(); i < inventoryEnd(); i++) {
    if (!bot.inventory.slots[i]) return true;
  }
  return false;
}

/** Run fn with the player inventory window active (window 0). */
async function withInventory(fn) {
  const previous = bot.currentWindow;
  if (!bot.currentWindow) bot.currentWindow = bot.inventory;
  try {
    return await fn();
  } finally {
    bot.currentWindow = previous;
  }
}

async function ensureShovel() {
  if (!bot) return false;
  if (isShovel(bot.heldItem)) return true;

  const hs = hotbarStart();

  for (let i = 0; i < 9; i++) {
    if (isShovel(bot.inventory.slots[hs + i])) {
      bot.setQuickBarSlot(i);
      await sleep(250);
      setPhase('shovel', `holding shovel (hotbar slot ${i})`);
      return true;
    }
  }

  const source = findInInventory(item => isShovel(item));
  if (source != null) {
    let dest = -1;
    for (let i = 0; i < 9; i++) {
      if (!bot.inventory.slots[hs + i]) {
        dest = hs + i;
        break;
      }
    }
    if (dest === -1) dest = hs; // hotbar full: swap with slot 0
    await withInventory(() => bot.moveSlotItem(source, dest));
    await sleep(250);
    bot.setQuickBarSlot(dest - hs);
    await sleep(250);
    setPhase('shovel', `moved shovel to hotbar slot ${dest - hs}`);
    return true;
  }

  return false;
}

async function alarmNoShovel() {
  setPhase('no-shovel', 'NO SHOVEL — waiting (give one or /stopsnow)', false);
  const now = Date.now();
  if (now - state.lastAlarmAt >= opts.alarmIntervalMs) {
    state.lastAlarmAt = now;
    bus.publish('error', '[snow] NO SHOVEL — give the bot a shovel, or type /stopsnow');
  }
  await sleep(1500);
}

function findSnowBlock() {
  if (!bot || !bot.entity) return null;
  for (const name of ['snow', 'snow_block']) {
    const positions = bot.findBlocks({
      matching: block => block && block.name === name,
      maxDistance: opts.searchRadius,
      count: 20,
      point: bot.entity.position
    });
    if (!positions.length) continue;
    // Only dig snow at/below foot level + 1: higher layers drop their
    // snowball onto a ledge the bot cannot reach.
    const feetY = bot.entity.position.y;
    const blocks = positions
      .map(p => bot.blockAt(p))
      .filter(Boolean)
      .filter(b => b.position.y <= feetY + 2)
      .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
    if (blocks.length) return blocks[0];
  }
  return null;
}

async function gotoBlock(block) {
  if (!bot.pathfinder) return false;
  try {
    await withTimeout(
      bot.pathfinder.goto(new goals.GoalNear(block.position.x, block.position.y, block.position.z, 1)),
      6000
    );
    return true;
  } catch {
    return false;
  }
}

async function digSnow() {
  setPhase('digging', 'digging snow');
  while (state.running) {
    state.snowballs = countItem('snowball');
    if (state.snowballs >= opts.targetSnowballs) return true;

    if (!(await ensureShovel())) {
      await alarmNoShovel();
      continue;
    }

    if (!hasFreeSlot()) {
      setPhase('inventory-full', 'inventory full — crafting first');
      return true; // let the loop craft/sell to free space
    }

    const block = findSnowBlock();
    if (!block) {
      const now = Date.now();
      if (now - (state.lastNoSnowFeedAt || 0) >= opts.repeatMsgMs) {
        state.lastNoSnowFeedAt = now;
        bus.publish('system', '[snow] no snow nearby — waiting');
      }
      setPhase('no-snow', 'no snow nearby — waiting', false);
      await sleep(opts.noSnowRetryMs);
      continue;
    }

    setPhase('digging', `digging snow at ${fmt(block.position)}`, false);

    let target = bot.blockAt(block.position);
    if (!target || !isSnow(target)) continue;

    // Climb to the snow first (1-block steps) so the snowball drops at our
    // feet instead of on a ledge. The pathfinder never mines terrain.
    const eye = bot.entity.position.offset(0, bot.entity.eyeHeight, 0);
    const dist = target.position.offset(0.5, 0.5, 0.5).distanceTo(eye);
    if (dist > 1.5) {
      const reached = await gotoBlock(block);
      if (!state.running) return false;
      target = bot.blockAt(block.position);
      if (!target || !isSnow(target)) continue;
      if (!reached && !bot.canDigBlock(target)) {
        setPhase('digging', `can't reach snow at ${fmt(block.position)} — trying another`);
        await sleep(opts.digRetryDelayMs);
        continue;
      }
    }

    // Pathfinding can change the held item — make sure it is the shovel.
    await ensureShovel();
    if (!isShovel(bot.heldItem)) {
      setPhase('digging', 'could not hold a shovel — retrying');
      await sleep(500);
      continue;
    }

    // Face the snow and dig it — no jumping, no extra movement, no support
    // digging (the drops are picked up on their own).
    try {
      await bot.lookAt(target.position.offset(0.5, 0.5, 0.5), true);
      await withTimeout(bot.dig(target), 10000);
    } catch (err) {
      setPhase('digging', `dig failed: ${err.message}`);
      await sleep(opts.digRetryDelayMs);
      continue;
    }
    // Check again immediately; the no-snow wait below only applies if there
    // is genuinely nothing left to dig.
    await sleep(100);
  }
  return false;
}

async function craftSnowBlocks() {
  setPhase('crafting', 'crafting snow blocks');
  let crafted = 0;

  await withInventory(async () => {
    // Fill the 2x2 crafting grid (slots 1-4) with snowball stacks.
    for (const craftSlot of [1, 2, 3, 4]) {
      const source = findInInventory(item => item.name === 'snowball');
      if (source == null) break;
      await bot.moveSlotItem(source, craftSlot);
      await sleep(opts.craftDelayMs);
    }

    // Take the result (slot 0) until the grid runs out.
    for (let i = 0; i < 32; i++) {
      const result = bot.currentWindow.slots[0];
      if (!result) break;
      await bot.putAway(0);
      crafted++;
      await sleep(opts.craftDelayMs);
    }
  });

  state.snowBlocks = countItem('snow_block');
  setPhase('crafting', `crafted ${crafted} snow block(s)`);
  return crafted;
}

async function holdSnowBlock() {
  if (!bot) return false;
  if (bot.heldItem && bot.heldItem.name === 'snow_block') return true;

  const source = findInInventory(item => item.name === 'snow_block');
  if (source == null) return false;

  const hs = hotbarStart();
  let dest = -1;
  for (let i = 0; i < 9; i++) {
    if (!bot.inventory.slots[hs + i]) {
      dest = hs + i;
      break;
    }
  }
  if (dest === -1) dest = hs;

  await withInventory(() => bot.moveSlotItem(source, dest));
  await sleep(250);
  bot.setQuickBarSlot(dest - hs);
  await sleep(250);
  return true;
}

async function sellSnowBlocks() {
  setPhase('selling', 'selling snow blocks');
  if (!(await holdSnowBlock())) {
    setPhase('selling', 'no snow blocks to sell');
    await sleep(1000);
    return;
  }
  bot.chat('/sellall hand');
  setPhase('selling', 'sent /sellall hand');
  await sleep(opts.sellDelayMs);
}

async function loop() {
  while (state.running) {
    if (!bot || !bot.entity) {
      setPhase('disconnected', 'bot disconnected — waiting', false);
      await sleep(2000);
      continue;
    }
    try {
      await digSnow();
      if (!state.running) break;

      await craftSnowBlocks();
      if (!state.running) break;

      await sellSnowBlocks();
      if (!state.running) break;

      state.cycles++;
      setPhase('starting', `cycle ${state.cycles + 1}`);
    } catch (err) {
      setPhase('error', `error: ${err.message}`);
      await sleep(2000);
    }
  }
}

function start(botInstance, options = {}) {
  if (state.running) return false;

  bot = botInstance;
  opts = { ...DEFAULTS, ...options };

  if (!bot.pathfinder) {
    bot.loadPlugin(pathfinderPlugin);
  }
  // Never let the pathfinder mine terrain: it equips the best tool (e.g. a
  // pickaxe) and would dig the snow with the wrong tool.
  const movements = new Movements(bot);
  movements.canDig = false;
  movements.allowPlacing = false;
  movements.allowParkour = false;
  bot.pathfinder.setMovements(movements);

  state.running = true;
  state.phase = 'starting';
  state.message = 'starting';
  state.snowballs = 0;
  state.snowBlocks = 0;
  state.cycles = 0;
  state.startedAt = Date.now();
  state.lastAlarmAt = 0;
  publish();

  loop().finally(() => {
    state.running = false;
    state.phase = 'idle';
    state.message = 'stopped';
    publish();
  });

  return true;
}

function stop() {
  if (!state.running) return false;
  state.running = false;
  state.message = 'stopping...';
  if (bot && bot.pathfinder) {
    try { bot.pathfinder.setGoal(null); } catch { /* ignore */ }
  }
  publish();
  return true;
}

function setBot(botInstance) {
  bot = botInstance;
}

module.exports = { start, stop, setBot, state };
