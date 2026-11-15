const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { setTimeout: delay } = require('timers/promises');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV native library '));
process.env.MOBILETV_DATA_DIR = sandbox;
const { decodeDocument, decodeFtyExtension, rc4 } = require('../src/content/format');
const { parseLive } = require('../src/content/live');
const { createAppServer } = require('../src/server');
const { Library } = require('../src/content/library');

const ftyEncode = document => rc4(Buffer.from(JSON.stringify(document).split('').map(character => String.fromCharCode(character.charCodeAt(0) + 2)).join('')), 'fantaiying921').toString('base64');

async function run() {
  assert.equal(rc4(Buffer.from('Plaintext'), 'Key').toString('hex'), 'bbf316e8d940af0ad3', 'Published RC4 test vector');
  const extension = { siteUrl: 'http://example.test/api', type: 1, categories: ['动作片', 'Anime'] };
  assert.deepEqual(decodeFtyExtension(ftyEncode(extension)), extension, 'UTF-16 shift handles Chinese category names');
  assert.deepEqual(decodeDocument(Buffer.concat([Buffer.from([255, 216, 255, 217]), Buffer.from('marker**' + Buffer.from('{/* note */"sites":[],}').toString('base64'))])), { sites: [] });
  assert.throws(() => decodeDocument(Buffer.from('<html>not a source</html>')), /网页/);
  const simple = parseLive('#EXTM3U\n#EXTINF:-1 group-title="News",News HD\n#EXTVLCOPT:http-user-agent=SourceClient\nhttp://example.test/live.m3u8\n', 'http://example.test');
  assert.equal(simple[0].urls[0].headers['user-agent'], 'SourceClient');
  assert.equal(simple[0].group, 'News');
  assert.equal(parseLive('News,#genre#\nOne,http://example.test/one.m3u8#http://example.test/two.m3u8', 'http://example.test')[0].urls.length, 2);
  assert.equal(parseLive('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n', 'http://example.test/channel.m3u8')[0].urls[0].url, 'http://example.test/channel.m3u8', 'A media playlist is one channel, rather than a list of segment channels');
  assert.equal(parseLive('#EXTM3U\n#EXTINF:-1 group-title="News, HD",One, Two\nhttp://example.test/live.m3u8\n', 'http://example.test')[0].name, 'One, Two');
  console.log('PASS: native FTY extension decoding, image/Base64 JSONC and M3U/TXT channel formats');

  let originBase, config, slowStarted, releaseSlow, mediaRequests = 0, pluginRequests = 0;
  const slowGate = new Promise(resolve => { releaseSlow = resolve; });
  const slowSeen = new Promise(resolve => { slowStarted = resolve; });
  const protectedHeaders = req => req.headers['user-agent'] === 'NativeFixture/1.0' && req.headers.referer === 'https://fixture.test/player';
  const responseVideo = (id = '1') => ({ vod_id: id, vod_name: `示例影片 ${id}`, vod_pic: originBase + '/poster.svg', vod_remarks: '两集', vod_content: '<b>fixture description</b>', vod_year: '2026', vod_play_from: 'HLS$$$备用', vod_play_url: `第一集$${originBase}/protected/master.m3u8?episode=1#第二集$${originBase}/protected/master.m3u8?episode=2$$$备用一$${originBase}/protected/master.m3u8` });
  const origin = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/config') { res.setHeader('Content-Type', 'application/octet-stream'); res.end(Buffer.concat([Buffer.from([255,216,255,217]), Buffer.from('native**' + Buffer.from(JSON.stringify(config)).toString('base64'))])); return; }
    if (url.pathname === '/bad') { res.end('<html>wrong endpoint</html>'); return; }
    if (url.pathname === '/plugin.jar') { pluginRequests++; res.writeHead(500); res.end(); return; }
    if (url.pathname === '/cms') {
      assert.equal(url.searchParams.get('token'), 'keep-me', 'Pre-existing source query parameters survive');
      assert.ok(protectedHeaders(req));
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ class: [{ type_id: 'movie', type_name: '动作片' }], list: [responseVideo(url.searchParams.get('ids') || '1')], page: Number(url.searchParams.get('pg')) || 1, pagecount: 3, total: 3 })); return;
    }
    if (url.pathname === '/api4') {
      if (url.searchParams.has('play')) { slowStarted(); await slowGate; res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ url: originBase + '/protected/master.m3u8', parse: 0 })); return; }
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ class: [{ type_id: '1', type_name: 'Test' }], list: [{ ...responseVideo(), vod_play_url: 'One$opaque-episode-id' }] })); return;
    }
    if (url.pathname === '/live.m3u') { assert.ok(protectedHeaders(req)); res.end(`#EXTM3U\n#EXTINF:-1 group-title="新闻",频道一\n${originBase}/protected/master.m3u8\n#EXTINF:-1 group-title="纪录",频道二\n${originBase}/protected/master.m3u8?alt=2\n`); return; }
    if (url.pathname.startsWith('/protected/')) {
      mediaRequests++;
      if (!protectedHeaders(req)) { res.writeHead(403); res.end('headers required'); return; }
      if (url.pathname.endsWith('.m3u8')) { res.setHeader('Content-Type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n'); }
      else { res.setHeader('Content-Type', 'video/mp2t'); res.end(Buffer.alloc(2048, 47)); }
      return;
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve));
  originBase = 'http://127.0.0.1:' + origin.address().port;
  const headers = { 'User-Agent': 'NativeFixture/1.0', Referer: 'https://fixture.test/player' };
  config = { spider: originBase + '/plugin.jar', sites: [{ key: 'native', name: 'Native T4', type: 3, api: 'csp_T4Guard', ext: ftyEncode({ ...extension, siteUrl: originBase + '/cms?token=keep-me' }), header: headers }, { key: 'api4', name: 'API4', type: 4, api: originBase + '/api4' }, { key: 'private', name: 'Not ported', type: 3, api: 'csp_UnknownGuard' }], lives: [{ name: 'Live', url: originBase + '/live.m3u', headers }] };
  const receiver = await createAppServer({ port: 0, enableDlna: false, enableAirplay: false, enableTvbox: false, dataDir: sandbox });
  const base = 'http://127.0.0.1:' + receiver.port;
  const call = async (route, body, expected = 200) => {
    const response = await fetch(base + '/api/library' + route, body === undefined ? undefined : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result;
  };
  try {
    const summary = await call('/config', { url: originBase + '/config' });
    assert.equal(summary.sites.filter(site => site.supported).length, 2);
    assert.equal(summary.sites.find(site => site.key === 'private').supported, false);
    assert.equal(pluginRequests, 0, 'Native operation never loads Android JAR or ARM code');
    assert.ok(!JSON.stringify(summary).includes('NativeFixture'), 'Source secrets and headers are not returned by summary');
    await call('/config', { url: originBase + '/bad' }, 502);
    assert.equal((await call('/config')).url, originBase + '/config', 'Invalid imports preserve the previous source');
    assert.equal(new Library({ dataDir: sandbox }).summary().sites.length, 3, 'Sources survive receiver restarts');
    const home = await call('/home?site=native'); assert.equal(home.classes[0].name, '动作片');
    const page = await call('/list?site=native&category=movie&page=2&keyword=demo'); assert.equal(page.page, 2);
    const detail = await call('/detail?site=native&id=1'); assert.equal(detail.lines.length, 2); assert.equal(detail.lines[0].episodes.length, 2);
    const play = await call('/play', { siteKey: 'native', vodId: '1', index: 0 });
    assert.equal(play.state.protocol, 'Library'); assert.equal(play.state.metadata.mimeType, 'application/vnd.apple.mpegurl');
    assert.ok(play.state.url.startsWith('/api/proxy?'));
    const playlist = await (await fetch(base + play.state.url)).text();
    const segment = playlist.split('\n').find(line => line.startsWith('/api/proxy?'));
    assert.match(segment, /headerContext=/, 'Headers propagate to HLS subresources');
    const data = await (await fetch(base + segment)).arrayBuffer(); assert.equal(data.byteLength, 2048);
    const advanced = await call('/next', { direction: 1, sessionId: play.state.sessionId }); assert.equal(advanced.playback.index, 1);
    await call('/next', { direction: 1, sessionId: play.state.sessionId }, 409);
    await call('/next', { direction: 1, sessionId: advanced.state.sessionId }, 409);
    const source = summary.lives[0].key;
    const { channels } = await call('/channels?source=' + source); assert.equal(channels.length, 2);
    const live = await call('/live/play', { sourceKey: source, channelId: channels[0].id });
    assert.equal(live.state.protocol, 'Live'); assert.equal(live.state.metadata.isLive, true);
    const nextChannel = await call('/next', { direction: 1, sessionId: live.state.sessionId }); assert.equal(nextChannel.playback.channelId, channels[1].id);
    await fetch(base + '/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'stop', sessionId: nextChannel.state.sessionId }) });
    assert.equal((await call('/playback')).playback, null);
    await call('/next', { direction: 1, sessionId: nextChannel.state.sessionId }, 409);
    const stale = call('/play', { siteKey: 'api4', vodId: '1' }, 409);
    await slowSeen;
    await fetch(base + '/api/control', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'cast', url: originBase + '/another.mp4' }) });
    releaseSlow(); await stale;
    assert.equal((await (await fetch(base + '/api/status')).json()).state.protocol, 'WebCast', 'An older parser request cannot replace a newer cast');
    assert.equal(pluginRequests, 0); assert.ok(mediaRequests >= 2);
    console.log('PASS: independent native VOD import, persistence, search/category/detail, playback, HLS headers, next episode, live channels and stale-request isolation');
  } finally {
    releaseSlow(); await receiver.close(); origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(() => {
  const target = fs.realpathSync(sandbox);
  assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.ok(path.basename(target).startsWith('MobileTV native library '));
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch (error) { if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error; }
});
