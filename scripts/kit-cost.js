'use strict';
/**
 * Bill-of-materials cost estimate for one `nethkit`, priced from the live
 * shop catalog (shop-prices.json). Run: node scripts/kit-cost.js
 * Items not present in the catalog are marked UNKNOWN and excluded.
 */
const catalog = require('../shop-prices.json');
const price = {};
for (const c of Object.values(catalog)) for (const it of c.items) {
  const b = it.l.match(/Buy Price\s*■\s*\$([\d,.]+)/);
  if (b) price[it.n.toLowerCase()] = parseFloat(b[1].replace(/,/g, ''));
}
const rows = [];
function add(item, qty, note='') { rows.push({ item, qty, unit: price[item.toLowerCase()], note }); }
function known(n) { return price[n.toLowerCase()] != null; }

// Gear: 4 armour (5+8+7+4 diamonds) + 5 tools (3+3+1+2+2 diamonds) = 35 diamonds
add('Diamond', 35, '4 armour pieces + 5 tools');
// Netherite upgrade: 1 ingot per piece = 9 ingots (smithing table)
add('Netherite Ingot', 9, 'upgrade all 9 diamond pieces');
// Anvil + smithing table + crafting bench
add('Anvil', 1);
add('Smithing Table', 1);
add('Bamboo Planks', 32, 'bench, chest, shelter seal');
// Golden apples: 8 gold ingots + 1 apple each
add('Gold Ingot', 16, '2 golden apples (8 ingots each)');
add('Apple', 2, '2 golden apples');
// Enchanting books — 27 slots, $10k–$32k; assume 12 books avg ~$18k
add('Enchanted Book', 12, 'approx 12 enchants; avg price');
// XP: Bottle o Enchanting (3-11 XP, avg 7). Lv30 from 0 = 1395 XP => ~200 bottles;
// anvil prior-work penalty pushes this to ~300 for a full enchanted set.
add("Bottle o' Enchanting", 300, 'XP to Lv30+ with anvil prior-work');
// Packaging
add('Shulker Shell', 2, 'shulker box');

const missing = ['Splash Potion (invisibility)','Netherite Upgrade Template','Trim templates','Oak Planks','item named "nether"'];
let total = 0;
console.log('nethkit bill of materials — priced from shop-prices.json\n');
for (const r of rows) {
  const u = r.unit;
  const line = u == null ? 'UNKNOWN' : `$${(u*r.qty).toLocaleString(undefined,{maximumFractionDigits:0})}`;
  if (u != null) total += u*r.qty;
  console.log(`${r.item.padEnd(24)} x${String(r.qty).padStart(4)}  ${line.padStart(14)}  ${r.note}`);
}
console.log(`\nSubtotal (catalog items): $${Math.round(total).toLocaleString()}`);
console.log(`Recommended buffer (15%):  $${Math.round(total*0.15).toLocaleString()}`);
console.log(`Pay the bot about:         $${Math.round(total*1.15).toLocaleString()}\n`);
console.log('NOT in catalog (cannot price):');
for (const m of missing) console.log('  -', m);
console.log('\nNote: enchants count and XP bottles are estimates; adjust after live recon.');
