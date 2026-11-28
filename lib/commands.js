'use strict';

/**
 * Command file — edit this and save; it is hot-reloaded on the next command.
 *
 * Add a command by adding a key to `commands` below. A command is any function
 *   async (bot, args, ctx) => { ... }
 * where `args` is the argument list (quotes are stripped) and `ctx` holds
 * { cfg, state, restart, reply, loaded }. Use ctx.reply('...') to show output
 * in BOTH the CLI and the web page.
 *
 * Kept self-contained on purpose: hot reload deletes this module from the
 * require cache, so anything imported here would NOT reload.
 */

const fs = require('node:fs');
const readline = require('node:readline');
const items = require('./items');
const snow = require('./snow');
const money = require('./money');

const CONTAINER_BLOCKS = [
  'chest', 'trapped_chest', 'barrel', 'ender_chest', 'shulker_box',
  'dispenser', 'dropper', 'hopper'
];

/** Openable container blocks (chest/barrel/...), nearest first. */
function listContainerBlocks(bot, maxDistance = 16) {
  if (!bot || !bot.entity) return [];
  const positions = bot.findBlocks({
    matching: block => block && CONTAINER_BLOCKS.includes(block.name),
    maxDistance,
    count: 20,
    point: bot.entity.position
  });
  return positions
    .map(p => bot.blockAt(p))
    .filter(Boolean)
    .sort((a, b) => a.position.distanceTo(bot.entity.position) - b.position.distanceTo(bot.entity.position));
}

function findContainerBlock(bot, maxDistance = 16) {
  return listContainerBlocks(bot, maxDistance)[0] || null;
}

const USAGE = {
  say: '/say <text> — send text to chat, e.g. /say "/tpa itamio"',
  help: '/help — list commands',
  status: '/status — health, food, position, game mode',
  pos: '/pos — print the bot position',
  inventory: '/inventory — list the hotbar',
  containershow: '/containershow — list the open container and your inventory',
  take: '/take <name> — take matching items from the container',
  takeall: '/takeall — take everything from the container',
  takeslot: '/takeslot <slot> — take one container slot',
  deposit: '/deposit <name> — move matching items into the container',
  depositall: '/depositall — move everything into the container',
  depositslot: '/depositslot <slot> — move one inventory slot into the container',
  click: '/click <slot> — left-click a container slot (menus / rules)',
  accept: '/accept — click the accept/rules item',
  close: '/close — close the open container',
  chest: '/chest [listnearby | <id>] — open a nearby chest/barrel',
  digsnow: '/digsnow — start the shovel → snow → craft → sell loop',
  stopsnow: '/stopsnow — stop the snow loop',
  eyeloop: '/eyeloop — buy pearls+powder, craft Eyes of Ender, sell, repeat',
  stopeye: '/stopeye — stop the money loop',
  eyestatus: '/eyestatus — money loop status',
  spawn: '/spawn — teleport back to spawn',
  join: '/join — re-run the compass → kit join workflow',
  wipe: '/wipe confirm — test hook: drop everything but the compass',
  reconnect: '/reconnect — leave and rejoin the server',
  quit: '/quit — disconnect and exit'
};

