const assert = require('assert');
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const castState = require('../src/services/castState');

const stoppedSession = castState.setMedia({url:'https://fixture.test/video.mp4',protocol:'Library',mediaType:'video',autoPlay:true});
castState.syncFromPlayer({sessionId:stoppedSession.sessionId,status:'PLAYING',position:4,duration:12});
castState.stop('Test');
castState.syncFromPlayer({sessionId:stoppedSession.sessionId,status:'PLAYING',position:5,duration:12});
assert.equal(castState.getSnapshot().status,'IDLE','Telemetry already in flight cannot revive playback after Stop');
assert.equal(castState.getSnapshot().position,0);
assert.equal(castState.getSnapshot().duration,0);
const timedSession=castState.setMedia({url:'https://fixture.test/video.mp4',autoPlay:false});
castState.setMediaDuration({sessionId:timedSession.sessionId-1,duration:99});assert.equal(castState.getSnapshot().duration,0,'An old probe cannot change the current movie duration');
castState.setMediaDuration({sessionId:timedSession.sessionId,duration:Infinity});assert.equal(castState.getSnapshot().duration,0);
castState.setMediaDuration({sessionId:timedSession.sessionId,duration:600});assert.equal(castState.getSnapshot().metadata.duration,600);
castState.stop('Test');

