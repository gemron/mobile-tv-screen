const assert=require('assert/strict'),fs=require('fs'),path=require('path'),os=require('os'),http=require('http'),{setTimeout:delay}=require('timers/promises');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV episode cancellation '));process.env.MOBILETV_DATA_DIR=directory;
const {createAppServer}=require('../src/server'),castState=require('../src/services/castState');let origin,receiver;
(async()=>{
  let source;const pending=[];
  origin=http.createServer((req,res)=>{
    const url=new URL(req.url,'http://fixture');res.setHeader('content-type','application/json');
    if(url.searchParams.has('play')){const item={closed:false,release:()=>{if(!res.destroyed)res.end(JSON.stringify({url:source+'/movie-'+url.searchParams.get('play')+'.mp4',type:'mp4',parse:0}));}};res.on('close',()=>{item.closed=true;});pending.push(item);return;}
    res.end(JSON.stringify({list:[{vod_id:'video',vod_name:'Request fixture',vod_play_from:'Main',vod_play_url:'One$one#Two$two#Three$three'}]}));
  });
  await new Promise(resolve=>origin.listen(0,'127.0.0.1',resolve));source='http://127.0.0.1:'+origin.address().port;
  receiver=await createAppServer({port:0,enableDlna:false,enableAirplay:false,enableTvbox:false,enableBilibili:false,dataDir:directory});const base='http://127.0.0.1:'+receiver.port,library=receiver.app._router.stack.find(layer=>layer.handle?.library).handle.library;
  library.apply({sites:[{key:'fixture',type:4,api:source+'/api'}]},source);library.playTimeoutMs=2000;
  const play=async(index,signal)=>{const r=await fetch(base+'/api/library/play',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({siteKey:'fixture',vodId:'video',index}),signal});return {status:r.status,...await r.json()};};
  const until=async check=>{for(let i=0;i<200;i++){if(check())return;await delay(10);}throw Error('Fixture request did not settle');};
  const first=play(0);await until(()=>pending.length===1);const second=play(1);await until(()=>pending.length===2);assert.equal((await first).status,409);pending[0].release();assert.equal(castState.getSnapshot().url,'');pending[1].release();const result=await second;assert.equal(result.status,200);assert.equal(result.playback.index,1);
  const session=result.state.sessionId,abort=new AbortController(),cancelled=play(2,abort.signal).catch(error=>error);await until(()=>pending.length===3);abort.abort();assert.equal((await cancelled).name,'AbortError');await until(()=>pending[2].closed);pending[2].release();assert.equal(castState.getSnapshot().sessionId,session,'Closing the HTTP request cannot start an abandoned episode');
  library.playTimeoutMs=100;const timed=await play(2);assert.equal(timed.status,504);assert.match(timed.error,/解析超时/);assert.equal(castState.getSnapshot().sessionId,session);
  const detail=library.detail;let release;library.detail=()=>new Promise(resolve=>{release=resolve;});const started=Date.now(),stuck=await play(0);assert.equal(stuck.status,504);assert.ok(Date.now()-started<1000);release({title:'Late metadata',lines:[{name:'Main',episodes:[{name:'One',id:source+'/late.mp4'}]}]});await delay(30);assert.equal(castState.getSnapshot().sessionId,session);library.detail=detail;
  console.log('PASS: newer episode cancels old parsing, client disconnect cancels upstream, bounded timeout and late metadata cannot replace playback');
})().catch(error=>{console.error(error);process.exitCode=1;}).finally(async()=>{await receiver?.close();origin?.closeAllConnections();if(origin)await new Promise(resolve=>origin.close(resolve));const target=fs.realpathSync(directory);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(target).startsWith('MobileTV episode cancellation '));fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});});
