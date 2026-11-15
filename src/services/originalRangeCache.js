const { createHash } = require('crypto');
const { Readable } = require('stream');
const MIB = 1024 * 1024;
const BUFFER_PROFILES = [
  { edge: 3200, label: '4K', max: 256, minAhead: 64, maxAhead: 192, seconds: 180 },
  { edge: 2304, label: '2K', max: 192, minAhead: 48, maxAhead: 144, seconds: 150 },
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
  constructor({ open, blockBytes = 96 * 1024, maxBytes = 32 * 1024 * 1024, concurrency = 96, ahead = 240, adaptive = false } = {}) {
    this.open = open;
    this.blockBytes = blockBytes;
    this.maxBytes = maxBytes;
    this.concurrency = concurrency;
    this.ahead = Math.min(ahead, Math.max(0, Math.floor(maxBytes / blockBytes) - concurrency));
    this.base = { maxBytes, ahead: this.ahead };
    this.adaptive = adaptive;
    this.videoInfo = null;
    this.profile = '默认';
    this.targetSeconds = 0;
    this.entries = new Map();
    this.jobs = new Map();
    this.sources = new Map();
    this.bytes = this.running = this.hits = this.misses = this.coalesced = this.downloadedBytes = this.failures = 0;
    this.receivedBytes = 0;
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
    // Add headroom for bitrate variation, with a byte budget independent of
    // untrusted metadata and without allocating the maximum up front.
    const desired = Math.max(profile.minAhead * MIB, Math.min(profile.maxAhead * MIB, rate ? rate * profile.seconds * 1.25 : profile.minAhead * MIB));
    const maxBytes = profile.max * MIB;
    const ahead = Math.min(Math.ceil(desired / this.blockBytes), Math.max(0, Math.floor(maxBytes / this.blockBytes) - this.concurrency));
    if (this.maxBytes === maxBytes && this.ahead === ahead && this.profile === profile.label) return;
    this.maxBytes = maxBytes; this.ahead = ahead; this.profile = profile.label; this.targetSeconds = profile.seconds;
    while (this.bytes > this.maxBytes && this.entries.size) {
      const key = this.entries.keys().next().value;
      this.bytes -= this.entries.get(key).body.length; this.entries.delete(key);
    }
    if (this.window) this.plan(this.window);
  }

  source(url, headers, scope) {
    const key = createHash('sha256').update(JSON.stringify([url, scope])).digest('hex');
    let source = this.sources.get(key);
    if (!source) {
      // Playback has one active read-ahead window, even with several viewers.
      for (const other of this.sources.values()) this.cancelAhead(other, -1);
      source = { key, url, headers: { ...headers }, total: 0, anchor: 0, urgentUntil: 0 };
      this.sources.set(key, source);
      while (this.sources.size > 8) {
        const old = this.sources.values().next().value;
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
    if (this.closed || this.window !== source || this.sources.get(source.key) !== source || !source.total) return;
    this.cancelAhead(source, source.anchor);
    const last = Math.min(source.anchor + this.ahead, Math.ceil(source.total / this.blockBytes) - 1);
    for (let index = source.anchor + 1; index <= last; index++) this.ensure(source, index, false).catch(() => {});
  }

  ensure(source, index, demand) {
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
    this.pump();
    return job.promise;
  }

  pump() {
    if (this.closed) return;
    if (this.running >= this.concurrency && [...this.jobs.values()].some(job => job.demand && !job.running && !job.cancelled) && ![...this.jobs.values()].some(job => job.running && job.cancelled)) {
      // A seek must not wait behind a full window of speculative reads.
      const speculative = [...this.jobs.values()].reverse().find(job => job.running && !job.demand && !job.cancelled && (job.received || 0) < (job.expected ?? Infinity));
      if (speculative) this.cancel(speculative);
    }
    while (this.running < this.concurrency) {
      const queued = [...this.jobs.values()].filter(job => !job.running && !job.cancelled);
      const job = queued.find(job => job.demand) || queued.find(candidate => candidate.source.anchor >= candidate.source.urgentUntil || [...this.jobs.values()].filter(other => other.running && other.source === candidate.source).length < 3);
      if (!job) return;
      job.running = true; job.started = Date.now(); this.running++;
      this.fetch(job).then(entry => { job.finish(); job.resolve(entry); }, error => {
        if (!job.cancelled) this.failures++;
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
    const headers = { ...source.headers };
    for (const name of Object.keys(headers)) if (/^(range|if-range)$/i.test(name)) delete headers[name];
    headers.Range = `bytes=${start}-${end}`;
    const { upRes } = await this.open(source.url, headers, 5, controller.signal);
    try {
      const unsatisfied = /^bytes \*\/(\d+)$/.exec(upRes.headers['content-range'] || '');
      if (upRes.statusCode === 416 && unsatisfied && Number.isSafeInteger(Number(unsatisfied[1])) && start >= Number(unsatisfied[1])) {
        source.total = Number(unsatisfied[1]);
        const entry = { body: Buffer.alloc(0), total: source.total }; job.headerResolve(entry); return entry;
      }
      const match = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(upRes.headers['content-range'] || '');
      const total = Number(match?.[3]);
      if (upRes.statusCode !== 206 || !match || !Number.isSafeInteger(total) || total <= start || Number(match[1]) !== start || Number(match[2]) !== Math.min(end, total - 1) || (source.total && source.total !== total)) throw new Error('Invalid original-file range response');
      source.total = total;
      this.updateProfile();
      const metadata = { total, type: upRes.headers['content-type'] || 'video/mp4', etag: upRes.headers.etag, modified: upRes.headers['last-modified'] };
      job.headerResolve(metadata);
      // Overlap the following reads with this block's transfer, not its completion.
      this.plan(source);
      const expected = Math.min(this.blockBytes, total - start), chunks = job.chunks;
      job.expected = expected;
      let length = 0;
      for await (const chunk of upRes) {
        length += chunk.length;
        job.received = length;
        if (length > expected) throw new Error('Original-file range exceeded buffer size');
        this.receivedBytes += chunk.length;
        chunks.push(chunk);
        job.wake();
      }
      if (length !== expected || job.cancelled || controller.signal.aborted) throw new Error('Incomplete original-file range');
      const entry = { ...metadata, body: Buffer.concat(chunks, length) };
      this.downloadedBytes += length;
      if (this.sources.get(source.key) === source && length <= this.maxBytes) {
        while (this.bytes + length > this.maxBytes && this.entries.size) {
          const first = this.entries.keys().next().value;
          this.bytes -= this.entries.get(first).body.length; this.entries.delete(first);
        }
        this.entries.set(job.key, entry); this.bytes += length;
      }
      return entry;
    } finally { upRes.destroy(); }
  }

  async read(url, headers, scope, range, signal, stream = false, allowSmall = false) {
    if (signal?.aborted) throw Object.assign(new Error('Playback request cancelled'), { name: 'AbortError' });
    const match = /^bytes=(\d+)-(\d*)$/.exec(range || '');
    if (!match || this.closed) return null;
    const start = Number(match[1]), requestedEnd = match[2] ? Number(match[2]) : Infinity;
    if (!Number.isSafeInteger(start) || (requestedEnd !== Infinity && !Number.isSafeInteger(requestedEnd)) || requestedEnd < start) return null;
    // Leave tiny sniffing requests alone rather than fetching a megabyte for two bytes.
    if (!allowSmall && requestedEnd - start < 64 * 1024 - 1) return null;
    const source = this.source(url, headers, scope), index = Math.floor(start / this.blockBytes);
    // After a distant seek, feed the current position before allowing a
    // large speculative window to compete for bandwidth.
    if (index > source.anchor + this.ahead || index < source.anchor - 1) source.urgentUntil = index + 3;
    source.anchor = index;
    this.cancelAhead(source, index);
    if (source.total && start >= source.total) return { status: 416, headers: { 'Content-Range': `bytes */${source.total}` }, body: Buffer.alloc(0) };
    const pending = this.ensure(source, index, true);
    const lease = pending.job;
    let released = false;
    if (lease) lease.readers = (lease.readers || 0) + 1;
    const release = () => {
      if (released) return;
      released = true;
      signal?.removeEventListener('abort', release);
      if (lease && --lease.readers === 0) {
        lease.demand = false;
        this.cancelAhead(source, this.window === source ? source.anchor : -1);
        this.pump();
      }
    };
    signal?.addEventListener('abort', release, { once: true });
    const job = stream ? pending.job : null;
    let entry;
    try { entry = await abortable(job ? job.header : pending, signal); }
    catch (error) { release(); throw error; }
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

  async response(url, headers, scope, range, signal) {
    const first = await this.read(url, headers, scope, range, signal, true);
    if (!first || first.status !== 206) return first;
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
          if (signal?.aborted) throw Object.assign(new Error('Playback request cancelled'), { name: 'AbortError' });
          if (part.stream) yield* part.stream;
          else yield part.body;
          position += Number(part.headers['Content-Length']);
          if (position <= end) {
            part = await cache.read(url, headers, scope, `bytes=${position}-${end}`, signal, true, true);
            if (!part || part.status !== 206) throw new Error('Original-file stream interrupted');
          }
        }
      } finally { part?.stream?.destroy(); }
    })(), { objectMode: false, highWaterMark: 64 * 1024 });
    stream.once('close', () => first.stream?.destroy());
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
    return { active: Boolean(this.window || this.videoInfo), profile: this.profile, targetSeconds: this.targetSeconds, bytes: this.bytes, maxBytes: this.maxBytes, blockBytes: this.blockBytes, parallelLimit: this.concurrency, aheadBytes: this.ahead * this.blockBytes, entries: this.entries.size, filling: this.running, queued: [...this.jobs.values()].filter(job => !job.running).length, hits: this.hits, misses: this.misses, coalesced: this.coalesced, downloadedBytes: this.downloadedBytes, receivedBytes: this.receivedBytes, failures: this.failures };
  }

  clear() {
    for (const job of [...this.jobs.values()]) this.cancel(job);
    this.entries.clear(); this.sources.clear(); this.window = null; this.bytes = 0;
    this.videoInfo = null; this.profile = '默认'; this.targetSeconds = 0;
    this.maxBytes = this.base.maxBytes; this.ahead = this.base.ahead;
  }

  close() { this.closed = true; this.clear(); }
}

module.exports = { OriginalRangeCache };
