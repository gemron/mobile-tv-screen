const http = require('http');
const express = require('express');
const castState = require('../services/castState');

// FongMi/TV 5.6.3: ScanTask GET /device, CastDialog POST /action?do=cast,
// and Media GET /media. This bridges the sender's resolved stream; it does not
// execute Android source configurations or spider JARs on the receiver.
function objectParam(value, name) {
  if (value == null || value === '') return {};
  try {
    const parsed = typeof value === 'string' ? JSON.parse(value) : value;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed;
  } catch {}
  throw Object.assign(new Error(`${name} 必须是 JSON 对象`), { status: 400 });
}

function normalizeIp(ip) {
  return String(ip || '').replace(/^\[|\]$/g, '').replace(/^::ffff:/, '').toLowerCase();
}

function httpUrl(value, senderIp = '') {
  try {
    const url = new URL(String(value || '').trim());
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) return '';
    if (senderIp && ['127.0.0.1', 'localhost', '0.0.0.0', '::1'].includes(normalizeIp(url.hostname))) {
      url.hostname = senderIp.includes(':') ? `[${senderIp}]` : senderIp;
    }
    return url.href;
  } catch {
    return '';
  }
}

function millisecondsToSeconds(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number / 1000 : 0;
}

class TvBoxService {
  constructor({ port = 9978, getIdentity, getPreferredIp, senderTimeout = 2500, diagnostics = process.env.CAST_DIAGNOSTICS === '1' }) {
    this.port = port;
    this.getIdentity = getIdentity;
    this.getPreferredIp = getPreferredIp;
    this.senderTimeout = senderTimeout;
    this.diagnostics = diagnostics;
    this.probeTimes = new Map();
    this.server = null;
    this.requestId = 0;
    this.onStateChange = (snapshot) => {
      if (snapshot.status === 'IDLE' || snapshot.status === 'STOPPED') this.requestId += 1;
    };
  }

  logProbe(key, message, detail) {
    const now = Date.now();
    if (now - (this.probeTimes.get(key) || 0) < 10000) return;
    if (this.probeTimes.size >= 128) this.probeTimes.clear();
    this.probeTimes.set(key, now);
    castState.addLog('TVBox', message, detail);
  }

  observeServer(server) {
    if (!this.diagnostics) return;
    server.on('connection', (socket) => {
      const clientIp = normalizeIp(socket.remoteAddress);
      if (['127.0.0.1', '::1', normalizeIp(this.getPreferredIp())].includes(clientIp)) return;
      const port = socket.localPort;
      this.logProbe(`tcp:${clientIp}:${port}`, '手机 TCP 连接已到达', { clientIp, port });
    });
  }

  async start() {
    castState.on('stateChange', this.onStateChange);
    const app = express();
    app.disable('x-powered-by');
    app.use(this.createRouter());
    const server = http.createServer(app);
    this.observeServer(server);
    const error = await new Promise((resolve) => {
      server.once('error', resolve);
      server.listen(this.port, '0.0.0.0', () => {
        server.removeListener('error', resolve);
        resolve(null);
      });
    });
    if (error) {
      castState.setProtocolStatus('tvbox', { active: false, port: this.port, lastError: error.code });
      castState.addLog('TVBox', `影视兼容端口 ${this.port} 启动失败: ${error.code}`);
      return;
    }
    this.server = server;
    this.port = server.address().port;
    castState.setProtocolStatus('tvbox', { active: true, port: this.port, lastError: null });
    castState.addLog('TVBox', `影视 HTTP 设备发现与投屏已开启: ${this.port}`);
  }

  async stop() {
    castState.off('stateChange', this.onStateChange);
    this.requestId += 1;
    castState.setProtocolStatus('tvbox', { active: false });
    if (!this.server) return;
    this.server.closeAllConnections?.();
    await new Promise((resolve) => this.server.close(resolve));
    this.server = null;
  }

