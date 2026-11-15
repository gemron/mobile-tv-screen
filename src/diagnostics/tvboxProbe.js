// Temporary discovery probe: observe a phone without restarting the receiver.
// Run with: node src/diagnostics/tvboxProbe.js
const http = require('http');
const path = require('path');
const QRCode = require('qrcode');
const { getPrimaryLanIp } = require('../utils/network');

const port = Number(process.env.TVBOX_PROBE_PORT || 9979);
const upstream = process.env.TVBOX_PROBE_UPSTREAM || 'http://127.0.0.1:9978';
const log = (event, detail = {}) => console.log(JSON.stringify({ time: new Date().toISOString(), event, ...detail }));

const server = http.createServer(async (req, res) => {
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const clientIp = req.socket.remoteAddress;
  log('request', { clientIp, method: req.method, path: pathname, userAgent: String(req.headers['user-agent'] || '').slice(0, 250) });
  if (req.method !== 'GET' || pathname !== '/device') {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('This diagnostic endpoint only provides GET /device.');
    return;
  }
  try {
    const response = await fetch(`${upstream}/device`, { signal: AbortSignal.timeout(1500) });
    if (!response.ok) throw new Error(`Receiver returned ${response.status}`);
    const device = await response.json();
    // Preserve the real receiver IP/port so selecting the discovered device
    // sends casting requests directly to it with the phone's original address.
    const body = Buffer.from(JSON.stringify(device));
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': body.length, 'Cache-Control': 'no-store' });
    res.end(body);
    log('device-response', { clientIp, status: 200, bytes: body.length, receiver: device.ip });
  } catch (error) {
    log('upstream-error', { clientIp, error: error.message });
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Receiver unavailable');
  }
});

server.on('connection', (socket) => {
  const clientIp = socket.remoteAddress;
  log('connection', { clientIp, port: socket.localPort });
  socket.once('data', (bytes) => log('first-bytes', { clientIp, hex: bytes.subarray(0, 8).toString('hex') }));
  socket.on('error', (error) => log('socket-error', { clientIp, error: error.code }));
});
server.on('clientError', (error, socket) => {
  log('http-error', { clientIp: socket.remoteAddress, error: error.code });
  if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});
server.on('upgrade', (req, socket) => {
  log('upgrade', { clientIp: socket.remoteAddress, path: new URL(req.url, 'http://localhost').pathname, upgrade: req.headers.upgrade });
  socket.end('HTTP/1.1 426 Upgrade Required\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
});
server.on('error', (error) => { log('server-error', { error: error.code }); process.exitCode = 1; });
server.listen(port, '0.0.0.0', async () => {
  const address = `http://${getPrimaryLanIp()}:${server.address().port}`;
  try {
    const file = path.resolve(__dirname, '../../data/uploads/tvbox-diagnostic-qr.png');
    await QRCode.toFile(file, address, { width: 480, margin: 4 });
    log('ready', { address, qrFile: file });
  } catch (error) {
    log('qr-error', { error: error.message });
    server.close();
    process.exitCode = 1;
  }
});
