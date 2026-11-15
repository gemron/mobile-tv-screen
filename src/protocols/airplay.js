const http = require('http');
const express = require('express');
const plist = require('plist');
const bplistParser = require('bplist-parser');
const castState = require('../services/castState');
const { getPrimaryLanIp } = require('../utils/network');

// Legacy HTTP video, photos and HLS only. No RAOP, FairPlay or screen mirroring.
const AIRPLAY_FEATURES = (1 << 0) | (1 << 1) | (1 << 4);

/**
 * Parse AirPlay request body across Binary Plist, XML Plist, and text/parameters formats.
 * @param {Buffer} buf
 * @param {string} contentType
 * @returns {Record<string, any>}
 */
function parseAirplayPayload(buf, contentType = '') {
  if (!buf || !buf.length) return {};
  const ct = String(contentType).toLowerCase();

  // Binary plist magic header check ("bplist00")
  if (ct.includes('binary-plist') || buf.slice(0, 6).toString('ascii') === 'bplist') {
    try {
      const parsed = bplistParser.parseBuffer(buf);
      return Array.isArray(parsed) && parsed[0] && typeof parsed[0] === 'object' ? parsed[0] : {};
    } catch {
      return {};
    }
  }

  const text = buf.toString('utf8').trim();
  if (!text) return {};

  // XML Plist
  if (ct.includes('xml') || text.startsWith('<?xml') || text.startsWith('<plist')) {
    try {
      const parsed = plist.parse(text);
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch {
      return {};
    }
  }

  // Standard AirPlay text/parameters ("Key: Value\n...")
  const result = {};
  for (const line of text.split(/\r?\n/)) {
    const idx = line.indexOf(':');
    if (idx === -1) continue;
    const key = line.slice(0, idx).trim();
    const val = line.slice(idx + 1).trim();
    if (key) result[key] = val;
  }
  return result;
}

class AirPlayService {
  constructor({ mainPort, airplayPort = 7000, getIdentity, getPreferredIp }) {
    this.mainPort = mainPort;
    this.airplayPort = airplayPort;
    this.getIdentity = getIdentity;
    this.getPreferredIp = getPreferredIp;

    this.bonjour = null;
    this.airplayAd = null;
    this.dedicatedServer = null;
    this.reverseSockets = new Map();
    this.playbackSession = null;
    this._onStateChange = (snapshot) => this._notifyPlaybackState(snapshot);

    // Small bounded in-memory photo cache for zero-disk-I/O iOS photo casting
    this.photoCache = new Map();
    this.photoOrder = [];
  }

  async start() {
    castState.on('stateChange', this._onStateChange);
    const router = this.createRouter();
    let advertisedPort = this.mainPort;

    // Try binding standard AirPlay port 7000 for maximum iOS client compatibility
    if (this.airplayPort && this.airplayPort !== this.mainPort) {
      const dedicatedApp = express();
      dedicatedApp.disable('x-powered-by');
      dedicatedApp.use(router);

      const bound = await new Promise((resolve) => {
        const srv = http.createServer(dedicatedApp);
        srv.on('upgrade', (req, socket) => {
          if (!this.handleUpgrade(req, socket)) socket.destroy();
        });
        srv.on('error', (err) => {
          castState.addLog('AirPlay', `端口 ${this.airplayPort} 占用 (${err.code})，自动复用主端口 ${this.mainPort}`);
          resolve(false);
        });
        srv.listen(this.airplayPort, '0.0.0.0', () => {
          this.dedicatedServer = srv;
          resolve(true);
        });
      });

      if (bound) {
        advertisedPort = this.dedicatedServer.address().port;
      }
    }

    castState.setProtocolStatus('airplay', { lastError: null });
    this._startBonjour(advertisedPort);
    castState.setProtocolStatus('airplay', {
      active: true,
      port: advertisedPort,
      capabilities: { video: true, photo: true, hls: true, mirroring: false, audio: false, fairPlay: false },
    });
    castState.addLog('AirPlay', `接收服务已启动 (Port :${advertisedPort})`);
  }

  async stop() {
    castState.off('stateChange', this._onStateChange);
    this.playbackSession = null;
    for (const sock of this.reverseSockets.keys()) {
      try {
        sock.destroy();
      } catch {
        // Ignore
      }
    }
    this.reverseSockets.clear();

    try {
      this.airplayAd?.stop?.();
      if (this.bonjour?.destroy) {
        await new Promise((resolve) => {
          const t = setTimeout(resolve, 300);
          this.bonjour.destroy(() => {
            clearTimeout(t);
            resolve();
          });
        });
      }
    } catch {
      // Ignore Bonjour cleanup error
    }

    if (this.dedicatedServer) {
      this.dedicatedServer.closeAllConnections?.();
      await new Promise((resolve) => {
        this.dedicatedServer.close(() => resolve());
      });
      this.dedicatedServer = null;
    }

    castState.setProtocolStatus('airplay', { active: false, mdnsActive: false });
  }

  _startBonjour(port) {
    castState.setProtocolStatus('airplay', { mdnsActive: false });
    try {
      const { Bonjour } = require('bonjour-service');
      const { uuid, mac, deviceName } = this.getIdentity();
      const airplayName = `${deviceName} (AirPlay)`;
      this.bonjour = new Bonjour();

      this.airplayAd = this.bonjour.publish({
        name: airplayName,
        type: 'airplay',
        port,
        txt: {
          deviceid: mac,
          features: `0x${AIRPLAY_FEATURES.toString(16)}`,
          flags: '0x4',
          model: 'AppleTV3,2',
          pi: uuid,
          srcvers: '150.33',
          vv: '1',
        },
      });

      this.airplayAd.on('up', () => castState.setProtocolStatus('airplay', { mdnsActive: true }));
    } catch (err) {
      castState.setProtocolStatus('airplay', { mdnsActive: false, lastError: err.message });
      castState.addLog('AirPlay', `Bonjour mDNS 广播初始化失败: ${err.message}`);
    }
  }

  /**
   * Re-publish Bonjour advertisement when device name changes.
   */
  restartBonjour() {
    const port = castState.protocols.airplay.port || this.mainPort;
    try {
      this.airplayAd?.stop?.();
      this.bonjour?.destroy?.();
    } catch {
      // Ignore
    }
    this._startBonjour(port);
  }

  handleUpgrade(req, socket) {
    if (req.method !== 'POST' || req.url.split('?')[0] !== '/reverse' ||
        String(req.headers.upgrade).toLowerCase() !== 'ptth/1.0') return false;

    const channel = {
      sessionId: String(req.headers['x-apple-session-id'] || ''),
      clientIp: socket.remoteAddress?.replace('::ffff:', '') || '',
      lastEvent: '',
    };
    this.reverseSockets.set(socket, channel);
    socket.on('close', () => this.reverseSockets.delete(socket));
    socket.on('error', () => socket.destroy());
    // The client replies HTTP 200 to /event messages on the upgraded socket.
    // Drain those replies without handing them back to Node's request parser.
    socket.on('data', () => {});
    socket.setTimeout(0);
    socket.setKeepAlive(true);
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: PTTH/1.0\r\nConnection: Upgrade\r\n\r\n');
    castState.addLog('AirPlay', '建立反向事件通道 (/reverse)', { clientIp: channel.clientIp });
    this._notifyPlaybackState(castState.getSnapshot());
    return true;
  }

  _beginPlaybackSession(req, category) {
    // End the previous client's session before replacing its media.
    if (this.playbackSession) this._sendPlaybackEvent('stopped');
    this.playbackSession = {
      sessionId: String(req.headers['x-apple-session-id'] || ''),
      clientIp: (req.ip || '').replace('::ffff:', ''),
      castSessionId: castState.state.sessionId + 1,
      category,
    };
  }

  _notifyPlaybackState(snapshot) {
    if (!this.playbackSession) return;
    if (snapshot.protocol !== 'AirPlay' || snapshot.sessionId !== this.playbackSession.castSessionId) {
      this._sendPlaybackEvent('stopped');
      this.playbackSession = null;
      return;
    }
    const state = { PLAYING: 'playing', PAUSED: 'paused', LOADING: 'loading' }[snapshot.status] || 'stopped';
    this._sendPlaybackEvent(state);
    if (state === 'stopped') this.playbackSession = null;
  }

  _sendPlaybackEvent(state) {
    const session = this.playbackSession;
    if (!session || (session.category === 'photo' && state !== 'stopped')) return;
    const body = plist.build({ category: session.category, sessionID: session.castSessionId, state });
    for (const [socket, channel] of this.reverseSockets) {
      const matches = session.sessionId ? channel.sessionId === session.sessionId : channel.clientIp === session.clientIp;
      const eventKey = `${session.castSessionId}:${state}`;
      if (!matches || socket.destroyed || channel.lastEvent === eventKey) continue;
      channel.lastEvent = eventKey;
      const sessionHeader = channel.sessionId ? `X-Apple-Session-ID: ${channel.sessionId}\r\n` : '';
      socket.write(`POST /event HTTP/1.1\r\nContent-Type: text/x-apple-plist+xml\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${sessionHeader}\r\n${body}`);
    }
  }

  _storePhoto(buffer, mimeType = 'image/jpeg') {
    const id = `${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    this.photoCache.set(id, { buffer, mimeType });
    this.photoOrder.push(id);
    while (this.photoOrder.length > 3) {
      const oldest = this.photoOrder.shift();
      this.photoCache.delete(oldest);
    }
    return id;
  }

  createRouter() {
    const router = express.Router();
    const rawParser = express.raw({ type: () => true, limit: '30mb' });

    // Serve cached AirPlay photos
    router.get('/api/airplay/photo/:id', (req, res) => {
      const item = this.photoCache.get(req.params.id);
      if (!item) {
        res.status(404).end();
        return;
      }
      res.set('Content-Type', item.mimeType);
      res.set('Cache-Control', 'no-store');
      res.send(item.buffer);
    });

    const handleServerInfo = (req, res) => {
      const { mac, deviceName } = this.getIdentity();
      const clientIp = (req.ip || '').replace('::ffff:', '');
      castState.addLog('AirPlay', `收到 ${req.path} 请求`, { clientIp });
      const xml = plist.build({
        deviceid: mac,
        features: AIRPLAY_FEATURES,
        model: 'AppleTV3,2',
        name: `${deviceName} (AirPlay)`,
        protovers: '1.0',
        srcvers: '150.33',
        vv: 1,
      });
      res.set('Content-Type', 'text/x-apple-plist+xml');
      res.send(xml);
    };

    router.get('/server-info', handleServerInfo);
    router.get('/info', handleServerInfo);

    // Real reverse channels are handled by the HTTP server's upgrade event.
    router.post('/reverse', (req, res) => {
      res.set('Upgrade', 'PTTH/1.0').status(426).end();
    });

    // Legacy media-URL playback (not RAOP audio streaming).
    router.post('/play', rawParser, (req, res) => {
      const payload = parseAirplayPayload(req.body, req.headers['content-type']);
      const url = String(
        payload['Content-Location'] ||
        payload['content-location'] ||
        payload.url ||
        payload.contentLocation ||
        payload.path ||
        '').trim();
      const rawStart = payload['Start-Position'] ?? payload['start-position'] ?? payload.startPosition ?? 0;
      const startPos = parseFloat(rawStart) || 0;
      const clientIp = (req.ip || '').replace('::ffff:', '');

      castState.addLog('AirPlay', `收到 /play 请求`, { clientIp, url: String(url).slice(0, 120) });

      if (!url) {
        res.status(400).end();
        return;
      }

      this._beginPlaybackSession(req, 'video');
      castState.setMedia({
        url: String(url).trim(),
        protocol: 'AirPlay',
        metadata: {
          title: payload.title || 'AirPlay 视频投屏',
          artist: payload.artist || '',
          artwork: payload.artwork || '',
        },
        clientIp,
        clientName: `iOS AirPlay (${clientIp})`,
        startPosition: startPos,
        autoPlay: true,
      });

      res.status(200).end();
    });

    // Seek / Scrub position
    router.post('/scrub', (req, res) => {
      const pos = parseFloat(req.query.position);
      if (Number.isFinite(pos)) {
        castState.seek(pos, 'AirPlay');
      }
      res.status(200).end();
    });

    router.get('/scrub', (req, res) => {
      const snap = castState.getSnapshot();
      res.set('Content-Type', 'text/parameters');
      res.send(`duration: ${snap.duration.toFixed(6)}\nposition: ${snap.position.toFixed(6)}\n`);
    });

    // Rate (0.0 = pause, 1.0 = play)
    router.post('/rate', (req, res) => {
      const rate = parseFloat(req.query.value);
      if (Number.isFinite(rate)) {
        if (rate === 0) {
          castState.pause('AirPlay');
        } else {
          castState.play('AirPlay');
        }
      }
      res.status(200).end();
    });

    router.post('/stop', (req, res) => {
      castState.stop('AirPlay');
      res.status(200).end();
    });

    router.get('/playback-info', (req, res) => {
      const snap = castState.getSnapshot();
      const duration = snap.duration || 0;
      const position = snap.position || 0;
      const playing = snap.status === 'PLAYING';
      const ready = snap.status === 'PLAYING' || snap.status === 'PAUSED';

      const info = {
        duration,
        loadedTimeRanges: duration > 0 ? [{ duration, start: 0 }] : [],
        playbackBufferEmpty: !ready,
        playbackBufferFull: false,
        playbackLikelyToKeepUp: ready,
        position,
        rate: playing ? snap.playbackRate || 1 : 0,
        readyToPlay: ready,
        seekableTimeRanges: duration > 0 ? [{ duration, start: 0 }] : [],
      };
      res.set('Content-Type', 'text/x-apple-plist+xml');
      res.send(plist.build(info));
    });

    // Photo casting from iOS Photos app
    router.put('/photo', rawParser, (req, res) => {
      const buf = Buffer.isBuffer(req.body) ? req.body : Buffer.from(req.body || '');
      const clientIp = (req.ip || '').replace('::ffff:', '');
      castState.addLog('AirPlay', `收到 /photo 图片投屏 (${buf.length} bytes)`, { clientIp });
      if (!buf.length) {
        res.status(400).end();
        return;
      }
      const localIp = getPrimaryLanIp(this.getPreferredIp ? this.getPreferredIp() : undefined);
      const mimeType = req.headers['content-type'] && req.headers['content-type'].startsWith('image/')
        ? req.headers['content-type']
        : 'image/jpeg';

      const id = this._storePhoto(buf, mimeType);
      const photoUrl = `http://${localIp}:${this.mainPort}/api/airplay/photo/${id}`;

      this._beginPlaybackSession(req, 'photo');
      castState.setMedia({
        url: photoUrl,
        protocol: 'AirPlay',
        mediaType: 'image',
        metadata: {
          title: 'iPhone 相册照片',
          mimeType,
        },
        clientIp,
        clientName: `iOS Photo (${clientIp})`,
        autoPlay: true,
        streamMode: 'direct',
      });

      res.status(200).end();
    });

    for (const endpoint of ['/fp-setup', '/auth-setup', '/pair-setup', '/pair-verify', '/setProperty', '/getProperty']) {
      router.post(endpoint, (req, res) => {
        castState.addLog('AirPlay', `不支持 ${endpoint}：当前接收端仅实现基础视频/图片投屏`);
        res.status(501).end();
      });
    }

    return router;
  }
}

module.exports = AirPlayService;
