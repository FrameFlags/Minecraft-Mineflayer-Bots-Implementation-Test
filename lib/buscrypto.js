'use strict';

/**
 * Encryption for the chat log only.
 *
 * The state, command queue and home list are plain JSON. Only the bot's chat
 * feed is encrypted, embedded in the state file as a base64 `feedBlob` so the
 * repo shows a normal JSON file with nothing obviously hidden.
 *
 * Layout: salt(16) | iv(12) | tag(16) | ciphertext, base64-encoded as ASCII so
 * GitHub stores it as text (binary blobs get re-encoded and corrupted).
 */

const crypto = require('node:crypto');

const ITERATIONS = 200000;
const KEY_LENGTH = 32;

function deriveKey(pass, salt) {
  return crypto.pbkdf2Sync(String(pass), salt, ITERATIONS, KEY_LENGTH, 'sha256');
}

function encryptJSON(value, pass) {
  const salt = crypto.randomBytes(16);
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  const plain = Buffer.from(JSON.stringify(value), 'utf8');
  const body = Buffer.concat([cipher.update(plain), cipher.final()]);
  return Buffer.concat([salt, iv, cipher.getAuthTag(), body]).toString('base64');
}

function decryptJSON(text, pass) {
  const raw = Buffer.from(String(text).trim(), 'base64');
  if (raw.length < 44) throw new Error('state file is too short to be a valid snapshot');
  const salt = raw.subarray(0, 16);
  const iv = raw.subarray(16, 28);
  const tag = raw.subarray(28, 44);
  const body = raw.subarray(44);
  const decipher = crypto.createDecipheriv('aes-256-gcm', deriveKey(pass, salt), iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(body), decipher.final()]);
  return JSON.parse(plain.toString('utf8'));
}

/** The passphrase: env first, then the local key file the dashboard writes. */
function readKey() {
  if (process.env.BUS_KEY || process.env.STATE_KEY) {
    return process.env.BUS_KEY || process.env.STATE_KEY;
  }
  try {
    const file = require('node:path').join(
      process.env.HOME || '~', '.config', 'minecraft-bot-runner', 'state.key'
    );
    return require('node:fs').readFileSync(file, 'utf8').trim();
  } catch {
    return '';
  }
}

module.exports = { encryptJSON, decryptJSON, readKey };
