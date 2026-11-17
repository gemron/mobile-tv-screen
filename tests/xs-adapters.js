const assert=require('assert/strict');
const http=require('http');
const crypto=require('crypto');
const fs=require('fs');
const os=require('os');
const path=require('path');
const {deflateSync}=require('zlib');
const catalog=require('../src/content/catalog');
const pb=require('../src/content/protobuf');
const {aes}=require('../src/content/adapters/xs-apps');
const {JavaRandom,dubokuDecode,jsonp}=require('../src/content/adapters/xs-api');
const rule=require('../src/content/adapters/xs-rule');
const {include}=require('../scripts/package-dependencies');
async function run(){
  const failures=[],requests=[],pair=crypto.generateKeyPairSync('rsa',{modulusLength:1024}),publicKey=pair.publicKey.export({format:'der',type:'spki'}).toString('base64'),key='1234567890abcdef';
  const server=http.createServer(async(req,res)=>{try{
    const body=Buffer.concat(await Array.fromAsync(req)),url=new URL(req.url,'http://localhost');requests.push(url.pathname);
    const send=data=>res.end(JSON.stringify(data));
    if(url.pathname==='/api.php/getappapi.index/initV119'){
      assert.ok(req.headers['app-user-device-id']);assert.equal(req.headers['app-version-code'],'119');assert.deepEqual(JSON.parse(body),{});
      return send({code:1,data:aes(Buffer.from(JSON.stringify({type_list:[{type_id:1,type_name:'分类'}],recommend_list:[{vod_id:'7',vod_name:'App 影片',vod_pic:'/p.jpg'}]})),key,key,true).toString('base64')});
    }
    if(url.pathname==='/api.php/getappapi.index/vodDetail')return send({data:aes(Buffer.from(JSON.stringify({vod:{vod_id:'7',vod_name:'App 影片'},vod_play_list:[{player_info:{show:'主线',parse:'jx'},urls:[{name:'第1集',url:'opaque',token:'fixture'}]}]})),key,key,true).toString('base64')});
    if(url.pathname==='/api.php/getappapi.index/vodParse'){
      assert.equal(aes(Buffer.from(req.headers['app-api-verify-sign'],'base64'),key,key).toString(),req.headers['app-api-verify-time']);
      const data=new URLSearchParams(body.toString());assert.equal(aes(Buffer.from(data.get('url'),'base64'),key,key).toString(),'opaque');
      return send({data:aes(Buffer.from(JSON.stringify({json:JSON.stringify({url:base+'/movie.mp4'})})),key,key,true).toString('base64')});
    }
    if(url.pathname.startsWith('/app/')||url.pathname.startsWith('/vod/')){
      assert.ok(req.headers.uuid);assert.ok(req.headers.nonce);assert.equal(req.headers.api_version,'v1');
      const iv=Buffer.from(body.toString(),'base64').subarray(0,16),payload=JSON.parse(aes(Buffer.from(body.toString(),'base64').subarray(16),req.headers.uuid.replace(/-/g,''),iv));
      assert.equal(payload.nonce,req.headers.nonce);
      assert.equal(req.headers.sign,crypto.createHash('sha256').update(body.toString()+':'+payload.timestamp+':'+payload.nonce+':'+payload.token).digest('hex'));
      const data=url.pathname==='/app/systemInit'?{categorys:{data:[{id:1,name:'分类'}]}}:url.pathname==='/app/userInfo'?{userInfo:{user_token:'fixture-token'}}:url.pathname==='/vod/search'?{data:[{id:7,name:'剧圈影片'}],page_count:2}:{data:{id:7,name:'剧圈影片',play_from:'直链',play_url:'第一集$'+base+'/movie.mp4'}};
      const v=crypto.randomBytes(16),bytes=aes(deflateSync(Buffer.from(JSON.stringify(data))),req.headers.uuid.replace(/-/g,''),v,true);return res.end(Buffer.concat([v,bytes]).toString('base64'));
    }
    if(url.pathname.startsWith('/api/proto/')||url.pathname==='/api/v5/find/app/zone'){
      assert.equal(req.headers['content-type'],'application/x-protobuf');assert.ok(req.headers.publicparams);
      const envelope=JSON.parse(req.headers.publicparams);assert.ok(aes(Buffer.from(envelope.paramsData,'hex'),key,key).length);
      const input=pb.decode(body);assert.ok(input.size>0,'wire body is binary, not JSON serialized Buffer');
      let data;
      if(url.pathname.endsWith('/zone'))data=pb.encode([[2,publicKey.slice(0,40)],[3,publicKey.slice(40,80)],[4,publicKey.slice(80,120)],[5,publicKey.slice(120)]]);
      else if(url.pathname.endsWith('/category'))data=pb.encode([[1,pb.encode([[3,7],[5,'Drama 影片'],[2,pb.encode([[2,base+'/p.jpg']])]])]]);
      else if(url.pathname.endsWith('/getDetail'))data=pb.encode([[4,7],[9,'Drama 影片'],[29,pb.encode([[2,'第1集'],[4,'opaque'],[9,'from'],[10,'专线']])]]);
      else data=pb.encode([[1,base+'/movie.mp4'],[6,pb.encode([[1,'Referer'],[2,base+'/']])]]);
      return res.end(pb.encode([[1,200],[3,data]]));
    }
    if(url.pathname==='/api/v3/drama/getCategory')return send({data:[{id:1,name:'分类'}]});
    if(url.pathname==='/api/contents/movie')return send({success:true,data:{items:[{source_link:'https://pan.quark.cn/s/fixture',title:'分享影片'}],total_pages:3}});
    if(url.pathname==='/')return res.end('<html><div class="module-item"><div class="module-item-titlebox"><a href="/voddetail/7.html" title="网盘影片">影片</a></div><img data-src="/p.jpg"></div></html>');
    if(url.pathname==='/rule.json')return res.end(JSON.stringify({'分类':'示例$c1','分类url':base+'/rule-list?type={cateId}&page={catePg}','数组':'<row>&&</row>','链接':'id="&&"','链接前缀':base+'/detail/','标题':'title="&&"','图片':'pic="&&"','副标题':'note="&&"','播放列表':'<play>&&</play>','播放标题':'name="&&"','播放链接':'url="&&"'}));
    if(url.pathname==='/rule-list')return res.end('<row>id="7" title="规则影片" pic="'+base+'/p.jpg" note="HD"</row>');
    if(url.pathname==='/detail/7')return res.end('<play>name="高清" url="'+base+'/movie.mp4"</play>');
    if(url.pathname==='/movie.mp4')return res.end('fixture');
    res.statusCode=404;res.end('missing');
  }catch(e){failures.push(e);res.statusCode=500;res.end('fixture assertion');}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  const site=raw=>catalog.describeSite({key:'test',type:3,...raw},base,0);
  try{
    const app=site({api:'csp_AppGet',ext:{url:base,dataKey:key,dataIv:key,version:'119'}});
    assert.equal((await catalog.home(app)).list[0].title,'App 影片');const detail=await catalog.detail(app,'7');
    const result=await require('../src/content/providers').resolve(app,detail.lines[0].episodes[0]);assert.equal(result.url,base+'/movie.mp4');
    const jq=site({api:'csp_App99',ext:{host:base,name:'Fixture',versionName:'2',buildSignature:'fixture',buildNumber:'1',package:'example.fixture'}});
    assert.equal((await catalog.home(jq)).list[0].title,'剧圈影片');assert.equal((await catalog.detail(jq,'7')).lines[0].episodes[0].name,'第一集');
    const drama=site({api:'csp_AppDrama',ext:{host:base,publicKey,dataKey:key,dataIv:key,version:'3.0.1',pkg:'fixture',appName:'fixture'}});drama.material={get:async()=>({fields:{c:key}})};
    assert.equal((await catalog.home(drama)).list[0].title,'Drama 影片');const d=await catalog.detail(drama,'7');assert.equal(d.lines[0].name,'专线');
    assert.equal((await require('../src/content/providers').resolve(drama,d.lines[0].episodes[0])).url,base+'/movie.mp4');
    const search=site({api:'csp_Jike',ext:{siteUrl:base}});assert.equal((await catalog.home(search)).list[0].title,'分享影片');
    const pan=site({api:'csp_PanWebShare',ext:{site:[base]}});pan.cloud={};assert.equal((await catalog.home(pan)).list[0].title,'网盘影片');
    const rules=site({api:'csp_XBPQ',ext:base+'/rule.json'});assert.equal((await catalog.home(rules)).list[0].title,'规则影片');assert.equal((await catalog.detail(rules,base+'/detail/7')).lines[0].episodes[0].id,base+'/movie.mp4');
    const {Library}=require('../src/content/library'),dir=fs.mkdtempSync(path.join(os.tmpdir(),'mobiletv-xs-'));
    const lib=new Library({dataDir:dir});try{lib.apply({spider:base+'/one.jar',sites:[{key:'a',type:3,api:'csp_AppGet',ext:{url:base}},{key:'b',type:3,api:'csp_AppGet',ext:{url:base},jar:'./two.jar'}]},base+'/xs.json');assert.equal(lib.sites[0].material.declaration,base+'/one.jar');assert.equal(lib.sites[1].material.declaration,'./two.jar');}finally{await lib.close();const target=fs.realpathSync(dir);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(target).startsWith('mobiletv-xs-'));fs.rmSync(target,{recursive:true,force:true});}
    const j=new JavaRandom(0);assert.equal(j.int(100),60);assert.equal(j.int(100),48);
    assert.equal(jsonp('callback({"data":[1]});').data[0],1);assert.throws(()=>jsonp('evil();callback({})'));
    assert.throws(()=>pb.decode(Buffer.from([0x0a,0x7f])));assert.throws(()=>pb.decode(Buffer.from([0xff])));
    assert.throws(()=>rule.extract('hello','js:eval()'));assert.equal(rule.extract('img="foo"','https://host/+img="&&"'),'https://host/foo');
    assert.ok(include('express','lib/router/index.js'));assert.ok(include('foo','LICENSE'));assert.ok(!include('hls.js','src/hls.ts'));assert.ok(include('hls.js','dist/hls.min.js'));assert.ok(!include('foo','tests/fixture.js'));assert.ok(!include('foo','lib/index.js.map'));assert.ok(include('foo','lib/index.js'));assert.ok(!include('foo','prebuilds/linux-x64/addon.node'));assert.ok(include('foo','prebuilds/win32-x64/addon.node'));
    assert.deepEqual(failures,[]);assert.ok(requests.length>12);
    console.log('PASS: XS encrypted AppGet/App99/Drama round trips, binary protobuf, signed headers, cloud HTML, search/rules, per-site material and Windows package pruning');
  }finally{server.closeAllConnections();await new Promise(r=>server.close(r));}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
