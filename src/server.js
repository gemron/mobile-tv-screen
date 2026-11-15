const http = require('http');
const path = require('path');
const fs = require('fs');
const { execFile, spawn } = require('child_process');
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const QRCode = require('qrcode');
const { WebSocketServer, WebSocket } = require('ws');

const castState = require('./services/castState');
const { createProxyRouter } = require('./services/proxy');
const DlnaService = require('./protocols/dlna');
const AirPlayService = require('./protocols/airplay');
const TvBoxService = require('./protocols/tvbox');
const {
  getLanInterfaces,
  getPrimaryLanIp,
  loadDeviceIdentity,
  saveDeviceName,
} = require('./utils/network');

const { ROOT_DIR, DATA_DIR } = require('./utils/paths');
const APP_VERSION = require('../package.json').version;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const UPLOAD_DIR = path.join(DATA_DIR, 'uploads');

if (!fs.existsSync(UPLOAD_DIR)) {
  fs.mkdirSync(UPLOAD_DIR, { recursive: true });
}

// Configure streaming disk upload with automatic bounded cleanup
const storage = multer.diskStorage({
  destination: (_, __, cb) => cb(null, UPLOAD_DIR),
  filename: (_, file, cb) => {
    const ext = path.extname(file.originalname || '') || '.bin';
    const safeName = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}${ext}`;
    cb(null, safeName);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // up to 2GB local LAN video cast
});

function cleanupOldUploads(maxFiles = 12) {
  try {
    const entries = fs
      .readdirSync(UPLOAD_DIR)
      .map((name) => {
        const full = path.join(UPLOAD_DIR, name);
        const stat = fs.statSync(full);
        return { full, mtimeMs: stat.mtimeMs };
      })
      .sort((a, b) => b.mtimeMs - a.mtimeMs);

    for (let i = maxFiles; i < entries.length; i++) {
      fs.unlinkSync(entries[i].full);
    }
  } catch {
    // Ignore cleanup errors
  }
}

/**
 * Lazily generate a crisp 10-second 60fps local H.264 MP4 sample using FFmpeg for offline cast testing.
 * @returns {Promise<string|null>}
 */
async function ensureSampleVideo() {
  const samplePath = path.join(DATA_DIR, 'sample-test.mp4');
  if (fs.existsSync(samplePath)) {
    const size = fs.statSync(samplePath).size;
    if (size > 10000 && size <= 5 * 1024 * 1024) {
      return samplePath;
    }
  }

  return new Promise((resolve) => {
    const ff = spawn(
      'ffmpeg',
      [
        '-y',
        '-f',
        'lavfi',
        '-i',
        'testsrc2=size=1280x720:rate=60:duration=10',
        '-f',
        'lavfi',
        '-i',
        'sine=frequency=440:duration=10',
        '-c:v',
        'libx264',
        '-preset',
        'veryfast',
        '-crf',
        '28',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'aac',
        '-b:a',
        '96k',
        '-movflags',
        '+faststart',
        samplePath,
      ],
      { stdio: 'ignore', windowsHide: true }
    );
    ff.on('error', () => resolve(null));
    ff.on('exit', (code) => resolve(code === 0 ? samplePath : null));
  });
}

function launchDesktopWindow(url) {
  if (process.platform !== 'win32') return;
  const edgeCandidates = [
    'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
    'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  ];
  const exe = edgeCandidates.find((p) => fs.existsSync(p));
  if (exe) {
    const child = spawn(exe, [`--app=${url}`, '--window-size=1280,800', '--autoplay-policy=no-user-gesture-required'], {
      detached: true,
      stdio: 'ignore',
    });
    child.unref();
    return;
  }
  execFile('cmd', ['/c', 'start', '', url], { windowsHide: true }, () => {});
}

async function createAppServer(options = {}) {
  const port = Number(options.port ?? process.env.PORT ?? 8080);
  const airplayPort = Number(options.airplayPort ?? process.env.AIRPLAY_PORT ?? 7000);
  const enableDlna = options.enableDlna ?? process.env.DISABLE_DLNA !== '1';
  const enableAirplay = options.enableAirplay ?? process.env.DISABLE_AIRPLAY !== '1';
  const enableTvbox = options.enableTvbox ?? process.env.DISABLE_TVBOX !== '1';

  let identity = { ...loadDeviceIdentity(), ...options.identity };
  let preferredIp = getPrimaryLanIp();

  const getIdentity = () => identity;
  const getPreferredIp = () => preferredIp;

  const app = express();
  app.disable('x-powered-by');
  app.use(cors());

  const dlnaService = new DlnaService({ port, getIdentity, getPreferredIp });
  const airplayService = new AirPlayService({
    mainPort: port,
    airplayPort,
    getIdentity,
    getPreferredIp,
  });
  const tvboxService = new TvBoxService({
    port: Number(options.tvboxPort ?? process.env.TVBOX_PORT ?? 9978),
    getIdentity,
    getPreferredIp,
    senderTimeout: options.tvboxSenderTimeout,
  });

  // Static UI & Local Vendor Assets (zero external CDN dependency)
  app.use(express.static(PUBLIC_DIR, { maxAge: 0 }));
  app.use('/vendor/hls', express.static(path.join(ROOT_DIR, 'node_modules/hls.js/dist'), { maxAge: '7d' }));
  app.use('/vendor/mpegts', express.static(path.join(ROOT_DIR, 'node_modules/mpegts.js/dist'), { maxAge: '7d' }));
  app.use('/uploads', express.static(UPLOAD_DIR, { acceptRanges: true }));

  // Mount protocol routers
  app.use('/upnp', dlnaService.createRouter());
  app.use('/', airplayService.createRouter());
  if (enableTvbox) app.use('/', tvboxService.createRouter());
  const proxyRouter = createProxyRouter();
  app.use('/api', proxyRouter);

  // JSON parser scoped to API routes (after AirPlay raw parsers)
  app.use('/api', express.json({ limit: '2mb' }));

  async function buildStatusPayload() {
    const primaryIp = getPrimaryLanIp(preferredIp);
    const interfaces = getLanInterfaces();
    const mobileUrl = `http://${primaryIp}:${port}/mobile.html`;
    let qrDataUrl = '';
    try {
      qrDataUrl = await QRCode.toDataURL(mobileUrl, {
        margin: 1,
        width: 240,
        color: { dark: '#0f172a', light: '#ffffff' },
      });
    } catch {
      qrDataUrl = '';
    }

    return {
      version: APP_VERSION,
      identity,
      primaryIp,
      interfaces,
      port,
      tvUrl: `http://${primaryIp}:${port}/`,
      mobileUrl,
      qrDataUrl,
      state: castState.getSnapshot(),
      logs: castState.getLogs(),
      history: castState.getHistory(),
      mediaCache: proxyRouter.mediaCache.stats(),
    };
  }

  app.get('/api/status', async (req, res) => {
    res.json(await buildStatusPayload());
  });

  app.post('/api/device/name', async (req, res) => {
    const name = String(req.body?.name || '').trim();
    if (!name) {
      res.status(400).json({ error: '设备名称不能为空' });
      return;
    }
    identity = saveDeviceName(name);
    castState.addLog('System', `投屏设备名称修改为: ${identity.deviceName}`);
    if (enableAirplay) airplayService.restartBonjour();
    if (enableDlna) dlnaService._sendSsdpAliveOrBye('ssdp:alive');
    const payload = await buildStatusPayload();
    broadcastWs({ type: 'deviceInfo', data: payload });
    res.json(payload);
  });

  app.post('/api/device/ip', async (req, res) => {
    const ip = String(req.body?.ip || '').trim();
    const ifaces = getLanInterfaces();
    if (!ifaces.some((i) => i.address === ip)) {
      res.status(400).json({ error: '无效的网卡 IP 地址' });
      return;
    }
    preferredIp = ip;
    if (enableDlna) dlnaService._sendSsdpAliveOrBye('ssdp:alive');
    const payload = await buildStatusPayload();
    broadcastWs({ type: 'deviceInfo', data: payload });
    res.json(payload);
  });

  app.post('/api/control', (req, res) => {
    const { action, url, title, mediaType, position, volume, muted, rotation, fitMode, streamMode, playbackRate } =
      req.body || {};

    switch (action) {
      case 'cast':
        if (!url) {
          res.status(400).json({ error: '缺少投屏媒体地址' });
          return;
        }
        castState.setMedia({
          url: String(url).trim(),
          protocol: 'WebCast',
          mediaType: mediaType || '',
          metadata: { title: title || '' },
          clientIp: (req.ip || '').replace('::ffff:', ''),
          clientName: 'Web 投屏推送',
          autoPlay: true,
          streamMode: streamMode || 'auto',
        });
        break;
      case 'play':
        castState.play('Control');
        break;
      case 'pause':
        castState.pause('Control');
        break;
      case 'stop':
        castState.stop('Control');
        break;
      case 'seek':
        castState.seek(position, 'Control');
        break;
      case 'volume':
        castState.setVolume(volume, 'Control');
        break;
      case 'mute':
        castState.setMute(muted, 'Control');
        break;
      case 'display':
        castState.setDisplayOptions({ rotation, fitMode, streamMode, playbackRate });
        break;
      default:
        res.status(400).json({ error: `未知控制指令: ${action}` });
        return;
    }

    res.json({ ok: true, state: castState.getSnapshot() });
  });

  // Built-in local sample media endpoint (works 100% offline for instant testing)
  app.get('/api/sample-video.mp4', async (req, res) => {
    const filePath = await ensureSampleVideo();
    if (!filePath) {
      res.status(503).json({ error: 'Sample generator unavailable' });
      return;
    }
    res.sendFile(filePath);
  });

  app.post('/api/cast/test', async (req, res) => {
    const mode = req.body?.mode || 'dlna-sim';
    const primaryIp = getPrimaryLanIp(preferredIp);
    const sampleUrl = `http://${primaryIp}:${port}/api/sample-video.mp4`;
    const protocol = mode === 'airplay-sim' ? 'AirPlay' : 'DLNA';

    await ensureSampleVideo();
    const snap = castState.setMedia({
      url: sampleUrl,
      protocol,
      mediaType: 'video',
      metadata: {
        title: `${protocol} 60FPS 本地流畅度测试流`,
        artist: 'MobileTvScreen Built-in Diagnostics',
      },
      clientIp: primaryIp,
      clientName: `${protocol} 自检模拟器`,
      autoPlay: true,
      streamMode: 'auto',
    });

    res.json({ ok: true, state: snap });
  });

  // Mobile local photo / video / audio upload & immediate cast
  app.post('/api/upload', upload.single('file'), (req, res) => {
    if (!req.file) {
      res.status(400).json({ error: '未接收到文件' });
      return;
    }

    cleanupOldUploads();
    const primaryIp = getPrimaryLanIp(preferredIp);
    const mediaUrl = `http://${primaryIp}:${port}/uploads/${encodeURIComponent(req.file.filename)}`;
    const originalName = req.file.originalname || req.file.filename;
    const clientIp = (req.ip || '').replace('::ffff:', '');

    const snap = castState.setMedia({
      url: mediaUrl,
      protocol: 'WebCast',
      metadata: {
        title: originalName,
        mimeType: req.file.mimetype || '',
      },
      clientIp,
      clientName: `手机本地文件 (${clientIp})`,
      autoPlay: true,
      streamMode: 'direct',
    });

    res.json({ ok: true, url: mediaUrl, state: snap });
  });

  app.post('/api/system/miracast', (req, res) => {
    if (process.platform !== 'win32') {
      res.status(400).json({ error: '仅 Windows 支持一键唤起系统无线投屏' });
      return;
    }
    execFile('explorer.exe', ['ms-settings:projections'], { windowsHide: true }, (err) => {
      if (err) {
        res.status(500).json({ error: err.message });
        return;
      }
      castState.addLog('System', '已唤起 Windows 系统无线投影 (Miracast) 设置面板');
      res.json({ ok: true });
    });
  });

  const server = http.createServer(app);
  if (enableTvbox) tvboxService.observeServer(server);
  const wss = new WebSocketServer({ noServer: true, path: '/ws' });
  server.on('upgrade', (req, socket, head) => {
    if (enableAirplay && airplayService.handleUpgrade(req, socket)) return;
    if (req.url.split('?')[0] === '/ws') {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    } else {
      socket.destroy();
    }
  });
  const clients = new Map(); // ws -> { role: 'tv'|'mobile' }

  function updateClientCounts() {
    let tvClients = 0;
    let mobileClients = 0;
    for (const meta of clients.values()) {
      if (meta.role === 'mobile') mobileClients++;
      else tvClients++;
    }
    castState.setProtocolStatus('websocket', {
      clients: clients.size,
      tvClients,
      mobileClients,
    });
  }

  function broadcastWs(payload, filterRole = null) {
    const raw = JSON.stringify(payload);
    for (const [ws, meta] of clients.entries()) {
      if (ws.readyState !== WebSocket.OPEN) continue;
      if (filterRole && meta.role !== filterRole) continue;
      ws.send(raw);
    }
  }

  // Forward CastStateService events to WebSocket clients
  const onStateChange = (snap) => broadcastWs({ type: 'state', data: snap });
  const onProgress = (prog) => broadcastWs({ type: 'progress', data: prog });
  const onCommand = (cmd) => broadcastWs({ type: 'command', data: cmd }, 'tv');
  const onLog = (entry) => broadcastWs({ type: 'log', data: entry });
  const onProtoStatus = (protos) => broadcastWs({ type: 'protocols', data: protos });

  castState.on('stateChange', onStateChange);
  castState.on('progress', onProgress);
  castState.on('command', onCommand);
  castState.on('log', onLog);
  castState.on('protocolStatus', onProtoStatus);

  wss.on('connection', (ws, req) => {
    const urlObj = new URL(req.url, `http://127.0.0.1:${port}`);
    const role = urlObj.searchParams.get('role') === 'mobile' ? 'mobile' : 'tv';
    clients.set(ws, { role });
    updateClientCounts();

    ws.send(
      JSON.stringify({
        type: 'init',
        data: {
          identity,
          primaryIp: getPrimaryLanIp(preferredIp),
          port,
          state: castState.getSnapshot(),
          logs: castState.getLogs(),
          history: castState.getHistory(),
        },
      })
    );

    ws.on('message', (rawMsg) => {
      let msg;
      try {
        msg = JSON.parse(rawMsg.toString('utf8'));
      } catch {
        return;
      }

      if (msg.type === 'register' && (msg.role === 'tv' || msg.role === 'mobile')) {
        clients.set(ws, { role: msg.role });
        updateClientCounts();
        return;
      }

      if (msg.type === 'player-telemetry') {
        castState.syncFromPlayer(msg.data || {});
        return;
      }

      if (msg.type === 'control') {
        const d = msg.data || {};
        if (d.action === 'play') castState.play('Web');
        else if (d.action === 'pause') castState.pause('Web');
        else if (d.action === 'stop') castState.stop('Web');
        else if (d.action === 'seek') castState.seek(d.position, 'Web');
        else if (d.action === 'volume') castState.setVolume(d.volume, 'Web');
        else if (d.action === 'mute') castState.setMute(d.muted, 'Web');
        else if (d.action === 'display') castState.setDisplayOptions(d);
        return;
      }

      // WebRTC real-time screen/camera mirroring signaling relay
      if (['webrtc-offer', 'webrtc-answer', 'webrtc-ice', 'webrtc-stop'].includes(msg.type)) {
        if (msg.type === 'webrtc-offer') {
          castState.setMedia({
            url: 'webrtc://mirror',
            protocol: 'WebRTC',
            mediaType: 'mirror',
            metadata: { title: msg.title || '手机实时屏幕/相机镜像' },
            clientName: 'WebRTC 实时镜像',
            autoPlay: true,
            streamMode: 'direct',
          });
          broadcastWs(msg, 'tv');
        } else if (msg.type === 'webrtc-stop') {
          castState.stop('WebRTC');
          broadcastWs(msg, 'tv');
        } else if (msg.type === 'webrtc-answer') {
          broadcastWs(msg, 'mobile');
        } else {
          // Relay ICE candidates to the opposite role
          const senderRole = clients.get(ws)?.role || 'mobile';
          broadcastWs(msg, senderRole === 'mobile' ? 'tv' : 'mobile');
        }
      }
    });

    ws.on('close', () => {
      clients.delete(ws);
      updateClientCounts();
    });
  });

  await new Promise((resolve) => {
    server.listen(port, '0.0.0.0', resolve);
  });

  const actualPort = server.address().port;
  dlnaService.port = actualPort;
  airplayService.mainPort = actualPort;
  tvboxService.mainPort = actualPort;

  if (enableDlna) await dlnaService.start();
  if (enableAirplay) await airplayService.start();
  if (enableTvbox) await tvboxService.start();

  castState.addLog('System', `大屏服务已就绪: http://${getPrimaryLanIp(preferredIp)}:${actualPort}/`);

  return {
    app,
    server,
    wss,
    port: actualPort,
    dlnaService,
    airplayService,
    tvboxService,
    async close() {
      proxyRouter.mediaCache.clear();
      castState.off('stateChange', onStateChange);
      castState.off('progress', onProgress);
      castState.off('command', onCommand);
      castState.off('log', onLog);
      castState.off('protocolStatus', onProtoStatus);
      await dlnaService.stop();
      await airplayService.stop();
      await tvboxService.stop();
      for (const ws of clients.keys()) {
        try {
          ws.terminate();
        } catch {}
      }
      clients.clear();
      wss.close();
      server.closeAllConnections?.();
      await new Promise((resolve) => server.close(() => resolve()));
    },
  };
}

if (require.main === module) {
  createAppServer()
    .then(({ port }) => {
      const localUrl = `http://127.0.0.1:${port}/`;
      console.log(`MobileTvScreen running at ${localUrl}`);
      console.log(`LAN URL: http://${getPrimaryLanIp()}:${port}/`);
      if (process.env.NO_OPEN !== '1') {
        launchDesktopWindow(localUrl);
      }
    })
    .catch((err) => {
      console.error('Failed to start MobileTvScreen:', err);
      process.exit(1);
    });
}

module.exports = { createAppServer, ensureSampleVideo };
