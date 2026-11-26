'use strict';

/**
 * Container / inventory helpers shared by the commands and the web panel.
 *
 * Window slot layout (prismarine-windows):
 *   0 .. inventoryStart-1        → the container/GUI slots
 *   inventoryStart .. inventoryEnd-1 → the player's main inventory + hotbar
 *   hotbarStart (= inventoryEnd-9)   → first hotbar slot
 * With no container open, `bot.inventory` uses the same layout for the player.
 */

/** Flatten a Minecraft chat component (JSON string or object) to plain text. */
function componentText(value) {
  if (value == null) return '';
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try { return componentText(JSON.parse(trimmed)); } catch { /* not JSON */ }
    }
    return value;
  }
  if (Array.isArray(value)) return value.map(componentText).join('');
  if (typeof value === 'object') {
    let out = typeof value.text === 'string' ? value.text : '';
    if (Array.isArray(value.extra)) out += value.extra.map(componentText).join('');
    if (!out && typeof value.translate === 'string') out = value.translate;
    return out;
  }
  return '';
}

function clean(s) {
  return componentText(s).replace(/§[0-9a-fk-or]/gi, '').replace(/&[0-9a-fk-or]/gi, '');
}

function itemNames(item) {
  return [item.name, item.displayName].filter(Boolean).map(n => clean(n).toLowerCase());
}

function matches(item, query) {
  const q = clean(query).toLowerCase();
  return itemNames(item).some(n => n.includes(q));
}

function extractLore(item) {
  try {
    let lore = item.nbt?.value?.display?.value?.Lore?.value;
    // Some servers wrap the list: { type: 'string', value: [...] }
    if (!Array.isArray(lore) && lore && Array.isArray(lore.value)) lore = lore.value;
    if (!Array.isArray(lore)) return [];
    return lore
      .map(entry => clean(typeof entry === 'string' ? entry : entry?.value ?? ''))
      .filter(Boolean);
  } catch {
    return [];
  }
}

const ENCHANT_NAMES = {
  sharpness: 'Sharpness', smite: 'Smite', bane_of_arthropods: 'Bane of Arthropods',
  knockback: 'Knockback', fire_aspect: 'Fire Aspect', looting: 'Looting',
  sweeping: 'Sweeping Edge', efficiency: 'Efficiency', silk_touch: 'Silk Touch',
  unbreaking: 'Unbreaking', fortune: 'Fortune', power: 'Power', punch: 'Punch',
  flame: 'Flame', infinity: 'Infinity', luck_of_the_sea: 'Luck of the Sea',
  lure: 'Lure', loyalty: 'Loyalty', impaling: 'Impaling', riptide: 'Riptide',
  channeling: 'Channeling', multishot: 'Multishot', piercing: 'Piercing',
  quick_charge: 'Quick Charge', protection: 'Protection',
  fire_protection: 'Fire Protection', feather_falling: 'Feather Falling',
  blast_protection: 'Blast Protection', projectile_protection: 'Projectile Protection',
  thorns: 'Thorns', respiration: 'Respiration', depth_strider: 'Depth Strider',
  aqua_affinity: 'Aqua Affinity', frost_walker: 'Frost Walker',
  soul_speed: 'Soul Speed', swift_sneak: 'Swift Sneak', mending: 'Mending',
  vanishing_curse: 'Curse of Vanishing', binding_curse: 'Curse of Binding'
};

function roman(n) {
  const map = { 1: 'I', 2: 'II', 3: 'III', 4: 'IV', 5: 'V', 6: 'VI', 7: 'VII', 8: 'VIII', 9: 'IX', 10: 'X' };
  return map[n] || String(n);
}

function nbtValue(item, key) {
  try { return item.nbt?.value?.[key]?.value; } catch { return undefined; }
}

function extractEnchantments(item) {
  const out = [];
  for (const key of ['Enchantments', 'StoredEnchantments', 'ench']) {
    let list;
    try { list = item.nbt?.value?.[key]?.value; } catch { list = null; }
    if (!Array.isArray(list)) continue;
    for (const entry of list) {
      const v = entry?.value || {};
      const id = String(v.id?.value ?? v.id ?? '').replace(/^minecraft:/, '');
      const lvl = Number(v.lvl?.value ?? v.lvl ?? 1);
      if (!id) continue;
      const name = ENCHANT_NAMES[id] || id.replace(/_/g, ' ');
      out.push({ id, lvl, name, display: `${name} ${roman(lvl)}` });
    }
  }
  return out;
}

function serializeItem(item, slot) {
  if (!item) return null;
  const damage = nbtValue(item, 'Damage');
  const customModelData = nbtValue(item, 'CustomModelData');
  return {
    slot,
    name: clean(item.name || ''),
    displayName: clean(item.displayName || item.name || ''),
    count: item.count || 0,
    lore: extractLore(item),
    enchantments: extractEnchantments(item),
    damage: typeof damage === 'number' ? damage : null,
    maxDurability: item.maxDurability || null,
    unbreakable: !!nbtValue(item, 'Unbreakable'),
    customModelData: typeof customModelData === 'number' ? customModelData : null
  };
}

function titleOf(window) {
  const t = window.title;
  let raw = t;
  if (t && typeof t === 'object') {
    raw = t.text || t.title || t.translate || window.type || 'container';
  }
  raw = String(raw ?? window.type ?? 'container');
  // Some servers send the title as a JSON chat component string.
  if (raw.trim().startsWith('{')) {
    try {
      const parsed = JSON.parse(raw);
      raw = parsed.text || parsed.translate || raw;
    } catch { /* not JSON after all */ }
  }
  return clean(raw);
}

