// Writes the app name, version and icon into dist/MicManager/MicManager.exe
// (what Task Manager, Explorer and the taskbar show). Close the app first. Needs: npm install
const fs = require('fs');
const path = require('path');
const R = require('resedit');

const root = path.join(__dirname, '..');
const exePath = path.join(root, 'dist', 'MicManager', 'MicManager.exe');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const [maj, min, pat] = pkg.version.split('.').map(Number);

const exe = R.NtExecutable.from(fs.readFileSync(exePath), { ignoreCert: true });
const res = R.NtExecutableResource.from(exe);
const icon = R.Data.IconFile.from(fs.readFileSync(path.join(root, 'assets', 'icon.ico')));
const group = res.entries.find(e => e.type === 14);
R.Resource.IconGroupEntry.replaceIconsForResource(res.entries, group.id, group.lang, icon.icons.map(i => i.data));
const vi = R.Resource.VersionInfo.fromEntries(res.entries)[0];
const lang = vi.getAllLanguagesForStringValues()[0];
vi.setStringValues(lang, {
  FileDescription: 'Mic Manager', ProductName: 'Mic Manager', CompanyName: '',
  InternalName: 'MicManager', OriginalFilename: 'MicManager.exe',
  FileVersion: pkg.version, ProductVersion: pkg.version
});
vi.setFileVersion(maj, min, pat, 0, lang.lang);
vi.setProductVersion(maj, min, pat, 0, lang.lang);
vi.outputToResourceEntries(res.entries);
res.outputResource(exe);
fs.writeFileSync(exePath, Buffer.from(exe.generate()));
console.log(`Patched ${path.relative(root, exePath)}: Mic Manager ${pkg.version}, icon from assets/icon.ico`);