const commands = {
  say(bot, args, ctx) {
    if (!args.length) return ctx.reply(`usage: ${USAGE.say}`);
    const text = args.join(' ');
    bot.chat(text);
    ctx.reply(`> ${text}`);
  },

  chat(bot, args, ctx) {
    return commands.say(bot, args, ctx);
  },

  help(bot, args, ctx) {
    ctx.reply('commands:');
    for (const text of Object.values(USAGE)) ctx.reply(`  ${text}`);
    ctx.reply(`command file: ${__filename} (edit + save, hot-reloaded on next command)`);
  },

  status(bot, args, ctx) {
    const e = bot.entity;
    if (!e) return ctx.reply('not spawned');
    ctx.reply(`health=${bot.health} food=${bot.food} gameMode=${bot.game.gameMode} pos=${fmt(e.position)}`);
  },

  pos(bot, args, ctx) {
    const e = bot.entity;
    if (!e) return ctx.reply('not spawned');
    ctx.reply(fmt(e.position));
  },

  inventory(bot, args, ctx) {
    const start = bot.inventory.hotbarStart ?? 36;
    const rows = ['hotbar:'];
    for (let i = 0; i < 9; i++) {
      const item = bot.inventory.slots[start + i];
      rows.push(`  [${i}] ${item ? `${item.count}x ${item.name}` : '(empty)'}`);
    }
    ctx.reply(rows.join('\n'));
  },

  containershow(bot, args, ctx) {
    ctx.reply(items.listWindow(bot));
  },

  container(bot, args, ctx) {
    return commands.containershow(bot, args, ctx);
  },

  cs(bot, args, ctx) {
    return commands.containershow(bot, args, ctx);
  },

  async take(bot, args, ctx) {
    if (!bot.currentWindow) return ctx.reply('no container open');
    const query = args.join(' ');
    const n = query ? await items.takeMatching(bot, query) : await items.takeAll(bot);
    ctx.reply(`took ${n} stack(s)`);
  },

  async takeall(bot, args, ctx) {
    if (!bot.currentWindow) return ctx.reply('no container open');
    const n = await items.takeAll(bot);
    ctx.reply(`took ${n} stack(s)`);
  },

  async takeslot(bot, args, ctx) {
    const slot = Number(args[0]);
    if (!Number.isInteger(slot)) return ctx.reply('usage: /takeslot <slot>');
    await items.takeSlot(bot, slot);
    ctx.reply(`took slot ${slot}`);
  },

  async deposit(bot, args, ctx) {
    if (!bot.currentWindow) return ctx.reply('no container open');
    const query = args.join(' ');
    const n = query ? await items.depositMatching(bot, query) : await items.depositAll(bot);
    ctx.reply(`moved ${n} stack(s)`);
  },

  async depositall(bot, args, ctx) {
    if (!bot.currentWindow) return ctx.reply('no container open');
    const n = await items.depositAll(bot);
    ctx.reply(`moved ${n} stack(s)`);
  },

  async depositslot(bot, args, ctx) {
    const slot = Number(args[0]);
    if (!Number.isInteger(slot)) return ctx.reply('usage: /depositslot <slot>');
    const ok = await items.depositSlot(bot, slot);
    ctx.reply(ok ? `moved slot ${slot}` : `could not move slot ${slot} (container full?)`);
  },

  async click(bot, args, ctx) {
    const slot = Number(args[0]);
    if (!Number.isInteger(slot)) return ctx.reply('usage: /click <slot>');
    await items.clickSlot(bot, slot);
    ctx.reply(`clicked slot ${slot}`);
  },

  async accept(bot, args, ctx) {
    const result = await items.acceptRules(bot);
    ctx.reply(result ? `clicked ${result}` : 'no accept/rules item found');
  },

  close(bot, args, ctx) {
    if (!bot.currentWindow) return ctx.reply('no container open');
    bot.closeWindow(bot.currentWindow);
    ctx.reply('closed the container');
  },

  snowscan(bot, args, ctx) {
    const positions = bot.findBlocks({
      matching: b => b && (b.name === 'snow' || b.name === 'snow_block'),
      maxDistance: 48, count: 40, point: bot.entity.position
    });
    const lines = positions.map(p => {
      const b = bot.blockAt(p);
      return `${b?.name}@${p.toString()} d=${p.distanceTo(bot.entity.position).toFixed(1)} dy=${(p.y - bot.entity.position.y).toFixed(0)}`;
    });
    ctx.reply(`snow blocks:\n${lines.join('\n') || 'none'}`);
  },

  async chest(bot, args, ctx) {
    const blocks = listContainerBlocks(bot, 32);

    if (args[0] === 'listnearby' || args[0] === 'list') {
      if (!blocks.length) return ctx.reply('no containers nearby');
      const lines = blocks.map((b, i) =>
        `#${i + 1} ${b.name} @ ${b.position.toString()} d=${b.position.distanceTo(bot.entity.position).toFixed(1)}`);
      return ctx.reply(`nearby containers:\n${lines.join('\n')}\nuse /chest <id>`);
    }

    if (!blocks.length) return ctx.reply('no chest/barrel nearby');

    let block;
    if (!args.length) {
      block = blocks[0];
    } else if (/^\d+$/.test(args[0])) {
      const idx = Number(args[0]) - 1;
      if (idx < 0 || idx >= blocks.length) {
        return ctx.reply(`no container #${args[0]} — run /chest listnearby`);
      }
      block = blocks[idx];
    } else {
      return ctx.reply('usage: /chest [listnearby | <id>]');
    }

    await bot.lookAt(block.position.offset(0.5, 0.5, 0.5));
    await bot.activateBlock(block);
    await new Promise(resolve => setTimeout(resolve, 600));
    ctx.reply(bot.currentWindow
      ? `opened ${block.name} at ${block.position.toString()}`
      : `could not open ${block.name} (protected?)`);
  },

  async chestlistnearby(bot, args, ctx) {
    return commands.chest(bot, ['listnearby'], ctx);
  },

  openchest(bot, args, ctx) {
    return commands.chest(bot, args, ctx);
  },

  snowdbg(bot, args, ctx) {
    const p = bot.entity.position;
    const positions = bot.findBlocks({
      matching: b => b && (b.name === 'snow' || b.name === 'snow_block'),
      maxDistance: 24, count: 8, point: p
    });
    const lines = [`pos=${p.toString()} held=${bot.heldItem?.name} balls=` +
      items.serializeWindow(bot).inventory.filter(Boolean).filter(i => i.name === 'snowball').reduce((a, i) => a + i.count, 0)];
    for (const pos of positions) {
      const b = bot.blockAt(pos);
      const below = bot.blockAt(pos.offset(0, -1, 0));
      lines.push(`${b?.name}@${pos.toString()} meta=${b?.metadata} below=${below?.name} dy=${(pos.y - p.y).toFixed(0)}`);
    }
    const near = Object.values(bot.entities)
      .filter(e => e && e.position && e.position.distanceTo(p) < 20)
      .map(e => `${e.name}@${e.position.toString()}`)
      .slice(0, 10);
    lines.push(`entities=${near.join(', ') || 'none'}`);
    ctx.reply(lines.join('\n'));
  },

  async digbelow(bot, args, ctx) {
    const positions = bot.findBlocks({
      matching: b => b && (b.name === 'snow' || b.name === 'snow_block'),
      maxDistance: 16, count: 1, point: bot.entity.position
    });
    if (!positions.length) return ctx.reply('no snow nearby');
    const below = bot.blockAt(positions[0].offset(0, -1, 0));
    const dist = below.position.offset(0.5, 0.5, 0.5).distanceTo(bot.entity.position.offset(0, 1.65, 0));
    ctx.reply(`digging ${below.name}@${below.position} diggable=${below.diggable} dist=${dist.toFixed(2)} held=${bot.heldItem?.name}`);
    await bot.lookAt(below.position.offset(0.5, 0.5, 0.5), true);
    await bot.dig(below);
    ctx.reply(`after: ${bot.blockAt(below.position)?.name}`);
  },

  terrain(bot, args, ctx) {
    const Vec3 = require('vec3').Vec3;
    const p = bot.entity.position.floored();
    const lines = [];
    for (let dy = -2; dy <= 4; dy++) {
      const row = [];
      for (let dx = -2; dx <= 2; dx++) {
        const b = bot.blockAt(new Vec3(p.x + dx, p.y + dy, p.z));
        row.push(b ? b.name.replace(/^minecraft:/, '').slice(0, 5) : '?');
      }
      lines.push(`y${p.y + dy}: ${row.join(' ')}`);
    }
    ctx.reply(lines.join('\n'));
  },

  terrainat(bot, args, ctx) {
    const Vec3 = require('vec3').Vec3;
    const [x, y, z] = args.map(Number);
    if (![x, y, z].every(Number.isFinite)) return ctx.reply('usage: /terrainat <x> <y> <z>');
    const lines = [];
    for (let dy = -2; dy <= 2; dy++) {
      const row = [];
      for (let dx = -2; dx <= 2; dx++) {
        const b = bot.blockAt(new Vec3(x + dx, y + dy, z));
        row.push(b ? b.name.replace(/^minecraft:/, '').slice(0, 5) : '?');
      }
      lines.push(`y${y + dy}: ${row.join(' ')}`);
    }
    ctx.reply(`around ${x},${y},${z}:\n${lines.join('\n')}`);
  },

  findent(bot, args, ctx) {
    const name = args[0] || 'snow_golem';
    const found = Object.values(bot.entities)
      .filter(e => e && e.name === name)
      .map(e => `${e.name}@${e.position.toString()}`);
    ctx.reply(found.slice(0, 10).join('\n') || `no ${name} loaded`);
  },

  async craft2x2(bot, args, ctx) {
    const win = bot.currentWindow;
    if (!win) return ctx.reply('open your inventory first (default: press E and close)');
    const inv = items.serializeWindow(bot).inventory;
    const find = pat => inv.find(i => i && new RegExp(pat, 'i').test(i.name));
    const A = find(args[0]);
    const B = find(args[1]);
    if (!A) return ctx.reply(`no ${args[0]} in inventory`);
    if (!B) return ctx.reply(`no ${args[1]} in inventory`);
    await bot.moveSlotItem(A.slot, 1);
    await new Promise(r => setTimeout(r, 250));
    await bot.moveSlotItem(B.slot, 2);
    await new Promise(r => setTimeout(r, 500));
    const result = bot.currentWindow?.slots[0];
    if (!result) return ctx.reply('no crafting result (wrong recipe?)');
    const name = result.displayName || result.name;
    await bot.clickWindow(0, 0, 0);
    await new Promise(r => setTimeout(r, 300));
    ctx.reply(`crafted ${name}`);
  },

  async recipes(bot, args, ctx) {
    const item = bot.registry.itemsByName[args[0].replace(/\s+/g, '_').toLowerCase()];
    if (!item) return ctx.reply('unknown item: ' + args[0]);
    const list = bot.recipesFor(item.id) || [];
    if (!list.length) return ctx.reply('no recipe for ' + item.displayName);
    const lines = list.map(r => {
      const needsTable = r.requiresTable ? ' [table]' : '';
      const ing = (r.ingredients || []).flat().map(id => bot.registry.items[id]?.displayName || id).join(' + ');
      return `${item.displayName} x${r.result?.count ?? 1} <- ${ing || '(shaped)'}${needsTable}`;
    });
    ctx.reply(lines.join('\n'));
  },

  async craftrecipe(bot, args, ctx) {
    const item = bot.registry.itemsByName[args[0].replace(/\s+/g, '_').toLowerCase()];
    if (!item) return ctx.reply('unknown item: ' + args[0]);
    const count = Number(args[1]) || 1;
    const list = bot.recipesFor(item.id) || [];
    if (!list.length) return ctx.reply('no recipe for ' + item.displayName);
    const recipe = list.find(r => !r.requiresTable) || list[0];
    if (recipe.requiresTable) return ctx.reply(item.displayName + ' needs a crafting table');
    try {
      await bot.craft(recipe, count, null);
      ctx.reply(`crafted ${count}x ${item.displayName}`);
    } catch (err) {
      ctx.reply('craft failed: ' + err.message);
    }
  },

  async sellhand(bot, args, ctx) {
    const name = args.join(' ').toLowerCase();
    if (bot.currentWindow) {
      try { bot.closeWindow(bot.currentWindow); } catch { /* ignore */ }
      await new Promise(r => setTimeout(r, 400));
    }
    const inv = items.serializeWindow(bot).inventory;
    const item = inv.find(i => i && (i.name.includes(name) || (i.displayName || '').toLowerCase().includes(name)));
    if (!item) return ctx.reply(`no ${args.join(' ')} in inventory`);
    if (item.slot !== 36) await bot.moveSlotItem(item.slot, 36);
    bot.setQuickBarSlot(0);
    await new Promise(r => setTimeout(r, 400));
    const held = bot.heldItem;
    if (!held) return ctx.reply('hand is empty — cannot sell');
    await commands.say(bot, ['/sellall hand'], ctx);
    ctx.reply(`selling ${held.displayName || held.name}`);
  },

  async buytest(bot, args, ctx) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const log = [];
    bot.chat('/shop');
    await sleep(1200);
    log.push('open: ' + (bot.currentWindow?.title ?? 'null'));
    await bot.clickWindow(21, 0, 0);
    await sleep(800);
    log.push('cat: ' + (bot.currentWindow?.title ?? 'null'));
    await bot.clickWindow(4, 0, 0);
    await sleep(800);
    log.push('item: ' + (bot.currentWindow?.title ?? 'null'));
    ctx.reply(log.join('\n'));
  },

  async chatinfo(bot, args, ctx) {
    ctx.reply([
      'bot=' + typeof bot,
      'chat=' + typeof bot?.chat,
      'client=' + typeof bot?._client,
      'client.chat=' + typeof bot?._client?.chat,
      'version=' + bot?._client?.version,
      'state=' + bot?._client?.state
    ].join('\n'));
  },

  async invdump(bot, args, ctx) {
    const slots = bot.inventory ? bot.inventory.slots : [];
    const lines = [];
    for (let i = 0; i < slots.length; i++) {
      const it = slots[i];
      if (it) lines.push(`${i}: ${it.name} x${it.count}`);
    }
    ctx.reply(lines.join('\n') || 'empty');
  },

  async crafttest(bot, args, ctx) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const n = Number(args[0]) || 1;
    const item = bot.registry.itemsByName.ender_eye;
    const recipe = (bot.recipesFor(item.id) || []).find(r => !r.requiresTable);
    if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch {} await sleep(400); }
    // clear the crafting grid back into the inventory first
    for (const s of [0, 1, 2, 3, 4]) {
      if (bot.inventory.slots[s]) {
        const free = bot.inventory.slots.findIndex((x, i) => i >= 9 && i <= 44 && !x);
        if (free >= 0) { await bot.moveSlotItem(s, free); await sleep(150); }
      }
    }
    if (!recipe) return ctx.reply('no recipe');
    const count = () => bot.inventory.slots.filter(i => i && i.name === 'ender_eye').reduce((a, i) => a + i.count, 0);
    const before = count();
    try { await bot.craft(recipe, n, null); } catch (err) { return ctx.reply('craft error: ' + err.message); }
    await sleep(600);
    ctx.reply(`before=${before} after=${count()}`);
  },

  async craftstack(bot, args, ctx) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const mode = Number(args[0] || 5);
    if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch {} await sleep(400); }
    // clear the grid
    for (const s of [0, 1, 2, 3, 4]) {
      if (bot.inventory.slots[s]) {
        const free = bot.inventory.slots.findIndex((x, i) => i >= 9 && i <= 44 && !x);
        if (free >= 0) { await bot.moveSlotItem(s, free); await sleep(150); }
      }
    }
    const inv = bot.inventory.slots;
    const pearlIdx = inv.findIndex((i, idx) => idx >= 9 && i && i.name === 'ender_pearl');
    const powderIdx = inv.findIndex((i, idx) => idx >= 9 && i && i.name === 'blaze_powder');
    if (pearlIdx < 0 || powderIdx < 0) return ctx.reply('need pearls + powder');
    await bot.moveSlotItem(pearlIdx, 1); await sleep(300);
    await bot.moveSlotItem(powderIdx, 2); await sleep(300);
    const count = () => bot.inventory.slots.filter(i => i && i.name === 'ender_eye').reduce((a, i) => a + i.count, 0);
    const before = count();
    await bot.clickWindow(0, 0, mode); await sleep(1000);
    ctx.reply(`mode=${mode} before=${before} after=${count()}`);
  },

  async nbt(bot, args, ctx) {
    const win = bot.currentWindow;
    if (!win) return ctx.reply('no container open');
    const slot = Number(args[0]);
    const item = win.slots[slot];
    if (!item) return ctx.reply(`slot ${slot} is empty`);
    const nbt = item.nbt ?? null;
    const display = nbt?.value?.display;
    const nameRaw = display?.value?.Name?.value;
    const loreRaw = display?.value?.Lore?.value;
    const esgui = nbt?.value?.ESGUI?.value?.PathToItem?.value;
    ctx.reply([
      `item: ${item.name}`,
      `displayName(raw): ${JSON.stringify(nameRaw)}`,
      `displayName(parsed): ${items.serializeWindow(bot).container.find(i => i && i.slot === slot)?.displayName ?? '-'}`,
      `lore(raw): ${JSON.stringify(loreRaw)}`,
      `esgui: ${esgui || '-'}`,
      `nbt: ${JSON.stringify(nbt)}`
    ].join('\n'));
  },

  digsnow(bot, args, ctx) {
    ctx.reply(snow.start(bot) ? 'snow digging started' : 'snow digging is already running');
  },

  snow(bot, args, ctx) {
    return commands.digsnow(bot, args, ctx);
  },

  stopsnow(bot, args, ctx) {
    ctx.reply(snow.stop() ? 'stopping snow digging' : 'snow digging is not running');
  },

  eyeloop(bot, args, ctx) {
    ctx.reply(money.start(bot) ? 'eye of ender money loop started' : 'money loop is already running');
  },

  stopeye(bot, args, ctx) {
    ctx.reply(money.stop() ? 'stopping the money loop' : 'money loop is not running');
  },

  async pickup(bot, args, ctx) {
    const n = await money.collectDrops();
    ctx.reply(`collected ${n} drops`);
  },

  eyestatus(bot, args, ctx) {
    const s = money.state;
    ctx.reply([
      `running=${s.running} phase=${s.phase}`,
      s.message,
      `cycles=${s.cycles} crafted=${s.eyesCrafted} sold=${s.eyesSold}`,
      `spent=$${s.spent.toFixed(2)} earned=$${s.earned.toFixed(2)} balance=$${s.balance.toFixed(2)}`,
      `payments=${s.payments} paid=$${s.paid.toFixed(2)}`
    ].join('\n'));
  },

  sellgui(bot, args, ctx) {
    bot.chat('/sellgui');
    ctx.reply('sent /sellgui');
  },

  async clearinv(bot, args, ctx) {
    ctx.reply('clearing junk through the SellGUI (keeping pearls/powder/eyes)…');
    const sold = await money.clearInventory();
    ctx.reply(`sold ${sold} junk item(s)`);
  },

  async dropjunk(bot, args, ctx) {
    const dropped = await money.clearInventoryFast();
    ctx.reply(`dropped ${dropped} junk item(s)`);
  },

  // Diagnostic: walk the shop into a Buying GUI, then click each candidate
  // button and report the resulting window. Looks for the "buy stacks" view.
  async buystacks(bot, args, ctx) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const items = require('./items');
    const flat = t => {
      let v = t;
      if (typeof v === 'string') {
        const s = v.trim();
        if (s.startsWith('{')) { try { v = JSON.parse(s); } catch { return s; } } else return s;
      }
      if (Array.isArray(v)) return v.map(flat).join('');
      if (v && typeof v === 'object') return (v.text || '') + (Array.isArray(v.extra) ? v.extra.map(flat).join('') : '');
      return String(v || '');
    };
    const title = () => (bot.currentWindow ? flat(bot.currentWindow.title) : '(none)');
    const waitTitle = async (re, ms = 6000) => {
      const t0 = Date.now();
      while (Date.now() - t0 < ms) {
        if (bot.currentWindow && re.test(title())) return true;
        await sleep(150);
      }
      return false;
    };
    const dump = async label => {
      const win = bot.currentWindow;
      if (!win) { ctx.reply(`${label}: no container`); return; }
      const w = items.serializeWindow(bot);
      ctx.reply(`${label}: "${title()}" slots ${w.container.length ? '' : ''}` +
        w.container.filter(Boolean).map(i => `[${i.slot}]${i.name}x${i.count}`).join(' '));
      for (const s of [13, 22, 31, 36]) {
        const it = win.slots[s];
        if (!it) continue;
        const name = flat(it.nbt?.value?.display?.value?.Name?.value) || it.name;
        const lore = String(it.nbt?.value?.display?.value?.Lore?.value ?? '').slice(0, 220);
        ctx.reply(`  slot ${s}: ${name} | lore: ${lore}`);
      }
    };

    if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch { /* ignore */ } await sleep(600); }
    bot.chat('/shop');
    ctx.reply('shop open: ' + await waitTitle(/^Shop/));
    await bot.clickWindow(21, 0, 0); await sleep(1200);
    ctx.reply('after category: ' + title());
    await bot.clickWindow(4, 0, 0); await sleep(1500);
    await dump('buying');
    for (const s of [31, 36, 22]) {
      await bot.clickWindow(s, 0, 0); await sleep(1500);
      await dump(`clicked ${s}`);
    }
  },

  // Diagnostic: walk the shop into a Buying GUI and report what the quantity
  // buttons actually do, so the buy path can use a "max" button if there is one.
  async buydump(bot, args, ctx) {
    const sleep = ms => new Promise(r => setTimeout(r, ms));
    const items = require('./items');
    const flat = t => {
      let v = t;
      if (typeof v === 'string') {
        const s = v.trim();
        if (s.startsWith('{')) { try { v = JSON.parse(s); } catch { return s; } } else return s;
      }
      if (Array.isArray(v)) return v.map(flat).join('');
      if (v && typeof v === 'object') return (v.text || '') + (Array.isArray(v.extra) ? v.extra.map(flat).join('') : '');
      return String(v || '');
    };
    const report = label => {
      const win = bot.currentWindow;
      if (!win) return ctx.reply(`${label}: no container`);
      const w = items.serializeWindow(bot);
      const qty = (w.container.find(i => i && i.slot === 22)?.lore || []).join(' ');
      ctx.reply(`${label}: ${flat(win.title)} | qty: ${qty} | ` +
        w.container.filter(Boolean).map(i => `[${i.slot}]${i.name}x${i.count}`).join(' '));
    };
    const click = async slot => { await bot.clickWindow(slot, 0, 0); await sleep(700); };

    if (bot.currentWindow) { try { bot.closeWindow(bot.currentWindow); } catch { /* ignore */ } await sleep(600); }
    bot.chat('/shop');
    await sleep(1500);
    report('shop');
    await click(21); await sleep(900);
    await click(4); await sleep(1500);
    report('buying');
    await click(31); await sleep(1200);
    report('after-slot31');
    await click(36); await sleep(1200);
    report('after-slot36');
  },

  async sellbatch(bot, args, ctx) {
    const before = money.state.eyesSold;
    const sold = await money.sellAllEyes();
    ctx.reply(`sold ${sold} Eyes of Ender (total ${money.state.eyesSold})`);
  },

  spawn(bot, args, ctx) {
    bot.chat('/spawn');
    ctx.reply('sent /spawn');
  },

  join(bot, args, ctx) {
    if (!ctx.runJoin) return ctx.reply('join not available yet');
    ctx.reply('re-running the join workflow…');
    Promise.resolve(ctx.runJoin(bot)).catch(err => ctx.reply(`join failed: ${err.message}`));
  },

  // Test hook: throw away everything except the compass, which is exactly what
  // a server restart leaves behind — lets you watch the restart watcher fire.
  async wipe(bot, args, ctx) {
    if (args[0] !== 'confirm') return ctx.reply('usage: /wipe confirm');
    let tossed = 0;
    for (const item of Object.values(bot.inventory.slots)) {
      if (!item) continue;
      if (/compass/i.test(item.name || '')) continue;
      try { await bot.tossStack(item); tossed++; } catch { /* ignore */ }
    }
    ctx.reply(`tossed ${tossed} stack(s) — only the compass is left`);
  },

  reconnect(bot, args, ctx) {
    ctx.reply('reconnecting...');
    ctx.restart();
  },

  // Home/AFK role commands (only meaningful on a bot with mode 'afk').
  // The answer goes to the owner by /tell; the dashboard only gets an ack so
  // home names and coordinates never land in the public state feed.
  async sethome(bot, args, ctx) {
    const homes = require('./homes').attached;
    if (!homes) return ctx.reply('this bot is not in afk/home mode');
    const owner = ctx.cfg?.afk?.owner || 'player';
    await homes.handleText(`sethome ${args.join(' ')}`, owner);
    return ctx.reply(args.join(' ') ? `sethome '${args.join(' ')}' — answer sent by tell` : 'usage: /sethome <name>');
  },
  async home(bot, args, ctx) {
    const homes = require('./homes').attached;
    if (!homes) return ctx.reply('this bot is not in afk/home mode');
    const owner = ctx.cfg?.afk?.owner || 'player';
    await homes.handleText(`home ${args.join(' ')}`, owner);
    return ctx.reply('home list — answer sent by tell');
  },
  async afkhome(bot, args, ctx) {
    const homes = require('./homes').attached;
    if (!homes) return ctx.reply('this bot is not in afk/home mode');
    const owner = ctx.cfg?.afk?.owner || 'player';
    await homes.handleText(`afkhome ${args.join(' ')}`, owner);
    return ctx.reply(args.join(' ') ? `afkhome '${args.join(' ')}' — answer sent by tell` : 'usage: /afkhome <name>');
  },

  // Send money to another player (used to move balances between accounts).
  async payto(bot, args, ctx) {
    const [to, amount] = args;
    if (!to || !amount) return ctx.reply('usage: /payto <player> <amount>');
    bot.chat(`/pay ${to} ${amount}`);
    ctx.reply(`sent /pay ${to} ${amount}`);
  },

  // Kit-mode controls (also reachable via the bus for remote testing).
  kitscan(bot, args, ctx) { return require('./kit').api?.handleText('kitscan', null); },
  kitstatus(bot, args, ctx) { return require('./kit').api?.handleText('kitstatus', null); },
  kitabort(bot, args, ctx) { return require('./kit').api?.handleText('kitabort', null); },
  kitmake(bot, args, ctx) { return require('./kit').api?.handleText('make nethkit', null); },

  quit(bot, args, ctx) {
    ctx.reply('quitting...');
    require('./quit').staggeredQuit(bot, (msg, ...a) => console.log(msg, ...a));
  },

  exit(bot, args, ctx) {
    return commands.quit(bot, args, ctx);
  }
};

