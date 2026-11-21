// Matroska text subtitles:
// 1. Indexed path: CueRelativePosition reads only the selected subtitle blocks
//    without downloading interleaved 4K video packets.
// 2. Bounded Cluster scan: when Cues only index video keyframes (the mkvmerge
//    default) or omit CueRelativePosition, jump to the Cluster covering [from]
//    and stream only up to [from + duration] (bounded by byte budget), skipping
//    video/audio payloads in place.
const zlib = require('zlib');
const { OriginalHttpPool } = require('./originalHttpPool');
const { plain } = require('./subtitleFormat');
const unsupported = () => Object.assign(new Error('此容器没有可直接读取的字幕索引'), { code: 'MKV_SUBTITLE_FALLBACK' });
const TOP_LEVEL_IDS = new Set([0x1f43b675, 0x1c53bb6b, 0x1254c367, 0x1941a469, 0x1043a770, 0x114d9b74, 0x1549a966, 0x1654ae6b]);

function vint(b, at, id = false) {
  const first = b[at];
  if (!first) throw unsupported();
  let width = 1;
  while (width <= 8 && !(first & (0x80 >> (width - 1)))) width++;
  if (width > 8 || at + width > b.length || (id && width > 4)) throw unsupported();
  let value = BigInt(id ? first : first & ((0x80 >> (width - 1)) - 1));
  for (let i = 1; i < width; i++) value = value * 256n + BigInt(b[at + i]);
  const unknown = !id && value === (1n << BigInt(7 * width)) - 1n;
  if (!unknown && value > BigInt(Number.MAX_SAFE_INTEGER)) throw unsupported();
  return { width, value: unknown ? Infinity : Number(value) };
}
function header(b, at = 0) {
  const id = vint(b, at, true), size = vint(b, at + id.width), data = at + id.width + size.width;
  return { id: id.value, data, size: size.value, end: data + size.value };
}
function children(b) {
  const values = [];
  for (let at = 0; at < b.length;) {
    const e = header(b, at);
    if (e.end > b.length || e.end <= at || values.length >= 100000) throw unsupported();
    values.push({ ...e, body: b.subarray(e.data, e.end) });
    at = e.end;
  }
  return values;
}
function uint(b) {
  if (!b?.length || b.length > 8) throw unsupported();
  let n = 0n;
  for (const v of b) n = n * 256n + BigInt(v);
  if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw unsupported();
  return Number(n);
}
function floatVal(b, fallback = 1) {
  if (!b?.length) return fallback;
  if (b.length === 4) return b.readFloatBE(0);
  if (b.length === 8) return b.readDoubleBE(0);
  throw unsupported();
}
const field = (list, id) => list.find(e => e.id === id)?.body;
const number = (list, id, fallback = 0) => { const b = field(list, id); return b ? uint(b) : fallback; };

function parseEncodings(track) {
  const encodingsEl = field(track, 0x6d80);
  if (!encodingsEl) return [];
  const list = [];
  for (const enc of children(encodingsEl).filter(e => e.id === 0x6240)) {
    const fields = children(enc.body);
    const type = number(fields, 0x5033, 0);
    if (type !== 0) throw unsupported(); // Encrypted track
    const scope = number(fields, 0x5032, 1);
    if ((scope & 1) === 0) continue; // Encoding does not apply to frame contents
    const compBody = field(fields, 0x5034);
    const comp = compBody ? children(compBody) : [];
    const algo = number(comp, 0x4254, 0); // Per Matroska spec, default ContentCompAlgo is 0 (zlib)
    if (algo !== 0 && algo !== 3) throw unsupported();
    list.push({ order: number(fields, 0x5031, 0), algo, settings: field(comp, 0x4255) || Buffer.alloc(0) });
  }
  return list.sort((a, b) => b.order - a.order);
}

function decodeSubtitleText(block, trackNumber, codec, encodings) {
  const numberId = vint(block, 0);
  if (numberId.value !== trackNumber) return null;
  if (block.length < numberId.width + 3 || (block[numberId.width + 2] & 6)) throw unsupported();
  const relTs = block.readInt16BE(numberId.width);
  let payload = block.subarray(numberId.width + 3);
  for (const enc of encodings) {
    if (enc.algo === 0) {
      try { payload = zlib.inflateSync(payload, { maxOutputLength: 256 * 1024 }); }
      catch { throw unsupported(); }
    } else if (enc.algo === 3 && enc.settings.length) {
      payload = Buffer.concat([enc.settings, payload]);
    }
  }
  let text = payload.toString('utf8');
  if (codec === 'S_TEXT/ASS' || codec === 'S_TEXT/SSA') {
    let skip = 0;
    for (let i = 0; i < 8; i++) {
      skip = text.indexOf(',', skip) + 1;
      if (!skip) return { relTs, text: '' };
    }
    text = text.slice(skip);
  }
  return { relTs, text: plain(text) };
}

