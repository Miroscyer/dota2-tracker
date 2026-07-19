/* 大话游戏 | DOTA2助手 — overlay UI.
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
// 物品名称: 支持传入对象(含name_zh)或字符串
function itemName(it) {
  if (typeof it === 'object' && it?.name_zh) return it.name_zh;
  const n = typeof it === 'object' ? it?.name : it;
  return pretty(n || '', 'item_');
}
// 英雄名称: 支持传入对象(含name_zh)或字符串
function heroName(h) {
  if (typeof h === 'object' && h?.name_zh) return h.name_zh;
  const n = typeof h === 'object' ? h?.name : h;
  return pretty(n || '', 'npc_dota_hero_');
}
const abilityName = (n) => pretty(n, '');
const fmt = (n) => (typeof n === 'number' ? n.toLocaleString('en-US') : '0');

function clockStr(s) {
  if (typeof s !== 'number') return '0:00';
  const neg = s < 0, a = Math.abs(Math.floor(s));
  return `${neg ? '-' : ''}${Math.floor(a / 60)}:${String(a % 60).padStart(2, '0')}`;
}
const GAME_STATE = {
  DOTA_GAMERULES_STATE_HERO_SELECTION: '选人',
  DOTA_GAMERULES_STATE_STRATEGY_TIME: '策略',
  DOTA_GAMERULES_STATE_PRE_GAME: '准备',
  DOTA_GAMERULES_STATE_GAME_IN_PROGRESS: '游戏中',
  DOTA_GAMERULES_STATE_POST_GAME: '结算',
};
const STATUS_FLAGS = [
  ['stunned', '眩晕'], ['silenced', '沉默'], ['hexed', '妖术'],
  ['disarmed', '缴械'], ['muted', '禁言'], ['break', '破坏'],
  ['magicimmune', 'BKB'], ['smoked', '诡计'], ['has_debuff', '减益'],
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
  $('hero-name').textContent = heroName(h) || '—';

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
    el.innerHTML = '<div class="mm-empty">暂无小地图数据 —<br>请重启 Dota（需要更新的 GSI 配置）</div>';
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
    el.innerHTML = dots.length ? dots.join('') : '<div class="mm-empty">暂无小地图数据 —<br>请重启 Dota（需要更新的 GSI 配置）</div>';
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
      div.textContent = itemName(it);
      if (it.cooldown > 0) { const c = document.createElement('span'); c.className = 'cd'; c.textContent = `${Math.ceil(it.cooldown)}s`; div.appendChild(c); }
      if (it.charges) { const c = document.createElement('span'); c.className = 'charges'; c.textContent = it.charges; div.appendChild(c); }
    }
    grid.appendChild(div);
  }
  const n = items && items.neutral0;
  $('neutral-item').textContent = n && n.name !== 'empty' ? itemName(n) : '—';
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
  $('conn-text').textContent = state === 'live' ? 'live' : state === 'server' ? '等待 DOTA2' : '无连接';
  // Update the waiting screen's status line to match.
  const ws = $('wait-status'), sub = $('wait-sub');
  if (!ws) return;
  if (state === 'off') {
    ws.textContent = '✕ 追踪器服务器不可用';
    ws.className = 'wait-status ws-off';
    if (sub) sub.textContent = '服务器未启动或端口 3001 被占用。打开日志 (▤) 查看原因。';
  } else if (state === 'server') {
    ws.textContent = '✓ 服务器运行中 · 等待 DOTA2 数据';
    ws.className = 'wait-status ws-server';
    if (sub) sub.textContent = '进入比赛、机器人游戏或英雄试玩。';
  }
}
let ws;
let lastLiveMatchId = null;
function connect() {
  ws = new WebSocket(WS);
  ws.onopen = () => setConn('server');
  ws.onclose = () => { setConn('off'); setTimeout(connect, 1500); };
  ws.onerror = () => ws.close();
  ws.onmessage = (ev) => {
    let m; try { m = JSON.parse(ev.data); } catch { return; }
    if (m.type === 'waiting') {
      setConn('server'); // server up, no Dota data yet
      $('live-players-card').classList.add('hidden');
      lastLiveMatchId = null;
    } else if (m.type === 'state') {
      setConn('live');
      render(m.payload);
      // Once a match is feeding data, the server can identify "me" — refresh it.
      if (!meLoaded) { meLoaded = true; loadMe(); }
      // 比赛ID变化时加载当前对局玩家
      const matchId = m.payload?.map?.matchid;
      if (matchId && matchId !== '0') {
        if (matchId !== lastLiveMatchId) {
          lastLiveMatchId = matchId;
          loadLivePlayers(matchId);
        }
      } else {
        $('live-players-card').classList.add('hidden');
        lastLiveMatchId = null;
      }
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
    box.innerHTML = '<div class="ai-empty">询问当前比赛的任何问题 — 助手可以看到游戏时间、你的数据、物品和选人。支持对话历史记忆。</div>';
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
    aiHistory.push({ role: 'assistant', content: r.ok ? (data.text || '—') : ('⚠ ' + (data.error || '请求错误')) });
    renderChat();
  } catch (e) {
    aiBusy = false;
    aiHistory.push({ role: 'assistant', content: '⚠ 服务器不可用: ' + e.message });
    renderChat();
  }
}

async function refreshAiProvider() {
  try {
    const info = await (await fetch(`${API}/ai/info`)).json();
    $('ai-prov').textContent = info.hasKey ? info.label : info.label + ' · 无密钥';
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
const MEDALS = ['先锋','卫士','中军','统帅','传奇','万古流芳','超凡入圣','冠绝一世'];
function rankName(t) {
  if (!t) return '无段位';
  const medal = MEDALS[Math.floor(t / 10) - 1];
  if (!medal) return '无段位';
  const stars = t % 10;
  return `${medal}${stars ? ' ' + stars + '星' : ''}`;
}
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const GAME_MODES = { 0:'未知',1:'全选',2:'队长模式',3:'随机征召',4:'单一征召',5:'全随机',7:'冥魂之夜',12:'最少玩',16:'队长征召',18:'技能征召',20:'全随机死斗',21:'1v1中单',22:'全征召',23:'加速' };
const LANE_ROLES = { 1:'优势路(1)',2:'中路(2)',3:'劣势路(3)',4:'优势路辅助(4)',5:'劣势路辅助(5)' };
const modeName = (m) => GAME_MODES[m] || '其他';
const laneName = (l) => LANE_ROLES[l] || '—';
const durStr = (s) => s ? `${Math.floor(s/60)}:${String(s%60).padStart(2,'0')}` : '—';
const timeStr = (ts) => { try { return new Date(ts*1000).toLocaleDateString('zh-CN'); } catch { return '—'; } };

// 缓存已加载的档案 (用于子标签切换回概览)
const profileCache = new Map();

// ── 档案渲染 (含子标签) ──────────────────────────────────────────────────────
function profileHTML(p) {
  if (!p || p.error) return `<div class="muted">${esc(p?.error) || '未找到档案'}</div>`;
  profileCache.set(String(p.accountId), p);
  const wrCls = p.winrate == null ? '' : p.winrate >= 50 ? 'wr-good' : 'wr-bad';
  return `<div class="profile-wrap" data-aid="${esc(p.accountId)}">
    <div class="profile-card">
      ${p.avatar ? `<img src="${esc(p.avatar)}" alt="" />` : '<div class="profile-noavatar">🧍</div>'}
      <div class="profile-meta">
        <div class="profile-name">${esc(p.name) || '—'}</div>
        <div class="profile-sub"><span class="rank-pill">${esc(rankName(p.rank))}</span> 胜率 <span class="${wrCls}">${p.winrate ?? '—'}%</span> <span class="muted">(${p.totalGames || 0} 局)</span></div>
        ${p.avgKDA ? `<div class="profile-sub muted">Ø KDA ${p.avgKDA.k}/${p.avgKDA.d}/${p.avgKDA.a} · GPM ${p.avgGPM} · XPM ${p.avgXPM}</div>` : ''}
      </div>
      <button class="ai-analyze-btn" data-aid="${esc(p.accountId)}" title="AI 玩家画像分析">🤖 分析</button>
    </div>
    <div class="ai-analyze-result hidden"></div>
    <div class="sub-tabs">
      <button class="sub-tab sub-tab--active" data-subtab="overview">概览</button>
      <button class="sub-tab" data-subtab="recent">比赛</button>
      <button class="sub-tab" data-subtab="peers">队友</button>
      <button class="sub-tab" data-subtab="heroes">英雄</button>
      <button class="sub-tab" data-subtab="rankings">排名</button>
      <button class="sub-tab" data-subtab="stats">统计</button>
    </div>
    <div class="sub-content">${renderOverview(p)}</div>
  </div>`;
}

// ── 子标签内容渲染器 ─────────────────────────────────────────────────────────
function renderOverview(p) {
  let html = '';
  // 胜率趋势 (从常用英雄推断 — 简单展示)
  if (p.topHeroes && p.topHeroes.length) {
    html += '<div class="mini-title">常用英雄</div>';
    html += p.topHeroes.map(h =>
      `<div class="top-hero"><span>${esc(h.name)}</span><span class="muted">${h.games} 局 · <b class="${h.winrate >= 50 ? 'wr-good' : 'wr-bad'}">${h.winrate}%</b></span></div>`
    ).join('');
  }
  if (p.mostCommonRole) {
    html += `<div class="mini-title">常玩位置</div><div class="top-hero"><span>${laneName(p.mostCommonRole)}</span></div>`;
  }
  return html || '<div class="muted">暂无数据</div>';
}

function renderRecentMatches(matches) {
  if (!Array.isArray(matches) || !matches.length) return '<div class="muted">暂无比赛记录</div>';
  // 胜率趋势条
  const trend = matches.slice(0, 20).reverse().map(m =>
    `<div class="trend-cell ${m.win ? 'win' : 'loss'}" title="${esc(m.heroName)} ${m.win ? '胜' : '负'}"></div>`
  ).join('');
  const wins = matches.filter(m => m.win).length;
  const wr = Math.round(wins / matches.length * 100);
  return `<div class="trend-row"><span class="muted">近${matches.length}场</span><div class="trend-bar">${trend}</div><b class="${wr >= 50 ? 'wr-good' : 'wr-bad'}">${wr}%</b></div>`
    + matches.map(m => `
    <div class="match-row ${m.win ? 'win' : 'loss'}">
      <div class="match-hero">${esc(m.heroName)}</div>
      <div class="match-stats">
        <span class="match-result">${m.win ? '胜' : '负'}</span>
        <span class="muted">${modeName(m.game_mode)} · ${durStr(m.duration)}</span>
      </div>
      <div class="match-kda">
        <b>${m.kills}/${m.deaths}/${m.assists}</b>
        <span class="muted">${m.gpm} GPM</span>
      </div>
    </div>`).join('');
}

function renderPeers(peers) {
  if (!Array.isArray(peers) || !peers.length) return '<div class="muted">暂无队友数据</div>';
  return peers.map(p => `
    <div class="peer-row" data-id="${p.account_id}">
      <div class="peer-name">${esc(p.personaname)}</div>
      <div class="peer-stats">
        <span class="muted">${p.games} 局</span>
        <b class="${p.winrate >= 50 ? 'wr-good' : 'wr-bad'}">${p.winrate}%</b>
      </div>
    </div>`).join('');
}

function renderHeroesFull(heroes) {
  if (!Array.isArray(heroes) || !heroes.length) return '<div class="muted">暂无英雄数据</div>';
  return heroes.map(h => `
    <div class="hero-stat-row">
      <div class="hero-stat-name">${esc(h.heroName)}</div>
      <div class="hero-stat-games">${h.games}场</div>
      <div class="hero-stat-wr ${h.winrate >= 50 ? 'wr-good' : 'wr-bad'}">${h.winrate}%</div>
      <div class="hero-stat-bar"><div class="hero-stat-bar-fill" style="width:${h.winrate}%"></div></div>
    </div>`).join('');
}

function renderRankings(rankings) {
  if (!Array.isArray(rankings) || !rankings.length) return '<div class="muted">暂无排名数据 (需要更多比赛场次)</div>';
  return rankings.map(r => `
    <div class="ranking-row">
      <div class="ranking-hero">${esc(r.heroName)}</div>
      <div class="ranking-rank">${r.score}分</div>
      <div class="ranking-pct muted">前 ${(r.percent_rank * 100).toFixed(1)}%</div>
    </div>`).join('');
}

function renderWordCounts(words) {
  if (!Array.isArray(words) || !words.length) return '<div class="muted">暂无聊天数据</div>';
  const maxCount = words[0]?.count || 1;
  return words.map(w => `
    <div class="word-row">
      <span class="word-text">${esc(w.word)}</span>
      <span class="word-bar"><span class="word-bar-fill" style="width:${(w.count/maxCount*100)}%"></span></span>
      <span class="word-count muted">${w.count}</span>
    </div>`).join('');
}

// 基于近期比赛计算统计数据
function renderStats(matches) {
  if (!Array.isArray(matches) || !matches.length) return '<div class="muted">暂无统计数据</div>';
  const wins = matches.filter(m => m.win).length;
  const total = matches.length;
  const wr = Math.round(wins / total * 100);
  const avgKills = (matches.reduce((s,m) => s + m.kills, 0) / total).toFixed(1);
  const avgDeaths = (matches.reduce((s,m) => s + m.deaths, 0) / total).toFixed(1);
  const avgAssists = (matches.reduce((s,m) => s + m.assists, 0) / total).toFixed(1);
  const avgKDA = avgDeaths > 0 ? ((+avgKills + +avgAssists) / avgDeaths).toFixed(2) : (+avgKills + +avgAssists).toFixed(1);
  const avgGPM = Math.round(matches.reduce((s,m) => s + m.gpm, 0) / total);
  const avgXPM = Math.round(matches.reduce((s,m) => s + m.xpm, 0) / total);
  const avgDuration = Math.round(matches.reduce((s,m) => s + m.duration, 0) / total);
  const avgLH = Math.round(matches.reduce((s,m) => s + m.last_hits, 0) / total);
  // 按位置统计
  const laneCounts = {};
  matches.forEach(m => { if (m.lane_role) laneCounts[m.lane_role] = (laneCounts[m.lane_role] || 0) + 1; });
  const topLane = Object.entries(laneCounts).sort((a,b) => b[1] - a[1])[0];
  return `
    <div class="stats-grid">
      <div class="stat-item"><div class="stat-val ${wr >= 50 ? 'wr-good' : 'wr-bad'}">${wr}%</div><div class="stat-label">胜率</div></div>
      <div class="stat-item"><div class="stat-val">${wins}/${total}</div><div class="stat-label">胜/负</div></div>
      <div class="stat-item"><div class="stat-val">${avgKDA}</div><div class="stat-label">平均 KDA</div></div>
      <div class="stat-item"><div class="stat-val">${avgGPM}</div><div class="stat-label">平均 GPM</div></div>
      <div class="stat-item"><div class="stat-val">${avgXPM}</div><div class="stat-label">平均 XPM</div></div>
      <div class="stat-item"><div class="stat-val">${avgLH}</div><div class="stat-label">平均正补</div></div>
      <div class="stat-item"><div class="stat-val">${durStr(avgDuration)}</div><div class="stat-label">场均时长</div></div>
      <div class="stat-item"><div class="stat-val">${topLane ? laneName(topLane[0]) : '—'}</div><div class="stat-label">常用位置</div></div>
    </div>
    <div class="mini-title">KDA 分布</div>
    <div class="trend-row"><span class="muted">击杀</span><div class="trend-bar"><div class="hero-stat-bar-fill" style="width:${Math.min(+avgKills/20*100, 100)}%"></div></div><b>${avgKills}</b></div>
    <div class="trend-row"><span class="muted">死亡</span><div class="trend-bar"><div class="hero-stat-bar-fill" style="width:${Math.min(+avgDeaths/15*100, 100)}%; background:#f06464"></div></div><b>${avgDeaths}</b></div>
    <div class="trend-row"><span class="muted">助攻</span><div class="trend-bar"><div class="hero-stat-bar-fill" style="width:${Math.min(+avgAssists/25*100, 100)}%; background:#4ecdc4"></div></div><b>${avgAssists}</b></div>
  `;
}

// ── 子标签数据加载 ───────────────────────────────────────────────────────────
const SUBTAB_ENDPOINTS = { recent: 'recent', peers: 'peers', heroes: 'heroes', rankings: 'rankings', stats: 'recent' };

async function loadSubTab(accountId, type, container) {
  container.innerHTML = '<div class="muted">加载中…</div>';
  try {
    const endpoint = SUBTAB_ENDPOINTS[type] || type;
    const r = await fetch(`${API}/profile/${accountId}/${endpoint}`);
    if (!r.ok) { container.innerHTML = '<div class="muted">加载失败</div>'; return; }
    const data = await r.json();
    const renderers = { recent: renderRecentMatches, peers: renderPeers, heroes: renderHeroesFull, rankings: renderRankings, stats: renderStats };
    const fn = renderers[type];
    container.innerHTML = fn ? fn(data) : '<div class="muted">未知标签</div>';
    // 队友行可点击 → 查找该玩家
    if (type === 'peers') {
      container.querySelectorAll('.peer-row').forEach(row => {
        row.onclick = () => { $('scout-input').value = row.dataset.id; scout(row.dataset.id); };
      });
    }
  } catch (e) { container.innerHTML = `<div class="muted">错误: ${esc(e.message)}</div>`; }
}

// ── AI 玩家分析 ──────────────────────────────────────────────────────────────
let analyzingSet = new Set();
async function runAIAnalysis(accountId, resultEl, btn) {
  if (analyzingSet.has(accountId)) return;
  analyzingSet.add(accountId);
  const original = btn.textContent;
  btn.textContent = '分析中…';
  btn.disabled = true;
  resultEl.classList.remove('hidden');
  resultEl.innerHTML = '<div class="ai-analyze-loading"><span class="ai-spinner"></span> 正在分析玩家数据，请稍候…</div>';
  try {
    const r = await fetch(`${API}/profile/${accountId}/analyze`);
    const data = await r.json();
    if (!r.ok) throw new Error(data.error || '分析失败');
    resultEl.innerHTML = formatAIAnalysis(data.text);
    btn.textContent = '🔄 重新分析';
  } catch (e) {
    resultEl.innerHTML = `<div class="ai-error">❌ ${esc(e.message)}</div>`;
    btn.textContent = '🤖 分析';
  } finally {
    btn.disabled = false;
    analyzingSet.delete(accountId);
  }
}

function formatAIAnalysis(text) {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l);
  const fullText = lines.join('\n');
  const sectionTitles = ['🎯','🔬','⚔️','🔥','💡','📊','🎮','🧠','⚠️','✨'];
  let html = `<div class="ai-analyze-content" data-full="${esc(fullText)}">`;
  // 顶部浮动复制按钮 — 复制完整分析
  html += '<button class="ai-copy-all-btn" data-text="' + esc(fullText) + '" title="复制完整分析">📋 复制全部</button>';
  lines.forEach(line => {
    if (sectionTitles.some(e => line.startsWith(e))) {
      html += `<div class="ai-section-title">${line}</div>`;
    } else if (line.startsWith('•') || line.startsWith('-') || line.startsWith('*')) {
      html += `<div class="ai-bullet">${line.replace(/^[•\-\*]\s*/, '')}</div>`;
    } else {
      html += `<div class="ai-text">${line}</div>`;
    }
  });
  html += '</div>';
  return html;
}

// 复制按钮事件委托
document.addEventListener('click', (e) => {
  const copyBtn = e.target.closest('.ai-copy-all-btn, .ai-copy-btn');
  if (!copyBtn) return;
  const text = copyBtn.dataset.text || '';
  const doCopy = (t) => {
    if (navigator.clipboard && navigator.clipboard.writeText) {
      return navigator.clipboard.writeText(t);
    }
    return new Promise((resolve, reject) => {
      const ta = document.createElement('textarea');
      ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0';
      document.body.appendChild(ta); ta.select();
      try { document.execCommand('copy'); resolve(); } catch (e) { reject(e); }
      document.body.removeChild(ta);
    });
  };
  const original = copyBtn.textContent;
  doCopy(text).then(() => {
    copyBtn.textContent = '✓ 已复制';
    setTimeout(() => { copyBtn.textContent = original; }, 1500);
  }).catch(() => {
    copyBtn.textContent = '❌ 失败';
    setTimeout(() => { copyBtn.textContent = original; }, 1500);
  });
});

// 子标签点击 (事件委托 — 支持多个档案区域)
document.addEventListener('click', (e) => {
  // AI 分析按钮
  const btn = e.target.closest('.ai-analyze-btn');
  if (btn) {
    const wrap = btn.closest('.profile-wrap');
    if (wrap) {
      const aid = btn.dataset.aid;
      const resultEl = wrap.querySelector('.ai-analyze-result');
      runAIAnalysis(aid, resultEl, btn);
    }
    return;
  }
  const tab = e.target.closest('.sub-tab');
  if (!tab) return;
  const wrap = tab.closest('.profile-wrap');
  if (!wrap) return;
  const accountId = wrap.dataset.aid;
  if (!accountId) return;
  wrap.querySelectorAll('.sub-tab').forEach(t => t.classList.remove('sub-tab--active'));
  tab.classList.add('sub-tab--active');
  const type = tab.dataset.subtab;
  const container = wrap.querySelector('.sub-content');
  if (type === 'overview') {
    const cached = profileCache.get(accountId);
    container.innerHTML = cached ? renderOverview(cached) : '<div class="muted">暂无数据</div>';
  } else {
    loadSubTab(accountId, type, container);
  }
});

// ── 当前对局玩家 ─────────────────────────────────────────────────────────────
async function loadLivePlayers(matchId) {
  const card = $('live-players-card');
  const box = $('live-players');
  card.classList.remove('hidden');
  box.innerHTML = '<div class="muted">加载对局玩家数据…</div>';
  try {
    const r = await fetch(`${API}/live/${matchId}`);
    if (!r.ok) { box.innerHTML = '<div class="muted">此比赛数据不可用 (非公开/锦标赛)</div>'; return; }
    const data = await r.json();
    if (data.partial) {
      box.innerHTML = '<div class="muted" style="margin-bottom:6px">普通比赛仅暴露你的数据 — 其他玩家不可查</div>' + renderLivePlayers(data);
    } else {
      box.innerHTML = renderLivePlayers(data);
    }
    // 点击玩家 → 查找
    box.querySelectorAll('.live-player').forEach(el => {
      if (el.dataset.id) el.onclick = () => { $('scout-input').value = el.dataset.id; scout(el.dataset.id); };
    });
  } catch (e) { box.innerHTML = '<div class="muted">无法加载对局数据</div>'; }
}

function renderLivePlayers(data) {
  if (!data?.players?.length) return '<div class="muted">无玩家数据</div>';
  const radiant = data.players.filter(p => p.team_number === 0);
  const dire = data.players.filter(p => p.team_number === 1);
  const renderTeam = (players, name, cls) => `
    <div class="live-team ${cls}">
      <div class="live-team-name">${name}</div>
      ${players.map(p => `
        <div class="live-player" data-id="${p.account_id || ''}">
          <span class="live-hero">${esc(p.heroName || '—')}</span>
          <span class="live-name muted">${esc(p.personaname || p.profile?.name || '匿名')}</span>
          ${p.profile?.rank ? `<span class="live-rank muted">${esc(rankName(p.profile.rank))}</span>` : ''}
          ${p.profile?.winrate != null ? `<span class="live-wr ${p.profile.winrate >= 50 ? 'wr-good' : 'wr-bad'}">${p.profile.winrate}%</span>` : ''}
        </div>`).join('')}
    </div>`;
  return renderTeam(radiant, '天辉', 'live-team--radiant') + renderTeam(dire, '夜魇', 'live-team--dire');
}

// ── 档案加载 ─────────────────────────────────────────────────────────────────
async function loadMe() {
  const box = $('me-result');
  try {
    const r = await fetch(`${API}/me`);
    if (!r.ok) { const e = await r.json().catch(() => ({})); box.innerHTML = `<div class="muted">${esc(e.error) || '账号尚未识别'}</div>`; return; }
    box.innerHTML = profileHTML(await r.json());
  } catch (e) { box.innerHTML = `<div class="muted">服务器不可用</div>`; }
}

async function scout(q) {
  const box = $('scout-result'); box.innerHTML = '<div class="muted">搜索中…</div>';
  try {
    let id = q.trim();
    if (!/^\d+$/.test(id)) {
      const sr = await (await fetch(`${API}/search?q=${encodeURIComponent(id)}`)).json();
      if (!Array.isArray(sr) || !sr.length) { box.innerHTML = '<div class="muted">未找到</div>'; return; }
      id = sr[0].account_id;
    }
    const p = await (await fetch(`${API}/profile/${id}`)).json();
    box.innerHTML = profileHTML(p);
  } catch (e) { box.innerHTML = `<div class="muted">错误: ${esc(e.message)}</div>`; }
}
$('scout-go').onclick = () => { const v = $('scout-input').value; if (v.trim()) scout(v); };
$('scout-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('scout-go').click(); });

// Auto-load "me" once on start, and refresh when opening the Scout tab.
loadMe();
document.querySelector('.tab[data-tab="scout"]').addEventListener('click', loadMe);
