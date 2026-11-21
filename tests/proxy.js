const assert = require('assert');
const http = require('http');
const express = require('express');
const { createProxyRouter } = require('../src/services/proxy');

async function verifyDisconnects() {
  let signalHeadersPending;
  let releaseHeaders;
  let signalStreamClosed;
  const headersPending = new Promise(resolve => { signalHeadersPending = resolve; });
  const headersReleased = new Promise(resolve => { releaseHeaders = resolve; });
  const streamClosed = new Promise(resolve => { signalStreamClosed = resolve; });
  const upstream = http.createServer(async (req, res) => {
    if (req.url === '/late.mp4') {
      signalHeadersPending();
      await headersReleased;
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.end(Buffer.alloc(1024));
    } else if (req.url === '/stream.mp4') {
      res.writeHead(200, { 'Content-Type': 'video/mp4' });
      res.write(Buffer.alloc(2048));
      const timer = setInterval(() => res.write(Buffer.alloc(2048)), 10);
      res.on('close', () => { clearInterval(timer); signalStreamClosed(); });
    } else if (req.url === '/expired.m3u8') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<pre>链接失效了，请重新获取</pre>');
    } else if (req.url === '/valid.m3u8') {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\n/ts/bad-json\n#EXTINF:6,\n/ts/bad-text\n#EXT-X-ENDLIST\n');
    } else if (req.url === '/ts/bad-json') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end('{"code":401,"message":"token expired"}');
    } else if (req.url === '/ts/bad-text') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('{"code":401,"message":"token expired"}');
    } else {
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(Buffer.alloc(4 * 1024 * 1024 + 1));
    }
  });
  const app = express();
  app.use('/api', createProxyRouter());
  app.get('/health', (req, res) => res.send('ok'));
  const proxy = http.createServer(app);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${proxy.address().port}`;
  const url = name => `${base}/api/proxy?url=${encodeURIComponent(`http://127.0.0.1:${upstream.address().port}/${name}`)}`;
  try {
    const client = http.get(url('late.mp4'));
    client.on('error', () => {});
    await headersPending;
    await new Promise(resolve => { client.once('close', resolve); client.destroy(); });
    await new Promise(resolve => setTimeout(resolve, 30));
    releaseHeaders();
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.strictEqual(await (await fetch(`${base}/health`)).text(), 'ok', 'aborting before upstream headers must not crash the server');

    await new Promise((resolve, reject) => {
      const streaming = http.get(url('stream.mp4'), response => {
        response.once('data', () => { response.destroy(); streaming.destroy(); resolve(); });
      });
      streaming.on('error', reject);
    });
    let timer;
    try {
      await Promise.race([streamClosed, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Upstream did not close')), 1500); })]);
    } finally { clearTimeout(timer); }
    assert.strictEqual((await fetch(`${base}/health`)).status, 200);
    const tooLarge = await fetch(url('large.m3u8'));
    assert.strictEqual(tooLarge.status, 502, 'oversized playlists must terminate the response');
    await tooLarge.text();
    const expired = await fetch(url('expired.m3u8') + '&hls=1');
    assert.strictEqual(expired.status, 502, 'expired non-EXTM3U HTML must not be rewritten as a valid playlist');
    assert.strictEqual(expired.headers.get('x-media-segment-error'), 'invalid-playlist');
    const validPlaylist = await fetch(url('valid.m3u8') + '&hls=1');
    assert.strictEqual(validPlaylist.status, 200);
    await validPlaylist.text();
    const badJsonSeg = await fetch(url('ts/bad-json'));
    assert.strictEqual(badJsonSeg.status, 502, 'fake-200 JSON HLS segment must be rejected and not cached');
    assert.strictEqual(badJsonSeg.headers.get('x-media-segment-error'), 'invalid-segment');
    const badTextSeg = await fetch(url('ts/bad-text'));
    assert.strictEqual(badTextSeg.status, 502, 'fake-200 text/plain JSON HLS segment must be rejected');
    assert.strictEqual(badTextSeg.headers.get('x-media-segment-error'), 'invalid-segment');
    console.log('PASS: proxy survives disconnects before headers and mid-stream, bounds playlist size, and rejects expired playlists and fake-200 error segments');
  } finally {
    releaseHeaders();
    proxy.closeAllConnections?.();
    upstream.closeAllConnections?.();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
}

verifyDisconnects().catch(error => { console.error(error); process.exitCode = 1; });
