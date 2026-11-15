// Native fMP4 may show only ~2s in Chromium even with a fast source. Verify that
// playable output is still prepared in a bounded receiver reserve during that wait.
const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),{execFileSync}=require('child_process');
const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV remux reserve '));process.env.MOBILETV_DATA_DIR=path.join(sandbox,'data');
const {createAppServer}=require('../src/server'),castState=require('../src/services/castState'),{browserDriver}=require('./browser-driver');let receiver,browser;
(async()=>{
  const file=path.join(sandbox,'long-gop.mkv');
  execFileSync('ffmpeg',['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=960x540:rate=24:duration=65','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=65','-c:v','libx264','-preset','ultrafast','-b:v','5M','-g','240','-sc_threshold','0','-c:a','eac3','-b:a','128k',file],{windowsHide:true,timeout:60000});
  receiver=await createAppServer({port:0,enableDlna:false,enableAirplay:false,enableTvbox:false,enableBilibiliCast:false,dataDir:path.join(sandbox,'data')});
  let offline=false;receiver.app.get('/reserve-fixture',(req,res)=>{if(offline)res.status(503).end('Synthetic outage');else res.sendFile(file);});
  const base='http://127.0.0.1:'+receiver.port,status=()=>fetch(base+'/api/status').then(r=>r.json());
  const chrome=process.argv.includes('--chrome');
  browser=await browserDriver(path.join(sandbox,'browser'),chrome?{gpu:true,executablePath:path.join(process.env.ProgramFiles||'C:\\Program Files','Google/Chrome/Application/chrome.exe')} : {});await browser.navigate(base);await browser.wait('window.MobileTVPlayerState');
  castState.setMedia({url:base+'/reserve-fixture',protocol:'Library',mediaType:'video',metadata:{title:'Synthetic remux reserve',mimeType:'video/x-matroska',duration:65},autoPlay:true});
  await browser.wait('tvVideo.videoWidth===960 && tvVideo.currentTime>1 && !tvVideo.paused',30000);
  const deadline=Date.now()+20000;let stats;do{stats=(await status()).remuxBuffer;if(stats.bytes>=8*1048576)break;await new Promise(r=>setTimeout(r,100));}while(Date.now()<deadline);
  assert.ok(stats.bytes>=8*1048576,'FFmpeg keeps preparing more than the native browser buffer');assert.ok(stats.bytes<=stats.maxBytes+65536);assert.equal(stats.streams,1);
  await browser.wait('!document.getElementById("metricRemux").hidden && document.getElementById("metricRemux").textContent.includes("封装后缓存")');
  await browser.evaluate('tvVideo.muted=true;window.reserveWaits=0;tvVideo.addEventListener("waiting",()=>reserveWaits++);window.reserveSample={time:tvVideo.currentTime,wall:performance.now(),waits:reserveWaits,ahead:tvVideo.buffered.length?tvVideo.buffered.end(tvVideo.buffered.length-1)-tvVideo.currentTime:0}');
  offline=true;assert.equal((await fetch(base+'/reserve-fixture')).status,503);
  await browser.wait('performance.now()-reserveSample.wall>=8000',12000);
  const result=await browser.evaluate('({advanced:tvVideo.currentTime-reserveSample.time,waiting:reserveWaits-reserveSample.waits,nativeAhead:reserveSample.ahead,width:tvVideo.videoWidth,error:tvVideo.error?.code||0})');
  assert.ok(result.advanced>=7);assert.equal(result.waiting,0);assert.equal(result.error,0);
  console.log(JSON.stringify({test:'prepared remux survives unavailable origin',...result,readyMiB:stats.bytes/1048576,maxMiB:stats.maxBytes/1048576}));
  offline=false;castState.seek(30,'Test');await browser.wait('tvVideo.currentSrc.includes("start=30") && tvVideo.currentTime>1 && !tvVideo.paused',30000);
  assert.equal((await status()).remuxBuffer.streams,1,'Seeking removes the old reserve');
  await browser.click('#playerOptions summary');await browser.screenshot(path.resolve('data/ui-previews/remux-ready-buffer.png'));
  castState.stop('Test');await browser.wait('!document.body.classList.contains("casting-active")');
  for(let i=0;i<40&&(await status()).remuxBuffer.active;i++)await new Promise(r=>setTimeout(r,50));assert.equal((await status()).remuxBuffer.active,false);
  console.log('PASS: real Edge remux prefetch, origin outage, telemetry, seek replacement and stop cleanup');
})().catch(error=>{console.error(error.stack||error);process.exitCode=1;}).finally(async()=>{await browser?.close();await receiver?.close();const target=fs.realpathSync(sandbox);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(target).startsWith('MobileTV remux reserve '));fs.rmSync(target,{recursive:true,force:true,maxRetries:8,retryDelay:200});});
