const assert = require('assert/strict');
const fs = require('fs'), os = require('os'), path = require('path'), http = require('http'), crypto = require('crypto');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV hmys transport ')); process.env.MOBILETV_DATA_DIR = sandbox;
const { createAppServer } = require('../src/server');
const { resolvePlayback } = require('../src/content/playback');
const mediaHeaders = require('../src/services/mediaHeaders');
const { normalize, signedUrl } = require('../src/services/hmysTransport');
const context = { kind: 'hmys', ck: Buffer.from('k=fixture&Time=fixture&uid=fixture').toString('base64'), sign: 'fixture-signing-material-32-chars!' };
const normalized = normalize(context), address = signedUrl('https://media.test/a%20b/index.m3u8?stale=1', context, 1794758400), parsed = new URL(address);
assert.equal(parsed.searchParams.get('wsTime'), (1794758400).toString(16)); assert.equal(parsed.searchParams.get('stale'), null);
assert.equal(parsed.searchParams.get('wsSecret'), crypto.createHash('md5').update(context.sign + '/a b/index.m3u8' + (1794758400).toString(16)).digest('hex'));
assert.throws(() => normalize({ ...context, ck: 'not a query' }), /凭据/);
let receiver, origin;
(async () => {
  let hits = 0, external = 0;
  origin = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/external.bin') { external++; assert.equal(url.searchParams.has('wsSecret'), false); assert.equal(req.headers.cookie, undefined); res.end('external'); return; }
    hits++; const time = url.searchParams.get('wsTime');
    assert.ok(time && Math.abs(parseInt(time, 16) * 1000 - Date.now()) < 15000);
    assert.equal(url.searchParams.get('wsSecret'), crypto.createHash('md5').update(context.sign + url.pathname + time).digest('hex')); assert.equal(url.searchParams.get('k'), 'fixture'); assert.equal(req.headers['user-agent'], 'Mozi');
    if (url.pathname.endsWith('.m3u8')) { res.setHeader('content-type', 'application/vnd.apple.mpegurl'); res.end(url.pathname === '/master.m3u8' ? '#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=100000\n/variant.m3u8?obsolete=1\n' : '#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXT-X-KEY:METHOD=AES-128,URI="/key?obsolete=1"\n#EXTINF:2,\n/segment.ts?obsolete=1\n#EXT-X-ENDLIST\n'); }
    else if (url.pathname === '/key') res.end(Buffer.alloc(16, 3));
    else { res.setHeader('content-type', 'video/mp2t'); res.end(Buffer.alloc(188 * 5, 0x47)); }
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve)); const source = 'http://127.0.0.1:' + origin.address().port;
  receiver = await createAppServer({ port: 0, enableDlna: false, enableAirplay: false, enableTvbox: false, enableBilibili: false, dataDir: sandbox }); const base = 'http://127.0.0.1:' + receiver.port;
  const raw = { url: source + '/master.m3u8', type: 'hls', parse: 0, header: { 'user-agent': 'Mozi', cookie: 'fixture-private' }, playlistContext: context };
  const resolved = await resolvePlayback({ api: source, headers: {} }, raw), local = mediaHeaders.mediaUrl(resolved.url, resolved.headers, '', resolved.mimeType, resolved.playlistContext);
  assert.ok(!local.includes(context.ck) && !local.includes(context.sign));
  const master = await (await fetch(base + local)).text(), variantPath = master.split('\n').find(line => line.startsWith('/api/proxy?'));
  const playlist = await (await fetch(base + variantPath)).text(); assert.ok(!playlist.includes('wsSecret') && !playlist.includes('fixture&Time') && !playlist.includes('obsolete'));
  const keyPath = /URI="([^"]+)"/.exec(playlist)[1], segmentPath = playlist.split('\n').find(line => line.startsWith('/api/proxy?'));
  assert.equal((await (await fetch(base + keyPath)).arrayBuffer()).byteLength, 16);
  assert.equal((await (await fetch(base + segmentPath)).arrayBuffer()).byteLength, 940); const before = hits;
  assert.equal((await (await fetch(base + segmentPath)).arrayBuffer()).byteLength, 940); assert.equal(hits, before, 'Completed segments still use the existing bounded cache');
  const id = new URL(local, base).searchParams.get('headerContext'), outside = source.replace('127.0.0.1', 'localhost') + '/external.bin';
  assert.equal(mediaHeaders.requestUrl(id, outside), outside); assert.equal(await (await fetch(base + '/api/proxy?url=' + encodeURIComponent(outside) + '&headerContext=' + id)).text(), 'external'); assert.equal(external, 1);
  assert.equal((await fetch(base + '/api/proxy?url=' + encodeURIComponent(source + '/segment.ts') + '&headerContext=expired')).status, 410);
  console.log('PASS: Hmys hex-time signing, nested playlists/keys/segments, bounded cache, private context handling and cross-origin credential isolation');
})().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await receiver?.close(); origin?.closeAllConnections(); if (origin) await new Promise(resolve => origin.close(resolve));
  const target = fs.realpathSync(sandbox); assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.ok(path.basename(target).startsWith('MobileTV hmys transport ')); fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
