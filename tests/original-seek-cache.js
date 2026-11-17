const assert = require('assert/strict');
const { Readable } = require('stream');
const { setTimeout: delay } = require('timers/promises');
const { OriginalRangeCache } = require('../src/services/originalRangeCache');

const block = 96 * 1024;
const data = Buffer.alloc(72 * block + 137);
for (let i = 0; i < data.length; i++) data[i] = i % 251;
const address = 'https://dl-pc-seek.drive.quark.cn/fixture.mkv';
async function wait(test) {
  const deadline = Date.now() + 2500;
  while (Date.now() < deadline) { if (test()) return; await delay(5); }
  throw new Error('Seek cleanup did not settle');
}
function fixture({ slowHeaders = false, slowBody = false, cacheOptions = {} } = {}) {
  const requests = [], active = new Set();
  const cache = new OriginalRangeCache({ blockBytes: block, maxBytes: 12 * block, concurrency: 4, ahead: 8, ...cacheOptions, open: async (_, headers, redirects, signal) => {
    const [start, end] = headers.Range.match(/\d+/g).map(Number);
    const record = { start, completed: false, cancelled: false }; requests.push(record); active.add(record);
    const abort = () => { record.cancelled = true; };
    signal.addEventListener('abort', abort, { once: true });
    try {
      if (slowHeaders) await delay(1000, undefined, { signal });
      const upRes = Readable.from((async function* () {
        if (slowBody) await delay(1000, undefined, { signal });
        for (let at = start; at <= Math.min(end, data.length - 1); at += 16 * 1024) {
          await delay(8, undefined, { signal });
          yield data.subarray(at, Math.min(at + 16 * 1024, end + 1, data.length));
        }
      })());
      upRes.statusCode = 206;
      upRes.headers = { 'content-range': `bytes ${start}-${Math.min(end, data.length - 1)}/${data.length}` };
      upRes.on('error', () => {});
      upRes.once('close', () => { record.completed = !signal.aborted; active.delete(record); signal.removeEventListener('abort', abort); });
      return { upRes };
    } catch (error) { active.delete(record); signal.removeEventListener('abort', abort); throw error; }
  } });
  cache.setMedia('/api/proxy?fixture=seek', 'PLAYING');
  return { cache, requests, active };
}
async function collect(response) {
  const chunks = []; for await (const chunk of response.stream) chunks.push(chunk);
  return Buffer.concat(chunks);
}
async function firstChunk(response) {
  return new Promise((resolve, reject) => {
    response.stream.once('error', reject);
    response.stream.once('data', chunk => { response.stream.pause(); resolve(chunk); });
  });
}

