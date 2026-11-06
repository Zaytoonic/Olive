// Runs the real installer and uninstaller end to end: npm run test:installer
// Everything is kept apart from a real install: its own temp folder, and a test name on every shortcut and registry value. Your Olive isn't touched.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, spawnSync, execFileSync } = require('child_process');

const root = path.join(__dirname, '..', '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const setup = path.join(root, 'dist', `Olive-Setup-${pkg.version}.exe`);
const TAG = 'Test' + process.pid;
const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'olive-install-test-'));
const dir = path.join(temp, 'Program Folder', 'Olive');
const RUN = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Run', APPROVED = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run';
const LOGIN = `electron.app.Olive${TAG}`, UNINSTALL = `HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Olive${TAG}`;
const appData = process.env.APPDATA;
const startMenu = path.join(appData, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `Olive${TAG}.lnk`);
const desktop = path.join(execFileSync('powershell.exe', ['-NoProfile', '-Command', "[Environment]::GetFolderPath('DesktopDirectory')"], { encoding: 'utf8' }).trim(), `Olive${TAG}.lnk`);
const settings = path.join(appData, `olive${TAG.toLowerCase()}`);

const sleep = ms => new Promise(r => setTimeout(r, ms));
const reg = (...a) => { try { return execFileSync('reg.exe', a, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }); } catch { return null; } };
const shortcutTarget = lnk => execFileSync('powershell.exe', ['-NoProfile', '-Command', `(New-Object -ComObject WScript.Shell).CreateShortcut('${lnk}').TargetPath`], { encoding: 'utf8' }).trim();
const results = [];
const check = (name, ok, detail) => { results.push(ok); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}: ${detail}`); };
function runSetup(...extra) {
  const log = path.join(temp, 'setup.log');
  const r = spawnSync(setup, ['--silent', '--tag', TAG, '--dir', dir, '--log', log, ...extra], { timeout: 180000 });
  return { code: r.status, log: fs.existsSync(log) ? fs.readFileSync(log, 'utf8').slice(0, 400) : '' };
}
// Counted with @(...).Count: with no Olive running at all, a piped Get-Process makes PowerShell exit with an error.
const procs = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-Process Olive -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${dir}\\*' }).Count`], { encoding: 'utf8' }).trim();

(async () => {
  try {
    if (!fs.existsSync(setup)) throw new Error('Run npm run installer first');
    console.log(`Installer: ${path.basename(setup)}, ${Math.round(fs.statSync(setup).size / 1048576)} MB`);

    console.log('\nFirst install');
    reg('add', RUN, '/v', LOGIN, '/t', 'REG_SZ', '/d', '"C:\\old-place\\Olive.exe" --hidden', '/f');
    const t0 = Date.now(), first = runSetup('--desktop');
    check('it installs without admin rights', first.code === 0, `exit ${first.code} in ${Math.round((Date.now() - t0) / 1000)} s ${first.log}`);
    const exe = path.join(dir, 'Olive.exe');
    check('the app and uninstaller are in place', fs.existsSync(exe) && fs.existsSync(path.join(dir, 'Uninstall Olive.exe')) && fs.existsSync(path.join(dir, 'resources', 'app', 'src', 'main', 'win-audio.exe')), dir);
    check('nothing is left beside it', !fs.existsSync(dir + '.new') && !fs.existsSync(dir + '.old'), 'no .new or .old folder');
    const version = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exe}').VersionInfo.ProductName + ' ' + (Get-Item -LiteralPath '${exe}').VersionInfo.FileVersion`], { encoding: 'utf8' }).trim();
    check('the exe has the right details', version.startsWith(`Olive ${pkg.version}`), version);
    check('Start menu shortcut works', fs.existsSync(startMenu) && shortcutTarget(startMenu).toLowerCase() === exe.toLowerCase(), startMenu.split('\\').slice(-1)[0]);
    check('desktop shortcut when asked for', fs.existsSync(desktop) && shortcutTarget(desktop).toLowerCase() === exe.toLowerCase(), 'present');
    const entry = reg('query', UNINSTALL) || '';
    check('it appears in Windows installed apps', entry.includes(`Olive${TAG}`) && entry.includes(pkg.version) && entry.includes('Uninstall Olive.exe'), `version ${pkg.version}`);
    const login = reg('query', RUN, '/v', LOGIN) || '';
    check('Start with Windows follows the new location', login.includes(exe) && login.includes('--hidden') && !login.includes('old-place'), 'repointed');

    console.log('\nOpening it, then upgrading while it runs');
    const profile = path.join(temp, 'profile');
    const running = spawn(exe, [`--user-data-dir=${profile}`, '--hidden', '--mute-audio'], { stdio: 'ignore', detached: true });
    running.unref();
    let count = '0';
    for (let i = 0; i < 30 && count === '0'; i++) { await sleep(500); count = procs(); }
    await sleep(3000);
    check('the installed app starts', count !== '0', `${count} processes`);
    fs.writeFileSync(path.join(dir, 'left-over-from-old-version.txt'), 'x');
    const again = runSetup();
    check('upgrading works while it is running', again.code === 0, `exit ${again.code} ${again.log}`);
    check('the old version is fully replaced', !fs.existsSync(path.join(dir, 'left-over-from-old-version.txt')) && fs.existsSync(exe), 'old files gone');
    check('it was closed for the upgrade', procs() === '0', 'no copy left running');
    check('no desktop shortcut is added unasked', fs.existsSync(desktop), 'the earlier one stays');

    console.log('\nUninstalling');
    fs.mkdirSync(settings, { recursive: true });
    fs.writeFileSync(path.join(settings, 'keep.txt'), 'x');
    let u = spawnSync(path.join(dir, 'Uninstall Olive.exe'), ['--silent', '--tag', TAG], { timeout: 60000 });
    for (let i = 0; i < 60 && fs.existsSync(dir); i++) await sleep(500);
    check('the app folder is removed', u.status === 0 && !fs.existsSync(dir), `exit ${u.status}`);
    check('shortcuts are removed', !fs.existsSync(startMenu) && !fs.existsSync(desktop), 'gone');
    check('it leaves Windows installed apps', reg('query', UNINSTALL) === null, 'gone');
    check('Start with Windows is removed', reg('query', RUN, '/v', LOGIN) === null, 'gone');
    check('settings stay unless you ask', fs.existsSync(path.join(settings, 'keep.txt')), 'kept');

    runSetup();
    u = spawnSync(path.join(dir, 'Uninstall Olive.exe'), ['--silent', '--tag', TAG, '--remove-settings'], { timeout: 60000 });
    for (let i = 0; i < 60 && (fs.existsSync(dir) || fs.existsSync(settings)); i++) await sleep(500);
    check('settings go when you ask', !fs.existsSync(settings) && !fs.existsSync(dir), 'gone');
  } catch (err) {
    check('the test finished', false, err.message);
  }
  for (const [key, name] of [[RUN, LOGIN], [APPROVED, LOGIN]]) reg('delete', key, '/v', name, '/f');
  reg('delete', UNINSTALL, '/f');
  for (const f of [startMenu, desktop]) fs.rmSync(f, { force: true });
  fs.rmSync(settings, { recursive: true, force: true });
  await sleep(1000);
  fs.rmSync(temp, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
  const failed = results.filter(ok => !ok).length;
  console.log(`\n${results.length - failed} of ${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
})();
