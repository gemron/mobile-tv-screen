const assert = require('assert/strict');
const { Readable, PassThrough } = require('stream');
const { setTimeout: delay } = require('timers/promises');
const { OriginalRangeCache } = require('../src/services/originalRangeCache');
const express = require('express');
const http = require('http');
const { createProxyRouter } = require('../src/services/proxy');
const mediaHeaders = require('../src/services/mediaHeaders');

const block = 128 * 1024, total = 40 * block + 37;
const data = Buffer.alloc(total);
for (let i = 0; i < data.length; i++) data[i] = i % 251;
const address = 'https://dl-pc-test.drive.quark.cn/original.mp4?signed=private';

function fixture(options = {}) {
  const requests = [], active = new Set(); let maximum = 0;
  const cache = new OriginalRangeCache({ blockBytes: block, maxBytes: 12 * block, ahead: 6, concurrency: 4, ...options, open: async (url, headers, redirects, signal) => {
    const [start, end] = headers.Range.match(/\d+/g).map(Number);
    const request = { start, end, cookie: headers.cookie, cancelled: false }; requests.push(request);
    active.add(request); maximum = Math.max(maximum, active.size);
    const body = data.subarray(start, Math.min(end + 1, total));
    const upRes = Readable.from((async function* () {
      await delay(25, undefined, { signal });
      if (options.truncated) { yield body.subarray(0, 17); return; }
      for (let at = 0; at < body.length; at += 32768) { yield body.subarray(at, at + 32768); await delay(5, undefined, { signal }); }
    })());
    upRes.statusCode = options.ignoreRange ? 200 : start >= total ? 416 : 206;
    upRes.headers = { 'content-range': start >= total ? `bytes */${total}` : `bytes ${start}-${Math.min(end, total - 1)}/${total}`, 'content-type': 'video/mp4' };
    const abort = () => { request.cancelled = true; upRes.destroy(Object.assign(new Error('aborted'), { name: 'AbortError' })); };
    signal.addEventListener('abort', abort, { once: true });
    upRes.on('error', () => {});
    upRes.on('close', () => { active.delete(request); signal.removeEventListener('abort', abort); });
    return { upRes };
  } });
  return { cache, requests, active, maximum: () => maximum };
}

