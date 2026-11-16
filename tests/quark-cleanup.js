const assert=require('assert/strict'),fs=require('fs'),os=require('os'),path=require('path'),http=require('http');
const {Cloud,encode,decode}=require('../src/content/cloud');
const {setTimeout:delay}=require('timers/promises');
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV Quark cleanup '));
let cloud,server,base,cookie='__uid=fixture-alpha; __puus=first',failDelete=false,full=false,saves=0,taskFile='new-file';
const files=new Map(),deleted=[];
const put=(fid,name,parent='0',size=1000)=>files.set(fid,{fid,file_name:name,pdir_fid:parent,size,file_type:1});
(async()=>{
 server=http.createServer(async(req,res)=>{
  let raw='';for await(const chunk of req)raw+=chunk;const body=raw?JSON.parse(raw):{},url=new URL(req.url,base);
  res.setHeader('content-type','application/json');const send=data=>res.end(JSON.stringify({code:0,data}));
  if(url.pathname.endsWith('/file/sort'))return send({list:[...files.values()].filter(f=>f.pdir_fid===url.searchParams.get('pdir_fid'))});
  if(url.pathname.endsWith('/file/delete')){assert.equal(body.action_type,2);assert.deepEqual(body.exclude_fids,[]);if(failDelete)return res.end(JSON.stringify({code:500,message:'Fixture deletion failed'}));for(const fid of body.filelist){deleted.push(fid);files.delete(fid);}full=false;return send({});}
  if(url.pathname.endsWith('/file')&&req.method==='POST'){assert.equal(body.pdir_fid,'0');assert.ok(body.file_name.startsWith('MobileTV '));files.set('temp-dir',{fid:'temp-dir',file_name:body.file_name,pdir_fid:'0',file_type:0,dir:true});return send({fid:'temp-dir'});}
  if(url.pathname.endsWith('/share/sharepage/token'))return send({stoken:'fixture-token'});
  if(url.pathname.endsWith('/share/sharepage/detail'))return send({list:[{fid:'selected',file_name:'Episode.mp4',share_fid_token:'fixture-file-token'}]});
  if(url.pathname.endsWith('/share/sharepage/save')){saves++;assert.deepEqual(body.fid_list,['selected']);assert.equal(body.to_pdir_fid,'temp-dir');if(full)return res.end(JSON.stringify({status:403,code:32003,message:'capacity limit'}));put(taskFile,'Episode.mp4','temp-dir',2500);return send({task_id:'save-task'});}
  if(url.pathname.endsWith('/task'))return send({status:2,save_as:{save_as_top_fids:[taskFile]}});
  if(url.pathname.endsWith('/file/download'))return send([{fid:body.fids[0],file_name:'Episode.mp4',download_url:base+'/movie.mp4'}]);
  if(url.pathname.endsWith('/file/v2/play'))return send({video_list:[]});
  res.statusCode=404;res.end('{}');
 });await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;
 const accounts={file:path.join(dir,'cloud-accounts.json'),get:()=>({cookie}),cookie:async()=>cookie,check:async()=>{}};
 cloud=new Cloud(accounts,null,{endpoints:{quark:base+'/cloud/'}});
 const owner=await cloud.cleanup.owner(),key=n=>String(n).padStart(64,'0');
 put('original','My original movie.mkv');put('legacy','Old Episode.mp4');put('playing','Playing.mp4');put('renamed','Kept renamed.mp4');put('other-owner','Other account.mp4');
 cloud.rememberShare(key(1),{provider:'quark',fid:'legacy'});
 cloud.rememberShare(key(2),{provider:'quark',fid:'playing',ownerHash:owner,name:'Playing.mp4',managed:true,parent:'0'});
 cloud.rememberShare(key(3),{provider:'quark',fid:'renamed',ownerHash:owner,name:'Before rename.mp4',managed:true,parent:'0'});
 cloud.rememberShare(key(4),{provider:'quark',fid:'other-owner',ownerHash:'f'.repeat(64),managed:true,parent:'0'});
 cloud.cleanup.activate(key(2),'playing',10);
 const first=await cloud.cleanup.clean('manual');assert.equal(first.removed,1);assert.deepEqual(deleted,['legacy']);
 assert.ok(files.has('original')&&files.has('playing')&&files.has('renamed')&&files.has('other-owner'),'Original, active, renamed and another account files remain');
 assert.equal(cloud.shareSaves.has(key(1)),false);
 cookie='__uid=fixture-alpha; __puus=rotated';assert.equal(await cloud.cleanup.owner(),owner,'Normal rotating cookies do not change account ownership');
 cloud.cleanup.configure('off');cloud.cleanup.active=null;assert.equal((await cloud.cleanup.clean('space')).removed,0);assert.ok(files.has('playing'));
 cloud.cleanup.configure('space');assert.equal((await cloud.cleanup.clean('playback')).removed,0);
 cloud.cleanup.activate(key(2),'playing',10);
 put('failure','Failure.mp4');cloud.rememberShare(key(5),{provider:'quark',fid:'failure',ownerHash:owner,managed:true,parent:'0'});
 failDelete=true;await assert.rejects(cloud.cleanup.clean('manual'),/Fixture deletion failed/);assert.ok(cloud.shareSaves.has(key(5)));failDelete=false;
 cookie='__uid=fixture-beta';assert.equal((await cloud.cleanup.clean('manual')).removed,0,'Account switches cannot delete another account\'s tracked files');cookie='__uid=fixture-alpha';
 // A new selection that arrives immediately before sending a delete is protected.
 const request=cloud.cleanup.request.bind(cloud.cleanup);cloud.cleanup.request=async(ctx,endpoint,body,guard)=>{if(endpoint==='file/delete')cloud.cleanup.activate(key(5),'failure',11);return request(ctx,endpoint,body,guard);};
 await assert.rejects(cloud.cleanup.clean('manual'),e=>e.status===409);assert.ok(files.has('failure'));cloud.cleanup.request=request;
 cloud.cleanup.activate(key(2),'playing',10);
 const id=encode({provider:'quark',share:'share',parent:'0',fid:'selected',fileToken:'fixture-file-token',name:'Episode.mp4',size:2500});
 full=true;const played=await cloud.saveShare(id,{consent:true});assert.equal(saves,2,'A capacity failure frees an old app transfer and retries this single save once');assert.ok(deleted.includes('failure'));assert.ok(played.url.values[0].v.endsWith('/movie.mp4'));
 const savedKey=await cloud.recordKey(decode(id)),record=cloud.shareSaves.get(savedKey);assert.equal(record.parent,'temp-dir');assert.equal(record.ownerHash,owner);assert.equal(record.managed,true);
 const hold=await cloud.holdEpisode(id);assert.equal((await cloud.cleanup.clean('manual')).removed,0,'A resolving file is protected');hold.release();
 const cancel=new AbortController(),one=await cloud.holdEpisode(id,cancel.signal),two=await cloud.holdEpisode(id);cancel.abort();one.release();assert.ok(cloud.cleanup.holds.has(savedKey),'Abort plus explicit release cannot remove another reader\'s protection');two.release();assert.equal(cloud.cleanup.holds.has(savedKey),false);
 cloud.cleanup.activate(savedKey,record.fid,12);assert.equal((await cloud.cleanup.clean('manual')).removed,1,'The previous episode can be cleaned while the new one plays');assert.ok(files.has('new-file'),'An actively playing save is protected');
 cloud.cleanup.configure('both');cloud.cleanup.ended(12);await delay(5300);await cloud.cleanup.queue;
 assert.ok(deleted.includes('new-file'),'Playback completion schedules automatic cleanup');assert.equal(cloud.shareSaves.has(savedKey),false);
 assert.ok(files.has('original')&&files.has('renamed')&&files.has('other-owner'));
 taskFile='reconciled';put(taskFile,'Recovered pending.mp4');cloud.rememberShare(key(8),{provider:'quark',taskId:'save-task',ownerHash:owner,parent:'0',managed:true,name:'Recovered pending.mp4'});
 assert.equal((await cloud.cleanup.clean('manual')).removed,1,'Completed saves whose client disconnected can be reconciled and cleaned by exact returned ID');assert.ok(!files.has('reconciled'));
 const persisted=fs.readFileSync(path.join(dir,'quark-cleanup.json'),'utf8')+fs.readFileSync(path.join(dir,'cloud-shares.json'),'utf8');assert.ok(!/fixture-alpha|fixture-file-token|__puus|fixture-token/.test(persisted),'Cleanup metadata contains no credentials or share tokens');
 console.log('PASS: exact transfer ownership, recycle-only deletion, active/inflight protection, account changes, renamed files, bounded capacity retry, completion cleanup and credential-free persistence');
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(async()=>{await cloud?.cleanup.close();if(server){server.closeAllConnections();await new Promise(r=>server.close(r));}const resolved=fs.realpathSync(dir);assert.equal(path.dirname(resolved).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(resolved).startsWith('MobileTV Quark cleanup '));fs.rmSync(resolved,{recursive:true,force:true});});