class RangeReader {
  constructor(source, open, signal) {
    this.source = source;
    this.signal = signal;
    this.pool = new OriginalHttpPool({ fallback: open });
    this.cache = new Map();
    this.bytes = 0;
    this.total = Infinity;
  }
  async read(at, length) {
    this.signal.throwIfAborted();
    if (!Number.isSafeInteger(at) || at < 0 || !Number.isSafeInteger(length) || length < 1 || length > 4 * 1024 * 1024) throw unsupported();
    for (const [start, b] of this.cache) if (at >= start && at + length <= start + b.length) return b.subarray(at - start, at - start + length);
    const count = Math.min(Math.max(length, 8192), this.total - at);
    if (count <= 0) throw unsupported();
    if (this.bytes + length > 16 * 1024 * 1024) throw unsupported();
    const headers = { ...this.source.headers };
    for (const name of Object.keys(headers)) if (/^(range|if-range)$/i.test(name)) delete headers[name];
    headers.Range = `bytes=${at}-${at + count - 1}`;
    const { upRes } = await this.pool.open(this.source.url, headers, 5, this.signal);
    try {
      const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(upRes.headers['content-range'] || '');
      if (upRes.statusCode !== 206 || !range || Number(range[1]) !== at) throw unsupported();
      const total = Number(range[3]), end = Number(range[2]);
      const minEnd = Math.min(at + length, total) - 1, maxEnd = Math.min(at + count, total) - 1;
      if (!Number.isSafeInteger(total) || end < minEnd || end > maxEnd || (this.total !== Infinity && this.total !== total)) throw unsupported();
      this.total = total;
      const expected = end - at + 1;
      const parts = [];
      let received = 0;
      for await (const chunk of upRes) {
        received += chunk.length;
        if (received > expected) throw unsupported();
        parts.push(chunk);
      }
      if (received !== expected) throw unsupported();
      this.bytes += received;
      if (this.bytes > 16 * 1024 * 1024) throw unsupported();
      const b = Buffer.concat(parts, received);
      this.cache.set(at, b);
      while (this.cache.size > 96) this.cache.delete(this.cache.keys().next().value);
      return b.subarray(0, Math.min(length, b.length));
    } finally { upRes.destroy(); }
  }
  async element(at) {
    const h = header(await this.read(at, 12));
    return { ...h, offset: at, data: at + h.data, end: at + h.end };
  }
  async body(e) { return this.read(e.data, e.size); }
  close() { this.pool.close(); this.cache.clear(); }
}

