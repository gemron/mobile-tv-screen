'use strict';

// Exercise the shipped EXE, bundled runtimes and ZIP outside the source tree.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const net = require('net');
const http = require('http');
const crypto = require('crypto');
const { spawn, execFileSync } = require('child_process');
const root = path.resolve(__dirname, '..');
const latest = JSON.parse(fs.readFileSync(path.join(root, 'dist', 'latest-release.json'), 'utf8'));
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV release check '));
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
const quote = text => "'" + String(text).replace(/'/g, "''") + "'";
const folderIndex = process.argv.indexOf('--folder');
let release = folderIndex >= 0 ? path.resolve(process.argv[folderIndex + 1]) : latest.folder;
let child, port, passed = false, cacheOrigin;

async function until(check, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { if (await check()) return; await sleep(150); }
  throw new Error('Timed out waiting for release process or response');
}

async function main() {
  if (process.argv.includes('--zip')) {
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(latest.zip)) digest.update(chunk);
    const expected = latest.zipSha256 || fs.readFileSync(latest.zip + '.sha256', 'utf8').trim().split(/\s+/)[0];
    assert.equal(digest.digest('hex'), expected, 'ZIP checksum');
    const unpack = path.join(sandbox, '\u53d1\u5e03\u9a8c\u8bc1 with spaces');
    fs.mkdirSync(unpack);
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::ExtractToDirectory(${quote(latest.zip)}, ${quote(unpack)})`], { windowsHide: true, timeout: 120000 });
    release = path.join(unpack, path.basename(latest.folder));
    console.log('PASS: ZIP checksum and extraction to a path with spaces and Chinese characters');
  }
  for (const file of ['MobileTV.exe', 'runtime/node.exe', 'tools/ffmpeg.exe', 'tools/ffprobe.exe', 'app/src/server.js', 'licenses/Node-LICENSE.txt', 'licenses/FFmpeg-LICENSE.txt']) assert.ok(fs.existsSync(path.join(release, file)), file);
  assert.ok(!fs.existsSync(path.join(release, 'app', 'data')), 'No development data in release');
  assert.deepEqual(fs.readdirSync(path.join(release, 'locales')).sort(), ['en-US.pak', 'zh-CN.pak', 'zh-TW.pak']);
  assert.ok(!fs.existsSync(path.join(release, 'app', 'src', 'diagnostics')), 'No development diagnostics');
  let compared = 0;
  for (const directory of ['src', 'public', 'desktop', 'docs']) {
    for (const relative of fs.readdirSync(path.join(root, directory), { recursive: true })) {
      if (directory === 'src' && relative.split(path.sep).includes('diagnostics')) continue;
      const source = path.join(root, directory, relative);
      if (!fs.statSync(source).isFile()) continue;
      const target = path.join(release, ...(directory === 'docs' ? [] : ['app']), directory, relative);
      assert.ok(fs.existsSync(target), `Missing packaged file: ${directory}/${relative}`);
      assert.ok(fs.readFileSync(source).equals(fs.readFileSync(target)), `Stale packaged file: ${directory}/${relative}`);
      compared++;
    }
  }
  for (const file of ['LICENSE', 'README.md', 'CHANGELOG.md', 'THIRD_PARTY_NOTICES.md', 'CONTRIBUTING.md', 'app/package.json', 'app/package-lock.json']) assert.ok(fs.readFileSync(path.join(root, file.replace(/^app\//, ''))).equals(fs.readFileSync(path.join(release, file))), file);
  const buildInfo = JSON.parse(fs.readFileSync(path.join(release, 'build-info.json'), 'utf8'));
  assert.equal(buildInfo.sourceCommit, latest.sourceCommit);
  assert.equal(buildInfo.version, latest.version);
  for (const [file, expected] of Object.entries(buildInfo.sha256)) {
    const digest = crypto.createHash('sha256');
    for await (const chunk of fs.createReadStream(path.join(release, file))) digest.update(chunk);
    assert.equal(digest.digest('hex'), expected, file);
  }
  console.log(`PASS: ${compared} shipped source, asset and documentation files match the release checkout`);
  assert.equal(execFileSync(path.join(release, 'runtime', 'node.exe'), ['--version'], { encoding: 'utf8', windowsHide: true }).trim(), latest.node);
  const ffmpeg=path.join(release,'tools','ffmpeg.exe'), ffOptions={encoding:'utf8',windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,PATH:path.join(process.env.WINDIR,'System32')}};
  assert.match(execFileSync(ffmpeg, ['-version'], ffOptions), /ffmpeg version/);
  assert.match(execFileSync(path.join(release, 'tools', 'ffprobe.exe'), ['-version'], ffOptions), /ffprobe version/);
  const decoders=execFileSync(ffmpeg,['-hide_banner','-decoders'],ffOptions),encoders=execFileSync(ffmpeg,['-hide_banner','-encoders'],ffOptions),filters=execFileSync(ffmpeg,['-hide_banner','-filters'],ffOptions);
  for(const codec of ['h264','hevc','aac','ac3','dca','subrip','ass'])assert.match(decoders,new RegExp('\\b'+codec+'\\b'),'Bundled decoder '+codec);
  for(const codec of ['aac','libx264','webvtt','mov_text','subrip'])assert.match(encoders,new RegExp('\\b'+codec+'\\b'),'Bundled encoder '+codec);
  assert.match(filters,/\bsubtitles\b/,'Subtitle rendering remains available');
  execFileSync(path.join(release,'runtime','node.exe'),['--input-type=module','-e',"const [{default:Torrent},{default:Store}]=await Promise.all([import('webtorrent'),import('fs-chunk-store')]);if(typeof Store!=='function')throw Error('Missing disk store');const c=new Torrent({dht:false,tracker:false,lsd:false,utp:false});await new Promise((r,j)=>c.destroy(e=>e?j(e):r()));"],{cwd:path.join(release,'app'),env:{...process.env,NODE_PATH:''},windowsHide:true,stdio:['ignore','pipe','pipe'],timeout:15000});
  console.log('PASS: slim media tools retain video/audio/subtitle codecs and staged torrent dependencies initialize offline');
  port = await new Promise(resolve => { const probe = net.createServer(); probe.listen(0, '127.0.0.1', () => { const free = probe.address().port; probe.close(() => resolve(free)); }); });
  const executable = path.join(release, 'MobileTV.exe');
  const data = path.join(sandbox, 'isolated user data');
  const env = { ...process.env, MOBILETV_DATA_DIR: data, DISABLE_DLNA: '1', DISABLE_AIRPLAY: '1', DISABLE_TVBOX: '1' };
  // Prove the installed development Node/FFmpeg and global modules are unnecessary.
  env.PATH = path.join(process.env.WINDIR || 'C:\\Windows', 'System32');
  delete env.NODE_PATH;
  const args = ['--no-window', '--self-test', '--port', String(port), '--remote-debugging-port=0'];
  child = spawn(executable, args, { env, cwd: sandbox, windowsHide: true, stdio: 'ignore' });
  let spawnError;
  child.on('error', error => { spawnError = error; });
  const base = `http://127.0.0.1:${port}`;
  async function request(route, options = {}) {
    const response = await fetch(base + route, { signal: AbortSignal.timeout(60000), ...options });
    assert.ok(response.ok, `${route}: HTTP ${response.status}`);
    return response;
  }
  await until(async () => {
    if (spawnError) throw spawnError;
    if (child.exitCode !== null) throw new Error(`Launcher exited with ${child.exitCode}`);
    try { return (await fetch(base + '/api/status', { signal: AbortSignal.timeout(500) })).ok; } catch { return false; }
  });
  const status = await (await request('/api/status')).json();
  assert.equal(status.version, latest.version);
  assert.equal(status.port, port);
  assert.ok(status.identity.deviceName);
  assert.ok(fs.existsSync(path.join(data, 'device-config.json')), 'Identity saved in user data');
  assert.ok(!fs.existsSync(path.join(release, 'app', 'data')), 'Application folder stays free of runtime data');
  console.log('PASS: compiled launcher starts bundled Node, with an independent user data directory');
  execFileSync(executable, args, { env, cwd: sandbox, windowsHide: true, timeout: 10000 });
  assert.equal(child.exitCode, null, 'Duplicate launch keeps the original instance alive');
  for (const file of ['/', '/mobile.html', '/css/style.css', '/css/mobile.css', '/css/library.css', '/css/subtitles.css', '/js/tv.js', '/js/ui.js', '/js/mobile.js', '/js/artwork.js', '/js/danmaku.js', '/js/subtitles.js', '/js/media-tracks.js', '/js/player-controls.js', '/js/skip-segments.js', '/js/library.js', '/icons.svg', '/favicon.svg', '/vendor/hls/hls.min.js', '/vendor/mpegts/mpegts.js']) {
    const response = await request(file);
    assert.ok((await response.arrayBuffer()).byteLength > 0, file);
  }
  console.log('PASS: receiver, mobile remote and offline player assets are included');
  const cachedSegment = Buffer.alloc(4096, 19);
  // The normal upload route deliberately sends max-age=0. Use a separate origin
  // with cacheable VOD segments, as a real phone or CDN would supply them.
  cacheOrigin = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'public, max-age=120');
    if (req.url === '/config') { res.end(JSON.stringify({ sites: [{ key: 'test', name: 'Packaged CMS', type: 1, api: '/cms' }], lives: [{ name: 'Packaged live', channels: [{ name: 'Test channel', url: '/release-cache.m3u8' }] }] })); return; }
    if (req.url.startsWith('/cms')) { res.end(JSON.stringify({ class: [{ type_id: '1', type_name: 'Test' }], list: [{ vod_id: '1', vod_name: 'Package test', vod_play_from: 'HLS', vod_play_url: 'One$/release-cache.m3u8' }] })); return; }
    if (req.url.endsWith('.m3u8')) {
      res.setHeader('Content-Type', 'application/vnd.apple.mpegurl');
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nrelease-cache.ts\n#EXT-X-ENDLIST\n');
    } else { res.setHeader('Content-Type', 'video/mp2t'); res.end(cachedSegment); }
  });
  await new Promise(resolve => cacheOrigin.listen(0, '127.0.0.1', resolve));
  const originBase = `http://127.0.0.1:${cacheOrigin.address().port}`;
  const library = await (await request('/api/library/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: originBase + '/config' }) })).json();
  assert.equal(library.sites[0].supported, true);
  assert.equal((await (await request('/api/library/home?site=test')).json()).list[0].title, 'Package test');
  const libraryPlay = await (await request('/api/library/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ siteKey: 'test', vodId: '1' }) })).json();
  assert.equal(libraryPlay.state.protocol, 'Library');
  const channels = await (await request('/api/library/channels?source=' + library.lives[0].key)).json();
  assert.equal(channels.channels.length, 1);
  assert.ok(fs.existsSync(path.join(data, 'library-config.json')));
  console.log('PASS: packaged native library imports, persists, browses, resolves playback and lists live channels without Android');
  const proxyRoute = file => '/api/proxy?url=' + encodeURIComponent(originBase + '/' + file);
  await (await request(proxyRoute('release-cache.m3u8'))).text();
  assert.deepEqual(Buffer.from(await (await request(proxyRoute('release-cache.ts'))).arrayBuffer()), cachedSegment);
  const cacheHit = await request(proxyRoute('release-cache.ts'));
  assert.equal(cacheHit.headers.get('x-media-cache'), 'HIT');
  assert.deepEqual(Buffer.from(await cacheHit.arrayBuffer()), cachedSegment);
  const cacheStats = (await (await request('/api/status')).json()).mediaCache;
  assert.equal(cacheStats.maxBytes, 64 * 1024 * 1024);
  assert.ok(cacheStats.hits > 0 && cacheStats.bytes <= cacheStats.maxBytes);
  console.log('PASS: packaged HLS segment cache returns identical bytes and respects its capacity');
  const sample = await request('/api/sample-video.mp4', { headers: { Range: 'bytes=0-1023' } });
  assert.equal(sample.status, 206);
  assert.equal((await sample.arrayBuffer()).byteLength, 1024);
  assert.ok(fs.statSync(path.join(data, 'sample-test.mp4')).size > 10000);
  console.log('PASS: bundled FFmpeg generates the offline test video; Range playback works');
  const remux = await request('/api/transcode?url=' + encodeURIComponent(base + '/api/sample-video.mp4') + '&start=4');
  const remuxed = Buffer.from(await remux.arrayBuffer());
  assert.ok(remuxed.length > 10000, 'Remux must finish without being killed by a normal GET close');
  assert.equal(remuxed.toString('ascii', 4, 8), 'ftyp');
  assert.ok(remuxed.includes(Buffer.from('moof')), 'Output is fragmented MP4');
  console.log('PASS: bundled FFmpeg remux completes and supports resume from a requested position');
  const cast = await (await request('/api/cast/test', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ mode: 'dlna-sim' }) })).json();
  assert.equal(cast.state.protocol, 'DLNA');
  assert.equal(cast.state.streamMode, 'auto');
  const tracks=await (await request('/api/media/tracks?sessionId='+cast.state.sessionId)).json();
  assert.ok(tracks.audio.some(track=>track.codec==='aac'),'Bundled FFprobe identifies the actual audio track');
  assert.ok(tracks.duration>0);assert.ok(Array.isArray(tracks.subtitles));
  const subtitleConfig=await (await request('/api/subtitles/config')).json();assert.equal(subtitleConfig.searchAvailable,true);assert.equal(subtitleConfig.provider,'迅雷字幕');
  console.log('PASS: packaged FFprobe discovers media tracks and subtitle search works without a preconfigured token');
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws?role=mobile`);
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('WebSocket handshake timed out')), 5000);
      socket.addEventListener('message', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(new Error('WebSocket failed')); }, { once: true });
    });
    socket.send(JSON.stringify({ type: 'control', data: { action: 'pause' } }));
    await until(async () => (await (await request('/api/status')).json()).state.status === 'PAUSED', 5000);
    const volume = await (await request('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'volume', volume: 73 }) })).json();
    assert.equal(volume.state.volume, 73);
  } finally { socket.close(); }
  console.log('PASS: packaged WebSocket control and HTTP control work');
  // Finish the paused control fixture before a newly opened window joins it.
  const stopped = await request('/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop' }) });
  assert.equal((await stopped.json()).state.status, 'IDLE');
  // Open the real Electron window via the tray instance and inspect decoded
  // frames, since HTTP success alone cannot establish Chromium codec support.
  execFileSync(executable, ['--self-test', '--port', String(port)], { env, windowsHide: true, cwd: sandbox, timeout: 10000 });
  await until(async () => (await (await request('/api/status')).json()).state.protocols.websocket.tvClients > 0);
  const debugPort = fs.readFileSync(path.join(data, 'electron', String(port), 'DevToolsActivePort'), 'utf8').split(/\r?\n/)[0];
  const pages = await (await fetch('http://127.0.0.1:' + debugPort + '/json/list')).json();
  const player = pages.find(page => page.type === 'page' && page.url === base + '/');
  assert.ok(player, 'Packaged Electron loaded the local receiver window');
  const inspect = new WebSocket(player.webSocketDebuggerUrl);
  try {
    await new Promise((resolve, reject) => { inspect.onopen = resolve; inspect.onerror = reject; });
    inspect.send(JSON.stringify({ id: 1, method: 'Runtime.enable' }));
    const playing = (await request('/api/cast/test', { method: 'POST' })).ok;
    assert.ok(playing);
    let sequence = 1, mediaState;
    await until(async () => {
      const id = ++sequence;
      const result = new Promise(resolve => {
        const onMessage = event => {
          const message = JSON.parse(event.data);
          if (message.id === id) { inspect.removeEventListener('message', onMessage); resolve(message.result?.result?.value); }
        };
        inspect.addEventListener('message', onMessage);
      });
      inspect.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: '({width:tvVideo.videoWidth,time:tvVideo.currentTime,frames:tvVideo.getVideoPlaybackQuality().totalVideoFrames,paused:tvVideo.paused,sandboxed:typeof require === "undefined",source:tvVideo.currentSrc,readyState:tvVideo.readyState,error:tvVideo.error?.message})', returnByValue: true } }));
      mediaState = await result;
      return mediaState?.width && mediaState.time > 0.5 && mediaState.frames > 2 && !mediaState.paused && mediaState.sandboxed;
    }).catch(error => { throw new Error(error.message + ': ' + JSON.stringify(mediaState)); });
  } finally { inspect.close(); }
  console.log('PASS: packaged sandboxed Electron window decodes and plays local video');
  execFileSync(executable, ['--quit', '--port', String(port)], { env, windowsHide: true, cwd: sandbox, timeout: 10000 });
  await until(async () => child.exitCode !== null, 10000);
  assert.equal(child.exitCode, 0);
  await until(async () => { try { await fetch(base + '/api/status', { signal: AbortSignal.timeout(500) }); return false; } catch { return true; } }, 5000);
  console.log('PASS: tray exit terminates the owned receiver process and releases its port');
  passed = true;
}

main().catch(error => { console.error(error.stack || error); console.error('Diagnostic files:', sandbox); process.exitCode = 1; }).finally(async () => {
  if (child && child.exitCode === null) child.kill();
  if (cacheOrigin) { cacheOrigin.closeAllConnections(); await new Promise(resolve => cacheOrigin.close(resolve)); }
  if (passed) {
    // Only this freshly created, verified task-owned temporary directory may be removed.
    const target = fs.realpathSync(sandbox);
    assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
    assert.ok(path.basename(target).startsWith('MobileTV release check '));
    try {
      fs.rmSync(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
    } catch (error) {
      // Antivirus and recently exited Windows child processes can temporarily
      // retain file handles after all functional checks have completed.
      if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error;
      console.log('Temporary release test files retained at ' + target);
    }
  }
});
