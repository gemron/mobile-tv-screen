'use strict';

// Build from the installed, locked production dependencies; no global Node/npm is needed at runtime.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { stage } = require('./package-dependencies');
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
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  const renderer = path.join(path.dirname(file), 'IconRenderer.exe');
  run(compiler, ['/nologo', '/target:exe', '/reference:System.Drawing.dll', '/out:' + renderer, path.join(root, 'packaging', 'IconRenderer.cs')]);
  run(renderer, [file, path.join(path.dirname(file), 'MobileTV-icon.png')]);
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
  copy(path.join(root, 'docs'), path.join(release, 'docs'));
  copy(path.join(root, 'docs', 'CONTENT_SOURCES.md'), path.join(release, 'docs', 'CONTENT_SOURCES.md'));
  const staged = stage(root, app, lock.packages), dependencies = staged.dependencies;
  console.log(`Production dependency files: ${(staged.shippedBytes / 1048576).toFixed(1)} MiB`);
  const runtime = path.join(release, 'runtime', 'node.exe');
  copy(process.execPath, runtime);
  const preparedFfmpeg = path.join(root, 'build', 'tools', 'ffmpeg-8.1.2-essentials_build', 'bin', 'ffmpeg.exe');
  const ffmpegPath = fs.realpathSync(process.env.FFMPEG_PATH || (fs.existsSync(preparedFfmpeg) ? preparedFfmpeg : run('where.exe', ['ffmpeg.exe']).trim().split(/\r?\n/)[0]));
  const ffmpeg = path.join(release, 'tools', 'ffmpeg.exe');
  copy(ffmpegPath, ffmpeg);
  const ffprobePath = path.join(path.dirname(ffmpegPath), 'ffprobe.exe');
  if (!fs.existsSync(ffprobePath)) throw new Error('The matching FFmpeg distribution must include ffprobe.exe for embedded tracks.');
  copy(ffprobePath, path.join(release, 'tools', 'ffprobe.exe'));
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
    '用途声明：仅供学习研究和非商业技术测试使用，禁止商业售卖。',
    '第三方组件及历史 MIT 代码遵循各自许可证，详见 LICENSE 和 THIRD_PARTY_NOTICES.md。', '',
    '本版新增：XS 订阅适配、片源镜像切换；修复海报、拖动缓存和返回列表状态。',
    '缩小媒体工具和依赖体积，保留音轨、内置字幕、免费字幕搜索和片头片尾跳过。',
    '夸克临时剧集默认在播完／换集后或空间不足时移入回收站，可在账号管理关闭。',
    '只清理本软件转存记录中的文件，保护当前播放和正在保存的文件，不清空回收站。',
    '夸克原文件按实际分辨率使用 32–512 MiB 有界缓冲，兼容封装另有 64 MiB 成品预读。',
    '字幕优先使用本机／订阅的 Assrt Token，没有时尝试迅雷免费搜索；S 键打开。',
    '设置与字幕使用双栏半透明面板，小窗口自适应；片库搜索和选集操作更紧凑。',
    '普通兼容封装保留视频码流；图像字幕兼容显示需明确启用视频转码。',
    '缓存自动回收，实际流畅度取决于源站、网络与设备。', '',
    '使用方法',
    '1. 将整个 ZIP 解压到一个文件夹，双击 MobileTV.exe。请勿只复制 EXE。',
    '2. 手机和电脑连接同一局域网。在视频 App 的 TV 投屏列表选择本机设备。',
    '3. 首次运行如有 Windows 防火墙提示，请允许在专用网络中通信。',
    '4. 关闭接收窗口后，服务会继续在托盘运行；右键托盘图标，选择“退出 MobileTV”可完全退出。',
    '5. 需要再次打开界面时，双击托盘图标或再次运行 MobileTV.exe。', '',
    '常用快捷键：空格 / K 播放暂停；左右方向键快退快进；上下方向键调节音量；',
    'F 全屏；M 静音；? 查看帮助；Esc 关闭面板或退出全屏。', '',
    '系统：Windows 10 / 11 x64，使用系统自带 .NET Framework 4.x。',
    '播放器优先使用已安装的 Chrome，未安装时使用 Microsoft Edge；已内置 Node.js 和 FFmpeg。',
    'Chrome 与 Edge 使用各自独立的播放配置。环境变量 MOBILETV_PLAYER_BROWSER=edge 可优先使用 Edge。',
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
  let sourceCommit = null, sourceDirty = null;
  try { sourceCommit = run('git', ['rev-parse', 'HEAD'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); sourceDirty = Boolean(run('git', ['status', '--porcelain', '--untracked-files=normal'], { cwd: root, stdio: ['ignore', 'pipe', 'ignore'] }).trim()); } catch { /* Source archives may not include Git metadata. */ }
  const info = { name: 'MobileTV', version: pkg.version, platform: 'win32', arch: 'x64', builtAt: new Date().toISOString(), sourceCommit, sourceDirty, node: process.version, ffmpeg: ffmpegVersion, dependencies: dependencies.length, sha256: { 'runtime/node.exe': await hash(runtime), 'tools/ffmpeg.exe': await hash(ffmpeg), 'tools/ffprobe.exe': await hash(path.join(release,'tools','ffprobe.exe')), 'MobileTV.exe': await hash(path.join(release, 'MobileTV.exe')) } };
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
