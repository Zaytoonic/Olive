// Copies the app (src + assets) into dist/Olive/resources/app, the folder Olive.exe runs.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const root = path.join(__dirname, '..');
const appDir = path.join(root, 'dist', 'Olive', 'resources', 'app');
if (!fs.existsSync(path.join(root, 'dist', 'Olive', 'Olive.exe'))) {
  console.error('dist/Olive/Olive.exe not found (the Electron runtime folder). Run npm run update-runtime first.');
  process.exit(1);
}
// The running app locks its files, so removing the old copy would fail halfway and leave it broken.
let running = false;
try { running = execFileSync('tasklist', ['/FI', 'IMAGENAME eq Olive.exe', '/NH'], { encoding: 'utf8', windowsHide: true }).includes('Olive.exe'); } catch { /* can't tell: carry on */ }
if (running) {
  console.error('Olive is running. Quit it from the tray icon, then build again. Nothing was changed.');
  process.exit(1);
}
require('./build-helper').buildHelper();
// The window is React (src/ui): build it into src/renderer/ui first. Its source isn't needed in the app.
execFileSync(process.execPath, [path.join(root, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'], { cwd: root, stdio: 'inherit' });
fs.rmSync(appDir, { recursive: true, force: true });
const uiSource = path.join(root, 'src', 'ui');
for (const dir of ['src', 'assets']) fs.cpSync(path.join(root, dir), path.join(appDir, dir), { recursive: true, filter: p => p !== uiSource && !p.startsWith(uiSource + path.sep) });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
// Keep "name" unchanged: Electron stores settings in a folder named after it. src/main/migrate.js moved them from the old name.
fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify({ name: pkg.name, version: pkg.version, main: pkg.main }, null, 2) + '\n');
// The app's own text is English, and Chromium falls back to en-US, so the other 54 language files only take up disk space.
// npm's copy of Electron keeps them all if they are ever wanted (node_modules/electron/dist/locales).
const locales = path.join(root, 'dist', 'Olive', 'locales');
let removed = 0;
if (fs.existsSync(path.join(locales, 'en-US.pak'))) {
  for (const f of fs.readdirSync(locales)) if (f !== 'en-US.pak') { fs.rmSync(path.join(locales, f)); removed++; }
}
console.log(`Built Olive ${pkg.version} -> ${path.relative(root, appDir)}${removed ? ` (removed ${removed} unused language files)` : ''}`);
