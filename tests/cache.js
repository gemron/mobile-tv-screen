const assert = require('assert/strict');
const http = require('http');
const express = require('express');
const { setTimeout: delay } = require('timers/promises');
const { SegmentCache } = require('../src/services/segmentCache');
const { createProxyRouter } = require('../src/services/proxy');

function verifyBounds() {
  let now = 0;
  const cache = new SegmentCache({ maxBytes: 12, maxEntryBytes: 8, maxFills: 2, ttlMs: 1000, now: () => now });
  const put = (key, value, headers = {}) => { const fill = cache.begin(key); fill.append(Buffer.from(value)); fill.commit({}, headers); };
  put('a', '123456'); put('b', 'abcdef');
  assert.ok(cache.get('a'));
  put('c', 'ABCDEF');
  assert.equal(cache.get('b'), null, 'Least recently used entry is evicted');
  assert.equal(cache.stats().bytes, 12);
  put('large', '123456789');
  assert.equal(cache.get('large'), null, 'Large bodies continue streaming without being retained');
  put('private', 'secret', { 'cache-control': 'private' });
  put('cookie', 'secret', { 'set-cookie': ['session=test'] });
  put('revalidate', 'secret', { 'cache-control': 'public, max-age=0' });
  assert.equal(cache.get('private'), null); assert.equal(cache.get('cookie'), null);
  assert.equal(cache.get('revalidate'), null, 'An origin requiring revalidation is never reused without contacting it');
  const first = cache.begin('first'), second = cache.begin('second');
  assert.equal(cache.begin('third'), null, 'Concurrent cache fills are bounded');
  first.cancel(); second.cancel();
  now = 1001;
  assert.equal(cache.stats().bytes, 0, 'Expired bytes are reclaimed');
  const base = 'http://origin.test/index.m3u8';
  cache.registerPlaylist('#EXTM3U\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST\n', base);
  const segmentKey = cache.key('http://origin.test/a.ts');
  assert.equal(cache.eligible(segmentKey), true);
  put(segmentKey, 'cached');
  cache.registerPlaylist('#EXTM3U\n#EXTINF:6,\na.ts\n', base);
  assert.equal(cache.eligible(segmentKey), false, 'A URL reused by a live playlist revokes finite-segment caching');
  assert.equal(cache.get(segmentKey), null);
  cache.clear();
  console.log('PASS: segment cache bounds, LRU eviction, expiry, privacy and concurrent fill limits');
}

