const { createHash } = require('crypto');

// Only completed, finite HLS segments are retained. Playlists, encryption keys,
// byte-range resources and live streams always continue to the origin.
class SegmentCache {
  constructor({ maxBytes = 64 * 1024 * 1024, maxEntryBytes = 16 * 1024 * 1024, ttlMs = 120000, maxFills = 4, now = Date.now } = {}) {
    this.maxBytes = maxBytes;
    this.maxEntryBytes = Math.min(maxEntryBytes, maxBytes);
    this.ttlMs = ttlMs;
    this.maxFills = maxFills;
    this.now = now;
    this.entries = new Map();
    this.allowed = new Map();
    this.fills = new Map();
    this.bytes = 0;
    this.hits = 0;
    this.misses = 0;
    this.coalesced = 0;
  }

  key(url, referer = '') {
    return createHash('sha256').update(JSON.stringify([url, referer])).digest('hex');
  }

  registerPlaylist(content, baseUrl, referer = '') {
    const finite = /^#EXT-X-ENDLIST\s*$/m.test(content) && !/\bBYTERANGE[=:]|#EXT-X-(?:PART|PRELOAD-HINT)[:\s]/.test(content);
    let segment = false;
    const allow = uri => {
      try {
        const url = new URL(uri, baseUrl);
        if (!/^https?:$/.test(url.protocol)) return;
        const key = this.key(url.href, referer);
        if (!finite) {
          this.allowed.delete(key);
          this.remove(key);
          this.fills.get(key)?.cancel();
          return;
        }
        this.allowed.delete(key);
        this.allowed.set(key, this.now() + 4 * 60 * 60 * 1000);
        while (this.allowed.size > 4096) this.allowed.delete(this.allowed.keys().next().value);
      } catch { /* Leave malformed URIs to the player. */ }
    };
    for (const line of content.split(/\r?\n/)) {
      const value = line.trim();
      if (value.startsWith('#EXTINF:')) segment = true;
      else if (value.startsWith('#EXT-X-MAP:')) {
        const uri = value.match(/URI="([^"]+)"/);
        if (uri) allow(uri[1]);
      } else if (value && !value.startsWith('#')) {
        if (segment) allow(value);
        segment = false;
      }
    }
  }

  eligible(key) {
    const expires = this.allowed.get(key);
    if (!expires || expires <= this.now()) { this.allowed.delete(key); return false; }
    return true;
  }

  prune() {
    const now = this.now();
    for (const [key, value] of this.entries) if (value.expires <= now) this.remove(key);
  }

  remove(key) {
    const entry = this.entries.get(key);
    if (entry) { this.bytes -= entry.body.length; this.entries.delete(key); }
  }

  get(key) {
    this.prune();
    const entry = this.entries.get(key);
    if (!entry) return null;
    this.entries.delete(key);
    this.entries.set(key, entry);
    this.hits++;
    return entry;
  }

  pending(key) {
    const fill = this.fills.get(key);
    if (fill) this.coalesced++;
    return fill?.promise;
  }

  begin(key) {
    this.misses++;
    if (this.fills.size >= this.maxFills || this.fills.has(key) || this.maxEntryBytes <= 0) return null;
    let resolve;
    let chunks = [], size = 0, finished = false;
    const promise = new Promise(done => { resolve = done; });
    const finish = entry => {
      if (finished) return;
      finished = true;
      chunks = [];
      this.fills.delete(key);
      resolve(entry);
    };
    const fill = {
      promise,
      append: chunk => {
        if (finished) return;
        size += chunk.length;
        if (size > this.maxEntryBytes) finish(null);
        else chunks.push(chunk);
      },
      cancel: () => finish(null),
      commit: (headers, sourceHeaders) => {
        if (finished) return;
        const control = String(sourceHeaders['cache-control'] || '');
        const age = control.match(/(?:^|,)\s*(?:s-maxage|max-age)\s*=\s*"?(\d+)/i);
        if (!size || /(?:^|,)\s*(?:no-store|private|no-cache)\b/i.test(control) || sourceHeaders['set-cookie'] || /(?:^|,)\s*\*\s*(?:,|$)/.test(String(sourceHeaders.vary || '')) || (age && Number(age[1]) === 0)) { finish(null); return; }
        if (sourceHeaders['content-length'] && Number(sourceHeaders['content-length']) !== size) { finish(null); return; }
        this.prune();
        this.remove(key);
        while (this.bytes + size > this.maxBytes && this.entries.size) this.remove(this.entries.keys().next().value);
        const lifetime = age ? Math.min(this.ttlMs, Number(age[1]) * 1000) : this.ttlMs;
        const entry = { body: Buffer.concat(chunks, size), headers: { ...headers, 'Content-Length': size }, expires: this.now() + lifetime };
        this.entries.set(key, entry);
        this.bytes += size;
        finish(entry);
      },
    };
    this.fills.set(key, fill);
    return fill;
  }

  stats() {
    this.prune();
    return { bytes: this.bytes, maxBytes: this.maxBytes, entries: this.entries.size, filling: this.fills.size, hits: this.hits, misses: this.misses, coalesced: this.coalesced };
  }

  clear() {
    for (const fill of this.fills.values()) fill.cancel();
    this.entries.clear();
    this.allowed.clear();
    this.bytes = 0;
  }
}

module.exports = { SegmentCache };
