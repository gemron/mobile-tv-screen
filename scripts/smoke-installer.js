'use strict';
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const release = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'latest-release.json'), 'utf8'));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV installer check '));
const installDir = path.join(sandbox, 'Installed MobileTV');
const registryKey = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\{7D611C6C-516B-49A9-A739-4C143B22A5B3}_is1';
let installed = false, passed = false;

function registered() {
  try { execFileSync('reg.exe', ['query', registryKey], { windowsHide: true, stdio: 'ignore' }); return true; } catch { return false; }
}
function uninstall() {
  const uninstaller = path.join(installDir, 'unins000.exe');
  if (fs.existsSync(uninstaller)) execFileSync(uninstaller, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/LOG=' + path.join(sandbox, 'uninstall.log')], { windowsHide: true, timeout: 120000 });
}

try {
  assert.ok(release.installer && fs.existsSync(release.installer), 'Build the installer first');
  assert.equal(registered(), false, 'An installed copy with this AppId already exists; refuse to change its registration');
  execFileSync(release.installer, ['/VERYSILENT', '/SUPPRESSMSGBOXES', '/NORESTART', '/SP-', '/NOICONS', '/DIR=' + installDir, '/LOG=' + path.join(sandbox, 'install.log')], { windowsHide: true, timeout: 180000 });
  installed = true;
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
} catch (error) {
  console.error(error.stack || error);
  console.error('Installer diagnostics:', sandbox);
  process.exitCode = 1;
} finally {
  if (installed) { try { uninstall(); } catch (error) { console.error('Test uninstall failed:', error.message); } }
  if (passed) {
    const target = fs.realpathSync(sandbox);
    assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(target).startsWith('MobileTV installer check '));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 });
  }
}
