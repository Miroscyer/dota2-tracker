// electron/preload.js — context bridge between the overlay UI and the main process.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  // Window controls
  minimize:       ()     => ipcRenderer.send('minimize-window'),
  close:          ()     => ipcRenderer.send('close-window'),
  setAlwaysOnTop: (flag) => ipcRenderer.send('set-always-on-top', flag),
  setOpacity:     (val)  => ipcRenderer.send('set-opacity', val),
  openLogs:       ()     => ipcRenderer.send('open-logs'),
  openSettings:   ()     => ipcRenderer.send('open-settings'),
  openExternal:   (url)  => ipcRenderer.send('open-external', url),
  getVersion:     ()     => ipcRenderer.invoke('get-version'),
  platform:       process.platform,

  // Updates
  checkForUpdates: ()   => ipcRenderer.send('check-for-updates'),
  downloadUpdate:  ()   => ipcRenderer.send('download-update'),
  installUpdate:   ()   => ipcRenderer.send('install-update'),
  onUpdateStatus:  (cb) => ipcRenderer.on('update-status', (_, p) => cb(p)),

  // Settings / API keys
  saveEnvKey:    (name, value) => ipcRenderer.send('save-env-key', name, value),
  getSettings:   ()    => ipcRenderer.invoke('get-settings'),
  setAutoLaunch: (on)  => ipcRenderer.send('set-auto-launch', on),
  onAppVersion:  (cb)  => ipcRenderer.on('app-version', (_, v) => cb(v)),

  // Logs
  onLog:        (cb) => ipcRenderer.on('log',         (_, e)  => cb(e)),
  onLogHistory: (cb) => ipcRenderer.on('log-history', (_, es) => cb(es)),
  onLogBadge:   (cb) => ipcRenderer.on('log-badge',   ()      => cb()),
});
