'use strict';

/**
 * Leave the server one bot at a time.
 *
 * A run stops all its bot jobs in the same tick (the 175-minute timeout, or a
 * cancel), so without a stagger every bot disconnects at once and the proxy
 * sees a herd. Waiting a random 1-4s spreads them out.
 */
function staggeredQuit(bot, log = console.log) {
  // The workflow assigns each bot a random slot (>=70s). Add a fresh jitter so
  // a restart never repeats a previous disconnect time, and never go below
  // 65s — that is what keeps two bots from leaving in the same minute.
  const slot = Number(process.env.BOT_STAGGER_MS || 0);
  const delay = Math.max(65000, slot) + Math.floor(Math.random() * 20000);
  log(`\nquitting in ${delay}ms (random slot ${slot}ms + jitter)...`);
  setTimeout(() => {
    try { bot?.quit(); } catch { /* already gone */ }
  }, delay);
  setTimeout(() => process.exit(0), delay + 2000);
  return delay;
}

module.exports = { staggeredQuit };
