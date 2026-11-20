// ---- Soundboard files ----
// Sounds you add are copied into Olive's settings folder (sounds\), so moving or deleting the original doesn't break
// them. The page only ever names a copy by its own file name (a random id plus the extension); it can't read anything else.
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const EXTENSIONS = ['mp3', 'wav', 'ogg', 'oga', 'opus', 'flac', 'm4a', 'aac', 'webm'];
const MAX_BYTES = 25 * 1024 * 1024;
const OWN_FILE = new RegExp(`^[a-f0-9]{16}\\.(${EXTENSIONS.join('|')})$`);
const soundsDir = () => path.join(app.getPath('userData'), 'sounds');
const ownPath = file => (typeof file === 'string' && OWN_FILE.test(file) ? path.join(soundsDir(), file) : null);

// Copies each file in; says which were added ({ file, name, original }) and which were skipped ({ name, why }).
async function importFiles(paths) {
  const added = [], skipped = [];
  await fs.promises.mkdir(soundsDir(), { recursive: true });
  for (const src of paths) {
    if (typeof src !== 'string' || !src) continue;
    const base = path.basename(src), ext = path.extname(src).slice(1).toLowerCase(), name = path.basename(src, path.extname(src));
    if (!EXTENSIONS.includes(ext)) { skipped.push({ name: base, why: 'not a sound file' }); continue; }
    try {
      const st = await fs.promises.stat(src);
      if (!st.isFile()) { skipped.push({ name: base, why: 'not a file' }); continue; }
      if (st.size > MAX_BYTES) { skipped.push({ name: base, why: 'bigger than 25 MB' }); continue; }
      const file = crypto.randomBytes(8).toString('hex') + '.' + ext;
      await fs.promises.copyFile(src, path.join(soundsDir(), file));
      added.push({ file, name, original: base });
    } catch (err) {
      skipped.push({ name: base, why: "couldn't be read (" + (err.code || err.message) + ')' });
    }
  }
  return { added, skipped };
}

function initSoundboard() {
  ipcMain.handle('board:pick', async event => {
    const win = BrowserWindow.fromWebContents(event.sender);
    const r = await dialog.showOpenDialog(win, {
      title: 'Add sounds', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Sound files', extensions: EXTENSIONS }]
    });
    return r.canceled ? { added: [], skipped: [] } : importFiles(r.filePaths);
  });
  ipcMain.handle('board:import', (event, paths) => importFiles(Array.isArray(paths) ? paths.slice(0, 100) : []));
  ipcMain.handle('board:read', async (event, file) => {
    const p = ownPath(file);
    if (!p) throw new Error('not a soundboard file');
    return fs.promises.readFile(p);
  });
  ipcMain.handle('board:remove', async (event, file) => {
    const p = ownPath(file);
    if (p) await fs.promises.rm(p, { force: true });
  });
}

module.exports = { initSoundboard, EXTENSIONS, importFiles };
