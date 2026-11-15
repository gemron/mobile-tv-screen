const assert = require('assert');
const http = require('http');
const plist = require('plist');
const castState = require('../src/services/castState');

function openReverse(baseUrl, sessionId) {
  return new Promise((resolve, reject) => {
    const req = http.request(`${baseUrl}/reverse`, {
      method: 'POST',
      headers: { Connection: 'Upgrade', Upgrade: 'PTTH/1.0', 'X-Apple-Session-ID': sessionId },
    });
    req.setTimeout(2000, () => req.destroy(new Error('AirPlay reverse handshake timed out')));
    req.on('error', reject);
    req.on('response', (res) => { res.resume(); reject(new Error(`Expected HTTP 101, got ${res.statusCode}`)); });
    req.on('upgrade', (res, socket, head) => {
      assert.strictEqual(res.statusCode, 101);
      let buffer = Buffer.alloc(0);
      const events = [];
      const waiters = new Set();
      const readEvents = (chunk) => {
        buffer = Buffer.concat([buffer, chunk]);
        while (true) {
          const end = buffer.indexOf('\r\n\r\n');
          if (end < 0) return;
          const headers = buffer.subarray(0, end).toString();
          const size = Number(headers.match(/Content-Length:\s*(\d+)/i)?.[1] || 0);
          if (buffer.length < end + 4 + size) return;
          assert(headers.startsWith('POST /event HTTP/1.1'), 'Reverse channel must send a real /event request');
          assert(headers.includes(`X-Apple-Session-ID: ${sessionId}`), 'Event must identify its AirPlay session');
          events.push(plist.parse(buffer.subarray(end + 4, end + 4 + size).toString()));
          buffer = buffer.subarray(end + 4 + size);
          socket.write('HTTP/1.1 200 OK\r\nContent-Length: 0\r\n\r\n');
          for (const waiter of waiters) waiter();
        }
      };
      socket.on('data', readEvents);
      socket.on('error', () => {});
      resolve({
        socket,
        events,
        waitFor(state) {
          return new Promise((done, fail) => {
            const timer = setTimeout(() => { waiters.delete(check); fail(new Error(`Missing AirPlay ${state} event`)); }, 2000);
            function check() {
              const event = events.find((item) => item.state === state);
              if (!event) return;
              clearTimeout(timer);
              waiters.delete(check);
              done(event);
            }
            waiters.add(check);
            check();
          });
        },
      });
      if (head.length) readEvents(head);
    });
    req.end();
  });
}

async function verifyAirplay(appServer, baseUrl, mediaUrl) {
  const service = appServer.airplayService;
  const dedicatedUrl = `http://127.0.0.1:${castState.protocols.airplay.port}`;
  const request = async (url, init = {}) => {
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(3000) });
    const body = Buffer.from(await response.arrayBuffer());
    return { status: response.status, body };
  };

  const info = plist.parse((await request(`${dedicatedUrl}/server-info`)).body.toString());
  assert.strictEqual(info.features, 0x13, 'Only implemented video/photo/HLS features should be advertised');
  assert.strictEqual(Number(service.airplayAd.txt.features), info.features, 'Bonjour and server-info must agree');
  assert.strictEqual(service.bonjour.registry.services.filter((ad) => ad.type.includes('raop')).length, 0,
    'Do not advertise an unimplemented RAOP speaker');

  const binaryUrl = 'http://example.test/airplay.mp4?token=a&b=2';
  // Python plistlib-generated binary plist, matching an actual iOS /play body.
  const binaryBody = Buffer.from('YnBsaXN0MDDSAQIDBF8QEENvbnRlbnQtTG9jYXRpb25eU3RhcnQtUG9zaXRpb25fECtodHRwOi8vZXhhbXBsZS50ZXN0L2FpcnBsYXkubXA0P3Rva2VuPWEmYj0yIz/QAAAAAAAACA0gL10AAAAAAAABAQAAAAAAAAAFAAAAAAAAAAAAAAAAAAAAZg==', 'base64');
  assert.strictEqual((await request(`${dedicatedUrl}/play`, {
    method: 'POST', headers: { 'Content-Type': 'application/x-apple-binary-plist' }, body: binaryBody,
  })).status, 200);
  assert.strictEqual(castState.state.url, binaryUrl);
  assert.strictEqual(castState.state.startPosition, 0.25);
  assert.strictEqual((await request(`${baseUrl}/play`, {
    method: 'POST', headers: { 'Content-Type': 'text/x-apple-plist+xml' },
    body: plist.build({ 'Content-Location': mediaUrl, 'Start-Position': 0.5 }),
  })).status, 200);
  assert.strictEqual(castState.state.startPosition, 0.5);
  for (const invalid of [Buffer.from('bplist00broken'), Buffer.from('Content-Location:   \n')]) {
    const oldSession = castState.state.sessionId;
    assert.strictEqual((await request(`${dedicatedUrl}/play`, {
      method: 'POST', headers: { 'Content-Type': 'text/parameters' }, body: invalid,
    })).status, 400);
    assert.strictEqual(castState.state.sessionId, oldSession, 'Invalid input must not replace the current media');
  }

  // Exercise both listening ports with real HTTP upgrades and client replies.
  for (const targetUrl of [baseUrl, dedicatedUrl]) {
    await request(`${targetUrl}/stop`, { method: 'POST' });
    const sessionId = `airplay-audit-${new URL(targetUrl).port}`;
    const channel = await openReverse(targetUrl, sessionId);
    const other = await openReverse(targetUrl, `${sessionId}-other`);
    let reconnect;
    try {
      assert.strictEqual((await request(`${targetUrl}/play`, {
        method: 'POST', headers: { 'Content-Type': 'text/parameters', 'X-Apple-Session-ID': sessionId },
        body: `Content-Location: ${mediaUrl}\r\nStart-Position: 0.25\r\n`,
      })).status, 200);
      assert.strictEqual((await channel.waitFor('playing')).category, 'video');
      assert.strictEqual((await request(`${targetUrl}/rate?value=0`, { method: 'POST' })).status, 200);
      await channel.waitFor('paused');
      assert.strictEqual(channel.socket.destroyed, false, 'HTTP 200 event acknowledgements must not close the socket');

      reconnect = await openReverse(targetUrl, sessionId);
      await reconnect.waitFor('paused');
      assert.strictEqual((await request(`${targetUrl}/scrub?position=42.5`, { method: 'POST' })).status, 200);
      assert.strictEqual(castState.state.position, 42.5);
      assert.strictEqual((await request(`${targetUrl}/stop`, { method: 'POST' })).status, 200);
      await channel.waitFor('stopped');
      await reconnect.waitFor('stopped');
      assert.strictEqual(other.events.length, 0, 'Events must not leak to another AirPlay session');
    } finally {
      channel.socket.destroy();
      other.socket.destroy();
      reconnect?.socket.destroy();
    }
  }

  const photoBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
  assert.strictEqual((await request(`${dedicatedUrl}/photo`, {
    method: 'PUT', body: photoBytes,
  })).status, 200, 'AirPlay photo bodies must work without Content-Type');
  assert((await request(castState.state.url)).body.equals(photoBytes));
  for (const endpoint of ['/fp-setup', '/auth-setup', '/pair-setup', '/pair-verify']) {
    assert.strictEqual((await request(`${dedicatedUrl}${endpoint}`, { method: 'POST' })).status, 501,
      'Unimplemented authentication must not report a successful handshake');
  }
  console.log('  PASS: AirPlay binary/XML requests, reverse events on both ports, session isolation, acknowledgements and capability flags');
}

module.exports = { verifyAirplay };
