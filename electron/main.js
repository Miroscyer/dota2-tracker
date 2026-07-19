// electron/main.js
// Base: ReXaXeR's overlay shell (frameless always-on-top window, tray, hotkeys,
// settings/logs windows, electron-updater auto-update).
// Merged in (from CrabotY's tracker): automatic GSI config installation into the
// Dota 2 folder on launch — the original required manual placement.
const {
  app, BrowserWindow, ipcMain, screen,
  globalShortcut, Tray, Menu, nativeImage, shell
} = require('electron');
const path    = require('path');
const { fork } = require('child_process');
const { autoUpdater } = require('electron-updater');
const { installConfig } = require('../lib/gsi-install');

let mainWindow   = null;
let logsWindow   = null;
let settingsWindow = null;
let tray         = null;
let gsiProcess   = null;
const isDev = !app.isPackaged;

const CFG_NAME = 'gamestate_integration_dota2tracker.cfg';
const startedHidden = process.argv.includes('--hidden');

// ─── Single instance ──────────────────────────────────────────────────────────
// Prevents two copies fighting over GSI port 3001; a second launch just reveals
// the already-running overlay.
const hasLock = app.requestSingleInstanceLock();
if (!hasLock) app.quit();

// ─── 设置 (settings.json 在 userData 中) ─────────────────────────────────────
function settingsFile() { return path.join(app.getPath('userData'), 'settings.json'); }
function loadSettings() {
  try { return JSON.parse(require('fs').readFileSync(settingsFile(), 'utf8')); }
  catch { return { autoLaunch: true }; }
}
function saveSettings(s) {
  try { require('fs').writeFileSync(settingsFile(), JSON.stringify(s, null, 2)); } catch {}
}

// ─── Windows 开机自启动 (隐藏到托盘) ─────────────────────────────────────
// 这样配置始终已安装且服务器在 Dota 启动前就已就绪 — 无需重启游戏。
function applyAutoLaunch(enabled) {
  if (isDev) return;
  try { app.setLoginItemSettings({ openAtLogin: enabled, openAsHidden: true, args: ['--hidden'] }); }
  catch (e) { pushLog('error', `autoLaunch: ${e.message}`); }
}

