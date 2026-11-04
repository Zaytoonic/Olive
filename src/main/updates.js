// Asks GitHub for the latest release. It only tells you a new version exists: nothing is downloaded or installed.
const REPO = 'Zaytoonic/olive';
const API = `https://api.github.com/repos/${REPO}/releases/latest`;
const RELEASE_PAGE = /^https:\/\/github\.com\/Zaytoonic\/[\w.-]+\/releases\/[\w./%-]+$/;

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

async function checkForUpdate(current, fetchFn) {
  let res;
  try {
    res = await fetchFn(API, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'Olive' }, signal: AbortSignal.timeout(10000) });
  } catch (err) {
    return { status: 'unavailable', reason: "can't reach GitHub" + (err && err.message ? ` (${err.message})` : '') };
  }
  if (res.status === 404) return { status: 'unavailable', reason: 'no public releases yet' };
  if (!res.ok) return { status: 'unavailable', reason: `GitHub answered ${res.status}` };
  let release;
  try { release = await res.json(); } catch { return { status: 'unavailable', reason: 'GitHub sent an unreadable reply' }; }
  if (!parse(release.tag_name)) return { status: 'unavailable', reason: 'the latest release has no version number' };
  if (!isNewer(release.tag_name, current)) return { status: 'current' };
  if (!RELEASE_PAGE.test(String(release.html_url))) return { status: 'unavailable', reason: 'the release link looks wrong' };
  return { status: 'available', version: String(release.tag_name).replace(/^v/, ''), url: release.html_url };
}

module.exports = { isNewer, checkForUpdate };
