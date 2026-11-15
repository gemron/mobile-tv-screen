'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const manifestPath = path.join(root, 'dist', 'latest-release.json');

async function sha256(file) {
  const hash = crypto.createHash('sha256');
  for await (const chunk of fs.createReadStream(file)) hash.update(chunk);
  return hash.digest('hex');
}

async function main() {
  if (process.platform !== 'win32') throw new Error('Windows is required to build the installer.');
  const release = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (release.version !== pkg.version) throw new Error('Run npm run build:win for the current version first.');
  const compiler = process.env.ISCC_PATH || path.join(root, 'build', 'tools', 'inno', 'ISCC.exe');
  if (!fs.existsSync(compiler)) throw new Error('Prepare Inno Setup 7 with scripts/prepare-build-tools.ps1 or set ISCC_PATH.');
  const icon = path.join(root, 'build', path.basename(release.folder), 'MobileTV.ico');
  const outputDir = path.join(root, 'dist');
  execFileSync(compiler, ['/Qp', `/DAppVersion=${pkg.version}`, `/DSourceDir=${release.folder}`, `/DOutputDir=${outputDir}`, `/DProjectRoot=${root}`, `/DAppIcon=${icon}`, path.join(root, 'packaging', 'installer.iss')], { stdio: 'inherit', windowsHide: true, timeout: 300000 });
  const installer = path.join(outputDir, `MobileTV-${pkg.version}-Setup-x64.exe`);
  const checksum = await sha256(installer);
  const sums = path.join(outputDir, 'SHA256SUMS.txt');
  fs.writeFileSync(installer + '.sha256', `${checksum}  ${path.basename(installer)}\n`);
  fs.writeFileSync(sums, `${release.zipSha256}  ${path.basename(release.zip)}\n${checksum}  ${path.basename(installer)}\n`);
  Object.assign(release, { installer, installerSha256: checksum, checksums: sums });
  fs.writeFileSync(manifestPath, JSON.stringify(release, null, 2) + '\n');
  console.log(JSON.stringify({ installer, sizeMiB: +(fs.statSync(installer).size / 1048576).toFixed(1), sha256: checksum, checksums: sums }, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
