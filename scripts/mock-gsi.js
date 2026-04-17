#!/usr/bin/env node
/**
 * Mock Dota 2 GSI sender — simulates a live match so you can develop and verify
 * the dashboard without launching the game. POSTs an evolving game state to the
 * tracker a few times per second, mirroring the real GSI payload shape.
 *
 * Usage:  node scripts/mock-gsi.js   (while `npm start` is running)
 */

const http = require('http');

const PORT = process.env.GSI_PORT || process.env.PORT || 3001;
const GSI_PATH = '/gsi';
const AUTH_TOKEN = process.env.GSI_AUTH_TOKEN || 'DOTA2_TRACKER_SECRET';
const TICK_MS = 500;

let clock = -90;        // start in pre-game (negative = horn countdown)
let tick = 0;

function buildPayload() {
  clock += TICK_MS / 1000;
  tick += 1;

  const inGame = clock >= 0;
  const minutes = Math.max(0, clock / 60);

  // Stats grow roughly with game time, with a little jitter.
  const lastHits = Math.floor(minutes * 6 + Math.sin(tick / 7) * 3);
  const denies = Math.floor(minutes * 0.8);
  const kills = Math.floor(minutes / 4);
  const deaths = Math.floor(minutes / 9);
  const assists = Math.floor(minutes / 3);
  const gpm = Math.floor(420 + minutes * 4 + Math.sin(tick / 11) * 20);
  const xpm = Math.floor(480 + minutes * 5);
  const gold = Math.floor((gpm * minutes) % 2500);
  const netWorth = Math.floor(625 + gpm * minutes);
  const level = Math.min(30, 1 + Math.floor(minutes / 1.5));
  const maxHp = 600 + level * 90;
  const maxMana = 300 + level * 55;

  return {
    provider: {
      name: 'Dota 2',
      appid: 570,
      version: 47,
      timestamp: Math.floor(Date.now() / 1000),
    },
    map: {
      name: 'start',
      matchid: '7654321098',
      game_time: Math.floor(clock + 90),
      clock_time: Math.floor(clock),
      daytime: Math.floor(clock / 240) % 2 === 0,
      nightstalker_night: false,
      game_state: inGame ? 'DOTA_GAMERULES_STATE_GAME_IN_PROGRESS'
                         : 'DOTA_GAMERULES_STATE_PRE_GAME',
      paused: false,
      win_team: 'none',
      radiant_score: kills,
      dire_score: Math.floor(kills * 0.8),
      radiant_ward_purchase_cooldown: 0,
      dire_ward_purchase_cooldown: 0,
    },
    player: {
      steamid: '76561198000000000',
      accountid: '40000000',
      name: 'Mock Player',
      activity: 'playing',
      kills,
      deaths,
      assists,
      last_hits: lastHits,
      denies,
      kill_streak: 0,
      team_name: 'radiant',
      gold,
      gold_reliable: Math.floor(gold * 0.4),
      gold_unreliable: Math.floor(gold * 0.6),
      gold_from_hero_kills: kills * 200,
      gold_from_creep_kills: lastHits * 40,
      gpm,
      xpm,
      net_worth: netWorth,
      hero_damage: Math.floor(minutes * 350),
      hero_healing: 0,
      tower_damage: Math.floor(minutes * 60),
    },
    hero: {
      id: 8,
      name: 'npc_dota_hero_juggernaut',
      level,
      xp: Math.floor(xpm * minutes),
      alive: deaths === 0 || tick % 40 > 6,
      respawn_seconds: tick % 40 <= 6 ? 6 - (tick % 40) + 6 : 0,
      buyback_cost: Math.floor(200 + minutes * 15),
      buyback_cooldown: 0,
      health: Math.floor(maxHp * (0.5 + 0.5 * Math.abs(Math.sin(tick / 9)))),
      max_health: maxHp,
      health_percent: Math.floor(50 + 50 * Math.abs(Math.sin(tick / 9))),
      mana: Math.floor(maxMana * (0.4 + 0.6 * Math.abs(Math.cos(tick / 13)))),
      max_mana: maxMana,
      mana_percent: Math.floor(40 + 60 * Math.abs(Math.cos(tick / 13))),
      silenced: false,
      stunned: false,
      disarmed: false,
      magicimmune: false,
      hexed: false,
      muted: false,
      break: false,
      smoked: false,
      has_debuff: false,
      talent_1: level >= 10, talent_2: false,
      talent_3: level >= 15, talent_4: false,
      talent_5: level >= 20, talent_6: false,
      talent_7: level >= 25, talent_8: false,
    },
    abilities: {
      ability0: { name: 'juggernaut_blade_fury', level: Math.min(4, Math.floor(level / 2)), can_cast: true, passive: false, ability_active: true, cooldown: tick % 12, ultimate: false },
      ability1: { name: 'juggernaut_healing_ward', level: Math.min(4, Math.floor(level / 3)), can_cast: true, passive: false, ability_active: true, cooldown: 0, ultimate: false },
      ability2: { name: 'juggernaut_blade_dance', level: Math.min(4, Math.floor(level / 2)), can_cast: false, passive: true, ability_active: true, cooldown: 0, ultimate: false },
      ability3: { name: 'juggernaut_omni_slash', level: Math.min(3, Math.floor(level / 6)), can_cast: level >= 6, passive: false, ability_active: true, cooldown: tick % 30, ultimate: true },
    },
    items: {
      slot0: { name: 'item_power_treads', purchaser: 0, can_cast: false, cooldown: 0, passive: true },
      slot1: minutes > 5 ? { name: 'item_bfury', purchaser: 0, passive: true } : { name: 'empty' },
      slot2: minutes > 10 ? { name: 'item_manta', purchaser: 0, passive: false, cooldown: 0 } : { name: 'empty' },
      slot3: { name: 'empty' },
      slot4: { name: 'empty' },
      slot5: { name: 'empty' },
      slot6: { name: 'item_tpscroll', purchaser: 0, charges: 1, cooldown: 0 },
      slot7: { name: 'empty' },
      slot8: { name: 'empty' },
      stash0: { name: 'empty' },
      neutral0: minutes > 7 ? { name: 'item_possessed_mask', purchaser: 0 } : { name: 'empty' },
    },
    buildings: {
      radiant: {
        dota_goodguys_tower1_top: { health: 1800, max_health: 1800 },
        dota_goodguys_tower1_mid: { health: 1200, max_health: 1800 },
        dota_goodguys_tower1_bot: { health: 1800, max_health: 1800 },
      },
      dire: {
        dota_badguys_tower1_top: { health: 900, max_health: 1800 },
        dota_badguys_tower1_mid: { health: 0, max_health: 1800 },
        dota_badguys_tower1_bot: { health: 1800, max_health: 1800 },
      },
    },
    auth: { token: AUTH_TOKEN },
  };
}

function send(payload) {
  const data = JSON.stringify(payload);
  const req = http.request({
    host: 'localhost',
    port: PORT,
    path: GSI_PATH,
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
  }, (res) => { res.resume(); });
  req.on('error', (e) => console.error('Mock send failed:', e.message));
  req.write(data);
  req.end();
}

console.log(`Mock GSI → http://localhost:${PORT}${GSI_PATH}  (Ctrl+C to stop)`);
setInterval(() => send(buildPayload()), TICK_MS);
