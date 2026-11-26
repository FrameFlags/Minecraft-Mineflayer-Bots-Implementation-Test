# Minecraft server bot automation to make automated crafting

A small, reusable framework for running **automated Minecraft bots** that log
into a server, follow a join workflow, and then run a repeating **buy → craft →
sell** money loop. Everything is plain JavaScript on top of
[Mineflayer](https://github.com/PrismarineJS/mineflayer); there is no build
step and no obfuscation.

This repo is intentionally open and readable: the point is that the behaviour
is auditable. The **account names, the server address, the pay target and the
passwords are not here** — they are injected at run time from GitHub repository
secrets (see [Secrets](#secrets)). Everything the bots publish is plain and
public — balance, phase and status — except the chat log, which is encrypted
and embedded in the state file as a base64 blob so nothing looks hidden.

## What the bots actually do

Each bot is a normal Minecraft client connection. On every session it:

1. Connects to the server, then disconnects after 2s and reconnects (this gets
   past the server's login timeout).
2. Registers on its first ever join (`/register <pw> <pw>`), or logs in with the
   saved password on later joins.
3. Looks for a compass in its inventory and right-clicks it to open the
   server's kit GUI, then takes the items it is configured to keep
   (`tnt`, and anything matching `lifesteal`). If the account has no compass
   yet, it logs a warning and carries on — the compass is not needed for the
   money loop.
4. Prints `WORKFLOW COMPLETE` and drops into command mode.

Then the money loop runs forever:

1. Read the balance from the shop GUI.
2. Work out the most pearl+powder pairs that fit the balance **and** the free
   inventory slots, buying only whichever material is short.
3. Buy the materials through the shop GUI, using the "stacks" view.
4. Close the shop, clear the 2×2 crafting grid, craft Eyes of Ender.
5. Sell every eye stack through the SellGUI.
6. Walk over any dropped items, then repeat.

Once the balance passes a threshold, the loop pays everything above a reserve
to a configured player with one `/pay`.

## Layout

```
bot.js            → tiny entry point (picks a bot by slot, starts it)
config.js         → server, web UI, bot list, timings (all env-injected)
lib/workflow.js   → the universal join workflow every bot runs
lib/commands.js   → every command (hot-reloaded on each CLI line)
lib/money.js      → the buy → craft → sell loop
lib/remote.js     → state/command bus over the GitHub contents API (chat log encrypted)
lib/quit.js       → graceful, staggered disconnect
lib/webui.js      → local web server + WebSocket panel
web/              → the panel (index.html, app.js, style.css)
dashboard.js      → optional local dashboard that reads the bus from the repo
```

## Secrets

The workflow reads these repository secrets and injects them as environment
variables. None of them appear in the repo or in the logs.

| Secret | Purpose |
| --- | --- |
| `MC_BOTS` | Comma-separated bot account names. |
| `MC_ACCOUNTS` | JSON map of account name → `{ "password": "…" }`. |
| `MC_HOST` / `MC_PORT` / `MC_VERSION` | Server address. |
| `PAY_TO` | Who the money loop pays out to. |
| `STATE_KEY` | Passphrase for the encrypted `feedBlob` in `bus/state/*.json`. |

Bots are identified everywhere by **slot index** (`slot0`, `slot1`, …), so the
state files in `bus/state/` never contain an account name.

## Joins and disconnects are spread out

Every run generates a fresh random schedule: each bot gets
`slot × 85s + random(0–20s)`, re-rolled on every run. That value drives its
first join, every reconnect and its quit, so:

- no two bots join or leave in the same minute;
- a restart never repeats a previous schedule.

A run also stops itself cleanly after ~170 minutes, ahead of the job timeout,
and the cron starts the next one.

## Running it

```bash
npm install
node bot.js            # local run (set MC_HOST, MC_BOTS, … yourself)
node dashboard.js      # local control panel on http://127.0.0.1:3000/
```

In CI, the workflow checks out the repo, seeds `accounts.json` from the
`MC_ACCOUNTS` secret, and runs one bot per matrix job.

## The home / AFK role

A bot can be given `mode: 'afk'` (via the `MC_AFK_BOTS` secret) instead of
running the money loop. It then does nothing but hold a spot and answer its
owner's whispers — handy for keeping a base chunk loaded or an account online.

Tell it from in game (only the pay target's account is obeyed):

| Whisper | What it does |
| --- | --- |
| `/tell <bot> sethome <name>` | `/tpa` the owner, and once the teleport lands, `/sethome <name>` there, then `/spawn` back. |
| `/tell <bot> home list` | List every saved home with its coordinates. |
| `/tell <bot> afkhome <name>` | `/home <name>`, then sneak continuously (re-asserted every 2s so knockbacks don't stand it up). |
| `/tell <bot> afkstop` | Stop sneaking. |

The home list is persisted in `bus/homes.json` so it survives runner restarts.
The same commands work from the dashboard as `/sethome <name>`, `/home list`,
`/afkhome <name>`.

## Commands

`lib/commands.js` is reloaded from disk on every CLI line, so you can edit it
and the next command uses the new version. Highlights: `/status`, `/pos`,
`/inventory`, `/containershow`, `/take`, `/deposit`, `/chest`, `/eyeloop`,
`/stopeye`, `/eyestatus`, `/pickup`, `/payto <player> <amount>`, `/reconnect`,
`/quit`.

## Notes and limits

- This drives a real game server with automated accounts. Whether that is
  allowed is up to the server's rules; it may get accounts banned and it may
  get the automation host's repository flagged. Use it on servers you have
  permission to automate.
- State files are plain JSON: a bot's balance, phase, status and inventory are
  intentionally public. Only the chat log is encrypted (AES-256-GCM, key from
  `STATE_KEY`) and stored as `feedBlob` — no `.enc` files. Account names and
  passwords never appear: bots are identified by slot index and credentials
  live in the `MC_ACCOUNTS` secret.
- Set up the key with `scripts/make-key.sh`, then push the same value as the
  `STATE_KEY` secret — the dashboard reads the local file, the runner reads the
  secret.
- The shop navigation assumes the server's shop GUI layout; if the server
  updates its menus, the selectors in `lib/money.js` need updating.