function fmt(pos) {
  return pos ? `${pos.x.toFixed(1)}, ${pos.y.toFixed(1)}, ${pos.z.toFixed(1)}` : 'n/a';
}

/** Split a line into tokens, honouring "double" and 'single' quotes. */
function parseLine(line) {
  const tokens = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  let m;
  while ((m = re.exec(line)) !== null) {
    tokens.push(m[1] ?? m[2] ?? m[3]);
  }
  return tokens;
}

/** Cache-busted reload so edits to this file apply on the very next command. */
function loadCommands() {
  const resolved = require.resolve(__filename);
  delete require.cache[resolved];
  return require(resolved);
}

let watcher = null;
let watchTimer = null;
function watchCommands() {
  if (watcher) return; // one watcher for the whole process, not one per CLI
  try {
    watcher = fs.watch(__filename, () => {
      clearTimeout(watchTimer);
      watchTimer = setTimeout(() => {
        try {
          loadCommands();
          console.log('[commands] file changed — reloaded');
        } catch (err) {
          console.log(`[commands] reload failed: ${err.message}`);
        }
      }, 200);
    });
  } catch {
    // watching is a convenience only; commands still reload per line
  }
}

/** Run one command line. Shared by the CLI and the web page. */
async function executeCommand(line, bot, ctx = {}) {
  const text = String(line || '').trim();
  if (!text) return false;

  const tokens = parseLine(text);
  const name = String(tokens.shift() || '').replace(/^\//, '').toLowerCase();

  let loaded;
  try {
    loaded = loadCommands();
  } catch (err) {
    const reply = ctx.reply || console.log;
    reply(`[commands] reload failed: ${err.message}`);
    return false;
  }

  const handler = loaded.commands?.[name];
  if (typeof handler !== 'function') {
    const reply = ctx.reply || console.log;
    reply(`unknown command "/${name}" — type /help`);
    return false;
  }

  const fullCtx = { reply: (...a) => console.log(...a), ...ctx, loaded };

  try {
    await handler(bot, tokens, fullCtx);
  } catch (err) {
    fullCtx.reply(`command error: ${err.message}`);
  }
  return true;
}

function safePrompt(rl) {
  if (!rl.closed) rl.prompt();
}

function startCli(bot, ctx = {}) {
  if (ctx.state?.rl) {
    try { ctx.state.rl.close(); } catch { /* ignore */ }
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: `${bot.username}> `
  });
  if (ctx.state) ctx.state.rl = rl;

  watchCommands();

  // Serialise commands: readline emits the next line before the previous
  // async handler has finished, so chain them instead of overlapping.
  let queue = Promise.resolve();
  rl.on('line', line => {
    queue = queue.then(async () => {
      await executeCommand(line, bot, ctx);
      safePrompt(rl);
    });
  });

  rl.on('close', () => console.log('cli closed'));
  safePrompt(rl);
  return rl;
}

module.exports = { commands, startCli, executeCommand, loadCommands, usage: USAGE };
