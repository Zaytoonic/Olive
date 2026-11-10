// npm run preview: opens this source's window next to your installed Olive, safely, to try a change.
// - Its own profile (%LOCALAPPDATA%\olive-preview), so the two copies never share settings or a single-instance lock.
// - Starts from a copy of your Olive's settings, read (never written) from its profile.
// - Send to Discord is forced off, so Discord never hears you twice. The mute hotkey, push to talk, the Muted badge
//   and update checks are off too: your Olive keeps those. Volume and Mute still act on the real Windows mic.
// It first starts muted and checks that Send really is off; only then does it open the copy with sound.
const { spawn, execFileSync } = require('child_process'), fs = require('fs'), path = require('path');

const root = path.join(__dirname, '..');
const exe = require(path.join(root, 'node_modules', 'electron'));
const profile = path.join(process.env.LOCALAPPDATA || path.join(root, 'dist'), 'olive-preview');
const PORT = 9361, KEY = 'olive.settings.v1', sleep = ms => new Promise(r => setTimeout(r, ms));
const SAFE = { send: false, muteHotkey: false, ptt: false, badge: false, updateAuto: false, setupDone: true };

// The newest saved settings in your Olive's localStorage files (they're plain JSON inside LevelDB's files).
function realSettings() {
  try {
    const dir = path.join(process.env.APPDATA, 'olive', 'Local Storage', 'leveldb');
    const files = fs.readdirSync(dir).filter(f => /\.(log|ldb)$/.test(f)).map(f => path.join(dir, f)).sort((a, b) => fs.statSync(a).mtimeMs - fs.statSync(b).mtimeMs);
    let best = null;
    for (const f of files) {
      const raw = fs.readFileSync(f).toString('latin1');
      for (let i = raw.indexOf(KEY); i >= 0; i = raw.indexOf(KEY, i + 1)) {
        const s = raw.indexOf('{', i);
        if (s < 0 || s - i > 40) continue;
        let depth = 0, e = -1;
        for (let k = s; k < raw.length; k++) { if (raw[k] === '{') depth++; else if (raw[k] === '}' && !--depth) { e = k; break; } }
        if (e > 0) try { best = JSON.parse(raw.slice(s, e + 1)); } catch { /* a half-written record */ }
      }
    }
    return best;
  } catch { return null; }
}

async function connect() {
  for (let i = 0; i < 120; i++) {
    try {
      const t = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find(x => x.type === 'page' && /index\.html/.test(x.url));
      if (t) {
        const ws = new WebSocket(t.webSocketDebuggerUrl);
        await new Promise((a, b) => { ws.onopen = a; ws.onerror = b; });
        let id = 0; const pending = new Map();
        ws.onmessage = m => { const d = JSON.parse(m.data); if (d.id && pending.has(d.id)) { pending.get(d.id)(d.result); pending.delete(d.id); } };
        const call = (method, params = {}) => new Promise(r => { const n = ++id; pending.set(n, r); ws.send(JSON.stringify({ id: n, method, params })); });
        const run = async expression => { const r = await call('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true }); return r && r.result ? r.result.value : undefined; };
        return { ws, call, run };
      }
    } catch { /* not up yet */ }
    await sleep(250);
  }
  throw new Error("the preview window didn't open");
}
const kill = pid => { try { execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* already gone */ } };
const check = `(() => { try { return JSON.stringify({ send: olive.state.send, sendOn: olive.getView().sendOn, mic: olive.state.deviceId, saved: JSON.parse(localStorage.getItem('${KEY}')).send }); } catch (e) { return 'not ready: ' + e.message; } })()`;

(async () => {
  if (!fs.existsSync(path.join(root, 'src', 'renderer', 'ui', 'olive.js'))) throw new Error('the window is not built: run npm run build:ui');
  const settings = { ...(realSettings() || {}), ...SAFE };
  console.log(realSettings() ? 'Using a copy of your Olive settings, with Send to Discord off.' : "Couldn't read your Olive settings; starting fresh, with Send to Discord off.");
  fs.mkdirSync(profile, { recursive: true });
  // 1. Muted: put the settings in place before the page's own script runs, then confirm Send is off.
  const muted = spawn(exe, ['.', `--user-data-dir=${profile}`, '--mute-audio', '--hidden', `--remote-debugging-port=${PORT}`], { cwd: root, stdio: 'ignore' });
  let p = await connect();
  await p.call('Page.enable');
  await p.call('Page.addScriptToEvaluateOnNewDocument', { source: `try { localStorage.setItem(${JSON.stringify(KEY)}, ${JSON.stringify(JSON.stringify(settings))}); } catch {}` });
  await p.call('Page.reload', { ignoreCache: true });
  await sleep(4000);
  const first = await p.run(check);
  await sleep(2500);                          // give Chromium time to write the settings to disk
  p.ws.close(); kill(muted.pid); await sleep(1500);
  if (!/"send":false,"sendOn":false/.test(first || '')) throw new Error('Send was not off in the muted check, so the preview was not opened: ' + first);
  // 2. With sound, the way you'll use it. Checked again before leaving it running.
  const live = spawn(exe, ['.', `--user-data-dir=${profile}`, `--remote-debugging-port=${PORT}`], { cwd: root, stdio: 'ignore', detached: true });
  live.unref();
  p = await connect();
  await sleep(3000);
  const second = await p.run(check);
  p.ws.close();
  if (!/"send":false,"sendOn":false/.test(second || '')) { kill(live.pid); throw new Error('Send was not off after the restart, so the preview was closed: ' + second); }
  console.log('Preview open, Send to Discord off. Close it from its tray icon (right-click > Quit) when you are done.');
  process.exit(0);
})().catch(err => { console.error('Preview not opened: ' + err.message); process.exit(1); });
