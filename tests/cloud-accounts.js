const assert=require('assert/strict');const fs=require('fs');const os=require('os');const path=require('path');const http=require('http');
const {Accounts}=require('../src/content/accounts');const {Cloud}=require('../src/content/cloud');
async function run(){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV accounts test '));let base,refreshCalls=0,quarkCalls=0,cleared=[],releaseResponse,receivedResponse;let browserCookie='anonymous=1';
  const browser={cookies:async()=>browserCookie,loginTokens:async()=>({}),open:async url=>({opened:true,url}),clearLogin:async scopes=>{cleared=scopes;browserCookie='';}};
  const accounts=new Accounts(directory,browser),server=http.createServer(async(req,res)=>{
    let body='';for await(const chunk of req)body+=chunk;res.setHeader('Content-Type','application/json');
    const url=new URL(req.url,base),send=v=>res.end(JSON.stringify(v));
    if(url.pathname==='/v2/account/token'){
      refreshCalls++;const request=JSON.parse(body);if(request.refresh_token==='invalid'){res.statusCode=400;return send({code:'InvalidRefreshToken'});}
      assert.equal(request.refresh_token,'refresh-old');await new Promise(resolve=>setTimeout(resolve,30));return send({access_token:'access-new',refresh_token:'refresh-new',expires_in:3600});
    }
    if(url.pathname==='/v2/user/get'){
      if(req.headers.authorization==='Bearer access-new')return send({user_id:'fixture-user',default_drive_id:'fixture-drive'});
      res.statusCode=401;return send({code:'AccessTokenExpired'});
    }
    if(url.pathname.startsWith('/quark/')||url.pathname.startsWith('/uc/')){
      quarkCalls++;if(!req.headers.cookie?.includes('session=valid'))return send({status:401,code:31001,message:'not login'});
      if(url.searchParams.has('wait')){receivedResponse();await new Promise(resolve=>{releaseResponse=resolve;});}
      res.setHeader('Set-Cookie','__puus=rotated; Path=/; HttpOnly');return send({code:0,data:{list:[]}});
    }
    if(url.pathname==='/api/list')return req.headers.cookie?.includes('BDUSS=valid')?send({errno:0,list:[]}):send({errno:-6});
    if(url.pathname==='/x/web-interface/nav')return send({code:0,data:{isLogin:req.headers.cookie?.includes('SESSDATA=valid')===true}});
    res.statusCode=404;send({error:'not found'});
  });await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
  const cloud=new Cloud(accounts,browser,{endpoints:{ali:base,quark:base+'/quark/',uc:base+'/uc/',baidu:base,bili:base}});accounts.validator=(provider,credentials,signal)=>cloud.checkAccount(provider,credentials,signal);
  try{
    assert.throws(()=>accounts.get('constructor'),/不支持/);
    assert.equal(accounts.summary()[0].configured,false);
    await assert.rejects(accounts.sync('quark'),e=>e.status===428);assert.equal(accounts.summary()[0].configured,false,'Anonymous browser cookies are not saved as a login');
    browserCookie='session=valid';await accounts.sync('quark');assert.equal(accounts.summary()[0].valid,true);assert.ok(accounts.get('quark').cookie.includes('__puus=rotated'),'Normal response session rotation is retained');
    const good=accounts.get('quark').cookie;browserCookie='anonymous=1';await assert.rejects(accounts.sync('quark'));assert.equal(accounts.get('quark').cookie,good,'Failed browser sync preserves a working saved account');
    accounts.set('quark',{cookie:'session=expired'});await assert.rejects(accounts.check('quark'),e=>e.status===428);assert.equal(accounts.summary()[0].status,'expired');
    accounts.set('quark',{cookie:'session=valid'});await accounts.check('quark');assert.equal(new Accounts(directory,browser).summary()[0].valid,true,'Verified status and credentials persist after restart');
    const before=accounts.get('quark');await assert.rejects(cloud.checkAccount('quark',{cookie:''}),e=>e.status===428);assert.deepEqual(accounts.get('quark'),before,'Validation uses candidate credentials without mutating saved account');
    accounts.set('ali',{refreshToken:'refresh-old'});const [a,b]=await Promise.all([cloud.authorization(),cloud.authorization()]);assert.equal(a.authorization,'Bearer access-new');assert.deepEqual(a,b);assert.equal(refreshCalls,1,'Concurrent refresh is coalesced');assert.equal(accounts.get('ali').refreshToken,'refresh-new');
    accounts.set('ali',{accessToken:'expired-but-unexpired-clock',refreshToken:'refresh-old',expiresAt:Date.now()+3600000});const user=await cloud.request('ali','/v2/user/get',{},await cloud.authorization());assert.equal(user.user_id,'fixture-user');assert.equal(refreshCalls,2,'A rejected access token refreshes once and retries');
    accounts.set('ali',{accessToken:'',refreshToken:'invalid'});await assert.rejects(accounts.check('ali'),e=>e.status===428);assert.equal(accounts.summary().find(a=>a.provider==='ali').valid,false);
    accounts.set('baidu',{cookie:'BDUSS=valid'});await accounts.check('baidu');assert.equal(accounts.summary().find(a=>a.provider==='baidu').status,'verified');
    accounts.set('bili',{cookie:'SESSDATA=valid'});await accounts.check('bili');assert.equal(accounts.summary().find(a=>a.provider==='bili').valid,true);accounts.set('bili',{cookie:'anonymous=1'});await assert.rejects(accounts.check('bili'),e=>e.status===428);assert.equal(accounts.summary().find(a=>a.provider==='bili').valid,false);
    const drive=await cloud.resolveDrive({provider:'baidu',fid:'/fixture.mp4'});assert.equal(drive.credentialOrigin,new URL(base).origin);assert.equal(drive.header.cookie,'BDUSS=valid');
    const playback=await require('../src/content/playback').resolvePlayback({api:'https://pan.quark.cn/',headers:{}},drive);assert.equal(playback.headers.cookie,'BDUSS=valid','The MyDrive entry retains credentials specifically scoped to a different selected provider API');
    const summary=JSON.stringify(accounts.summary());for(const value of ['session=valid','BDUSS=valid','refresh-old','access-new','rotated'])assert.ok(!summary.includes(value),'Public account summary never returns secrets');
    const baidu=accounts.get('baidu');await accounts.logout('quark');assert.equal(accounts.get('quark').cookie,undefined);assert.ok(cleared.every(url=>!url.includes('baidu')));assert.deepEqual(accounts.get('baidu'),baidu,'Logout is restricted to the selected provider');
    accounts.set('quark',{cookie:'session=valid'});const received=new Promise(resolve=>{receivedResponse=resolve;});const delayed=cloud.request('quark','file/sort?wait=1');await received;await accounts.logout('quark');releaseResponse();await delayed;assert.equal(accounts.get('quark').cookie,undefined,'A late Set-Cookie response cannot restore a logged-out account');
    accounts.set('uc',{cookie:'session=old'});const originalValidator=accounts.validator;let release;accounts.validator=async(provider,credentials)=>new Promise(resolve=>{release=()=>resolve(credentials);});
    const pending=accounts.check('uc');accounts.set('uc',{cookie:'session=new'});release();await assert.rejects(pending,e=>e.status===409);assert.equal(accounts.get('uc').cookie,'session=new','A late account check cannot restore credentials after an account switch');accounts.validator=originalValidator;
    assert.ok(quarkCalls>0);console.log('PASS: actual session validation, anonymous-cookie rejection, failed-sync rollback, cookie rotation, refresh coalescing/retry, expiry, persistence, secret-free summaries and provider logout');
  }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('MobileTV accounts test '));fs.rmSync(target,{recursive:true,force:true});}
}
run().catch(e=>{console.error(e);process.exitCode=1;});
