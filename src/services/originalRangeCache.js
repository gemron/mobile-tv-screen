const { createHash } = require('crypto');
const { Readable } = require('stream');
const { setTimeout: delay } = require('timers/promises');
const MIB = 1024 * 1024;
const BUFFER_PROFILES = [
  { edge: 3200, label: '4K', max: 512, minAhead: 96, maxAhead: 384, seconds: 180 },
  { edge: 2304, label: '2K', max: 256, minAhead: 64, maxAhead: 192, seconds: 150 },
  { edge: 1600, label: '1080p', max: 128, minAhead: 32, maxAhead: 96, seconds: 120 },
  { edge: 1100, label: '720p', max: 64, minAhead: 16, maxAhead: 48, seconds: 90 },
  { edge: 0, label: '标清', max: 32, minAhead: 8, maxAhead: 22.5, seconds: 60 },
];

async function abortable(promise, signal) {
  if (!signal) return promise;
  let abort;
  const cancelled = new Promise((_, reject) => {
    abort = () => reject(Object.assign(new Error('Playback request cancelled'), { name: 'AbortError' }));
    if (signal.aborted) abort(); else signal.addEventListener('abort', abort, { once: true });
  });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

// A bounded playback buffer, scoped to the signed URL and its credential context.
// Only a bounded window is prefetched, independent of the full movie size.
class OriginalRangeCache {
  constructor({ open, blockBytes = 96 * 1024, maxBytes = 32 * 1024 * 1024, concurrency = 96, ahead = 240, adaptive = false, maxRetries = 2, blockTimeoutMs = 12000, retryDelayMs = 100 } = {}) {
    this.open = open;
    this.blockBytes = blockBytes;
    this.maxBytes = maxBytes;
    this.concurrency = concurrency;
    this.ahead = Math.min(ahead, Math.max(0, Math.floor(maxBytes / blockBytes) - concurrency));
    this.base = { maxBytes, ahead: this.ahead, concurrency };
    this.adaptive = adaptive;
    this.maxRetries=maxRetries;this.blockTimeoutMs=blockTimeoutMs;this.retryDelayMs=retryDelayMs;this.rangeRetries=0;this.timeouts=0;
    this.videoInfo = null;
    this.profile = '默认';
    this.targetSeconds = 0;
    this.entries = new Map();
    this.jobs = new Map();
    this.sources = new Map();
    this.bytes = this.running = this.hits = this.misses = this.coalesced = this.downloadedBytes = this.failures = 0;
    this.receivedBytes = 0;
    this.evictions = 0;
    this.media = '';
    this.closed = false;
  }

  eligible(address, context, range) {
    if (!context || !/^bytes=\d+-\d*$/.test(range || '')) return false;
    try { const url = new URL(address); return url.protocol === 'https:' && !url.port && /^dl-pc-[a-z0-9-]+\.drive\.quark\.cn$/i.test(url.hostname); }
    catch { return false; }
  }

  setMedia(url, status) {
    const next = ['IDLE', 'STOPPED'].includes(status) ? '' : url || '';
    if (next !== this.media) { this.clear(); this.media = next; }
  }

  setPlaybackInfo({ width, height, duration } = {}, media = this.media) {
    if (!this.adaptive || !this.media || media !== this.media || !Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384) return false;
    let original = Boolean(this.window && this.eligible(this.window.url, 'original', 'bytes=0-'));
    try {
      const proxy = new URL(this.media, 'http://localhost');
      original ||= this.media.startsWith('/api/proxy?') && proxy.pathname === '/api/proxy' && this.eligible(proxy.searchParams.get('url'), proxy.searchParams.get('headerContext'), 'bytes=0-');
    } catch { /* Only the active original-file buffer is adaptive. */ }
    if (!original) return false;
    const seconds = Number.isFinite(duration) && duration > 0 && duration <= 604800 ? duration : this.videoInfo?.duration || 0;
    if (this.videoInfo?.width === width && this.videoInfo?.height === height && this.videoInfo?.duration === seconds) return false;
    this.videoInfo = { width, height, duration: seconds };
    this.updateProfile();
    return true;
  }

  updateProfile() {
    if (!this.adaptive || !this.videoInfo) return;
    const { width, height, duration } = this.videoInfo;
    const profile = BUFFER_PROFILES.find(item => Math.max(width, height) >= item.edge);
    const rate = this.window?.total && duration ? this.window.total / duration : 0;
    const wanted=rate?rate*profile.seconds*1.25:profile.minAhead*MIB;
    const tier=[...BUFFER_PROFILES].reverse().find(item=>item.max>=profile.max&&item.maxAhead*MIB>=wanted)||BUFFER_PROFILES[0];
    // Add headroom for bitrate variation, with a byte budget independent of
    // untrusted metadata and without allocating the maximum up front.
    const desired = Math.max(profile.minAhead * MIB, Math.min(tier.maxAhead * MIB, wanted));
    const maxBytes = tier.max * MIB;
    const concurrency = Math.max(this.base.concurrency, tier.max>=512 ? 384 : tier.max>=256 ? 192 : 96);
    const ahead = Math.min(Math.ceil(desired / this.blockBytes), Math.max(0, Math.floor(maxBytes / this.blockBytes) - concurrency));
    if (this.maxBytes === maxBytes && this.ahead === ahead && this.profile === profile.label) return;
    this.maxBytes = maxBytes; this.ahead = ahead; this.concurrency = concurrency; this.profile = profile.label; this.targetSeconds = profile.seconds;this.highBitrate=tier.max>profile.max;
    this.trim(this.maxBytes);
    if (this.window) this.plan(this.window);
  }

  trim(limit) {
    while(this.bytes>limit&&this.entries.size){
      const source=this.window;let victim;
      // General LRU kept recently PLAYED blocks newer than prefetched ones.
      // Once full, it evicted the NEXT unread block and downloaded it again.
      // Keep the active forward window; discard history/other windows first.
      if(source)for(const [key,entry]of this.entries){if(entry.sourceKey!==source.key||!entry.metadata&&(entry.index<source.anchor||entry.index>source.anchor+this.ahead)){victim=key;break;}}
      if(victim===undefined){let farthest=-1;for(const [key,entry]of this.entries)if(entry.index>farthest){victim=key;farthest=entry.index;}}
      victim??=this.entries.keys().next().value;this.bytes-=this.entries.get(victim).body.length;this.entries.delete(victim);this.evictions++;
    }
  }

  source(url, headers, scope) {
    const key = createHash('sha256').update(JSON.stringify([url, scope])).digest('hex');
    let source = this.sources.get(key);
    if (!source) {
      // Playback has one active read-ahead window, even with several viewers.
      for (const other of this.sources.values()) this.cancelAhead(other, -1);
      source = { key, url, headers: { ...headers }, total: 0, anchor: 0, urgentUntil: 0, failed: new Map(), consumers: new Set(), prefetchPaused: false };
      this.sources.set(key, source);
      while (this.sources.size > 8) {
        const old = this.sources.values().next().value;
        for (const consumer of [...old.consumers]) consumer.cancel();
        for (const job of [...this.jobs.values()]) if (job.source === old) this.cancel(job);
        this.sources.delete(old.key);
      }
    }
    if (this.window !== source) {
      for (const other of this.sources.values()) if (other !== source) this.cancelAhead(other, -1);
      this.window = source;
    }
    return source;
  }

  cancel(job) {
    if (job.cancelled) return;
    job.cancelled = true;
    job.controller.abort();
    if (!job.running) {
      this.jobs.delete(job.key);
      const error = Object.assign(new Error('Playback buffer cancelled'), { name: 'AbortError' });
      job.finish(error); job.reject(error);
    }
  }

  cancelAhead(source, index) {
    for (const job of [...this.jobs.values()]) {
      if (job.source === source && !job.demand && (job.received || 0) < (job.expected ?? Infinity) && (job.index < index || job.index > index + this.ahead || index < 0)) this.cancel(job);
    }
  }

  plan(source) {
    if (this.closed || this.clearing || source.prefetchPaused || this.window !== source || this.sources.get(source.key) !== source || !source.total) return;
    this.cancelAhead(source, source.anchor);
    const last = Math.min(source.anchor + this.ahead, Math.ceil(source.total / this.blockBytes) - 1);
    for (let index = source.anchor + 1; index <= last; index++) {
      const key = source.key + ':' + index;
      // Planning is frequent while a 4K window fills. Do not attach another
      // promise handler to every existing job, or refresh speculative LRU hits.
      if (this.entries.has(key) || this.jobs.has(key) && !this.jobs.get(key).cancelled) continue;
      if((source.failed.get(index)?.until||0)>Date.now())continue;
      if (this.jobs.size >= this.ahead + this.concurrency + 8) break;
      this.ensure(source, index, false, true);
    }
    this.pump();
  }

  ensure(source, index, demand, deferPump = false) {
    const key = source.key + ':' + index;
    const entry = this.entries.get(key);
    if (entry) {
      this.entries.delete(key); this.entries.set(key, entry);
      if (demand) this.hits++;
      return Promise.resolve(entry);
    }
    let job = this.jobs.get(key);
    if (job && !job.cancelled) {
      if (demand) { this.coalesced++; job.demand = true; this.pump(); }
      return job.promise;
    }
    if (this.jobs.size >= this.ahead + this.concurrency + 8) return Promise.reject(new Error('Playback buffer busy'));
    job = { key, source, index, demand, controller: new AbortController(), running: false, cancelled: false, chunks: [], waiters: new Set(), done: false };
    job.promise = new Promise((resolve, reject) => { job.resolve = resolve; job.reject = reject; });
    job.header = new Promise((resolve, reject) => { job.headerResolve = resolve; job.headerReject = reject; });
    job.wake = () => { for (const wake of job.waiters) wake(); job.waiters.clear(); };
    job.finish = error => { job.error = error; job.done = true; if (error) job.headerReject(error); job.wake(); };
    job.promise.job = job;
    // A streaming reader consumes chunks before the completed-block promise.
    job.promise.catch(() => {}); job.header.catch(() => {});
    this.jobs.set(key, job);
    this.misses++;
    if (!deferPump) this.pump();
    return job.promise;
  }

  pump() {
    if (this.closed || this.clearing) return;
    if (this.running >= this.concurrency && [...this.jobs.values()].some(job => job.demand && !job.running && !job.cancelled) && ![...this.jobs.values()].some(job => job.running && job.cancelled)) {
      // A seek must not wait behind a full window of speculative reads.
      const speculative = [...this.jobs.values()].reverse().find(job => job.running && !job.demand && !job.cancelled && (job.received || 0) < (job.expected ?? Infinity));
      if (speculative) this.cancel(speculative);
    }
    const queued = [...this.jobs.values()].filter(job => !job.running && !job.cancelled);
    const ordered = [...queued.filter(job => job.demand), ...queued.filter(job => !job.demand)];
    const runningBySource = new Map();
    for (const job of this.jobs.values()) if (job.running) runningBySource.set(job.source, (runningBySource.get(job.source) || 0) + 1);
    for (const job of ordered) {
      if (this.running >= this.concurrency) break;
      if (job.cancelled || job.running) continue;
      if (!job.demand && job.source.prefetchPaused) continue;
      if (!job.demand && job.source.anchor < job.source.urgentUntil && (runningBySource.get(job.source) || 0) >= 3) continue;
      job.running = true; job.started = Date.now(); this.running++;
      runningBySource.set(job.source, (runningBySource.get(job.source) || 0) + 1);
      this.fetch(job).then(entry => { job.finish(); job.resolve(entry); }, error => {
        if (!job.cancelled) {this.failures++;const count=(job.source.failed.get(job.index)?.count||0)+1;job.source.failed.set(job.index,{count,until:Date.now()+Math.min(30000,2000*2**Math.min(count-1,4))});while(job.source.failed.size>this.ahead+this.concurrency+8)job.source.failed.delete(job.source.failed.keys().next().value);}
        job.finish(error); job.reject(error);
      }).finally(() => {
        this.running--;
        if (this.jobs.get(job.key) === job) this.jobs.delete(job.key);
        this.pump();
      });
    }
  }

  async fetch(job) {
    const { source, index, controller } = job;
    const start = index * this.blockBytes, end = start + this.blockBytes - 1;
    let length=0,metadata;
    for(let attempt=0;;attempt++){
      controller.signal.throwIfAborted();job.attempt=attempt;
      const bounded=AbortSignal.any([controller.signal,AbortSignal.timeout(this.blockTimeoutMs)]),headers={...source.headers};let upRes;
      const abort=()=>upRes?.destroy(bounded.reason);
      for(const name of Object.keys(headers))if(/^(range|if-range)$/i.test(name))delete headers[name];
      headers.Range=`bytes=${start+length}-${end}`;
      if(length&&metadata?.etag&&!metadata.etag.startsWith('W/'))headers['If-Range']=metadata.etag;
      try {
      ({upRes}=await this.open(source.url,headers,5,bounded));
      bounded.addEventListener('abort',abort,{once:true});bounded.throwIfAborted();
      if([408,429,500,502,503,504].includes(upRes.statusCode))throw Object.assign(new Error('Temporary original-file response'),{retryable:true});
      const unsatisfied = /^bytes \*\/(\d+)$/.exec(upRes.headers['content-range'] || '');
      if (!length && upRes.statusCode === 416 && unsatisfied && Number.isSafeInteger(Number(unsatisfied[1])) && start >= Number(unsatisfied[1])) {
        source.total = Number(unsatisfied[1]);
        const entry = { body: Buffer.alloc(0), total: source.total }; job.headerResolve(entry); return entry;
      }
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(upRes.headers['content-range'] || '');
      const total = Number(match?.[3]);
      if (upRes.statusCode !== 206 || !match || !Number.isSafeInteger(total) || total <= start+length || Number(match[1]) !== start+length || Number(match[2]) !== Math.min(end, total - 1) || (source.total && source.total !== total) || metadata?.etag&&upRes.headers.etag&&metadata.etag!==upRes.headers.etag) throw Object.assign(new Error('Invalid original-file range response'),{retryable:false});
      source.total = total;
      this.updateProfile();
      metadata ||= { total, type: upRes.headers['content-type'] || 'video/mp4', etag: upRes.headers.etag, modified: upRes.headers['last-modified'] };
      job.headerResolve(metadata);
      // Overlap the following reads with this block's transfer, not its completion.
      this.plan(source);
      const expected = Math.min(this.blockBytes, total - start), chunks = job.chunks;
      job.expected = expected;
      for await (const chunk of upRes) {
        controller.signal.throwIfAborted();bounded.throwIfAborted();
        length += chunk.length;
        job.received = length;
        if (length > expected) throw Object.assign(new Error('Original-file range exceeded buffer size'),{retryable:false});
        this.receivedBytes += chunk.length;
        chunks.push(chunk);
        job.wake();
        // Content-Range already defines this block completely. A CDN may send
        // its final bytes well before closing the HTTP/2 stream; do not time
        // out and retry from end + 1 after the whole block has arrived.
        if (length === expected) break;
      }
      if (upRes.destroyed && !upRes.closed) await new Promise(resolve => upRes.once('close', resolve));
      if (length !== expected || job.cancelled || controller.signal.aborted) throw new Error('Incomplete original-file range');
      const entry = { ...metadata, sourceKey: source.key, index, metadata: Boolean(job.metadata), body: Buffer.concat(chunks, length) };
      this.downloadedBytes += length;
      source.failed.delete(index);
      const useful=job.demand||this.window===source&&index>=source.anchor&&index<=source.anchor+this.ahead;
      if (this.sources.get(source.key) === source && length <= this.maxBytes && (useful||this.bytes+length<=this.maxBytes)) {
        const previous=this.entries.get(job.key);if(previous){this.bytes-=previous.body.length;this.entries.delete(job.key);}
        this.trim(this.maxBytes-length);
        this.entries.set(job.key, entry); this.bytes += length;
      }
      return entry;
      }catch(error){
        upRes?.destroy();
        controller.signal.throwIfAborted();if(job.cancelled||this.closed)throw error;
        if(bounded.aborted)this.timeouts++;
        if(attempt>=this.maxRetries||error.retryable===false)throw error;
        this.rangeRetries++;await delay(this.retryDelayMs*(attempt+1),undefined,{signal:controller.signal});
      }finally{bounded.removeEventListener('abort',abort);upRes?.destroy();}
    }
  }

  async read(url, headers, scope, range, signal, stream = false, allowSmall = false, consumer = null) {
    if (signal?.aborted || consumer?.active === false) throw Object.assign(new Error('Playback request cancelled'), { name: 'AbortError' });
    const match = /^bytes=(\d+)-(\d*)$/.exec(range || '');
    if (!match || this.closed || this.clearing) return null;
    const start = Number(match[1]), requestedEnd = match[2] ? Number(match[2]) : Infinity;
    if (!Number.isSafeInteger(start) || (requestedEnd !== Infinity && !Number.isSafeInteger(requestedEnd)) || requestedEnd < start) return null;
    // Leave tiny sniffing requests alone rather than fetching a megabyte for two bytes.
    if (!allowSmall && !consumer?.seekRead && requestedEnd - start < 64 * 1024 - 1) return null;
    const source = this.source(url, headers, scope), index = Math.floor(start / this.blockBytes);
    // FFmpeg probes the header and tail index again before a nonzero seek.
    // These bounded reads must not replace the warm playback window or start
    // speculative downloads from byte zero. Keep small edge regions, rounded
    // to blocks, inside the same total memory budget.
    const edge = Math.min(2 * MIB, this.maxBytes / 16);
    const metadata = Boolean(consumer?.seekRead && (start < edge || source.total && start >= source.total - edge));
    if (consumer) { consumer.source = source; consumer.probing = metadata; source.consumers.add(consumer); }
    source.prefetchPaused = metadata ? ![...source.consumers].some(reader => reader.active && !reader.probing) : false;
    // After a distant seek, feed the current position before allowing a
    // large speculative window to compete for bandwidth.
    if (!metadata) {
      if (index > source.anchor + this.ahead || index < source.anchor - 1) source.urgentUntil = this.entries.has(source.key + ':' + index) ? 0 : index + 3;
      source.anchor = index; source.position = start;
      this.cancelAhead(source, index);
    } else if (source.prefetchPaused) this.cancelAhead(source, -1);
    if (source.total && start >= source.total) return { status: 416, headers: { 'Content-Range': `bytes */${source.total}` }, body: Buffer.alloc(0) };
    const pending = this.ensure(source, index, true);
    if (metadata && pending.job) pending.job.metadata = true;
    const lease = pending.job;
    let released = false;
    if (lease) lease.readers = (lease.readers || 0) + 1;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', release);
      if (lease && --lease.readers === 0) {
        lease.demand = false;
        this.cancelAhead(source, this.window === source && !source.prefetchPaused ? source.anchor : -1);
        this.pump();
      }
    };
    signal?.addEventListener('abort', release, { once: true });
    const job = stream ? pending.job : null;
    let entry;
    try { entry = await abortable(job ? job.header : pending, signal); }
    catch (error) { release(); throw error; }
    if (metadata && entry.body) entry.metadata = true;
    if (start >= entry.total) { release(); return { status: 416, headers: { 'Content-Range': `bytes */${entry.total}` }, body: Buffer.alloc(0) }; }
    this.plan(source);
    const offset = start - index * this.blockBytes, end = Math.min(requestedEnd, (index + 1) * this.blockBytes - 1, entry.total - 1);
    const body = job ? null : entry.body.subarray(offset, end - index * this.blockBytes + 1);
    const responseHeaders = { 'Content-Type': entry.type, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${entry.total}`, 'Accept-Ranges': 'bytes', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*', 'Access-Control-Expose-Headers': 'Content-Range, Content-Length, Accept-Ranges' };
    if (entry.etag) responseHeaders.ETag = entry.etag;
    if (entry.modified) responseHeaders['Last-Modified'] = entry.modified;
    const bodyStream = job ? Readable.from(this.chunks(job, offset, end - start + 1, signal), { objectMode: false, highWaterMark: 64 * 1024 }) : null;
    if (bodyStream) bodyStream.once('close', release);
    else release();
    return { status: 206, headers: responseHeaders, body, stream: bodyStream };
  }

  async response(url, headers, scope, range, signal, { seekRead = false } = {}) {
    const controller = new AbortController();
    const combined = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
    let output;
    const consumer = { active: true, source: null, seekRead, probing: false, cancel: () => { release(); output?.destroy(); } };
    const release = () => {
      if (!consumer.active) return;
      consumer.active = false;
      combined.removeEventListener('abort', release);
      const source = consumer.source;
      if (source) {
        source.consumers.delete(consumer);
        source.prefetchPaused = ![...source.consumers].some(reader => reader.active && !reader.probing);
      }
      // Abort reads awaiting headers/chunks even when the caller destroyed the
      // response without providing an external AbortSignal. Completed entries
      // stay available for a backward seek; only unused work is cancelled.
      controller.abort();
      if (source?.prefetchPaused) this.cancelAhead(source, -1);
      this.pump();
    };
    combined.addEventListener('abort', release, { once: true });
    let first;
    try { first = await this.read(url, headers, scope, range, combined, true, false, consumer); }
    catch (error) { release(); throw error; }
    if (!first || first.status !== 206) { release(); return first; }
    const requested = /^bytes=(\d+)-(\d*)$/.exec(range);
    const total = Number(first.headers['Content-Range'].split('/')[1]);
    const start = Number(requested[1]), end = requested[2] ? Math.min(Number(requested[2]), total - 1) : total - 1;
    const responseHeaders = { ...first.headers, 'Content-Length': end - start + 1, 'Content-Range': `bytes ${start}-${end}/${total}` };
    const cache = this;
    // Keep the player's logical HTTP response open while bounded origin ranges
    // arrive in parallel. Chromium no longer has to reopen the media at every
    // block boundary. Readable backpressure limits data ahead of the consumer.
    const stream = Readable.from((async function* () {
      let part = first, position = start;
      try {
        while (position <= end) {
          if (combined.aborted) throw Object.assign(new Error('Playback request cancelled'), { name: 'AbortError' });
          if (part.stream) yield* part.stream;
          else yield part.body;
          position += Number(part.headers['Content-Length']);
          if (position <= end) {
            part = await cache.read(url, headers, scope, `bytes=${position}-${end}`, combined, true, true, consumer);
            if (!part || part.status !== 206) throw new Error('Original-file stream interrupted');
          }
        }
      } finally { release(); part?.stream?.destroy(); }
    })(), { objectMode: false, highWaterMark: 64 * 1024 });
    output = stream;
    const destroy = stream._destroy;
    stream._destroy = function (error, callback) {
      // Readable.from waits for iterator cleanup. Cancel the pending upstream
      // first, otherwise a seek can wait for that same upstream to produce data.
      release();
      destroy.call(this, error, callback);
    };
    stream.once('close', () => { release(); first.stream?.destroy(); });
    return { status: 206, headers: responseHeaders, stream };
  }

  async *chunks(job, offset, length, signal) {
    let index = 0, position = 0, remaining = length;
    while (remaining > 0) {
      if (signal?.aborted) throw Object.assign(new Error('Playback request cancelled'), { name: 'AbortError' });
      while (index < job.chunks.length && remaining > 0) {
        const chunk = job.chunks[index++], from = Math.max(0, offset - position);
        position += chunk.length;
        if (from >= chunk.length) continue;
        const body = chunk.subarray(from, Math.min(chunk.length, from + remaining));
        remaining -= body.length;
        yield body;
      }
      if (!remaining) return;
      if (job.done) { if (job.error) throw job.error; throw new Error('Incomplete playback buffer'); }
      let wake;
      const changed = new Promise(resolve => { wake = resolve; job.waiters.add(wake); });
      try { await abortable(changed, signal); }
      finally { job.waiters.delete(wake); }
    }
  }

  stats() {
    let contiguousAheadBytes = 0;
    const source = this.window;
    if (source?.total) for (let index = source.anchor; index * this.blockBytes < source.total; index++) {
      const entry = this.entries.get(source.key + ':' + index);
      if (!entry) break;
      contiguousAheadBytes += Math.max(0, entry.body.length - (index === source.anchor ? (source.position || 0) % this.blockBytes : 0));
    }
    const rate = source?.total && this.videoInfo?.duration ? source.total / this.videoInfo.duration : 0;
    let forwardBytes=0,historyBytes=0;for(const entry of this.entries.values())if(entry.sourceKey===source?.key){if(entry.index>=source.anchor)forwardBytes+=entry.body.length;else historyBytes+=entry.body.length;}
    const head=source?this.jobs.get(source.key+':'+source.anchor):null;
    const failedAhead=source?[...source.failed.keys()].filter(index=>index>=source.anchor&&index<=source.anchor+this.ahead).length:0;
    return { active: Boolean(this.window || this.videoInfo), profile: this.profile, highBitrate:Boolean(this.highBitrate), targetSeconds: this.targetSeconds, bytes: this.bytes, maxBytes: this.maxBytes, blockBytes: this.blockBytes, parallelLimit: this.concurrency, aheadBytes: this.ahead * this.blockBytes, contiguousAheadBytes, forwardBytes, historyBytes, readOffset:source?.position||0, totalBytes:source?.total||0, headWaitingMs:head?.started&&!head.done?Date.now()-head.started:0, estimatedAheadSeconds: rate ? contiguousAheadBytes / rate : 0, entries: this.entries.size, filling: this.running, queued: [...this.jobs.values()].filter(job => !job.running).length, hits: this.hits, misses: this.misses, coalesced: this.coalesced, downloadedBytes: this.downloadedBytes, receivedBytes: this.receivedBytes, failures: this.failures, evictions:this.evictions, retries:this.rangeRetries, timeouts:this.timeouts, failedAhead };
  }

  clear() {
    this.clearing = true;
    // Invalidate entire response readers, including ones paused on cached data.
    // Cancelling only network jobs lets an old reader repopulate the cache after
    // Stop or a media change when it resumes its next block.
    for (const source of this.sources.values()) for (const consumer of [...source.consumers]) consumer.cancel();
    for (const job of [...this.jobs.values()]) this.cancel(job);
    this.entries.clear(); this.sources.clear(); this.window = null; this.bytes = 0;
    this.videoInfo = null; this.profile = '默认'; this.targetSeconds = 0;
    this.highBitrate=false;
    this.maxBytes = this.base.maxBytes; this.ahead = this.base.ahead; this.concurrency = this.base.concurrency;
    this.clearing = false;
  }

  close() { this.closed = true; this.clear(); }
}

module.exports = { OriginalRangeCache };
