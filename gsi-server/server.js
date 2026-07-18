// gsi-server/server.js
// Base: ReXaXeR's OpenDota/Valve scouting server.
// Merged in (from CrabotY's tracker): live GSI is now the PRIMARY data source —
// the full game-state payload is enriched and pushed to the UI over WebSocket,
// so in-game stats update several times per second (the original only polled
// external APIs that have no live data for ordinary matches).
const path = require('path');
const fs   = require('fs');

require('dotenv').config({ path: path.join(__dirname, '../.env') });
if (process.env.USER_ENV_PATH && fs.existsSync(process.env.USER_ENV_PATH)) {
  require('dotenv').config({ path: process.env.USER_ENV_PATH, override: true });
}

const express = require('express');
const http    = require('http');
const axios   = require('axios');
const { WebSocketServer } = require('ws');
const { findSteamId, steam64ToAccountId } = require('../lib/steam-id');

const app    = express();
const server = http.createServer(app);

const PORT       = Number(process.env.GSI_PORT) || 3001;
// Shared secret — must match the token in the GSI .cfg. Empty string disables
// the check (kept lax because GSI only ever talks to localhost).
const AUTH_TOKEN = process.env.GSI_AUTH_TOKEN ?? 'DOTA2_TRACKER_SECRET';

app.use(express.json({ limit: '10mb' }));
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const OPENDOTA = 'https://api.opendota.com/api';

let currentState   = null;   // full enriched GSI snapshot (live)
let playerCache    = {};
let heroesCache    = {};
let itemCostCache  = {};     // item short-name -> gold cost (from OpenDota)
let currentMatchId = null;
// Heroes seen this match (accumulated — survives fog of war). Allies are always
// on the minimap; enemies get added once spotted. Reset on a new match.
let seenHeroes = { allies: new Set(), enemies: new Set() };
let minimapEverSeen = false; // false => GSI cfg likely lacks minimap (restart Dota)

// ─── "我"是谁 — 自动识别 ─────────────────────────────────────────────
// 优先级: 实时 GSI 的 account id > 本地 Steam 登录的 SteamID.
let liveAccountId  = null;   // 来自当前比赛 (GSI)
let localAccountId = null;   // 来自 <steam>/config/loginusers.vdf
function detectLocalSteam() {
  try {
    const sid = findSteamId();
    if (sid) {
      localAccountId = steam64ToAccountId(sid);
      console.log(`[Steam] 账号已自动识别: ${localAccountId} (SteamID ${sid})`);
    } else {
      console.log('[Steam] 无法从 Steam 识别账号 — 将使用比赛数据。');
    }
  } catch (e) { console.error('[Steam] detect:', e.message); }
}
function myAccountId() { return liveAccountId || localAccountId; }

// ─── WebSocket: live push to the overlay ──────────────────────────────────────
const wss = new WebSocketServer({ server, path: '/ws' });
wss.on('error', () => {}); // don't crash on bind races
function broadcast(obj) {
  const data = JSON.stringify(obj);
  for (const c of wss.clients) if (c.readyState === 1) c.send(data);
}
wss.on('connection', (socket) => {
  socket.send(JSON.stringify(
    currentState ? { type: 'state', payload: currentState } : { type: 'waiting' }
  ));
});

// Derive the handful of stats Dota doesn't send but players expect.
function enrich(raw) {
  const out = { ...raw, derived: {} };
  const p = raw.player || {};
  const h = raw.hero || {};
  if (typeof p.kills === 'number') {
    const d = p.deaths || 0;
    out.derived.kda = d === 0
      ? (p.kills + (p.assists || 0)).toFixed(1)
      : ((p.kills + (p.assists || 0)) / d).toFixed(2);
  }
  out.derived.netWorth = computeNetWorth(raw);
  if (h && typeof h.alive === 'boolean') {
    out.derived.alive = h.alive;
    out.derived.respawnSeconds = h.respawn_seconds || 0;
  }
  out.derived.receivedAt = Date.now();
  return out;
}

// GSI does NOT send net worth, so we compute it: current gold + value of every
// carried item (inventory + backpack + stash + neutral). Item costs come from
// OpenDota. Until they load, this is just gold (same as before).
function computeNetWorth(raw) {
  const gold = (raw.player && typeof raw.player.gold === 'number') ? raw.player.gold : 0;
  let itemsValue = 0;
  const items = raw.items || {};
  for (const k of Object.keys(items)) {
    const name = items[k] && items[k].name;
    if (!name || name === 'empty') continue;
    const cost = itemCostCache[name.replace(/^item_/, '')];
    if (typeof cost === 'number') itemsValue += cost;
  }
  return gold + itemsValue;
}

async function loadItemCosts() {
  try {
    const { data } = await axios.get(`${OPENDOTA}/constants/items`, { timeout: 10000 });
    let n = 0;
    for (const key of Object.keys(data || {})) {
      const c = data[key] && data[key].cost;
      if (typeof c === 'number') { itemCostCache[key] = c; n++; }
    }
    console.log(`[OpenDota] 已加载 ${n} 件物品价格（用于净资产计算）`);
  } catch (e) {
    console.error('[OpenDota] 物品价格加载错误:', e.message);
  }
}