// ─── 检查 Dota 是否正在运行 ────────────────────────────────────────────
function isDotaRunning() {
  try {
    const { execSync } = require('child_process');
    if (process.platform === 'win32') {
      const out = execSync('tasklist /FI "IMAGENAME eq dota2.exe" /NH', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      return /dota2\.exe/i.test(out);
    }
    return execSync('pgrep -x dota2 || true', { encoding: 'utf8' }).trim().length > 0;
  } catch { return false; }
}

// ─── 日志缓冲区 ───────────────────────────────────────────────────────
const logBuffer = [];
function pushLog(level, text) {
  const entry = { level, text, time: new Date().toLocaleTimeString('zh-CN') };
  logBuffer.push(entry);
  if (logBuffer.length > 500) logBuffer.shift();
  logsWindow?.webContents?.send('log', entry);
  mainWindow?.webContents?.send('log-badge');
}
const _log = console.log.bind(console);
const _err = console.error.bind(console);
console.log   = (...a) => { _log(...a);  pushLog('info',  a.join(' ')); };
console.error = (...a) => { _err(...a);  pushLog('error', a.join(' ')); };

// ─── 自动安装 GSI 配置 (来自我们的追踪器) ───────────────────────────
function installGsiConfig() {
  const cfgPath = isDev
    ? path.join(__dirname, '..', CFG_NAME)
    : path.join(process.resourcesPath, CFG_NAME);
  try {
    const res = installConfig(cfgPath, CFG_NAME);
    if (res.ok) {
      pushLog('info', `✓ GSI 配置已安装: ${res.dest}`);
      if (isDotaRunning()) {
        pushLog('warn', '⚠ Dota 正在运行 — 配置将在下次启动时生效。' +
          '请重启 Dota 一次；之后不再需要重启。');
      } else {
        pushLog('info', '✓ 完成。Dota 未运行 — 下次启动时将自动加载，无需重启。');
      }
    } else if (res.reason === 'dota-not-found') {
      pushLog('warn', '⚠ 未自动找到 Dota 2 — 请手动复制配置文件:');
      pushLog('warn', `   ${cfgPath}`);
      pushLog('warn', '   → <Steam>\\steamapps\\common\\dota 2 beta\\game\\dota\\cfg\\gamestate_integration\\');
    } else {
      pushLog('error', `无法安装 GSI 配置: ${res.reason}`);
    }
  } catch (e) {
    pushLog('error', `GSI 配置错误: ${e.message}`);
  }
}

// ─── 自动更新 ───────────────────────────────────────────────────────────
function setupAutoUpdater() {
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = true;

  autoUpdater.on('checking-for-update', () => {
    pushLog('info', '🔍 正在检查更新...');
    settingsWindow?.webContents?.send('update-status', { status: 'checking' });
    mainWindow?.webContents?.send('update-status',     { status: 'checking' });
  });
  autoUpdater.on('update-available', info => {
    pushLog('info', `⬆ 发现新版本: v${info.version}`);
    const payload = { status: 'available', version: info.version, notes: info.releaseNotes };
    settingsWindow?.webContents?.send('update-status', payload);
    mainWindow?.webContents?.send('update-status',     payload);
  });
  autoUpdater.on('update-not-available', () => {
    pushLog('info', '✓ 已是最新版本');
    const payload = { status: 'latest', version: app.getVersion() };
    settingsWindow?.webContents?.send('update-status', payload);
    mainWindow?.webContents?.send('update-status',     payload);
  });
  autoUpdater.on('download-progress', prog => {
    const p = Math.round(prog.percent);
    pushLog('info', `⬇ 下载更新: ${p}%`);
    const payload = { status: 'downloading', percent: p, speed: Math.round(prog.bytesPerSecond / 1024) };
    settingsWindow?.webContents?.send('update-status', payload);
    mainWindow?.webContents?.send('update-status',     payload);
  });
  autoUpdater.on('update-downloaded', info => {
    pushLog('info', `✅ 更新 v${info.version} 已下载 — 准备安装`);
    const payload = { status: 'downloaded', version: info.version };
    settingsWindow?.webContents?.send('update-status', payload);
    mainWindow?.webContents?.send('update-status',     payload);
  });
  autoUpdater.on('error', err => {
    pushLog('error', `更新错误: ${err.message}`);
    settingsWindow?.webContents?.send('update-status', { status: 'error', message: err.message });
  });

  if (!isDev) setTimeout(() => autoUpdater.checkForUpdates(), 5000);
}

// ─── GSI 服务器 ───────────────────────────────────────────────────────
function startGSIServer() {
  pushLog('info', '▶ 启动 GSI 服务器...');
  const serverPath = isDev
    ? path.join(__dirname, '../gsi-server/server.js')
    : path.join(process.resourcesPath, 'app/gsi-server/server.js');

  gsiProcess = fork(serverPath, [], {
    env: { ...process.env, USER_ENV_PATH: path.join(app.getPath('userData'), '.env') },
    silent: true
  });
  gsiProcess.stdout.on('data', d =>
    d.toString().split('\n').filter(Boolean).forEach(l => pushLog('info', l)));
  gsiProcess.stderr.on('data', d =>
    d.toString().split('\n').filter(Boolean).forEach(l => pushLog('error', l)));
  gsiProcess.on('error', err => pushLog('error', `GSI error: ${err.message}`));
  gsiProcess.on('exit',  code => pushLog('warn',  `GSI exited (${code})`));
}

// ─── 主窗口 (覆盖层) ───────────────────────────────────────────────────
function createWindow() {
  const { width } = screen.getPrimaryDisplay().workAreaSize;
  mainWindow = new BrowserWindow({
    width: 440, height: 760,
    x: width - 460, y: 20,
    show: !startedHidden, // launched at login → start hidden in the tray
    title: '大话游戏 | DOTA2助手',
    frame: false, transparent: true,
    alwaysOnTop: true, skipTaskbar: false,
    resizable: true, hasShadow: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    }
  });
  mainWindow.setAlwaysOnTop(true, 'screen-saver');
  mainWindow.setVisibleOnAllWorkspaces(true);

  if (isDev) mainWindow.loadURL('http://localhost:5173');
  else       mainWindow.loadFile(path.join(__dirname, '../dist/index.html'));

  mainWindow.on('closed', () => { mainWindow = null; });
  pushLog('info', '✓ 主窗口已创建');
}

