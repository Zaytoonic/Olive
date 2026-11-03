// Olive used to be called Mic Manager. Moves what the old name left behind, once, on the first run under the new name.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const OLD_SETTINGS_FOLDER = 'mic-manager';
const OLD_LOGIN_ENTRY = 'electron.app.Mic Manager';
const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run';
const APPROVED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';

// Copies the saved settings and the salt behind saved mic IDs. The old folder is left alone, so nothing is lost if this goes wrong.
// Only runs when the new folder has no settings yet, so it can never overwrite anything. Run this before the browser starts up.
function migrateSettings(oldDir, newDir) {
  const from = path.join(oldDir, 'Local Storage'), to = path.join(newDir, 'Local Storage'), part = to + '.migrating';
  if (fs.existsSync(to)) return 'exists';
  if (!fs.existsSync(from)) return 'none';
  try {
    fs.rmSync(part, { recursive: true, force: true });
    fs.cpSync(from, part, { recursive: true, filter: f => path.basename(f) !== 'LOCK' });
    const prefs = path.join(oldDir, 'Preferences');
    if (fs.existsSync(prefs) && !fs.existsSync(path.join(newDir, 'Preferences'))) fs.copyFileSync(prefs, path.join(newDir, 'Preferences'));
    fs.renameSync(part, to);                     // last, so a half-finished copy never counts as settings
    return 'copied';
  } catch (err) {
    console.error('Could not copy the old settings: ' + err.message);
    try { fs.rmSync(part, { recursive: true, force: true }); } catch { /* it gets cleared next time */ }
    return 'failed';
  }
}

function reg(...args) {
  const exe = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'reg.exe');
  try { return execFileSync(exe, args, { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; }
}

// Windows names the login entry after the exe's product name, so the old one would stay behind, pointing at the old exe.
// register(enabled) adds the new entry and says whether it worked; the old one only goes once it has.
// An entry turned off in Task Manager stays off: the first byte of its StartupApproved value is odd when it's off.
function moveLoginEntry(register, name = OLD_LOGIN_ENTRY) {
  if (reg('query', RUN, '/v', name) === null) return 'none';
  const approved = reg('query', APPROVED, '/v', name);
  const state = approved && approved.match(/REG_BINARY\s+([0-9A-Fa-f]{2})/);
  const enabled = !state || parseInt(state[1], 16) % 2 === 0;
  if (!register(enabled)) return 'failed';
  reg('delete', RUN, '/v', name, '/f');
  if (approved) reg('delete', APPROVED, '/v', name, '/f');
  return enabled ? 'moved' : 'moved-off';
}

module.exports = { OLD_SETTINGS_FOLDER, RUN, APPROVED, migrateSettings, moveLoginEntry, reg };
