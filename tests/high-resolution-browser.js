// Optional GPU playback acceptance with a local 4K fixture; never reads user accounts.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { browserDriver } = require('./browser-driver');
const argument = name => process.argv[process.argv.indexOf(name) + 1];
const input = process.argv.includes('--file') ? path.resolve(argument('--file')) : null;
if (!input || !fs.existsSync(input)) throw new Error('Provide a local 4K fixture with --file <video.mp4|video.mkv>.');
const engine = process.argv.includes('--browser') ? argument('--browser') : 'chrome';
assert.ok(['chrome', 'edge'].includes(engine), 'Supported test browsers: chrome, edge');
const candidates = engine === 'chrome' ? [
  path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
  path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
] : [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
];
const executablePath = candidates.find(file => fs.existsSync(file));
assert.ok(executablePath, `The ${engine} test browser must already be installed.`);
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV 4K acceptance '));
process.env.MOBILETV_DATA_DIR = path.join(sandbox, 'data');
const { createAppServer } = require('../src/server');
const castState = require('../src/services/castState');
let receiver, browser;
(async () => {
  receiver = await createAppServer({ port: 0, enableDlna: false, enableAirplay: false, enableTvbox: false, enableBilibiliCast: false, dataDir: path.join(sandbox, 'data') });
  receiver.app.get('/high-resolution-fixture', (_, res) => res.sendFile(input));
  browser = await browserDriver(path.join(sandbox, 'browser'), { gpu: true, media: true, executablePath });
  await browser.navigate('http://127.0.0.1:' + receiver.port);
  await browser.wait('window.MobileTVPlayerState');
  castState.setMedia({ url: '/high-resolution-fixture', protocol: 'Library', mediaType: 'video', metadata: { title: 'Local 4K acceptance', mimeType: /\.mkv$/i.test(input) ? 'video/x-matroska' : 'video/mp4' }, autoPlay: true });
  await browser.wait('tvVideo.videoWidth >= 3840 && tvVideo.currentTime > 3 && !tvVideo.paused', 60000);
  await browser.evaluate(`tvVideo.muted=true;window.sample={time:tvVideo.currentTime,wall:performance.now(),frames:tvVideo.getVideoPlaybackQuality().totalVideoFrames,dropped:tvVideo.getVideoPlaybackQuality().droppedVideoFrames};window.waits=0;tvVideo.addEventListener('waiting',()=>window.waits++);`);
  await browser.wait('performance.now()-window.sample.wall >= 20000', 30000);
  const result = await browser.evaluate(`(()=>{const v=tvVideo,q=v.getVideoPlaybackQuality(),s=window.sample;return {seconds:v.currentTime-s.time,wallSeconds:(performance.now()-s.wall)/1000,width:v.videoWidth,height:v.videoHeight,frames:q.totalVideoFrames-s.frames,dropped:q.droppedVideoFrames-s.dropped,waiting:window.waits,error:v.error?.code||0}})()`);
  console.log(JSON.stringify({ browser: engine, ...result, decoder: browser.mediaProperties().map(({kVideoDecoderName,kIsPlatformVideoDecoder})=>({name:kVideoDecoderName,hardware:kIsPlatformVideoDecoder})) }, null, 2));
  assert.equal(result.error, 0);
  assert.ok(result.seconds >= result.wallSeconds - 1, '4K playback must keep advancing in real time');
  assert.equal(result.waiting, 0, 'A fully available local fixture must not underflow');
  assert.ok(result.frames >= 200, 'Measure a meaningful number of video frames');
  assert.ok(result.dropped / result.frames <= 0.05, '4K playback dropped more than 5% of frames');
  console.log('PASS: GPU 4K playback preserves resolution, advances continuously and drops at most 5% of frames');
})().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (receiver) await receiver.close();
  const target = fs.realpathSync(sandbox);
  assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(target).startsWith('MobileTV 4K acceptance '));
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
});