// Run the actual TV script with browser boundaries stubbed. Inspect the URL
// handed to the media engine rather than duplicating the routing implementation.
function createPlayer({ hls = false, now = () => performance.now(), origin = 'http://127.0.0.1:8080' } = {}) {
  const elements = new Map();
  const intervals = [];
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
    playCalls: 0,
    addEventListener(event, handler) { this.listeners[event] = handler; },
    removeAttribute(name) { delete this[name]; },
    load() { this.loadCalls++; this.currentTime = 0; this.duration = NaN; this.error = null; },
    play() { this.playCalls++; this.paused = false; return Promise.resolve(); },
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
    location: new URL(origin),
    URL,
    WebSocket: FakeWebSocket,
    performance: { now },
    setInterval(fn, ms) { intervals.push({ fn, ms }); },
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
    runInterval(ms) { for (const interval of intervals) if (interval.ms === ms) interval.fn(); },
    runTimers(ms) { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } },
    seek(position) { socket.onmessage({ data: JSON.stringify({ type: 'command', data: { type: 'seek', position } }) }); },
    progress(data) { socket.onmessage({ data: JSON.stringify({ type: 'progress', data }) }); },
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
const originalPlayer = createPlayer();
const originalUrl = '/api/proxy?headerContext=private&url=' + encodeURIComponent('https://dl-pc-test.drive.quark.cn/original.mp4');
const originalVideo = originalPlayer.cast(originalUrl);
assert.equal(originalVideo.playCalls, 0, 'original files build a reserve before autoplay');
originalVideo.duration = 120;
originalVideo.buffered = { length: 1, start: () => 0, end: () => 12 };
originalPlayer.runTimers(200);
assert.equal(originalVideo.playCalls, 1, 'original playback starts once the short reserve is available');
const bufferedRemux = createPlayer();
const bufferedRemuxVideo = bufferedRemux.cast(originalUrl, 'transcode', 'video', { duration: 7380 });
assert.equal(bufferedRemuxVideo.playCalls, 0, 'protected originals also build a reserve when remuxing');
bufferedRemuxVideo.readyState = 2; bufferedRemuxVideo.videoWidth = 3840;
bufferedRemuxVideo.duration = 1;
bufferedRemuxVideo.buffered = { length: 1, start: () => 0.167, end: () => 1 };
bufferedRemux.runTimers(200);
assert.equal(bufferedRemuxVideo.playCalls, 0, 'a growing fragmented MP4 duration must not be mistaken for the end of the full movie');
bufferedRemuxVideo.buffered = { length: 1, start: () => 0.167, end: () => 3 };
bufferedRemux.runTimers(200);
assert.equal(bufferedRemuxVideo.playCalls, 1, 'a small initial timestamp offset does not block a ready remux buffer');
const matroskaPlayer = createPlayer();
const matroskaVideo = matroskaPlayer.cast(originalUrl, 'auto', 'video', { metadata: { mimeType: 'video/mp4' } });
matroskaVideo.readyState = 2; matroskaVideo.videoWidth = 3840; matroskaVideo.videoHeight = 1600; matroskaVideo.duration = 7380;
matroskaPlayer.runTimers(200);
assert.equal(matroskaVideo.playCalls, 1, 'a decoded first frame can start even when the browser exposes no buffered time range before play');
let bufferClock = 0;
const metadataPlayer = createPlayer({ now: () => bufferClock });
const metadataVideo = metadataPlayer.cast(originalUrl);
metadataVideo.readyState = 1; metadataVideo.duration = 7380;
metadataPlayer.runTimers(200);
assert.equal(metadataVideo.playCalls, 0);
bufferClock = 12001; metadataPlayer.runTimers(200);
assert.equal(metadataVideo.playCalls, 1, 'metadata starts the bounded prebuffer deadline even without buffered ranges');
const missingMkvVideo = createPlayer();
const audioOnlyMkv = missingMkvVideo.cast(originalUrl, 'auto', 'video', { metadata: { mimeType: 'video/x-matroska' } });
audioOnlyMkv.videoWidth = 0; audioOnlyMkv.duration = 7380; audioOnlyMkv.listeners.loadedmetadata();
const compatibleMkv = new URL(audioOnlyMkv.src, 'http://127.0.0.1:8080');
assert.equal(compatibleMkv.pathname, '/api/transcode', 'an MKV with only its audio accepted is remuxed instead of reporting video playback');
const protectedInput = new URL(compatibleMkv.searchParams.get('url'));
assert.equal(protectedInput.pathname, '/api/proxy');
assert.equal(protectedInput.searchParams.get('headerContext'), 'private', 'MKV remux retains the protected parallel input proxy');
const lanPlayer = createPlayer({ origin: 'http://192.168.1.8:8080' });
const lanVideo = lanPlayer.cast(originalUrl, 'transcode');
lanPlayer.seek(40);
const lanInput = new URL(new URL(lanVideo.src, 'http://localhost').searchParams.get('url'));
assert.equal(lanInput.searchParams.get('seekRead'), '1', 'LAN receivers preserve the original read-ahead window during a container index probe');
assert.equal(lanInput.searchParams.get('headerContext'), 'private');
audioOnlyMkv.duration = Infinity; audioOnlyMkv.listeners.loadedmetadata();
assert.equal(missingMkvVideo.elements.get('seekSlider').max, 7380, 'remux retains the original duration for seeking');
assert.equal(audioOnlyMkv.paused, true, 'an unsupported video track cannot silently continue as audio-only playback');
assert.match(missingMkvVideo.elements.get('bufferingPill').textContent, /无法解码/);
const clockMkv = createPlayer();
const clockVideo = clockMkv.cast(originalUrl, 'auto', 'video', { metadata: { mimeType: 'video/x-matroska' } });
clockVideo.videoWidth = 3840; clockVideo.videoHeight = 1608; clockVideo.duration = 7380; clockVideo.listeners.loadedmetadata();
const clockUrl = new URL(clockVideo.src, 'http://127.0.0.1:8080');
assert.equal(clockUrl.pathname, '/api/transcode', 'MKV uses compatible packaging even when native HEVC video metadata is available');
assert.equal(clockUrl.searchParams.get('reencode'), null, '4K video is copied without scaling or re-encoding');
for (const [startPosition, startPositionUnit, expected] of [[133, 'seconds', 133], [0.5, 'auto', 3690]]) {
  const resumedMkv = createPlayer();
  const resumedVideo = resumedMkv.cast(originalUrl, 'auto', 'video', { duration: 7380, startPosition, startPositionUnit, metadata: { mimeType: 'video/x-matroska' } });
  resumedVideo.videoWidth = 3840; resumedVideo.duration = 7380; resumedVideo.listeners.loadedmetadata();
  const resumedUrl = new URL(resumedVideo.src, 'http://127.0.0.1:8080');
  assert.equal(Number(resumedUrl.searchParams.get('start')), expected, 'automatic MKV remux preserves the requested resume position before native seeking');
  resumedVideo.duration = Infinity; resumedVideo.currentTime = 2; resumedVideo.listeners.loadedmetadata();
  resumedVideo.listeners.playing();
  assert.equal(resumedMkv.sent.filter(message => message.type === 'player-telemetry').at(-1).data.position, expected + 2);
}
const joinedMkv = createPlayer();
const joinedVideo = joinedMkv.cast(originalUrl, 'transcode', 'video', { duration: 7380, position: 519, metadata: { mimeType: 'video/x-matroska' } });
assert.equal(new URL(joinedVideo.src, 'http://127.0.0.1:8080').searchParams.get('start'), '519', 'a newly opened player resumes the current session rather than replaying its original start position');
let fpsClock = 0;
const fpsPlayer = createPlayer({ now: () => fpsClock });
const fpsVideo = fpsPlayer.cast('/fixture.mp4','transcode');
fpsVideo.getVideoPlaybackQuality = () => ({ totalVideoFrames: 24, droppedVideoFrames: 5 });
fpsClock = 1000; fpsPlayer.runInterval(1000);
assert.match(fpsPlayer.elements.get('metricPerf').textContent, /FPS: 19 \| 丢帧:21%/, 'FPS counts presented frames rather than including dropped frames');
fpsVideo.readyState = 4; fpsVideo.videoWidth = 3840; fpsVideo.videoHeight = 1608; fpsVideo.listeners.playing();
const resolutionTelemetry = fpsPlayer.sent.filter(message => message.type === 'player-telemetry').at(-1).data;
assert.equal(resolutionTelemetry.videoWidth, 3840); assert.equal(resolutionTelemetry.videoHeight, 1608);
fpsPlayer.progress({ sessionId: 1, originalBuffer: { active: true, profile: '4K', bytes: 20 * 1048576, maxBytes: 256 * 1048576, targetSeconds: 180 } });
assert.match(fpsPlayer.elements.get('metricBuffer').textContent, /4K.*20 \/ 256 MB/);
assert.equal(fpsPlayer.elements.get('metricBuffer').hidden, false);
const fpsRequest=new URL(fpsVideo.src,'http://localhost').searchParams.get('requestId');
fpsPlayer.progress({sessionId:1,originalBuffer:{active:true,profile:'4K',bytes:20*1048576,maxBytes:512*1048576,contiguousAheadBytes:12*1048576,estimatedAheadSeconds:8,targetSeconds:180},remuxBuffer:{active:true,bytes:80*1048576,maxBytes:128*1048576,buffers:[{requestId:'old-request',start:0,bytes:64*1048576,maxBytes:64*1048576,ranges:[]},{requestId:fpsRequest,start:0,bytes:16*1048576,maxBytes:64*1048576,ranges:[]}]}});
assert.match(fpsPlayer.elements.get('metricRemux').textContent,/16.0 \/ 64 MB/);
assert.match(fpsPlayer.elements.get('metricBuffer').title,/连续缓存 12.0 MB.*约 8 秒/);
fpsPlayer.progress({sessionId:0,remuxBuffer:{active:false}});
assert.equal(fpsPlayer.elements.get('metricRemux').hidden,false,'stale telemetry cannot hide the active remux reserve');
fpsPlayer.progress({ sessionId: 2, originalBuffer: { active: false } });
assert.equal(fpsPlayer.elements.get('metricBuffer').hidden, false, 'stale buffer telemetry cannot hide the active session');
fpsPlayer.seek(200);
assert.equal(fpsPlayer.elements.get('metricBuffer').hidden, false, 'Replacing the output stream keeps the original-file cache readout');
fpsPlayer.cast('', 'auto', 'video', { status: 'IDLE' });
assert.equal(fpsPlayer.elements.get('metricBuffer').hidden, true);
const cancelledOriginal = createPlayer();
const stoppedOriginal = cancelledOriginal.cast(originalUrl);
cancelledOriginal.cast('', 'auto', 'video', { status: 'IDLE' });
cancelledOriginal.runTimers(200);
assert.equal(stoppedOriginal.playCalls, 0, 'a cancelled buffering task cannot restart stopped playback');
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
const tokenizedRemux=new URL(createPlayer().cast(phoneVideo,'transcode').src,'http://127.0.0.1');assert.equal(tokenizedRemux.pathname,'/api/transcode');assert.equal(tokenizedRemux.searchParams.get('url'),phoneVideo);assert.ok(tokenizedRemux.searchParams.get('requestId'));
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
const prepared=createPlayer();const remuxUrl='/api/transcode?url='+encodeURIComponent('https://fixture.test/video.m4s')+'&audioUrl='+encodeURIComponent('https://fixture.test/audio.m4s')+'&headerContext=fixture';
const preparedVideo=prepared.cast(remuxUrl,'auto','video',{duration:600,startPosition:120,startPositionUnit:'seconds'});assert.ok(preparedVideo.src.startsWith('/api/transcode?url=https%3A%2F%2Ffixture.test%2Fvideo.m4s'));assert.ok(preparedVideo.src.includes('headerContext=fixture'));assert.match(preparedVideo.src,/start=120/);
preparedVideo.duration=5;preparedVideo.currentTime=2;preparedVideo.listeners.playing();const preparedTelemetry=prepared.sent.filter(message=>message.type==='player-telemetry').at(-1).data;assert.equal(preparedTelemetry.position,122);assert.equal(preparedTelemetry.duration,600);prepared.seek(300);assert.match(preparedVideo.src,/start=300/);assert.ok(!preparedVideo.src.includes(encodeURIComponent('/api/transcode')),'Prepared DASH remux URLs are never wrapped again');
console.log('PASS: prepared DASH remux preserves original duration, absolute resume/seek and credential context');
const pendingAudio=createPlayer();pendingAudio.cast(originalUrl,'auto','video',{duration:7380,startPosition:1491.15,startPositionUnit:'seconds'});
const changedAudio=pendingAudio.cast(originalUrl,'transcode','video',{duration:7380,startPosition:1491.15,startPositionUnit:'seconds',audioTrack:0});
assert.equal(new URL(changedAudio.src,'http://127.0.0.1').searchParams.get('start'),'1491.15','Choosing a compatible audio track before metadata arrives preserves the queued resume position');
assert.equal(new URL(changedAudio.src,'http://127.0.0.1').searchParams.get('audioTrack'),'0');
console.log('PASS: early audio compatibility switches retain the pending resume position and selected track');
const timeline = createPlayer(), timelineVideo = timeline.cast('http://example.test/movie.mp4');
timelineVideo.duration = 100; timelineVideo.currentTime = 25;
timelineVideo.buffered = { length: 2, start: index => [0, 70][index], end: index => [40, 80][index] };
timelineVideo.listeners.progress();
assert.equal(timeline.elements.get('seekPlayed').style.width, '25%');
assert.ok(timeline.elements.get('seekBuffered').style.background.includes('#a2b7bc 40%'));
assert.ok(timeline.elements.get('seekBuffered').style.background.includes('transparent 70%'));
assert.match(timeline.elements.get('seekTrack').title, /15 秒/);
preparedVideo.duration = 300; preparedVideo.currentTime = 5;
preparedVideo.buffered = { length: 1, start: () => 0, end: () => 30 };
preparedVideo.listeners.progress();
assert.ok(prepared.elements.get('seekBuffered').style.background.includes('transparent 50%'), 'Remux buffered ranges include the absolute seek offset');
assert.ok(prepared.elements.get('seekBuffered').style.background.includes('#a2b7bc 55%'));
timeline.cast('', 'auto', 'video', { status: 'IDLE' });
assert.equal(timeline.elements.get('seekBuffered').style.background, 'none');
console.log('PASS: seek bar displays disjoint playable buffer ranges, remux offsets and clears old media');
const localBuffer=createPlayer();const localVideo=localBuffer.cast('/fixture.mp4','transcode','video',{duration:600,startPosition:120,startPositionUnit:'seconds'});
localVideo.currentTime=2;localVideo.buffered={length:1,start:()=>0,end:()=>4};
const firstRequest=new URL(localVideo.src,'http://localhost').searchParams.get('requestId');
localBuffer.progress({sessionId:1,remuxBuffer:{active:true,bytes:123456,maxBytes:67108864,buffers:[{requestId:firstRequest,start:120,ranges:[[0,30]],bytes:123456,maxBytes:67108864}]}});localBuffer.runInterval(1000);
assert.match(localBuffer.elements.get('metricPerf').textContent,/本机可播: 28.0s/,'Completed remux timestamps extend local availability beyond the tiny native browser range');
assert.ok(localBuffer.elements.get('seekBuffered').style.background.includes('#557e78 25%'),'The progress bar includes the true prepared-media range');
localBuffer.seek(400);const secondRequest=new URL(localVideo.src,'http://localhost').searchParams.get('requestId');assert.notEqual(firstRequest,secondRequest);
localBuffer.progress({sessionId:1,remuxBuffer:{active:true,buffers:[{requestId:firstRequest,start:120,ranges:[[0,500]]}]}});localBuffer.runInterval(1000);assert.match(localBuffer.elements.get('metricPerf').textContent,/本机可播: 4.0s/,'Late data from a previous seek cannot inflate the current buffer');
localBuffer.progress({sessionId:1,remuxBuffer:{active:true,buffers:[{requestId:secondRequest,start:400,ranges:[[0,40]]}]}});localBuffer.runInterval(1000);assert.match(localBuffer.elements.get('metricPerf').textContent,/本机可播: 40.0s/);
console.log('PASS: prepared ranges, native buffers and seek epochs produce an honest local playable duration and progress bar');
const seekReuse = createPlayer();
const seekReuseVideo = seekReuse.cast('/fixture.mp4', 'transcode', 'video', { duration: 600 });
seekReuseVideo.buffered = { length: 1, start: () => 0, end: () => 20 };
const seekReuseUrl = seekReuseVideo.src, seekReuseLoads = seekReuseVideo.loadCalls;
seekReuse.seek(12);
assert.equal(seekReuseVideo.currentTime, 12);
assert.equal(seekReuseVideo.src, seekReuseUrl, 'A seek inside native buffered data keeps the existing remux request');
assert.equal(seekReuseVideo.loadCalls, seekReuseLoads);
seekReuse.elements.get('seekSlider').value = 300;
seekReuse.elements.get('seekSlider').listeners.input();
assert.equal(seekReuse.elements.get('seekPlayed').style.width, '2%', 'The preview thumb must not paint over the buffered range');
assert.equal(seekReuseVideo.loadCalls, seekReuseLoads, 'Dragging previews the target without restarting downloads for every pointer movement');
seekReuseVideo.seekable = { length: 1, start: () => 0, end: () => 0 };
seekReuse.seek(15);
assert.equal(new URL(seekReuseVideo.src, 'http://localhost').searchParams.get('start'), '15', 'Native streaming with no seekable interval must reopen at the requested time');
seekReuse.seek(200); seekReuse.seek(40); seekReuse.seek(320);
assert.equal(new URL(seekReuseVideo.src, 'http://localhost').searchParams.get('start'), '320');
assert.equal(seekReuse.elements.get('metricRemux').hidden, true, 'A replacement seek hides the old reserve until the current request reports data');
console.log('PASS: buffered seeks reuse the stream, dragging previews without downloads, and rapid seeks retain only the latest timeline');
const unknownLength=createPlayer(),unknownVideo=unknownLength.cast('/fixture.mp4','transcode','video',{startPosition:120,startPositionUnit:'seconds'});
unknownVideo.currentTime=2;unknownVideo.duration=3.5;unknownVideo.buffered={length:1,start:()=>0,end:()=>3.5};
const unknownRequest=new URL(unknownVideo.src,'http://localhost').searchParams.get('requestId');
unknownLength.progress({sessionId:1,remuxBuffer:{active:true,buffers:[{requestId:unknownRequest,start:120,ranges:[[0,40]]}]}});unknownLength.runInterval(1000);
assert.match(unknownLength.elements.get('metricPerf').textContent,/本机可播: 38.0s/,'A growing stream duration cannot truncate completed fragments');
unknownVideo.listeners.playing();assert.equal(unknownLength.sent.filter(m=>m.type==='player-telemetry').at(-1).data.duration,0,'Partial fMP4 duration is never reported as the full movie');
const loads=unknownVideo.loadCalls;unknownLength.cast('/fixture.mp4','transcode','video',{startPosition:120,startPositionUnit:'seconds',duration:600,metadata:{duration:600}});
assert.equal(unknownVideo.loadCalls,loads,'Source duration updates do not restart playback');assert.equal(unknownLength.elements.get('seekSlider').max,600);
unknownVideo.listeners.progress();assert.ok(unknownLength.elements.get('seekBuffered').style.background.includes('#557e78 26.6667%'));
console.log('PASS: unknown source length never caps the prepared timeline; source duration updates the seek bar without reloading media');
