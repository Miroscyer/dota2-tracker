# 大话游戏 | DOTA2助手

A live, in-game Dota 2 **overlay** that shows your real-time match stats and lets
you scout any player — built on Valve's official **Game State Integration (GSI)**.

It's a desktop app (Electron): a frameless, always-on-top overlay you keep on
top of the game. No game files are modified; GSI is ToS-friendly.

![status](https://img.shields.io/badge/status-working-brightgreen)

> **v2.0** merges two projects: the Electron overlay shell (tray, hotkeys,
> transparency, auto-update) with a live GSI data pipeline that actually streams
> in-game stats to the UI over WebSocket — so the numbers update several times a
> second during the match (earlier versions polled external APIs that have no
> live data for ordinary games, so nothing changed on screen).

## Features

**Match tab — live, from GSI (updates in real time):**
- Scoreboard: Radiant/Dire kills, game clock, game state, day/night
- Hero: name, level, HP/mana bars, respawn timer, status effects (stun/silence/hex/smoke/…)
- Player: K/D/A + KDA, last hits, denies, GPM, XPM, gold, net worth, hero & tower damage
- Items (all 9 slots, cooldowns & charges) + neutral item
- Abilities (levels, cooldowns, ultimate highlight)
- Tier-1 tower health per lane
- 🤖 **AI coach** — one click sends your current state to Claude for 5 quick tips

**Scout tab — from OpenDota:**
- Look up any player by name or Steam/Account ID
- Winrate, rank, recent average KDA/GPM/XPM, top heroes

**Overlay shell:**
- Frameless, transparent, always-on-top; drag by the title bar
- System tray, hotkeys (`Alt+D` show/hide · `Alt+L` logs · `Alt+S` settings · `Alt+Shift+D` reset position)
- Adjustable opacity, in-app logs window

The overlay appears top-right. SmartScreen may warn (the installer isn't
code-signed) → **More info → Run anyway**.

## FAQ

**Do I have to restart Dota every time?**
No — only **once**, and only if Dota was already running the first time the
tracker installed the config. Dota reads GSI configs only at its own startup
(a Valve limitation — there's no way to make it reload them live). The tracker
auto-starts with Windows (toggle in Settings ⚙) and keeps the config installed,
so on every later Dota launch it's already there and no restart is needed.

**Can I open the tracker in the middle of a match?**
Yes. GSI streams the full current state continuously, and the server replays the
latest snapshot the moment the overlay connects — so you'll see live data within
a second of opening it mid-game (as long as the config was loaded when Dota
started).

## Run from source

```bash
npm install
npm start          # launches the Electron overlay (dev)
```

Test the data layer without the game (simulated match):

```bash
npm run gsi        # terminal 1 — GSI server on :3001
npm run mock       # terminal 2 — streams a fake live match
```

## Build the installer

```bash
npm run dist       # → release/Dota-2-Tracker-Setup-<version>.exe
# (productName 已改为「大话游戏 | DOTA2助手」，安装包显示名随之变更)
```

The GitHub Actions workflow (`.github/workflows/build-release.yml`) builds the
installer on a Windows runner and publishes it (Setup .exe + blockmap +
`latest.yml` for auto-update) to a Release whenever a `vX.Y.Z` tag is pushed.

## How it works

```
 Dota 2 ──POST /gsi (JSON)──▶ gsi-server (:3001) ──WebSocket /ws──▶ overlay UI
 (GSI cfg)   many times/sec    enrich + broadcast      live stats, instant

 overlay ──HTTP──▶ gsi-server ──▶ OpenDota API   (scouting: profiles, winrates)
                              └──▶ Anthropic API (AI coach)
```

- `electron/` — main process (overlay window, tray, hotkeys, auto-update, GSI-config
  auto-install) + preload bridge.
- `gsi-server/server.js` — Express: receives GSI, validates the auth token,
  enriches the payload, broadcasts over WebSocket; plus OpenDota/Valve/AI endpoints.
- `dist/` — the overlay UI (plain HTML/CSS/JS, no build step).
- `lib/gsi-install.js` — finds the Steam/Dota path and installs the cfg cross-platform.

## AI assistant

A chat (with conversation history) that answers any Dota question and sees your
**live match context** — game minute, your hero/level/HP/mana/stats/items/
abilities, scores and draft picks. Ask things like *"против Хускара что купить?"*.

Pick a provider in **Settings ⚙** and paste **your own** key — choose one of:

| Provider | Get a key |
|----------|-----------|
| ChatGPT (OpenAI) | <https://platform.openai.com/api-keys> |
| Google Gemini    | <https://aistudio.google.com/app/apikey> |
| DeepSeek         | <https://platform.deepseek.com/api_keys> |

Keys are stored **only locally** (`%AppData%/Dota 2 Tracker/.env`) and are never
committed to the repo or bundled in the release. They take effect immediately
(no restart).

> Note: GSI only exposes *your* live data + the draft (hero lineups). Teammates'/
> enemies' live items aren't available in a normal match, so the AI reasons from
> your situation, the picks, and what you mention in the question.

## Configuration

Other optional keys (Settings window, saved to `%AppData%/Dota 2 Tracker/.env`):

| Key             | Enables |
|-----------------|---------|
| `STEAM_API_KEY` | Live full-scoreboard lookups via Valve WebAPI (optional) |

The GSI auth token defaults to `DOTA2_TRACKER_SECRET` (must match the `.cfg`);
override with `GSI_AUTH_TOKEN`.

## Credits

- Original overlay app & concept: [uin3556/dota2-tracker](https://github.com/uin3556/dota2-tracker)
- Live GSI pipeline + merge: this fork.

## License

MIT
