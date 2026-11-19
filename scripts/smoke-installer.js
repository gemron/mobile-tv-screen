'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync, execFile } = require('child_process');
const run = require('util').promisify(execFile);
const root = path.resolve(__dirname, '..');
const release = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'latest-release.json'), 'utf8'));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV installer check '));
const installDir = path.join(sandbox, 'Installed MobileTV');
const registryKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{7D611C6C-516B-49A9-A739-4C143B22A5B3}_is1';
const online = process.argv.includes('--online');
let installed = false, passed = false, mirror;

function registered() {
  try { execFileSync('reg.exe', ['query', registryKey], { windowsHide: true, stdio: 'ignore' }); return true; } catch { return false; }
}
function uninstall() {
  const uninstaller = path.join(installDir, 'unins000.exe');
  if (fs.existsSync(uninstaller)) execFileSync(uninstaller, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=' + path.join(sandbox, 'uninstall.log')], { windowsHide: true, timeout: 120000 });
}

async function main() {
  assert.ok(release.installer && fs.existsSync(release.installer), 'Build the installer first');
  assert.equal(registered(), false, 'An installed copy with this AppId already exists; refuse to change its registration');
  const args = ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NOICONS', '/DIR=' + installDir];
  const options = { windowsHide: true, timeout: 240000 };
  let downloads = 0;
  if (online) {
    mirror = http.createServer((req, res) => {
      if (req.url === '/corrupt') { res.end('incorrect installer'); return; }
      if (req.url !== '/setup.exe') { res.writeHead(404).end(); return; }
      downloads++;
      res.writeHead(200, { 'Content-Length': fs.statSync(release.installer).size });
      fs.createReadStream(release.installer).pipe(res);
    });
    await new Promise((resolve, reject) => mirror.once('error', reject).listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + mirror.address().port;
    const log = path.join(sandbox, 'corrupt.log');
    await assert.rejects(run(release.onlineInstaller, [...args, '/SOURCE=' + base + '/corrupt', '/LOG=' + log], options),
      error => Number.isInteger(error.code) && error.code > 0);
    assert.match(fs.readFileSync(log, 'utf8'), /file hash is incorrect/i);
    assert.equal(registered(), false);
    assert.equal(fs.existsSync(path.join(installDir, 'MobileTV.exe')), false);
    console.log('PASS: online installer rejects a corrupt download before installing');
    args.push('/SOURCE=' + base + '/setup.exe');
  }
  // The previous Electron distribution shipped af.pak. Exercise upgrade cleanup.
  fs.mkdirSync(path.join(installDir, 'locales'), { recursive: true });
  fs.writeFileSync(path.join(installDir, 'locales', 'af.pak'), 'old locale');
  installed = true;
  await run(online ? release.onlineInstaller : release.installer, [...args, '/LOG=' + path.join(sandbox, 'install.log')], options);
  if (online) assert.ok(downloads > 0, 'Downloaded the payload from the mirror');
  assert.ok(fs.existsSync(path.join(installDir, 'MobileTV.exe')));
  assert.equal(registered(), true);
  console.log('PASS: current-user installer installs into an isolated temporary directory');
  execFileSync(process.execPath, [path.join(__dirname, 'smoke-release.js'), '--folder', installDir], { cwd: root, stdio: 'inherit', windowsHide: true, timeout: 120000 });
  uninstall();
  installed = false;
  assert.equal(fs.existsSync(path.join(installDir, 'MobileTV.exe')), false);
  assert.equal(registered(), false);
  console.log('PASS: installed application runs independently and uninstalls cleanly');
  passed = true;
}
main().catch(error => {
  console.error(error.stack || error);
  console.error('Installer diagnostics:', sandbox);
  process.exitCode = 1;
}).finally(() => {
  if (mirror) mirror.close();
  if (installed) { try { uninstall(); } catch (error) { console.error('Test uninstall failed:', error.message); } }
  if (passed) {
    const target = fs.realpathSync(sandbox);
    assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(target).startsWith('MobileTV installer check '));
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      // Inno's temporary self-deleting uninstaller can briefly retain a handle.
      // Successful program and registry removal were asserted above; retained
      // diagnostic files must not turn that successful test into a failure.
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
      console.log('Temporary installer logs retained at ' + target);
    }
  }
});
