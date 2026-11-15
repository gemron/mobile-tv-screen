const assert = require('assert');
const http = require('http');
const { createAppServer } = require('../src/server');
const castState = require('../src/services/castState');

async function verifyTvbox() {
  let reply = {};
  let requests = 0;
  let release;
  let requested;
  const sender = http.createServer(async (req, res) => {
    requests += 1;
    assert.strictEqual(req.url, '/media');
    if (requested) requested();
    if (reply.wait) await new Promise((resolve) => { release = resolve; });
    if (res.destroyed) return;
    if (reply.redirect) {
      res.writeHead(302, { Location: '/unrelated' });
      return res.end();
    }
    res.setHeader('Content-Type', 'application/json');
    res.end(reply.raw || JSON.stringify(reply));
  });
  await new Promise((resolve) => sender.listen(0, '127.0.0.1', resolve));
  const senderBase = `http://127.0.0.1:${sender.address().port}`;
  const app = await createAppServer({
    port: 0, tvboxPort: 0, tvboxSenderTimeout: 180,
    enableDlna: false, enableAirplay: false,
  });
  const base = `http://127.0.0.1:${app.tvboxService.port}`;
  const main = `http://127.0.0.1:${app.port}`;
  const stream = `${senderBase}/resolved/master.m3u8?token=abc`;
  const history = { episodeUrl: 'spider:opaque-episode', vodName: '影片名', position: 90000 };
  const device = { name: '测试手机', uuid: 'phone', ip: senderBase, type: 1 };
  const sendCast = (fields = {}) => fetch(`${base}/action?do=cast`, {
    method: 'POST',
    body: new URLSearchParams({
      device: JSON.stringify(device), history: JSON.stringify(history),
      config: JSON.stringify({ url: 'https://config.example/source.json' }),
      ...fields,
    }),
  });
  const control = (type) => fetch(`${base}/action?do=control&type=${type}`, { method: 'POST' });

  try {
    console.log('验证影视 HTTP 发现、手机已解析地址、播放控制与失败处理...');
    const identity = await (await fetch(`${base}/device`)).json();
    assert.strictEqual(identity.type, 0);
    assert(identity.uuid.endsWith('-tvbox'), 'HTTP device must not collide with its DLNA UUID');
    assert(identity.name.endsWith('(影视)'));
    assert(identity.ip.endsWith(`:${app.tvboxService.port}`));
    assert.deepStrictEqual(await (await fetch(`${main}/device`)).json(), identity);
    assert.strictEqual((await (await fetch(`${main}/api/status`)).json()).state.protocols.tvbox.active, true);

    reply = { url: stream, title: '已解析影片', position: 500, duration: 125000 };
    let response = await sendCast();
    assert.strictEqual(await response.text(), 'OK');
    let snap = castState.getSnapshot();
    assert.strictEqual(snap.url, stream, 'must use resolved stream instead of opaque episode ID');
    assert.strictEqual(snap.protocol, 'TVBox');
    assert.strictEqual(snap.metadata.title, '已解析影片');
    assert.strictEqual(snap.clientName, '测试手机');
    assert.strictEqual(snap.startPosition, 0.5);
    assert.strictEqual(snap.startPositionUnit, 'seconds');
    assert.strictEqual(snap.duration, 125);
    assert(snap.position >= 0.5 && snap.position < 1);

    assert.strictEqual(await (await control('pause')).text(), 'OK');
    const media = await (await fetch(`${base}/media`)).json();
    assert.strictEqual(media.state, 2);
    assert.strictEqual(media.duration, 125000);
    assert(media.position >= 500 && media.position < 1500);
    await control('play');
    assert.strictEqual(castState.getSnapshot().status, 'PLAYING');
    await control('replay');
    assert(castState.getSnapshot().position < 1);
    assert.strictEqual((await control('next')).status, 501);

    // Unknown IDs and HTML pages must never replace a working cast with a fake success.
    const session = castState.getSnapshot().sessionId;
    reply = {};
    response = await sendCast({ history: JSON.stringify({ episodeUrl: 'https://example.com/watch/123' }) });
    assert.strictEqual(response.status, 502);
    assert((await response.text()).includes('未取得'));
    assert.strictEqual(castState.getSnapshot().sessionId, session);
    const beforeInvalid = requests;
    assert.strictEqual((await sendCast({ history: '{broken' })).status, 400);
    assert.strictEqual(requests, beforeInvalid, 'malformed cast must not start sender lookup');

    // A direct stream remains usable when /media is absent or the sender is older.
    reply = { raw: 'not json' };
    response = await sendCast({ history: JSON.stringify({ episodeUrl: stream, vodName: '直链影片', position: -9223372036854776000 }) });
    assert.strictEqual(await response.text(), 'OK');
    assert.strictEqual(castState.getSnapshot().metadata.title, '直链影片');
    assert.strictEqual(castState.getSnapshot().startPosition, 0);

    reply = { url: `${senderBase}/resolved/no-extension`, position: 10000 };
    response = await sendCast();
    assert.strictEqual(await response.text(), 'OK');
    assert(castState.getSnapshot().url.endsWith('/no-extension'));

    // An advertised device address cannot redirect the lookup to another machine.
    const beforeMismatch = requests;
    response = await sendCast({ device: JSON.stringify({ ip: 'http://192.0.2.10:9978' }) });
    assert.strictEqual(response.status, 502);
    assert.strictEqual(requests, beforeMismatch);
    reply = { redirect: true };
    response = await sendCast();
    assert.strictEqual(response.status, 502);
    reply = { url: 'file:///sdcard/movie.mp4' };
    assert.strictEqual((await sendCast()).status, 502);

    // Stop during a slow lookup must keep the receiver stopped, even if lookup succeeds later.
    reply = { wait: true, url: stream };
    let observed = new Promise((resolve) => { requested = resolve; });
    const pending = sendCast();
    await observed;
    await control('stop');
    release();
    assert.strictEqual((await pending).status, 409);
    assert.strictEqual(castState.getSnapshot().status, 'IDLE');
    requested = null;

    // Stopping from another protocol/UI must also cancel the pending cast.
    observed = new Promise((resolve) => { requested = resolve; });
    const stoppedFromWeb = sendCast();
    await observed;
    castState.stop('Web');
    release();
    assert.strictEqual((await stoppedFromWeb).status, 409);
    assert.strictEqual(castState.getSnapshot().status, 'IDLE');
    requested = null;

    // Bound the entire sender response, including a connected phone that never replies.
    reply = { wait: true, url: stream };
    const started = Date.now();
    response = await sendCast();
    assert.strictEqual(response.status, 502);
    assert(Date.now() - started < 2000);
    release();

    // Port collisions are visible and do not falsely advertise an active receiver.
    const second = await createAppServer({ port: 0, tvboxPort: app.tvboxService.port, enableDlna: false, enableAirplay: false });
    try {
      snap = castState.getSnapshot();
      assert.strictEqual(snap.protocols.tvbox.active, false);
      assert.strictEqual(snap.protocols.tvbox.lastError, 'EADDRINUSE');
      const fallback = await (await fetch(`http://127.0.0.1:${second.port}/device`)).json();
      assert(fallback.ip.endsWith(`:${second.port}`));
    } finally {
      await second.close();
    }
    console.log('PASS: 影视发现与投屏模拟通过，错误和超时不会伪报成功或覆盖新会话');
  } finally {
    if (release) release();
    await app.close();
    sender.closeAllConnections?.();
    await new Promise((resolve) => sender.close(resolve));
  }
}

verifyTvbox().catch((error) => { console.error(error); process.exitCode = 1; });
