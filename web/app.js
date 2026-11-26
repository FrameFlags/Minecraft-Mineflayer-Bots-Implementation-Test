'use strict';

const feed = document.getElementById('feed');
const dot = document.getElementById('dot');
const statusEl = document.getElementById('status');
const whoEl = document.getElementById('who');
const clearBtn = document.getElementById('clear');
const winTitle = document.getElementById('win-title');
const containerGrid = document.getElementById('container-grid');
const inventoryGrid = document.getElementById('inventory-grid');
const tooltip = document.getElementById('tooltip');
const rightPanel = document.querySelector('.right');

const BADGES = {
  chat: 'CHAT', whisper: 'WHISPER', server: 'SERVER', system: 'SYS',
  step: 'STEP', out: 'YOU', command: 'CMD', title: 'TITLE',
  actionbar: 'INFO', error: 'ERROR'
};

let ws;
let nearBottom = true;
let panel = null;

/* ---------------- feed ---------------- */

function scroll() { feed.scrollTop = feed.scrollHeight; }

feed.addEventListener('scroll', () => {
  nearBottom = feed.scrollHeight - feed.scrollTop - feed.clientHeight < 80;
});

function add(ev) {
  const row = document.createElement('div');
  row.className = `line t-${ev.type}`;

  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(ev.ts).toLocaleTimeString();

  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = BADGES[ev.type] || '•';

  const body = document.createElement('span');
  body.className = 'body';

  if (ev.type === 'chat' || ev.type === 'whisper') {
    const user = document.createElement('b');
    user.textContent = `${ev.username || '???'}: `;
    body.appendChild(user);
    body.appendChild(document.createTextNode(ev.text));
  } else {
    body.textContent = ev.text;
  }

  row.appendChild(time);
  row.appendChild(badge);
  row.appendChild(body);
  feed.appendChild(row);

  while (feed.children.length > 500) feed.removeChild(feed.firstChild);
  if (nearBottom) scroll();
}

function setStatus(status) {
  if (!status) return;
  if (status.username) whoEl.textContent = `@${status.username}`;
  const on = !!status.connected;
  dot.classList.toggle('on', on);
  const phase = status.phase ? ` · ${status.phase}` : '';
  statusEl.textContent = on ? `connected${phase}` : `disconnected${phase}`;
}

/* ---------------- container / inventory panel ---------------- */

function itemColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `hsl(${h % 360} 45% 32%)`;
}

function shortName(name) {
  const s = String(name || '');
  return s.length > 10 ? `${s.slice(0, 9)}…` : s;
}

function renderPanel(state) {
  panel = state;
  if (!state) return;

  winTitle.textContent = state.open
    ? `${state.title}  ·  ${state.type}`
    : 'no container open';

  const containerBySlot = new Map(state.container.filter(Boolean).map(i => [i.slot, i]));
  containerGrid.innerHTML = '';
  const containerCount = state.open ? state.inventoryStart : 0;
  for (let s = 0; s < containerCount; s++) {
    containerGrid.appendChild(makeSlot('container', s, containerBySlot.get(s) || null));
  }

  const invBySlot = new Map(state.inventory.filter(Boolean).map(i => [i.slot, i]));
  inventoryGrid.innerHTML = '';
  for (let s = state.inventoryStart; s < state.inventoryEnd; s++) {
    inventoryGrid.appendChild(makeSlot('inventory', s, invBySlot.get(s) || null));
  }
}

function makeSlot(area, slot, item) {
  const cell = document.createElement('div');
  cell.className = `slot${item ? ' has-item' : ''}`;
  cell.dataset.area = area;
  cell.dataset.slot = slot;
  if (item) {
    cell.style.background = itemColor(item.name);
    const label = document.createElement('span');
    label.className = 'slot-label';
    label.textContent = shortName(item.displayName || item.name);
    cell.appendChild(label);
    if (item.count > 1) {
      const count = document.createElement('span');
      count.className = 'slot-count';
      count.textContent = item.count;
      cell.appendChild(count);
    }
  }
  return cell;
}

function findItem(area, slot) {
  if (!panel) return null;
  const list = area === 'container' ? panel.container : panel.inventory;
  return list.find(i => i && i.slot === slot) || null;
}

function ttRow(cls, text) {
  const div = document.createElement('div');
  div.className = cls;
  div.textContent = text;
  return div;
}