// ─── 英雄 ────────────────────────────────────────────────────────────
async function loadHeroes() {
  try {
    const { data } = await axios.get(`${OPENDOTA}/heroes`, { timeout: 8000 });
    data.forEach(h => { heroesCache[h.id] = h.localized_name; });
    console.log(`[OpenDota] 已加载 ${data.length} 位英雄`);
  } catch (e) {
    console.error('[OpenDota] 英雄加载错误:', e.message);
  }
}

// ─── 玩家档案 ───────────────────────────────────────────────────────────
async function fetchPlayerProfile(accountId) {
  if (!accountId || accountId === 0) return null;
  const id = Number(accountId);
  if (playerCache[id]) return playerCache[id];

  try {
    const [profile, wl, recent, heroes] = await Promise.allSettled([
      axios.get(`${OPENDOTA}/players/${id}`,             { timeout: 8000 }),
      axios.get(`${OPENDOTA}/players/${id}/wl?limit=20`, { timeout: 8000 }),
      axios.get(`${OPENDOTA}/players/${id}/recentMatches`,{ timeout: 8000 }),
      axios.get(`${OPENDOTA}/players/${id}/heroes?limit=5`,{ timeout: 8000 }),
    ]);

    const p    = profile.value?.data;
    const wlD  = wl.value?.data;
    const rec  = recent.value?.data?.slice(0, 10) || [];
    const heroList = heroes.value?.data?.slice(0, 5) || [];

    const wins  = wlD?.win  || 0;
    const losses= wlD?.lose || 0;
    const total = wins + losses;
    const wr    = total > 0 ? Math.round(wins / total * 100) : null;

    const avg = (arr, fn) => arr.length
      ? +(arr.reduce((s, x) => s + (fn(x) || 0), 0) / arr.length).toFixed(1) : 0;

    const avgKDA = rec.length ? {
      k: avg(rec, x => x.kills),
      d: avg(rec, x => x.deaths),
      a: avg(rec, x => x.assists),
    } : null;

    const avgGPM = Math.round(avg(rec, x => x.gold_per_min));
    const avgXPM = Math.round(avg(rec, x => x.xp_per_min));

    const laneRoles = rec.map(m => m.lane_role).filter(Boolean);
    const mostCommonRole = laneRoles.length
      ? [1,2,3,4,5].sort((a,b) =>
          laneRoles.filter(r=>r===b).length - laneRoles.filter(r=>r===a).length
        )[0]
      : null;

    const topHeroes = heroList.map(h => ({
      name:    heroesCache[h.hero_id] || `Hero ${h.hero_id}`,
      games:   h.games,
      winrate: h.games > 0 ? Math.round(h.win / h.games * 100) : 0,
    }));

    const result = {
      accountId: id,
      name:     p?.profile?.personaname || '匿名',
      avatar:   p?.profile?.avatarmedium || null,
      rank:     p?.rank_tier || null,
      winrate: wr, totalGames: total, wins, losses,
      avgKDA, avgGPM, avgXPM,
      mostCommonRole,
      topHeroes,
      profileUrl: `https://www.opendota.com/players/${id}`,
    };

    playerCache[id] = result;
    return result;
  } catch (e) {
    console.error(`[OpenDota] 档案 ${accountId}:`, e.message);
    return { accountId: id, name: '加载错误', winrate: null, avgKDA: null };
  }
}

// ─── 比赛 (赛后, OpenDota) ───────────────────────────────────────────────
async function fetchMatch(matchId) {
  const { data } = await axios.get(`${OPENDOTA}/matches/${matchId}`, { timeout: 15000 });
  if (!data?.players) throw new Error('比赛未找到或未被解析');

  const profiles = await Promise.all(data.players.map(p => fetchPlayerProfile(p.account_id)));

  const players = data.players.map((p, i) => ({
    account_id:   p.account_id,
    personaname:  p.personaname || '匿名',
    hero_id:      p.hero_id,
    heroName:     heroesCache[p.hero_id] || `Hero ${p.hero_id}`,
    team_number:  p.player_slot < 128 ? 0 : 1,
    player_slot:  p.player_slot,
    lane_role:    p.lane_role,
    is_roaming:   p.is_roaming,
    kills:        p.kills,
    deaths:       p.deaths,
    assists:      p.assists,
    gold_per_min: p.gold_per_min,
    xp_per_min:   p.xp_per_min,
    net_worth:    p.net_worth,
    hero_damage:  p.hero_damage,
    tower_damage: p.tower_damage,
    hero_healing: p.hero_healing,
    last_hits:    p.last_hits,
    denies:       p.denies,
    win:          data.radiant_win ? (p.player_slot < 128) : (p.player_slot >= 128),
    rank_tier:    p.rank_tier,
    profile:      profiles[i],
  }));

  return {
    match_id:    data.match_id,
    radiant_win: data.radiant_win,
    duration:    data.duration,
    game_mode:   data.game_mode,
    players,
  };
}

