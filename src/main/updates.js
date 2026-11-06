// Asks GitHub for the latest release, and downloads its installer when you ask for it. Nothing is installed by itself.
const fs = require('fs');
const crypto = require('crypto');

// Where releases come from. Only a test copy of the app may point somewhere else (see main.js).
const GITHUB = {
  api: 'https://api.github.com/repos/Zaytoonic/olive/releases/latest',
  page: /^https:\/\/github\.com\/Zaytoonic\/[\w.-]+\/releases\/[\w./%-]+$/,
  asset: /^https:\/\/github\.com\/Zaytoonic\/[\w.-]+\/releases\/download\/[\w.-]+\/Olive-Setup-[\d.]+\.exe$/
};

const parse = v => {
  const m = /^v?(\d+)\.(\d+)(?:\.(\d+))?$/.exec(String(v || '').trim());
  return m ? [+m[1], +m[2], +(m[3] || 0)] : null;
};
function isNewer(candidate, current) {
  const a = parse(candidate), b = parse(current);
  if (!a || !b) return false;
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] > b[i];
  return false;
}

// The release's installer, only if GitHub gives its exact size and SHA-256, so the download can be checked before it runs.
function findInstaller(release, version, feed) {
  const want = `Olive-Setup-${version}.exe`;
  const a = (Array.isArray(release.assets) ? release.assets : []).find(x => x && x.name === want);
  if (!a || !feed.asset.test(String(a.browser_download_url))) return null;
  const digest = /^sha256:([0-9a-f]{64})$/i.exec(String(a.digest || ''));
  if (!digest || !Number.isSafeInteger(a.size) || a.size <= 0) return null;
  return { url: a.browser_download_url, size: a.size, sha256: digest[1].toLowerCase(), name: want };
}

async function checkForUpdate(current, fetchFn, feed = GITHUB) {
  let res;
  try {
    res = await fetchFn(feed.api, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Olive' }, signal: AbortSignal.timeout(10000) });
  } catch (err) {
    return { status: 'unavailable', reason: "can't reach GitHub" + (err && err.message ? ` (${err.message})` : '') };
  }
  if (res.status === 404) return { status: 'unavailable', reason: 'no public releases yet' };
  if (!res.ok) return { status: 'unavailable', reason: `GitHub answered ${res.status}` };
  let release;
  try { release = await res.json(); } catch { return { status: 'unavailable', reason: 'GitHub sent an unreadable reply' }; }
  if (!parse(release.tag_name)) return { status: 'unavailable', reason: 'the latest release has no version number' };
  if (!isNewer(release.tag_name, current)) return { status: 'current' };
  if (!feed.page.test(String(release.html_url))) return { status: 'unavailable', reason: 'the release link looks wrong' };
  const version = String(release.tag_name).replace(/^v/, '');
  return { status: 'available', version, url: release.html_url, installer: findInstaller(release, version, feed) };
}

// Downloads to <dest>.part, then checks the size and SHA-256 against GitHub's before naming it <dest>.
// Gives up if no data arrives for 30 s. onProgress gets 0..1.
async function downloadInstaller(installer, fetchFn, dest, onProgress = () => {}) {
  const part = dest + '.part', idle = new AbortController();
  let idleTimer = null;
  const stillGoing = () => { clearTimeout(idleTimer); idleTimer = setTimeout(() => idle.abort(new Error('the download stalled')), 30000); };
  let file = null;
  try {
    stillGoing();
    const res = await fetchFn(installer.url, { headers: { 'user-agent': 'Olive' }, signal: idle.signal });
    if (!res.ok || !res.body) throw new Error(`GitHub answered ${res.status}`);
    file = await fs.promises.open(part, 'w');
    const hash = crypto.createHash('sha256'), reader = res.body.getReader();
    let got = 0, shown = -1;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      stillGoing();
      got += value.length;
      if (got > installer.size) throw new Error('the download is bigger than GitHub said');
      hash.update(value);
      await file.write(value);
      const pct = Math.floor(got / installer.size * 100);
      if (pct !== shown) { shown = pct; onProgress(got / installer.size); }
    }
    await file.close(); file = null;
    if (got !== installer.size) throw new Error('the download was cut short');
    if (hash.digest('hex') !== installer.sha256) throw new Error("the download doesn't match the release, so it wasn't used");
    await fs.promises.rm(dest, { force: true });
    await fs.promises.rename(part, dest);
    return dest;
  } catch (err) {
    if (file) await file.close().catch(() => {});
    await fs.promises.rm(part, { force: true }).catch(() => {});
    throw err;
  } finally {
    clearTimeout(idleTimer);
  }
}

module.exports = { GITHUB, isNewer, checkForUpdate, downloadInstaller };
