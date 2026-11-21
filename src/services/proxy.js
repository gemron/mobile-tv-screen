const http = require('http');
const https = require('https');
const { URL } = require('url');
const { pipeline, Transform } = require('stream');
const { setTimeout: delay } = require('timers/promises');
const { spawn } = require('child_process');
const express = require('express');
const castState = require('./castState');
const { SegmentCache } = require('./segmentCache');
const { OriginalRangeCache } = require('./originalRangeCache');
const { OriginalHttpPool } = require('./originalHttpPool');
const { MediaTracks } = require('./mediaTracks');
const { RemuxBuffer } = require('./remuxBuffer');
const mediaHeaders = require('./mediaHeaders');
const { HlsAdFilter } = require('./hlsAdFilter');

// Persistent HTTP/HTTPS connection pools eliminate repeated TCP/TLS handshakes across HLS segments and Range seeks
const httpAgent = new http.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  keepAliveMsecs: 30000,
  timeout: 15000,
});

const httpsAgent = new https.Agent({
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16,
  keepAliveMsecs: 30000,
  timeout: 15000,
  rejectUnauthorized: false,
});

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36';

/**
 * Determine smart Referer and User-Agent headers for common video platforms.
 * @param {string} targetUrl
 * @param {string} [explicitReferer]
 */
function resolveUpstreamHeaders(targetUrl, explicitReferer) {
  const headers = {
    'User-Agent': DEFAULT_UA,
    Accept: '*/*',
    'Accept-Encoding': 'identity',
  };

  if (explicitReferer) {
    headers.Referer = explicitReferer;
    return headers;
  }

  try {
    const host = new URL(targetUrl).hostname.toLowerCase();
    if (host.includes('bilivideo') || host.includes('hdslb') || host.includes('bilibili')) {
      headers.Referer = 'https://www.bilibili.com/';
      headers.Origin = 'https://www.bilibili.com';
    } else if (host.includes('douyin') || host.includes('amemv') || host.includes('snssdk') || host.includes('byte')) {
      headers.Referer = 'https://www.douyin.com/';
    } else if (host.includes('iqiyi') || host.includes('qiyi') || host.includes('71.am')) {
      headers.Referer = 'https://www.iqiyi.com/';
    } else if (host.includes('qq.com') || host.includes('gtimg') || host.includes('qpic')) {
      headers.Referer = 'https://v.qq.com/';
    } else if (host.includes('youku') || host.includes('ykimg')) {
      headers.Referer = 'https://www.youku.com/';
    } else if (host.includes('mgtv') || host.includes('hunantv')) {
      headers.Referer = 'https://www.mgtv.com/';
    }
  } catch {
    // Ignore malformed URL
  }
  return headers;
}

/**
 * Make an HTTP/HTTPS request with redirect following (up to maxRedirects) and Keep-Alive pooling.
 */
async function openUpstreamStream(targetUrl, reqHeaders, maxRedirects = 5, signal, attempt = 0) {
  let opened;
  try {
    opened = await new Promise((resolve, reject) => {
      let parsed;
      try {
        parsed = new URL(targetUrl);
      } catch (err) {
        reject(new Error(`Invalid URL: ${targetUrl}`));
        return;
      }

      const isHttps = parsed.protocol === 'https:';
      if (!isHttps && parsed.protocol !== 'http:') {
        reject(new Error(`Unsupported protocol: ${parsed.protocol}`));
        return;
      }

      const lib = isHttps ? https : http;
      const options = {
        protocol: parsed.protocol,
        hostname: parsed.hostname,
        port: parsed.port || (isHttps ? 443 : 80),
        path: parsed.pathname + parsed.search,
        method: 'GET',
        agent: isHttps ? httpsAgent : httpAgent,
        headers: reqHeaders,
        timeout: 15000,
        signal,
      };

      const upReq = lib.request(options, (upRes) => {
        // A response can fail between receiving its headers and attaching a pipe.
        upRes.on('error', () => {});
        resolve({ upReq, upRes, finalUrl: targetUrl });
      });

      upReq.on('timeout', () => {
        upReq.destroy(Object.assign(new Error('Upstream timeout'), { code: 'ETIMEDOUT' }));
      });

      upReq.on('error', reject);
      upReq.end();
    });
  } catch (error) {
    if (attempt < 1 && !signal?.aborted && ['ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN'].includes(error.code)) {
      await delay(250, undefined, { signal });
      return openUpstreamStream(targetUrl, reqHeaders, maxRedirects, signal, attempt + 1);
    }
    throw error;
  }
  if ([301, 302, 303, 307, 308].includes(opened.upRes.statusCode) && opened.upRes.headers.location && maxRedirects > 0) {
    opened.upRes.resume();
    const next = new URL(opened.upRes.headers.location, targetUrl);
    const redirectHeaders = { ...reqHeaders };
    if (next.origin !== new URL(targetUrl).origin) for (const name of Object.keys(redirectHeaders)) if (/^(authorization|cookie)$/i.test(name)) delete redirectHeaders[name];
    return openUpstreamStream(next.href, redirectHeaders, maxRedirects - 1, signal, attempt);
  }
  if (attempt < 1 && !signal?.aborted && [408, 429, 500, 502, 503, 504].includes(opened.upRes.statusCode)) {
    opened.upRes.destroy();
    await delay(250, undefined, { signal });
    return openUpstreamStream(targetUrl, reqHeaders, maxRedirects, signal, attempt + 1);
  }
  return opened;
}