async function main() {
  const { cache, requests, maximum } = fixture();
  const cancelledBeforeRead = new AbortController(); cancelledBeforeRead.abort();
  await assert.rejects(cache.response(address, {}, 'cancelled', 'bytes=0-', cancelledBeforeRead.signal), { name: 'AbortError' });
  assert.equal(requests.length, 0, 'an already aborted reader cannot change the buffer window or start downloads');
  const read = (start, end = '') => cache.read(address, { cookie: 'one' }, 'context-one', `bytes=${start}-${end}`);
  assert.equal(cache.eligible(address, 'context', 'bytes=0-'), true);
  for (const url of ['http://dl-pc-test.drive.quark.cn/a', 'https://dl-pc-test.drive.quark.cn.evil/a', 'https://dl-pc-test.drive.quark.cn:444/a']) assert.equal(cache.eligible(url, 'context', 'bytes=0-'), false);
  assert.equal(cache.eligible(address, '', 'bytes=0-'), false);
  try {
    const [first, shared] = await Promise.all([read(0), read(0)]);
    assert.deepEqual(first.body, data.subarray(0, block));
    assert.deepEqual(shared.body, first.body);
    assert.equal(first.headers['Content-Range'], `bytes 0-${block - 1}/${total}`);
    assert.equal(requests.filter(r => r.start === 0).length, 1, 'simultaneous viewers share a range transfer');
    await delay(100);
    assert.ok(maximum() > 1 && maximum() <= 4, 'read-ahead overlaps origin transfers with bounded concurrency');
    const hit = await read(block + 137, 3 * block);
    assert.deepEqual(hit.body, data.subarray(block + 137, 2 * block));
    assert.ok(cache.stats().hits > 0, 'the next range is already buffered');
    const deadline = Date.now() + 2000;
    while (cache.jobs.size && Date.now() < deadline) await delay(10);
    assert.equal(cache.jobs.size, 0, 'read-ahead reaches a finite stopping point');
    assert.ok(requests.length <= 8, 'background completion never recursively downloads the movie');
    const ensure = cache.ensure.bind(cache); let scheduled = 0;
    cache.ensure = (...args) => { scheduled++; return ensure(...args); };
    for (let repeat = 0; repeat < 100; repeat++) cache.plan(cache.window);
    assert.equal(scheduled, 0, 'completed speculative blocks do not allocate promises or change their LRU position on every planning pass');
    assert.equal(cache.stats().contiguousAheadBytes, 7 * block - 137, 'only contiguous completed bytes after the current read offset count as ready');
    cache.ensure = ensure;

    const seek = await read(30 * block + 41);
    assert.deepEqual(seek.body, data.subarray(30 * block + 41, 31 * block));
    const tail = await read(total - 19);
    assert.deepEqual(tail.body, data.subarray(total - 19));
    assert.equal(tail.headers['Content-Length'], 19);
    const eof = await read(total + block);
    assert.equal(eof.status, 416);
    assert.equal(eof.headers['Content-Range'], `bytes */${total}`);
    await cache.read(address, { cookie: 'two' }, 'context-two', 'bytes=0-');
    assert.equal(requests.filter(r => r.start === 0).length, 2, 'separate credentials cannot share a cached block');
    assert.equal(requests.at(-1).cookie, 'two');
    cache.setMedia('/api/proxy?new', 'PLAYING');
    const pending = read(10 * block);
    cache.setMedia('', 'STOPPED');
    await assert.rejects(pending);
    await delay(50);
    assert.equal(cache.stats().bytes, 0);
    assert.equal(cache.stats().filling, 0, 'stopping playback aborts background reads');
  } finally { cache.close(); }

  for (const options of [{ truncated: true }, { ignoreRange: true }]) {
    const broken = fixture({ ...options, ahead: 0 });
    try {
      await assert.rejects(broken.cache.read(address, {}, 'one', 'bytes=0-'));
      assert.equal(broken.cache.stats().bytes, 0, 'incomplete or non-range responses are never retained');
    } finally { broken.cache.close(); }
  }
  const small = fixture({ maxBytes: 3 * block, ahead: 0, concurrency: 1 });
  try {
    for (let i = 0; i < 8; i++) await small.cache.read(address, {}, 'one', `bytes=${i * block}-`);
    assert.equal(small.cache.stats().bytes, 3 * block, 'old ranges are evicted within the memory budget');
    const abort = new AbortController();
    const cancelled = small.cache.read(address, {}, 'one', 'bytes=0-', abort.signal); abort.abort();
    await assert.rejects(cancelled, { name: 'AbortError' });
  } finally { small.cache.close(); }

  const sequential=fixture({maxBytes:6*block,ahead:4,concurrency:1});
  try {
    const settle=async()=>{const end=Date.now()+3000;while(sequential.cache.jobs.size&&Date.now()<end)await delay(5);assert.equal(sequential.cache.jobs.size,0);};
    for(let index=0;index<14;index++){
      const part=await sequential.cache.read(address,{},'sequential',`bytes=${index*block}-`);assert.deepEqual(part.body,data.subarray(index*block,(index+1)*block));await settle();
      assert.ok(sequential.cache.stats().contiguousAheadBytes>=5*block,'A full sliding window keeps the current and next four blocks ready, rather than retaining played history');
    }
    for(const request of sequential.requests)assert.equal(sequential.requests.filter(other=>other.start===request.start).length,1,'Sequential playback never redownloads a block evicted by speculative LRU churn');
  }finally{sequential.cache.close();}
  for(const mode of ['truncate','timeout','temporary','etag','late-end']){
    const calls=[];let attempts=0;
    const resilient=new OriginalRangeCache({blockBytes:block,maxBytes:2*block,concurrency:1,ahead:0,blockTimeoutMs:60,retryDelayMs:0,open:async(_,headers)=>{
      const [start,end]=headers.Range.match(/\d+/g).map(Number),attempt=attempts++;calls.push({start,end,ifRange:headers['If-Range']});
      const upRes=(mode==='timeout'&&attempt===0)||mode==='late-end'?new PassThrough():Readable.from([data.subarray(start,mode==='truncate'&&attempt===0||mode==='etag'&&attempt===0?start+8192:end+1)]);
      upRes.statusCode=mode==='temporary'&&attempt===0?503:206;upRes.headers={'content-range':`bytes ${start}-${end}/${total}`,etag:mode==='etag'&&attempt>0?'"changed"':'"stable"'};upRes.on('error',()=>{});
      if(mode==='timeout'&&attempt===0){let sent=0;const timer=setInterval(()=>{if(!upRes.destroyed)upRes.write(data.subarray(sent,sent+1));sent++;},10);upRes.once('close',()=>clearInterval(timer));}
      if(mode==='late-end')upRes.write(data.subarray(start,end+1));
      return {upRes};
    }});
    try{
      const response=await resilient.read(address,{},'retry','bytes=0-',undefined,true),collect=async()=>{const chunks=[];for await(const chunk of response.stream)chunks.push(chunk);return Buffer.concat(chunks);};
      if(mode==='etag'){await assert.rejects(collect());assert.equal(resilient.stats().bytes,0,'A changed representation is never combined with prior partial bytes');assert.equal(calls.length,2);}
      else if(mode==='late-end'){assert.deepEqual(await collect(),data.subarray(0,block));const end=Date.now()+500;while(resilient.jobs.size&&Date.now()<end)await delay(5);assert.equal(resilient.stats().bytes,block,'A complete range is cached without waiting for delayed origin EOF');assert.equal(resilient.stats().retries,0);assert.equal(calls.length,1);}
      else {assert.deepEqual(await collect(),data.subarray(0,block),'A retry resumes at the exact missing byte, without duplicating or dropping streamed media');assert.equal(resilient.stats().retries,1);if(mode!=='temporary'){assert.ok(calls[1].start>0);assert.equal(calls[1].ifRange,'"stable"');}if(mode==='timeout')assert.equal(resilient.stats().timeouts,1);}
    }finally{resilient.close();}
  }
  const brokenAhead=new OriginalRangeCache({blockBytes:block,maxBytes:6*block,concurrency:1,ahead:4,retryDelayMs:0,open:async(_,headers)=>{const [start,end]=headers.Range.match(/\d+/g).map(Number),upRes=Readable.from([data.subarray(start,start>=block&&start<2*block?start+17:end+1)]);upRes.statusCode=206;upRes.headers={'content-range':`bytes ${start}-${end}/${total}`};return {upRes};}});
  try{
    await brokenAhead.read(address,{},'backoff','bytes=0-');const end=Date.now()+2000;while(brokenAhead.jobs.size&&Date.now()<end)await delay(5);assert.equal(brokenAhead.jobs.size,0);
    const before=brokenAhead.stats().retries;for(let i=0;i<100;i++)brokenAhead.plan(brokenAhead.window);await delay(20);assert.equal(brokenAhead.stats().retries,before,'Permanent speculative failures are backed off rather than re-created on every plan pass');
    assert.ok(brokenAhead.stats().failedAhead>0);assert.equal(brokenAhead.stats().failures,1);
  }finally{brokenAhead.close();}
  const flowing=fixture({maxBytes:12*block,ahead:8,concurrency:4});
  try{
    const response=await flowing.cache.response(address,{},'flowing','bytes=137-'),received=[];
    for await(const chunk of response.stream){received.push(chunk);assert.ok(flowing.cache.stats().bytes<=flowing.cache.maxBytes);await delay(3);}
    assert.deepEqual(Buffer.concat(received),data.subarray(137));const seen=new Set();for(const request of flowing.requests){assert.ok(!seen.has(request.start),'A continuous HTTP response must not redownload its next unread block under streaming backpressure');seen.add(request.start);}
  }finally{flowing.cache.close();}
  const progressive = fixture({ ahead: 0 });
  try {
    const response = await progressive.cache.read(address, {}, 'one', 'bytes=137-', undefined, true);
    assert.equal(progressive.cache.stats().bytes, 0);
    const received = [];
    for await (const chunk of response.stream) {
      received.push(chunk);
      if (received.length === 1) assert.equal(progressive.cache.stats().bytes, 0, 'playback receives partial data while the original block is still downloading');
      if (received.length === 1) assert.ok(progressive.cache.stats().receivedBytes > 0, 'network throughput includes streamed bytes before a block finishes');
    }
    assert.deepEqual(Buffer.concat(received), data.subarray(137, block));
  } finally { progressive.cache.close(); }
  const viewers = fixture({ ahead: 0 });
  try {
    const controller = new AbortController();
    const [one, two] = await Promise.all([
      viewers.cache.read(address, {}, 'one', 'bytes=0-', controller.signal, true),
      viewers.cache.read(address, {}, 'one', 'bytes=0-', undefined, true),
    ]);
    one.stream.on('error', () => {}); one.stream.resume(); controller.abort(); one.stream.destroy();
    const received = []; for await (const chunk of two.stream) received.push(chunk);
    assert.deepEqual(Buffer.concat(received), data.subarray(0, block), 'one viewer disconnecting cannot cancel another viewer sharing the read');
  } finally { viewers.cache.close(); }
  const abandoned = fixture();
  try {
    const controller = new AbortController();
    const old = await abandoned.cache.read(address, {}, 'one', 'bytes=0-', controller.signal, true);
    old.stream.on('error', () => {}); old.stream.resume(); controller.abort(); old.stream.destroy();
    await abandoned.cache.read(address, {}, 'one', `bytes=${30 * block}-`);
    assert.ok(abandoned.requests.find(request => request.start === 0).cancelled, 'a seek cancels the abandoned foreground transfer as well as its old prefetch window');
  } finally { abandoned.cache.close(); }
  const stitched = fixture({ ahead: 2 });
  try {
    const controller = new AbortController();
    const response = await stitched.cache.response(address, {}, 'one', 'bytes=0-', controller.signal);
    assert.equal(response.headers['Content-Length'], total);
    const firstBytes = new Promise((resolve, reject) => { response.stream.once('data', resolve); response.stream.once('error', reject); });
    response.stream.resume(); await firstBytes;
    controller.abort(); response.stream.destroy();
    await delay(180);
    assert.ok(stitched.requests.length < 10, 'disconnecting a continuous response stops consuming the file beyond its bounded prefetch window');
    const far = await stitched.cache.response(address, {}, 'one', `bytes=${30 * block + 91}-${31 * block + 17}`);
    const received = []; for await (const chunk of far.stream) received.push(chunk);
    assert.deepEqual(Buffer.concat(received), data.subarray(30 * block + 91, 31 * block + 18), 'a new continuous response seeks accurately after cancellation');
  } finally { stitched.cache.close(); }
  const origin = fixture();
  const router = createProxyRouter({ originalCache: { open: origin.cache.open, blockBytes: block, maxBytes: 12 * block, ahead: 2 } });
  const app = express(); app.use('/api', router);
  const server = http.createServer(app);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const context = mediaHeaders.create({ cookie: 'private-session' }, address);
    const url = `http://127.0.0.1:${server.address().port}/api/proxy?url=${encodeURIComponent(address)}&headerContext=${context}`;
    for (let i = 0; i < 2; i++) {
      const response = await fetch(url, { headers: { range: 'bytes=137-400000' } });
      assert.equal(response.status, 206);
      assert.equal(response.headers.get('content-range'), `bytes 137-400000/${total}`);
      assert.equal(response.headers.get('content-length'), String(400000 - 137 + 1));
      assert.deepEqual(Buffer.from(await response.arrayBuffer()), data.subarray(137, 400001));
    }
    assert.equal(origin.requests.filter(request => request.start === 0).length, 1);
    assert.equal(origin.requests[0].cookie, 'private-session');
    assert.ok(router.originalCache.stats().hits + router.originalCache.stats().coalesced > 0);
    const tail = await fetch(url, { headers: { range: `bytes=${total - block - 17}-` } });
    assert.equal(tail.headers.get('content-range'), `bytes ${total - block - 17}-${total - 1}/${total}`);
    assert.deepEqual(Buffer.from(await tail.arrayBuffer()), data.subarray(total - block - 17), 'one HTTP response stitches bounded ranges through a tiny final block');
  } finally {
    router.originalCache.close(); origin.cache.close(); router.mediaCache.clear(); await router.adFilter.close();
    server.closeAllConnections(); await new Promise(resolve => server.close(resolve));
  }
  console.log('PASS: original-file read-ahead, shared reads, exact seeks, EOF, credential isolation, bounded memory and cancellation');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
