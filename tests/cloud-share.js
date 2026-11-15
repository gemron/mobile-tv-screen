const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const {Cloud,encode}=require('../src/content/cloud');
const {resolvePlayback}=require('../src/content/playback'),mediaHeaders=require('../src/services/mediaHeaders'),express=require('express'),{createProxyRouter,boundedOriginalRange}=require('../src/services/proxy');
async function run(){
 const directory=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV share playback '));let base,saves=0,polls=0,failPlay=false,capacityLimited=false,proxy,originalAvailable=false,originalCalls=0,wrongOriginal=false;
 const server=http.createServer(async(req,res)=>{
  let input='';for await(const chunk of req)input+=chunk;const url=new URL(req.url,base);res.setHeader('Content-Type','application/json');
  const send=data=>res.end(JSON.stringify({code:0,data}));
  if(url.pathname.startsWith('/protected/')){
   if(req.headers.cookie!=='session=private'){res.statusCode=412;return res.end('session required');}
   if(url.pathname.endsWith('/master.m3u8')){res.setHeader('Content-Type','application/vnd.apple.mpegurl');return res.end('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=1000\nnested/child.m3u8\n');}
   if(url.pathname.endsWith('/child.m3u8')){res.setHeader('Content-Type','application/vnd.apple.mpegurl');return res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXT-X-MAP:URI="init.mp4"\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST\n');}
   res.setHeader('Content-Type','application/octet-stream');return res.end(Buffer.alloc(16,23));
  }
  if(url.pathname.endsWith('/share/sharepage/token'))return send({stoken:'fixture-share-session'});
  if(url.pathname.endsWith('/share/sharepage/detail')){assert.equal(url.searchParams.get('stoken'),'fixture-share-session');return send({list:[{fid:'selected-file',file_name:'Episode.mp4',share_fid_token:'fresh-file-token'}]});}
  if(url.pathname.endsWith('/share/sharepage/save')){
   saves++;const data=JSON.parse(input);assert.deepEqual(data.fid_list,['selected-file']);assert.deepEqual(data.fid_token_list,['fresh-file-token']);assert.equal(data.to_pdir_fid,'0');assert.equal(data.save_all,undefined);assert.equal(data.pdir_save_all,undefined);await new Promise(r=>setTimeout(r,20));return send({task_id:'fixture-task'});
  }
  if(url.pathname.endsWith('/task')){polls++;assert.equal(url.searchParams.get('task_id'),'fixture-task');if(capacityLimited){res.end(JSON.stringify({code:32003,status:403,message:'capacity limit[{0}]'}));return;}return send({status:2,save_as:{save_as_top_fids:['saved-file']}});}
  if(url.pathname.endsWith('/file/download')){originalCalls++;assert.deepEqual(JSON.parse(input).fids,['saved-file']);assert.ok(req.headers['user-agent'].includes('quark-cloud-drive/'));assert.equal(url.searchParams.get('sys'),'win32');if(!originalAvailable){res.statusCode=403;return res.end('{}');}return send([{fid:wrongOriginal?'another-file':'saved-file',file_name:'Episode.mp4',format_type:'video/mp4',download_url:base+'/original.mp4?fresh='+originalCalls}]);}
  if(url.pathname.endsWith('/file/v2/play')){assert.equal(JSON.parse(input).fid,'saved-file');if(failPlay){res.statusCode=503;return res.end('{}');}return send({video_list:[{video_info:{url:'https://cdn.example.test/movie.mp4',width:1920,height:1080}}]});}
  res.statusCode=404;res.end('{}');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 const accounts={file:path.join(directory,'cloud-accounts.json'),get:()=>({}),cookie:async()=>'',check:async()=>{}};
 const options={endpoints:{quark:base+'/cloud/'}};
 const id=encode({provider:'quark',share:'share',fid:'selected-file',parent:'0',fileToken:'fixture-file-token',name:'Episode.mp4'});
 try{
  const originalHost='https://dl-pc-zb.drive.quark.cn/original.mp4';assert.equal(boundedOriginalRange(originalHost,'context','bytes=0-'),'bytes=0-1048575');assert.equal(boundedOriginalRange(originalHost,'context','bytes=1048576-9999999'),'bytes=1048576-2097151');assert.equal(boundedOriginalRange(originalHost,'context','bytes=0-1023'),'bytes=0-1023');assert.equal(boundedOriginalRange(originalHost,'','bytes=0-'),'bytes=0-');assert.equal(boundedOriginalRange('https://dl-pc-zb.drive.quark.cn.evil.test/file','context','bytes=0-'),'bytes=0-');assert.equal(boundedOriginalRange(originalHost,'context','bytes=-8192'),'bytes=-8192');
  const cloud=new Cloud(accounts,null,options);
  await assert.rejects(cloud.saveShare(id),e=>e.status===400);assert.equal(saves,0,'Ordinary playback never silently writes to the user drive');
  const cancelled=new AbortController();cancelled.abort();await assert.rejects(cloud.saveShare(id,{consent:true,signal:cancelled.signal}));assert.equal(saves,0);
  await assert.rejects(cloud.saveShare(encode({provider:'baidu'}),{consent:true}),e=>e.status===422);
  const [a,b]=await Promise.all([cloud.saveShare(id,{consent:true}),cloud.saveShare(id,{consent:true})]);assert.deepEqual(a,b);assert.equal(saves,1,'Concurrent saves coalesce into one single-file task');assert.equal(polls,1);
  assert.equal(a.url.values[0].v,'https://cdn.example.test/movie.mp4');assert.equal(a.header.cookie,undefined);
  const restarted=new Cloud(accounts,null,options);const reused=await restarted.resolve(id);assert.equal(reused.url.values[0].v,a.url.values[0].v);assert.equal(saves,1,'Restarted playback reuses saved file references');
  failPlay=true;await assert.rejects(restarted.resolve(id));assert.equal(saves,1,'Playback errors never trigger another save');failPlay=false;
  const key=restarted.shareKey(require('../src/content/cloud').decode(id));restarted.rememberShare(key,{provider:'quark',taskId:'fixture-task'});
  const resumed=new Cloud(accounts,null,options);await resumed.saveShare(id,{consent:true});assert.equal(saves,1,'A pending task resumes without transferring a duplicate');
  resumed.rememberShare(key,{provider:'quark',taskId:'fixture-task'});capacityLimited=true;await assert.rejects(resumed.saveShare(id,{consent:true}),e=>e.capacityLimited&&e.status===409&&/空间不足/.test(e.message));assert.equal(resumed.shareSaves.has(key),false,'A failed capacity task is removed so an explicit retry can work after space is freed');assert.equal(saves,1,'Capacity failures do not automatically resubmit a save');capacityLimited=false;
  const data=fs.readFileSync(path.join(directory,'cloud-shares.json'),'utf8');assert.ok(!data.includes('fixture-file-token')&&!data.includes('fixture-share-session'),'Only task and saved-file references persist');
  restarted.rememberShare(key,{provider:'quark',fid:'saved-file'});originalAvailable=true;let raw=await restarted.resolve(id);assert.equal(raw.url.values[0].n,'原文件（原画）');assert.ok(raw.url.values[0].v.startsWith(base+'/original.mp4'));assert.equal(raw.url.values.length,2,'Original and available previews remain selectable');
  const originalPlayback=await resolvePlayback({api:'https://pan.quark.cn/',headers:{}},raw);assert.equal(originalPlayback.mimeType,'video/mp4');assert.ok(originalPlayback.url.startsWith(base+'/original.mp4'));assert.ok(originalPlayback.headers['user-agent'].includes('quark-cloud-drive/'));
  assert.equal((await resolvePlayback({api:base,headers:{}},raw,{quality:1})).url,'https://cdn.example.test/movie.mp4','Preview remains a distinct selectable rendition');
  const nextRaw=await restarted.resolve(id);assert.notEqual(nextRaw.url.values[0].v,raw.url.values[0].v,'Replaying refreshes temporary original links');
  failPlay=true;raw=await restarted.resolve(id);assert.equal(raw.url.values.length,1);assert.equal(raw.url.values[0].n,'原文件（原画）','Original playback survives a preview API failure');failPlay=false;
  wrongOriginal=true;raw=await restarted.resolve(id);assert.equal(raw.url.values.length,1);assert.ok(raw.url.values[0].n.startsWith('预览'),'A link for another file is never selected');wrongOriginal=false;originalAvailable=false;assert.equal(saves,1,'Original-link reads never save additional files');
  const authenticated=new Cloud({cookie:async()=> 'session=private',get:()=>({})},null,options),site={api:'https://pan.quark.cn/',headers:{}};
  const trusted='https://video-play-h-zb.drive.quark.cn/watch.m3u8',external='https://cdn.example.test/watch.m3u8';
  const renditions=await authenticated.mediaChoices('quark',[{url:external,width:1920,height:1080},{url:trusted,width:1280,height:720}]);
  assert.equal((await resolvePlayback(site,renditions,{quality:0})).headers.cookie,undefined,'An unrelated rendition does not receive credentials');
  const selected=await resolvePlayback(site,renditions,{quality:1});assert.equal(selected.headers.cookie,'session=private','Quark HTTPS video origins retain the required session for the selected rendition');
  for(const url of ['http://video-play-h-zb.drive.quark.cn/watch.m3u8','https://video-play-h-zb.drive.quark.cn.evil.test/watch.m3u8','https://video-play-h-zb.drive.quark.cn:9443/watch.m3u8'])assert.equal((await authenticated.mediaHeaders('quark',url)).cookie,undefined);
  assert.equal((await authenticated.mediaHeaders('uc',trusted)).cookie,undefined,'A provider cannot reuse the Quark credential exception');
  assert.equal((await authenticated.mediaHeaders('quark','https://dl-pc-zb.drive.quark.cn/original.mp4')).cookie,'session=private');
  assert.equal((await authenticated.mediaHeaders('quark','https://dl-pc-zb.drive.quark.cn.evil.test/original.mp4')).cookie,undefined);
  const context=mediaHeaders.create(selected.headers,selected.url);assert.equal(mediaHeaders.get(context,trusted+'?segment=1').cookie,'session=private');assert.equal(mediaHeaders.get(context,external).cookie,undefined,'Nested media remains restricted to the selected origin');
  const app=express(),router=createProxyRouter({dataDir:directory});app.use('/api',router);proxy=http.createServer(app);await new Promise(r=>proxy.listen(0,'127.0.0.1',r));const proxyBase='http://127.0.0.1:'+proxy.address().port;
  assert.equal((await fetch(base+'/protected/master.m3u8')).status,412);
  const playable=await resolvePlayback(site,await authenticated.mediaChoices('quark',[{url:base+'/protected/master.m3u8'}]));
  const master=await(await fetch(new URL(mediaHeaders.mediaUrl(playable.url,playable.headers,'',playable.mimeType),proxyBase))).text();assert.ok(master.startsWith('#EXTM3U'));
  const child=await(await fetch(new URL(master.split('\n').find(line=>line&&!line.startsWith('#')),proxyBase))).text();assert.ok(child.startsWith('#EXTM3U'));
  const resources=[...child.matchAll(/URI="([^"]+)"/g)].map(match=>match[1]).concat(child.split('\n').filter(line=>line&&!line.startsWith('#')));
  assert.equal(resources.length,3);for(const resource of resources){const response=await fetch(new URL(resource,proxyBase));assert.equal(response.status,200);assert.equal((await response.arrayBuffer()).byteLength,16);}
  await router.adFilter.close();
  console.log('PASS: explicit single-file consent, task reuse, scoped Quark media authentication, per-rendition credentials, nested HLS playlist/key/init/segment playback and no secret persistence');
 }finally{if(proxy){proxy.closeAllConnections();await new Promise(r=>proxy.close(r));}server.closeAllConnections();await new Promise(r=>server.close(r));const target=fs.realpathSync(directory);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(target).startsWith('MobileTV share playback '));fs.rmSync(target,{recursive:true,force:true});}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
