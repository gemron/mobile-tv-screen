const assert = require('assert/strict');
const http = require('http'); const crypto = require('crypto');
const catalog = require('../src/content/catalog'); const { extract } = require('../src/content/literals');
const { Cloud, shareAddress, decode } = require('../src/content/cloud');
const protectedApps = require('../src/content/adapters/protected-apps');
const { hchacha, decrypt } = require('../src/content/adapters/audiobooks');
const { crypt } = require('../src/content/adapters/sports');
const { rc4 } = require('../src/content/format');
async function run() {
  // Published HChaCha20 test vector, draft-irtf-cfrg-xchacha-03 §2.2.1.
  const key=Buffer.from(Array.from({length:32},(_,i)=>i));
  assert.equal(hchacha(key,Buffer.from('000000090000004a0000000031415927','hex')).toString('hex'),'82413b4227b27bfed30e42508a877d73a0f9e4d58a74a853c12ec41326d3ecdc');
  const nonce=crypto.randomBytes(24),iv=Buffer.alloc(12);nonce.copy(iv,4,16);const cipher=crypto.createCipheriv('chacha20-poly1305',hchacha(key,nonce.subarray(0,16)),iv,{authTagLength:16});const body=Buffer.concat([cipher.update('{"ok":true}'),cipher.final(),cipher.getAuthTag()]);
  for(const version of [1,2])assert.equal(decrypt(Buffer.concat([Buffer.from([version]),nonce,version===2?Buffer.from(body).reverse():body]).toString('hex'),key).ok,true);
  const corrupt=Buffer.concat([Buffer.from([1]),nonce,body]);corrupt[30]^=1;assert.throws(()=>decrypt(corrupt.toString('hex'),key));
  const pair=crypto.generateKeyPairSync('rsa',{modulusLength:1024}),publicKey=pair.publicKey.export({format:'der',type:'spki'}).toString('base64'),privateKey=pair.privateKey.export({format:'der',type:'pkcs8'}).toString('base64');
  const long='fixture-'.repeat(60);assert.equal(protectedApps.rsaDecode(protectedApps.rsaEncrypt(long,publicKey),privateKey),long);
  assert.equal(crypt(crypt('{"match":123}',true),false),'{"match":123}');
  global.__untrustedExecuted=false;
  const literal=extract('const rule={host:"https://fixture.test", classes:[1,2], run(){global.__untrustedExecuted=true}, get cookie(){throw 1}, nested:(()=>{global.__untrustedExecuted=true})(), __proto__:{polluted:true}};',/const rule=/);
  assert.equal(literal.host,'https://fixture.test');assert.equal(literal.run,undefined);assert.equal(global.__untrustedExecuted,false);assert.equal({}.polluted,undefined);
  assert.equal(extract('const sources=[{apiData:{api:"https://example.test/video.mp4"}}]',/const sources=/)[0].apiData.api,'https://example.test/video.mp4');
  assert.throws(()=>shareAddress('https://evilquark.cn/s/no'));assert.equal(shareAddress('https://pan.quark.cn/s/abc?pwd=1234').password,'1234');
  let base;const seen=[];
  const server=http.createServer(async(req,res)=>{
    let input='';for await(const chunk of req)input+=chunk;const u=new URL(req.url,base);seen.push({path:u.pathname,headers:req.headers,body:input});res.setHeader('Content-Type','application/json');
    const send=data=>res.end(JSON.stringify(data));
    if(u.pathname==='/x/web-interface/search/type'){assert.equal(u.searchParams.get('keyword'),'fixture');return send({code:0,data:{result:[{bvid:'BVtest',title:'<b>Fixture</b>',pic:base+'/cover.jpg'}],numPages:2}});}
    if(u.pathname==='/x/web-interface/view')return send({code:0,data:{aid:1,bvid:'BVtest',title:'Fixture',pages:[{cid:11,part:'Part one'},{cid:12,part:'Part two'}]}});
    if(u.pathname==='/x/player/playurl')return send({code:0,data:{dash:{video:[{id:80,codecs:'hev1',baseUrl:'https://cdn.example.test/hevc'},{id:64,codecs:'avc1',baseUrl:'https://cdn.example.test/video'}],audio:[{bandwidth:100,baseUrl:'https://audio.example.test/audio'}]}}});
    if(u.pathname==='/v3/type/top_type')return send({code:1,data:{list:[{type_id:'1',type_name:'Movies'}]}});
    if(u.pathname==='/v3/home/type_search'){assert.match(req.headers['content-type'],/^multipart\/form-data/);assert.match(input,/name="sign"/);return send({code:1,data:{list:[{vod_id:'app1',vod_name:'App fixture'}]}});}
    if(u.pathname==='/api/mw-movie/anonymous/video/list'){assert.match(req.headers.sign,/^[a-f0-9]{40}$/);assert.ok(req.headers.t);assert.ok(req.headers.deviceid);return send({code:200,data:{result:{list:[{id:'jp1',vodName:'JP fixture'}]}}});}
    if(u.pathname==='/api/vod/classify/word/search.action'){const data=JSON.parse(input);assert.equal(data.data.rows,24);const raw=`os:Android|version:5.6.01|action:${u.pathname}|time:${data.time}|appToken:|privateKey:fixture-sign|data:rows=24&startRow=0&uuidList=[]&vodType=0&`;assert.equal(data.sign,crypto.createHash('md5').update(raw).digest('hex'));return send({code:0,data:[{uuid:'mdd1',name:'MDD fixture',coverImage:base+'/cover.jpg'}]});}
    if(u.pathname==='/gz/live/sports'){const data=JSON.parse(crypt(new URLSearchParams(input).get('parameter'),false));assert.equal(data.type,'1');return send({data:crypt(JSON.stringify([{mid:1,match_id:2,ball_type:1,home:{name:'A'},visiting:{name:'B'},m_status:2}]),true)});}
    if(u.pathname==='/hmys'){assert.equal(req.headers.device_id,'device-fixture');const data=JSON.stringify({code:10000,result:{ok:true}});return res.end(protectedApps.aes(Buffer.from(data),'01234567890123456789012345678901','0123456789012345',true).toString('base64'));}
    if(u.pathname.endsWith('/share/sharepage/token'))return send({code:0,data:{stoken:'share-token'}});
    if(u.pathname.endsWith('/share/sharepage/detail')){assert.equal(u.searchParams.get('stoken'),'share-token');return send({code:0,data:{list:u.searchParams.get('pdir_fid')==='0'?[{fid:'folder',file_name:'Season 1',dir:true}]:[{fid:'f2',file_name:'Episode 02.mp4',share_fid_token:'f-token'},{fid:'f1',file_name:'Episode 01.mp4',share_fid_token:'f-token'}]}});}
    if(u.pathname.endsWith('/share/sharepage/video')){assert.equal(JSON.parse(input).share_fid_token,'f-token');return send({code:0,data:{video_list:[{video_info:{width:640,height:360,url:'https://cdn.example.test/360.m3u8'}},{video_info:{width:1920,height:1080,url:'https://cdn.example.test/1080.m3u8'}}]}});}
    if(u.pathname==='/legacy')return res.end(rc4(Buffer.from('{"list":[]}'),'520720ygq').toString('hex'));
    res.statusCode=404;send({error:'fixture not found'});
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  try {
    const site=api=>catalog.describeSite({key:api,api,type:3,ext:{siteUrl:base,apiUrl:base},headers:{cookie:'private=fixture'}},base,0);
    const bili=site('csp_BiliGuard'), home=await catalog.category(bili,{keyword:'fixture'});assert.equal(home.list[0].title,'Fixture');const detail=await catalog.detail(bili,'BVtest');assert.equal(detail.lines[0].episodes.length,2);const media=await catalog.resolve(bili,detail.lines[0],detail.lines[0].episodes[0],[],'');assert.equal(media.audioUrl,'https://audio.example.test/audio');assert.equal(media.headers.cookie,undefined);
    assert.equal((await catalog.home(site('csp_AppTTGuard'))).list[0].id,'app1');assert.equal((await catalog.home(site('csp_JpysGuard'))).list[0].id,'jp1');
    const mdd=site('csp_MaiDuiDuiGuard');mdd.api=base;mdd.material={get:async()=>({fields:{SN:'fixture-sign',N:'fixture-web',t0:'5.6.01'}})};assert.equal((await catalog.category(mdd,{id:'0',page:1})).list[0].id,'mdd1');
    const sports=site('csp_LiveGzGuard');sports.api=base;assert.equal((await catalog.category(sports,{id:'0-0-1'})).list[0].title,'A vs B');
    const hmys={adapter:'hmys',api:base,headers:{},deviceId:'device-fixture',material:{get:async()=>({fields:{i:'app',t0:'channel',M:'fixture',N:'salt',Gc:'1',yq:'01234567890123456789012345678901',SN:'0123456789012345'}})}};assert.equal((await protectedApps.hmysCall(hmys,'/hmys',{},undefined)).ok,true);
    const cloud=new Cloud({cookie:async()=> 'private=cloud',get:()=>({})},null,{endpoints:{quark:base+'/cloud/'}});const share=await cloud.detail('https://pan.quark.cn/s/fixture');assert.equal(share.lines[0].name,'Season 1');assert.equal(share.lines[0].provider,'quark');assert.equal(share.lines[0].episodes[0].name,'Episode 01.mp4');assert.deepEqual(decode(share.lines[0].episodes[0].id).folders,['Season 1'],'Browser fallback retains the exact containing directory');const resolved=await cloud.resolve(share.lines[0].episodes[0].id);assert.equal(resolved.url.values[0].v,'https://cdn.example.test/1080.m3u8');assert.equal(resolved.url.values.length,2,'All returned cloud renditions remain selectable');assert.equal(resolved.header.cookie,undefined);
    console.log('PASS: Bili DASH/credentials, signed app forms, MDD signing, sports envelopes, private app crypto, nested cloud files/quality and literal-only rules');
  } finally {server.closeAllConnections();await new Promise(resolve=>server.close(resolve));delete global.__untrustedExecuted;}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
