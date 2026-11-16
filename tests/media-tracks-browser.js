const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{execFileSync}=require('child_process');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV tracks browser '));process.env.MOBILETV_DATA_DIR=path.join(dir,'data');
const {createAppServer}=require('../src/server'),state=require('../src/services/castState'),{browserDriver}=require('./browser-driver');let receiver,browser;
(async()=>{
 const sub=path.join(dir,'sub.srt'),file=path.join(dir,'multi.mp4');fs.writeFileSync(sub,'1\n00:00:00,000 --> 00:00:15,000\n内置字幕画面\n\n2\n00:02:05,000 --> 00:02:15,000\n跳转字幕画面\n');
 execFileSync('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=10:duration=160','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=160','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=160','-i',sub,'-map','0:v','-map','1:a','-map','2:a','-map','3:s','-map','3:s','-map','3:s','-c:v','libx264','-preset','ultrafast','-g','20','-c:a:0','ac3','-ac:a:0','6','-c:a:1','aac','-c:s','mov_text','-metadata:s:a:0','language=jpn','-metadata:s:a:1','language=eng','-metadata:s:s:0','language=zho','-metadata:s:s:0','title=中文（简体）','-metadata:s:s:1','language=eng','-metadata:s:s:2','language=chi','-metadata:s:s:2','title=中文（繁体）','-movflags','+faststart',file],{windowsHide:true,timeout:30000});
 receiver=await createAppServer({port:0,enableDlna:false,enableAirplay:false,enableTvbox:false,enableBilibiliCast:false,dataDir:path.join(dir,'data')});receiver.app.get('/fixture.mp4',(req,res)=>res.sendFile(file));
 const base='http://127.0.0.1:'+receiver.port;browser=await browserDriver(path.join(dir,'browser'),{gpu:true,media:true,executablePath:path.join(process.env.ProgramFiles||'C:\\Program Files','Google/Chrome/Application/chrome.exe')});await browser.navigate(base);await browser.wait('window.MobileTVPlayerState');
 state.setMedia({url:base+'/fixture.mp4',protocol:'Library',mediaType:'video',metadata:{title:'Tracks browser fixture',mimeType:'video/mp4',duration:160},autoPlay:true});
 await browser.wait('tvVideo.currentTime>1');await browser.click('#playerOptions summary');await browser.click('#mediaTracksRead');await browser.wait('mediaAudioTrack.options.length===3 && !mediaAudioTrack.disabled');
 assert.ok((await browser.evaluate('mediaAudioTrack.options[1].textContent')).includes('日语'));
 const before=await browser.evaluate('MobileTVPlaybackPosition()');await browser.evaluate('mediaAudioTrack.value="1";mediaAudioTrack.dispatchEvent(new Event("change"))');
 await browser.wait('tvVideo.src.includes("audioTrack=1") && tvVideo.currentTime>1 && !tvVideo.paused');assert.ok(await browser.evaluate('MobileTVPlaybackPosition()')>=before-1,'Audio changes preserve the absolute playback position');
 await browser.click('#btnSubtitles');await browser.wait('document.querySelectorAll("#subtitleEmbedded button").length===3');
 for(const [width,height]of [[1440,900],[1280,720],[870,850],[600,700],[390,844]]){
   await browser.viewport(width,height);const box=await browser.evaluate(`(()=>{const e=subtitleDialog,r=e.getBoundingClientRect();return {x:r.left,right:r.right,y:r.top,bottom:r.bottom,overflow:e.scrollHeight-e.clientHeight,horizontal:e.scrollWidth-e.clientWidth,columns:getComputedStyle(document.querySelector('.subtitle-layout')).gridTemplateColumns,background:getComputedStyle(e).backgroundColor};})()`);
   assert.ok(box.x>=0&&box.y>=0&&box.right<=width+1&&box.bottom<=height+1);assert.ok(box.horizontal<=1);if(width>=870)assert.ok(box.overflow<=1,'Desktop subtitle controls fit in one screen');console.log(JSON.stringify({viewport:[width,height],...box}));
   if(width===1440)await browser.screenshot(path.resolve('data/ui-previews/subtitle-compact-dialog.png'));
 }
 await browser.viewport(1440,900);
 // A cancelled or failed read must stop the spinner and automatic retry loop.
 await browser.evaluate(`window.originalSubtitleFetch=fetch;window.subtitleReadMode='delay';window.subtitleReadCount=0;window.fetch=(url,options)=>{if(String(url).includes('/api/media/subtitles')){window.subtitleReadCount++;if(subtitleReadMode==='delay')return new Promise((resolve,reject)=>options.signal.addEventListener('abort',()=>reject(new DOMException('Cancelled','AbortError')),{once:true}));if(subtitleReadMode==='error')return Promise.resolve(new Response(JSON.stringify({error:'Fixture read failed'}),{status:502}));}return originalSubtitleFetch(url,options);};`);
 await browser.click('#subtitleEmbedded button');await browser.wait('document.querySelector(".subtitle-embedded-progress").getAttribute("aria-busy")==="true"');await browser.click('#subtitleEmbeddedCancel');
 assert.equal(await browser.evaluate('document.querySelector(".subtitle-embedded-progress").getAttribute("aria-busy")'),'false');
 await browser.evaluate('tvVideo.dispatchEvent(new Event("timeupdate"));tvVideo.dispatchEvent(new Event("timeupdate"))');assert.equal(await browser.evaluate('subtitleReadCount'),1);
 await browser.evaluate('subtitleReadMode="error"');await browser.click('#subtitleEmbedded button');await browser.wait('subtitleEmbeddedStatus.textContent.includes("Fixture read failed")');
 await browser.evaluate('tvVideo.dispatchEvent(new Event("timeupdate"));tvVideo.dispatchEvent(new Event("timeupdate"))');assert.equal(await browser.evaluate('subtitleReadCount'),2);
 await browser.evaluate('subtitleReadMode="real"');await browser.click('#subtitleEmbedded button');
 await browser.wait('!subtitleDialog.open && Array.from(tvVideo.textTracks).some(t=>t.mode==="showing" && Array.from(t.activeCues||[]).some(c=>c.text.includes("内置字幕画面")))');
 await browser.screenshot(path.resolve('data/ui-previews/embedded-subtitle.png'));
 state.seek(126,'Fixture');await browser.wait('MobileTVPlaybackPosition()>126 && Array.from(tvVideo.textTracks).some(t=>Array.from(t.activeCues||[]).some(c=>c.text.includes("跳转字幕画面")))',25000);
 await browser.click('#btnSubtitles');await browser.click('#subtitleOff');assert.equal(await browser.evaluate('Array.from(tvVideo.textTracks).some(t=>t.mode==="showing")'),false);
 assert.equal(state.getSnapshot().audioTrack,1);
 console.log('PASS: real Chrome discovers audio/subtitles, selects AAC-compatible audio without losing progress, displays embedded captions after seek and turns them off');
})().catch(e=>{console.error(e.stack||e);process.exitCode=1;}).finally(async()=>{await browser?.close();await receiver?.close();const target=fs.realpathSync(dir);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(target).startsWith('MobileTV tracks browser '));fs.rmSync(target,{recursive:true,force:true,maxRetries:8,retryDelay:200});});
