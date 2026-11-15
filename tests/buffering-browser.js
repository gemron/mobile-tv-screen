// Optional real Edge playback check: synthetic VOD, an origin outage, and remux seeking.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, execFileSync } = require('child_process');
const { setTimeout: delay } = require('timers/promises');
const WebSocket = require('ws');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV buffer browser '));
process.env.MOBILETV_DATA_DIR = path.join(sandbox, 'data');
const { createAppServer } = require('../src/server');
let receiver, origin, browser, socket, session, offline = false, blocked = 0;
let sequence = 0;
const pending = new Map();

function command(method, params = {}, sessionId) {
  return new Promise((resolve, reject) => {
    const id = ++sequence;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer });
    socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
}
async function evaluate(expression) {
  const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
  if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
  return result.result.value;
}
async function waitFor(expression, timeout = 30000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) { const value = await evaluate(expression); if (value) return value; await delay(200); }
  throw new Error('Playback condition timed out: ' + expression + '\n' + JSON.stringify(await evaluate('({src:tvVideo.currentSrc,time:tvVideo.currentTime,ready:tvVideo.readyState,error:tvVideo.error?.message,pill:bufferingPill.textContent})')));
}

async function main() {
  const media = path.join(sandbox, 'media');
  fs.mkdirSync(media);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=480x270:rate=25:duration=75', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '30', '-g', '50', '-sc_threshold', '0', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(media, 'seg-%03d.ts'), path.join(media, 'index.m3u8')], { windowsHide: true, timeout: 60000 });
  origin = http.createServer(async (req, res) => {
    if (offline) { blocked++; res.writeHead(503); res.end(); return; }
    const file = path.join(media, path.basename(req.url.split('?')[0]));
    if (!fs.existsSync(file)) { res.writeHead(404); res.end(); return; }
    await delay(50);
    res.writeHead(200, { 'Content-Type': file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t' });
    fs.createReadStream(file).pipe(res);
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  receiver = await createAppServer({ port: 0, enableDlna: false, enableAirplay: false, enableTvbox: false });
  const base = `http://127.0.0.1:${receiver.port}`;
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(file => fs.existsSync(file));
  assert.ok(edge, 'Edge is required for this optional test');
  browser = spawn(edge, ['--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', '--user-data-dir=' + path.join(sandbox, 'browser'), 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => reject(new Error('Edge debugger did not start: ' + output.slice(-1500))), 15000);
    browser.once('error', error => { clearTimeout(timer); reject(error); });
    browser.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  socket = new WebSocket(endpoint);
  socket.on('message', raw => {
    const message = JSON.parse(raw);
    const item = pending.get(message.id);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer);
    if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const target = await command('Target.createTarget', { url: 'about:blank' });
  session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await command('Page.enable', {}, session);
  await command('Page.navigate', { url: base }, session);
  await waitFor('document.getElementById("tvVideo") && document.readyState === "complete"');
  await evaluate('window.qaWaiting=0;window.qaMetadata=0;tvVideo.addEventListener("waiting",()=>qaWaiting++);tvVideo.addEventListener("loadedmetadata",()=>qaMetadata++)');
  const control = async data => { const response = await fetch(base + '/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data) }); assert.ok(response.ok); };
  const source = `http://127.0.0.1:${origin.address().port}/index.m3u8`;
  await control({ action: 'cast', url: source, title: 'Buffer verification' });
  const ahead = await waitFor('(() => {const v=tvVideo;for(let i=0;i<v.buffered.length;i++){const ahead=v.buffered.end(i)-v.currentTime;if(v.buffered.start(i)<=v.currentTime&&ahead>=55&&!v.paused)return ahead;}return false;})()');
  const before = await evaluate('({time:tvVideo.currentTime,waiting:qaWaiting,metadata:qaMetadata})');
  offline = true;
  // Force an uncached origin request to confirm the simulated outage is active.
  assert.equal((await fetch(base + '/api/proxy?url=' + encodeURIComponent(source + '?outage=1'))).status, 503);
  await delay(8000);
  const after = await evaluate('({time:tvVideo.currentTime,waiting:qaWaiting,paused:tvVideo.paused,width:tvVideo.videoWidth,height:tvVideo.videoHeight,error:tvVideo.error?.message})');
  assert.ok(after.time - before.time >= 6, 'Video must advance during the outage');
  assert.equal(after.waiting, before.waiting, 'Buffered playback must not stall during the outage');
  assert.equal(after.paused, false); assert.equal(after.error, undefined);
  await control({ action: 'volume', volume: 61 });
  assert.equal(await evaluate('qaMetadata'), before.metadata, 'A volume change must not reload the media');
  offline = false;
  console.log(JSON.stringify({ test: 'HLS origin outage', bufferedAheadSeconds: +ahead.toFixed(1), outageSeconds: 8, playbackAdvancedSeconds: +(after.time - before.time).toFixed(1), newWaitingEvents: after.waiting - before.waiting, confirmedFailedOriginRequests: blocked, resolution: after.width + 'x' + after.height }, null, 2));
  await control({ action: 'cast', url: base + '/api/sample-video.mp4', streamMode: 'transcode' });
  await waitFor('tvVideo.currentSrc.includes("/api/transcode?") && tvVideo.readyState>=3 && tvVideo.currentTime>0.3 && !tvVideo.paused');
  await control({ action: 'seek', position: 4 });
  await waitFor('tvVideo.currentTime + Number(new URL(tvVideo.currentSrc).searchParams.get("start") || 0) > 4.5 && !tvVideo.paused');
  const status = await (await fetch(base + '/api/status')).json();
  assert.ok(status.state.position >= 4, 'Server telemetry keeps the absolute remux playhead');
  console.log('PASS: real Edge HLS buffers through an 8-second origin outage; remux playback and seeking work');
}

main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (socket?.readyState === WebSocket.OPEN) { try { await command('Browser.close'); } catch {} socket.close(); }
  if (browser && browser.exitCode === null) { await Promise.race([new Promise(resolve => browser.once('exit', resolve)), delay(3000)]); if (browser.exitCode === null) browser.kill(); }
  for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Browser closed')); }
  if (receiver) await receiver.close();
  if (origin) { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); }
  const target = fs.realpathSync(sandbox);
  assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(target).startsWith('MobileTV buffer browser '));
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch { console.log('Test files retained at ' + target); }
});
