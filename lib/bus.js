'use strict';

/**
 * Tiny global event bus. The bot (workflow + commands) publishes feed events;
 * the web UI subscribes and streams them to the browser.
 *
 * Also keeps a rolling history so a freshly opened page can load past messages.
 */

const EventEmitter = require('node:events');

const MAX_HISTORY = 300;

class Bus extends EventEmitter {
  constructor() {
    super();
    this.history = [];
    this.panel = null;
    this._panelKey = null;
    this.snow = null;
    this._snowKey = null;
    this.money = null;
    this._moneyKey = null;
  }

  publish(type, text, extra = {}) {
    const entry = { ts: Date.now(), type, text: String(text), ...extra };
    this.history.push(entry);
    if (this.history.length > MAX_HISTORY) this.history.shift();
    this.emit('feed', entry);
    return entry;
  }

  recent() {
    return this.history;
  }

  /** Structured container/inventory snapshot for the web panel (not the feed). */
  publishPanel(state) {
    const key = JSON.stringify(state);
    if (key === this._panelKey) return;
    this._panelKey = key;
    this.panel = state;
    this.emit('panel', state);
  }

  /** Snow-bot status for the web panel (not the feed). */
  publishSnow(state) {
    const key = JSON.stringify(state);
    if (key === this._snowKey) return;
    this._snowKey = key;
    this.snow = state;
    this.emit('snow', state);
  }

  /** Money-loop status for the web panel (not the feed). */
  publishMoney(state) {
    const key = JSON.stringify(state);
    if (key === this._moneyKey) return;
    this._moneyKey = key;
    this.money = state;
    this.emit('money', state);
  }
}

module.exports = new Bus();
