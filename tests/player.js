const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');

// Run the actual TV script with browser boundaries stubbed. Inspect the URL
// handed to the media engine rather than duplicating the routing implementation.
function createPlayer({ hls = false } = {}) {
  const elements = new Map();
  const hlsSources = [];
  const hlsInstances = [];
  const sent = [];
  const timers = new Map();
  let nextTimer = 0;
  const documentEvents = {};
  let fullscreenCalls = 0;
  let socket;
  const makeElement = () => ({
    style: {},
    classList: { add() {}, remove() {}, toggle() {}, contains() { return false; } },
    listeners: {},
    currentTime: 0,
    duration: NaN,
    buffered: { length: 0 },
    loadCalls: 0,
    addEventListener(event, handler) { this.listeners[event] = handler; },
    removeAttribute(name) { delete this[name]; },
    load() { this.loadCalls++; this.currentTime = 0; this.duration = NaN; this.error = null; },
    play() { this.paused = false; return Promise.resolve(); },
    pause() { this.paused = true; },
    focus() {},
  });
  const document = {
    body: makeElement(),
    getElementById(id) {
      if (!elements.has(id)) elements.set(id, makeElement());
      return elements.get(id);
    },
    addEventListener(event, handler) { documentEvents[event] = handler; },
    querySelector() { return null; },
    documentElement: { requestFullscreen() { fullscreenCalls += 1; return Promise.resolve(); } },
  };
  class FakeWebSocket {
    static OPEN = 1;
    constructor() { socket = this; this.readyState = 1; }
    send(data) { sent.push(JSON.parse(data)); }
  }
  class FakeHls {
    static isSupported() { return true; }
    static Events = { MANIFEST_PARSED: 'manifest', LEVEL_LOADED: 'level', ERROR: 'error' };
    static ErrorTypes = { NETWORK_ERROR: 'network', MEDIA_ERROR: 'media' };
    constructor(config) { this.config = config; this.handlers = {}; this.restarts = []; this.recoveries = 0; hlsInstances.push(this); }
    loadSource(url) { hlsSources.push(url); }
    attachMedia() {}
    on(event, handler) { this.handlers[event] = handler; }
    emit(event, data) { this.handlers[event]?.(event, data); }
    startLoad(position) { this.restarts.push(position); }
    recoverMediaError() { this.recoveries++; }
    destroy() { this.destroyed = true; }
  }
  const context = vm.createContext({
    document,
    window: { addEventListener() {}, ...(hls ? { Hls: FakeHls } : {}) },
    location: new URL('http://127.0.0.1:8080/'),
    URL,
    WebSocket: FakeWebSocket,
    performance,
    setInterval() {},
    setTimeout(fn, ms) { const id = ++nextTimer; timers.set(id, { fn, ms }); return id; },
    clearTimeout(id) { timers.delete(id); },
    fetch: () => new Promise(() => {}),
  });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../public/js/tv.js'), 'utf8'), context);
  return {
    elements,
    hlsSources,
    hlsInstances,
    sent,
    runTimers(ms) { for (const [id, timer] of timers) if (timer.ms === ms) { timers.delete(id); timer.fn(); } },
    seek(position) { socket.onmessage({ data: JSON.stringify({ type: 'command', data: { type: 'seek', position } }) }); },
    get fullscreenCalls() { return fullscreenCalls; },
    press(key, options = {}) {
      const event = { key, target: {}, prevented: false, preventDefault() { this.prevented = true; }, ...options };
      documentEvents.keydown(event);
      return event;
    },
    cast(url, streamMode = 'auto', mediaType = 'video', extraState = {}) {
      socket.onmessage({ data: JSON.stringify({ type: 'state', data: {
        sessionId: 1, status: 'PLAYING', url, streamMode, mediaType, metadata: {},
        ...extraState,
      } }) });
      return elements.get(mediaType === 'image' ? 'tvImage' : 'tvVideo');
    },
  };
}

const phonePlaylist = 'http://192.168.1.50:10264/proxy/vod.m3u8?play_id=53&clip_id=1';
const hlsPlayer = createPlayer({ hls: true });
hlsPlayer.cast(phonePlaylist);
assert.strictEqual(hlsPlayer.hlsSources[0], `/api/proxy?url=${encodeURIComponent(phonePlaylist)}`,
  'HLS served by a phone without CORS must load through the receiver proxy');

