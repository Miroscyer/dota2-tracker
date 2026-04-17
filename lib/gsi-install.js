/**
 * Shared helpers for locating the Dota 2 GSI config folder and installing the
 * tracker's .cfg into it. Used by both the CLI installer and the .exe launcher.
 *
 * Dota only loads GSI configs from:
 *   <dota-library>/steamapps/common/dota 2 beta/game/dota/cfg/gamestate_integration/
 *
 * Robust detection: find the Steam client (registry on Windows + common paths),
 * then read Steam's libraryfolders.vdf so we find Dota even when it's installed
 * in a library on another drive (D:/E:/F:…) — the common reason the config
 * "silently doesn't install" and the overlay sits on "waiting" forever.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const GSI_REL = path.join('game', 'dota', 'cfg', 'gamestate_integration');

/** Steam *client* install roots (where Steam.exe / loginusers.vdf live). */
function candidateSteamRoots() {
  const home = os.homedir();
  const roots = [];
  switch (process.platform) {
    case 'win32':
      roots.push(...steamRootsFromRegistry());
      roots.push(
        'C:\\Program Files (x86)\\Steam',
        'C:\\Program Files\\Steam',
        'C:\\Steam',
        path.join(home, 'Steam'),
      );
      break;
    case 'darwin':
      roots.push(path.join(home, 'Library', 'Application Support', 'Steam'));
      break;
    default: // linux
      roots.push(
        path.join(home, '.steam', 'steam'),
        path.join(home, '.local', 'share', 'Steam'),
        path.join(home, '.steam', 'root'),
        '/usr/share/steam',
      );
  }
  return [...new Set(roots)];
}

/** On Windows, ask the registry where Steam is — the definitive location. */
function steamRootsFromRegistry() {
  if (process.platform !== 'win32') return [];
  const out = [];
  try {
    const { execSync } = require('child_process');
    for (const key of ['HKCU\\Software\\Valve\\Steam', 'HKLM\\SOFTWARE\\WOW6432Node\\Valve\\Steam']) {
      try {
        const res = execSync(`reg query "${key}" /v ${key.startsWith('HKCU') ? 'SteamPath' : 'InstallPath'}`,
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
        const m = res.match(/REG_SZ\s+(.+)/i);
        if (m) out.push(m[1].trim().replace(/\//g, '\\'));
      } catch { /* key absent */ }
    }
  } catch { /* no reg / not windows */ }
  return out;
}

/** All Steam library paths, parsed from libraryfolders.vdf across all roots. */
function steamLibraries() {
  const libs = new Set();
  for (const root of candidateSteamRoots()) {
    if (!root || !fs.existsSync(root)) continue;
    libs.add(root); // the client root is itself a library
    for (const rel of [
      path.join('steamapps', 'libraryfolders.vdf'),
      path.join('config', 'libraryfolders.vdf'),
    ]) {
      const vdf = path.join(root, rel);
      if (!fs.existsSync(vdf)) continue;
      try {
        const text = fs.readFileSync(vdf, 'utf8');
        const re = /"path"\s*"([^"]+)"/g;
        let m;
        while ((m = re.exec(text)) !== null) libs.add(m[1].replace(/\\\\/g, '\\'));
      } catch { /* skip */ }
    }
  }
  return [...libs];
}

/** Return the gamestate_integration dir for the installed Dota, or null. */
function findDotaCfgDir() {
  for (const lib of steamLibraries()) {
    const dotaBeta = path.join(lib, 'steamapps', 'common', 'dota 2 beta');
    if (fs.existsSync(dotaBeta)) return path.join(dotaBeta, GSI_REL);
  }
  return null;
}

/**
 * Copy a .cfg into the Dota GSI folder.
 * @returns {{ok: true, dest: string} | {ok: false, reason: string}}
 */
function installConfig(sourceCfgPath, cfgName = 'gamestate_integration_tracker.cfg') {
  if (!fs.existsSync(sourceCfgPath)) {
    return { ok: false, reason: `source config missing: ${sourceCfgPath}` };
  }
  const target = findDotaCfgDir();
  if (!target) return { ok: false, reason: 'dota-not-found' };

  fs.mkdirSync(target, { recursive: true });
  const dest = path.join(target, cfgName);
  fs.copyFileSync(sourceCfgPath, dest);
  return { ok: true, dest };
}

module.exports = { findDotaCfgDir, installConfig, candidateSteamRoots, steamLibraries };
