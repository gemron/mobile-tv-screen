const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { artworkUrl } = require('../public/js/artwork');
const { createProxyRouter } = require('../src/services/proxy');

async function run() {
  const original = 'https://img3.doubanio.com/view/photo/m_ratio_poster/public/fixture.jpg?x=a%2Bb';
  const result = new URL(artworkUrl(original), 'http://localhost');
  assert.equal(result.pathname, '/api/proxy'); assert.equal(result.searchParams.get('url'), original); assert.equal(result.searchParams.get('referer'), 'https://movie.douban.com/');
  assert.equal(artworkUrl('https://doubanio.com.evil.test/poster.jpg'), 'https://doubanio.com.evil.test/poster.jpg');
  assert.equal(artworkUrl('/poster.jpg', 'http://127.0.0.1:8080/'), 'http://127.0.0.1:8080/poster.jpg');
  assert.equal(artworkUrl('javascript:alert(1)'), ''); assert.equal(artworkUrl(''), '');
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jhXcAAAAASUVORK5CYII=', 'base64');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV artwork test '));
  const origin = http.createServer((req, res) => {
    assert.equal(req.headers.cookie, undefined, 'Browser account cookies are not sent to the poster CDN');
    if (req.headers.referer !== 'https://movie.douban.com/') { res.writeHead(403); res.end('referer required'); return; }
    res.writeHead(200, { 'Content-Type': 'image/png', 'Cache-Control': 'public, max-age=3600' }); res.end(png);
  });
  const router = createProxyRouter({ dataDir: directory }), app = express(); app.use('/api', router); const proxy = http.createServer(app);
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve)); await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  try {
    const target = 'http://127.0.0.1:' + origin.address().port + '/poster.png';
    assert.equal((await fetch(target)).status, 403, 'Direct image requests reproduce the source rejection');
    const response = await fetch('http://127.0.0.1:' + proxy.address().port + '/api/proxy?' + new URLSearchParams({ url: target, referer: result.searchParams.get('referer') }), { headers: { cookie: 'local-session=private' } });
    assert.equal(response.status, 200); assert.equal(response.headers.get('content-type'), 'image/png'); assert.deepEqual(Buffer.from(await response.arrayBuffer()), png); assert.match(response.headers.get('cache-control'), /max-age=3600/);
    console.log('PASS: protected poster URL routing, exact query preservation, cookie isolation, image bytes and cache headers');
  } finally {
    await router.adFilter.close(); router.mediaCache.clear(); proxy.closeAllConnections(); origin.closeAllConnections();
    await new Promise(resolve => proxy.close(resolve)); await new Promise(resolve => origin.close(resolve));
    const target = path.resolve(directory); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('MobileTV artwork test ')); fs.rmSync(target, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
