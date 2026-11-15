'use strict';

// Build from the installed, locked production dependencies; no global Node/npm is needed at runtime.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const pkg = require('../package.json');
const lock = require('../package-lock.json');
const dist = path.join(root, 'dist');
const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, '').replace('T', '-');
const name = `MobileTV-${pkg.version}-win-x64-${stamp}`;
const release = path.join(dist, name);
const psQuote = value => "'" + String(value).replace(/'/g, "''") + "'";
const run = (file, args, options = {}) => execFileSync(file, args, { encoding: 'utf8', windowsHide: true, ...options });
const write = (file, text) => fs.writeFileSync(file, text, 'utf8');
const copy = (from, to, options = {}) => { fs.mkdirSync(path.dirname(to), { recursive: true }); fs.cpSync(from, to, { recursive: true, ...options }); };
const hash = file => new Promise((resolve, reject) => {
  const digest = crypto.createHash('sha256');
  const stream = fs.createReadStream(file);
  stream.on('error', reject).on('data', chunk => digest.update(chunk)).on('end', () => resolve(digest.digest('hex')));
});

function createIcon(file) {
  const size = 64, pixels = Buffer.alloc(size * size * 4);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) {
    const i = ((size - 1 - y) * size + x) * 4;
    const dx = Math.max(7 - x, 0, x - 56), dy = Math.max(7 - y, 0, y - 56);
    if (dx * dx + dy * dy > 49) continue;
    let color = [16, 126, 100];
    const frame = x >= 12 && x <= 51 && y >= 16 && y <= 43 && (x <= 15 || x >= 48 || y <= 19 || y >= 40);
    const stand = y >= 44 && y <= 48 && x >= 29 && x <= 34 || y >= 49 && y <= 51 && x >= 24 && x <= 39;
    const arrow = y >= 25 && y <= 34 && x >= 27 && x <= 36 && Math.abs(y - 29.5) <= (36 - x) * 0.65;
    if (frame || stand || arrow) color = [255, 255, 255];
    pixels[i] = color[2]; pixels[i + 1] = color[1]; pixels[i + 2] = color[0]; pixels[i + 3] = 255;
  }
  const mask = Buffer.alloc(Math.ceil(size / 32) * 4 * size);
  const bmp = Buffer.alloc(40);
  bmp.writeUInt32LE(40, 0); bmp.writeInt32LE(size, 4); bmp.writeInt32LE(size * 2, 8);
  bmp.writeUInt16LE(1, 12); bmp.writeUInt16LE(32, 14); bmp.writeUInt32LE(pixels.length, 20);
  const header = Buffer.alloc(22);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(1, 4); header[6] = size; header[7] = size;
  header.writeUInt16LE(1, 10); header.writeUInt16LE(32, 12);
  header.writeUInt32LE(bmp.length + pixels.length + mask.length, 14); header.writeUInt32LE(22, 18);
  fs.writeFileSync(file, Buffer.concat([header, bmp, pixels, mask]));
}

