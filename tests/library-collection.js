const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV collection '));
process.env.MOBILETV_DATA_DIR = sandbox;
const { Library } = require('../src/content/library');
const { createAppServer } = require('../src/server');
const castState = require('../src/services/castState');
let receiver, origin;

async function run() {
  let originBase, configReads = 0;
  origin = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (/^\/config[AB]$/.test(url.pathname)) {
      configReads++; const name = url.pathname.slice(-1);
      res.end(JSON.stringify({ sites: [{ key: 'same-key', name: 'Site ' + name, type: 1, api: originBase + '/api' + name }], lives: [{ name: 'Live ' + name, channels: [{ name: 'News ' + name, url: originBase + '/live' + name + '.m3u8' }] }] })); return;
    }
    if (/^\/api[AB]$/.test(url.pathname)) {
      const name = url.pathname.slice(-1);
      res.end(JSON.stringify({ list: [{ vod_id: '1', vod_name: 'Movie ' + name, vod_play_from: 'Original', vod_play_url: `Episode 1$${originBase}/movie${name}.mp4?ep=1#Episode 2$${originBase}/movie${name}.mp4?ep=2` }] })); return;
    }
    res.writeHead(404); res.end('missing');
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve)); originBase = 'http://127.0.0.1:' + origin.address().port;
  // Existing single-address installations migrate without losing their source.
  fs.writeFileSync(path.join(sandbox, 'library-config.json'), JSON.stringify({ version: 1, url: originBase + '/configA', importedAt: 123, document: { sites: [{ key: 'same-key', name: 'Site A', type: 1, api: originBase + '/apiA' }] } }));
  receiver = await createAppServer({ port: 0, enableDlna: false, enableAirplay: false, enableTvbox: false, enableBilibili: false, dataDir: sandbox });
  const base = 'http://127.0.0.1:' + receiver.port;
  const call = async (route, body, expected = 200) => {
    const response = await fetch(base + '/api/library' + route, body === undefined ? undefined : { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    const data = await response.json(); assert.equal(response.status, expected, JSON.stringify(data)); return data;
  };
  let summary = await call('/config'); assert.equal(summary.sources.length, 1); const a = summary.sourceId;
  summary = await call('/config', { url: originBase + '/configA', name: 'My source A' }); assert.equal(summary.sources.length, 1);
  let play = await call('/play', { siteKey: 'same-key', vodId: '1', index: 1 });
  castState.syncFromPlayer({ sessionId: play.state.sessionId, position: 73, duration: 120, status: 'PAUSED' });
  let collection = await call('/favorites', { kind: 'vod', siteKey: 'same-key', vodId: '1', saved: true });
  assert.equal(collection.history[0].index, 1); assert.equal(collection.history[0].position, 73); assert.equal(collection.favorites.length, 1);
  await call('/favorites', { kind: 'vod', siteKey: 'same-key', vodId: '1', saved: true });
  summary = await call('/config', { url: originBase + '/configB', name: 'My source B' }); const b = summary.sourceId; assert.notEqual(a, b);
  await call('/play', { siteKey: 'same-key', vodId: '1' });
  collection = await call('/favorites', { kind: 'vod', siteKey: 'same-key', vodId: '1', saved: true });
  assert.equal(collection.history.length, 2); assert.equal(collection.favorites.length, 2, 'Same site and video IDs in separate subscriptions remain separate');
  const reads = configReads;
  summary = await call('/sources/select', { id: a }); assert.equal(configReads, reads, 'Saved sources switch without refetching a subscription');
  assert.equal(summary.sites[0].name, 'Site A');
  await call('/sources/rename', { id: b, name: 'Renamed B' });
  await call('/config', { url: originBase + '/missing' }, 502); assert.equal((await call('/config')).sourceId, a);
  const entry = collection.history.find(item => item.sourceId === a);
  play = await call('/resume', { id: entry.id }); assert.equal(play.playback.index, 1); assert.equal(play.state.startPosition, 73); assert.ok(play.state.url.includes('movieA'));
  castState.syncFromPlayer({ sessionId: play.state.sessionId - 1, position: 99, duration: 120, status: 'PLAYING' });
  assert.equal((await call('/collection')).history.find(item => item.id === entry.id).position, 73, 'Stale player telemetry cannot change a saved position');
  const source = summary.lives[0].key, channel = (await call('/channels?source=' + source)).channels[0];
  await call('/live/play', { sourceKey: source, channelId: channel.id });
  await call('/favorites', { kind: 'live', sourceKey: source, channelId: channel.id, saved: true });
  await call('/sources/remove', { id: a }, 400); await call('/sources/remove', { id: 'missing' }, 404);
  await receiver.close(); receiver = null;
  const restored = new Library({ dataDir: sandbox });
  try {
    assert.equal(restored.summary().sources.length, 2); assert.equal(restored.summary().sources.find(item => item.id === b).name, 'Renamed B');
    const saved = restored.collection.summary(); assert.equal(saved.favorites.length, 3); assert.equal(saved.history.length, 3); assert.ok(Math.abs(saved.history.find(item => item.id === entry.id).position - 73) < 1);
    assert.ok(!JSON.stringify(saved).includes('movieA.mp4'), 'History stores catalog selections rather than media links');
    restored.selectSource(b); restored.removeSource(a);
    await assert.rejects(restored.resume({ id: entry.id }), /不存在/);
    restored.collection.remove('history', undefined, true); assert.equal(restored.collection.summary().history.length, 0); assert.equal(restored.collection.summary().favorites.length, 3);
  } finally { await restored.close(); }
  console.log('PASS: legacy migration, offline subscription switching, rename/removal, source-isolated favorites, persistent resume positions and live history');
}
run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  await receiver?.close(); origin?.closeAllConnections(); if (origin) await new Promise(resolve => origin.close(resolve));
  const resolved = fs.realpathSync(sandbox); assert.equal(path.dirname(resolved).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.ok(path.basename(resolved).startsWith('MobileTV collection '));
  fs.rmSync(resolved, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});