async function verifyProxyCache() {
  const counts = new Map();
  const bytes = Buffer.alloc(8192, 37);
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const upstream = http.createServer(async (req, res) => {
    const name = req.url;
    counts.set(name, (counts.get(name) || 0) + 1);
    if (name.endsWith('.m3u8')) {
      let body = '#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n';
      const files = name === '/live.m3u8' ? ['live.ts'] : name === '/range.m3u8' ? ['range.ts'] : ['a.ts', 'b.ts', 'private.ts', 'truncated.ts', 'big.ts', 'flaky.ts', 'missing.ts', 'payload?id=17'];
      for (const file of files) body += '#EXTINF:6,\n' + (name === '/range.m3u8' ? '#EXT-X-BYTERANGE:4@0\n' : '') + file + '\n';
      if (name !== '/live.m3u8') body += '#EXT-X-ENDLIST\n';
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' }); res.end(body); return;
    }
    if (name === '/flaky.ts' && counts.get(name) === 1) { res.writeHead(503); res.end('temporary'); return; }
    if (name === '/missing.ts') { res.writeHead(404); res.end('missing'); return; }
    if (name === '/a.ts' && counts.get(name) === 1) await gate;
    if (name === '/truncated.ts' && counts.get(name) === 1) {
      res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': bytes.length });
      res.write(bytes.subarray(0, 1024));
      setTimeout(() => res.destroy(), 20); return;
    }
    if (req.headers.range) {
      assert.equal(req.headers.range, 'bytes=0-3');
      assert.equal(req.headers['if-range'], '"origin-etag"');
      res.writeHead(206, { 'Content-Type': 'video/mp2t', 'Content-Length': 4, 'Content-Range': `bytes 0-3/${bytes.length}` }); res.end(bytes.subarray(0, 4)); return;
    }
    const data = name === '/big.ts' ? Buffer.alloc(16385, 42) : bytes;
    res.writeHead(200, { 'Content-Type': 'video/mp2t', 'Content-Length': data.length, ...(name === '/private.ts' ? { 'Cache-Control': 'no-store' } : {}) }); res.end(data);
  });
  const app = express();
  const router = createProxyRouter({ cache: { maxBytes: 32768, maxEntryBytes: 16384 } });
  app.use('/api', router);
  const proxy = http.createServer(app);
  await new Promise(resolve => upstream.listen(0, '127.0.0.1', resolve));
  await new Promise(resolve => proxy.listen(0, '127.0.0.1', resolve));
  const upstreamBase = `http://127.0.0.1:${upstream.address().port}`;
  const base = `http://127.0.0.1:${proxy.address().port}/api/proxy?url=`;
  const get = async (name, options) => {
    const response = await fetch(base + encodeURIComponent(upstreamBase + '/' + name), options);
    return { status: response.status, cache: response.headers.get('x-media-cache'), body: Buffer.from(await response.arrayBuffer()) };
  };
  try {
    await get('vod.m3u8');
    const concurrent = Promise.all(Array.from({ length: 6 }, () => get('a.ts')));
    for (let i = 0; i < 100 && router.mediaCache.stats().coalesced < 5; i++) await delay(10);
    release();
    const results = await concurrent;
    for (const response of results) assert.deepEqual(response.body, bytes);
    assert.equal(counts.get('/a.ts'), 1, 'Concurrent viewers share one origin request');
    assert.equal(results.filter(response => response.cache === 'COALESCED').length, 5);
    assert.equal((await get('a.ts')).cache, 'HIT');
    assert.equal(counts.get('/a.ts'), 1, 'Repeated segments are served from RAM');
    const range = await get('a.ts', { headers: { Range: 'bytes=0-3', 'If-Range': '"origin-etag"' } });
    assert.equal(range.status, 206); assert.deepEqual(range.body, bytes.subarray(0, 4));
    assert.equal(counts.get('/a.ts'), 2, 'Range and validators still reach the origin');
    for (const name of ['key.bin', 'private.ts', 'big.ts']) { await get(name); await get(name); assert.equal(counts.get('/' + name), 2, name + ' must not be retained'); }
    await get('live.m3u8'); await get('live.ts'); await get('live.ts');
    await get('range.m3u8'); await get('range.ts'); await get('range.ts');
    assert.equal(counts.get('/live.ts'), 2); assert.equal(counts.get('/range.ts'), 2);
    await assert.rejects(get('truncated.ts'), 'Truncated payload must fail rather than poison the cache');
    assert.deepEqual((await get('truncated.ts')).body, bytes);
    assert.equal(counts.get('/truncated.ts'), 2);
    assert.equal((await get('truncated.ts')).cache, 'HIT');
    await get('payload?id=17'); assert.equal((await get('payload?id=17')).cache, 'HIT', 'Extensionless HLS segments are cacheable');
    assert.deepEqual((await get('flaky.ts')).body, bytes);
    assert.equal(counts.get('/flaky.ts'), 2, 'A transient 503 is retried once');
    assert.equal((await get('missing.ts')).status, 404);
    assert.equal(counts.get('/missing.ts'), 1, 'Permanent errors are not retried');
    assert.ok(router.mediaCache.stats().bytes <= 32768);
    console.log('PASS: coalesced HLS downloads, cache hits, byte-identical payloads, Range, live/key bypass, truncation and bounded retries');
  } finally {
    release(); router.mediaCache.clear();
    proxy.closeAllConnections(); upstream.closeAllConnections();
    await Promise.all([new Promise(resolve => proxy.close(resolve)), new Promise(resolve => upstream.close(resolve))]);
  }
}

verifyBounds();
verifyProxyCache().catch(error => { console.error(error); process.exitCode = 1; });
