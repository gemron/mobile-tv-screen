const http = require('http');
const https = require('https');
const { URL } = require('url');
const { pipeline, Transform } = require('stream');
const { setTimeout: delay } = require('timers/promises');
const { spawn } = require('child_process');
const express = require('express');
const castState = require('./castState');
const { SegmentCache } = require('./segmentCache');

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
    return openUpstreamStream(new URL(opened.upRes.headers.location, targetUrl).href, reqHeaders, maxRedirects - 1, signal, attempt);
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
function rewriteM3u8(content, baseUrl, explicitReferer = '') {
  const refParam = explicitReferer ? `&referer=${encodeURIComponent(explicitReferer)}` : '';
  const toProxyUrl = (rawUri) => {
    const abs = new URL(rawUri, baseUrl).toString();
    return `/api/proxy?url=${encodeURIComponent(abs)}${refParam}`;
  };

  const lines = content.split(/\r?\n/);
  return lines
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      // Rewrite URI="..." inside tags such as #EXT-X-KEY, #EXT-X-MAP, #EXT-X-MEDIA
      if (trimmed.startsWith('#')) {
        if (trimmed.includes('URI="')) {
          return line.replace(/URI="([^"]+)"/g, (original, uri) => {
            try { return `URI="${toProxyUrl(uri)}"`; } catch { return original; }
          });
        }
        return line;
      }

      // Non-comment lines are media segment or variant playlist URIs
      try {
        return toProxyUrl(trimmed);
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

function createProxyRouter(options = {}) {
  const router = express.Router();
  const cache = new SegmentCache(options.cache);
  router.mediaCache = cache;

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
    if (!targetUrl) {
      res.status(400).json({ error: 'Missing url parameter' });
      return;
    }

    const upstreamHeaders = resolveUpstreamHeaders(targetUrl, explicitReferer);
    if (req.headers.range) {
      upstreamHeaders.Range = req.headers.range;
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
    const cacheKey = cache.key(targetUrl, explicitReferer);
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
      opened = await openUpstreamStream(targetUrl, upstreamHeaders, 5, controller.signal);
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
    if (req.method !== 'HEAD' && isM3u8Response(finalUrl, contentType) && (upRes.statusCode || 200) < 400) {
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

      upRes.on('end', () => {
        if (clientClosed || res.destroyed || res.headersSent) return;
        const bodyText = Buffer.concat(chunks).toString('utf8');
        cache.registerPlaylist(bodyText, finalUrl, explicitReferer);
        const rewritten = rewriteM3u8(bodyText, finalUrl, explicitReferer);
        res.status(upRes.statusCode || 200);
        res.set({
          'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-cache',
        });
        res.send(rewritten);
      });

      upRes.on('error', () => {
        if (!clientClosed && !res.destroyed && !res.headersSent) res.status(502).end();
      });
      return;
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
    const targetUrl = String(req.query.url || '').trim();
    const explicitReferer = String(req.query.referer || '').trim();
    const reencode = req.query.reencode === '1';
    const startPosition = Math.max(0, Math.min(7 * 24 * 3600, Number(req.query.start) || 0));

    if (!targetUrl) {
      res.status(400).json({ error: 'Missing url parameter' });
      return;
    }

    const headers = resolveUpstreamHeaders(targetUrl, explicitReferer);
    const headerLines = Object.entries(headers)
      .map(([k, v]) => `${k}: ${v}`)
      .join('\r\n') + '\r\n';

    const args = [
      '-hide_banner',
      '-loglevel',
      'error',
      '-analyzeduration',
      '1000000',
      '-probesize',
      '1000000',
    ];

    if (/^https?:/i.test(targetUrl)) {
      args.push('-headers', headerLines, '-reconnect', '1', '-reconnect_streamed', '1', '-reconnect_delay_max', '2');
    }

    if (startPosition > 0) args.push('-ss', String(startPosition));
    args.push('-i', targetUrl);

    if (reencode) {
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

    args.push('-movflags', 'frag_keyframe+empty_moov+default_base_moof', '-f', 'mp4', 'pipe:1');

    const ff = spawn('ffmpeg', args, { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let closed = false;

    const killFfmpeg = () => {
      if (closed) return;
      closed = true;
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

    pipeline(ff.stdout, res, err => {
      if (err) killFfmpeg();
    });
  });

  return router;
}

module.exports = {
  createProxyRouter,
  rewriteM3u8,
  resolveUpstreamHeaders,
};