async function main() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Build requires Windows x64 and an x64 Node.js runtime.');
  fs.mkdirSync(dist, { recursive: true });
  if (fs.existsSync(release)) throw new Error(`Build output already exists: ${release}`);
  fs.mkdirSync(release);
  console.log('Staging application and production dependencies...');
  const app = path.join(release, 'app');
  copy(path.join(root, 'src'), path.join(app, 'src'), { filter: source => !path.relative(path.join(root, 'src'), source).split(path.sep).includes('diagnostics') });
  copy(path.join(root, 'public'), path.join(app, 'public'));
  copy(path.join(root, 'package.json'), path.join(app, 'package.json'));
  copy(path.join(root, 'package-lock.json'), path.join(app, 'package-lock.json'));
  for (const file of ['README.md', 'LICENSE', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'SECURITY.md', 'CONTRIBUTING.md']) copy(path.join(root, file), path.join(release, file));
  copy(path.join(root, 'docs', 'images'), path.join(release, 'docs', 'images'));
  copy(path.join(root, 'docs', 'CONTENT_SOURCES.md'), path.join(release, 'docs', 'CONTENT_SOURCES.md'));
  const dependencies = [];
  for (const [relative, entry] of Object.entries(lock.packages)) {
    if (!relative.startsWith('node_modules/') || entry.dev) continue;
    const source = path.join(root, relative);
    if (!fs.existsSync(source)) { if (entry.optional) continue; throw new Error(`Missing locked dependency: ${relative}`); }
    copy(source, path.join(app, relative));
    dependencies.push({ name: relative.replace(/^node_modules\//, ''), version: entry.version, license: entry.license || 'See bundled package' });
  }
  const runtime = path.join(release, 'runtime', 'node.exe');
  copy(process.execPath, runtime);
  const preparedFfmpeg = path.join(root, 'build', 'tools', 'ffmpeg-8.0.1-full_build', 'bin', 'ffmpeg.exe');
  const ffmpegPath = fs.realpathSync(process.env.FFMPEG_PATH || (fs.existsSync(preparedFfmpeg) ? preparedFfmpeg : run('where.exe', ['ffmpeg.exe']).trim().split(/\r?\n/)[0]));
  const ffmpeg = path.join(release, 'tools', 'ffmpeg.exe');
  copy(ffmpegPath, ffmpeg);
  const ffmpegVersion = run(ffmpeg, ['-version']).split(/\r?\n/)[0];
  const ffmpegRoot = path.dirname(path.dirname(ffmpegPath));
  for (const [source, target] of [['LICENSE', 'FFmpeg-LICENSE.txt'], ['README.txt', 'FFmpeg-README.txt']]) {
    const file = path.join(ffmpegRoot, source);
    if (!fs.existsSync(file)) throw new Error(`Missing FFmpeg distribution notice: ${file}`);
    copy(file, path.join(release, 'licenses', target));
  }
  const cache = path.join(root, 'build', 'cache');
  fs.mkdirSync(cache, { recursive: true });
  const nodeLicense = path.join(cache, `node-${process.version}-LICENSE.txt`);
  if (!fs.existsSync(nodeLicense)) {
    console.log('Fetching the matching official Node.js license...');
    const address = `https://raw.githubusercontent.com/nodejs/node/${process.version}/LICENSE`;
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$ErrorActionPreference='Stop'; $ProgressPreference='SilentlyContinue'; Invoke-WebRequest -Uri ${psQuote(address)} -OutFile ${psQuote(nodeLicense)} -UseBasicParsing -TimeoutSec 30`], { timeout: 40000 });
    const license = fs.readFileSync(nodeLicense, 'utf8');
    if (!license.includes('Permission is hereby granted')) throw new Error('Unexpected Node license content.');
  }
  copy(nodeLicense, path.join(release, 'licenses', 'Node-LICENSE.txt'));
  write(path.join(release, 'THIRD-PARTY-NOTICES.txt'), [
    `Node.js ${process.version}: https://github.com/nodejs/node/tree/${process.version}`,
    'License: licenses/Node-LICENSE.txt', '', ffmpegVersion,
    'License and corresponding source: licenses/FFmpeg-LICENSE.txt and licenses/FFmpeg-README.txt',
    'Bundled JavaScript dependency licenses are included in app/node_modules.', '',
    ...dependencies.map(item => `${item.name}@${item.version} - ${item.license}`), '',
  ].join('\r\n'));
  write(path.join(release, 'README-使用说明.txt'), '\ufeff' + [
    `MobileTV ${pkg.version} · Windows 64 位免安装版`, '',
    '本版优化：HLS 点播前向缓冲 60–90 秒、64 MB 完整分片缓存、网络重试及播放进度恢复。',
    '缓存自动按容量和有效期回收；播放优化保持源视频分辨率，不主动降低画质。', '',
    '使用方法',
    '1. 将整个 ZIP 解压到一个文件夹，双击 MobileTV.exe。请勿只复制 EXE。',
    '2. 手机和电脑连接同一局域网。在视频 App 的 TV 投屏列表选择本机设备。',
    '3. 首次运行如有 Windows 防火墙提示，请允许在专用网络中通信。',
    '4. 关闭接收窗口后，服务会继续在托盘运行；右键托盘图标，选择“退出 MobileTV”可完全退出。',
    '5. 需要再次打开界面时，双击托盘图标或再次运行 MobileTV.exe。', '',
    '常用快捷键：空格 / K 播放暂停；左右方向键快退快进；上下方向键调节音量；',
    'F 全屏；M 静音；? 查看帮助；Esc 关闭面板或退出全屏。', '',
    '系统：Windows 10 / 11 x64，使用系统自带 .NET Framework 4.x。',
    '界面优先使用 Microsoft Edge，其次 Chrome；已内置 Node.js 和 FFmpeg，无需另装。',
    '本机地址：http://127.0.0.1:8080/ 。主服务 8080，AirPlay 7000，影视投屏 9978。',
    '苹果接收支持基础 AirPlay 视频和照片；不支持苹果屏幕镜像或 DRM 视频。',
    'Android 17 上请使用支持本地网络权限的新版视频 App，并允许相关权限。', '',
    '默认数据目录：%LOCALAPPDATA%\\MobileTV\\data',
    '运行日志：上述目录下的 logs 文件夹，可通过托盘菜单打开。',
    '发布包不包含开发电脑的设备配置、历史或上传文件。',
    '如已有开发版占用 8080 端口，启动器会复用接收服务；要运行发布版服务，请先退出开发版。', '',
    '高级参数：MobileTV.exe --port 8080 / --no-window / --quit',
    '使用非默认端口时，退出命令也需带相同的 --port。',
    '环境变量 MOBILETV_DATA_DIR 可指定独立数据目录。', '',
  ].join('\r\n'));
  console.log('Compiling the Windows launcher...');
  const generated = path.join(root, 'build', name);
  fs.mkdirSync(generated, { recursive: true });
  const icon = path.join(generated, 'MobileTV.ico');
  createIcon(icon);
  const versionSource = path.join(generated, 'AssemblyInfo.cs');
  write(versionSource, `using System.Reflection;\n[assembly: AssemblyTitle("MobileTV")]\n[assembly: AssemblyProduct("MobileTV")]\n[assembly: AssemblyVersion("${pkg.version}.0")]\n[assembly: AssemblyFileVersion("${pkg.version}.0")]\n`);
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  console.log(run(compiler, ['/nologo', '/target:winexe', '/platform:x64', '/optimize+', '/codepage:65001', '/reference:System.Windows.Forms.dll', '/reference:System.Drawing.dll', '/reference:System.Web.Extensions.dll', `/win32icon:${icon}`, `/win32manifest:${path.join(root, 'packaging', 'app.manifest')}`, `/out:${path.join(release, 'MobileTV.exe')}`, path.join(root, 'packaging', 'Launcher.cs'), versionSource]).trim());
  let sourceCommit = null;
  try { sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { /* Source archives may not include Git metadata. */ }
  const info = { name: 'MobileTV', version: pkg.version, platform: 'win32', arch: 'x64', builtAt: new Date().toISOString(), sourceCommit, node: process.version, ffmpeg: ffmpegVersion, dependencies: dependencies.length, sha256: { 'runtime/node.exe': await hash(runtime), 'tools/ffmpeg.exe': await hash(ffmpeg), 'MobileTV.exe': await hash(path.join(release, 'MobileTV.exe')) } };
  write(path.join(release, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');
  console.log('Creating portable ZIP...');
  const zip = path.join(dist, name + '.zip');
  run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory(${psQuote(release)}, ${psQuote(zip)}, [System.IO.Compression.CompressionLevel]::Optimal, $true)`], { timeout: 300000 });
  const checksum = await hash(zip);
  write(zip + '.sha256', `${checksum}  ${path.basename(zip)}\n`);
  write(path.join(dist, 'latest-release.json'), JSON.stringify({ ...info, folder: release, zip, zipSha256: checksum }, null, 2) + '\n');
  console.log(JSON.stringify({ folder: release, zip, sizeMiB: +(fs.statSync(zip).size / 1024 / 1024).toFixed(1), sha256: checksum }, null, 2));
}

main().catch(error => { console.error(error.stack || error); process.exitCode = 1; });
