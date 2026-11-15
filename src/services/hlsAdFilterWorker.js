// Isolated rule matching: subscription regular expressions never run on the
// HTTP event loop. This file also implements the playlist-only transformation.
const { parentPort, workerData } = require('worker_threads');
function hostMatches(host, rule) {
  return host === rule || host.endsWith('.' + rule);
}
function filterPlaylist(content, address, options) {
  const unchanged = reason => ({ content, removed: 0, seconds: 0, reason });
  if (!/^\s*#EXTM3U/.test(content)) return unchanged('not-hls');
  if (!/#EXT-X-ENDLIST(?:\s|$)/.test(content)) return unchanged('live');
  if (/#EXT-X-(?:STREAM-INF|PART:|BYTERANGE:|SKIP:|I-FRAMES-ONLY)/.test(content)) return unchanged('complex-playlist');
  const lines = content.replace(/\r+/g, '').split('\n');
  const segments = [], header = [], pending = []; let key = '', map = '', sequence = 0n, discontinuity = false, cue = false, cueStart = -1;
  const cueGroups = []; let duration = 0, offset = 0;
  for (const line of lines) {
    const value = line.trim(), start = offset; offset += line.length + 1;
    if (!value) continue;
    if (value.startsWith('#EXT-X-MEDIA-SEQUENCE:')) { try { sequence = BigInt(value.split(':')[1]); } catch { return unchanged('invalid-sequence'); } header.push(line); continue; }
    if (value.startsWith('#EXT-X-KEY:')) { key = line; continue; }
    if (value.startsWith('#EXT-X-MAP:')) { map = line; continue; }
    if (value === '#EXT-X-DISCONTINUITY') { discontinuity = true; continue; }
    if (/^#EXT-X-CUE-OUT(?::|$)/.test(value)) { cue = true; cueStart = segments.length; continue; }
    if (value.startsWith('#EXT-X-CUE-IN')) { if (cue && cueStart >= 0) cueGroups.push([cueStart, segments.length]); cue = false; cueStart = -1; continue; }
    if (/^#EXT-X-CUE-OUT-CONT/.test(value)) continue;
    if (value.startsWith('#EXTINF:')) { duration = Number(value.slice(8).split(',')[0]); if (!Number.isFinite(duration) || duration <= 0) return unchanged('invalid-duration'); pending.push(line); continue; }
    if (value === '#EXT-X-ENDLIST') continue;
    if (value.startsWith('#')) {
      if (/^#(?:EXTM3U|EXT-X-(?:VERSION|TARGETDURATION|PLAYLIST-TYPE|DISCONTINUITY-SEQUENCE|INDEPENDENT-SEGMENTS|START))/.test(value)) header.push(line);
      else pending.push(line);
      continue;
    }
    if (!duration) return unchanged('invalid-segment');
    let url; try { url = new URL(value, address); if (!['http:', 'https:'].includes(url.protocol)) return unchanged('unsupported-uri'); } catch { return unchanged('invalid-uri'); }
    segments.push({ uri: line, url, tags: pending.splice(0), duration, key, map, discontinuity, sequence: sequence + BigInt(segments.length), end: offset });
    duration = 0; discontinuity = false;
    if (segments.length > 20000) return unchanged('too-many-segments');
  }
  if (!segments.length) return unchanged('empty');
  const remove = new Set();
  for (const [first, last] of cueGroups) for (let i = first; i < last; i++) remove.add(i);
  segments.forEach((segment, i) => { if (options.domains.some(rule => hostMatches(segment.url.hostname.toLowerCase(), rule))) remove.add(i); });
  const normalized = lines.join('\n'), host = new URL(address).hostname.toLowerCase();
  // Media block rules are different from WebView/sniffer rules. Only patterns
  // explicitly describing EXTINF blocks are eligible to remove segments.
  for (const rule of options.rules) {
    if (!rule.hosts.some(h => hostMatches(host, h) || host.includes(h))) continue;
    for (const expression of rule.regex) {
      if (!expression.includes('#EXTINF')) continue;
      let pattern; try { pattern = new RegExp(expression, 'g'); } catch { continue; }
      for (const match of normalized.matchAll(pattern)) {
        if (!match[0]) continue;
        const end = match.index + match[0].length;
        for (let i = 0; i < segments.length; i++) {
          const segment = segments[i];
          // Match the complete URI line, never just a duration or a substring.
          const uriStart = segment.end - segment.uri.length - 1;
          if (match.index <= uriStart && end >= uriStart + segment.uri.length) remove.add(i);
        }
      }
    }
  }
  if (!remove.size) return unchanged('no-match');
  const seconds = [...remove].reduce((sum, i) => sum + segments[i].duration, 0), total = segments.reduce((sum, s) => sum + s.duration, 0);
  if (remove.size === segments.length || seconds > 180 || seconds > total * 0.4) return unchanged('guarded');
  const output = [...header]; let lastKey = '', lastMap = '', gap = false, written = 0;
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    if (remove.has(i)) { gap = true; continue; }
    if ((gap && written > 0) || segment.discontinuity) output.push('#EXT-X-DISCONTINUITY');
    let segmentKey = segment.key;
    if (/METHOD=AES-128(?:,|$)/.test(segmentKey) && !/(?:^|,)IV=/.test(segmentKey)) segmentKey += ',IV=0x' + segment.sequence.toString(16).padStart(32, '0');
    if (segmentKey !== lastKey) { if (segmentKey) output.push(segmentKey); lastKey = segmentKey; }
    if (segment.map !== lastMap) { if (segment.map) output.push(segment.map); lastMap = segment.map; }
    output.push(...segment.tags.filter(tag => !/^#EXT-X-DATERANGE:.*(?:SCTE35|CLASS="[^"]*(?:ad|interstitial))/i.test(tag)), segment.uri);
    written++; gap = false;
  }
  output.push('#EXT-X-ENDLIST', '');
  return { content: output.join('\n'), removed: remove.size, seconds, reason: 'filtered' };
}
if (parentPort) { try { parentPort.postMessage(filterPlaylist(workerData.content, workerData.address, workerData.options)); } catch { parentPort.postMessage({ content: workerData.content, removed: 0, seconds: 0, reason: 'invalid' }); } }
module.exports = { filterPlaylist, hostMatches };
