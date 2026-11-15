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
    console.log('PASS: proxy survives disconnects before headers and mid-stream, and bounds playlist size');
  } finally {
    releaseHeaders();
    proxy.closeAllConnections?.();
    upstream.closeAllConnections?.();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
}

verifyDisconnects().catch(error => { console.error(error); process.exitCode = 1; });