/**
 * Rewrite M3U8 playlist URIs (segments, variant playlists, #EXT-X-KEY, #EXT-X-MAP)
 * so all nested fetches flow seamlessly through /api/proxy.
 */
function rewriteM3u8(content, baseUrl, explicitReferer = '', headerContext = '') {
  const refParam = (explicitReferer ? `&referer=${encodeURIComponent(explicitReferer)}` : '') + (headerContext ? `&headerContext=${encodeURIComponent(headerContext)}` : '');
  const toProxyUrl = (rawUri, playlist = false) => {
    const abs = new URL(rawUri, baseUrl).toString();
    return `/api/proxy?url=${encodeURIComponent(abs)}${refParam}${playlist ? '&hls=1' : ''}`;
  };

  const lines = content.replace(/\r+/g, '').split('\n'); let variant = false;
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Rewrite URI="..." inside tags such as #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA
      if (trimmed.startsWith('#')) {
        if (trimmed.startsWith('#EXT-X-STREAM-INF:')) variant = true;
        if (trimmed.includes('URI="')) {
          return line.replace(/URI="([^"]+)"/g, (original, uri) => {
            try { return `URI="${toProxyUrl(uri, /^#EXT-X-(?:MEDIA|I-FRAME-STREAM-INF):/.test(trimmed))}"`; } catch { return original; }
          });
        }
        return line;
      }

      // Non-comment lines are media segment or variant playlist URIs
      try {
        const result = toProxyUrl(trimmed, variant); variant = false; return result;
      } catch {
        return line;
      }
    })
    .join('\n');
}

function isM3u8Response(url, contentType = '') {
  const ct = String(contentType).toLowerCase();
  if (ct.includes('mpegurl') || ct.includes('x-mpegurl')) return true;
  try {
    const pathname = new URL(url).pathname.toLowerCase();
    return pathname.endsWith('.m3u8') || pathname.endsWith('.m3u');
  } catch {
    return url.toLowerCase().includes('.m3u8');
  }
}

function boundedOriginalRange(address,context,range){
  const match=/^bytes=(\d+)-(\d*)$/.exec(range||'');
  if(!context||!match)return range;
  let url;try{url=new URL(address);}catch{return range;}
  if(url.protocol!=='https:'||url.port||!/^dl-pc-[a-z0-9-]+\.drive\.quark\.cn$/i.test(url.hostname))return range;
  const start=Number(match[1]),limit=start+1024*1024-1,end=match[2]?Math.min(Number(match[2]),limit):limit;
  if(!Number.isSafeInteger(start)||!Number.isSafeInteger(end)||end<start)return range;
  // Native video requests an open-ended range. Small, complete HTTP ranges
  // let Chromium finish metadata reads without waiting on a huge response.
  return `bytes=${start}-${end}`;
}

