const http2 = require('http2');
const { setTimeout: delay } = require('timers/promises');

async function waitReady(promise, signal) {
  if (!signal) return promise;
  signal.throwIfAborted();
  let abort;
  const cancelled = new Promise((_, reject) => { abort = () => reject(signal.reason); signal.addEventListener('abort', abort, { once: true }); });
  try { return await Promise.race([promise, cancelled]); }
  finally { signal.removeEventListener('abort', abort); }
}

// Quark original files support multiplexed ranges. Keep credentials on each
// request, reuse the TLS connection, and retire it before the CDN's request cap.
class OriginalHttpPool {
  constructor({ fallback, connect = http2.connect, maxRequests = 900, idleMs = 30000, timeoutMs = 15000, connectionsPerOrigin = 1, streamsPerConnection = 96 } = {}) {
    if (typeof fallback !== 'function') throw new TypeError('An HTTP/1 fallback is required');
    this.fallback = fallback;
    this.connect = connect;
    this.maxRequests = maxRequests;
    this.idleMs = idleMs;
    this.timeoutMs = timeoutMs;
    this.connectionsPerOrigin = Math.max(1, Math.min(4, Math.floor(connectionsPerOrigin) || 1));
    this.streamsPerConnection = Math.max(1, Math.min(128, Math.floor(streamsPerConnection) || 96));
    this.origins = new Map();
    this.sessions = new Set();
    this.blocked = new Map();
    this.closed = false;
    this.h2Requests = this.fallbackRequests = this.rotations = this.retries = this.errors = 0;
  }

  retire(entry) {
    if (!entry || entry.draining) return;
    entry.draining = true;
    const entries = this.origins.get(entry.origin);
    if (entries) {
      const remaining = entries.filter(item => item !== entry);
      if (remaining.length) this.origins.set(entry.origin, remaining); else this.origins.delete(entry.origin);
    }
    if (!entry.active && !entry.session.destroyed) entry.session.close();
  }

  create(origin) {
    const session = this.connect(origin, { settings: { initialWindowSize: 1024 * 1024 } });
    const entry = { origin, session, requests: 0, active: 0, waiting: 0, draining: false };
    this.origins.set(origin, [...(this.origins.get(origin) || []), entry]);
    this.sessions.add(entry);
    entry.ready = new Promise((resolve, reject) => {
      const timer = setTimeout(() => session.destroy(Object.assign(new Error('Original transport timeout'), { code: 'ETIMEDOUT' })), this.timeoutMs);
      session.once('connect', () => { clearTimeout(timer); try { session.setLocalWindowSize(16 * 1024 * 1024); resolve(); } catch (error) { reject(error); session.destroy(); } });
      session.once('error', error => { clearTimeout(timer); reject(error); });
      session.once('close', () => { clearTimeout(timer); reject(new Error('Original transport closed before connection')); });
    });
    entry.ready.catch(() => {});
    session.on('error', () => this.retire(entry));
    session.on('goaway', () => this.retire(entry));
    session.on('close', () => { this.sessions.delete(entry); this.retire(entry); });
    session.setTimeout(this.idleMs, () => this.retire(entry));
    while (this.origins.size > 4) for (const old of this.origins.values().next().value) this.retire(old);
    return entry;
  }

  async reserve(origin, signal) {
    for (;;) {
      signal?.throwIfAborted();
      if (this.closed) throw Object.assign(new Error('Original transport closed'), { name: 'AbortError' });
      let entries = this.origins.get(origin) || [];
      for (const entry of entries) if (entry.draining || entry.session.closed || entry.session.destroyed || entry.requests >= this.maxRequests) { if (!entry.draining) this.rotations++; this.retire(entry); }
      entries = this.origins.get(origin) || [];
      // Fill one connection before opening another: spreading 96 requests
      // thinly across four connections was slower on the actual CDN.
      let entry = entries.find(item => item.active + item.waiting < this.streamsPerConnection);
      if (!entry && entries.length < this.connectionsPerOrigin) entry = this.create(origin);
      entry ||= entries.reduce((best, item) => !best || item.active + item.waiting < best.active + best.waiting ? item : best, null);
      entry.waiting++;
      try { await waitReady(entry.ready, signal); } finally { entry.waiting--; }
      signal?.throwIfAborted();
      if (entry.draining || entry.session.closed || entry.session.destroyed || entry.requests >= this.maxRequests) {
        if (!entry.draining) this.rotations++;
        this.retire(entry);
        continue;
      }
      entry.requests++;
      entry.active++;
      return entry;
    }
  }

