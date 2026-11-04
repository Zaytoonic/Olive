// Builds dist/Olive-Setup-<version>.exe from dist/Olive: npm run installer
// Uses the C# compiler in Windows, so there is nothing extra to install. Run "npm run build" and "npm run patch-exe" first.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { isConfigured, sign } = require('./sign');

const root = path.join(__dirname, '..');
const dist = path.join(root, 'dist'), app = path.join(dist, 'Olive'), work = path.join(dist, 'installer-work'), source = path.join(__dirname, 'installer');
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const stop = message => { console.error(message); process.exit(1); };

if (!fs.existsSync(path.join(app, 'Olive.exe'))) stop('dist/Olive/Olive.exe not found. Run npm run update-runtime, npm run build and npm run patch-exe first.');
if (!fs.existsSync(csc)) stop('The C# compiler in Windows was not found: ' + csc);
for (const f of ['src/main/main.js', 'src/renderer/renderer.js', 'src/renderer/index.html', 'package.json']) {
  const built = path.join(app, 'resources', 'app', f);
  if (f === 'package.json') {
    if (!fs.existsSync(built) || JSON.parse(fs.readFileSync(built, 'utf8')).version !== pkg.version) stop('dist/Olive is not this version. Run npm run build and npm run patch-exe first.');
  } else if (!fs.existsSync(built) || !fs.readFileSync(built).equals(fs.readFileSync(path.join(root, f)))) stop(`dist/Olive is out of date (${f}). Run npm run build first.`);
}
const fileVersion = execFileSync('powershell.exe', ['-NoProfile', '-Command', `(Get-Item -LiteralPath '${path.join(app, 'Olive.exe')}').VersionInfo.FileVersion`], { encoding: 'utf8' }).trim();
if (!fileVersion.startsWith(pkg.version)) stop(`Olive.exe says version ${fileVersion}, not ${pkg.version}. Quit Olive and run npm run patch-exe first.`);

fs.rmSync(work, { recursive: true, force: true });
fs.mkdirSync(work, { recursive: true });
try {
  if (isConfigured()) {
    sign(path.join(app, 'Olive.exe'));
    sign(path.join(app, 'resources', 'app', 'src', 'main', 'win-audio.exe'));
  }

  const zip = path.join(work, 'payload.zip');
  execFileSync(path.join(process.env.WINDIR, 'System32', 'tar.exe'), ['-a', '-c', '-f', zip, '-C', dist, 'Olive'], { stdio: 'inherit' });

  const version = path.join(work, 'version.cs');
  fs.writeFileSync(version, `using System.Reflection;
[assembly: AssemblyProduct("Olive")]
[assembly: AssemblyCopyright("Copyright (C) 2026 Zaytoon")]
[assembly: AssemblyVersion("${pkg.version}.0")]
[assembly: AssemblyFileVersion("${pkg.version}.0")]
namespace OliveSetup { static class Build { public const string Version = "${pkg.version}"; } }
`);
  const common = ['/nologo', '/optimize+', '/platform:x64', '/target:winexe', `/win32icon:${path.join(root, 'assets', 'icon.ico')}`, '/r:System.Windows.Forms.dll'];
  const compile = (args, label) => {
    try { execFileSync(csc, args, { stdio: 'pipe', maxBuffer: 1 << 24 }); } catch (err) { stop(`Could not build the ${label}:\n` + String(err.stdout || err.message)); }
  };

  const uninstaller = path.join(work, 'uninstall.exe');
  compile([...common, `/out:${uninstaller}`, '/r:System.Drawing.dll', path.join(source, 'common.cs'), path.join(source, 'uninstall.cs'), version], 'uninstaller');
  if (isConfigured()) sign(uninstaller);

  const setup = path.join(dist, `Olive-Setup-${pkg.version}.exe`);
  compile([...common, `/out:${setup}`, '/r:System.Drawing.dll', '/r:System.IO.Compression.dll', '/r:System.IO.Compression.FileSystem.dll',
    `/resource:${zip},payload.zip`, `/resource:${uninstaller},uninstall.exe`, path.join(source, 'common.cs'), path.join(source, 'setup.cs'), version], 'installer');
  if (isConfigured()) sign(setup);

  console.log(`Built ${path.relative(root, setup)} (${Math.round(fs.statSync(setup).size / 1048576)} MB), ${isConfigured() ? 'signed' : 'not signed'}`);
} finally {
  fs.rmSync(work, { recursive: true, force: true });
}
