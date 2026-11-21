const http = require('http');
const { spawn } = require('child_process');
const { pipeline, Transform } = require('stream');
const { randomBytes } = require('crypto');
const { OriginalRangeCache } = require('./originalRangeCache');
const { OriginalHttpPool } = require('./originalHttpPool');
const { parseSubtitle } = require('./subtitleFormat');
const { readMatroskaSubtitles } = require('./matroskaSubtitles');
const textCodecs = new Set(['subrip', 'srt', 'ass', 'ssa', 'mov_text', 'webvtt', 'text', 'hdmv_text_subtitle']);
const imageCodecs = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub']);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

function isQuarkOriginal(address) {
  try {
    const url = new URL(address);
    return url.protocol === 'https:' && !url.port && /^dl-pc-[a-z0-9-]+\.drive\.quark\.cn$/i.test(url.hostname);
  } catch {
    return false;
  }
}

function childOutput(executable, args, { signal, maxBytes = 128 * 1024 } = {}) {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const child = spawn(executable, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let chunks = [], length = 0, errors = '', done = false;
    const finish = (error, value) => { if (done) return; done = true; signal?.removeEventListener('abort', abort); error ? reject(error) : resolve(value); };
    const abort = () => { child.kill(); finish(signal.reason || new DOMException('Cancelled', 'AbortError')); };
    signal?.addEventListener('abort', abort, { once: true });
    child.on('error', error => finish(error.code === 'ENOENT' ? failure('缺少媒体轨道工具，请更新完整程序目录', 503) : error));
    child.stdout.on('data', chunk => { length += chunk.length; if (length > maxBytes) { child.kill(); finish(failure('媒体轨道数据超过读取上限', 413)); } else chunks.push(chunk); });
    child.stderr.on('data', chunk => { if (errors.length < 2048) errors += chunk; });
    child.on('close', code => { if (code === 0) finish(null, Buffer.concat(chunks)); else finish(failure('未能读取媒体轨道，请重试或使用兼容播放', 502)); });
  });
}