// ─── 设置窗口 ────────────────────────────────────────────────────────────
function createSettingsWindow() {
  if (settingsWindow) { settingsWindow.focus(); return; }
  settingsWindow = new BrowserWindow({
    width: 520, height: 600,
    title: '大话游戏 | DOTA2助手 — 设置',
    backgroundColor: '#0a0c12', frame: true, resizable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false,
    }
  });
  settingsWindow.setMenuBarVisibility(false);
  settingsWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildSettingsHTML()));
  settingsWindow.webContents.on('did-finish-load', () =>
    settingsWindow.webContents.send('app-version', app.getVersion()));
  settingsWindow.on('closed', () => { settingsWindow = null; });
}

function buildSettingsHTML() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>设置</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0c12;color:#c8d0e0;font-family:'Segoe UI',sans-serif;font-size:13px}
.header{background:linear-gradient(135deg,#1a1f2e,#111520);padding:20px 24px;border-bottom:1px solid #1e2535}
.header h1{font-size:16px;font-weight:600;color:#e8eaf0;letter-spacing:.05em}
.header p{font-size:11px;color:#4a5168;margin-top:4px}
.body{padding:20px 24px;overflow-y:auto;height:calc(100vh - 90px)}
.section{margin-bottom:24px}
.section-title{font-size:10px;font-weight:700;color:#4a5168;letter-spacing:.1em;text-transform:uppercase;margin-bottom:12px;padding-bottom:6px;border-bottom:1px solid #1e2535}
.card{background:#111520;border:1px solid #1e2535;border-radius:8px;padding:16px;margin-bottom:8px}
.card-row{display:flex;align-items:center;justify-content:space-between;gap:12px}
.card-label{font-size:13px;color:#c8d0e0}
.card-sub{font-size:11px;color:#4a5168;margin-top:2px}
.btn{padding:8px 18px;border-radius:6px;border:none;font-size:12px;font-weight:600;cursor:pointer;transition:opacity .15s}
.btn:disabled{opacity:.4;cursor:not-allowed}
.btn-primary{background:#6c8cff;color:#fff}.btn-green{background:#4ade80;color:#0a1a0f}
.btn-ghost{background:rgba(255,255,255,.07);color:#7a8299;border:1px solid #1e2535}
.input{height:34px;padding:0 10px;background:rgba(255,255,255,.06);border:1px solid #1e2535;border-radius:6px;color:#c8d0e0;font-size:12px;outline:none;width:100%}
.tag{font-size:10px;padding:2px 7px;border-radius:20px;font-weight:600}
.tag-green{background:rgba(74,222,128,.12);color:#4ade80}.tag-blue{background:rgba(108,140,255,.12);color:#6c8cff}
.tag-red{background:rgba(248,113,113,.12);color:#f87171}.tag-gray{background:rgba(255,255,255,.07);color:#7a8299}
.progress-wrap{margin-top:10px;display:none}.progress-bar{height:4px;background:#1e2535;border-radius:2px;overflow:hidden;margin-bottom:6px}
.progress-fill{height:100%;background:#6c8cff;width:0%;transition:width .3s}.progress-text{font-size:11px;color:#7a8299}
.notes{font-size:11px;color:#7a8299;line-height:1.6;margin-top:8px;background:rgba(255,255,255,.03);padding:8px;border-radius:6px;max-height:80px;overflow-y:auto;display:none}
.link{color:#6c8cff;font-size:11px;cursor:pointer;text-decoration:none}.link:hover{text-decoration:underline}
.divider{height:1px;background:#1e2535;margin:8px 0}
code{background:#1e2535;padding:2px 6px;border-radius:3px;color:#c8d0e0}
</style></head><body>
<div class="header"><h1>⚙ 设置</h1><p id="ver-line">大话游戏 | DOTA2助手 v—</p></div>
<div class="body">
  <div class="section"><div class="section-title">更新</div>
    <div class="card">
      <div class="card-row"><div><div class="card-label">应用版本</div>
        <div class="card-sub">当前: <span id="cur-ver">—</span> · 最新: <span id="latest-ver">—</span></div></div>
        <span id="update-tag" class="tag tag-gray">—</span></div>
      <div class="divider"></div>
      <div class="card-row" style="margin-top:4px"><div id="update-msg" style="font-size:12px;color:#7a8299">点击检查更新</div>
        <div style="display:flex;gap:6px">
          <button class="btn btn-ghost" id="check-btn" onclick="checkUpdates()">检查</button>
          <button class="btn btn-primary" id="download-btn" style="display:none" onclick="downloadUpdate()">下载</button>
          <button class="btn btn-green" id="install-btn" style="display:none" onclick="installUpdate()">安装</button></div></div>
      <div class="progress-wrap" id="progress-wrap"><div class="progress-bar"><div class="progress-fill" id="progress-fill"></div></div>
        <div class="progress-text" id="progress-text">0 KB/s</div></div>
      <div class="notes" id="release-notes"></div></div>
  </div>
  <div class="section"><div class="section-title">API 密钥（可选）</div>
    <div class="card" style="background:rgba(74,222,128,.06);border-color:rgba(74,222,128,.2)">
      <div class="card-label">✓ 你的 Steam 账号已自动识别</div>
      <div class="card-sub">从本地 Steam 登录和比赛数据 (GSI) 获取 — 无需手动输入。</div></div>
    <div class="card"><div class="card-label" style="margin-bottom:4px">Steam Web API Key — 可选</div>
      <div class="card-sub" style="margin-bottom:8px">仅用于通过 Valve 获取完整比赛数据表。密钥需要从网页一次性复制。没有它一切正常 (OpenDota + GSI)。</div>
      <input class="input" type="password" id="steam-key" placeholder="XXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX">
      <div style="display:flex;justify-content:space-between;margin-top:8px;align-items:center">
        <a class="link" onclick="openExternal('https://steamcommunity.com/dev/apikey');return false">获取密钥 →</a>
        <button class="btn btn-ghost" onclick="saveKey('STEAM_API_KEY','steam-key')">保存</button></div></div>
  </div>
  <div class="section"><div class="section-title">AI 助手</div>
    <div class="card">
      <div class="card-label" style="margin-bottom:8px">AI 提供商</div>
      <select class="input" id="ai-provider" onchange="setProvider(this.value)">
        <option value="openai">ChatGPT (OpenAI)</option>
        <option value="gemini">Google Gemini</option>
        <option value="deepseek">DeepSeek</option>
      </select>
      <div class="card-sub" style="margin-top:6px">每个提供商需要各自的密钥。密钥仅存储在本机 (userData/.env)，不会进入仓库/发布版。</div>
    </div>
    <div class="card"><div class="card-label" style="margin-bottom:6px">OpenAI API Key (ChatGPT)</div>
      <input class="input" type="password" id="openai-key" placeholder="sk-...">
      <div style="display:flex;justify-content:space-between;margin-top:8px;align-items:center">
        <a class="link" onclick="openExternal('https://platform.openai.com/api-keys');return false">获取密钥 →</a>
        <button class="btn btn-ghost" onclick="saveKey('OPENAI_API_KEY','openai-key')">保存</button></div></div>
    <div class="card"><div class="card-label" style="margin-bottom:6px">Google Gemini API Key</div>
      <input class="input" type="password" id="gemini-key" placeholder="AIza...">
      <div style="display:flex;justify-content:space-between;margin-top:8px;align-items:center">
        <a class="link" onclick="openExternal('https://aistudio.google.com/app/apikey');return false">获取密钥 →</a>
        <button class="btn btn-ghost" onclick="saveKey('GEMINI_API_KEY','gemini-key')">保存</button></div></div>
    <div class="card"><div class="card-label" style="margin-bottom:6px">DeepSeek API Key</div>
      <input class="input" type="password" id="deepseek-key" placeholder="sk-...">
      <div style="display:flex;justify-content:space-between;margin-top:8px;align-items:center">
        <a class="link" onclick="openExternal('https://platform.deepseek.com/api_keys');return false">获取密钥 →</a>
        <button class="btn btn-ghost" onclick="saveKey('DEEPSEEK_API_KEY','deepseek-key')">保存</button></div></div>
  </div>
  <div class="section"><div class="section-title">覆盖层</div>
    <div class="card"><div class="card-row"><div><div class="card-label">Windows 开机自启动</div>
      <div class="card-sub">追踪器在登录时静默启动到托盘 — 配置始终就位，无需重启 Dota。</div></div>
      <label style="cursor:pointer;display:flex;align-items:center;gap:6px;font-size:12px;color:#7a8299">
        <input type="checkbox" id="auto-launch" checked onchange="toggleAutoLaunch(this.checked)"> 开启</label></div></div>
    <div class="card"><div class="card-row"><div><div class="card-label">透明度</div>
      <div class="card-sub" id="opacity-val">100%</div></div>
      <input type="range" min="30" max="100" value="100" id="opacity-slider" style="width:120px" oninput="updateOpacity(this.value)"></div></div>
    <div class="card"><div class="card-label">快捷键</div>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:8px;font-size:11px;color:#7a8299">
        <div><code>Alt+D</code> 显示/隐藏</div><div><code>Alt+L</code> 日志</div>
        <div><code>Alt+S</code> 设置</div><div><code>Alt+Shift+D</code> 重置位置</div></div></div>
  </div>
  <div class="section"><div class="section-title">关于</div>
    <div class="card" style="font-size:11px;color:#4a5168;line-height:2">
      <div>大话游戏 | DOTA2助手 · <a class="link" onclick="openExternal('https://github.com/CrabotY/dota2-tracker');return false">CrabotY/dota2-tracker</a></div>
      <div>实时数据: Valve Game State Integration · 玩家资料: OpenDota</div></div>
  </div>
</div>
<script>
const api = window.electronAPI;
api?.onAppVersion(v => { document.getElementById('cur-ver').textContent='v'+v; document.getElementById('ver-line').textContent='大话游戏 | DOTA2助手 v'+v; });
api?.onUpdateStatus(info => {
  const $=id=>document.getElementById(id);
  const tag=$('update-tag'),msg=$('update-msg'),dl=$('download-btn'),inst=$('install-btn'),chk=$('check-btn'),pw=$('progress-wrap'),pf=$('progress-fill'),pt=$('progress-text'),nt=$('release-notes');
  if(info.status==='checking'){tag.className='tag tag-gray';tag.textContent='检查中...';msg.textContent='连接到 GitHub...';chk.disabled=true;}
  else if(info.status==='available'){tag.className='tag tag-blue';tag.textContent='有更新';$('latest-ver').textContent='v'+info.version;msg.textContent='发现新版本 v'+info.version;dl.style.display='inline-block';chk.disabled=false;if(info.notes){nt.style.display='block';nt.textContent=typeof info.notes==='string'?info.notes.replace(/<[^>]+>/g,''):JSON.stringify(info.notes);}}
  else if(info.status==='latest'){tag.className='tag tag-green';tag.textContent='已是最新';$('latest-ver').textContent='v'+info.version;msg.textContent='已是最新版本';chk.disabled=false;dl.style.display='none';}
  else if(info.status==='downloading'){tag.className='tag tag-blue';tag.textContent='下载中...';pw.style.display='block';pf.style.width=info.percent+'%';pt.textContent=info.percent+'% · '+info.speed+' KB/s';dl.disabled=true;}
  else if(info.status==='downloaded'){tag.className='tag tag-green';tag.textContent='准备安装';pw.style.display='none';dl.style.display='none';inst.style.display='inline-block';msg.textContent='更新已下载。立即安装？';}
  else if(info.status==='error'){tag.className='tag tag-red';tag.textContent='错误';msg.textContent=info.message||'更新错误';chk.disabled=false;dl.disabled=false;}
});
function checkUpdates(){api?.checkForUpdates();} function downloadUpdate(){api?.downloadUpdate();} function installUpdate(){api?.installUpdate();}
function openExternal(u){api?.openExternal(u);}
function updateOpacity(v){document.getElementById('opacity-val').textContent=v+'%';api?.setOpacity(v/100);}
function toggleAutoLaunch(on){api?.setAutoLaunch(on);}
api?.getSettings?.().then(s=>{ if(s&&typeof s.autoLaunch==='boolean') document.getElementById('auto-launch').checked=s.autoLaunch; });
function saveKey(name,id){const v=document.getElementById(id).value.trim();if(!v)return;api?.saveEnvKey(name,v);alert('已保存 ✓');}
function setProvider(v){api?.saveEnvKey('AI_PROVIDER',v);}
fetch('http://localhost:3001/ai/info').then(r=>r.json()).then(i=>{if(i&&i.provider)document.getElementById('ai-provider').value=i.provider;}).catch(()=>{});
</script></body></html>`;
}

// ─── 日志窗口 ───────────────────────────────────────────────────────────
function createLogsWindow() {
  if (logsWindow) { logsWindow.focus(); return; }
  logsWindow = new BrowserWindow({
    width: 700, height: 500,     title: '大话游戏 | DOTA2助手 — 日志',
    backgroundColor: '#0a0c12',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false }
  });
  logsWindow.setMenuBarVisibility(false);
  logsWindow.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(buildLogsHTML()));
  logsWindow.webContents.on('did-finish-load', () => logsWindow.webContents.send('log-history', logBuffer));
  logsWindow.on('closed', () => { logsWindow = null; });
}

function buildLogsHTML() {
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><style>
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0c12;color:#c8d0e0;font-family:Consolas,monospace;font-size:12px;display:flex;flex-direction:column;height:100vh;overflow:hidden}
#toolbar{display:flex;align-items:center;gap:8px;padding:8px 12px;background:#111520;border-bottom:1px solid #1e2535;flex-shrink:0}
#toolbar span{font-size:13px;font-weight:600;color:#6c8cff}
.tbtn{padding:4px 10px;border:1px solid #1e2535;border-radius:4px;background:transparent;color:#7a8299;font-size:11px;cursor:pointer}
.tbtn:hover{background:#1e2535;color:#c8d0e0}
#filter{flex:1;max-width:200px;height:26px;padding:0 8px;background:#111520;border:1px solid #1e2535;border-radius:4px;color:#c8d0e0;font-size:11px;outline:none}
#logs{flex:1;overflow-y:auto;padding:4px 0}
.line{display:flex;gap:8px;padding:2px 12px;line-height:1.5}.line:hover{background:rgba(255,255,255,.03)}
.time{color:#3d4f6b;flex-shrink:0;font-size:11px}.msg{word-break:break-all;white-space:pre-wrap}
.line.error .msg{color:#f87171}.line.warn .msg{color:#facc15}.line.info .msg{color:#c8d0e0}
#status{padding:4px 12px;font-size:11px;color:#3d4f6b;background:#111520;border-top:1px solid #1e2535}
</style></head><body>
<div id="toolbar"><span>📋 日志</span><input id="filter" placeholder="过滤...">
<button class="tbtn" onclick="clearLogs()">清空</button><button class="tbtn" onclick="copyAll()">复制</button>
<label style="display:flex;align-items:center;gap:4px;font-size:11px;color:#7a8299"><input type="checkbox" id="as" checked> 自动滚动</label></div>
<div id="logs"></div><div id="status">0 条</div>
<script>
const el=document.getElementById('logs'),fi=document.getElementById('filter'),st=document.getElementById('status');let all=[],ft='';
function esc(s){return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;')}
function cls(e){return e.level==='error'?'error':e.level==='warn'?'warn':'info'}
function mk(e){const d=document.createElement('div');d.className='line '+cls(e);d.innerHTML='<span class="time">'+e.time+'</span><span class="msg">'+esc(e.text)+'</span>';return d}
function add(e){all.push(e);if(ft&&!e.text.toLowerCase().includes(ft))return;el.appendChild(mk(e));st.textContent=all.length+' 条';if(document.getElementById('as').checked)el.scrollTop=el.scrollHeight}
function rr(){el.innerHTML='';all.filter(e=>!ft||e.text.toLowerCase().includes(ft)).forEach(e=>el.appendChild(mk(e)));if(document.getElementById('as').checked)el.scrollTop=el.scrollHeight}
function clearLogs(){all=[];el.innerHTML='';st.textContent='0 条'}
function copyAll(){navigator.clipboard.writeText(all.map(e=>'['+e.time+'] '+e.text).join('\\n'))}
fi.addEventListener('input',()=>{ft=fi.value.toLowerCase();rr()});
if(window.electronAPI){window.electronAPI.onLog(e=>add(e));window.electronAPI.onLogHistory(es=>{all=es;rr();st.textContent=all.length+' 条'});}
</script></body></html>`;
}

// ─── 托盘 ─────────────────────────────────────────────────────────────
function createTray() {
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('大话游戏 | DOTA2助手');
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '大话游戏 | DOTA2助手', enabled: false },
    { type: 'separator' },
    { label: '显示追踪器', click: () => mainWindow?.show() },
    { label: '设置',       click: () => createSettingsWindow() },
    { label: '日志',            click: () => createLogsWindow() },
    { type: 'separator' },
    { label: '退出',           click: () => app.quit() }
  ]));
  tray.on('double-click', () => mainWindow?.show());
}

// ─── IPC ──────────────────────────────────────────────────────────────────────
ipcMain.on('open-logs',         () => createLogsWindow());
ipcMain.on('open-settings',     () => createSettingsWindow());
ipcMain.on('minimize-window',   () => mainWindow?.minimize());
ipcMain.on('close-window',      () => mainWindow?.hide());
ipcMain.on('set-always-on-top', (_, f) => mainWindow?.setAlwaysOnTop(f, 'screen-saver'));
ipcMain.on('set-opacity',       (_, v) => mainWindow?.setOpacity(v));
ipcMain.on('open-external',     (_, url) => shell.openExternal(url));
ipcMain.on('check-for-updates', () => {
  if (isDev) settingsWindow?.webContents?.send('update-status', { status: 'error', message: '开发模式下不可用' });
  else autoUpdater.checkForUpdates();
});
ipcMain.on('download-update', () => autoUpdater.downloadUpdate());
ipcMain.on('install-update',  () => autoUpdater.quitAndInstall(false, true));
ipcMain.handle('get-version', () => app.getVersion());

ipcMain.handle('get-settings', () => loadSettings());
ipcMain.on('set-auto-launch', (_, enabled) => {
  const s = loadSettings(); s.autoLaunch = !!enabled; saveSettings(s);
  applyAutoLaunch(!!enabled);
  pushLog('info', `Windows 开机自启动: ${enabled ? '开启' : '关闭'}`);
});

ipcMain.on('save-env-key', (_, name, value) => {
  const fs = require('fs');
  const envPath = path.join(app.getPath('userData'), '.env');
  try {
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, 'utf8') : '';
    const re = new RegExp(`^${name}=.*$`, 'm');
    content = re.test(content) ? content.replace(re, `${name}=${value}`) : (content + `\n${name}=${value}`);
    fs.writeFileSync(envPath, content.trim() + '\n');
    pushLog('info', `${name} 已保存 — 请重启追踪器`);
  } catch (e) { pushLog('error', `保存密钥错误: ${e.message}`); }
});

// Second launch → just reveal the running overlay instead of starting a rival.
app.on('second-instance', () => { mainWindow?.show(); mainWindow?.focus(); });

// ─── Boot ─────────────────────────────────────────────────────────────────────
if (hasLock) app.whenReady().then(() => {
  pushLog('info', `═══ 大话游戏 | DOTA2助手 v${app.getVersion()} ═══`);
  applyAutoLaunch(loadSettings().autoLaunch !== false); // default ON
  installGsiConfig();
  startGSIServer();
  createWindow();
  createTray();
  setupAutoUpdater();

  globalShortcut.register('Alt+D', () => {
    if (mainWindow?.isVisible()) mainWindow.hide(); else mainWindow?.show();
  });
  globalShortcut.register('Alt+L', () => createLogsWindow());
  globalShortcut.register('Alt+S', () => createSettingsWindow());
  globalShortcut.register('Alt+Shift+D', () => {
    const { width } = screen.getPrimaryDisplay().workAreaSize;
    mainWindow?.setPosition(width - 460, 20);
  });
});

app.on('will-quit', () => { globalShortcut.unregisterAll(); gsiProcess?.kill(); });
app.on('window-all-closed', () => { /* 保持在托盘中 */ });
app.on('activate', () => { if (!mainWindow) createWindow(); });
