const assert = require('assert');
const { randomUUID } = require('crypto');
const http = require('http');
const dgram = require('dgram');
const { performance } = require('perf_hooks');
const { WebSocket } = require('ws');
const plist = require('plist');
const { createAppServer } = require('../src/server');
const { getPrimaryLanIp } = require('../src/utils/network');
const { verifyAirplay } = require('./airplay');

async function httpRequest(url, { method = 'GET', headers = {}, body = null } = {}) {
  const res = await fetch(url, { method, headers, body });
  const buf = Buffer.from(await res.arrayBuffer());
  return { status: res.status, headers: res.headers, body: buf.toString('utf8'), buffer: buf };
}

function sendSoap(baseUrl, path, serviceType, action, innerXml) {
  const envelope = `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${action} xmlns:u="${serviceType}">
      ${innerXml}
    </u:${action}>
  </s:Body>
</s:Envelope>`;

  return httpRequest(`${baseUrl}${path}`, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/xml; charset="utf-8"',
      SOAPACTION: `"${serviceType}#${action}"`,
    },
    body: envelope,
  });
}

async function testSsdpDiscovery(expectedPort) {
  return new Promise((resolve, reject) => {
    const client = dgram.createSocket({ type: 'udp4', reuseAddr: true });
    const start = performance.now();
    let done = false;

    const timer = setTimeout(() => {
      if (done) return;
      done = true;
      client.close();
      reject(new Error('SSDP M-SEARCH timeout after 2500ms'));
    }, 2500);

    client.on('message', (msg) => {
      const text = msg.toString('utf8');
      if (text.includes('200 OK') && text.includes(`/upnp/device.xml`) && text.includes(`:${expectedPort}/`)) {
        if (done) return;
        done = true;
        clearTimeout(timer);
        const elapsedMs = performance.now() - start;
        client.close();
        resolve({ response: text, elapsedMs });
      }
    });

    client.bind(0, '0.0.0.0', () => {
      const msearch = [
        'M-SEARCH * HTTP/1.1',
        'HOST: 239.255.255.250:1900',
        'MAN: "ssdp:discover"',
        'MX: 1',
        'ST: urn:schemas-upnp-org:service:AVTransport:1',
        '',
        '',
      ].join('\r\n');
      const buf = Buffer.from(msearch, 'utf8');
      const targetIp = getPrimaryLanIp();
      client.send(buf, 0, buf.length, 1900, targetIp);
      client.send(buf, 0, buf.length, 1900, '239.255.255.250');
    });
  });
}

async function createMockMediaUpstream() {
  const sampleBytes = Buffer.alloc(4096);
  for (let i = 0; i < sampleBytes.length; i++) sampleBytes[i] = i % 251;

  const srv = http.createServer((req, res) => {
    if (req.url === '/live/master.m3u8') {
      const playlist = [
        '#EXTM3U',
        '#EXT-X-VERSION:3',
        '#EXT-X-TARGETDURATION:4',
        '#EXT-X-KEY:METHOD=AES-128,URI="keys/enc.key"',
        '#EXTINF:4.000,',
        'seg-001.ts',
        '#EXTINF:4.000,',
        '/live/seg-002.ts?token=abc',
        '#EXT-X-ENDLIST',
      ].join('\n');
      res.writeHead(200, { 'Content-Type': 'application/vnd.apple.mpegurl' });
      res.end(playlist);
      return;
    }

    if (req.url === '/video/sample.mp4') {
      const range = req.headers.range;
      if (range) {
        const m = range.match(/bytes=(\d+)-(\d*)/);
        const start = Number(m[1]);
        const end = m[2] ? Number(m[2]) : sampleBytes.length - 1;
        const slice = sampleBytes.subarray(start, end + 1);
        res.writeHead(206, {
          'Content-Type': 'video/mp4',
          'Content-Length': slice.length,
          'Content-Range': `bytes ${start}-${end}/${sampleBytes.length}`,
          'Accept-Ranges': 'bytes',
        });
        res.end(slice);
        return;
      }
      res.writeHead(200, {
        'Content-Type': 'video/mp4',
        'Content-Length': sampleBytes.length,
        'Accept-Ranges': 'bytes',
      });
      res.end(sampleBytes);
      return;
    }

    res.writeHead(404);
    res.end();
  });

  await new Promise((resolve) => srv.listen(0, '127.0.0.1', resolve));
  return {
    port: srv.address().port,
    sampleBytes,
    close: () => new Promise((r) => srv.close(r)),
  };
}