class StreamCursor {
  constructor(iterable, signal) {
    this.iter = iterable[Symbol.asyncIterator]();
    this.signal = signal;
    this.chunks = [];
    this.offset = 0;
    this.buffered = 0;
    this.pos = 0;
    this.eof = false;
  }
  async ensure(n) {
    while (this.buffered < n && !this.eof) {
      this.signal.throwIfAborted();
      const { value, done } = await this.iter.next();
      if (done) { this.eof = true; break; }
      if (value?.length) { this.chunks.push(value); this.buffered += value.length; }
    }
    return this.buffered >= n;
  }
  peekBytes(n) {
    if (this.buffered < n) return null;
    const first = this.chunks[0];
    if (first.length - this.offset >= n) return first.subarray(this.offset, this.offset + n);
    const out = Buffer.allocUnsafe(n);
    let written = 0, ci = 0, off = this.offset;
    while (written < n) {
      const c = this.chunks[ci++];
      const take = Math.min(n - written, c.length - off);
      c.copy(out, written, off, off + take);
      written += take;
      off = 0;
    }
    return out;
  }
  consume(n) {
    this.pos += n;
    this.buffered -= n;
    let remaining = n;
    while (remaining > 0 && this.chunks.length) {
      const avail = this.chunks[0].length - this.offset;
      if (remaining < avail) { this.offset += remaining; remaining = 0; }
      else { remaining -= avail; this.chunks.shift(); this.offset = 0; }
    }
  }
  async read(n) {
    if (n === 0) return Buffer.alloc(0);
    if (!(await this.ensure(n))) return null;
    const buf = Buffer.from(this.peekBytes(n));
    this.consume(n);
    return buf;
  }
  async skip(n) {
    let remaining = n;
    while (remaining > 0) {
      if (this.buffered > 0) {
        const take = Math.min(remaining, this.buffered);
        this.consume(take);
        remaining -= take;
        continue;
      }
      if (this.eof) return false;
      this.signal.throwIfAborted();
      const { value, done } = await this.iter.next();
      if (done) { this.eof = true; return false; }
      if (value?.length) { this.chunks.push(value); this.buffered += value.length; }
    }
    return true;
  }
  async peekId() {
    if (!(await this.ensure(1))) return null;
    const first = this.peekBytes(1)[0];
    if (!first) return null;
    let width = 1;
    while (width <= 4 && !(first & (0x80 >> (width - 1)))) width++;
    if (width > 4 || !(await this.ensure(width))) return null;
    const b = this.peekBytes(width);
    let value = 0;
    for (let i = 0; i < width; i++) value = value * 256 + b[i];
    return { id: value, width };
  }
  async readHeader() {
    const idInfo = await this.peekId();
    if (!idInfo) return null;
    if (!(await this.ensure(idInfo.width + 1))) return null;
    const sizeFirst = this.peekBytes(idInfo.width + 1)[idInfo.width];
    if (!sizeFirst) return null;
    let sizeWidth = 1;
    while (sizeWidth <= 8 && !(sizeFirst & (0x80 >> (sizeWidth - 1)))) sizeWidth++;
    if (sizeWidth > 8 || !(await this.ensure(idInfo.width + sizeWidth))) return null;
    const raw = this.peekBytes(idInfo.width + sizeWidth);
    const size = vint(raw, idInfo.width, false);
    this.consume(idInfo.width + sizeWidth);
    return { id: idInfo.id, size: size.value, dataPos: this.pos };
  }
}

async function scanClusters(reader, { startOffset, endOffset, trackNumber, codec, encodings, scale, trackScale, defaultDuration, from, duration, maxScanBytes = 32 * 1024 * 1024 }) {
  const limitEnd = Math.min(endOffset, startOffset + maxScanBytes);
  if (limitEnd <= startOffset) return { cues: [], to: from + duration };
  const truncatedByBudget = limitEnd < endOffset;
  const headers = { ...reader.source.headers };
  for (const name of Object.keys(headers)) if (/^(range|if-range)$/i.test(name)) delete headers[name];
  headers.Range = `bytes=${startOffset}-${limitEnd - 1}`;
  const { upRes } = await reader.pool.open(reader.source.url, headers, 5, reader.signal);
  try {
    const range = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(upRes.headers['content-range'] || '');
    if (upRes.statusCode !== 206 || !range || Number(range[1]) !== startOffset) throw unsupported();
    const cursor = new StreamCursor(upRes, reader.signal);
    const result = [];
    let lastClusterTime = -1, reachedEnd = false;
    while (true) {
      const cluster = await cursor.readHeader();
      if (!cluster) break;
      if (cluster.id !== 0x1f43b675) {
        if (TOP_LEVEL_IDS.has(cluster.id)) { reachedEnd = true; break; }
        if (!Number.isFinite(cluster.size) || !(await cursor.skip(cluster.size))) break;
        continue;
      }
      const clusterEnd = Number.isFinite(cluster.size) ? cluster.dataPos + cluster.size : Infinity;
      let clusterTs = 0, hasTs = false;
      while (cursor.pos < clusterEnd) {
        const peek = await cursor.peekId();
        if (!peek) break;
        if (clusterEnd === Infinity && TOP_LEVEL_IDS.has(peek.id)) break;
        const el = await cursor.readHeader();
        if (!el) break;
        if (!Number.isFinite(el.size)) { reachedEnd = false; return null; }
        if (el.id === 0xe7 && el.size <= 8) {
          const b = await cursor.read(el.size);
          if (!b) break;
          clusterTs = uint(b);
          hasTs = true;
          const clusterSec = clusterTs * scale;
          if (clusterSec >= from + duration) { reachedEnd = true; break; }
        } else if (el.id === 0xa0 && el.size <= 131072) {
          const b = await cursor.read(el.size);
          if (!b) break;
          try {
            const group = children(b);
            const block = field(group, 0xa1);
            if (block) {
              const decoded = decodeSubtitleText(block, trackNumber, codec, encodings);
              if (decoded && decoded.text) {
                const start = (clusterTs + decoded.relTs) * scale;
                const durBody = field(group, 0x9b);
                const seconds = durBody ? uint(durBody) * scale * trackScale : defaultDuration;
                const end = start + (seconds > 0 ? seconds : 3);
                if (start >= 0 && end > from && start < from + duration && end <= 604800) {
                  result.push({ start, end, text: decoded.text });
                }
              }
            }
          } catch { /* Ignore malformed non-subtitle or unrelated blocks. */ }
        } else if (el.id === 0xa3 && el.size <= 131072) {
          const b = await cursor.read(el.size);
          if (!b) break;
          try {
            const decoded = decodeSubtitleText(b, trackNumber, codec, encodings);
            if (decoded && decoded.text) {
              const start = (clusterTs + decoded.relTs) * scale;
              const end = start + (defaultDuration > 0 ? defaultDuration : 3);
              if (start >= 0 && end > from && start < from + duration && end <= 604800) {
                result.push({ start, end, text: decoded.text });
              }
            }
          } catch { /* Ignore unrelated SimpleBlocks. */ }
        } else {
          if (!(await cursor.skip(el.size))) break;
        }
      }
      if (reachedEnd) break;
      if (hasTs) lastClusterTime = Math.max(lastClusterTime, clusterTs * scale);
    }
    const coveredTo = reachedEnd || !truncatedByBudget
      ? from + duration
      : lastClusterTime > from + 1
        ? Math.min(from + duration, lastClusterTime)
        : 0;
    if (!coveredTo) throw unsupported();
    result.sort((a, b) => a.start - b.start || a.end - b.end);
    return { cues: result, to: coveredTo };
  } finally { upRes.destroy(); }
}

