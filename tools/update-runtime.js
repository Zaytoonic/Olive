// Replaces the Electron runtime in dist/Olive with the version in node_modules. Run this after changing Electron's version,
// then "npm run build" and "npm run patch-exe". Close the app first. "npm run build" alone never touches the runtime.
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const from = path.dirname(require('electron'));   // finds the runtime, downloading it if it's missing
const to = path.join(root, 'dist', 'Olive');
fs.rmSync(to, { recursive: true, force: true });
fs.cpSync(from, to, { recursive: true });
fs.renameSync(path.join(to, 'electron.exe'), path.join(to, 'Olive.exe'));
fs.rmSync(path.join(to, 'resources', 'default_app.asar'), { force: true });   // it would be the app otherwise
console.log('Runtime is now Electron ' + fs.readFileSync(path.join(to, 'version'), 'utf8').trim());
