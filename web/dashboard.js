'use strict';

const botsEl = document.getElementById('bots');
const feedEl = document.getElementById('feed');
const nowEl = document.getElementById('now');
const connEl = document.getElementById('conn');
const form = document.getElementById('cmd-form');
const cmdInput = document.getElementById('cmd');
const submitBtn = form.querySelector('button');

const BADGES = {
  chat: 'CHAT', whisper: 'WHISPER', server: 'SERVER', system: 'SYS',
  step: 'STEP', out: 'YOU', command: 'CMD', title: 'TITLE',
  actionbar: 'INFO', error: 'ERROR'
};

let selected = null;
let known = [];
let timer = null;

async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `${res.status}`);
  return data;
}

function scroll() { feedEl.scrollTop = feedEl.scrollHeight; }

async function loadBots() {
  try {
    const { bots } = await api('/api/bots');
    known = bots;
    connEl.textContent = `${bots.length} bot${bots.length === 1 ? '' : 's'}`;
    connEl.className = 'ok';
    botsEl.innerHTML = '';
    for (const name of bots) {
      const li = document.createElement('li');
      li.innerHTML = `<button type="button" data-bot="${name}">
        <span class="dot"></span><span class="name">${name}</span>
        <span class="meta"></span></button>`;
      li.querySelector('button').addEventListener('click', () => select(name));
      botsEl.appendChild(li);
    }
    if (!selected && bots.length) select(bots[0]);
    refreshSidebar();
  } catch (err) {
    connEl.textContent = err.message;
    connEl.className = 'muted';
  }
}

function select(name) {
  selected = name;
  feedEl.innerHTML = '';
  nowEl.textContent = `loading ${name}…`;
  for (const li of botsEl.children) {
    li.querySelector('button').classList.toggle('active', li.querySelector('.name').textContent === name);
  }
  cmdInput.disabled = false;
  submitBtn.disabled = false;
  cmdInput.placeholder = `Command for ${name} — e.g. /status, /help`;
  loadState();
  clearInterval(timer);
  timer = setInterval(loadState, 4000);
}

/** Pull every bot's state so the whole sidebar shows live balances. */
async function refreshSidebar() {
  await Promise.all(known.map(async name => {
    const li = [...botsEl.children].find(l => l.querySelector('.name').textContent === name);
    if (!li) return;
    const btn = li.querySelector('button');
    try {
      const s = await api(`/api/state?bot=${encodeURIComponent(name)}`);
      btn._state = s;
      const m = s.money;
      li.querySelector('.meta').textContent = m && m.balance != null ? `$${Number(m.balance).toFixed(0)}` : '';
      btn.classList.toggle('offline', !s.connected);
    } catch {
      li.querySelector('.meta').textContent = '';
      btn.classList.add('offline');
    }
  }));
}

async function loadState() {
  if (!selected) return;
  try {
    const s = await api(`/api/state?bot=${encodeURIComponent(selected)}`);
    render(s);
  } catch (err) {
    nowEl.textContent = `${selected}: ${err.message}`;
  }
}

function render(s) {
  const age = Math.round((Date.now() - s.ts) / 1000);
  const m = s.money || {};
  const st = s.status || {};
  nowEl.innerHTML =
    `<span class="name">${s.bot}</span> ` +
    `<span class="${s.connected ? 'ok' : 'bad'}">${s.connected ? 'online' : 'offline'}</span>` +
    ` · ${m.phase || s.phase || ''} ${m.message || ''}` +
    (m.balance != null ? ` · <b>$${Number(m.balance).toFixed(2)}</b>` : '') +
    (st.health != null ? ` · hp ${st.health} food ${st.food}` : '') +
    ` <span class="muted">(${age}s ago)</span>`;

  const feed = s.feed || [];
  feedEl.innerHTML = '';
  for (const ev of feed) add(ev);
  scroll();
}

function add(ev) {
  const row = document.createElement('div');
  row.className = `line t-${ev.type}`;
  const time = document.createElement('span');
  time.className = 'time';
  time.textContent = new Date(ev.ts).toLocaleTimeString();
  const badge = document.createElement('span');
  badge.className = 'badge';
  badge.textContent = BADGES[ev.type] || String(ev.type || '').toUpperCase();
  const text = document.createElement('span');
  text.className = 'text';
  text.textContent = ev.text;
  row.append(time, badge, text);
  feedEl.appendChild(row);
}

form.addEventListener('submit', async e => {
  e.preventDefault();
  const text = cmdInput.value.trim();
  if (!text || !selected) return;
  cmdInput.value = '';
  try {
    await api('/api/command', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bot: selected, text })
    });
    add({ ts: Date.now(), type: 'out', text });
    scroll();
    setTimeout(loadState, 2500);
  } catch (err) {
    add({ ts: Date.now(), type: 'error', text: err.message });
  }
});

loadBots();
setInterval(loadBots, 20000);
setInterval(refreshSidebar, 5000);
