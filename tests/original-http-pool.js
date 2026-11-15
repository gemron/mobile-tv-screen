const assert = require('assert/strict');
const http2 = require('http2');
const { EventEmitter } = require('events');
const { Readable } = require('stream');
const { setTimeout: delay } = require('timers/promises');
const { OriginalHttpPool } = require('../src/services/originalHttpPool');
const { OriginalRangeCache } = require('../src/services/originalRangeCache');

const target = 'https://dl-pc-fixture.drive.quark.cn/original.mkv?signed=fixture';
const bytes = Buffer.from(Array.from({ length: 256 * 1024 }, (_, i) => i % 251));
const server = http2.createServer({ settings: { maxConcurrentStreams: 100 } });
const connections = new Set(), requests = [], sessions = [];
let active = 0, maxActive = 0, refused = false, sentGoaway = false;
let releaseWide;
const wideGate = new Promise(resolve => { releaseWide = resolve; });
server.on('session', session => { sessions.push(session); connections.add(session); session.on('error', () => {}); session.on('close', () => connections.delete(session)); });
server.on('stream', async (stream, headers) => {
  stream.on('error', () => {});
  requests.push({ path: headers[':path'], cookie: headers.cookie, range: headers.range });
  if (headers[':path'].startsWith('/refuse') && !refused) { refused = true; stream.close(http2.constants.NGHTTP2_REFUSED_STREAM); return; }
  if (headers[':path'].startsWith('/goaway') && !sentGoaway) { sentGoaway = true; stream.session.goaway(0, stream.id); }
  if (headers[':path'].startsWith('/redirect')) { stream.respond({ ':status': 302, location: 'https://external.invalid/file' }); stream.end(); return; }
  active++; maxActive = Math.max(maxActive, active);
  stream.once('close', () => active--);
  const range = /^bytes=(\d+)-(\d+)$/.exec(headers.range || '');
  const start = range ? Number(range[1]) : 0, end = range ? Number(range[2]) : bytes.length - 1;
  if (headers[':path'].startsWith('/wide')) await wideGate;
  else await delay(headers[':path'].startsWith('/slow') ? 150 : 10);
  if (stream.destroyed) return;
  stream.respond({ ':status': 206, 'content-type': 'video/x-matroska', 'content-range': `bytes ${start}-${end}/${bytes.length}`, 'content-length': end - start + 1 });
  stream.end(bytes.subarray(start, end + 1));
});

