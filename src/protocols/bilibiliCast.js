const net=require('net'),http=require('http'),express=require('express'),{createHash}=require('crypto');
const castState=require('../services/castState'),mediaHeaders=require('../services/mediaHeaders');
const codec=require('./nva-codec');
const NVA='urn:app-bilibili-com:service:NirvanaControl:3';
const escape=value=>String(value??'').replace(/[<>&"']/g,char=>({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;',"'":'&apos;'}[char]));
const validId=value=>/^[A-Za-z0-9._-]{1,128}$/.test(value||'');
const failure=(message,code=400)=>Object.assign(new Error(message),{code});
function mediaUrl(value,remote){const url=new URL(value);if(!['http:','https:'].includes(url.protocol)||url.username||url.password)throw failure('媒体地址无效');if(['127.0.0.1','localhost','0.0.0.0'].includes(url.hostname))url.hostname=remote.replace(/^::ffff:/,'');return url.href;}
class BilibiliCastService{
 constructor({port=9958,mainPort,getIdentity,getPreferredIp,resolveMedia,dlnaRouter,getAccount=()=>({signedIn:false})}={}){
  this.port=port;this.mainPort=mainPort;this.getIdentity=getIdentity;this.getPreferredIp=getPreferredIp;this.resolveMedia=resolveMedia;this.getAccount=getAccount;
  this.sockets=new Set();this.clients=new Set();this.sessions=new Map();this.probeTimes=new Map();this.serial=0;this.current=null;this.transition=Promise.resolve();
  this.app=express();this.app.get(['/description.xml','/device.xml'],(req,res)=>{this.logProbe('设备描述',req.socket.remoteAddress);res.type('xml').send(this.description(req.hostname));});
  this.app.get('/dlna/NirvanaControl.xml',(req,res)=>res.type('xml').send(this.scpd()));
  this.app.post('/NirvanaControl/action',express.text({type:'*/*',limit:'128kb'}),(req,res)=>{
   const action=/[#](\w+)/.exec(String(req.headers.soapaction||''))?.[1];
   this.logProbe('SOAP '+String(action||'unknown').slice(0,48),req.socket.remoteAddress);
   const values=action==='GetAppInfo'?{PackageName:'com.xiaodianshi.tv.yst',AppKey:'0000000000000000',Signature:'0000000000000000',CurrentSignedIn:this.getAccount().signedIn?1:0}:action==='GetAccountInfo'?{VipInfo:0}:null;
   if(!values){res.status(501).type('xml').send('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><s:Fault><faultcode>s:Client</faultcode><faultstring>Unsupported experimental NVA action</faultstring></s:Fault></s:Body></s:Envelope>');return;}
   res.type('xml').send(`<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><u:${action}Response xmlns:u="${NVA}">${Object.entries(values).map(([key,value])=>`<${key}>${escape(value)}</${key}>`).join('')}</u:${action}Response></s:Body></s:Envelope>`);
  });
  if(dlnaRouter)this.app.use('/upnp',dlnaRouter);
  this.http=http.createServer(this.app);this.onState=snapshot=>{
   if(this.setting)return;
   if(!this.setting&&this.controller&&this.pendingSnapshot&&(snapshot.sessionId!==this.pendingSnapshot.sessionId||snapshot.url!==this.pendingSnapshot.url||snapshot.status!==this.pendingSnapshot.status)){this.controller.abort();this.serial++;}
   if(!this.setting&&this.current&&(snapshot.sessionId!==this.current.sessionId||!snapshot.url)){this.controller?.abort();this.current=null;this.serial++;}
   this.broadcast(snapshot);
  };
  this.onEnded=snapshot=>{
   if(this.current?.sessionId!==snapshot.sessionId)return;const client=[...this.clients].find(item=>item.record.sessionId===snapshot.sessionId);if(!client)return;
   this.notify(client,'OnPlayState',{playState:6});const params=client.record.playParams||{},media=client.record.media;
   if(params.autoNext===false||params.autoNext==='false'||!media)return;
   const episodes=media.episodes||[],index=episodes.findIndex(item=>String(item.cid)===String(media.playItem?.cid)),next=episodes[index+1];
   if(index>=0&&next)this.handle(client,'Play',{...params,...next,seekTs:0}).catch(()=>this.notify(client,'OnPlayState',{playState:7,error:'下一集暂时无法播放'}));
  };
 }
 logProbe(method,remote){const key=remote+'\0'+method,now=Date.now();if(now-(this.probeTimes.get(key)||0)<10000)return;if(this.probeTimes.size>=64)this.probeTimes.clear();this.probeTimes.set(key,now);castState.addLog('BilibiliCast','收到 '+method,{clientIp:String(remote||'').replace(/^::ffff:/,'')});}
 identity(){return 'XY'+createHash('sha256').update(this.getIdentity().uuid).digest('hex').toUpperCase().slice(0,35);}
 discoveryTargets(){if(!this.server?.listening)return [];const uuid=this.identity();return ['upnp:rootdevice',`uuid:${uuid}`,'urn:schemas-upnp-org:device:MediaRenderer:1','urn:schemas-upnp-org:service:NirvanaControl:3',NVA].map(st=>({st,usn:st===`uuid:${uuid}`?st:`uuid:${uuid}::${st}`,location:ip=>`http://${ip}:${this.port}/description.xml`}));}
 description(host){
  const ip=net.isIP(host)?host:this.getPreferredIp(),base=`http://${ip}:${this.mainPort}`;
  const services=['AVTransport','RenderingControl','ConnectionManager'].map(name=>`<service><serviceType>urn:schemas-upnp-org:service:${name}:1</serviceType><serviceId>urn:upnp-org:serviceId:${name}</serviceId><controlURL>${escape(base)}/upnp/control/${name}1</controlURL><eventSubURL>${escape(base)}/upnp/event/${name}1</eventSubURL><SCPDURL>${escape(base)}/upnp/scpd/${name}.xml</SCPDURL></service>`).join('');
  return `<?xml version="1.0"?><root xmlns="urn:schemas-upnp-org:device-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><device><deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType><friendlyName>我的小电视</friendlyName><manufacturer>Bilibili Inc.</manufacturer><manufacturerURL>https://bilibili.com/</manufacturerURL><modelName>MobileTV NVA compatibility</modelName><modelDescription>MobileTV 实验性兼容接收端</modelDescription><UDN>uuid:${this.identity()}</UDN><X_brandName>MobileTV</X_brandName><hostVersion>25</hostVersion><ottVersion>106400</ottVersion><channelName>master</channelName><capability>0</capability><serviceList>${services}<service><serviceType>${NVA}</serviceType><serviceId>urn:app-bilibili-com:serviceId:NirvanaControl</serviceId><controlURL>/NirvanaControl/action</controlURL><eventSubURL>/NirvanaControl/event</eventSubURL><SCPDURL>/dlna/NirvanaControl.xml</SCPDURL></service></serviceList></device></root>`;
 }
 scpd(){const actions={GetAppInfo:['PackageName','AppKey','Signature','CurrentSignedIn'],GetAccountInfo:['VipInfo']};const names=[...new Set(Object.values(actions).flat())];return `<?xml version="1.0"?><scpd xmlns="urn:schemas-upnp-org:service-1-0"><specVersion><major>1</major><minor>0</minor></specVersion><actionList>${Object.entries(actions).map(([name,args])=>`<action><name>${name}</name><argumentList>${args.map(arg=>`<argument><name>${arg}</name><direction>out</direction><relatedStateVariable>${arg}</relatedStateVariable></argument>`).join('')}</argumentList></action>`).join('')}</actionList><serviceStateTable>${names.map(name=>`<stateVariable sendEvents="no"><name>${name}</name><dataType>string</dataType></stateVariable>`).join('')}</serviceStateTable></scpd>`;}
 start(){return this.transition=this.transition.then(()=>this.startService(),()=>this.startService());}
 async startService(){
  if(this.server?.listening)return;this.server=net.createServer(socket=>this.accept(socket));
  try{await new Promise((resolve,reject)=>{this.server.once('error',reject);this.server.listen(this.port,'0.0.0.0',resolve);});this.port=this.server.address().port;this.server.on('error',()=>{});
   castState.on('stateChange',this.onState);castState.on('mediaEnded',this.onEnded);this.timer=setInterval(()=>{for(const client of this.clients){this.send(client,codec.ping(++client.counter));this.broadcastTo(client,castState.getSnapshot());}},1000);this.timer.unref();
   castState.setProtocolStatus('bilibili',{active:true,port:this.port,lastError:null,experimental:true});
  }catch(error){this.server=null;castState.setProtocolStatus('bilibili',{active:false,lastError:error.code||error.message,experimental:true});throw error;}
 }
 accept(socket){
  if(this.sockets.size>=8){socket.destroy();return;}this.sockets.add(socket);socket.setTimeout(90000,()=>socket.destroy());socket.on('error',()=>{});socket.on('close',()=>this.sockets.delete(socket));
  let prefix=Buffer.alloc(0);
  const route=bytes=>{
   prefix=Buffer.concat([prefix,bytes]);const space=prefix.indexOf(32);if(space<0){if(prefix.length>32)socket.destroy();return;}
   const method=prefix.toString('ascii',0,space);socket.off('data',route);
   if(['SETUP','RESTORE','STARTRESTORE'].includes(method)){this.connectClient(socket,prefix);return;}
   socket.pause();socket.unshift(prefix);this.http.emit('connection',socket);socket.resume();
  };
  socket.on('data',route);
 }
 connectClient(socket,first){
  const client={socket,buffer:Buffer.alloc(0),decoder:new codec.Decoder(),ready:false,counter:0,pending:0};
  socket.on('close',()=>{this.clients.delete(client);if(this.pendingClient===client){this.controller?.abort();this.serial++;}});
  const data=bytes=>{try{
   if(!client.ready){
    client.buffer=Buffer.concat([client.buffer,bytes]);const end=client.buffer.indexOf('\r\n\r\n');if(end<0){if(client.buffer.length>8192)throw failure('握手数据过大');return;}if(end>8192)throw failure('握手数据过大');
    const lines=client.buffer.toString('ascii',0,end).split('\r\n'),firstLine=lines.shift();
    if(!/^(SETUP|RESTORE|STARTRESTORE) \/projection (NVA|HTTP)\/1\.[01]$/.test(firstLine))throw failure('握手格式无效');
    const headers={};for(const line of lines){const at=line.indexOf(':');if(at>0)headers[line.slice(0,at).toLowerCase()]=line.slice(at+1).trim();}
    if(!validId(headers.session)||!validId(headers.uuid))throw failure('会话编号无效');
    client.uuid=headers.uuid;client.session=headers.session;const key=client.uuid+'\0'+client.session;
    for(const previous of this.clients)if(previous.uuid===client.uuid)previous.socket.destroy();
    const previousRecord=this.sessions.get(key);client.record=previousRecord||{sessionId:null};this.sessions.delete(key);this.sessions.set(key,client.record);while(this.sessions.size>32)this.sessions.delete(this.sessions.keys().next().value);
    client.ready=true;this.clients.add(client);this.logProbe(firstLine.split(' ')[0],socket.remoteAddress);const protocol=firstLine.includes('NVA/')?'NVA/1.0':'HTTP/1.0';
    this.send(client,Buffer.from(`${protocol} 200 OK\r\nNvaVersion: 1\r\nSession: ${client.session}\r\nUUID: ${this.identity()}\r\nConnection: Keep-Alive\r\nContent-Length: 0\r\n\r\n`));
    bytes=client.buffer.subarray(end+4);client.buffer=Buffer.alloc(0);this.broadcastTo(client,castState.getSnapshot());this.mediaInfo(client);
    if(!previousRecord&&!firstLine.startsWith('SETUP ')){this.notify(client,'OnPlayState',{playState:7});this.notify(client,'OnProgress',{duration:0,position:0});}
   }
   for(const frame of client.decoder.push(bytes)){
    if(frame.kind==='ping'){this.send(client,codec.response(frame.id));continue;}if(frame.kind!=='command')continue;
    if(client.pending>=32)throw failure('待处理指令过多');client.pending++;this.logProbe(String(frame.method).slice(0,48),socket.remoteAddress);
    const switching=frame.method==='SwitchQn'||frame.method==='SwitchQuality',early=frame.method==='Play'||frame.method==='PlayUrl'||switching;if(early){this.send(client,codec.response(frame.id));this.notify(client,'OnPlayState',{playState:3});}
    const operation=this.handle(client,frame.method,frame.data||{}),generation=this.serial;
    operation.then(result=>{if(!early)this.send(client,codec.response(frame.id,result));}).catch(error=>{
     const result={code:error.code||500,message:String(error.message).replace(/https?:\/\/\S+/g,'[URL]').slice(0,160)};
     if(switching){this.mediaInfo(client);this.notify(client,'OnPlayState',{playState:castState.getSnapshot().status==='PAUSED'?5:4,error:result.message});}
     else if(early)this.notify(client,'OnPlayState',{playState:7,error:result.message});else this.send(client,codec.response(frame.id,result));
    }).finally(()=>{client.pending--;if(early&&generation===this.serial&&this.pendingClient===client){this.controller=null;this.pendingClient=null;this.pendingSnapshot=null;}});
   }
  }catch{socket.destroy();}};
  socket.on('data',data);data(first);
 }
 send(client,bytes){if(client.socket.destroyed)return;if(client.socket.writableLength>256*1024){client.socket.destroy();return;}client.socket.write(bytes);}
 notify(client,method,data){this.send(client,codec.command(++client.counter,method,data));}
 mediaInfo(client){
  const media=client.record?.media;if(!media||client.record.sessionId!==castState.getSnapshot().sessionId)return;
  const qn=media.nva||{curQn:0,userDesireQn:0,supportQnList:[{quality:0,description:'自动',displayDesc:'自动',needLogin:false,needVip:false,superscript:''}]};
  this.notify(client,'OnEpisodeSwitch',{playItem:media.playItem||{},qnDesc:qn,title:media.title||'B站投屏'});this.notify(client,'OnQnSwitch',qn);
  this.notify(client,'SpeedChanged',{currSpeed:castState.getSnapshot().playbackRate,supportSpeedList:[0.5,0.75,1,1.25,1.5,2]});
  this.notify(client,'OnDanmakuSwitch',{open:castState.getSnapshot().danmakuEnabled!==false});
 }
 broadcast(snapshot){for(const client of this.clients)this.broadcastTo(client,snapshot);}
 broadcastTo(client,snapshot){
  if(client.record.sessionId!==snapshot.sessionId){if(client.record.sessionId!=null&&client.lastStatus!=='STOPPED'){this.notify(client,'OnPlayState',{playState:7});client.lastStatus='STOPPED';}return;}
  this.notify(client,'OnProgress',{duration:Math.max(0,Math.floor(snapshot.duration)),position:Math.max(0,Math.floor(snapshot.position))});
  if(client.lastDanmaku!==snapshot.danmakuEnabled){this.notify(client,'OnDanmakuSwitch',{open:snapshot.danmakuEnabled!==false});client.lastDanmaku=snapshot.danmakuEnabled;}
  if(client.lastStatus!==snapshot.status||client.lastSession!==snapshot.sessionId){this.notify(client,'OnPlayState',{playState:({LOADING:3,PLAYING:4,PAUSED:5,IDLE:7,STOPPED:7})[snapshot.status]||7});if(snapshot.status==='PLAYING')this.notify(client,'PLAY_SUCCESS');client.lastStatus=snapshot.status;client.lastSession=snapshot.sessionId;}
 }
 owns(client){const snapshot=castState.getSnapshot();if(snapshot.url&&client.record.sessionId!==snapshot.sessionId)throw failure('播放已切换，请重新投放',409);return snapshot;}
 async handle(client,method,params,playOptions={}){
  if(method==='GetVolume')return {volume:castState.getSnapshot().volume};
  if(method==='GetTVInfo'||method==='GetTvInfo')return {name:'MobileTV',uuid:this.identity(),version:'1',signedIn:this.getAccount().signedIn===true,capability:0};
  if(method==='Play'||method==='PlayUrl'){
   this.controller?.abort();const controller=this.controller=new AbortController(),serial=++this.serial;this.pendingSnapshot=castState.getSnapshot();this.pendingClient=client;
   const signal=AbortSignal.any([controller.signal,AbortSignal.timeout(15000)]);
   let media;if(method==='PlayUrl'&&params.url){
    const url=new URL(params.url),extra=url.searchParams.get('nva_ext')||url.searchParams.get('_nva_ext_');
    if(extra){const parsed=JSON.parse(extra);params=parsed.content||parsed;media=await this.resolveMedia(params,signal);}
    else media={url:mediaUrl(params.url,client.socket.remoteAddress),headers:{},title:String(params.title||'B站投屏').slice(0,200)};
   }else{if(!this.resolveMedia)throw failure('播放解析尚未配置',501);media=await this.resolveMedia(params,signal);}
   if(serial!==this.serial||signal.aborted||client.socket.destroyed)throw failure('播放请求已取消',409);
   if(playOptions.switching&&Number(params.qn)>0&&media.nva&&Number(media.nva.curQn)!==Number(params.qn)){
    const currentQn=client.record.media?.nva?.curQn||0;if(client.record.media)client.record.media.nva={...media.nva,curQn:currentQn};this.mediaInfo(client);const snapshot=castState.getSnapshot();
    castState.addLog('BilibiliCast','所选画质暂不可用，保留当前播放',{requestedQn:Number(params.qn),returnedQn:media.nva.curQn,currentQn});
    this.notify(client,'OnPlayState',{playState:snapshot.status==='PAUSED'?5:4});
    castState.emit('command',{type:'notice',sessionId:snapshot.sessionId,message:'平台未提供所选画质，继续使用当前可用画质。'});this.controller=null;this.pendingClient=null;this.pendingSnapshot=null;return;
   }
   this.setting=true;let snapshot;
   const mimeType=media.mimeType||require('../content/catalog').mediaHint(media.url);
   try{snapshot=castState.setMedia({url:mediaHeaders.mediaUrl(media.url,media.headers||{},media.audioUrl||'',mimeType),protocol:'BilibiliCast',mediaType:'video',metadata:{title:media.title||'B站投屏',mimeType,duration:Number(media.duration)||0,isLive:Boolean(media.isLive),bilibili:media.playItem||null},clientIp:client.socket.remoteAddress.replace(/^::ffff:/,''),clientName:'B站兼容投屏',autoPlay:true,startPosition:Math.max(0,Number(params.seekTs)||0),startPositionUnit:'seconds'});if(playOptions.paused)snapshot=castState.pause('BilibiliCast');}finally{this.setting=false;}
   this.current={sessionId:snapshot.sessionId};client.record.sessionId=snapshot.sessionId;client.record.media=media;client.record.playParams={...params};this.controller=null;this.pendingClient=null;this.pendingSnapshot=null;
   if(media.nva)castState.addLog('BilibiliCast','播放画质已协商',{requestedQn:Number(params.qn)||0,actualQn:media.nva.curQn,delegatedSession:Boolean(params.accessKey||params.access_key)});
   this.mediaInfo(client);this.broadcast(snapshot);return;
  }
  this.owns(client);
  if(method==='SwitchDanmaku'){castState.setDisplayOptions({danmakuEnabled:!(params.open===false||params.open==='false'||params.open===0)});return;}
  if(method==='SendDanmaku'){
   const text=String(params.content||'').slice(0,160);if(text)castState.emit('command',{type:'danmaku',sessionId:castState.getSnapshot().sessionId,text,mode:[4,5,6].includes(Number(params.type))?Number(params.type):1,size:Math.max(16,Math.min(36,Number(params.size)||25)),color:(Number(params.color)>>>0)&0xffffff});return;
  }
  if(method==='SwitchQn'||method==='SwitchQuality'){
   const qn=Number(params.qn??params.Qn),snapshot=castState.getSnapshot();if(!Number.isInteger(qn)||qn<0||qn>100000||!client.record.playParams)throw failure('画质参数无效');
   return this.handle(client,'Play',{...client.record.playParams,qn,seekTs:snapshot.position},{paused:snapshot.status==='PAUSED',switching:true});
  }
  if(method==='SetVolume'){const volume=Number(params.volume);if(!Number.isFinite(volume)||volume<0||volume>100)throw failure('音量无效');castState.setVolume(volume,'BilibiliCast');return;}
  if(method==='Pause'){castState.pause('BilibiliCast');return;}
  if(method==='Resume'){castState.play('BilibiliCast');return;}
  if(method==='Stop'){++this.serial;this.controller?.abort();this.controller=null;this.pendingClient=null;this.pendingSnapshot=null;client.record.playParams=null;client.record.media=null;castState.stop('BilibiliCast');return;}
  if(method==='Seek'){if(!Number.isFinite(Number(params.seekTs)))throw failure('进度无效');castState.seek(Number(params.seekTs),'BilibiliCast');return;}
  if(method==='SwitchSpeed'){const speed=Number(params.speed);if(!Number.isFinite(speed)||speed<0.25||speed>4)throw failure('倍速无效');castState.setDisplayOptions({playbackRate:speed});this.notify(client,'SpeedChanged',{currSpeed:speed,supportSpeedList:[0.5,0.75,1,1.25,1.5,2]});return;}
  throw failure('此实验版本暂未支持该指令',501);
 }
 stop(){return this.transition=this.transition.then(()=>this.stopService(),()=>this.stopService());}
 async stopService(){
  ++this.serial;this.controller?.abort();clearInterval(this.timer);castState.off('stateChange',this.onState);castState.off('mediaEnded',this.onEnded);
  if(this.current?.sessionId===castState.getSnapshot().sessionId)castState.stop('BilibiliCast');
  for(const socket of this.sockets)socket.destroy();this.clients.clear();this.sockets.clear();this.sessions.clear();this.probeTimes.clear();this.current=null;this.controller=null;this.pendingClient=null;this.pendingSnapshot=null;
  if(this.server){await new Promise(resolve=>this.server.close(resolve));this.server=null;}
  castState.setProtocolStatus('bilibili',{active:false,port:this.port,experimental:true});
 }
}
module.exports={BilibiliCastService,NVA};
