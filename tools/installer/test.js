// Runs the real installer and uninstaller end to end, and an update from inside Olive: npm run test:installer
// Everything is kept apart from a real install: its own temp folder, and a test name on every shortcut and registry value. Your Olive isn't touched.
// The test copy's window opens for a moment when it reopens after its update. Takes about 2 minutes.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const crypto = require('crypto');
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

// ---- Updating from inside Olive ----
// The installed test copy is offered a made-up release 99.0.0 from a server on this PC (allowed for test copies only),
// whose installer is this same installer. Clicking Install must download it, check it, close Olive, install, and reopen it.
const CDP = 9461;
async function page(timeoutMs = 60000) {
  let seen = 'nothing on the port';
  for (const end = Date.now() + timeoutMs; Date.now() < end; await sleep(300)) {
    try {
      const all = await (await fetch(`http://127.0.0.1:${CDP}/json`)).json();
      seen = all.map(x => `${x.type} ${x.url}`).join(', ') || 'no targets';
      const t = all.find(x => x.type === 'page' && /index\.html/.test(x.url));
      if (!t) continue;
      const ws = new WebSocket(t.webSocketDebuggerUrl);
      await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; });
      let seq = 0; const waiting = new Map();
      ws.onmessage = m => { const d = JSON.parse(m.data), cb = waiting.get(d.id); if (cb) { waiting.delete(d.id); cb(d.result); } };
      ws.onclose = () => { for (const cb of waiting.values()) cb({ closed: true }); waiting.clear(); };
      const run = expression => new Promise(r => { const id = ++seq; waiting.set(id, r); ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } })); })
        .then(r => {
          if (r.closed) return undefined;
          if (r.exceptionDetails) throw new Error('in the page: ' + JSON.stringify(r.exceptionDetails).slice(0, 300));
          return r.result && r.result.value;
        });
      // The page exists before its script has run: wait for the app itself.
      if (!(await until(() => run(`document.readyState === 'complete' && typeof checkUpdates === 'function'`).catch(err => { seen = err.message; return false; }), 30000))) { ws.close(); continue; }
      await sleep(1000);
      return { run, close: () => ws.close() };
    } catch (err) { seen = err.message + (err.cause ? ' (' + (err.cause.code || err.cause.message) + ')' : ''); }
  }
  throw new Error(`the installed copy never opened its page (${seen})`);
}
const until = async (fn, ms) => { for (const end = Date.now() + ms; Date.now() < end; await sleep(300)) { const v = await fn(); if (v) return v; } return null; };
const mainPid = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-CimInstance Win32_Process -Filter "Name='Olive.exe'" | Where-Object { $_.ExecutablePath -like '${dir}\\*' -and $_.CommandLine -notmatch '--type=' } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }) -join '|'`], { encoding: 'utf8' }).trim();
const stopCopies = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', `Get-Process Olive -ErrorAction SilentlyContinue | Where-Object { $_.Path -like '${dir}\\*' } | Stop-Process -Force; exit 0`]);

async function updateChecks(exe, profile) {
  console.log('\nUpdating from inside Olive');
  const body = fs.readFileSync(setup), sha = crypto.createHash('sha256').update(body).digest('hex');
  const tampered = Buffer.from(body); tampered[tampered.length - 100] ^= 1;
  let served = tampered, downloads = 0;
  const server = http.createServer((req, res) => {
    const base = `http://127.0.0.1:${server.address().port}`;
    if (req.url === '/latest') {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ tag_name: 'v99.0.0', html_url: `${base}/release`, assets: [{ name: 'Olive-Setup-99.0.0.exe', size: body.length, digest: 'sha256:' + sha, browser_download_url: `${base}/Olive-Setup-99.0.0.exe` }] }));
    } else if (req.url === '/Olive-Setup-99.0.0.exe') {
      downloads++;
      res.setHeader('content-length', served.length);
      res.end(served);
    } else { res.statusCode = 404; res.end(); }
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const env = { ...process.env, OLIVE_TEST_UPDATE_FEED: `http://127.0.0.1:${server.address().port}/latest`, OLIVE_TEST_INSTALL_TAG: TAG };
  const marker = path.join(dir, 'left-over-before-the-update.txt');
  let p = null;
  try {
    spawn(exe, [`--user-data-dir=${profile}`, '--hidden', '--mute-audio', `--remote-debugging-port=${CDP}`], { stdio: 'ignore', detached: true, env }).unref();
    p = await page();
    await p.run('checkUpdates(true)');
    const offer = await p.run(`({ hint: $('updateHint').textContent, button: $('updateBtn').textContent, notes: !$('updateNotes').hidden })`);
    check('an installed copy offers Install', /99\.0\.0 is available/.test(offer.hint) && offer.button === 'Install' && offer.notes, `"${offer.hint}", button "${offer.button}"`);

    fs.writeFileSync(marker, 'x');
    const pidBefore = mainPid();
    await p.run(`$('updateBtn').click()`);
    const refusal = await until(() => p.run(`/^Couldn't update/.test($('updateHint').textContent) && $('updateHint').textContent`), 60000);
    await sleep(2000);
    check('a download that fails its checksum is never run', /doesn't match/.test(refusal || '') && mainPid() === pidBefore && fs.existsSync(marker), `"${refusal}", still running, nothing installed`);

    served = body;
    await p.run(`$('updateBtn').click()`);
    const progress = await until(() => p.run(`/Downloading… \\d+%|Installing/.test($('updateHint').textContent) && $('updateHint').textContent`), 30000);
    p.close(); p = null;
    const t0 = Date.now();
    const relaunched = await until(() => { const now = mainPid(); return now && now !== pidBefore && now.includes('--updated') ? now : null; }, 120000);
    check('Install closes Olive, installs, and opens it again', !!relaunched && !fs.existsSync(marker), relaunched ? `back in ${Math.round((Date.now() - t0) / 1000)} s, old files replaced (saw "${progress}")` : 'it did not come back');
    // Windows hands a new process the open handles of the one that started it. Its debugging port shows whether the
    // new copy still holds anything of the old one: an inherited listening socket would sit on it and never answer.
    const newPid = relaunched ? relaunched.split(' ')[0] : '';
    const listeners = () => execFileSync('powershell.exe', ['-NoProfile', '-Command', `@(Get-NetTCPConnection -LocalPort ${CDP} -State Listen -ErrorAction SilentlyContinue | ForEach-Object OwningProcess | Sort-Object -Unique) -join ','`], { encoding: 'utf8' }).trim();
    const owners = (await until(() => { const o = listeners(); return o === newPid ? o : null; }, 15000)) || listeners();
    check('the reopened copy holds nothing of the old one', owners === newPid, `port ${CDP} is held by ${owners || 'nobody'}, the new copy is ${newPid}`);
    p = await page();
    const after = await until(() => p.run(`/Updated to Olive/.test($('updateHint').textContent) && ({ hint: $('updateHint').textContent, notice: $('appNotice').textContent, hidden: document.hidden })`), 20000);
    const version = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${exe}').VersionInfo.FileVersion`], { encoding: 'utf8' }).trim();
    check('it says it was updated, with its settings folder and window back', after && after.hint === `Updated to Olive ${pkg.version}` && !after.notice && relaunched.includes(profile) && !relaunched.includes('--hidden'), after ? `"${after.hint}", exe ${version}` : 'no message');
    check('the downloaded installer is checked before running: one bad, one good download', downloads === 2, `${downloads} downloads`);

    // A failed install: something holds the folder the installer unpacks into. The old copy must come back and say so.
    fs.writeFileSync(marker, 'x');
    const stale = dir + '.new';
    fs.mkdirSync(stale, { recursive: true });
    const lockFile = path.join(stale, 'locked.txt');
    fs.writeFileSync(lockFile, 'x');
    const holder = spawn('powershell.exe', ['-NoProfile', '-Command', `$f = [IO.File]::Open('${lockFile}', 'Open', 'Read', 'None'); Start-Sleep -Seconds 40; $f.Close()`], { stdio: 'ignore' });
    await sleep(1500);
    await p.run('checkUpdates(true)');
    await p.run(`$('updateBtn').click()`);
    p.close(); p = null;
    const pidUpdated = relaunched;
    const back = await until(() => { const now = mainPid(); return now && now !== pidUpdated ? now : null; }, 120000);
    p = back ? await page() : null;
    const notice = p ? await until(() => p.run(`$('appNotice').textContent`), 20000) : null;
    holder.kill();
    check('a failed install brings the old copy back, and says why', !!back && fs.existsSync(marker) && /couldn't be installed/.test(notice || '') && /used by another process/i.test(notice || ''), `"${notice}"`);
  } finally {
    if (p) p.close();
    server.close();
    stopCopies();
    await sleep(1500);
    fs.rmSync(dir + '.new', { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
}

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

    await updateChecks(exe, profile);

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