async function body(response) { const chunks = []; for await (const chunk of response.upRes) chunks.push(chunk); return Buffer.concat(chunks); }
async function main() {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const local = 'http://127.0.0.1:' + server.address().port;
  let fallbackCalls = 0;
  const fallback = async () => { fallbackCalls++; return { upRes: Readable.from([Buffer.from('fallback')]) }; };
  const connect = (_, options) => http2.connect(local, options);
  const pool = new OriginalHttpPool({ fallback, connect, maxRequests: 8 });
  try {
    const results = await Promise.all(Array.from({ length: 24 }, async (_, i) => {
      const start = i * 1024, response = await pool.open(target, { Range: `bytes=${start}-${start + 1023}`, Cookie: i % 2 ? 'account-a' : 'account-b', Connection: 'keep-alive' });
      assert.equal(response.upRes.statusCode, 206);
      assert.equal(response.upRes.headers['content-range'], `bytes ${start}-${start + 1023}/${bytes.length}`);
      assert.deepEqual(await body(response), bytes.subarray(start, start + 1024));
    }));
    assert.equal(results.length, 24);
    assert.equal(fallbackCalls, 0, 'rotating connections cannot lose already reserved requests');
    assert.ok(pool.stats().rotations >= 2);
    assert.ok(sessions.length >= 3 && sessions.length <= 4, 'requests reuse each connection and rotate before its cap');
    assert.ok(maxActive > 1, 'ranges are multiplexed');
    for (const request of requests) assert.equal(request.cookie, (Number(/^bytes=(\d+)/.exec(request.range)[1]) / 1024) % 2 ? 'account-a' : 'account-b', 'credentials stay on their own stream');
    assert.ok(requests.every(request => request.path.endsWith('?signed=fixture')));
  } finally { pool.close(); }

  const wide = new OriginalHttpPool({ fallback, connect, connectionsPerOrigin: 4, streamsPerConnection: 4 });
  try {
    const before = sessions.length;
    const reads = Array.from({ length: 16 }, (_, i) => wide.open(target.replace('/original', '/wide'), { range: `bytes=${i * 1024}-${i * 1024 + 1023}`, cookie: 'wide-' + i }).then(body));
    const deadline = Date.now() + 3000;
    while (wide.stats().activeStreams < 16 && Date.now() < deadline) await delay(5);
    assert.equal(wide.stats().connections, 4, 'high-resolution reads expand to a bounded four-connection pool');
    assert.equal(wide.stats().activeStreams, 16);
    assert.ok(sessions.slice(before).every(session => session.state.localWindowSize > 0));
    releaseWide();
    const received = await Promise.all(reads);
    received.forEach((chunk, i) => assert.deepEqual(chunk, bytes.subarray(i * 1024, i * 1024 + 1024)));
    await delay(10);
    assert.equal(wide.stats().activeStreams, 0);
    assert.deepEqual(await body(await wide.open(target, { range: 'bytes=0-1023' })), bytes.subarray(0,1024));
    assert.equal(wide.stats().connections, 4, 'completed sessions are reused without opening additional connections');
    assert.equal(wide.stats().fallbackRequests, 0);
  } finally { releaseWide(); wide.close(); }

  const shared = new OriginalHttpPool({ fallback, connect });
  try {
    const abort = new AbortController();
    const cancelled = shared.open(target.replace('/original', '/slow'), { range: 'bytes=0-1023' }, 5, abort.signal);
    const surviving = shared.open(target, { range: 'bytes=1024-2047', cookie: 'second' });
    await delay(10); abort.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
    assert.deepEqual(await body(await surviving), bytes.subarray(1024, 2048), 'aborting one range does not destroy a shared session');
    assert.equal(shared.stats().fallbackRequests, 0, 'an abort cannot start an HTTP/1 retry');
    assert.deepEqual(await body(await shared.open(target.replace('/original', '/refuse'), { range: 'bytes=0-1023' })), bytes.subarray(0, 1024));
    assert.equal(shared.stats().retries, 1, 'a refused unprocessed GET is retried on a fresh session');
    for (const result of await Promise.all(Array.from({length:3}, () => shared.open(target.replace('/original', '/goaway'), {range:'bytes=0-1023'})))) assert.deepEqual(await body(result), bytes.subarray(0, 1024));
    assert.equal(shared.stats().fallbackRequests, 0, 'GOAWAY drains existing reads while later requests use a new session');
    await shared.open(target.replace('/original', '/redirect'), { cookie: 'private', range: 'bytes=0-1023' });
    assert.equal(shared.stats().fallbackRequests, 1, 'redirect handling remains with the existing credential-stripping path');
    const count = requests.length;
    await shared.open('https://dl-pc-fixture.drive.quark.cn.external.invalid/file', { cookie: 'private' });
    await shared.open('http://dl-pc-fixture.drive.quark.cn/file', {});
    assert.equal(requests.length, count, 'HTTP/2 transport only applies to official HTTPS original-file hosts');
  } finally { shared.close(); }

  let attempts = 0;
  const broken = new OriginalHttpPool({ fallback, connect() { attempts++; throw Object.assign(new Error('Protocol unavailable'), { code: 'ERR_HTTP2_ERROR' }); } });
  try {
    await broken.open(target, {}); await broken.open(target, {});
    assert.equal(attempts, 1, 'unsupported transport is cooled down rather than retried for every range');
    assert.equal(broken.stats().fallbackRequests, 2);
  } finally { broken.close(); }

  const pendingSession = new EventEmitter();
  Object.assign(pendingSession, { destroyed: false, setTimeout() {}, setLocalWindowSize() {}, close() { this.destroy(); }, destroy() { this.destroyed = true; this.emit('close'); } });
  const connecting = new OriginalHttpPool({ fallback, connect: () => pendingSession });
  try {
    const controller = new AbortController(), pending = connecting.open(target, {}, 5, controller.signal);
    controller.abort();
    await Promise.race([assert.rejects(pending, { name: 'AbortError' }), delay(100).then(() => { throw new Error('Cancelled readers waited for the shared handshake'); })]);
    assert.equal(connecting.stats().fallbackRequests, 0);
  } finally { connecting.close(); }

  const transport = new OriginalHttpPool({ fallback, connect, maxRequests: 16 });
  const cache = new OriginalRangeCache({ open: transport.open.bind(transport), blockBytes: 4096, maxBytes: 64 * 1024, concurrency: 4, ahead: 8 });
  try {
    const response = await cache.response(target, { cookie: 'scoped' }, 'one', 'bytes=137-131100');
    const chunks = []; for await (const chunk of response.stream) chunks.push(chunk);
    assert.deepEqual(Buffer.concat(chunks), bytes.subarray(137, 131101), 'continuous playback remains byte exact across connection rotations');
    assert.ok(transport.stats().rotations > 0);
    assert.ok(cache.stats().bytes <= cache.stats().maxBytes);
  } finally { cache.close(); transport.close(); }
  await delay(30);
  console.log('PASS: HTTP/2 range multiplexing, rotation, exact playback bytes, per-stream credentials, abort isolation and HTTP/1 fallback');
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const session of connections) session.destroy();
  await new Promise(resolve => server.close(resolve));
});