for (const url of [
  'http://192.168.1.50:10264/video.mp4',
  'http://10.0.0.2/video.mp4',
  'http://172.16.0.2/video.mp4',
  'http://127.0.0.1:9000/video.mp4',
  'http://localhost:8080/video.mp4',
  'https://127.0.0.1:8080/video.mp4',
  '//192.168.1.50:10264/video.mp4',
  'https://media.example/video.mp4',
]) {
  const absoluteUrl = new URL(url, 'http://127.0.0.1:8080/').href;
  assert.strictEqual(createPlayer().cast(url).src, `/api/proxy?url=${encodeURIComponent(absoluteUrl)}`,
    `A different origin must use the proxy: ${url}`);
}

for (const url of ['/uploads/video.mp4', 'http://127.0.0.1:8080/uploads/video.mp4', 'blob:http://127.0.0.1:8080/test']) {
  assert.strictEqual(createPlayer().cast(url).src, url, 'Receiver-owned media should load directly');
}

const phoneVideo = 'http://192.168.1.50:10264/video.mp4';
assert.strictEqual(createPlayer().cast(phoneVideo, 'proxy').src, `/api/proxy?url=${encodeURIComponent(phoneVideo)}`);
assert.strictEqual(createPlayer().cast(phoneVideo, 'transcode').src, `/api/transcode?url=${encodeURIComponent(phoneVideo)}`);
const directVideo = createPlayer().cast(phoneVideo, 'direct');
assert.strictEqual(directVideo.src, phoneVideo, 'An explicit direct mode should be respected');
directVideo.listeners.error();
assert.strictEqual(directVideo.src, `/api/proxy?url=${encodeURIComponent(phoneVideo)}`,
  'A failed direct LAN stream should retry through the proxy before transcoding');

const photo = 'http://192.168.1.50:10264/photo.jpg';
assert.strictEqual(createPlayer().cast(photo, 'auto', 'image').src, `/api/proxy?url=${encodeURIComponent(photo)}`);

for (const [unit, expected] of [['seconds', 0.5], ['auto', 50]]) {
  const video = createPlayer().cast(phoneVideo, 'auto', 'video', { startPosition: 0.5, startPositionUnit: unit });
  video.duration = 100;
  video.listeners.loadedmetadata();
  assert.strictEqual(video.currentTime, expected, 'TVBox seconds and AirPlay ratios must remain distinct');
}

console.log('PASS: TV player routes phone media through the proxy and preserves direct playback for its own origin');

const keyboard = createPlayer();
const keyboardVideo = keyboard.cast(phoneVideo, 'auto', 'video', { volume: 98, duration: 100, muted: false });
const lastControl = () => keyboard.sent.filter(message => message.type === 'control').at(-1)?.data;
keyboard.press(' ');
assert.strictEqual(lastControl().action, 'pause');
let count = keyboard.sent.length;
assert.strictEqual(keyboard.press(' ', { repeat: true }).prevented, true);
assert.strictEqual(keyboard.sent.length, count, 'holding Space must not repeatedly toggle playback');
keyboardVideo.currentTime = 96;
keyboardVideo.duration = 100;
keyboard.press('ArrowRight');
assert.strictEqual(lastControl().position, 100, 'keyboard seek must respect duration');
keyboardVideo.currentTime = 3;
keyboard.press('ArrowLeft');
assert.strictEqual(lastControl().position, 0, 'keyboard seek must respect zero');
keyboard.press('ArrowUp');
assert.strictEqual(lastControl().volume, 100, 'keyboard volume must stay within bounds');
keyboard.press('m');
assert.strictEqual(lastControl().muted, true);
keyboard.press('F');
assert.strictEqual(keyboard.fullscreenCalls, 1);
count = keyboard.sent.length;
for (const key of [' ', 'k', 'm', 'f', 'ArrowLeft', 'ArrowUp']) {
  assert.strictEqual(keyboard.press(key, { target: { tagName: 'INPUT' } }).prevented, false);
  keyboard.press(key, { ctrlKey: true });
}
keyboard.press(' ', { target: { closest() { return {}; } } });
assert.strictEqual(keyboard.sent.length, count, 'typing, browser shortcuts and native control activation must remain untouched');
const idleKeyboard = createPlayer();
assert.strictEqual(idleKeyboard.press('ArrowLeft').prevented, false);
assert.strictEqual(idleKeyboard.sent.length, 0, 'playback shortcuts must not send commands while idle');
keyboardVideo.videoWidth = 1920;
keyboardVideo.videoHeight = 1080;
keyboardVideo.listeners.resize();
assert.strictEqual(keyboard.elements.get('videoResolution').textContent, '1920 × 1080');
console.log('PASS: keyboard playback, seek/volume limits, input isolation and actual video resolution');

