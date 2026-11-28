'use strict';

// Shared configuration. Bot files stay tiny: they just pick an entry from
// `bots` and hand it to lib/workflow.js.
const path = require('node:path');

module.exports = {
  // Server coordinates come from the environment — the workflow injects them
  // from repository secrets, so the repo itself never names the server.
  server: {
    host: process.env.MC_HOST || '127.0.0.1',
    port: Number(process.env.MC_PORT || 25565),
    version: process.env.MC_VERSION || '1.20.1',
    auth: 'offline' // server uses /register + /login, not Mojang auth
  },

  // Local web UI (feed + chat + commands). Set WEB_PORT to change the port.
  web: {
    host: process.env.WEB_HOST || '127.0.0.1',
    port: Number(process.env.WEB_PORT || 3000),
    openOnStart: !process.env.NO_OPEN // auto-open the page when the bot starts
  },

  // Where registered account passwords are saved (one entry per username).
  accountsFile: path.join(__dirname, 'accounts.json'),

  // Used ONLY when an account has no saved password yet (first ever join).
  // Set MC_PASSWORD in the shell to choose it yourself; otherwise a random
  // password is generated and written to accounts.json.
  registerPassword: process.env.MC_PASSWORD || null,

  // Start the Eye of Ender money loop automatically once the workflow finishes.
  money: { autoStart: true },

  // Money loop auto-payout: whenever the balance reaches `threshold`, send
  // `amount` to `to` with /pay.
  payout: {
    to: process.env.PAY_TO || 'player',
    reserve: 10000, // always keep this much; everything above it is paid out
    threshold: 10000 // pay once the balance is past this
  },

  workflow: {
    // The first join intentionally drops after 2s and rejoins — the server has a
    // ~10s login timeout, so this has to stay short. The spacing between bots
    // comes from the random slot applied to the rejoin, not from this hold.
    firstJoinHoldMs: 2000,
    reconnectDelayMs: 5000, // first wait before rejoining (grows per attempt)
    maxReconnectDelayMs: 900000, // cap the backoff (15 min) — slots are minutes apart
    authDelayMs: 1200, // wait after spawn before /register or /login
    compassSettleMs: 1000, // wait after selecting the compass before right-click
    compassTimeoutMs: 10000, // give up if no compass appears in the hotbar
    guiTimeoutMs: 8000, // give up if the compass GUI never opens
    // A server restart wipes every inventory except the compass the bot keeps
    // in its hotbar. When that is all we can see, redo the join workflow.
    restartWatchMs: 10000,
    restartWatchCooldownMs: 60000,
    workflowRetryMs: 20000, // reconnect and retry after a failed workflow
    connectTimeoutMs: 20000, // give up if the server never responds
    maxReconnectAttempts: 24, // per phase; then it stops and waits for /reconnect
    autoAcceptRules: true, // click the rules/accept item when a GUI opens
    // The rules GUI's accept item is a Block of Emerald, so match on that too.
    rulesAcceptMatch: ['accept', 'agree', 'confirm', 'allow', 'yes', 'emerald'],
    lootExact: ['tnt'], // item names taken verbatim (lowercased)
    lootIncludes: ['lifesteal'], // substrings matched against item names
    logChat: false // server/chat messages go to the web page, not the CLI
  },

  // The bot list comes from the environment (MC_BOTS, comma-separated), and
  // MC_AFK_BOTS names the ones that run the home/AFK role instead of trading.
  // Both are injected by the workflow from repository secrets.
  bots: (() => {
    const names = (process.env.MC_BOTS || 'bot1,bot2').split(',').map(s => s.trim()).filter(Boolean);
    const afk = new Set((process.env.MC_AFK_BOTS || '').split(',').map(s => s.trim()).filter(Boolean));
    const kit = new Set((process.env.MC_KIT_BOTS || '').split(',').map(s => s.trim()).filter(Boolean));
    return Object.fromEntries(names.map(name => [
      name, { username: name, mode: kit.has(name) ? 'kit' : afk.has(name) ? 'afk' : 'money' }
    ]));
  })(),

  // Home/AFK role settings. `owner` is the only player allowed to command it.
  afk: {
    owner: process.env.PAY_TO || 'player',
    homesFile: 'bus/homes.json'
  },

  // Kit role: only the pay target may command the bot.
  kit: {
    owner: process.env.PAY_TO || 'player'
  }
};