// ─── 通过 Valve WebAPI 获取直播比赛 (需要 STEAM_API_KEY) ───────────────────────
async function fetchLiveMatch(matchId) {
  const key = process.env.STEAM_API_KEY || '';
  if (!key) throw new Error('未设置 STEAM_API_KEY');

  const { data } = await axios.get('https://api.steampowered.com/IDOTA2Match_570/GetMatchDetails/v1/', {
    params: { match_id: matchId, key },
    timeout: 8000,
  });

  const match = data?.result;
  if (!match || match.error) throw new Error(match?.error || 'Valve API 中未找到比赛');

  const profiles = await Promise.all(
    (match.players || []).map(p => fetchPlayerProfile(p.account_id))
  );

  const players = (match.players || []).map((p, i) => ({
    account_id:   p.account_id,
    hero_id:      p.hero_id,
    heroName:     heroesCache[p.hero_id] || `Hero ${p.hero_id}`,
    team_number:  p.player_slot < 128 ? 0 : 1,
    player_slot:  p.player_slot,
    kills:        p.kills,
    deaths:       p.deaths,
    assists:      p.assists,
    gold_per_min: p.gold_per_min,
    xp_per_min:   p.xp_per_min,
    net_worth:    p.net_worth,
    hero_damage:  p.hero_damage,
    last_hits:    p.last_hits,
    denies:       p.denies,
    personaname:  profiles[i]?.name || '玩家',
    rank_tier:    profiles[i]?.rank,
    profile:      profiles[i],
  }));

  return { match_id: Number(matchId), radiant_win: match.radiant_win, duration: match.duration, game_mode: match.game_mode, live: true, players };
}

// ─── 通过 OpenDota /live 获取直播数据 (无需密钥; 仅公开直播) ────────
async function fetchLiveOpenDota(matchId) {
  const { data } = await axios.get(`${OPENDOTA}/live`, { timeout: 8000 });
  const liveMatch = data?.find(m => String(m.match_id) === String(matchId) || String(m.lobby_id) === String(matchId));
  if (!liveMatch) throw new Error('比赛未在直播中');

  const allPlayers = [
    ...(liveMatch.players || []),
    ...(liveMatch.radiant_team?.players || []),
    ...(liveMatch.dire_team?.players   || []),
  ].filter(p => p.account_id);
  if (!allPlayers.length) throw new Error('无玩家数据');

  const profiles = await Promise.all(allPlayers.map(p => fetchPlayerProfile(p.account_id)));
  const players = allPlayers.map((p, i) => ({
    account_id:   p.account_id,
    hero_id:      p.hero_id,
    heroName:     heroesCache[p.hero_id] || `Hero ${p.hero_id}`,
    team_number:  p.team === 'radiant' || p.is_radiant ? 0 : 1,
    player_slot:  i,
    kills:        p.kills || 0,
    deaths:       p.deaths || 0,
    assists:      p.assists || 0,
    gold_per_min: p.gold_per_min || 0,
    net_worth:    p.net_worth || 0,
    hero_damage:  p.hero_damage || 0,
    last_hits:    p.last_hits || 0,
    personaname:  profiles[i]?.name || '玩家',
    rank_tier:    profiles[i]?.rank,
    profile:      profiles[i],
  }));
  return { match_id: Number(matchId), radiant_win: null, duration: liveMatch.duration, live: true, players };
}

// ─── GSI endpoint — PRIMARY live source ───────────────────────────────────────
app.post('/gsi', (req, res) => {
  const body = req.body || {};
  if (AUTH_TOKEN && body.auth?.token !== AUTH_TOKEN) {
    return res.status(403).json({ error: 'invalid auth token' });
  }

  currentState = enrich(body);

  // Learn who "I" am from the live feed (works even without any Steam key).
  const pl = body.player || {};
  if (pl.accountid) liveAccountId = String(pl.accountid);
  else if (pl.steamid) liveAccountId = steam64ToAccountId(pl.steamid);

  const matchId = body.map?.matchid;
  if (matchId && matchId !== currentMatchId && matchId !== '0') {
    currentMatchId = matchId;
    playerCache = {};
    seenHeroes = { allies: new Set(), enemies: new Set() };
    console.log(`[GSI] 新比赛: ${currentMatchId}`);
  }
  accumulateSeenHeroes(body);
  // Push the full live state to every open overlay.
  broadcast({ type: 'state', payload: currentState });
  res.sendStatus(200);
});

