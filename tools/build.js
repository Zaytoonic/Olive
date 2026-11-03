// Copies the app (src + assets) into dist/Olive/resources/app, the folder Olive.exe runs.
// The old copy is removed first, so nothing stale is left behind.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const appDir = path.join(root, 'dist', 'Olive', 'resources', 'app');
if (!fs.existsSync(path.join(root, 'dist', 'Olive', 'Olive.exe'))) {
  console.error('dist/Olive/Olive.exe not found (the Electron runtime folder). Run npm run update-runtime first.');
  process.exit(1);
}
require('./build-helper').buildHelper();
fs.rmSync(appDir, { recursive: true, force: true });
for (const dir of ['src', 'assets']) fs.cpSync(path.join(root, dir), path.join(appDir, dir), { recursive: true });
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