class MediaTracks {
  constructor({ resolveSource, open, snapshot }) { this.resolveSource = resolveSource; this.open = open; this.snapshot = snapshot; this.cache = new Map(); this.controllers = new Set(); }
  current(sessionId) { const state = this.snapshot(); if (!state.url || ['IDLE', 'STOPPED'].includes(state.status) || Number(sessionId) !== state.sessionId) throw failure('播放已切换，请重新读取音轨和字幕', 409); return state; }
  async input(state, signal, work, { budget = 96 * 1024 * 1024, probe = false } = {}) {
    const source = this.resolveSource(state);
    // HLS already has a credential-scoped local proxy and segment cache.
    if (source.playlist) return work(source.url);
    const quark = isQuarkOriginal(source.url);
    const pool = new OriginalHttpPool({ fallback: this.open });
    let directBytes = 0;
    const cache = new OriginalRangeCache({
      open: async (...args) => { if (cache.receivedBytes + directBytes > budget) throw failure('轨道读取超过本次流量上限', 413); return pool.open(...args); },
      maxBytes: 16 * 1024 * 1024,
      concurrency: probe ? (quark ? 8 : 4) : (quark ? 64 : 16),
      ahead: probe ? (quark ? 4 : 2) : (quark ? 48 : 16),
    });
    let rangeSupported = true;
    const token = '/' + randomBytes(16).toString('hex');
    const server = http.createServer(async (req, res) => {
      if (req.url !== token) { res.writeHead(404).end(); return; }
      const stop = new AbortController(), abort = () => stop.abort(); res.once('close', abort);
      const combined = AbortSignal.any([signal, stop.signal]);
      if (rangeSupported) {
        try {
          const range = req.headers.range || 'bytes=0-';
          const result = await cache.response(source.url, source.headers, 'tracks', range, combined, { seekRead: true });
          if (result) {
            if (res.destroyed) { result.stream?.destroy(); return; }
            res.writeHead(result.status, result.headers);
            if (result.stream) pipeline(result.stream, res, () => {});
            else res.end(result.body);
            return;
          }
        } catch (error) {
          if (combined.aborted || error.status === 413) { res.destroy(); return; }
          // Upstream may not support 206 Range requests; fall back to direct streaming.
          rangeSupported = false;
        }
      }
      try {
        const headers = { ...source.headers };
        for (const name of Object.keys(headers)) if (/^(range|if-range)$/i.test(name)) delete headers[name];
        if (req.headers.range) headers.Range = req.headers.range;
        const { upRes } = await this.open(source.url, headers, 5, combined);
        if (res.destroyed) { upRes.destroy(); return; }
        const pass = { 'Content-Type': upRes.headers['content-type'] || 'application/octet-stream' };
        if (upRes.headers['content-length']) pass['Content-Length'] = upRes.headers['content-length'];
        if (upRes.headers['content-range']) pass['Content-Range'] = upRes.headers['content-range'];
        if (upRes.headers['accept-ranges']) pass['Accept-Ranges'] = upRes.headers['accept-ranges'];
        res.writeHead(upRes.statusCode || 200, pass);
        const meter = new Transform({
          transform(chunk, _enc, done) {
            directBytes += chunk.length;
            if (cache.receivedBytes + directBytes > budget) done(failure('轨道读取超过本次流量上限', 413));
            else done(null, chunk);
          },
        });
        pipeline(upRes, meter, res, () => { upRes.destroy(); });
      } catch { res.destroy(); }
    });
    const stop = () => { cache.close(); pool.close(); server.closeAllConnections(); };
    signal.addEventListener('abort', stop, { once: true });
    try { await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); }); return await work('http://127.0.0.1:' + server.address().port + token); }
    finally { signal.removeEventListener('abort', stop); stop(); await new Promise(resolve => server.close(resolve)); }
  }
  async operation(sessionId, signal, work) {
    if (this.controllers.size >= 3) throw failure('正在读取其他轨道，请稍后重试', 429);
    const state = this.current(sessionId), controller = new AbortController(); this.controllers.add(controller);
    const bounded = AbortSignal.any([controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(45000)]);
    try { const result = await work(state, bounded); this.current(sessionId); return result; }
    finally { this.controllers.delete(controller); }
  }
  async list(sessionId, signal) {
    const state = this.current(sessionId), key = state.sessionId + ':' + state.url;
    if (this.cache.has(key)) return this.cache.get(key);
    return this.operation(sessionId, signal, async (state, bounded) => {
      const bytes = await this.input(state, bounded, input => childOutput('ffprobe', ['-v', 'error', '-nofind_stream_info', '-rw_timeout', '10000000', '-show_entries', 'format=duration:stream=index,codec_type,codec_name,channels,width,height,duration:stream_tags=language,title,handler_name:stream_disposition=default,forced', '-of', 'json', input], { signal: bounded, maxBytes: 1024 * 1024 }), { probe: true });
      let data; try { data = JSON.parse(bytes); } catch { throw failure('媒体轨道数据无效', 502); }
      const streams = (data.streams || []).filter(s => ['video', 'audio', 'subtitle'].includes(s.codec_type)).slice(0, 64);
      const track = s => ({ index: Number(s.index), codec: String(s.codec_name || ''), language: String(s.tags?.language || 'und').slice(0, 30), title: String(s.tags?.title || '').slice(0, 200), channels: Number(s.channels) || 0, default: Boolean(s.disposition?.default), forced: Boolean(s.disposition?.forced) });
      // MP4 exposes track durations before expensive packet analysis; MKV uses
      // the container duration. Neither requires decoding the movie to find EOF.
      const duration = Number(data.format?.duration) || Math.max(0, ...streams.filter(s => ['video', 'audio'].includes(s.codec_type)).map(s => Number(s.duration) || 0));
      const result = { sessionId: state.sessionId, duration: Number.isFinite(duration) && duration > 0 && duration <= 604800 ? duration : 0, audio: streams.filter(s => s.codec_type === 'audio').map(track), subtitles: streams.filter(s => s.codec_type === 'subtitle').map(s => ({ ...track(s), kind: textCodecs.has(s.codec_name) ? 'text' : imageCodecs.has(s.codec_name) ? 'image' : 'unsupported' })) };
      this.cache.set(key, result); while (this.cache.size > 8) this.cache.delete(this.cache.keys().next().value); return result;
    });
  }
  async subtitles(sessionId, index, position, signal, { exact = false } = {}) {
    const tracks = await this.list(sessionId, signal), selected = tracks.subtitles.find(t => t.index === Number(index));
    if (!selected) throw failure('内置字幕轨道不存在');
    if (selected.kind !== 'text') throw failure('此轨道是图像字幕，需要启用图像字幕兼容播放', 422);
    const clamped = Math.max(0, Math.min(604800, Number(position) || 0));
    const from = Math.max(0, exact ? Math.floor(clamped) : Math.floor(clamped / 20) * 20);
    return this.operation(sessionId, signal, async (state, bounded) => {
      const source = this.resolveSource(state), indexed = source.playlist ? null : await readMatroskaSubtitles(source, this.open, bounded, { index: selected.index, from, duration: 180 });
      if (indexed !== null) return { sessionId: state.sessionId, name: selected.title || selected.language + ' · 内置字幕', cues: indexed.cues, from, to: indexed.to };
      // Unindexed containers still work, but only demux a short window. Reading
      // three minutes of interleaved high-bitrate video exhausted the old budget.
      const duration = 40;
      const output = await this.input(state, bounded, input => childOutput('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-rw_timeout', '10000000', '-copyts', ...(from > 0 ? ['-ss', String(from)] : []), '-t', String(duration), '-i', input, '-map', '0:' + selected.index, '-c:s', 'webvtt', '-to', String(from + duration), '-f', 'webvtt', 'pipe:1'], { signal: bounded, maxBytes: 4 * 1024 * 1024 }));
      const raw = output.toString('utf8');
      let cues = [];
      if (raw.trim() !== 'WEBVTT') {
        try { cues = parseSubtitle(output, 'embedded.vtt'); }
        catch (error) { if (!/^WEBVTT\b/.test(raw.trimStart())) throw error; }
      }
      return { sessionId: state.sessionId, name: selected.title || selected.language + ' · 内置字幕', cues, from, to: from + duration };
    });
  }
  reset() { for (const controller of this.controllers) controller.abort(); }
  setState(state) { if (this.sessionId !== state.sessionId) { this.reset(); this.sessionId = state.sessionId; } }
  close() { this.reset(); this.cache.clear(); }
}
module.exports = { MediaTracks, childOutput };
