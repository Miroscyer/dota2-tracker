/**
 * Auto-detect the logged-in Steam account locally — so the app knows who "you"
 * are without any manual entry. The Steam Web API *key* can't be read locally
 * (Valve only issues it via the website after login); but the logged-in
 * SteamID is stored on disk in `<steam>/config/loginusers.vdf`, and during a
 * match the live GSI feed also carries player.steamid / player.accountid.
 */

const fs = require('fs');
const path = require('path');
const { candidateSteamRoots } = require('./gsi-install');

const STEAMID64_BASE = 76561197960265728n;

/** SteamID64 → 32-bit Dota account id. */
function steam64ToAccountId(steam64) {
  try { return String(BigInt(steam64) - STEAMID64_BASE); }
  catch { return null; }
}

/** account id → SteamID64. */
function accountIdToSteam64(accountId) {
  try { return String(BigInt(accountId) + STEAMID64_BASE); }
  catch { return null; }
}

/**
 * Parse loginusers.vdf and return the most-recently-used SteamID64, or null.
 * Picks the account flagged "MostRecent" "1", falling back to the highest
 * "Timestamp".
 */
function findSteamId() {
  for (const root of candidateSteamRoots()) {
    const vdf = path.join(root, 'config', 'loginusers.vdf');
    if (!fs.existsSync(vdf)) continue;
    try {
      const text = fs.readFileSync(vdf, 'utf8');
      // Each account block: "76561198..." { ... "MostRecent" "1" ... "Timestamp" "..." }
      const re = /"(7656\d{13})"\s*\{([^}]*)\}/g;
      let m, best = null, bestTs = -1;
      while ((m = re.exec(text)) !== null) {
        const id = m[1], body = m[2];
        const mostRecent = /"MostRecent"\s*"1"/.test(body);
        const tsMatch = body.match(/"Timestamp"\s*"(\d+)"/);
        const ts = tsMatch ? Number(tsMatch[1]) : 0;
        if (mostRecent) return id;          // definitive
        if (ts > bestTs) { bestTs = ts; best = id; }
      }
      if (best) return best;
    } catch {
      /* unreadable — try the next root */
    }
  }
  return null;
}

module.exports = { findSteamId, steam64ToAccountId, accountIdToSteam64 };