function createProxyRouter(options = {}) {
  const router = express.Router();
  const cache = new SegmentCache(options.cache);
  router.mediaCache = cache;
  const originalPool = options.originalCache?.open ? null : new OriginalHttpPool({ fallback: openUpstreamStream, connectionsPerOrigin: 4 });
  const originalCache = new OriginalRangeCache({ open: originalPool ? originalPool.open.bind(originalPool) : openUpstreamStream, adaptive: true, ...options.originalCache });
  if (originalPool) {
    const close = originalCache.close.bind(originalCache), stats = originalCache.stats.bind(originalCache);
    originalCache.close = () => { close(); originalPool.close(); };
    originalCache.stats = () => ({ ...stats(), transport: originalPool.stats() });
  }
  router.originalCache = originalCache;
  let tracksPort = 0;
  const tracks = router.mediaTracks = new MediaTracks({ open: openUpstreamStream, snapshot: () => castState.getSnapshot(), resolveSource: state => {
    const base='http://127.0.0.1:'+tracksPort;
    let current=new URL(state.url,base),headers={},context='';
    for(let depth=0;depth<4&&current.origin===base&&['/api/proxy','/api/transcode'].includes(current.pathname);depth++){
      const target=current.searchParams.get('url');if(!target)break;
      context=current.searchParams.get('headerContext')||'';
      const scoped=context?mediaHeaders.get(context,target):{};
      if(!scoped)throw Object.assign(new Error('媒体凭据已过期，请重新选择影片'),{status:410});
      headers={...Object.fromEntries(Object.entries(resolveUpstreamHeaders(context?'':target,current.searchParams.get('referer')||'')).map(([key,value])=>[key.toLowerCase(),value])),...scoped};current=new URL(target,base);
    }
    if(!['http:','https:'].includes(current.protocol))throw new Error('此媒体暂不支持内置轨道读取');
    const playlist=/m3u8(?:$|\?)/i.test(current.href)||/mpegurl/i.test(state.metadata?.mimeType||'');
    return {url:playlist?base+'/api/proxy?'+new URLSearchParams({url:current.href,...(context?{headerContext:context}:{}),hls:'1'}):current.href,headers,playlist};
  }});
  const trackTask = work => async(req,res)=>{
    tracksPort=req.socket.localPort;const controller=new AbortController(),abort=()=>{if(!res.writableEnded)controller.abort();};res.on('close',abort);
    try{const result=await work(req,controller.signal);if(!res.destroyed)res.json(result);}catch(error){if(!res.destroyed)res.status(error.status||(['AbortError','TimeoutError'].includes(error.name)?409:502)).json({error:error.name==='TimeoutError'?'轨道读取超时，请重试':error.message});}finally{res.off('close',abort);}
  };
  router.get('/media/tracks',trackTask(async(req,signal)=>{const result=await tracks.list(req.query.sessionId,signal);signal.throwIfAborted();castState.setMediaDuration(result);return result;}));
  router.post('/media/subtitles',express.json({limit:'4kb'}),trackTask((req,signal)=>tracks.subtitles(req.body?.sessionId,req.body?.index,req.body?.position,signal,{exact:req.body?.exact===true})));
  const remuxBuffers = new Set();
  router.remuxBufferStats = (sessionId = castState.getSnapshot().sessionId) => {
    const active = [...remuxBuffers].filter(item => item.sessionId === sessionId && !item.buffer.destroyed);
    return { active: active.length > 0, streams: active.length, bytes: active.reduce((sum, item) => sum + item.buffer.stats().bytes, 0), maxBytes: active.reduce((sum, item) => sum + item.buffer.maxBytes, 0), buffers: active.slice(-8).map(item=>({requestId:item.requestId,start:item.start,...item.buffer.stats()})) };
  };
  const adFilter = options.adFilter || new HlsAdFilter({dataDir:options.dataDir});
  router.adFilter = adFilter;
  router.get('/adfilter', (req,res) => res.json(adFilter.summary()));
  router.post('/adfilter', express.json({limit:'64kb'}), (req,res) => { try { res.json(adFilter.save(req.body||{})); } catch(error) { res.status(error.status||500).json({error:error.message}); } });

  router.options('/proxy', (req, res) => {
    res.set({
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
      'Access-Control-Allow-Headers': 'Range, Content-Type',
    });
    res.status(204).end();
  });

  router.get('/proxy', async (req, res) => {
    const targetUrl = String(req.query.url || '').trim();
    const explicitReferer = String(req.query.referer || '').trim();
    const headerContext = String(req.query.headerContext || '');
    const customHeaders = headerContext ? mediaHeaders.get(headerContext,targetUrl) : {};
    if (!customHeaders) { res.status(410).json({ error: '播放请求头已过期，请重新选择节目' }); return; }
    if (!targetUrl) {
      res.status(400).json({ error: 'Missing url parameter' });
      return;
    }

    const upstreamHeaders = { ...Object.fromEntries(Object.entries(resolveUpstreamHeaders(headerContext ? '' : targetUrl, explicitReferer)).map(([key, value]) => [key.toLowerCase(), value])), ...customHeaders };
    if (req.headers.range) {
      upstreamHeaders.Range = boundedOriginalRange(targetUrl,headerContext,req.headers.range);
    }
    if (req.headers['if-range']) {
      upstreamHeaders['If-Range'] = req.headers['if-range'];
    }

    let opened;
    let cacheFill;
    const controller = new AbortController();
    let clientClosed = req.aborted || res.destroyed;
    const cleanupUpstream = () => {
      clientClosed = true;
      controller.abort();
      cacheFill?.cancel();
      if (opened?.upRes && !opened.upRes.destroyed) opened.upRes.destroy();
      if (opened?.upReq && !opened.upReq.destroyed) opened.upReq.destroy();
    };
    // IncomingMessage 'close' can mean the GET request has completed normally.
    // Track an aborted request or a closed response, including while headers
    // from the upstream are still pending.
    req.once('aborted', cleanupUpstream);
    res.once('close', cleanupUpstream);
    if (clientClosed) return;
    const cacheScope = explicitReferer + (headerContext ? '\n' + headerContext : '');
    const cacheKey = cache.key(targetUrl, cacheScope);
    if (req.method === 'GET' && !req.headers['if-range'] && originalCache.eligible(targetUrl, headerContext, req.headers.range)) {
      try {
        const entry = await originalCache.response(targetUrl, upstreamHeaders, cacheScope, req.headers.range, controller.signal, { seekRead: req.query.seekRead === '1' });
        if (clientClosed) { entry?.stream?.destroy(); return; }
        if (entry) {
          res.status(entry.status).set(entry.headers);
          if (entry.stream) pipeline(entry.stream, res, () => {});
          else res.end(entry.body);
          return;
        }
      } catch {
        if (!clientClosed) res.status(502).json({ error: '原文件读取失败，请重试或重新选择节目' });
        return;
      }
    }
    const cacheable = req.method === 'GET' && !req.headers.range && !req.headers['if-range'] && cache.eligible(cacheKey);
    if (cacheable) {
      let entry = cache.get(cacheKey);
      let shared = false;
      if (!entry) {
        const pending = cache.pending(cacheKey);
        if (pending) {
          shared = true;
          entry = await Promise.race([pending, new Promise(resolve => controller.signal.addEventListener('abort', () => resolve(null), { once: true }))]);
        }
      }
      if (clientClosed) return;
      if (entry) {
        res.status(200).set(entry.headers).set('X-Media-Cache', shared ? 'COALESCED' : 'HIT').end(entry.body);
        return;
      }
      cacheFill = cache.begin(cacheKey);
    }
    try {
      opened = await openUpstreamStream(mediaHeaders.requestUrl(headerContext, targetUrl), upstreamHeaders, 5, controller.signal);
    } catch (err) {
      cacheFill?.cancel();
      if (!clientClosed && !res.destroyed && !res.headersSent) {
        res.status(502).json({ error: `Proxy upstream error: ${err.message}` });
      }
      return;
    }

    const { upReq, upRes, finalUrl } = opened;
    if (clientClosed || res.destroyed || res.writableEnded || upRes.destroyed) {
      cleanupUpstream();
      return;
    }

    const contentType = upRes.headers['content-type'] || 'application/octet-stream';

    // Handle HLS playlists by rewriting segment & sub-playlist URLs
    if (req.method !== 'HEAD' && (req.query.hls === '1' || isM3u8Response(finalUrl, contentType) || /[?&](?:type|format)=m3u8(?:&|$)/i.test(finalUrl)) && (upRes.statusCode || 200) < 400) {
      cacheFill?.cancel();
      const chunks = [];
      let totalSize = 0;
      const MAX_PLAYLIST_BYTES = 4 * 1024 * 1024;

      upRes.on('data', (chunk) => {
        totalSize += chunk.length;
        if (totalSize <= MAX_PLAYLIST_BYTES) {
          chunks.push(chunk);
        } else {
          if (!res.destroyed && !res.headersSent) res.status(502).end('Playlist exceeds the size limit');
          cleanupUpstream();
        }
      });

      upRes.on('end', async () => {
        if (clientClosed || res.destroyed || res.headersSent) return;
        const rawBody = Buffer.concat(chunks).toString('utf8');
        if (!/^\uFEFF?\s*#EXTM3U\b/i.test(rawBody)) {
          res.status(502).set({
            'Content-Type': 'application/json; charset=utf-8',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'no-store',
            'X-Media-Segment-Error': 'invalid-playlist',
          }).json({ error: '播放列表已失效或源站返回了错误页面，请重新选择剧集或切换线路' });
          return;
        }
        let bodyText = mediaHeaders.cleanPlaylist(headerContext, rawBody, finalUrl);
        const filtered = await adFilter.filter(bodyText, finalUrl);
        if (clientClosed || res.destroyed || res.headersSent) return;
        bodyText = filtered.content;
        cache.registerPlaylist(bodyText, finalUrl, cacheScope);
        const rewritten = rewriteM3u8(bodyText, finalUrl, explicitReferer, headerContext);
        res.status(upRes.statusCode || 200);
        res.set({
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
          'X-Ad-Filter': filtered.reason,
          'X-Ad-Filter-Segments': String(filtered.removed),
        });
        res.send(rewritten);
      });

      upRes.on('error', () => {
        if (!clientClosed && !res.destroyed && !res.headersSent) res.status(502).end();
      });
      return;
    }

    const isHlsSegment = cache.eligible(cacheKey) || (req.method === 'GET' && /\/ts\/|\.(?:ts|m4s|m2ts)(?:[?#]|$)/i.test(finalUrl));
    const rejectBadSegment = () => {
      cacheFill?.cancel();
      cacheFill = null;
      cleanupUpstream();
      if (!res.destroyed && !res.headersSent) {
        res.status(502).set({
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store',
          'X-Media-Segment-Error': 'invalid-segment',
        }).json({ error: '源站切片返回异常数据（可能残缺或已过期），建议切换其他线路' });
      }
    };
    if (isHlsSegment && (upRes.statusCode || 200) < 400 && /^(?:application\/(?:json|problem\+json|xhtml\+xml)|text\/html)\b/i.test(contentType)) {
      rejectBadSegment();
      return;
    }

    let firstChunk = null;
    if (isHlsSegment && (upRes.statusCode || 200) < 400 && /^text\/plain\b/i.test(contentType)) {
      firstChunk = await new Promise((resolve) => {
        const onData = (chunk) => { cleanup(); upRes.pause(); resolve(chunk); };
        const onEnd = () => { cleanup(); resolve(null); };
        const onErr = () => { cleanup(); resolve(null); };
        const cleanup = () => { upRes.off('data', onData); upRes.off('end', onEnd); upRes.off('error', onErr); };
        upRes.on('data', onData);
        upRes.once('end', onEnd);
        upRes.once('error', onErr);
      });
      if (clientClosed || res.destroyed || res.headersSent) { cleanupUpstream(); return; }
      if (firstChunk && /^\s*(?:<!doctype\b|<html\b|<pre\b|\{\s*"(?:code|err|error|msg|message|status)")/i.test(firstChunk.toString('utf8', 0, Math.min(firstChunk.length, 512)))) {
        rejectBadSegment();
        return;
      }
    }

    // Zero-copy streaming pipe for MP4, FLV, TS, M4S, audio & images
    const passHeaders = {
      'Content-Type': contentType,
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Expose-Headers': 'Content-Length, Content-Range, Accept-Ranges',
      'Accept-Ranges': upRes.headers['accept-ranges'] || 'bytes',
    };
    if (upRes.headers['content-length']) passHeaders['Content-Length'] = upRes.headers['content-length'];
    if (upRes.headers['content-range']) passHeaders['Content-Range'] = upRes.headers['content-range'];
    if (upRes.headers['cache-control']) passHeaders['Cache-Control'] = upRes.headers['cache-control'];
    if (upRes.headers.etag) passHeaders.ETag = upRes.headers.etag;
    if (upRes.headers['last-modified']) passHeaders['Last-Modified'] = upRes.headers['last-modified'];
    if (cacheFill && (upRes.statusCode !== 200 || upRes.headers['content-encoding'] && upRes.headers['content-encoding'] !== 'identity')) { cacheFill.cancel(); cacheFill = null; }

    try {
      passHeaders['X-Media-Cache'] = cacheFill ? 'MISS' : 'BYPASS';
      res.writeHead(upRes.statusCode || 200, passHeaders);
      if (firstChunk) {
        if (cacheFill) cacheFill.append(firstChunk);
        res.write(firstChunk);
      }
      if (cacheFill) {
        const fill = cacheFill;
        const capture = new Transform({
          transform(chunk, encoding, done) { fill.append(chunk); done(null, chunk); },
          flush(done) { if (upRes.complete) fill.commit(passHeaders, upRes.headers); else fill.cancel(); done(); },
        });
        pipeline(upRes, capture, res, err => { if (err) cleanupUpstream(); });
      } else {
        pipeline(upRes, res, err => { if (err) cleanupUpstream(); });
      }
    } catch {
      cleanupUpstream();
      if (!res.destroyed) res.destroy();
    }
  });

  // Low-latency FFmpeg stream remux / transcode endpoint for incompatible codecs (e.g. HEVC/MKV/RTSP)
  router.get('/transcode', (req, res) => {
    if (req.aborted || res.destroyed) return;
    const targetUrl = String(req.query.url || '').trim();
    const explicitReferer = String(req.query.referer || '').trim();
    const headerContext = String(req.query.headerContext || '');
    const customHeaders = headerContext ? mediaHeaders.get(headerContext,targetUrl) : {};
    if (!customHeaders) { res.status(410).end('播放请求已过期，请重新选择节目'); return; }
    const reencode = req.query.reencode === '1';
    const audioTrack = /^\d{1,2}$/.test(req.query.audioTrack||'') ? Number(req.query.audioTrack) : null;
    const burnSubtitle = /^\d{1,2}$/.test(req.query.burnSubtitle||'') ? Number(req.query.burnSubtitle) : null;
    let audioUrl = String(req.query.audioUrl || '');
    if (audioUrl) {
      try { if (!['http:', 'https:'].includes(new URL(audioUrl).protocol)) throw new Error(); }
      catch { res.status(400).end('Invalid audio URL'); return; }
    }
    const startPosition = Math.max(0, Math.min(7 * 24 * 3600, Number(req.query.start) || 0));

    if (!targetUrl) {
      res.status(400).json({ error: 'Missing url parameter' });
      return;
    }

    const headers = { ...Object.fromEntries(Object.entries(resolveUpstreamHeaders(headerContext ? '' : targetUrl, explicitReferer)).map(([key, value]) => [key.toLowerCase(), value])), ...customHeaders };
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') + '\r\n';

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-analyzeduration',
      '5000000',
      '-probesize',
      '10000000',
    ];

    if (/^https?:/i.test(targetUrl)) {
      args.push('-headers', headerLines, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2');
    }

    if (startPosition > 0) args.push('-ss', String(startPosition));
    let inputUrl = mediaHeaders.hasPlaylistContext(headerContext, targetUrl) ? `http://127.0.0.1:${req.socket.localPort}/api/proxy?url=${encodeURIComponent(targetUrl)}&headerContext=${encodeURIComponent(headerContext)}&hls=1` : targetUrl;
    if (startPosition > 0) {
      try {
        const proxy = new URL(inputUrl);
        if (proxy.origin === `http://127.0.0.1:${req.socket.localPort}` && proxy.pathname === '/api/proxy') { proxy.searchParams.set('seekRead', '1'); inputUrl = proxy.href; }
      } catch { /* Direct inputs keep their existing request behavior. */ }
    }
    args.push('-i', inputUrl);
    if (audioUrl) {
      const audioHeaders = { ...Object.fromEntries(Object.entries(resolveUpstreamHeaders(headerContext ? '' : audioUrl, explicitReferer)).map(([key,value])=>[key.toLowerCase(),value])), ...(headerContext ? mediaHeaders.get(headerContext,audioUrl) : {}) };
      args.push('-headers', Object.entries(audioHeaders).map(([key,value])=>`${key}: ${value}`).join('\r\n')+'\r\n');
      if (startPosition > 0) args.push('-ss', String(startPosition));
      args.push('-i', audioUrl, '-map', '0:v:0', '-map', '1:a:0?', '-shortest');
    }

    if(!audioUrl){
      const selectedAudio = audioTrack !== null ? '0:a:' + audioTrack + '?' : '0:a:0?';
      if(burnSubtitle!==null)args.push('-filter_complex',`[0:s:${burnSubtitle}][0:V:0]scale2ref[s][base];[base][s]overlay=eof_action=pass[v]`,'-map','[v]','-map',selectedAudio,'-sn','-dn');
      else args.push('-map','0:V:0?','-map',selectedAudio,'-sn','-dn');
    }
    if (reencode || burnSubtitle!==null) {
      args.push(
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-tune',
        'zerolatency',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '128k'
      );
    } else {
      // Video copy = zero CPU video re-encoding while remuxing to fragmented MP4
      args.push('-c:v', 'copy', '-c:a', 'aac', '-b:a', '128k');
    }
    // Browser output always has a 48 kHz stereo AAC track, including AC-3 / DTS /
    // TrueHD multi-channel or high-sample-rate Blu-ray sources.
    args.push('-ac','2','-ar','48000');

    // A copied video keeps its keyframe preroll while encoded audio is trimmed
    // to the requested seek time. Wait for initial packets before writing the
    // edit lists, so fragmented MP4 preserves their shared presentation clock.
    // Bound fragment latency even for sources with very long keyframe gaps.
    // Keep delay_moov and the original timestamps/edit lists for seek A/V sync.
    args.push('-movflags', 'frag_keyframe+empty_moov+delay_moov+default_base_moof', '-frag_duration', '1000000', '-flush_packets', '1', '-f', 'mp4', 'pipe:1');

    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    const snapshot = castState.getSnapshot(), reserve = new RemuxBuffer({ live: Boolean(snapshot.metadata?.isLive) });
    const requestId=/^[a-z0-9_-]{1,80}$/i.test(String(req.query.requestId||''))?String(req.query.requestId):'';
    const buffered = { sessionId: snapshot.sessionId, requestId, start:startPosition, buffer: reserve }; remuxBuffers.add(buffered);
    reserve.once('close', () => remuxBuffers.delete(buffered));
    let closed = false;

    const killFfmpeg = () => {
      if (closed) return;
      closed = true;
      reserve.destroy();
      try {
        ff.kill('SIGKILL');
      } catch {
        // Ignore
      }
    };

    req.on('aborted', killFfmpeg);
    res.on('close', () => { if (!res.writableFinished) killFfmpeg(); });

    res.set({
      'Content-Type': 'video/mp4',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    });

    ff.on('error', (err) => {
      castState.addLog('Transcode', `FFmpeg 启动失败: ${err.message}`);
      if (!res.headersSent) res.status(500).end();
    });

    let errBuf = '';
    ff.stderr.on('data', (d) => {
      if (errBuf.length < 1024) errBuf += d.toString();
    });

    ff.on('exit', (code) => {
      if (code && code !== 0 && !closed) {
        castState.addLog('Transcode', `FFmpeg 退出 (${code}): ${errBuf.trim()}`);
        if (!res.headersSent) res.status(502);
      }
    });

    if (req.aborted || res.destroyed) { killFfmpeg(); return; }
    try {
      pipeline(ff.stdout, reserve, res, err => { if (err) killFfmpeg(); });
    } catch {
      // A replaced media request can already be closed before pipeline attaches.
      // Synchronous setup failure must release both FFmpeg and its reserve too.
      killFfmpeg();
      if (!res.destroyed) res.destroy();
    }
  });

  return router;
}

module.exports = {
  createProxyRouter,
  rewriteM3u8,
  resolveUpstreamHeaders,
  openUpstreamStream,
  boundedOriginalRange,
};