// Remember every hero spotted on the minimap this match (fog-proof lineup).
function accumulateSeenHeroes(body) {
  const mm = body.minimap;
  if (!mm || typeof mm !== 'object') return;
  minimapEverSeen = true;
  const myTeamNum = body.player?.team_name === 'dire' ? 3 : 2;
  const myHero = body.hero?.name;
  for (const k of Object.keys(mm)) {
    const o = mm[k];
    // GSI puts the hero npc name in `unitname` (not `name`, which is a label).
    const u = o && (o.unitname || o.name);
    if (!u || !String(u).startsWith('npc_dota_hero_')) continue;
    if (u === myHero) continue;
    const hn = prettyName(u, /^npc_dota_hero_/);
    if (o.team === myTeamNum) seenHeroes.allies.add(hn);
    else if (o.team === 2 || o.team === 3) seenHeroes.enemies.add(hn);
  }
}

app.get('/state',   (req, res) => res.json(currentState || { gameState: 'WAITING' }));
app.get('/health',  (req, res) => res.json({ ok: true, matchId: currentMatchId, browsers: wss.clients.size, me: myAccountId(), minimap: minimapEverSeen }));

// "我" — 自动识别的当前玩家档案 (无需手动输入)。
app.get('/me', async (req, res) => {
  const id = myAccountId();
  if (!id) return res.status(404).json({ error: '账号尚未识别 — 请进入比赛或打开 Steam。' });
  const profile = await fetchPlayerProfile(id);
  if (!profile) return res.status(404).json({ error: '未找到档案' });
  res.json({ ...profile, source: liveAccountId ? 'gsi' : 'steam' });
});

app.get('/profile/:id', async (req, res) => {
  const raw = req.params.id;
  const id = raw.length > 12 ? String(BigInt(raw) - BigInt('76561197960265728')) : raw;
  const profile = await fetchPlayerProfile(id);
  res.json(profile || { error: '未找到' });
});

app.get('/live/:matchId', async (req, res) => {
  const matchId = req.params.matchId;
  console.log(`[Live] 请求比赛 ${matchId} 的直播数据`);
  if (process.env.STEAM_API_KEY) {
    try { return res.json(await fetchLiveMatch(matchId)); }
    catch (e) { console.log(`[Live] Valve API: ${e.message}，尝试 OpenDota 直播...`); }
  }
  try { return res.json(await fetchLiveOpenDota(matchId)); }
  catch (e) { console.log(`[Live] OpenDota live: ${e.message}`); }

  // 回退 — 你来自实时 GSI 的玩家数据 (始终可用)。
  if (currentState?.player?.steamid) {
    try {
      const accountId = String(BigInt(currentState.player.steamid) - BigInt('76561197960265728'));
      const profile = await fetchPlayerProfile(accountId);
      return res.json({
        match_id: Number(matchId), live: true, partial: true,
        players: [{
          account_id: Number(accountId), personaname: profile?.name || '你',
          heroName: heroesCache[currentState.hero?.id] || currentState.hero?.name || '—',
          hero_id: currentState.hero?.id, team_number: 0, player_slot: 0,
          kills: currentState.player.kills || 0, deaths: currentState.player.deaths || 0,
          assists: currentState.player.assists || 0, gold_per_min: currentState.player.gpm || 0,
          net_worth: currentState.player.net_worth || 0, hero_damage: currentState.player.hero_damage || 0,
          last_hits: currentState.player.last_hits || 0, profile,
        }],
      });
    } catch (e) { console.error('[Live] 回退:', e.message); }
  }
  res.status(404).json({ error: '直播数据不可用 — 比赛未公开直播' });
});

app.get('/match/:matchId', async (req, res) => {
  try { res.json(await fetchMatch(req.params.matchId)); }
  catch (e) { console.error('[Match]', e.message); res.status(404).json({ error: e.message }); }
});