  headers(entry, target, values, signal) {
    const headers = { ':method': 'GET', ':path': target.pathname + target.search };
    for (const [key, value] of Object.entries(values)) {
      const name = key.toLowerCase();
      if (!/^(connection|keep-alive|proxy-connection|transfer-encoding|upgrade|host|http2-settings)$/.test(name) && (name !== 'te' || value === 'trailers')) headers[name] = value;
    }
    headers[http2.sensitiveHeaders] = ['cookie', 'authorization'];
    return new Promise((resolve, reject) => {
      let stream, released = false;
      const release = () => { if (released) return; released = true; entry.active--; if (entry.draining && !entry.active && !entry.session.destroyed) entry.session.close(); };
      try { stream = entry.session.request(headers, { signal }); }
      catch (error) { release(); reject(error); return; }
      stream.once('close', release);
      stream.setTimeout(this.timeoutMs, () => stream.destroy(Object.assign(new Error('Original range timeout'), { code: 'ETIMEDOUT' })));
      stream.on('error', error => { error.originalRstCode = stream.rstCode; reject(error); });
      stream.once('response', incoming => {
        stream.statusCode = Number(incoming[':status']);
        stream.headers = Object.fromEntries(Object.entries(incoming).filter(([name]) => !name.startsWith(':')));
        resolve({ upReq: stream, upRes: stream, finalUrl: target.href });
      });
      stream.once('close', () => { if (stream.statusCode === undefined) reject(Object.assign(new Error('Original range closed before headers'), { code: 'ERR_HTTP2_INVALID_STREAM' })); });
      stream.end();
    });
  }

  async open(address, headers, redirects = 5, signal) {
    signal?.throwIfAborted();
    if (this.closed) throw Object.assign(new Error('Original transport closed'), { name: 'AbortError' });
    let target;
    try { target = new URL(address); } catch { /* The fallback validates ordinary addresses. */ }
    const eligible = target?.protocol === 'https:' && !target.port && /^dl-pc-[a-z0-9-]+\.drive\.quark\.cn$/i.test(target.hostname);
    if (eligible && (this.blocked.get(target.origin) || 0) <= Date.now()) {
      for (let attempt = 0; attempt < 2; attempt++) {
        let entry;
        try {
          entry = await this.reserve(target.origin, signal);
          const response = await this.headers(entry, target, headers, signal);
          this.h2Requests++;
          if ([301, 302, 303, 307, 308].includes(response.upRes.statusCode)) {
            // Let the existing redirect code strip cross-origin credentials.
            response.upRes.destroy(); break;
          }
          return response;
        } catch (error) {
          signal?.throwIfAborted();
          if (this.closed) throw error;
          const retryable = error.originalRstCode === http2.constants.NGHTTP2_REFUSED_STREAM || /ERR_HTTP2_(GOAWAY_SESSION|INVALID_SESSION|INVALID_STREAM)/.test(error.code || '');
          this.retire(entry);
          if (retryable && attempt === 0) { this.retries++; await delay(100, undefined, { signal }); continue; }
          this.errors++;
          this.blocked.set(target.origin, Date.now() + 60000);
          while (this.blocked.size > 8) this.blocked.delete(this.blocked.keys().next().value);
          break;
        }
      }
    }
    signal?.throwIfAborted();
    this.fallbackRequests++;
    return this.fallback(address, headers, redirects, signal);
  }

  stats() {
    return { connections: this.sessions.size, connectionsPerOrigin: this.connectionsPerOrigin, activeStreams: [...this.sessions].reduce((sum, entry) => sum + entry.active, 0), h2Requests: this.h2Requests, fallbackRequests: this.fallbackRequests, rotations: this.rotations, retries: this.retries, errors: this.errors };
  }

  close() {
    this.closed = true;
    for (const entry of this.sessions) entry.session.destroy();
    this.origins.clear(); this.sessions.clear(); this.blocked.clear();
  }
}

module.exports = { OriginalHttpPool };