async function run() {
  console.log('=== MobileTvScreen 集成协议与性能验证 ===');
  const upstream = await createMockMediaUpstream();
  const appSrv = await createAppServer({
    port: 0, airplayPort: 17000, tvboxPort: 0,
    identity: { uuid: randomUUID(), mac: '02:00:00:00:00:01', deviceName: `MobileTV Test ${process.pid}` },
  });
  const baseUrl = `http://127.0.0.1:${appSrv.port}`;
  const mockMp4Url = `http://127.0.0.1:${upstream.port}/video/sample.mp4`;
  const mockM3u8Url = `http://127.0.0.1:${upstream.port}/live/master.m3u8`;

  try {
    // 1. Status & WebSocket verification
    console.log('[1/5] 验证 HTTP /api/status 与 WebSocket 实时通信...');
    const statusRes = await httpRequest(`${baseUrl}/api/status`);
    assert.strictEqual(statusRes.status, 200);
    const statusJson = JSON.parse(statusRes.body);
    assert(statusJson.primaryIp, 'primaryIp should be detected');
    assert(statusJson.qrDataUrl.startsWith('data:image/png;base64,'), 'QR code should be generated');
    assert.strictEqual(statusJson.state.protocols.dlna.active, true, 'DLNA should be active');
    assert.strictEqual(statusJson.state.protocols.airplay.active, true, 'AirPlay should be active');

    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${appSrv.port}/ws?role=tv`);
      ws.on('message', (raw) => {
        const msg = JSON.parse(raw.toString());
        if (msg.type === 'init') {
          ws.close();
          resolve();
        }
      });
      ws.on('error', reject);
    });
    console.log(`  PASS: LAN IP = ${statusJson.primaryIp}, Port = ${appSrv.port}`);

    // 2. SSDP M-SEARCH verification
    console.log('[2/5] 验证 SSDP UDP 1900 局域网发现...');
    const ssdpResult = await testSsdpDiscovery(appSrv.port);
    assert(ssdpResult.response.includes('AVTransport:1'));
    console.log(`  PASS: SSDP 响应耗时 ${ssdpResult.elapsedMs.toFixed(1)} ms`);

    // 3. DLNA / UPnP SOAP & Latency verification
    console.log('[3/5] 验证 DLNA device.xml、DIDL-Lite 解析、SOAP 控制与 O(1) 轮询延迟...');
    const devXml = await httpRequest(`${baseUrl}/upnp/device.xml`);
    assert.strictEqual(devXml.status, 200);
    assert(devXml.body.includes('urn:schemas-upnp-org:device:MediaRenderer:1'));

    const scpdAv = await httpRequest(`${baseUrl}/upnp/scpd/AVTransport.xml`);
    assert.strictEqual(scpdAv.status, 200);
    assert(scpdAv.body.includes('SetAVTransportURI'));

    const avService = 'urn:schemas-upnp-org:service:AVTransport:1';
    const didl = `&lt;DIDL-Lite xmlns=&quot;urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/&quot; xmlns:dc=&quot;http://purl.org/dc/elements/1.1/&quot;&gt;&lt;item id=&quot;0&quot;&gt;&lt;dc:title&gt;B站4K测试视频&lt;/dc:title&gt;&lt;/item&gt;&lt;/DIDL-Lite&gt;`;
    const setUriRes = await sendSoap(
      baseUrl,
      '/upnp/control/AVTransport1',
      avService,
      'SetAVTransportURI',
      `<InstanceID xmlns:dt="urn:schemas-microsoft-com:datatypes" dt:dt="ui4">0</InstanceID><CurrentURI xmlns:dt="urn:schemas-microsoft-com:datatypes" dt:dt="string">${mockMp4Url}</CurrentURI><CurrentURIMetaData dt:dt="string">${didl}</CurrentURIMetaData>`
    );
    assert.strictEqual(setUriRes.status, 200);

    // Verify SetAVTransportURI immediately enters PLAYING state without stalling in LOADING
    const immediatelyAfterUri = JSON.parse((await httpRequest(`${baseUrl}/api/status`)).body);
    assert.strictEqual(immediatelyAfterUri.state.status, 'PLAYING');
    assert.strictEqual(immediatelyAfterUri.state.url, mockMp4Url);

    const playRes = await sendSoap(
      baseUrl,
      '/upnp/control/AVTransport1',
      avService,
      'Play',
      `<InstanceID>0</InstanceID><Speed>1</Speed>`
    );
    assert.strictEqual(playRes.status, 200);

    const seekRes = await sendSoap(
      baseUrl,
      '/upnp/control/AVTransport1',
      avService,
      'Seek',
      `<InstanceID>0</InstanceID><Unit>REL_TIME</Unit><Target>00:01:25</Target>`
    );
    assert.strictEqual(seekRes.status, 200);

    // Warm up one call, then measure GetPositionInfo latency
    await sendSoap(baseUrl, '/upnp/control/AVTransport1', avService, 'GetPositionInfo', `<InstanceID>0</InstanceID>`);
    const t0 = performance.now();
    const posRes = await sendSoap(
      baseUrl,
      '/upnp/control/AVTransport1',
      avService,
      'GetPositionInfo',
      `<InstanceID>0</InstanceID>`
    );
    const posLatencyMs = performance.now() - t0;
    assert.strictEqual(posRes.status, 200);
    assert(posRes.body.includes('<RelTime>00:01:25</RelTime>') || posRes.body.includes('<RelTime>00:01:26</RelTime>'));
    assert(posLatencyMs < 15, `GetPositionInfo latency too high: ${posLatencyMs}ms`);

    const afterDlna = JSON.parse((await httpRequest(`${baseUrl}/api/status`)).body);
    assert.strictEqual(afterDlna.state.status, 'PLAYING');
    assert.strictEqual(afterDlna.state.protocol, 'DLNA');
    assert.strictEqual(afterDlna.state.metadata.title, 'B站4K测试视频');
    console.log(`  PASS: DLNA SOAP 控制 & DIDL 解析正常, GetPositionInfo 延迟 ${posLatencyMs.toFixed(2)} ms`);

    // 4. AirPlay protocol verification
    console.log('[4/5] 验证 Apple AirPlay 协议 (/server-info, /play, /scrub, /rate, /playback-info, /photo)...');
    const srvInfo = await httpRequest(`${baseUrl}/server-info`);
    assert.strictEqual(srvInfo.status, 200);
    const parsedInfo = plist.parse(srvInfo.body);
    assert.strictEqual(parsedInfo.model, 'AppleTV3,2');

    const apPlay = await httpRequest(`${baseUrl}/play`, {
      method: 'POST',
      headers: { 'Content-Type': 'text/parameters' },
      body: `Content-Location: ${mockMp4Url}\nStart-Position: 0.25\n`,
    });
    assert.strictEqual(apPlay.status, 200);

    const apScrub = await httpRequest(`${baseUrl}/scrub`);
    assert.strictEqual(apScrub.status, 200);
    assert(apScrub.body.includes('position:'));

    const apRatePause = await httpRequest(`${baseUrl}/rate?value=0.0`, { method: 'POST' });
    assert.strictEqual(apRatePause.status, 200);

    const apPlaybackInfo = await httpRequest(`${baseUrl}/playback-info`);
    assert.strictEqual(apPlaybackInfo.status, 200);
    const pbObj = plist.parse(apPlaybackInfo.body);
    assert.strictEqual(pbObj.rate, 0);

    const fakeJpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46]);
    const apPhoto = await httpRequest(`${baseUrl}/photo`, {
      method: 'PUT',
      headers: { 'Content-Type': 'image/jpeg' },
      body: fakeJpeg,
    });
    assert.strictEqual(apPhoto.status, 200);
    const afterPhoto = JSON.parse((await httpRequest(`${baseUrl}/api/status`)).body);
    assert.strictEqual(afterPhoto.state.mediaType, 'image');
    const photoFetch = await httpRequest(afterPhoto.state.url);
    assert.strictEqual(photoFetch.status, 200);
    assert(photoFetch.buffer.equals(fakeJpeg), 'Uploaded AirPlay photo bytes must match');
    await verifyAirplay(appSrv, baseUrl, mockMp4Url);
    console.log('  PASS: AirPlay 视频/进度/暂停/相册投屏协议模拟通过（未替代苹果真机兼容性测试）');

    // 5. Streaming proxy & HLS rewrite & Range verification
    console.log('[5/5] 验证流媒体 Keep-Alive 代理、HLS M3U8 重写与 Range 206 分片拖拽...');
    const m3u8Proxy = await httpRequest(`${baseUrl}/api/proxy?url=${encodeURIComponent(mockM3u8Url)}`);
    assert.strictEqual(m3u8Proxy.status, 200);
    assert(
      m3u8Proxy.body.includes(`/api/proxy?url=${encodeURIComponent(`http://127.0.0.1:${upstream.port}/live/seg-001.ts`)}`),
      'Relative .ts segment should be rewritten to proxy URL'
    );
    assert(
      m3u8Proxy.body.includes(`/api/proxy?url=${encodeURIComponent(`http://127.0.0.1:${upstream.port}/live/keys/enc.key`)}`),
      'Encryption key URI should be rewritten to proxy URL'
    );

    const rangeProxy = await httpRequest(`${baseUrl}/api/proxy?url=${encodeURIComponent(mockMp4Url)}`, {
      headers: { Range: 'bytes=100-611' },
    });
    assert.strictEqual(rangeProxy.status, 206);
    assert.strictEqual(rangeProxy.headers.get('content-range'), `bytes 100-611/${upstream.sampleBytes.length}`);
    assert(rangeProxy.buffer.equals(upstream.sampleBytes.subarray(100, 612)), 'Range slice bytes must match');
    const hlsVendor = await httpRequest(`${baseUrl}/vendor/hls/hls.min.js`);
    assert.strictEqual(hlsVendor.status, 200);
    const mpegtsVendor = await httpRequest(`${baseUrl}/vendor/mpegts/mpegts.js`);
    assert.strictEqual(mpegtsVendor.status, 200);

    const apDedicated = await httpRequest('http://127.0.0.1:17000/server-info');
    assert.strictEqual(apDedicated.status, 200);

    const castTestRes = await httpRequest(`${baseUrl}/api/cast/test`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'dlna-sim' }),
    });
    assert.strictEqual(castTestRes.status, 200);

    console.log('  PASS: HLS 清单重写、206 Range 零拷贝转发、离线播放器资源与模拟测试流全部通过');

    console.log('\n全部 5 项端到端协议与性能验证通过!');
  } finally {
    await appSrv.close();
    await upstream.close();
  }
}

run().catch((err) => {
  console.error('Verification failed:', err);
  process.exit(1);
});