/** Snapshot of the open container (or just the inventory) for the web panel. */
function serializeWindow(bot) {
  const isOpen = !!bot.currentWindow;
  const win = bot.currentWindow || bot.inventory;
  const invStart = win.inventoryStart ?? 9;
  const invEnd = win.inventoryEnd ?? 45;
  const hotbarStart = win.hotbarStart ?? 36;

  const container = [];
  if (isOpen) {
    for (let i = 0; i < invStart; i++) container.push(serializeItem(win.slots[i], i));
  }

  const inventory = [];
  for (let i = invStart; i < invEnd; i++) inventory.push(serializeItem(win.slots[i], i));
  if (!isOpen) {
    // The player-only slots: armor (5-8) and offhand (45).
    for (const i of [5, 6, 7, 8, 45]) inventory.push(serializeItem(win.slots[i], i));
  }

  return {
    open: isOpen,
    windowId: isOpen ? win.id : 0,
    type: isOpen ? win.type : 'minecraft:inventory',
    title: isOpen ? titleOf(win) : 'inventory',
    inventoryStart: invStart,
    inventoryEnd: invEnd,
    hotbarStart,
    container,
    inventory
  };
}

function formatList(state) {
  const fmt = rows => rows
    .filter(Boolean)
    .map(i => `  [${i.slot}] ${i.count}x ${i.displayName} (${i.name})`)
    .join('\n') || '  (empty)';

  const lines = [];
  if (state.open) {
    lines.push(`container: ${state.title} (${state.type}), slots 0..${state.inventoryStart - 1}`);
    lines.push('container items:');
    lines.push(fmt(state.container));
  } else {
    lines.push('no container open');
  }
  lines.push('inventory:');
  lines.push(fmt(state.inventory));
  return lines.join('\n');
}

function listWindow(bot) {
  return formatList(serializeWindow(bot));
}

async function takeSlot(bot, slot) {
  if (!bot.currentWindow) throw new Error('no container open');
  await bot.putAway(slot);
  return true;
}

async function takeMatching(bot, query) {
  const win = bot.currentWindow;
  if (!win) return 0;
  let taken = 0;
  for (let i = 0; i < win.inventoryStart; i++) {
    const item = win.slots[i];
    if (item && matches(item, query)) {
      await bot.putAway(i);
      taken++;
    }
  }
  return taken;
}

async function takeAll(bot) {
  const win = bot.currentWindow;
  if (!win) return 0;
  let taken = 0;
  for (let i = 0; i < win.inventoryStart; i++) {
    if (win.slots[i]) {
      await bot.putAway(i);
      taken++;
    }
  }
  return taken;
}

async function depositSlot(bot, slot) {
  const win = bot.currentWindow;
  if (!win) throw new Error('no container open');
  const item = win.slots[slot];
  if (!item) return false;

  let dest = -1;
  for (let i = 0; i < win.inventoryStart; i++) {
    const s = win.slots[i];
    if (!s) {
      if (dest === -1) dest = i;
      continue;
    }
    if (s.type === item.type && s.count < 64) {
      dest = i;
      break;
    }
  }
  if (dest === -1) return false;

  await bot.moveSlotItem(slot, dest);
  return true;
}

async function depositMatching(bot, query) {
  const win = bot.currentWindow;
  if (!win) return 0;
  let moved = 0;
  for (let i = win.inventoryStart; i < win.inventoryEnd; i++) {
    const item = win.slots[i];
    if (item && matches(item, query)) {
      const ok = await depositSlot(bot, i).catch(() => false);
      if (ok) moved++;
    }
  }
  return moved;
}

async function depositAll(bot) {
  const win = bot.currentWindow;
  if (!win) return 0;
  let moved = 0;
  for (let i = win.inventoryStart; i < win.inventoryEnd; i++) {
    if (win.slots[i]) {
      const ok = await depositSlot(bot, i).catch(() => false);
      if (ok) moved++;
    }
  }
  return moved;
}

async function clickSlot(bot, slot) {
  if (!bot.currentWindow) throw new Error('no container open');
  await bot.clickWindow(slot, 0, 0);
  return true;
}

const CONTAINER_BLOCKS = [
  'chest', 'trapped_chest', 'barrel', 'ender_chest', 'shulker_box',
  'dispenser', 'dropper', 'hopper'
];

/** Nearest openable container block (chest/barrel/...) or null. */
function findContainerBlock(bot, maxDistance = 16) {
  if (!bot || !bot.entity) return null;
  const positions = bot.findBlocks({
    matching: block => block && CONTAINER_BLOCKS.includes(block.name),
    maxDistance,
    count: 20,
    point: bot.entity.position
  });
  return positions
    .map(p => bot.blockAt(p))
    .filter(Boolean)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position))[0] || null;
}

function findRuleSlot(window, patterns) {
  const pats = (patterns && patterns.length ? patterns : ['accept', 'agree', 'confirm', 'allow', 'yes'])
    .map(p => String(p).toLowerCase());
  for (let i = 0; i < window.inventoryStart; i++) {
    const item = window.slots[i];
    if (!item) continue;
    const names = itemNames(item);
    if (pats.some(p => names.some(n => n.includes(p)))) return i;
  }
  return -1;
}

async function acceptRules(bot) {
  const win = bot.currentWindow;
  if (!win) return null;
  const slot = findRuleSlot(win);
  if (slot === -1) return null;
  await clickSlot(bot, slot);
  return win.slots[slot]?.name || `slot ${slot}`;
}

module.exports = {
  clean,
  matches,
  extractLore,
  serializeItem,
  serializeWindow,
  listWindow,
  takeSlot,
  takeMatching,
  takeAll,
  depositSlot,
  depositMatching,
  depositAll,
  clickSlot,
  findContainerBlock,
  findRuleSlot,
  acceptRules
};
