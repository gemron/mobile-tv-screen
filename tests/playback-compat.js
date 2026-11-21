const assert=require('assert/strict');const http=require('http');
const catalog=require('../src/content/catalog');const {resolvePlayback,variants}=require('../src/content/playback');
async function run(){
  let base,playerCalls=0,parserCalls=0;const seen=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;const url=new URL(req.url,base);seen.push({path:url.pathname,query:url.searchParams,method:req.method,body,headers:req.headers});res.setHeader('Content-Type','application/json');
    if(url.pathname==='/x/player/playurl'){playerCalls++;res.end(JSON.stringify({code:0,data:{durl:[{url:base+'/media.mp4'}]}}));return;}
    if(url.pathname==='/parse'){parserCalls++;assert.equal(url.searchParams.get('url'),base+'/media.mp4');res.end(JSON.stringify({url:base+'/parsed.m3u8',ua:'ParsedPlayer/1',referer:'https://player.example/'}));return;}
    if(url.pathname==='/multi'){res.end(JSON.stringify({url:['SD',base+'/sd.mp4','HD',base+'/hd.mp4']}));return;}
    if(url.pathname==='/opaque'){res.setHeader('Content-Type','application/octet-stream');res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXTINF:6,\nsegment.ts\n#EXT-X-ENDLIST');return;}
    if(url.pathname==='/opaque-mkv'){res.setHeader('Content-Type','application/octet-stream');res.end(Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3,0x93,0x42,0x82,0x88]),Buffer.from('matroska')]));return;}
    if(url.pathname==='/opaque-webm'){res.setHeader('Content-Type','application/octet-stream');res.end(Buffer.concat([Buffer.from([0x1a,0x45,0xdf,0xa3,0x8f,0x42,0x82,0x84]),Buffer.from('webm')]));return;}
    if(url.pathname==='/framed'){res.setHeader('Content-Type','text/html');res.end('<iframe src="'+base+'/frame?url='+encodeURIComponent(base+'/media.mp4')+'"></iframe>');return;}
    if(url.pathname==='/json-prefix'){assert.equal(url.searchParams.get('url'),'opaque-title');res.end(JSON.stringify({data:{url:base+'/prefix.m3u8',header:JSON.stringify({UA:'PrefixPlayer/1'})}}));return;}
    if(url.pathname==='/xml'){assert.equal(url.searchParams.get('ac'),'videolist');res.setHeader('Content-Type','text/xml');res.end('<rss><list page="1" pagecount="2"><video><id>1</id><name>XML fixture</name><dl><dd flag="main">One$'+base+'/a.mp4</dd></dl></video></list></rss>');return;}
    if(url.pathname==='/api4'){
      if(url.searchParams.has('play')){res.end(JSON.stringify({url:{values:[{n:'SD',v:base+'/sd.mp4'},{n:'HD',v:base+'/hd.mp4'}],position:1},parse:0,format:'mp4',header:'{"UA":"NativePlayer/1"}'}));return;}
      res.end(JSON.stringify({class:[{type_id:'1',type_name:'Movies'}],list:[{vod_id:'1',vod_name:'HTTP fixture',vod_play_from:'main',vod_play_url:'One$opaque-title'}]}));return;
    }
    res.statusCode=404;res.end('{}');
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  try{
    const site={api:base,headers:{'user-agent':'Fixture/1'}},episode={id:Buffer.from(JSON.stringify({aid:1,cid:2})).toString('base64url')},bili=catalog.describeSite({api:'csp_BiliGuard',type:3,ext:{apiUrl:base}},base,0);
    const result=await catalog.resolve(bili,{name:'main'},episode,[{key:'json',type:1,url:base+'/parse?url=',headers:{}}],'json');
    assert.equal(playerCalls,1,'Manual parser still executes the native site player first');assert.equal(parserCalls,1);assert.equal(result.url,base+'/parsed.m3u8');assert.equal(result.headers['user-agent'],'ParsedPlayer/1');assert.equal(result.headers.referer,'https://player.example/');
    await assert.rejects(catalog.resolve(bili,{name:'main'},episode,[{key:'jar',type:2,url:base+'/never',headers:{}}],'jar'),/Android/);
    const prefixed=await resolvePlayback(site,{url:'opaque-title',playUrl:'json:'+base+'/json-prefix?url=',parse:1});assert.equal(prefixed.url,base+'/prefix.m3u8');assert.equal(prefixed.headers['user-agent'],'PrefixPlayer/1');
    const auto=await resolvePlayback({...site,parseFlags:['vip']},{url:base+'/media.mp4',jx:1},{parsers:[{key:'auto',type:1,url:base+'/parse?url=',flags:['vip']}],flag:'vip'});assert.equal(auto.url,base+'/parsed.m3u8');
    const named=await resolvePlayback(site,{url:base+'/media.mp4',playUrl:'parse:Named',parse:1},{parsers:[{key:'named',name:'Named',type:1,url:base+'/parse?url='}]});assert.equal(named.url,base+'/parsed.m3u8');
    const multi=await resolvePlayback(site,{url:base+'/media.mp4'},{parsers:[{key:'multi',type:1,url:base+'/multi?url='}],parserKey:'multi',quality:1});assert.equal(multi.url,base+'/hd.mp4');assert.deepEqual(multi.qualities,['SD','HD']);assert.equal(multi.quality,1);
    const extensionless=await resolvePlayback(site,{url:base+'/opaque',parse:0});assert.equal(extensionless.mimeType,'application/vnd.apple.mpegurl');
    assert.equal((await resolvePlayback(site,{url:base+'/movie.mkv',parse:0})).mimeType,'video/x-matroska');
    assert.equal((await resolvePlayback(site,{url:base+'/opaque-mkv',parse:0})).mimeType,'video/x-matroska');
    assert.equal((await resolvePlayback(site,{url:base+'/opaque-webm',parse:0})).mimeType,'video/webm');
    assert.equal((await resolvePlayback(site,{url:'/api/library/torrent/deadbeef/0/stream.mkv',localUrl:true,parse:0})).mimeType,'video/x-matroska');
    const framed=await resolvePlayback(site,{url:base+'/framed',parse:1});assert.equal(framed.headers.referer,base+'/');assert.equal(framed.headers.origin,base,'Embedded media inherits the player frame origin rather than the catalog page');
    const api=catalog.describeSite({api:base+'/api4',type:4,ext:'{"fixture":true}'},base,0);await catalog.category(api,{id:'1',filters:{area:'CN',year:'2026'}});const request=seen.find(r=>r.path==='/api4');assert.equal(request.query.get('extend'),'{"fixture":true}');assert.deepEqual(JSON.parse(Buffer.from(request.query.get('ext'),'base64url').toString()),{area:'CN',year:'2026'});
    const played=await catalog.resolve(api,{name:'main'},{id:'opaque-title'},[],'');assert.equal(played.url,base+'/hd.mp4');assert.equal(played.headers['user-agent'],'NativePlayer/1');assert.equal(played.mimeType,'video/mp4');assert.deepEqual(played.qualities,['SD','HD']);
    const xml=catalog.describeSite({api:base+'/xml',type:0},base,0);assert.equal((await catalog.detail(xml,'1')).title,'XML fixture');
    const long=catalog.describeSite({api:base+'/api4?token=preserved',type:4,ext:'x'.repeat(1500)},base,0);await catalog.home(long);const posted=seen.find(r=>r.path==='/api4'&&r.method==='POST');assert.equal(posted.query.get('token'),'preserved');assert.equal(new URLSearchParams(posted.body).get('extend'),'x'.repeat(1500));
    const one=catalog.describeSite({api:base+'/api4',type:1},base,0);await catalog.category(one,{id:'1',filters:{year:'2026'}});assert.equal(seen.at(-1).query.get('f'),'{"year":"2026"}');
    assert.equal(variants(['Only']).values.length,0);await assert.rejects(resolvePlayback(site,{url:{values:[{n:'A',v:base+'/a.mp4'}],position:99}}),/画质/);
    console.log('PASS: 5.8.8-compatible native-before-parser flow, web/JSON types, prefixes, flags, headers, rendition selection, extensionless HLS, XML actions and HTTP API extensions');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
