// Code-signs files if a certificate is set up, so Windows can show who made Olive. Without one this does nothing, and the app works the same.
// Set one of these before running "npm run installer":
//   OLIVE_SIGN_COMMAND     your signing tool's command with {file} where the file goes, for a cloud signing service or USB token
//   OLIVE_SIGN_THUMBPRINT  the thumbprint of a certificate in your Windows certificate store
//   OLIVE_SIGN_TIMESTAMP   optional timestamp server for the thumbprint route, or "none" to skip it
const { execSync, execFileSync } = require('child_process');

const SCRIPT = `
$cert = Get-Item ("Cert:\\CurrentUser\\My\\" + $env:OLIVE_SIGN_THUMBPRINT) -ErrorAction Stop
$options = @{ FilePath = $env:OLIVE_SIGN_FILE; Certificate = $cert; HashAlgorithm = 'SHA256' }
if ($env:OLIVE_SIGN_TIMESTAMP -ne 'none') { $options.TimestampServer = $(if ($env:OLIVE_SIGN_TIMESTAMP) { $env:OLIVE_SIGN_TIMESTAMP } else { 'http://timestamp.digicert.com' }) }
$result = Set-AuthenticodeSignature @options
if (-not $result.SignerCertificate) { throw $result.StatusMessage }
`;

const isConfigured = () => !!(process.env.OLIVE_SIGN_COMMAND || process.env.OLIVE_SIGN_THUMBPRINT);

function sign(file) {
  if (process.env.OLIVE_SIGN_COMMAND) {
    execSync(process.env.OLIVE_SIGN_COMMAND.split('{file}').join(`"${file}"`), { stdio: 'inherit' });
  } else {
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', SCRIPT], { env: { ...process.env, OLIVE_SIGN_FILE: file }, stdio: ['ignore', 'ignore', 'inherit'] });
  }
}

if (require.main === module) {
  if (!isConfigured()) { console.log('No certificate set up, so nothing was signed. See the top of tools/sign.js.'); process.exit(0); }
  for (const file of process.argv.slice(2)) { sign(file); console.log('Signed ' + file); }
}
module.exports = { isConfigured, sign };
