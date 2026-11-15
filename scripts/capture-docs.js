'use strict';
// Render the real UI with neutral, explicitly labelled documentation fixtures.
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');
const express = require('express');
const QRCode = require('qrcode');
const { WebSocketServer } = require('ws');
const root = path.resolve(__dirname, '..');
const output = path.join(root, 'docs', 'images');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV documentation '));
const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });
let status;
const state = {
  sessionId: 0, status: 'IDLE', mediaType: 'video', url: '', metadata: {}, position: 0, duration: 0,
  volume: 80, muted: false, playbackRate: 1, rotation: 0, fitMode: 'contain', streamMode: 'auto',
  protocols: { dlna: { active: true, ssdpBound: true }, airplay: { active: true }, tvbox: { active: true }, websocket: { clients: 2, mobileClients: 1, tvClients: 1 } },
};
function snapshot(mobile) {
  return mobile ? { ...status, state: { ...state, sessionId: 1, status: 'PLAYING', protocol: 'DLNA', clientName: '手机视频 App', metadata: { title: '一起享受大屏时光', artist: '示例视频' }, position: 125, duration: 1800 } } : status;
}
app.get('/api/status', (req, res) => res.json(snapshot(String(req.headers.referer || '').includes('mobile.html'))));
app.use(express.static(path.join(root, 'public')));
app.use('/vendor/hls', express.static(path.join(root, 'node_modules', 'hls.js', 'dist')));
app.use('/vendor/mpegts', express.static(path.join(root, 'node_modules', 'mpegts.js', 'dist')));
wss.on('connection', (socket, req) => socket.send(JSON.stringify({ type: 'init', data: snapshot(req.url.includes('role=mobile')) })));

async function main() {
  fs.mkdirSync(output, { recursive: true });
  const mobileUrl = 'http://192.168.1.100:8080/mobile.html';
  status = { identity: { deviceName: 'MobileTV 客厅', uuid: '00000000-0000-4000-8000-000000000001', mac: '02:00:00:00:00:01' }, primaryIp: '192.168.1.100', interfaces: [{ name: 'Wi-Fi', address: '192.168.1.100' }], port: 8080, mobileUrl, qrDataUrl: await QRCode.toDataURL(mobileUrl), state, logs: [], history: [] };
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  const edge = ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(file => fs.existsSync(file));
  if (!edge) throw new Error('Microsoft Edge is required to render the documentation screenshots.');
  for (const shot of [{ name: 'desktop', size: '1440,1000', page: '/' }, { name: 'mobile', size: '520,900', page: '/mobile.html' }]) {
    await new Promise((resolve, reject) => {
      const child = spawn(edge, ['--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--force-device-scale-factor=1', '--window-size=' + shot.size, '--virtual-time-budget=2500', '--user-data-dir=' + path.join(sandbox, shot.name), '--screenshot=' + path.join(output, shot.name + '.png'), base + shot.page], { windowsHide: true, stdio: 'ignore' });
      const timeout = setTimeout(() => { child.kill(); reject(new Error('Screenshot timed out')); }, 45000);
      child.once('error', error => { clearTimeout(timeout); reject(error); });
      child.once('exit', code => { clearTimeout(timeout); code === 0 ? resolve() : reject(new Error('Edge exited: ' + code)); });
    });
    console.log('Rendered docs/images/' + shot.name + '.png');
  }
}
main().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  for (const socket of wss.clients) socket.terminate();
  wss.close(); server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  const target = fs.realpathSync(sandbox);
  if (path.dirname(target).toLowerCase() !== fs.realpathSync(os.tmpdir()).toLowerCase() || !path.basename(target).startsWith('MobileTV documentation ')) throw new Error('Unexpected screenshot cleanup path');
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch { console.log('Screenshot profile retained at ' + target); }
});
