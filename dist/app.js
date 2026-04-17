/* Dota 2 Tracker — overlay UI.
 * Live in-game stats come from the GSI server over WebSocket (primary source);
 * the Scouting tab and AI button use the OpenDota/AI HTTP endpoints. */

const API = 'http://localhost:3001';
const WS  = 'ws://localhost:3001/ws';
const api = window.electronAPI; // undefined when opened in a plain browser (dev/test)
const $ = (id) => document.getElementById(id);

// ── Window controls + tabs ──────────────────────────────────────────────────
$('btn-settings').onclick = () => api?.openSettings();
$('btn-logs').onclick     = () => api?.openLogs();
$('btn-min').onclick      = () => api?.minimize();
$('btn-close').onclick    = () => api?.close();

document.querySelectorAll('.tab').forEach((t) => {
  t.onclick = () => {
    document.querySelectorAll('.tab').forEach((x) => x.classList.remove('tab--active'));
    t.classList.add('tab--active');
    const tab = t.dataset.tab;
    // Generic: show the pane whose id is `tab-<name>`, hide the rest. Covers
    // match / scout / ai (and any tab added later) — the old code only toggled
    // match+scout, so the AI pane never un-hid and showed up blank.
    document.querySelectorAll('.tabpane').forEach((pane) => {
      pane.classList.toggle('hidden', pane.id !== `tab-${tab}`);
    });
  };
});

// ── Name prettifiers (npc_dota_hero_x / item_x → readable) ───────────────────
function pretty(name, prefix) {
  if (!name || name === 'empty') return '';
  let s = name.startsWith(prefix) ? name.slice(prefix.length) : name;
  return s.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase()).trim();
}
const heroName = (n) => pretty(n, 'npc_dota_hero_');
const itemName = (n) => pretty(n, 'item_');
const abilityName = (n) => pretty(n, '');
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '0');

