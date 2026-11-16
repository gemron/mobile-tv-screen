const fs=require('fs'),os=require('os'),path=require('path'),assert=require('assert/strict'),{execFileSync}=require('child_process');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV embedded tracks '));process.env.MOBILETV_DATA_DIR=path.join(directory,'data');
const {createAppServer}=require('../src/server'),state=require('../src/services/castState');let receiver;
const run=(bin,args)=>execFileSync(bin,args,{windowsHide:true,maxBuffer:20*1024*1024,timeout:30000});
(async()=>{
 const file=path.join(directory,'multiple.mp4'),subs=path.join(directory,'zh.srt');
 fs.writeFileSync(subs,'1\n00:00:01,000 --> 00:00:04,000\n内置字幕测试\n\n2\n00:02:05,000 --> 00:02:08,000\n跳转后的字幕\n');
 run('ffmpeg',['-v','error','-f','lavfi','-i','color=c=blue:size=160x90:rate=10:duration=160','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=160','-f','lavfi','-i','sine=frequency=880:sample_rate=48000:duration=160','-i',subs,'-map','0:v','-map','1:a','-map','2:a','-map','3:s','-c:v','libx264','-preset','ultrafast','-c:a:0','ac3','-ac:a:0','6','-c:a:1','aac','-c:s','mov_text','-metadata:s:a:0','language=jpn','-metadata:s:a:1','language=eng','-metadata:s:s:0','language=zho','-movflags','+faststart',file]);
 receiver=await createAppServer({port:0,enableDlna:false,enableAirplay:false,enableTvbox:false,enableBilibiliCast:false,dataDir:path.join(directory,'data')});
 receiver.app.get('/track-fixture.mp4',(req,res)=>res.sendFile(file));
 const base='http://127.0.0.1:'+receiver.port,snap=state.setMedia({url:base+'/track-fixture.mp4',protocol:'Library',mediaType:'video',metadata:{title:'Embedded track fixture',mimeType:'video/mp4'},autoPlay:false});
 const response=await fetch(base+'/api/media/tracks?sessionId='+snap.sessionId);const tracks=await response.json();assert.equal(response.status,200,JSON.stringify(tracks));assert.equal(tracks.audio.length,2);assert.equal(tracks.audio[0].codec,'ac3');assert.equal(tracks.audio[0].channels,6);assert.equal(tracks.audio[0].language,'jpn');assert.equal(tracks.audio[1].language,'eng');assert.equal(tracks.subtitles[0].kind,'text');
 const subtitle=async position=>{const r=await fetch(base+'/api/media/subtitles',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:snap.sessionId,index:tracks.subtitles[0].index,position})});const body=await r.json();assert.equal(r.status,200,JSON.stringify(body));return body;};
 assert.ok(Math.abs(tracks.duration-160)<.1);assert.equal(state.getSnapshot().metadata.duration,tracks.duration,'The source container supplies the whole movie duration independently of growing remux output');
 const first=await subtitle(0);assert.ok(first.cues.some(c=>c.text.includes('内置字幕测试')&&Math.abs(c.start-1)<.05));
 const seek=await subtitle(124);assert.equal(seek.from,120);assert.ok(seek.cues.some(c=>c.text.includes('跳转后的字幕')&&Math.abs(c.start-125)<.05),'Embedded cues retain absolute timestamps after seeking');
 const remux=await fetch(base+'/api/transcode?'+new URLSearchParams({url:base+'/track-fixture.mp4',audioTrack:'1',start:'123'}));assert.equal(remux.status,200);const output=path.join(directory,'selected.mp4');fs.writeFileSync(output,Buffer.from(await remux.arrayBuffer()));
 const encoded=JSON.parse(run('ffprobe',['-v','error','-show_entries','stream=codec_name,codec_type,channels','-of','json',output]));assert.equal(encoded.streams.find(s=>s.codec_type==='audio').codec_name,'aac');assert.equal(encoded.streams.find(s=>s.codec_type==='audio').channels,2);assert.equal(encoded.streams.find(s=>s.codec_type==='video').codec_name,'h264');
 const pcm=run('ffmpeg',['-v','error','-i',output,'-map','0:a:0','-ac','1','-ar','8000','-f','f32le','pipe:1']);const samples=Array.from({length:Math.min(8000,pcm.length/4)},(_,i)=>pcm.readFloatLE(i*4));
 const power=f=>{let a=0,b=0;for(let i=0;i<samples.length;i++){a+=samples[i]*Math.cos(2*Math.PI*f*i/8000);b+=samples[i]*Math.sin(2*Math.PI*f*i/8000);}return a*a+b*b;};assert.ok(power(880)>power(440)*20,'The selected second audio track is actually encoded, not merely relabeled');
 assert.equal((await fetch(base+'/api/media/tracks?sessionId='+(snap.sessionId-1))).status,409);
 const indexedFile=path.join(directory,'indexed.mkv');
 run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=320x180:rate=24:duration=8','-i',subs,'-map','0:v','-map','1:s','-c:v','libx264','-preset','ultrafast','-b:v','12M','-minrate','12M','-maxrate','12M','-bufsize','12M','-x264-params','nal-hrd=cbr:filler=1','-c:s','srt',indexedFile]);
 receiver.app.get('/indexed.mkv',(req,res)=>res.sendFile(indexedFile));
 const {RangeReader,indexedSubtitles}=require('../src/services/matroskaSubtitles'),{openUpstreamStream}=require('../src/services/proxy');
 const reader=new RangeReader({url:base+'/indexed.mkv',headers:{}},openUpstreamStream,AbortSignal.timeout(15000));
 try {
   const first=await indexedSubtitles(reader,{index:1,from:0,duration:40});assert.equal(first[0].text,'内置字幕测试');assert.ok(Math.abs(first[0].start-1)<.05);
   const overlap=await indexedSubtitles(reader,{index:1,from:2,duration:40});assert.equal(overlap[0]?.text,'内置字幕测试','A subtitle beginning before the window remains visible until its real end');
   const later=await indexedSubtitles(reader,{index:1,from:120,duration:40});assert.equal(later[0].text,'跳转后的字幕');assert.ok(Math.abs(later[0].start-125)<.05);
   assert.deepEqual(await indexedSubtitles(reader,{index:1,from:50,duration:30}),[],'An indexed silent window is valid');
   assert.ok(fs.statSync(indexedFile).size>8*1024*1024);assert.ok(reader.bytes<1024*1024,'Subtitle extraction skips the high-bitrate video payload');
 }finally{reader.close();}
 const indexedState=state.setMedia({url:base+'/indexed.mkv',protocol:'Library',mediaType:'video',metadata:{title:'Indexed MKV fixture'},autoPlay:false});
 const indexedResponse=await fetch(base+'/api/media/subtitles',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({sessionId:indexedState.sessionId,index:1,position:124})});
 assert.equal(indexedResponse.status,200);const indexedResult=await indexedResponse.json();assert.equal(indexedResult.from,120);assert.equal(indexedResult.to,300);assert.ok(indexedResult.cues.some(c=>c.text==='跳转后的字幕'));
 console.log('PASS: indexed high-bitrate MKV subtitles skip video bytes, preserve absolute timing and accept windows without dialogue');
 const pgsIndex=process.argv.indexOf('--pgs');
 if(pgsIndex>=0){
  const sample=path.resolve(process.argv[pgsIndex+1]);receiver.app.get('/pgs-fixture.mkv',(req,res)=>res.sendFile(sample));
  const imageState=state.setMedia({url:base+'/pgs-fixture.mkv',protocol:'Library',mediaType:'video',metadata:{title:'PGS fixture',mimeType:'video/x-matroska'},autoPlay:false});
  const info=await fetch(base+'/api/media/tracks?sessionId='+imageState.sessionId).then(r=>r.json());assert.equal(info.subtitles[0].kind,'image');
  const burned=await fetch(base+'/api/transcode?'+new URLSearchParams({url:base+'/pgs-fixture.mkv',burnSubtitle:'0'}));assert.equal(burned.status,200);const target=path.join(directory,'pgs.mp4');fs.writeFileSync(target,Buffer.from(await burned.arrayBuffer()));
  const frame=input=>run('ffmpeg',['-v','error','-ss','1.5','-i',input,'-frames:v','1','-vf','scale=160:100','-pix_fmt','gray','-f','rawvideo','pipe:1']);const original=frame(sample),result=frame(target);assert.equal(original.length,result.length);let difference=0;for(let i=0;i<result.length;i++)difference+=Math.abs(result[i]-original[i]);assert.ok(difference/result.length>1,'PGS pixels are actually overlaid on the video');
  console.log('PASS: optional FFmpeg PGS fixture is detected and its image subtitle is rendered through explicit compatibility playback');
 }
 console.log('PASS: real container audio/subtitle discovery, AC-3 language/channels, embedded text, absolute seek timestamps, audible selected track, AAC stereo and stale-session rejection');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await receiver?.close();const target=fs.realpathSync(directory);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(target).startsWith('MobileTV embedded tracks '));fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