const recovery = createPlayer({ hls: true });
const recoveryVideo = recovery.cast(phonePlaylist);
const engine = recovery.hlsInstances[0];
assert.equal(engine.config.maxBufferLength, 60);
assert.equal(engine.config.maxMaxBufferLength, 90);
engine.emit('level', { details: { live: true } });
assert.equal(engine.config.maxMaxBufferLength, 30, 'Live streams keep a shorter moving buffer');
engine.emit('level', { details: { live: false } });
assert.equal(engine.config.maxBufferLength, 60);
recoveryVideo.currentTime = 14;
recoveryVideo.listeners.error();
assert.equal(engine.destroyed, undefined, 'The HLS engine handles its own native errors');
engine.emit('error', { fatal: true, type: 'network' });
recovery.runTimers(1500);
assert.deepEqual(engine.restarts, [14], 'A bounded network recovery retains the playhead');
engine.emit('error', { fatal: true, type: 'network' });
assert.equal(engine.destroyed, true);
assert.match(recoveryVideo.src, /^\/api\/transcode\?/);
assert.match(recoveryVideo.src, /&start=14$/);
assert.equal(recovery.hlsInstances.length, 1, 'Remuxed MP4 is never handed to the HLS parser');

const mediaRecovery = createPlayer({ hls: true });
const brokenVideo = mediaRecovery.cast(phonePlaylist);
brokenVideo.error = { code: 3 };
const brokenEngine = mediaRecovery.hlsInstances[0];
brokenEngine.emit('error', { fatal: true, type: 'media' });
assert.equal(brokenEngine.recoveries, 1);
brokenEngine.emit('error', { fatal: true, type: 'media' });
assert.equal(brokenEngine.destroyed, true, 'Repeated decoding errors do not loop forever');

const fallback = createPlayer();
const fallbackVideo = fallback.cast(phoneVideo, 'direct');
fallbackVideo.currentTime = 42.5; fallbackVideo.duration = 100;
fallbackVideo.listeners.error();
fallbackVideo.duration = 100; fallbackVideo.listeners.loadedmetadata();
assert.equal(fallbackVideo.currentTime, 42.5, 'Proxy fallback keeps playback position');
const loaded = fallbackVideo.loadCalls;
fallback.cast(phoneVideo, 'direct', 'video', { status: 'PAUSED', volume: 50 });
fallback.cast(phoneVideo, 'direct', 'video', { status: 'PLAYING', volume: 60 });
assert.equal(fallbackVideo.loadCalls, loaded, 'Pause, volume and telemetry must not reload an automatic fallback');
assert.equal(fallback.elements.get('selectStreamMode').value, 'proxy');
fallbackVideo.currentTime = 43; fallbackVideo.duration = 100;
fallbackVideo.listeners.error();
assert.match(fallbackVideo.src, /&start=43$/);
fallbackVideo.currentTime = 2; fallbackVideo.duration = 57;
fallbackVideo.listeners.playing();
const telemetry = fallback.sent.filter(message => message.type === 'player-telemetry').at(-1).data;
assert.equal(telemetry.position, 45, 'Remux telemetry keeps absolute timeline position');
assert.equal(telemetry.duration, 100);
fallback.seek(80);
assert.match(fallbackVideo.src, /&start=80$/, 'Seeking outside a remuxed buffer restarts from the requested position');
const remuxOnly = createPlayer({ hls: true });
assert.match(remuxOnly.cast(phonePlaylist, 'transcode').src, /^\/api\/transcode\?/);
assert.equal(remuxOnly.hlsSources.length, 0);
console.log('PASS: bounded HLS recovery, live/VOD buffering, stable fallback, remux routing and absolute seek position');