function clockStr(s) {
  if (typeof s !== 'number') return '0:00';
  const neg = s < 0, a = Math.abs(Math.floor(s));
  return `${neg ? '-' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}
const GAME_STATE = {
  DOTA_GAMERULES_STATE_HERO_SELECTION: 'Пик',
  DOTA_GAMERULES_STATE_STRATEGY_TIME: 'Стратегия',
  DOTA_GAMERULES_STATE_PRE_GAME: 'Пре-гейм',
  DOTA_GAMERULES_STATE_GAME_IN_PROGRESS: 'Игра',
  DOTA_GAMERULES_STATE_POST_GAME: 'Пост-гейм',
};
const STATUS_FLAGS = [
  ['stunned', 'Стан'], ['silenced', 'Сайленс'], ['hexed', 'Хекс'],
  ['disarmed', 'Disarm'], ['muted', 'Mute'], ['break', 'Break'],
  ['magicimmune', 'BKB'], ['smoked', 'Смок'], ['has_debuff', 'Дебафф'],
];

let lastState = null;
let meLoaded = false;

function render(s) {
  lastState = s;
  $('waiting').classList.add('hidden');
  $('live').classList.remove('hidden');

  const map = s.map || {}, p = s.player || {}, h = s.hero || {}, d = s.derived || {};
  // Scoreboard
  $('clock').textContent = clockStr(map.clock_time);
  $('radiant-score').textContent = map.radiant_score ?? 0;
  $('dire-score').textContent = map.dire_score ?? 0;
  $('game-state').textContent = GAME_STATE[map.game_state] || '—';
  $('daytime').textContent = map.daytime ? '☀' : '🌙';

  // Player
  $('kda').textContent = `${p.kills ?? 0}/${p.deaths ?? 0}/${p.assists ?? 0}`;
  $('kda-ratio').textContent = d.kda ?? '0.0';
  $('cs').textContent = p.last_hits ?? 0;
  $('denies').textContent = p.denies ?? 0;
  $('gpm').textContent = p.gpm ?? 0;
  $('xpm').textContent = p.xpm ?? 0;
  $('gold').textContent = fmt(p.gold ?? 0);
  $('networth').textContent = fmt(d.netWorth ?? p.net_worth ?? 0);
  $('hero-dmg').textContent = fmt(p.hero_damage ?? 0);
  $('tower-dmg').textContent = fmt(p.tower_damage ?? 0);

  // Hero — name + status only. HP/mana/level are intentionally NOT displayed,
  // but they stay in `lastState` and are sent to the AI assistant.
  $('hero-name').textContent = heroName(h.name) || '—';

  const row = $('hero-status');
  row.innerHTML = '';
  const active = STATUS_FLAGS.filter(([k]) => h[k]);
  if (h.alive === false) {
    $('respawn').classList.remove('hidden');
    $('respawn-sec').textContent = h.respawn_seconds ?? 0;
  } else {
    $('respawn').classList.add('hidden');
    if (!active.length) row.innerHTML = '<span class="status-tag status-tag--ok">OK</span>';
  }
  for (const [, label] of active) {
    const t = document.createElement('span');
    t.className = 'status-tag'; t.textContent = label; row.appendChild(t);
  }

  renderItems(s.items);
  renderAbilities(s.abilities);
  renderBuildings(s.buildings);
  renderMinimap(s.minimap, h.name, p.team_name);
}

// Live minimap: plot every visible object (fog-of-war respected by Dota). World
// coords run ~[-8200, 8200]; Radiant base is bottom-left, so we invert Y.
const WORLD_MIN = -8200, WORLD_RANGE = 16400;
function renderMinimap(minimap, myHeroName, myTeam) {
  const el = $('minimap');
  if (!minimap || typeof minimap !== 'object' || !Object.keys(minimap).length) {
    el.innerHTML = '<div class="mm-empty">нет данных карты —<br>перезапусти Dota (нужен обновлённый GSI-конфиг)</div>';
    return;
  }
  const myTeamNum = myTeam === 'dire' ? 3 : 2; // radiant = 2, dire = 3
  const dots = [];
  for (const key of Object.keys(minimap)) {
    const o = minimap[key];
    if (!o || typeof o.xpos !== 'number' || typeof o.ypos !== 'number') continue;
    const left = Math.max(0, Math.min(100, (o.xpos - WORLD_MIN) / WORLD_RANGE * 100));
    const top = Math.max(0, Math.min(100, (1 - (o.ypos - WORLD_MIN) / WORLD_RANGE) * 100));
    const unit = o.unitname || o.name || ''; // hero npc name is in `unitname`
    const isHero = String(unit).startsWith('npc_dota_hero_');
    let cls;
    if (isHero && unit === myHeroName) cls = 'mm-dot mm-hero mm-me';
    else if (o.team === myTeamNum) cls = isHero ? 'mm-dot mm-hero mm-ally' : 'mm-dot mm-ally';
    else if (o.team === 2 || o.team === 3) cls = isHero ? 'mm-dot mm-hero mm-enemy' : 'mm-dot mm-enemy';
    else cls = 'mm-dot mm-neutral';
    dots.push(`<i class="${cls}" style="left:${left}%;top:${top}%"></i>`);
  }
  el.innerHTML = dots.length ? dots.join('') : '<div class="mm-empty">нет данных карты —<br>перезапусти Dota (нужен обновлённый GSI-конфиг)</div>';
}

function renderItems(items) {
  const grid = $('items'); grid.innerHTML = '';
  for (let i = 0; i < 9; i++) {
    const it = items && items[`slot${i}`];
    const empty = !it || it.name === 'empty';
    const div = document.createElement('div');
    div.className = `item-slot${empty ? ' empty' : ''}`;
    if (empty) { div.textContent = '·'; }
    else {
      div.textContent = itemName(it.name);
      if (it.cooldown > 0) { const c = document.createElement('span'); c.className = 'cd'; c.textContent = `${Math.ceil(it.cooldown)}s`; div.appendChild(c); }
      if (it.charges) { const c = document.createElement('span'); c.className = 'charges'; c.textContent = it.charges; div.appendChild(c); }
    }
    grid.appendChild(div);
  }
  const n = items && items.neutral0;
  $('neutral-item').textContent = n && n.name !== 'empty' ? itemName(n.name) : '—';
}

function renderAbilities(ab) {
  const row = $('abilities'); row.innerHTML = '';
  if (!ab) return;
  Object.keys(ab).filter((k) => k.startsWith('ability')).forEach((k) => {
    const a = ab[k]; if (!a || !a.name) return;
    const div = document.createElement('div');
    div.className = `ability${a.ultimate ? ' ultimate' : ''}${a.cooldown > 0 ? ' on-cd' : ''}`;
    const nm = document.createElement('div'); nm.className = 'ability-name'; nm.textContent = abilityName(a.name); div.appendChild(nm);
    const lv = document.createElement('div'); lv.className = 'ability-level'; lv.textContent = a.passive ? `${a.level}·P` : `Lv ${a.level}`; div.appendChild(lv);
    if (a.cooldown > 0) { const c = document.createElement('span'); c.className = 'ability-cd'; c.textContent = Math.ceil(a.cooldown); div.appendChild(c); }
    row.appendChild(div);
  });
}

function towerLabel(k) { const m = k.match(/tower\d+_(\w+)/); return m ? m[1].toUpperCase() : k; }
function renderBuildings(b) {
  for (const [side, id] of [['radiant', 'radiant-buildings'], ['dire', 'dire-buildings']]) {
    const el = $(id); el.innerHTML = '';
    const g = (b && b[side]) || {};
    Object.keys(g).filter((k) => k.includes('tower1')).forEach((k) => {
      const t = g[k], pct = t.max_health ? (t.health / t.max_health) * 100 : 0, dead = t.health <= 0;
      const r = document.createElement('div'); r.className = `b-row${dead ? ' dead' : ''}`;
      r.innerHTML = `<div class="b-label"><span>${towerLabel(k)}</span><span>${dead ? '✕' : Math.round(pct) + '%'}</span></div><div class="b-bar"><div class="b-bar-fill" style="width:${pct}%"></div></div>`;
      el.appendChild(r);
    });
  }
}

// ── WebSocket (live) ─────────────────────────────────────────────────────────
// Three distinct states so "waiting" is never a black box:
//   off    — tracker server unreachable (server crashed / port busy)
//   server — connected to the server, but Dota hasn't sent any GSI yet
//   live   — GSI data is flowing
function setConn(state) {
  const el = $('conn');
  el.className = 'conn conn--' + state;
  $('conn-text').textContent = state === 'live' ? 'live' : state === 'server' ? 'жду Dota' : 'нет связи';
  // Update the waiting screen's status line to match.
  const ws = $('wait-status'), sub = $('wait-sub');
  if (!ws) return;
  if (state === 'off') {
    ws.textContent = '✕ Трекер-сервер недоступен';
    ws.className = 'wait-status ws-off';
    if (sub) sub.textContent = 'Сервер не запущен или порт 3001 занят. Открой Логи (▤) — там причина.';
  } else if (state === 'server') {
    ws.textContent = '✓ Сервер работает · ждём данные от Dota';
    ws.className = 'wait-status ws-server';
    if (sub) sub.textContent = 'Зайди в матч, бот-игру или демо героя.';
  }
}
let ws;
function connect() {
  ws = new WebSocket(WS);
  ws.onopen = () => setConn('server');
  ws.onclose = () => { setConn('off'); setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'waiting') {
      setConn('server'); // server up, no Dota data yet
    } else if (m.type === 'state') {
      setConn('live');
      render(m.payload);
      // Once a match is feeding data, the server can identify "me" — refresh it.
      if (!meLoaded) { meLoaded = true; loadMe(); }
    }
  };
}
connect();

// ── AI assistant — chat with history; server injects the live match context ──
const aiHistory = [];          // [{role:'user'|'assistant', content}]
let aiBusy = false;

// Render an AI message: escape HTML, turn **bold** into real bold, drop stray
// asterisks, keep line breaks. (`esc` is defined below; used here at runtime.)
function fmtMsg(s) {
  return esc(s)
    .replace(/\*\*(.+?)\*\*/g, '<b>$1</b>')
    .replace(/\*\*/g, '')
    .replace(/\n/g, '<br>');
}

function renderChat() {
  const box = $('ai-chat');
  if (!aiHistory.length) {
    box.innerHTML = '<div class="ai-empty">Спроси что угодно по текущему матчу — ассистент видит минуту игры, твои статы, предметы и пики. Помнит историю диалога.</div>';
    return;
  }
  box.innerHTML = aiHistory.map((m) =>
    `<div class="ai-msg ai-msg--${m.role === 'user' ? 'me' : 'bot'}">${fmtMsg(m.content)}</div>`
  ).join('') + (aiBusy ? '<div class="ai-msg ai-msg--bot ai-typing">…</div>' : '');
  box.scrollTop = box.scrollHeight;
}

async function sendAI(question) {
  if (aiBusy || !question.trim()) return;
  aiHistory.push({ role: 'user', content: question.trim() });
  aiBusy = true; renderChat();
  $('ai-input').value = '';
  try {
    const r = await fetch(`${API}/ai`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ messages: aiHistory, mode: ($('ai-mode') || {}).value || 'normal' }),
    });
    const data = await r.json();
    aiBusy = false;
    aiHistory.push({ role: 'assistant', content: r.ok ? (data.text || '—') : ('⚠ ' + (data.error || 'Ошибка запроса')) });
    renderChat();
  } catch (e) {
    aiBusy = false;
    aiHistory.push({ role: 'assistant', content: '⚠ Сервер недоступен: ' + e.message });
    renderChat();
  }
}

async function refreshAiProvider() {
  try {
    const info = await (await fetch(`${API}/ai/info`)).json();
    $('ai-prov').textContent = info.hasKey ? info.label : info.label + ' · нет ключа';
    $('ai-prov').className = 'ai-prov' + (info.hasKey ? ' ok' : ' nokey');
  } catch { $('ai-prov').textContent = '—'; }
}

$('ai-send').onclick = () => sendAI($('ai-input').value);
$('ai-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') sendAI($('ai-input').value); });
$('ai-clear').onclick = () => { aiHistory.length = 0; renderChat(); };
document.querySelectorAll('.ai-chip').forEach((c) => { c.onclick = () => sendAI(c.dataset.q); });
document.querySelector('.tab[data-tab="ai"]').addEventListener('click', refreshAiProvider);
// Remember the game-mode choice (affects AI timing advice).
try {
  const saved = localStorage.getItem('aiMode');
  if (saved) $('ai-mode').value = saved;
  $('ai-mode').onchange = () => { try { localStorage.setItem('aiMode', $('ai-mode').value); } catch {} };
} catch {}

// ── Scouting ─────────────────────────────────────────────────────────────────
const MEDALS = ['Herald','Guardian','Crusader','Archon','Legend','Ancient','Divine','Immortal'];
function rankName(t) {
  if (!t) return 'Без ранга';
  const medal = MEDALS[Math.floor(t / 10) - 1];
  if (!medal) return 'Без ранга';
  const stars = t % 10;
  return `${medal}${stars ? ' ' + stars : ''}`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

function profileHTML(p) {
  if (!p || p.error) return `<div class="muted">${esc(p?.error) || 'Профиль не найден'}</div>`;
  const wrCls = p.winrate == null ? '' : p.winrate >= 50 ? 'wr-good' : 'wr-bad';
  return `
    <div class="profile-card">
      ${p.avatar ? `<img src="${esc(p.avatar)}" alt="" />` : '<div class="profile-noavatar">🧍</div>'}
      <div class="profile-meta">
        <div class="profile-name">${esc(p.name) || '—'}</div>
        <div class="profile-sub"><span class="rank-pill">${esc(rankName(p.rank))}</span> WR <span class="${wrCls}">${p.winrate ?? '—'}%</span> <span class="muted">(${p.totalGames || 0} игр)</span></div>
        ${p.avgKDA ? `<div class="profile-sub muted">Ø KDA ${p.avgKDA.k}/${p.avgKDA.d}/${p.avgKDA.a} · GPM ${p.avgGPM} · XPM ${p.avgXPM}</div>` : ''}
      </div>
    </div>
    ${(p.topHeroes || []).length ? '<div class="mini-title">Топ герои</div>' + p.topHeroes.map((h) =>
      `<div class="top-hero"><span>${esc(h.name)}</span><span class="muted">${h.games} игр · <b class="${h.winrate >= 50 ? 'wr-good' : 'wr-bad'}">${h.winrate}%</b></span></div>`).join('') : ''}`;
}

async function loadMe() {
  const box = $('me-result');
  try {
    const r = await fetch(`${API}/me`);
    if (!r.ok) { const e = await r.json().catch(() => ({})); box.innerHTML = `<div class="muted">${esc(e.error) || 'Аккаунт ещё не определён'}</div>`; return; }
    box.innerHTML = profileHTML(await r.json());
  } catch (e) { box.innerHTML = `<div class="muted">Сервер недоступен</div>`; }
}

async function scout(q) {
  const box = $('scout-result'); box.innerHTML = '<div class="muted">Ищу…</div>';
  try {
    let id = q.trim();
    if (!/^\d+$/.test(id)) {
      const sr = await (await fetch(`${API}/search?q=${encodeURIComponent(id)}`)).json();
      if (!Array.isArray(sr) || !sr.length) { box.innerHTML = '<div class="muted">Не найдено</div>'; return; }
      id = sr[0].account_id;
    }
    const p = await (await fetch(`${API}/profile/${id}`)).json();
    box.innerHTML = profileHTML(p);
  } catch (e) { box.innerHTML = `<div class="muted">Ошибка: ${esc(e.message)}</div>`; }
}
$('scout-go').onclick = () => { const v = $('scout-input').value; if (v.trim()) scout(v); };
$('scout-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('scout-go').click(); });

// Auto-load "me" once on start, and refresh when opening the Scout tab.
loadMe();
document.querySelector('.tab[data-tab="scout"]').addEventListener('click', loadMe);