function showTooltip(item, x, y) {
  tooltip.innerHTML = '';
  tooltip.appendChild(ttRow('tt-title', item.displayName || item.name));
  tooltip.appendChild(ttRow('tt-meta', `${item.name}  ·  x${item.count}  ·  slot ${item.slot}`));
  if (item.enchantments && item.enchantments.length) {
    tooltip.appendChild(ttRow('tt-ench', item.enchantments.map(e => e.display).join('\n')));
  }
  if (item.maxDurability) {
    const used = item.damage ?? 0;
    tooltip.appendChild(ttRow('tt-meta', `durability: ${Math.max(0, item.maxDurability - used)}/${item.maxDurability}`));
  }
  if (item.unbreakable) tooltip.appendChild(ttRow('tt-meta', 'unbreakable'));
  if (item.customModelData != null) tooltip.appendChild(ttRow('tt-meta', `custom model data: ${item.customModelData}`));
  if (item.lore && item.lore.length) {
    tooltip.appendChild(ttRow('tt-lore', item.lore.join('\n')));
  }
  tooltip.hidden = false;
  positionTooltip(x, y);
}

function positionTooltip(x, y) {
  const pad = 14;
  const rect = tooltip.getBoundingClientRect();
  let left = x + pad;
  let top = y + pad;
  if (left + rect.width > window.innerWidth - 8) left = x - rect.width - pad;
  if (top + rect.height > window.innerHeight - 8) top = y - rect.height - pad;
  tooltip.style.left = `${Math.max(8, left)}px`;
  tooltip.style.top = `${Math.max(8, top)}px`;
}

rightPanel.addEventListener('mouseover', e => {
  const cell = e.target.closest('.slot.has-item');
  if (!cell) return;
  const item = findItem(cell.dataset.area, Number(cell.dataset.slot));
  if (item) showTooltip(item, e.clientX, e.clientY);
});
rightPanel.addEventListener('mousemove', e => {
  if (!tooltip.hidden) positionTooltip(e.clientX, e.clientY);
});
rightPanel.addEventListener('mouseout', e => {
  if (e.target.closest('.slot')) tooltip.hidden = true;
});

rightPanel.addEventListener('click', e => {
  const cell = e.target.closest('.slot');
  if (!cell || !ws || ws.readyState !== WebSocket.OPEN) return;
  const area = cell.dataset.area;
  const slot = Number(cell.dataset.slot);
  if (area === 'container') {
    send({ type: e.shiftKey ? 'take' : 'click', slot });
  } else {
    send({ type: e.shiftKey ? 'deposit' : 'click', slot });
  }
});

/* ---------------- snow bot ---------------- */

let snowState = null;

function renderSnow(state) {
  snowState = state;
  const btn = document.getElementById('snow-toggle');
  const status = document.getElementById('snow-status');
  if (!state) {
    btn.textContent = 'Start';
    status.textContent = 'idle';
    return;
  }
  btn.textContent = state.running ? 'Stop' : 'Start';
  status.textContent =
    `${state.phase} — ${state.message}  ·  snowballs ${state.snowballs}` +
    `  ·  blocks ${state.snowBlocks}  ·  cycles ${state.cycles}`;
}

document.getElementById('snow-toggle').addEventListener('click', () => {
  send({ type: snowState && snowState.running ? 'stopsnow' : 'digsnow' });
});

document.getElementById('open-chest').addEventListener('click', () => send({ type: 'command', text: '/chest' }));
document.getElementById('takeall').addEventListener('click', () => send({ type: 'takeall' }));
document.getElementById('depositall').addEventListener('click', () => send({ type: 'depositall' }));
document.getElementById('accept').addEventListener('click', () => send({ type: 'accept' }));
document.getElementById('closewin').addEventListener('click', () => send({ type: 'closewindow' }));

/* ---------------- websocket ---------------- */

function send(obj) {
  if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
}

function connect() {
  const proto = location.protocol === 'https:' ? 'wss://' : 'ws://';
  ws = new WebSocket(`${proto}${location.host}`);

  ws.onclose = () => {
    dot.classList.remove('on');
    statusEl.textContent = 'reconnecting…';
    setTimeout(connect, 1000);
  };
  ws.onmessage = e => {
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    if (msg.kind === 'history') {
      for (const ev of msg.events) add(ev);
      scroll();
    } else if (msg.kind === 'feed') {
      add(msg.event);
    } else if (msg.kind === 'status') {
      setStatus(msg.status);
    } else if (msg.kind === 'panel') {
      renderPanel(msg.state);
    } else if (msg.kind === 'snow') {
      renderSnow(msg.state);
    }
  };
}

function wireForm(formId, inputId, type) {
  const form = document.getElementById(formId);
  const input = document.getElementById(inputId);
  form.addEventListener('submit', e => {
    e.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    send({ type, text });
    input.value = '';
    input.focus();
  });
}

wireForm('chat-form', 'chat', 'chat');
wireForm('cmd-form', 'cmd', 'command');

clearBtn.addEventListener('click', () => { feed.innerHTML = ''; });

connect();