app.get('/search', async (req, res) => {
  const q = req.query.q;
  if (!q) return res.status(400).json({ error: '缺少查询参数 q' });
  try {
    if (/^\d+$/.test(q.trim())) {
      const p = await fetchPlayerProfile(q.trim());
      return res.json(p ? [{ account_id: p.accountId, personaname: p.name, avatar: p.avatar }] : []);
    }
    const { data } = await axios.get(`${OPENDOTA}/search?q=${encodeURIComponent(q)}`, { timeout: 8000 });
    res.json(data.slice(0, 8));
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── AI 助手 (提供商选择, 带历史的聊天) ──────────────────────────────
// 密钥和提供商选择存储在本地 userData/.env — 永远不进入仓库。
// 每次请求重新读取 .env，这样新密钥无需重启即可生效。
function userEnv() {
  const merged = { ...process.env };
  try {
    const p = process.env.USER_ENV_PATH;
    if (p && fs.existsSync(p)) Object.assign(merged, require('dotenv').parse(fs.readFileSync(p)));
  } catch { /* ignore */ }
  return merged;
}

const AI_PROVIDERS = {
  openai:   { label: 'ChatGPT (OpenAI)', envKey: 'OPENAI_API_KEY' },
  gemini:   { label: 'Google Gemini',    envKey: 'GEMINI_API_KEY' },
  deepseek: { label: 'DeepSeek',         envKey: 'DEEPSEEK_API_KEY' },
};

const prettyName = (n, pre) => (n && n !== 'empty' ? n.replace(pre, '').replace(/_/g, ' ') : null);

// Picks + bans per team from the GSI draft block (when present — populated in
// ranked/draft modes during hero selection).
function parseDraft(draft) {
  const out = { radiant: { picks: [], bans: [] }, dire: { picks: [], bans: [] } };
  if (!draft || typeof draft !== 'object') return out;
  const teamOf = { team2: 'radiant', radiant: 'radiant', team3: 'dire', dire: 'dire' };
  for (const k of Object.keys(draft)) {
    const team = teamOf[k];
    const sub = draft[k];
    if (!team || !sub || typeof sub !== 'object') continue;
    for (const f of Object.keys(sub)) {
      const pick = /^pick\d+_id$/.test(f);
      const ban = /^ban\d+_id$/.test(f);
      if ((pick || ban) && sub[f] && heroesCache[sub[f]]) {
        out[team][pick ? 'picks' : 'bans'].push(heroesCache[sub[f]]);
      }
    }
  }
  return out;
}

// Build a rich, live context block for the AI from the current GSI snapshot.
function buildAIContext() {
  const s = currentState;
  if (!s) return '当前没有比赛进行中 — 无 GSI 实时数据。';
  const map = s.map || {}, p = s.player || {}, h = s.hero || {}, d = s.derived || {};
  const min = Math.floor((map.clock_time || 0) / 60);
  const items = [];
  for (let i = 0; i < 9; i++) {
    const it = (s.items || {})[`slot${i}`];
    if (!it || !it.name || it.name === 'empty') continue;
    const nm = prettyName(it.name, /^item_/);
    items.push(it.cooldown > 0 ? `${nm} (CD ${Math.ceil(it.cooldown)}秒)` : nm);
  }
  const neutral = prettyName((s.items || {}).neutral0?.name, /^item_/);
  // Abilities with cooldown/ready + ultimate flag; talents pulled out separately.
  const abilities = [], talents = [];
  for (const k of Object.keys(s.abilities || {})) {
    const a = s.abilities[k];
    if (!a || !a.name) continue;
    if (a.name.startsWith('special_bonus_')) {
      if (a.level > 0) talents.push(a.name.replace(/^special_bonus_/, '').replace(/_/g, ' '));
      continue;
    }
    if (!k.startsWith('ability')) continue;
    const cd = a.cooldown > 0 ? `CD ${Math.ceil(a.cooldown)}秒` : (a.passive ? '被动' : '就绪');
    abilities.push(`${a.name.replace(/_/g, ' ')}${a.ultimate ? ' [ULT]' : ''} (等级${a.level}, ${cd})`);
  }
  const t = parseDraft(s.draft);
  // Currently-visible enemies (this snapshot) + the accumulated match lineup.
  const mm = s.minimap || {};
  const myTeamNum = p.team_name === 'dire' ? 3 : 2;
  const visibleEnemies = [];
  for (const k of Object.keys(mm)) {
    const o = mm[k];
    const u = o && (o.unitname || o.name); // hero npc name lives in `unitname`
    if (!u || !String(u).startsWith('npc_dota_hero_')) continue;
    if (o.team !== myTeamNum && (o.team === 2 || o.team === 3)) {
      const hn = prettyName(u, /^npc_dota_hero_/);
      if (!visibleEnemies.includes(hn)) visibleEnemies.push(hn);
    }
  }
  const alliesAll = [...seenHeroes.allies];   // teammates (always on minimap)
  const enemiesAll = [...seenHeroes.enemies]; // every enemy spotted so far
  const noMapData = !minimapEverSeen;
  const gs = map.game_state || '';
  const isPick = /HERO_SELECTION|CUSTOM_GAME_SETUP/.test(gs); // 正在选人
  const isPregame = /STRATEGY_TIME|PRE_GAME/.test(gs);        // 英雄已选, 出门/购买
  const myTeam = p.team_name || (myTeamNum === 3 ? 'dire' : 'radiant');
  const heroName_ = prettyName(h.name, /^npc_dota_hero_/);
  const draftLine = (t.radiant.picks.length || t.dire.picks.length || t.radiant.bans.length || t.dire.bans.length)
    ? `选人 — 天辉: ${t.radiant.picks.join(', ') || '—'}; 夜魇: ${t.dire.picks.join(', ') || '—'}.`
      + ` 禁用 — 天辉: ${t.radiant.bans.join(', ') || '—'}; 夜魇: ${t.dire.bans.join(', ') || '—'}.`
    : null;

  // 死亡/买活/状态/神杖 — 用于死亡统计和整体状态。
  const statusFlags = [['stunned','眩晕'],['silenced','沉默'],['hexed','妖术'],['smoked','诡计'],
    ['disarmed','缴械'],['magicimmune','免疫'],['break','破坏']].filter(([k]) => h[k]).map(([, l]) => l);
  const deadInfo = h.alive === false
    ? `已死亡 (复活 ${h.respawn_seconds ?? '?'}秒)`
    : '存活';
  const bb = (typeof h.buyback_cost === 'number' && h.buyback_cost > 0)
    ? `; 买活 ${h.buyback_cost}金 ${h.buyback_cooldown ? `(CD ${h.buyback_cooldown}秒)` : '(就绪)'}` : '';
  const aghs = [h.aghanims_scepter && '阿哈利姆', h.aghanims_shard && '魔晶'].filter(Boolean).join('+');
  const heroLine = `我的英雄: ${heroName_ || '?'} (${myTeam}), 等级 ${h.level ?? '?'}, HP ${h.health ?? '?'}/${h.max_health ?? '?'}, 魔力 ${h.mana ?? '?'}/${h.max_mana ?? '?'}, ${deadInfo}${bb}${aghs ? `, ${aghs}` : ''}${statusFlags.length ? `, 效果: ${statusFlags.join(', ')}` : ''}.`;
  const statsLine = `我的数据: KDA ${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}${p.kill_streak ? ` (连杀 ${p.kill_streak})` : ''}, 正补 ${p.last_hits ?? 0}, 反补 ${p.denies ?? 0}, GPM ${p.gpm ?? 0}, XPM ${p.xpm ?? 0}, 金币 ${p.gold ?? 0}, 净资产 ${d.netWorth ?? p.net_worth ?? 0}.`;
  const talentsLine = talents.length ? `已选天赋: ${talents.join('; ')}.` : null;

  // Buildings: towers + racks + ancient HP (push/defend context).
  const countDown = (side, re) => { const g = (s.buildings || {})[side] || {}; let down = 0, total = 0;
    for (const k of Object.keys(g)) if (re.test(k)) { total++; if ((g[k].health || 0) <= 0) down++; } return `${down}/${total}`; };
  const ancientHp = (side) => { const g = (s.buildings || {})[side] || {};
    for (const k of Object.keys(g)) if (/fort|ancient/.test(k)) return g[k].max_health ? Math.round((g[k].health / g[k].max_health) * 100) : null;
    return null; };
  const towersLine = s.buildings ? `防御塔被摧毁 — 天辉 ${countDown('radiant', /tower/)}, 夜魇 ${countDown('dire', /tower/)}.` : null;
  const racksLine = s.buildings ? `兵营被摧毁 — 天辉 ${countDown('radiant', /rax/)}, 夜魇 ${countDown('dire', /rax/)}.` : null;
  const ancientLine = (s.buildings && (ancientHp('radiant') !== null || ancientHp('dire') !== null))
    ? `遗迹血量 — 天辉 ${ancientHp('radiant') ?? '?'}%, 夜魇 ${ancientHp('dire') ?? '?'}%.` : null;

  // My position → rough lane / side, from the minimap.
  let posLine = null;
  for (const k of Object.keys(mm)) {
    const o = mm[k];
    if (o && (o.unitname || o.name) === h.name && typeof o.xpos === 'number' && typeof o.ypos === 'number') {
      const nx = (o.xpos + 8200) / 16400, ny = (o.ypos + 8200) / 16400, sum = nx + ny;
      const lane = Math.abs(nx - ny) < 0.18 ? '中路' : (ny > nx ? '上路' : '下路');
      const ownLow = myTeam !== 'dire';
      const side = (ownLow ? sum < 0.85 : sum > 1.15) ? '在己方半区'
        : (ownLow ? sum > 1.15 : sum < 0.85) ? '在敌方半区' : '在地图中央';
      posLine = `我的位置: 大约在${lane}, ${side}.`;
      break;
    }
  }

  // Roshan timer (only if this GSI version provides it).
  const roshLine = (map.roshan_state || typeof map.roshan_state_end_seconds === 'number')
    ? `肉山: ${map.roshan_state === 'alive' ? '存活' : map.roshan_state === 'dead'
        ? `已死亡, 复活约 ${map.roshan_state_end_seconds ?? '?'}秒` : map.roshan_state}.` : null;

  // Economy detail + death economy (fields present only in some GSI versions).
  const ecoBits = [];
  if (typeof p.gold_reliable === 'number') ecoBits.push(`稳定 ${p.gold_reliable}`);
  if (typeof p.gold_unreliable === 'number') ecoBits.push(`非稳定 ${p.gold_unreliable}`);
  if (typeof p.gold_lost_to_death === 'number') ecoBits.push(`死亡损失 ${p.gold_lost_to_death}`);
  if (typeof p.gold_spent_on_buybacks === 'number') ecoBits.push(`买活消耗 ${p.gold_spent_on_buybacks}`);
  const ecoLine = ecoBits.length ? `经济: ${ecoBits.join(', ')}.` : null;

  // Wards / runes / camps.
  const visionBits = [];
  if (typeof p.wards_purchased === 'number') visionBits.push(`购买眼 ${p.wards_purchased}`);
  if (typeof p.wards_placed === 'number') visionBits.push(`放置 ${p.wards_placed}`);
  if (typeof p.wards_destroyed === 'number') visionBits.push(`排眼 ${p.wards_destroyed}`);
  if (typeof p.runes_activated === 'number') visionBits.push(`符点收集 ${p.runes_activated}`);
  if (typeof p.camps_stacked === 'number') visionBits.push(`拉野 ${p.camps_stacked}`);
  const visionLine = visionBits.length ? `视野/发育: ${visionBits.join(', ')}.` : null;

  // Enemy wards currently visible on the minimap.
  let enemyWards = 0;
  for (const k of Object.keys(mm)) { const o = mm[k];
    if (o && /ward/i.test(o.image || '') && (o.team === 2 || o.team === 3) && o.team !== myTeamNum) enemyWards++; }
  const enemyWardLine = enemyWards ? `地图上可见敌方守卫: ${enemyWards}.` : null;

  const teamLines = [
    draftLine,
    alliesAll.length ? `我方阵容 (队友): ${alliesAll.join(', ')}.` : null,
    enemiesAll.length ? `敌人 (本局已发现): ${enemiesAll.join(', ')}.` : null,
    visibleEnemies.length ? `当前地图上可见敌人: ${visibleEnemies.join(', ')}.` : null,
    noMapData ? '注意: 小地图数据尚未收到 — 阵容将随视野逐步更新。如果玩家提到敌方英雄，请给出相应建议。' : null,
  ];

  let lines;
  if (isPick) {
    lines = [
      `>>> 正在进行英雄选择（BP阶段）。我方阵营: ${myTeam}. 帮忙选人: 反制对方阵容、与队友配合、哪个位置还没人、该禁谁。 <<<`,
      draftLine || 'BP数据暂不可见（可能是全选模式）— 根据我提到的英雄和当前版本给出建议。',
      heroName_ ? `我已选择: ${heroName_}.` : '我还没有选择英雄。',
      ...teamLines.filter(x => x && x !== draftLine),
    ];
  } else if (isPregame) {
    lines = [
      `>>> ${/STRATEGY/.test(gs) ? '购买初始装备阶段' : '准备阶段（出门）'} — 英雄已选择 (${heroName_ || '?'}). 建议出门装备、技能加点和对线策略，不要讨论选人。 <<<`,
      heroLine,
      `我的初始物品: ${items.length ? items.join(', ') : '暂无'}.`,
      abilities.length ? `我的技能: ${abilities.join(', ')}.` : null,
      ...teamLines,
    ];
  } else {
    lines = [
      `第 ${min} 分钟 (时钟 ${map.clock_time || 0}秒), 阶段 ${gs || '?'}, ${map.daytime ? '白天' : '夜晚'}.`,
      `比分 (击杀): 天辉 ${map.radiant_score ?? '?'}—${map.dire_score ?? '?'} 夜魇.`,
      heroLine,
      posLine,
      statsLine,
      ecoLine,
      `我的物品: ${items.length ? items.join(', ') : '无'}${neutral ? `; 中立: ${neutral}` : ''}.`,
      abilities.length ? `我的技能: ${abilities.join(', ')}.` : null,
      talentsLine,
      towersLine,
      racksLine,
      ancientLine,
      roshLine,
      visionLine,
      enemyWardLine,
      ...teamLines,
    ];
  }
  return lines.filter(Boolean).join('\n');
}

const SYSTEM_PROMPT =
  '你是一位经验丰富的 Dota 2 教练。用中文回答，自信、具体、简洁：' +
  '列表形式，带表情。考虑比赛的全部上下文：分钟数、我的数据和经济、' +
  '物品及其冷却、技能冷却和大招就绪状态、我的天赋、' +
  '我的地图位置、防御塔/兵营/遗迹状态、肉山、BP和阵容。对于' +
  '"打还是撤"的决策，依据大招/物品就绪状态和位置来判断。' +
  '关于反制选择和装备，给出具体的物品/天赋并简要说明原因。' +
  '重要：如果问题或BP中提到了敌方英雄 — 立即针对该英雄给出明确的' +
  'Dota知识建议（物品、时间节奏、打法）。不要说没有' +
  '对手信息、不要道歉、不要无必要地要求澄清 —' +
  '直接给出最佳实战建议。' +
  '如果上下文显示正在进行英雄选择（BP）— 给出选人建议：' +
  '推荐2-3个具体英雄作为反制对方阵容的选择，' +
  '考虑与队友的配合，提示哪个位置/角色应该补充，以及该禁谁，' +
  '简要说明原因。记住对话历史。' +
  '敌人装备的实时数据不可用（Dota不提供）。' +
  '如果询问敌方出装/构建 — 根据英雄和' +
  '游戏时间估算典型出装（该时间点的常见路线），并注明这是估算；' +
  '不要拒绝回答。' +
  '理解并使用中文 Dota 术语：中路/大哥(1)/二号位(2)/三号位(3)/' +
  '辅助(4-5)/位置1-5, 对线, 正补/反补, 小兵, 神符, 肉山/不朽,' +
  '团战/打架, 抓人, 推塔/防守, 保人, 开局, IMBA, 削弱, 克制, 刷钱/' +
  '刷, 净资产, BKB, 跳刀, A杖/阿哈利姆, 妖术, 圣剑, 支配头盔, MKB,' +
  '黯灭, 狂战斧, 雷锤, 分身斧, 撒旦, 回血, 眩晕, 卖/送, 喂/送人头,' +
  '撕裂, 抢, 诡计, 守卫/视野, 鞋子。' +
  '用同样随意但务实的风格回答。' +
  '不要使用 markdown 格式：不用 ** **, ##, -- — 只用纯文本、' +
  '表情和换行。';

// Provider dispatch. `history` = [{role:'user'|'assistant', content}], newest last.
async function callProvider(provider, key, system, history) {
  if (provider === 'gemini') {
    const contents = history.map(m => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }));
    const { data } = await axios.post(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${encodeURIComponent(key)}`,
      { systemInstruction: { parts: [{ text: system }] }, contents,
        generationConfig: { maxOutputTokens: 800, temperature: 0.6 } },
      { headers: { 'Content-Type': 'application/json' }, timeout: 30000 });
    return data.candidates?.[0]?.content?.parts?.map(p => p.text).join('') || '—';
  }
  // OpenAI & DeepSeek share the OpenAI chat-completions format.
  const url = provider === 'deepseek'
    ? 'https://api.deepseek.com/chat/completions'
    : 'https://api.openai.com/v1/chat/completions';
  const model = provider === 'deepseek' ? 'deepseek-chat' : 'gpt-4o-mini';
  const { data } = await axios.post(url, {
    model, max_tokens: 800, temperature: 0.6,
    messages: [{ role: 'system', content: system }, ...history],
  }, { headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` }, timeout: 30000 });
  return data.choices?.[0]?.message?.content?.trim() || '—';
}

