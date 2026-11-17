const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { Readable } = require('stream');
const { setTimeout: delay } = require('timers/promises');
const WebSocket = require('ws');
const { OriginalRangeCache } = require('../src/services/originalRangeCache');
const MIB = 1048576, data = Buffer.alloc(512 * 1024, 7);
for (let i = 0; i < data.length; i++) data[i] = i % 251;
const original = '/api/proxy?url=' + encodeURIComponent('https://dl-pc-fixture.drive.quark.cn/video.mkv') + '&headerContext=fixture';
async function wait(test) { const deadline = Date.now() + 3000; while (Date.now() < deadline) { const value = await test(); if (value) return value; await delay(10); } throw new Error('Buffer profile did not update'); }
async function profiles() {
  let offline = false, requests = 0;
  const cache = new OriginalRangeCache({ adaptive: true, blockBytes: 65536, maxBytes: 256 * 1024, concurrency: 2, ahead: 2, open: async (_, headers) => {
    requests++; if (offline) throw new Error('Simulated source outage');
    const [start, end] = headers.Range.match(/\d+/g).map(Number), response = Readable.from([data.subarray(start, end + 1)]);
    response.statusCode = 206; response.headers = { 'content-range': `bytes ${start}-${Math.min(end, data.length - 1)}/${data.length}` };
    return { upRes: response };
  } });
  try {
    cache.setMedia(original, 'PLAYING');
    await cache.read('https://dl-pc-fixture.drive.quark.cn/video.mkv', {}, 'one', 'bytes=0-');
    cache.setPlaybackInfo({ width: 3840, height: 1608, duration: 1 }, original);
    assert.equal(cache.stats().profile, '4K'); assert.equal(cache.stats().maxBytes, 512 * MIB);
    assert.equal(cache.stats().parallelLimit, 384, '4K has enough concurrent small ranges to fill its larger reserve');
    const highBitrate = cache.stats().aheadBytes;
    cache.setPlaybackInfo({ width: 3840, height: 1608, duration: 6000 }, original);
    assert.ok(cache.stats().aheadBytes < highBitrate, 'low bitrate does not prefetch the entire maximum window');
    assert.equal(cache.stats().targetSeconds, 180);
    assert.ok(cache.stats().aheadBytes >= 96 * MIB && cache.stats().aheadBytes <= 384 * MIB);
    for (const [width, height, label, capacity] of [[720,1280,'720p',64],[1920,1080,'1080p',128],[2560,1440,'2K',256],[2160,3840,'4K',512]]) {
      cache.setPlaybackInfo({ width, height, duration: 6000 }, original);
      assert.equal(cache.stats().profile, label); assert.equal(cache.stats().maxBytes, capacity * MIB);
      assert.equal(cache.stats().parallelLimit, label === '4K' ? 384 : label === '2K' ? 192 : 96);
    }
    assert.equal(cache.setPlaybackInfo({ width: 40000, height: 2160 }, original), false);
    cache.setPlaybackInfo({width:1920,height:1080,duration:.05},original);
    assert.equal(cache.stats().profile,'1080p');assert.equal(cache.stats().highBitrate,true);assert.equal(cache.stats().maxBytes,512*MIB,'High-bitrate 1080p originals can grow beyond the normal resolution budget');assert.equal(cache.stats().parallelLimit,384);
    cache.setPlaybackInfo({width:3840,height:2160,duration:6000},original);
    assert.equal(cache.setPlaybackInfo({ width: 1280, height: 720 }, '/old-session'), false);
    assert.equal(cache.stats().maxBytes, 512 * MIB);
    await wait(() => cache.jobs.size === 0);
    assert.ok(cache.stats().bytes > 256 * 1024, 'cache grows with real data instead of allocating the maximum eagerly');
    offline = true;
    const beforeOutage = requests, response = await cache.response('https://dl-pc-fixture.drive.quark.cn/video.mkv', {}, 'one', 'bytes=70001-300000');
    const pieces = []; for await (const piece of response.stream) pieces.push(piece);
    assert.deepEqual(Buffer.concat(pieces), data.subarray(70001, 300001), 'the expanded read-ahead continues byte-exact playback while the source is unavailable');
    assert.equal(requests, beforeOutage, 'buffered playback does not wait for the unavailable source');
    cache.setMedia('/next-quality', 'PLAYING');
    assert.equal(cache.stats().maxBytes, 256 * 1024); assert.equal(cache.stats().bytes, 0);
    assert.equal(cache.stats().parallelLimit, 2, 'stopping or changing media resets the speculative connection budget');
    assert.equal(cache.stats().profile, '默认'); assert.equal(cache.stats().active, false);
    assert.equal(cache.setPlaybackInfo({ width: 3840, height: 2160 }, original), false);
  } finally { cache.close(); }
}
async function integration() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV buffer profile '));
  process.env.MOBILETV_DATA_DIR = path.join(sandbox, 'data');
  const { createAppServer } = require('../src/server'), castState = require('../src/services/castState');
  let receiver, tv, mobile;
  try {
    receiver = await createAppServer({ port: 0, enableDlna: false, enableAirplay: false, enableTvbox: false, enableBilibiliCast: false, dataDir: path.join(sandbox, 'data') });
    const base = 'http://127.0.0.1:' + receiver.port, packets = [];
    tv = new WebSocket(base.replace('http:', 'ws:') + '/ws?role=tv');
    tv.on('message', message => packets.push(JSON.parse(message)));
    await new Promise(resolve => tv.once('open', resolve));
    const media = castState.setMedia({ url: original, protocol: 'Library', mediaType: 'video', autoPlay: false });
    const send = (socket, videoWidth, videoHeight, sessionId = media.sessionId) => socket.send(JSON.stringify({ type: 'player-telemetry', data: { sessionId, videoWidth, videoHeight, duration: 600, position: 0 } }));
    send(tv, 3840, 1608);
    const status = () => fetch(base + '/api/status').then(r => r.json());
    await wait(async () => (await status()).originalCache.profile === '4K');
    assert.equal((await status()).originalCache.maxBytes, 512 * MIB);
    await delay(550); send(tv, 3840, 1608);
    await wait(() => packets.some(packet => packet.type === 'progress' && packet.data.originalBuffer?.profile === '4K'));
    const progress = packets.find(packet => packet.type === 'progress' && packet.data.originalBuffer?.profile === '4K').data.originalBuffer;
    assert.equal(progress.highBitrate, false, 'the live readout includes the actual bitrate promotion flag');
    assert.equal(progress.historyBytes, 0, 'the live readout separates played history from the forward window');
    send(tv, 1280, 720);
    await wait(async () => (await status()).originalCache.profile === '720p');
    send(tv, 3840, 2160, media.sessionId - 1);
    mobile = new WebSocket(base.replace('http:', 'ws:') + '/ws?role=mobile');
    await new Promise(resolve => mobile.once('open', resolve)); send(mobile, 3840, 2160);
    await delay(30); assert.equal((await status()).originalCache.profile, '720p', 'stale sessions and remote phones cannot resize the decoded-video buffer');
    const preview = castState.setMedia({ url: '/api/proxy?url=' + encodeURIComponent('https://video-play.quark.cn/preview.m3u8') + '&headerContext=preview', protocol: 'Library', mediaType: 'video', autoPlay: false });
    send(tv, 3840, 2160, preview.sessionId);
    await delay(30); assert.equal((await status()).originalCache.profile, '默认', 'HLS preview does not claim an original-file memory budget');
    castState.stop();
    assert.equal((await status()).originalCache.maxBytes, 32 * MIB);
  } finally {
    tv?.terminate(); mobile?.terminate(); if (receiver) await receiver.close();
    const target = fs.realpathSync(sandbox);
    assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.ok(path.basename(target).startsWith('MobileTV buffer profile '));
    fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
  }
}
(async () => { await profiles(); await integration(); console.log('PASS: decoded-resolution profiles, bitrate-sized prefetch, bounded growth, quality reset, stale telemetry and live buffer readout'); })().catch(error => { console.error(error); process.exitCode = 1; });
