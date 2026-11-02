// Compiles src/main/win-audio.cs to win-audio.exe with the C# compiler built into Windows.
// Runs before "npm start" and "npm run build". If it can't, the app falls back to win-audio.ps1, so this never stops anything.
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const dir = path.join(__dirname, '..', 'src', 'main');
const source = path.join(dir, 'win-audio.cs'), exe = path.join(dir, 'win-audio.exe');
const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');

function buildHelper() {
  if (process.platform !== 'win32') return;
  if (fs.existsSync(exe) && fs.statSync(exe).mtimeMs >= fs.statSync(source).mtimeMs) return;
  if (!fs.existsSync(csc)) { console.warn('C# compiler not found: the app will use the PowerShell helper.'); return; }
  try {
    execFileSync(csc, ['/nologo', '/optimize+', '/target:exe', '/r:System.Management.dll', '/out:' + exe, source], { stdio: 'pipe' });
    console.log('Built helper -> ' + path.relative(path.join(__dirname, '..'), exe));
  } catch (err) {
    console.warn('Could not build the helper, so the app will use the PowerShell one: ' + String(err.stdout || err.message).trim());
  }
}

if (require.main === module) buildHelper();
module.exports = { buildHelper };
