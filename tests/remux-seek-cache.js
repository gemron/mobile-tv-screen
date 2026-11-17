const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { Readable } = require('stream');
const { execFileSync } = require('child_process');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV cached remux '));
process.env.MOBILETV_DATA_DIR = path.join(sandbox, 'data');
const { createProxyRouter } = require('../src/services/proxy');
const mediaHeaders = require('../src/services/mediaHeaders');
const castState = require('../src/services/castState');
let router, server;
(async () => {
  const input = path.join(sandbox, 'multi-track.mkv'), output = path.join(sandbox, 'seek.mp4');
  execFileSync('ffmpeg', ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=320x180:rate=24:duration=16', '-f', 'lavfi', '-i', 'sine=frequency=440:sample_rate=48000:duration=16', '-map', '0:v', '-map', '1:a', '-map', '1:a', '-c:v', 'libx264', '-preset', 'ultrafast', '-b:v', '256k', '-g', '96', '-c:a', 'ac3', '-b:a', '192k', input], { windowsHide: true, timeout: 30000 });
  const bytes = fs.readFileSync(input);
  const address = 'https://dl-pc-cached-remux.drive.quark.cn/fixture.mkv';
  let offline = false, requests = 0;
  router = createProxyRouter({ dataDir: path.join(sandbox, 'data'), originalCache: { blockBytes: 64 * 1024, maxBytes: 4 * 1024 * 1024, concurrency: 4, ahead: 8, open: async (_, headers) => {
    requests++; if (offline) throw new Error('Origin is offline; cached seeks must not download');
    const [start, end] = headers.Range.match(/\d+/g).map(Number);
    const upRes = Readable.from([bytes.subarray(start, Math.min(end + 1, bytes.length))]);
    upRes.statusCode = start >= bytes.length ? 416 : 206;
    upRes.headers = { 'content-range': start >= bytes.length ? `bytes */${bytes.length}` : `bytes ${start}-${Math.min(end, bytes.length - 1)}/${bytes.length}`, etag: '"cached-fixture"' };
    return { upRes };
  } } });
  const app = express(); app.use('/api', router);
  server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = 'http://127.0.0.1:' + server.address().port;
  const context = mediaHeaders.create({ 'user-agent': 'CachedSeekFixture' }, address);
  const proxy = '/api/proxy?' + new URLSearchParams({ url: address, headerContext: context });
  castState.setMedia({ url: proxy, protocol: 'Library', mediaType: 'video', autoPlay: false });
  router.originalCache.setMedia(proxy, 'PLAYING');
  const warm = await fetch(base + proxy, { headers: { Range: 'bytes=0-' }, signal: AbortSignal.timeout(10000) });
  assert.ok(Buffer.from(await warm.arrayBuffer()).equals(bytes));
  const baseline = requests; offline = true;
  const response = await fetch(base + '/api/transcode?' + new URLSearchParams({ url: base + proxy, start: '5.37', audioTrack: '1', requestId: 'offline-cached-seek' }), { signal: AbortSignal.timeout(15000) });
  assert.equal(response.status, 200);
  fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));
  assert.equal(requests, baseline, 'A real non-keyframe MKV seek reuses header, index and media bytes with the origin unavailable');
  const probe = JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-show_streams', '-of', 'json', output], { windowsHide: true, timeout: 10000, encoding: 'utf8' }));
  assert.equal(probe.streams.find(stream => stream.codec_type === 'video').width, 320);
  const audio = probe.streams.find(stream => stream.codec_type === 'audio');
  assert.equal(audio.codec_name, 'aac'); assert.equal(audio.channels, 2);
  assert.equal(router.originalCache.stats().failures, 0);
  console.log('PASS: real multi-track MKV remux seek reads cached headers/index/media offline and preserves video plus selected AAC audio');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (router) { router.originalCache.close(); router.mediaCache.clear(); await router.mediaTracks.close(); await router.adFilter.close(); }
  if (server) { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
  const target = fs.realpathSync(sandbox);
  assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.ok(path.basename(target).startsWith('MobileTV cached remux '));
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
});
