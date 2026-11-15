const assert=require('assert/strict'),http=require('http');
const {createBilibiliResolver}=require('../src/content/bilibili-cast');
async function main(){let base,drm=false,received=[],commentCalls=0;
 const server=http.createServer((req,res)=>{const url=new URL(req.url,base);received.push({path:url.pathname,qn:url.searchParams.get('qn'),key:url.searchParams.get('access_key')});res.setHeader('Content-Type','application/json');
  if(url.pathname.endsWith('/view'))return res.end(JSON.stringify({code:0,data:{title:'Fixture title',pages:[{cid:2,part:'One'},{cid:3,part:'Two'}]}}));
  if(url.pathname.endsWith('/playurl'))return res.end(JSON.stringify({code:0,data:{is_drm:drm,quality:64,support_formats:[{quality:80,new_description:'1080P',need_login:true},{quality:64,description:'720P'},{quality:32,description:'480P'}],dash:{video:[{id:64,codecs:'avc1',baseUrl:base+'/720.mp4'},{id:32,codecs:'avc1',baseUrl:base+'/480.mp4'}],audio:[{baseUrl:base+'/audio.m4a',bandwidth:100}]}}}));
  if(url.pathname==='/room/v1/Room/playUrl')return res.end(JSON.stringify({code:0,data:{current_quality:4,accept_quality:[4],durl:[{url:base+'/live.m3u8'}]}}));
  if(url.pathname==='/2.xml'){commentCalls++;res.setHeader('Content-Type','text/xml');return res.end('<i><d p="1,1,25,16777215">Hello &amp; safe</d><d p="2,5,25,255">Top</d><d p="3,8,25,0">Script is unsupported</d></i>');}
  res.writeHead(404);res.end('{}');
 });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
 try{const resolve=createBilibiliResolver({apiBase:base,liveBase:base,commentBase:base,getSite:()=>({headers:{cookie:'session=fixture'}})});
  const media=await resolve({aid:1,cid:2,qn:64,accessKey:'fixture-token'});assert.equal(media.url,base+'/720.mp4');assert.equal(media.audioUrl,base+'/audio.m4a');assert.equal(media.headers.cookie,undefined);assert.equal(media.nva.curQn,64);assert.equal(media.nva.supportQnList[0].needLogin,true);assert.equal(media.episodes.length,2);assert.equal(media.title,'Fixture title');assert.equal(received.find(x=>x.path==='/x/player/playurl').key,'fixture-token');
  const low=await resolve({aid:1,cid:2,qn:32});assert.equal(low.url,base+'/480.mp4');assert.equal(low.nva.curQn,32);
  await resolve({aid:1,cid:2,epId:4});assert.ok(received.some(x=>x.path==='/pgc/player/web/playurl'));await resolve({aid:1,cid:2,epId:4,contentType:2});assert.ok(received.some(x=>x.path==='/pugv/player/web/playurl'));
  const live=await resolve({roomId:1,contentType:4});assert.equal(live.isLive,true);assert.equal(live.mimeType,'application/vnd.apple.mpegurl');
  const comments=await resolve.danmaku('2');assert.deepEqual(comments.map(x=>x.text),['Hello & safe','Top']);await resolve.danmaku('2');assert.equal(commentCalls,1);await assert.rejects(resolve.danmaku('../private'));
  drm=true;await assert.rejects(resolve({aid:1,cid:2}),/DRM/);console.log('PASS: NVA media/quality metadata, current permission limits, DASH audio, PGC/course/live routes, episode list, bounded cached XML comments and DRM rejection');
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
main().catch(error=>{console.error(error);process.exitCode=1;});