(async () => {
  const abandoned = fixture();
  try {
    const response = await abandoned.cache.response(address, {}, 'one', 'bytes=0-');
    await firstChunk(response);
    const started = abandoned.requests.length;
    response.stream.destroy();
    await wait(() => abandoned.active.size === 0 && abandoned.cache.jobs.size === 0);
    assert.equal(abandoned.requests.length, started, 'Closing the last playback response must cancel queued prefetch instead of downloading the abandoned window');
    assert.ok(abandoned.requests.every(request => request.cancelled || request.completed));
  } finally { abandoned.cache.close(); }

  const early = fixture({ slowHeaders: true });
  try {
    const controller = new AbortController();
    const pending = early.cache.response(address, {}, 'one', 'bytes=0-', controller.signal);
    await delay(10); controller.abort();
    await assert.rejects(pending, { name: 'AbortError' });
    await wait(() => early.active.size === 0 && early.cache.jobs.size === 0);
    assert.equal(early.cache.stats().failures, 0, 'Cancelling a seek before headers is not a source failure');
  } finally { early.cache.close(); }

  const stalled = fixture({ slowBody: true });
  try {
    const response = await stalled.cache.response(address, {}, 'one', 'bytes=0-');
    response.stream.on('error', () => {}); response.stream.resume();
    await delay(20);
    const stopped = Date.now(); response.stream.destroy();
    await wait(() => stalled.active.size === 0 && stalled.cache.jobs.size === 0);
    assert.ok(Date.now() - stopped < 300, 'Destroying a response cancels stalled body reads immediately, before async iterator cleanup');
  } finally { stalled.cache.close(); }

  const warm = fixture();
  try {
    await warm.cache.read(address, {}, 'one', `bytes=${4 * block}-`);
    await wait(() => warm.cache.jobs.size === 0);
    const count = start => warm.requests.filter(request => request.start === start).length;
    const forwardBefore = count(7 * block), backBefore = count(4 * block);
    const forward = await warm.cache.response(address, {}, 'one', `bytes=${7 * block + 137}-${8 * block + 311}`);
    assert.deepEqual(await collect(forward), data.subarray(7 * block + 137, 8 * block + 312));
    await wait(() => warm.cache.jobs.size === 0);
    assert.equal(count(7 * block), forwardBefore, 'Seeking inside a warm original-file range reuses its exact bytes');
    assert.ok(warm.cache.stats().bytes > 0, 'Closing a remux input retains completed original bytes for a subsequent seek');
    const back = await warm.cache.response(address, {}, 'one', `bytes=${4 * block + 91}-${5 * block + 17}`);
    assert.deepEqual(await collect(back), data.subarray(4 * block + 91, 5 * block + 18));
    await wait(() => warm.cache.jobs.size === 0);
    assert.equal(count(4 * block), backBefore, 'A short backward seek reuses history instead of clearing the entire cache');
    assert.ok(warm.cache.stats().bytes <= warm.cache.maxBytes);
    warm.cache.setMedia('', 'STOPPED');
    await wait(() => warm.cache.jobs.size === 0);
    assert.equal(warm.cache.stats().bytes, 0, 'Stopping releases completed data as well as in-flight reads');
  } finally { warm.cache.close(); }

  const shared = fixture();
  try {
    const one = await shared.cache.response(address, {}, 'one', 'bytes=0-');
    const two = await shared.cache.response(address, {}, 'one', 'bytes=0-');
    const [, prefix] = await Promise.all([firstChunk(one), firstChunk(two)]);
    one.stream.destroy();
    assert.ok(Buffer.concat([prefix, await collect(two)]).equals(data), 'The remaining viewer receives every byte once');
    await wait(() => shared.cache.jobs.size === 0);
    assert.equal(shared.requests.filter(request => request.start === 0).length, 1, 'One viewer leaving cannot cancel a shared range still used by another viewer');
    assert.equal(shared.cache.stats().failures, 0);
  } finally { shared.cache.close(); }

  const rapid = fixture();
  try {
    let previous;
    for (const index of [0, 48, 4, 33, 1, 52]) {
      previous?.stream.destroy();
      previous = await rapid.cache.response(address, {}, 'one', `bytes=${index * block + 137}-`);
      assert.deepEqual(await firstChunk(previous), data.subarray(index * block + 137, index * block + 16 * 1024));
      assert.ok(rapid.cache.stats().bytes <= rapid.cache.maxBytes);
    }
    previous.stream.destroy();
    const final = await rapid.cache.response(address, {}, 'one', `bytes=${30 * block + 91}-${33 * block + 311}`);
    assert.deepEqual(await collect(final), data.subarray(30 * block + 91, 33 * block + 312));
    await wait(() => rapid.active.size === 0 && rapid.cache.jobs.size === 0);
    const count = rapid.requests.length; await delay(80);
    assert.equal(rapid.requests.length, count, 'Late completions cannot restart cancelled seek windows');
    assert.equal(rapid.cache.stats().failures, 0);
    assert.ok(rapid.cache.stats().bytes <= rapid.cache.maxBytes);
  } finally { rapid.cache.close(); }

  const probe = fixture({ cacheOptions: { maxBytes: 6 * block, ahead: 4, concurrency: 1 } });
  try {
    for (const index of [30, 31]) { await probe.cache.read(address, {}, 'one', `bytes=${index * block}-`); await wait(() => probe.cache.jobs.size === 0); }
    const offset = probe.cache.stats().readOffset, targetRequests = probe.requests.filter(request => request.start === 32 * block).length;
    const header = await probe.cache.response(address, {}, 'one', `bytes=0-${block - 1}`, undefined, { seekRead: true });
    await wait(() => probe.cache.jobs.size === 0);
    assert.equal(probe.cache.stats().readOffset, offset, 'A remux header/index probe must not move the playback cache window back to the file header');
    header.stream.destroy();
    const target = await probe.cache.response(address, {}, 'one', `bytes=${32 * block}-${33 * block - 1}`);
    assert.ok((await collect(target)).equals(data.subarray(32 * block, 33 * block)));
    assert.equal(probe.requests.filter(request => request.start === 32 * block).length, targetRequests, 'Probing the container must not evict and redownload a cached seek target');
    await wait(() => probe.cache.jobs.size === 0);
    const headerRequests = probe.requests.filter(request => request.start === 0).length;
    const again = await probe.cache.response(address, {}, 'one', `bytes=0-${block - 1}`, undefined, { seekRead: true });
    assert.ok((await collect(again)).equals(data.subarray(0, block)));
    assert.equal(probe.requests.filter(request => request.start === 0).length, headerRequests, 'Bounded container headers are retained for repeated remux seeks');
  } finally { probe.cache.close(); }

  const switched = fixture();
  try {
    await switched.cache.read(address, {}, 'one', 'bytes=0-');
    await wait(() => switched.cache.jobs.size === 0);
    const old = await switched.cache.response(address, {}, 'one', 'bytes=0-');
    old.stream.on('error', () => {});
    await firstChunk(old);
    switched.cache.setMedia('/api/proxy?fixture=new-film', 'PLAYING');
    await wait(() => switched.active.size === 0 && switched.cache.running === 0);
    const count = switched.requests.length;
    try { await collect(old); } catch (error) { assert.ok(error.name === 'AbortError' || error.code === 'ERR_STREAM_PREMATURE_CLOSE'); }
    await delay(80);
    assert.equal(switched.requests.length, count, 'An old response cannot resume downloads after a media change');
    assert.equal(switched.cache.stats().bytes, 0, 'Late readers cannot repopulate cleared entries from the previous film');
    assert.equal(switched.cache.stats().active, false);
  } finally { switched.cache.close(); }
  console.log('PASS: seek cache reuse, backward history, rapid replacement, shared viewers, pre-header cancellation and last-reader cleanup');
})().catch(error => { console.error(error); process.exitCode = 1; });
