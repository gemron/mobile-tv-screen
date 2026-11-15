const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const express = require('express');
const { Torrents } = require('../src/content/torrents');
async function run() {
  const { default: WebTorrent } = await import('webtorrent');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV torrent test '));
  const seed = new WebTorrent({ dht: false, tracker: false, lsd: false, utp: false, natUpnp: false, natPmp: false });
  const player = new Torrents(directory, { clientOptions: { dht: false, tracker: false } });
  const input = Buffer.alloc(300000); for (let i = 0; i < input.length; i++) input[i] = i % 251;
  input.name = 'fixture.mp4';
  let server;
  try {
    const torrent = await new Promise((resolve, reject) => { seed.once('error', reject); seed.seed(input, { name: 'fixture.mp4', announce: [], pieceLength: 16384 }, resolve); });
    if (!seed.address()) await new Promise(resolve => seed.once('listening', resolve));
    const app = express();
    app.get('/fixture.torrent', (_, res) => res.end(torrent.torrentFile));
    app.get('/api/library/torrent/:id/:index/:name', (req, res) => player.serve(req, res));
    server = http.createServer(app); await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    const origin = 'http://127.0.0.1:' + server.address().port, detail = await player.detail(origin + '/fixture.torrent');
    assert.equal(detail.lines[0].episodes.length, 1);
    assert.equal(player.active.selected, -1, 'Metadata browsing does not start a media download');
    const media = await player.resolve(detail.lines[0].episodes[0].id);
    player.active.torrent.addPeer('127.0.0.1:' + seed.address().port);
    const response = await fetch(origin + media.url, { headers: { Range: 'bytes=12345-98765' }, signal: AbortSignal.timeout(15000) });
    assert.equal(response.status, 206); assert.equal(response.headers.get('content-range'), 'bytes 12345-98765/300000');
    assert.deepEqual(Buffer.from(await response.arrayBuffer()), input.subarray(12345, 98766));
    const suffix = await fetch(origin + media.url, { headers: { Range: 'bytes=-100' }, signal: AbortSignal.timeout(10000) });
    assert.deepEqual(Buffer.from(await suffix.arrayBuffer()), input.subarray(-100));
    const bad = await fetch(origin + media.url, { headers: { Range: 'bytes=999999-' } }); assert.equal(bad.status, 416);
    assert.ok(fs.readdirSync(player.active.directory).every(name => !name.includes('fixture')), 'Untrusted filenames never become disk paths');
    const cache = player.active.directory; await player.stop(); assert.equal(fs.existsSync(cache), false);
    assert.equal((await fetch(origin + media.url)).status, 410);
    console.log('PASS: local P2P metadata, selected-file download, byte-exact Range/suffix, limits and session cache cleanup');
  } finally {
    await player.close(); await new Promise(resolve => seed.destroy(resolve));
    if (server) await new Promise(resolve => server.close(resolve));
    const target = path.resolve(directory); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('MobileTV torrent test '));
    fs.rmSync(target, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