// Which provider is active + whether its key is set (for the UI badge).
app.get('/ai/info', (req, res) => {
  const env = userEnv();
  const provider = AI_PROVIDERS[env.AI_PROVIDER] ? env.AI_PROVIDER : 'openai';
  res.json({ provider, label: AI_PROVIDERS[provider].label, hasKey: !!env[AI_PROVIDERS[provider].envKey] });
});

// Turbo changes pacing a lot, so the AI must know to shift its timings.
const TURBO_NOTE =
  '游戏模式: 加速模式。经济约2倍（金币和经验更快），装备大约提前一倍时间做出，' +
  '买活更便宜且冷却更快，复活时间更短，防御塔更弱，信使免费且快速。给出建议时' +
  '请考虑加速模式的影响：更早的装备节奏和强势期，打法更激进。' +
  'GPM 600-1200+ 在此模式下是正常的 — 不要将其视为优势指标。';

// Chat endpoint. Body: { messages: [{role,content}...], mode: 'normal'|'turbo' }.
app.post('/ai', async (req, res) => {
  const mode = req.body?.mode === 'turbo' ? 'turbo' : 'normal';
  const messages = Array.isArray(req.body?.messages) ? req.body.messages : null;
  if (!messages || !messages.length) {
    // Backward-compat: single question.
    if (req.body?.question) return aiRespond(res, [{ role: 'user', content: String(req.body.question) }], mode);
    return res.status(400).json({ error: '空请求' });
  }
  return aiRespond(res, messages.slice(-20), mode); // keep last 20 turns of history
});

