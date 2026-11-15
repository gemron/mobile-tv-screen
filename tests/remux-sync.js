// Measure actual flash/beep timing after remuxing, including non-keyframe seeks.
const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV remux sync '));
process.env.MOBILETV_DATA_DIR = path.join(sandbox, 'data');
const { createAppServer } = require('../src/server');
let receiver, browser;
const ffmpeg = args => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', ...args], { windowsHide: true, maxBuffer: 30e6 });
function frames(file, type) {
  return JSON.parse(execFileSync('ffprobe', ['-v', 'error', '-select_streams', type, '-show_frames', '-show_entries', 'frame=best_effort_timestamp_time', '-of', 'json', file], { windowsHide: true, maxBuffer: 10e6 })).frames;
}
function measure(file) {
  const videoFrames = frames(file, 'v:0');
  const gray = ffmpeg(['-i', file, '-map', '0:v:0', '-vf', 'scale=1:1', '-pix_fmt', 'gray', '-fps_mode', 'passthrough', '-f', 'rawvideo', 'pipe:1']);
  assert.equal(gray.length, videoFrames.length);
  const video = [];
  for (let i = 0; i < gray.length; i++) if (gray[i] > 180 && (!i || gray[i - 1] <= 180)) video.push(Number(videoFrames[i].best_effort_timestamp_time));
  const audioStart = Number(frames(file, 'a:0')[0].best_effort_timestamp_time);
  const audio = ffmpeg(['-i', file, '-map', '0:a:0', '-ac', '1', '-ar', '48000', '-c:a', 'pcm_f32le', '-f', 'f32le', 'pipe:1']);
  const sound = []; let last = -Infinity;
  for (let i = 0; i < audio.length / 4; i++) if (Math.abs(audio.readFloatLE(i * 4)) > 0.25) {
    if (i - last > 4800) sound.push(audioStart + i / 48000);
    last = i;
  }
  // The copied track includes decoder preroll before a seek; compare the shared
  // irregular final markers, not packets that are intentionally presented < 0.
  const count = Math.min(video.length, sound.length);
  assert.ok(count >= 2, 'At least two matching markers must survive the seek');
  return video.slice(-count).map((time, i) => time - sound.slice(-count)[i]);
}
async function checkBrowser(base, streamUrl) {
  const { browserDriver } = require('./browser-driver');
  const engine = process.argv[process.argv.indexOf('--browser') + 1];
  assert.ok(['chrome', 'edge'].includes(engine));
  const executablePath = engine === 'chrome' ? path.join(process.env.ProgramFiles || 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe') : undefined;
  browser = await browserDriver(path.join(sandbox, 'browser'), { gpu: true, executablePath });
  await browser.navigate(base); await browser.wait('window.MobileTVPlayerState');
  await browser.evaluate(`(async()=>{
    const context = new AudioContext(), source = context.createMediaElementSource(tvVideo), analyser = context.createAnalyser(), gain = context.createGain();
    analyser.fftSize=512;gain.gain.value=0;source.connect(analyser);analyser.connect(gain);gain.connect(context.destination);await context.resume();
    const canvas=document.createElement('canvas');canvas.width=canvas.height=1;const drawing=canvas.getContext('2d',{willReadFrequently:true}),wave=new Float32Array(512);
    window.syncProbe={video:[],audio:[]};let bright=false,loud=false;
    function sample(){
      const now=performance.now()/1000;let white=false;if(tvVideo.readyState>=2&&tvVideo.videoWidth){drawing.drawImage(tvVideo,0,0,1,1);white=drawing.getImageData(0,0,1,1).data[0]>180;}
      analyser.getFloatTimeDomainData(wave);const sound=Math.sqrt(wave.reduce((sum,x)=>sum+x*x,0)/wave.length)>.1;
      if(white&&!bright)syncProbe.video.push(now);if(sound&&!loud)syncProbe.audio.push(now);bright=white;loud=sound;requestAnimationFrame(sample);
    }requestAnimationFrame(sample);
  })()`);
  require('../src/services/castState').setMedia({ url: streamUrl, protocol: 'Library', mediaType: 'video', metadata: { title: 'Synthetic flash/beep sync check', mimeType: 'video/mp4' }, autoPlay: true });
  await browser.wait('syncProbe.video.length>=3 && syncProbe.audio.length>=3', 30000);
  const result = await browser.evaluate('({video:syncProbe.video.slice(-3),audio:syncProbe.audio.slice(-3),error:tvVideo.error?.code||0})');
  const offsets = result.video.map((time, i) => time - result.audio[i]);
  assert.equal(result.error, 0);
  assert.ok(offsets.every(offset => Math.abs(offset) < 0.18), 'Browser flash/beep mismatch: ' + JSON.stringify(offsets));
  console.log('PASS: ' + engine + ' presents flash/beep markers together after seeking; offsets ms: ' + offsets.map(offset => Math.round(offset * 1000)).join(', '));
}
(async () => {
  const file = path.join(sandbox, 'sync.mkv');
  const condition = [2, 5, 9, 14, 20, 27].map(time => `between(t,${time},${time + 1 / 12})`).join('+');
  ffmpeg(['-f', 'lavfi', '-i', 'color=black:size=320x180:rate=24:duration=32', '-f', 'lavfi', '-i', `aevalsrc='0.8*sin(2*PI*1000*t)*(${condition})':s=48000:d=32`, '-vf', `drawbox=color=white:t=fill:enable='${condition}'`, '-c:v', 'libx265', '-preset', 'ultrafast', '-x265-params', 'log-level=error:keyint=192:min-keyint=192:scenecut=0:bframes=4', '-c:a', 'eac3', '-b:a', '128k', file]);
  assert.ok(measure(file).every(offset => Math.abs(offset) < 0.08));
  const video = path.join(sandbox, 'video.mp4'), audio = path.join(sandbox, 'audio.m4a');
  ffmpeg(['-i', file, '-map', '0:v:0', '-c', 'copy', '-movflags', '+faststart', video]);
  ffmpeg(['-i', file, '-map', '0:a:0', '-c:a', 'aac', '-b:a', '128k', audio]);
  receiver = await createAppServer({ port: 0, enableDlna: false, enableAirplay: false, enableTvbox: false, enableBilibiliCast: false, dataDir: path.join(sandbox, 'data') });
  for (const [name, source] of [['sync.mkv', file], ['video.mp4', video], ['audio.m4a', audio]]) receiver.app.get('/' + name, (_, res) => res.sendFile(source));
  const base = 'http://127.0.0.1:' + receiver.port;
  for (const [kind, start] of [['combined', 0], ['combined', 13.37], ['combined', 18.88], ['separate', 13.37]]) {
    const url = base + '/api/transcode?url=' + encodeURIComponent(base + (kind === 'separate' ? '/video.mp4' : '/sync.mkv')) + '&start=' + start + (kind === 'separate' ? '&audioUrl=' + encodeURIComponent(base + '/audio.m4a') : '');
    const response = await fetch(url); assert.equal(response.status, 200);
    const output = path.join(sandbox, kind + start + '.mp4'); fs.writeFileSync(output, Buffer.from(await response.arrayBuffer()));
    const offsets = measure(output);
    assert.ok(offsets.every(offset => Math.abs(offset) < 0.08), `${kind} seek ${start}: A/V offsets ${JSON.stringify(offsets)}`);
    if (start > 0) {
      const firstVisible = frames(output, 'v:0').map(frame => Number(frame.best_effort_timestamp_time)).find(time => time >= 0);
      assert.ok(firstVisible < 0.1, 'Decoder preroll must not shift presentation several seconds after the requested time');
    }
    console.log(`PASS: ${kind} seek ${start}s preserves flash/beep sync; max offset ${(Math.max(...offsets.map(Math.abs)) * 1000).toFixed(1)}ms`);
  }
  if (process.argv.includes('--browser')) await checkBrowser(base, base + '/api/transcode?url=' + encodeURIComponent(base + '/sync.mkv') + '&start=13.37');
})().catch(error => { console.error(error.stack); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (receiver) await receiver.close();
  const target = fs.realpathSync(sandbox);
  assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase());
  assert.ok(path.basename(target).startsWith('MobileTV remux sync '));
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 });
});