async function parseMatroskaSubtitles(reader, { index, from, duration }, { allowClusterScan = false } = {}) {
  if ((await reader.read(0, 4)).readUInt32BE() !== 0x1a45dfa3) return null;
  let at = 0, segment;
  for (let i = 0; i < 8; i++) {
    const e = await reader.element(at);
    if (e.id === 0x18538067) { segment = e; break; }
    at = e.end;
  }
  if (!segment) throw unsupported();
  const locations = new Map(), visited = new Set();
  let firstCluster;
  const seekHead = async e => {
    if (visited.has(e.data)) return;
    visited.add(e.data);
    if (visited.size > 8) throw unsupported();
    for (const entry of children(await reader.body(e)).filter(x => x.id === 0x4dbb)) {
      const v = children(entry.body), id = uint(field(v, 0x53ab)), offset = segment.data + number(v, 0x53ac);
      if (!Number.isSafeInteger(offset) || offset < segment.data || offset >= Math.min(segment.end, reader.total)) continue;
      if (!locations.has(id) || id === 0x114d9b74) locations.set(id, offset);
    }
    const next = locations.get(0x114d9b74);
    if (next !== undefined) await seekHead(await reader.element(next));
  };
  at = segment.data;
  const segmentEnd = Math.min(segment.end, reader.total);
  for (let i = 0; i < 64 && at < segmentEnd; i++) {
    const e = await reader.element(at);
    if (!locations.has(e.id)) locations.set(e.id, at);
    if (e.id === 0x114d9b74) await seekHead(e);
    if (e.id === 0x1f43b675) { firstCluster = at; break; }
    if (e.end <= at) break;
    at = e.end;
  }
  if (firstCluster === undefined || !locations.has(0x1654ae6b) || !locations.has(0x1c53bb6b)) throw unsupported();
  let scale = 0.001;
  const infoAt = locations.get(0x1549a966);
  if (infoAt !== undefined) scale = number(children(await reader.body(await reader.element(infoAt))), 0x2ad7b1, 1000000) / 1e9;
  const tracks = children(await reader.body(await reader.element(locations.get(0x1654ae6b)))).filter(e => e.id === 0xae).map(e => children(e.body));
  const track = tracks[index];
  if (!track || number(track, 0x83) !== 17 || number(track, 0x56aa)) throw unsupported();
  const trackScale = floatVal(field(track, 0x23314f), 1);
  if (!(trackScale > 0 && Number.isFinite(trackScale))) throw unsupported();
  const encodings = parseEncodings(track);
  const defaultDuration = number(track, 0x23e383, 0) / 1e9;
  const codec = field(track, 0x86)?.toString('utf8'), trackNumber = number(track, 0xd7);
  if (!['S_TEXT/UTF8', 'S_TEXT/ASS', 'S_TEXT/SSA', 'S_TEXT/WEBVTT'].includes(codec)) throw unsupported();
  const cues = children(await reader.body(await reader.element(locations.get(0x1c53bb6b)))).filter(e => e.id === 0xbb);
  const positions = [], clusterIndex = [];
  let hasTrackCue = false, hasRelative = true;
  for (const cue of cues) {
    const v = children(cue.body), time = number(v, 0xb3) * scale;
    for (const point of v.filter(e => e.id === 0xb7)) {
      const p = children(point.body);
      const cueTrack = number(p, 0xf7);
      const cluster = segment.data + number(p, 0xf1);
      if (Number.isSafeInteger(cluster) && cluster >= segment.data && cluster < segmentEnd) {
        clusterIndex.push({ time, cluster });
      }
      if (cueTrack !== trackNumber) continue;
      hasTrackCue = true;
      const relative = field(p, 0xf0);
      if (!relative) { hasRelative = false; continue; }
      const cueDurBody = field(p, 0xb2);
      const cueDuration = cueDurBody ? uint(cueDurBody) * scale : 0;
      const end = time + cueDuration;
      const windowStart = cueDurBody ? from : Math.max(0, from - 15);
      if (time < from + duration && (end > windowStart || time >= windowStart)) {
        positions.push({ time, duration: cueDuration, cluster, relative: uint(relative) });
      }
    }
  }
  if (hasTrackCue && hasRelative) {
    if (positions.length > 2000) throw unsupported();
    const result = [];
    for (let start = 0; start < positions.length; start += 8) {
      await Promise.all(positions.slice(start, start + 8).map(async p => {
        const cluster = await reader.element(p.cluster);
        if (cluster.id !== 0x1f43b675) throw unsupported();
        const element = await reader.element(cluster.data + p.relative);
        if (element.end > cluster.end || element.size > 65536) throw unsupported();
        let block, seconds = p.duration;
        if (element.id === 0xa0) {
          const group = children(await reader.body(element));
          block = field(group, 0xa1);
          const durBody = field(group, 0x9b);
          seconds = durBody ? uint(durBody) * scale * trackScale : seconds || defaultDuration;
        } else if (element.id === 0xa3) {
          block = await reader.body(element);
          seconds = seconds || defaultDuration;
        } else {
          throw unsupported();
        }
        if (!block) throw unsupported();
        if (!(seconds > 0)) throw unsupported();
        const decoded = decodeSubtitleText(block, trackNumber, codec, encodings);
        if (!decoded || !decoded.text) return;
        const cueEnd = p.time + seconds;
        if (cueEnd > from && p.time < from + duration && cueEnd <= 604800) {
          result.push({ start: p.time, end: cueEnd, text: decoded.text });
        }
      }));
    }
    return { cues: result.sort((a, b) => a.start - b.start || a.end - b.end), to: from + duration };
  }
  if (!allowClusterScan || !clusterIndex.length) throw unsupported();
  // Unindexed subtitle track (e.g. default mkvmerge video-only Cues): scan only
  // the Clusters covering [from - 5, from + scanDuration], bounded by byte cap.
  clusterIndex.sort((a, b) => a.cluster - b.cluster || a.time - b.time);
  const scanDuration = Math.min(duration, 40);
  const lookback = Math.max(0, from - 5);
  let startOffset = firstCluster;
  for (const item of clusterIndex) {
    if (item.time <= lookback) startOffset = item.cluster;
    else break;
  }
  let endOffset = segmentEnd;
  for (const item of clusterIndex) {
    if (item.cluster > startOffset && item.time >= from + scanDuration + 1) {
      endOffset = item.cluster;
      break;
    }
  }
  return scanClusters(reader, {
    startOffset, endOffset, trackNumber, codec, encodings, scale, trackScale, defaultDuration, from, duration: scanDuration,
  });
}

async function indexedSubtitles(reader, window) {
  const result = await parseMatroskaSubtitles(reader, window, { allowClusterScan: false });
  return result ? result.cues : null;
}

async function readMatroskaSubtitles(source, open, signal, window) {
  const reader = new RangeReader(source, open, signal);
  try {
    return await parseMatroskaSubtitles(reader, window, { allowClusterScan: true });
  } catch (error) {
    signal.throwIfAborted();
    if (error.code === 'MKV_SUBTITLE_FALLBACK') return null;
    throw error;
  } finally {
    reader.close();
  }
}

module.exports = { readMatroskaSubtitles, indexedSubtitles, RangeReader };