async function aiRespond(res, history, mode) {
  const env = userEnv();
  const provider = AI_PROVIDERS[env.AI_PROVIDER] ? env.AI_PROVIDER : 'openai';
  const key = env[AI_PROVIDERS[provider].envKey];
  if (!key) {
    return res.status(503).json({ error: `未设置「${AI_PROVIDERS[provider].label}」密钥 — 请在设置 ⚙ 中添加。` });
  }
  const turbo = mode === 'turbo' ? `\n\n${TURBO_NOTE}` : '';
  const system = `${SYSTEM_PROMPT}${turbo}\n\n比赛上下文 (最新):\n${buildAIContext()}`;
  try {
    const text = await callProvider(provider, key, system,
      history.map(m => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content || '') })));
    res.json({ text, provider });
  } catch (e) {
    res.status(500).json({ error: e.response?.data?.error?.message || e.message });
  }
}

server.on('error', (err) => {
  if (err.code === 'EADDRINUSE') {
    console.error(`[FATAL] 端口 ${PORT} 被占用 — 可能已有另一个 Dota 2 Tracker ` +
      `（或旧版本）在运行。请在托盘中关闭后重启。服务器未启动。`);
  } else {
    console.error('[FATAL] 服务器启动失败:', err.message);
  }
  process.exit(1);
});

server.listen(PORT, () => {
  console.log('');
  console.log('╔═══════════════════════════════════════╗');
  console.log('║  Dota 2 Tracker — GSI + OpenDota 服务器 ║');
  console.log(`║  http://localhost:${PORT}  (live via /ws) ║`);
  console.log('╚═══════════════════════════════════════╝');
  console.log('');
  loadHeroes();
  loadItemCosts();
  detectLocalSteam();
});

module.exports = {};
