const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const {parseSubtitle,subtitleZip}=require('../src/services/subtitleFormat'),{zipSubtitles}=require('./subtitle-fixture');
const {Subtitles}=require('../src/services/subtitles');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV subtitles '));process.env.MOBILETV_DATA_DIR=directory;
const {createAppServer}=require('../src/server'),castState=require('../src/services/castState');let receiver,origin;
const srt='1\n00:00:01,250 --> 00:00:03,000\n你好 <b>world</b>\n第二行\n\n2\n00:00:05,000 --> 00:00:07,000\n&lt;script&gt;safe&lt;/script&gt;\n';
(async()=>{
  const cues=parseSubtitle(Buffer.from(srt),'fixture.srt');assert.equal(cues[0].start,1.25);assert.equal(cues[0].text,'你好 world\n第二行');
  assert.equal(parseSubtitle(Buffer.concat([Buffer.from([255,254]),Buffer.from(srt,'utf16le')]),'utf16.srt')[0].text,cues[0].text);
  assert.deepEqual(parseSubtitle(Buffer.from('WEBVTT\n\ncue\n00:01.000 --> 00:02.500 position:50%\nVTT cue\n'),'test.vtt'),[{start:1,end:2.5,text:'VTT cue'}]);
  assert.deepEqual(parseSubtitle(Buffer.from('[Events]\nFormat: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text\nDialogue: 0,0:00:01.00,0:00:04.20,Default,,0,0,0,,{\\i1}你好\\Nsecond, line\n'),'test.ass'),[{start:1,end:4.2,text:'你好\nsecond, line'}]);
  assert.throws(()=>parseSubtitle(Buffer.from('<html>login</html>'),'test.srt'),/网页/);
  assert.throws(()=>parseSubtitle(Buffer.from('x'),'test.srt'),/没有识别/);
  assert.throws(()=>parseSubtitle(Buffer.alloc(4*1024*1024+1),'test.srt'),/超过/);
  const archive=zipSubtitles({'zh.srt':srt,'folder/en.vtt':'WEBVTT\n\n00:01.000 --> 00:02.000\nEnglish\n','ignore.exe':'unsafe'});
  assert.equal(subtitleZip(archive).length,2);assert.throws(()=>subtitleZip(zipSubtitles({'../escape.srt':srt})),/路径/);
  const bad=Buffer.from(archive);bad[40]^=1;assert.throws(()=>subtitleZip(bad));
  const manual='b'.repeat(32),subscription='a'.repeat(32),requests=[];let waitSearch,started;
  const request=async(address,options)=>{
    const url=new URL(address);requests.push({host:url.host,authorization:options.headers?.authorization,urlToken:url.searchParams.has('token')});
    if(url.hostname==='api-shoulei-ssl.xunlei.com'){assert.equal(options.headers.authorization,undefined);return {text:JSON.stringify({code:0,data:[{name:'免费中文字幕.srt',url:'https://files.test/free.srt',ext:'srt',languages:['简体']},{name:'Unsupported.exe',url:'https://files.test/ignore.exe',ext:'exe'}]})};}
    if(url.hostname==='api.assrt.test'){
      assert.equal(url.searchParams.has('token'),false);assert.match(options.headers.authorization,/^Bearer [ab]{32}$/);
      if(url.pathname.endsWith('/search')){if(url.searchParams.get('q')==='quota fixture')return {text:JSON.stringify({status:30900})};if(url.searchParams.get('q')==='slow fixture'){started?.();await new Promise(resolve=>{waitSearch=resolve;});}return {text:JSON.stringify({status:0,sub:{subs:[{id:123456,native_name:'Fixture 字幕',lang:{desc:'中英'},subtype:'SRT'}]}})};}
      return {text:JSON.stringify({status:0,sub:{subs:[{id:123456,filelist:[{f:'中文.srt',url:'https://files.test/test.srt'},{f:'多文件.zip',url:'https://files.test/test.zip'}]}]}})};
    }
    if(url.hostname==='files.test')assert.equal(options.headers.authorization,undefined);
    return {body:url.pathname.endsWith('.zip')?archive:Buffer.from(srt)};
  };
  receiver=await createAppServer({port:0,enableDlna:false,enableAirplay:false,enableTvbox:false,enableBilibiliCast:false,dataDir:directory,subtitlesRequest:request,subtitlesApiBase:'https://api.assrt.test/'});
  const base='http://127.0.0.1:'+receiver.port,call=async(route,body)=>{const response=await fetch(base+'/api/subtitles/'+route,body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});return {status:response.status,...await response.json()};};
  const service=new Subtitles({dataDir:directory,request,apiBase:'https://api.assrt.test/'});service.setSubscriptionToken(subscription);assert.equal(service.config().tokenSource,'subscription');assert.ok(!JSON.stringify(service.config()).includes(subscription));service.configure(manual);assert.equal(service.config().tokenSource,'manual');assert.equal(service.effectiveToken(),manual);service.configure('');assert.equal(service.effectiveToken(),subscription);
  assert.equal((await call('config')).configured,false);assert.equal((await call('config',{token:'invalid'})).status,400);
  const session=castState.setMedia({url:'https://movie.test/movie.mp4',protocol:'Library',mediaType:'video',autoPlay:false,metadata:{title:'Subtitle fixture'}}).sessionId;
  const free=await call('search',{sessionId:session,keyword:'fixture'});assert.equal(free.status,200);assert.equal(free.provider,'迅雷字幕');assert.equal(free.items.length,1);assert.match(free.items[0].id,/^thunder:/);assert.ok(!JSON.stringify(free).includes('files.test'));
  const freeDetail=await call('detail',{sessionId:session,id:free.items[0].id});assert.equal(freeDetail.files.length,1);assert.equal((await call('load',{sessionId:session,id:freeDetail.files[0].id})).cues[0].text,cues[0].text);
  const cfg=await call('config',{token:manual});assert.equal(cfg.configured,true);assert.ok(!JSON.stringify(cfg).includes(manual));
  assert.equal((await call('detail',{sessionId:session,id:free.items[0].id})).status,410,'Changing search credentials invalidates old free result handles');
  const fallback=await call('search',{sessionId:session,keyword:'quota fixture'});assert.equal(fallback.provider,'迅雷字幕');assert.match(fallback.notice,/Assrt/);
  const found=await call('search',{sessionId:session,keyword:'fixture'});assert.equal(found.items.length,1);assert.equal(found.items[0].lang,'中英');
  const before=requests.length;await call('search',{sessionId:session,keyword:'fixture'});assert.equal(requests.length,before,'search uses a bounded cache');
  const detail=await call('detail',{sessionId:session,id:123456});assert.equal(detail.files.length,2);assert.ok(!JSON.stringify(detail).includes('files.test'));
  const loaded=await call('load',{sessionId:session,id:detail.files[0].id});assert.equal(loaded.cues[0].text,cues[0].text);
  const unpacked=await call('load',{sessionId:session,id:detail.files[1].id});assert.equal(unpacked.files.length,2);
  const unpackedFile=await call('load',{sessionId:session,id:unpacked.files[1].id});assert.equal(unpackedFile.cues[0].text,'English');
  const form=new FormData();form.set('sessionId',String(session));form.set('file',new Blob([srt]),'local.srt');const uploaded=await fetch(base+'/api/subtitles/upload',{method:'POST',body:form});assert.equal(uploaded.status,200);assert.equal((await uploaded.json()).cues[0].start,1.25);
  const source=service.setSources(session,[{name:'Source',url:'https://other.test/sub.srt'}],'https://movie.test/','https://movie.test/movie.mp4',{cookie:'private',authorization:'private'});await service.load(source[0].id);assert.equal(requests.at(-1).authorization,undefined,'media credentials do not leak to another subtitle host');
  const library=receiver.app._router.stack.find(layer=>layer.handle?.library).handle.library;
  origin=http.createServer((req,res)=>{const url=new URL(req.url,'http://fixture');res.setHeader('content-type','application/json');res.end(JSON.stringify(url.searchParams.has('play')?{url:'https://movie.test/movie.mp4',subs:[{name:'Source 中文',url:'https://files.test/test.srt',lang:'zh'}],parse:0}:{list:[{vod_id:'1',vod_name:'CMS Subtitle',vod_play_from:'main',vod_play_url:'One$opaque'}]}));});await new Promise(r=>origin.listen(0,'127.0.0.1',r));
  const api='http://127.0.0.1:'+origin.address().port;library.apply({sites:[{key:'fixture',type:4,api}],assrt:subscription},api);await call('config',{token:''});assert.equal((await call('config')).tokenSource,'subscription');
  const played=await library.play({siteKey:'fixture',vodId:'1'}),listed=await call('list?sessionId='+played.state.sessionId);assert.equal(listed.files[0].name,'Source 中文');
  const gate=new Promise(resolve=>{started=resolve;}),late=call('search',{sessionId:played.state.sessionId,keyword:'slow fixture'});await gate;castState.stop('Test');waitSearch();assert.equal((await late).status,409);
  assert.equal((await call('load',{sessionId:session,id:detail.files[0].id})).status,409);
  assert.ok(!JSON.stringify(castState.getLogs()).includes(manual));assert.ok(requests.every(row=>!row.urlToken));
  console.log('PASS: subtitle text/encoding/ZIP parsing, Assrt search/detail/load, subscription fallback, private tokens, source tracks, upload, cache, credential isolation and stale-session cancellation');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await receiver?.close();origin?.closeAllConnections();if(origin)await new Promise(r=>origin.close(r));const target=fs.realpathSync(directory);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(target).startsWith('MobileTV subtitles '));fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});});
