const assert = require('assert/strict');
const { Readable, Writable } = require('stream');
const { pipeline } = require('stream/promises');
const { setTimeout: delay } = require('timers/promises');
const { RemuxBuffer } = require('../src/services/remuxBuffer');

(async () => {
  const chunkBytes = 16384, capacity = 8 * chunkBytes, data = Buffer.alloc(64 * chunkBytes);
  for (let i = 0; i < data.length; i++) data[i] = i % 251;
  let produced = 0, release, received = [];
  const source = Readable.from((function* () { for (let offset = 0; offset < data.length; offset += chunkBytes) { produced++; yield data.subarray(offset, offset + chunkBytes); } })(), { objectMode: false, highWaterMark: chunkBytes });
  const buffer = new RemuxBuffer({ maxBytes: capacity });
  const sink = new Writable({ highWaterMark: chunkBytes, write(chunk, _, callback) { received.push(chunk); if (!release) release = callback; else callback(); } });
  const done = pipeline(source, buffer, sink);
  await delay(40);
  assert.ok(produced > 8, 'producer keeps preparing future output while the consumer waits');
  assert.ok(produced < 64, 'full reserve applies backpressure instead of reading the entire movie');
  assert.ok(buffer.stats().bytes >= capacity && buffer.stats().bytes <= capacity + chunkBytes);
  release(); await done;
  assert.deepEqual(Buffer.concat(received), data);
  assert.equal(buffer.stats().bytes, 0);
  const live = new RemuxBuffer({ live: true }); assert.equal(live.maxBytes, 256 * 1024); live.destroy();
  const cancelled = new RemuxBuffer({ maxBytes: capacity });
  cancelled.write(Buffer.alloc(capacity)); cancelled.destroy(); assert.equal(cancelled.stats().bytes, 0);
  console.log('PASS: remux output builds a bounded ready reserve, backpressures a stalled consumer, preserves bytes and releases on cancellation');
})().catch(error => { console.error(error); process.exitCode = 1; });