  createRouter() {
    const router = express.Router();
    router.use((req, res, next) => {
      if (this.diagnostics && req.path !== '/device' &&
          (req.socket.localPort === this.port || ['/action', '/media'].includes(req.path))) {
        const detail = {
          clientIp: normalizeIp(req.socket.remoteAddress),
          port: req.socket.localPort,
          method: req.method,
          path: req.path.slice(0, 100),
          userAgent: String(req.get('user-agent') || '').slice(0, 200),
        };
        this.logProbe(`http:${detail.clientIp}:${detail.port}:${detail.method}:${detail.path}`, '收到影视 HTTP 请求', detail);
      }
      next();
    });
    router.get('/device', (req, res) => {
      const ip = normalizeIp(req.socket.remoteAddress);
      this.logProbe(`device:${ip}:${req.socket.localPort}`, '收到影视设备搜索', {
        clientIp: ip,
        port: req.socket.localPort,
        userAgent: String(req.get('user-agent') || '').slice(0, 200),
      });
      const identity = this.getIdentity();
      // A separate UUID keeps the app's DLNA discovery from overwriting this entry.
      res.set('Cache-Control', 'no-store').json({
        uuid: `${identity.uuid}-tvbox`,
        name: `${identity.deviceName} (影视)`,
        ip: `http://${this.getPreferredIp()}:${this.server ? this.port : this.mainPort || this.port}`,
        type: 0,
      });
    });

    router.get('/media', (req, res) => {
      const snap = castState.getSnapshot();
      res.set('Cache-Control', 'no-store').json({
        state: snap.status === 'PLAYING' ? 3 : snap.status === 'PAUSED' ? 2 : 1,
        speed: snap.playbackRate,
        duration: Math.round(snap.duration * 1000),
        position: Math.round(snap.position * 1000),
        url: snap.url,
        title: snap.metadata.title,
        artist: snap.metadata.artist,
        artwork: snap.metadata.artwork,
      });
    });

    router.all('/action', express.urlencoded({ extended: false, limit: '2mb' }), express.json({ limit: '2mb' }), async (req, res) => {
      const params = { ...req.query, ...req.body };
      try {
        if (params.do === 'cast') await this.cast(req, params);
        else if (params.do === 'control') this.control(params.type);
        else throw Object.assign(new Error('暂不支持此影视操作'), { status: 501 });
        res.type('text/plain').send('OK');
      } catch (error) {
        castState.addLog('TVBox', error.message, { clientIp: normalizeIp(req.socket.remoteAddress) });
        res.status(error.status || 502).type('text/plain').send(error.message);
      }
    });
    router.use((error, req, res, next) => {
      if (req.path !== '/action') return next(error);
      res.status(error.status || 400).type('text/plain').send('投屏请求格式错误');
    });
    return router;
  }

  async readSenderMedia(device, clientIp) {
    let port = 9978;
    if (device.ip) {
      const address = new URL(device.ip);
      // Only contact the phone making this request, not an unrelated advertised host.
      if (address.protocol !== 'http:' || normalizeIp(address.hostname) !== clientIp || address.username || address.password) {
        throw new Error('手机设备地址与请求来源不一致');
      }
      port = Number(address.port || 80);
    }
    const host = clientIp.includes(':') ? `[${clientIp}]` : clientIp;
    const response = await fetch(`http://${host}:${port}/media`, {
      signal: AbortSignal.timeout(this.senderTimeout),
      redirect: 'error',
    });
    if (!response.ok) throw new Error(`手机 /media 返回 ${response.status}`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 128 * 1024) throw new Error('手机 /media 响应过大');
      chunks.push(Buffer.from(chunk));
    }
    return objectParam(Buffer.concat(chunks).toString('utf8'), '手机媒体信息');
  }

  async cast(req, params) {
    const device = objectParam(params.device, 'device');
    const history = objectParam(params.history, 'history');
    const clientIp = normalizeIp(req.socket.remoteAddress);
    const requestId = ++this.requestId;
    const sessionId = castState.getSnapshot().sessionId;
    let media = {};
    let lookupError = '';
    try {
      media = await this.readSenderMedia(device, clientIp);
    } catch (error) {
      lookupError = error.message;
    }
    // /media contains the resolved URL, unlike History.episodeUrl, which can be a
    // detail page or a spider ID. Only use recognizable media URLs as a fallback.
    const resolvedUrl = httpUrl(media.url, clientIp);
    const episodeUrl = httpUrl(history.episodeUrl, clientIp);
    const directEpisode = /\.(m3u8?|mp4|mkv|webm|flv|ts|mov|m4v|mp3|m4a|aac|ogg|wav)(?:$|\?)/i.test(episodeUrl);
    const url = resolvedUrl || (directEpisode ? episodeUrl : '');
    if (!url) {
      throw new Error(`未取得手机正在播放的视频地址，请先在手机播放后再投屏${lookupError ? `（${lookupError}）` : ''}`);
    }
    if (requestId !== this.requestId || sessionId !== castState.getSnapshot().sessionId) {
      throw Object.assign(new Error('投屏请求已被新的操作替代'), { status: 409 });
    }
    const position = millisecondsToSeconds(resolvedUrl ? media.position : history.position);
    const duration = millisecondsToSeconds(resolvedUrl ? media.duration : history.duration);
    castState.setMedia({
      url,
      protocol: 'TVBox',
      metadata: {
        title: media.title || [history.vodName, history.vodRemarks].filter(Boolean).join(' · '),
        artist: media.artist || '',
        artwork: media.artwork || history.vodPic || '',
        duration,
      },
      clientIp,
      clientName: device.name || '影视手机端',
      // startPosition also represents AirPlay ratios below 1. Use an explicit
      // seconds unit for this protocol, including sub-second resume positions.
      startPosition: position,
      startPositionUnit: 'seconds',
      autoPlay: true,
    });
    if (!resolvedUrl) castState.addLog('TVBox', '手机媒体查询失败，使用直链剧集地址', { reason: lookupError });
  }

  control(type) {
    if (type === 'stop') {
      this.requestId += 1;
      castState.stop('TVBox');
    } else if (type === 'play') castState.play('TVBox');
    else if (type === 'pause') castState.pause('TVBox');
    else if (type === 'replay') {
      castState.seek(0, 'TVBox');
      castState.play('TVBox');
    } else throw Object.assign(new Error('暂不支持此播放控制'), { status: 501 });
  }
}

module.exports = TvBoxService;
