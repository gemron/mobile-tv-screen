// Dedicated Chromium profile for source verification and JavaScript players.
// Uses the browser's renderer sandbox; never evaluates source scripts in Node.
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { randomUUID } = require('crypto');
const WebSocket = require('ws');
const { setTimeout: delay } = require('timers/promises');
const { webUrl, cleanHeaders } = require('./format');

class SourceBrowser {
  constructor(dataDir) { this.profile = path.resolve(dataDir, 'source-browser'); this.pending = new Map(); this.sequence = 0; this.queue = Promise.resolve(); this.closed = false; }
  async start(visible = false) {
    if(this.closed)throw new Error('站点浏览器已关闭');
    if(this.starting)await this.starting;
    if (this.socket?.readyState === WebSocket.OPEN && (!visible || this.visible)) return;
    const starting=(async()=>{
      if(this.closed)throw new Error('站点浏览器已关闭');
      if(this.socket?.readyState!==WebSocket.OPEN)await this.reconnect();
      if(this.socket?.readyState===WebSocket.OPEN&&(!visible||this.visible))return;
      if(this.socket||this.child)await this.stop();
      await this.launch(visible);
    })();
    this.starting=starting;
    try { await starting; } finally { if(this.starting===starting)this.starting = null; }
  }
  async reconnect(endpoint){
    try{
      if(!endpoint){
        const file=path.join(this.profile,'DevToolsActivePort');if(fs.statSync(file).size>2048)return false;
        const [port,route]=fs.readFileSync(file,'utf8').trim().split(/\r?\n/);
        if(!/^\d{1,5}$/.test(port)||Number(port)<1||Number(port)>65535||!/^\/devtools\/browser\/[a-f\d-]+$/i.test(route||''))return false;
        endpoint='ws://127.0.0.1:'+port+route;
      }
      await this.connect(endpoint);return true;
    }catch{return false;}
  }
  async connect(endpoint){
    const socket=this.socket=new WebSocket(endpoint,{maxPayload:8*1024*1024,handshakeTimeout:2000});
    socket.on('message',raw=>{
      let msg;try{msg=JSON.parse(raw);}catch{return;}
      const pending=this.pending.get(msg.id);
      if(pending?.socket===socket){clearTimeout(pending.timer);this.pending.delete(msg.id);msg.error?pending.reject(new Error(pending.method+': '+msg.error.message)):pending.resolve(msg.result);}
      else if(this.socket===socket)this.events?.(msg);
    });
    socket.on('error',()=>{});
    socket.on('close',()=>{
      for(const [id,item]of this.pending)if(item.socket===socket){clearTimeout(item.timer);item.reject(new Error('站点浏览器连接已关闭，请重试'));this.pending.delete(id);}
      if(this.socket===socket){this.socket=null;this.visible=false;}
    });
    try{
      await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
      const version=await this.command('Browser.getVersion');this.visible=!/Headless/i.test(version.userAgent||'');
    }catch(error){if(this.socket===socket)this.socket=null;socket.terminate();throw error;}
  }
  async launch(visible) {
    if (this.closed) throw new Error('站点浏览器已关闭');
    const executable = [process.env.MOBILETV_BROWSER_PATH, 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe', '/usr/bin/chromium', '/usr/bin/google-chrome'].find(p=>p&&fs.existsSync(p));
    if (!executable) throw new Error('此源需要浏览器解析，请安装 Microsoft Edge 或配置 MOBILETV_BROWSER_PATH');
    fs.mkdirSync(this.profile,{recursive:true}); this.visible=visible;
    // Chromium resolves relative profile paths against its own installation,
    // which can surface an interactive error even during a headless launch.
    fs.accessSync(this.profile,fs.constants.R_OK|fs.constants.W_OK);
    const probe=path.join(this.profile,'.mobiletv-write-'+randomUUID());
    try{fs.writeFileSync(probe,'ok',{flag:'wx',mode:0o600});}catch{throw new Error('站点浏览器数据目录不可写，请在设置中选择可写的数据目录');}finally{try{fs.unlinkSync(probe);}catch{}}
    const args=['--no-first-run','--no-default-browser-check','--autoplay-policy=no-user-gesture-required','--remote-debugging-port=0','--user-data-dir='+this.profile,'about:blank'];
    if(!visible) args.unshift('--headless=new');
    const child=this.child=spawn(executable,args,{windowsHide:!visible,stdio:['ignore','ignore','pipe']});
    let output='',endpoint='',spawnError,exitedAt=0;
    child.once('error',error=>{spawnError=error;});child.once('exit',()=>{exitedAt=Date.now();});
    child.stderr.on('data',chunk=>{output=(output+chunk).slice(-12000);endpoint=/DevTools listening on (ws:\/\/\S+)/.exec(output)?.[1]||'';});
    const deadline=Date.now()+15000;
    while(Date.now()<deadline){
      if(this.closed)throw new Error('站点浏览器已关闭');
      // Edge can exit its launcher while the actual browser keeps running.
      // The profile endpoint, rather than the launcher PID, determines readiness.
      if(await this.reconnect(endpoint||undefined))return;
      if(spawnError)throw spawnError;
      if(exitedAt&&child.exitCode!==0&&Date.now()-exitedAt>1500)throw new Error('站点浏览器未能启动，请关闭该应用的站点浏览器窗口后重试');
      await delay(100);
    }
    if(child.exitCode===null)child.kill();throw new Error('站点浏览器启动超时，请重试');
  }
  command(method,params={},sessionId){return new Promise((resolve,reject)=>{const socket=this.socket;if(socket?.readyState!==WebSocket.OPEN){reject(new Error('站点浏览器未连接'));return;}const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('站点浏览器请求超时'));},12000);this.pending.set(id,{resolve,reject,timer,method,socket});socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
  async cookies(url){if(this.socket?.readyState!==WebSocket.OPEN)return '';const result=await this.command('Storage.getCookies'),target=new URL(url),host=target.hostname;return (result.cookies||[]).filter(c=>{const domain=c.domain.replace(/^\./,''),path=c.path||'/';return (host===domain||(c.domain.startsWith('.')&&host.endsWith('.'+domain)))&&(!c.secure||target.protocol==='https:')&&(!c.expires||c.expires<0||c.expires>Date.now()/1000)&&(target.pathname===path||target.pathname.startsWith(path.endsWith('/')?path:path+'/'));}).map(c=>c.name+'='+c.value).join('; ');}
  async open(address){await this.start(true);await this.command('Target.createTarget',{url:webUrl(address)});return {opened:true};}
  async clearLogin(addresses){
    await this.start();const hosts=addresses.map(address=>new URL(address).hostname),matches=host=>hosts.some(root=>host===root||host.endsWith('.'+root));
    const targets=await this.command('Target.getTargets');
    for(const target of targets.targetInfos||[])try{if(target.type==='page'&&matches(new URL(target.url).hostname))await this.command('Target.closeTarget',{targetId:target.targetId});}catch{}
    const stored=await this.command('Storage.getCookies'),cookies=(stored.cookies||[]).filter(c=>matches(c.domain.replace(/^\./,''))).map(c=>({name:c.name,value:'',domain:c.domain,path:c.path||'/',expires:1,...(c.partitionKey?{partitionKey:c.partitionKey}:{})}));
    if(cookies.length)await this.command('Storage.setCookies',{cookies});
    const target=await this.command('Target.createTarget',{url:'about:blank'});
    const session=(await this.command('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
    try{for(const origin of new Set(addresses.map(address=>new URL(address).origin)))await this.command('Storage.clearDataForOrigin',{origin,storageTypes:'local_storage,indexeddb'},session);}
    finally{await this.command('Target.closeTarget',{targetId:target.targetId});}
  }
  async loginTokens(address){
    await this.start();
    const origin=new URL(address).origin,targets=await this.command('Target.getTargets');let tab=targets.targetInfos?.find(t=>t.type==='page'&&t.url.startsWith(origin+'/')),created=false;
    if(!tab){const target=await this.command('Target.createTarget',{url:webUrl(address)});tab={targetId:target.targetId};created=true;}
    const session=(await this.command('Target.attachToTarget',{targetId:tab.targetId,flatten:true})).sessionId;
    try{
      if(created)await delay(1000);
      const response=await this.command('Runtime.evaluate',{expression:'(()=>{const result={};for(const key of ["token","refresh_token","access_token","aliyundrive_token","alipan_token"]){try{const v=localStorage.getItem(key);if(v)result[key]=v}catch{}}return result})()',returnByValue:true},session);
      const result={};
      const walk=(value,depth=0)=>{if(depth>4||!value||typeof value!=='object')return;for(const [key,v]of Object.entries(value)){if(['access_token','refresh_token','accessToken','refreshToken'].includes(key)&&typeof v==='string')result[/^access/.test(key)?'accessToken':'refreshToken']=v;else if(typeof v==='object')walk(v,depth+1);else if(typeof v==='string'&&/^[\[{]/.test(v))try{walk(JSON.parse(v),depth+1);}catch{}}};
      walk(response.result?.value);return result;
    }finally{try{await this.command('Target.detachFromTarget',{sessionId:session});if(created)await this.command('Target.closeTarget',{targetId:tab.targetId});}catch{}}
  }
  run(address,options={}) {
    const task=this.queue.catch(()=>{}).then(()=>this.navigate(address,options));this.queue=task.catch(()=>{});return task;
  }
  async navigate(address,{media=false,signal,timeout=30000,selectText='',folders=[],headers:configured={},click=''}={}) {
    await this.start();if(signal?.aborted)throw signal.reason;
    const url=webUrl(address),target=await this.command('Target.createTarget',{url:'about:blank'});
    const session=(await this.command('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
    const requests=new Map(),started=new Map(),candidates=[],deadline=Date.now()+timeout;
    const evaluate=async expression=>{const r=await this.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);return r.result?.value;};
    this.events=event=>{
      if(event.sessionId!==session)return;
      if(event.method==='Fetch.requestPaused'){
        const request=event.params.request,added=new URL(request.url).origin===new URL(url).origin?cleanHeaders(configured):{};
        const headers=Object.entries({...Object.fromEntries(Object.entries(request.headers).map(([key,value])=>[key.toLowerCase(),String(value)])),...added}).map(([name,value])=>({name,value}));
        if(event.params.networkId)requests.set(event.params.networkId,Object.fromEntries(headers.map(h=>[h.name,h.value])));
        this.command('Fetch.continueRequest',{requestId:event.params.requestId,headers},session).catch(()=>{});
      }
      if(event.method==='Network.requestWillBeSent'){requests.set(event.params.requestId,event.params.request.headers);started.set(event.params.requestId,Date.now());}
      if(event.method==='Network.responseReceived'){
        const r=event.params.response;
        if(r.status>=200&&r.status<300&&/^https?:/.test(r.url)&&(/mpegurl|video\/(?:mp4|x-flv)|audio\/mpeg/i.test(r.mimeType)||/\.(m3u8|mp4|flv)(?:[?#]|$)/i.test(r.url))&&!/\/(?:ads?|advert|preview)\//i.test(r.url))candidates.push({url:r.url,mime:r.mimeType,headers:requests.get(event.params.requestId)||{},time:Date.now(),started:started.get(event.params.requestId)||Date.now()});
      }
    };
    try{
      await this.command('Page.enable',{},session);await this.command('Network.enable',{},session);
      if(Object.keys(cleanHeaders(configured)).length)await this.command('Fetch.enable',{patterns:[{urlPattern:'http*',requestStage:'Request'}]},session);
      if(cleanHeaders(configured)['user-agent'])await this.command('Network.setUserAgentOverride',{userAgent:cleanHeaders(configured)['user-agent']},session);
      await this.command('Page.navigate',{url},session);
      let documentReady=0,clicked=false,selected=!selectText,selectedAt=selectText?Infinity:0,folderIndex=0,nextSelection=0;
      const directoryNames=Array.isArray(folders)?folders.filter(name=>typeof name==='string').slice(0,12):[];
      const selectByName=async name=>evaluate(`(()=>{const name=${JSON.stringify(name)},match=e=>(e.getAttribute('title')||e.textContent||'').trim()===name;const e=Array.from(document.querySelectorAll('.file-click-wrap')).find(match)||Array.from(document.querySelectorAll('[title],a,span,div')).find(match);if(!e)return false;e.scrollIntoView({block:'center'});e.click();e.dispatchEvent(new MouseEvent('dblclick',{bubbles:true,view:window,button:0,detail:2}));return true})()`);
      while(Date.now()<deadline){
        if(this.closed||signal?.aborted)throw signal?.reason||new Error('站点浏览器已关闭');
        const state=await evaluate('({ready:document.readyState,title:document.title,html:document.documentElement?.outerHTML,url:location.href,video:document.querySelector("video")?.currentSrc,saveRequired:/该文件暂不支持预览[，,]?请保存至网盘后查看/.test(document.body?.innerText||"")})');
        if(state?.ready==='complete')documentReady ||= Date.now();
        if(media&&documentReady&&!selected&&Date.now()>=nextSelection){const selectionTime=Date.now();selected=await selectByName(selectText);if(selected)selectedAt=selectionTime;else if(folderIndex<directoryNames.length&&await selectByName(directoryNames[folderIndex])){folderIndex++;nextSelection=Date.now()+500;}}
        if(!media&&documentReady&&Date.now()-documentReady>1500){
          if(/人机验证|Just a moment|Checking your browser|Access denied|Attention Required/i.test((state.title||'')+' '+(state.html||'').slice(0,1800)))throw Object.assign(new Error('请先打开站点浏览器完成人机验证或登录，再重试'),{status:428,verifyUrl:url});
          if(Buffer.byteLength(state.html||'')>4*1024*1024)throw new Error('站点页面超过 4 MiB 限制');
          return {text:state.html,body:Buffer.from(state.html||''),url:state.url,headers:{'content-type':'text/html'},cookie:await this.cookies(state.url)};
        }
        if(media&&documentReady&&selected&&!clicked){clicked=true;await evaluate('(()=>{const v=document.querySelector("video");if(v)v.play().catch(()=>{});document.querySelector(".art-video-player,.dplayer-play-icon,.vjs-big-play-button,.art-icon-playback")?.click();return true})()');}
        if(media&&selected&&state?.saveRequired&&new URL(url).hostname==='pan.quark.cn')throw Object.assign(new Error('夸克要求先保存此文件到网盘后播放，会占用你的网盘空间'),{status:428,verifyUrl:url,requiresSave:true});
        if(media&&clicked&&/^[.#\[]/.test(click)&&click.length<=256){await evaluate(`(()=>{try{document.querySelector(${JSON.stringify(click)})?.click()}catch{}return true})()`);click='';}
        const available=selected?candidates.filter(candidate=>candidate.started>=selectedAt):[];
        if(media&&available.length&&Date.now()-available.at(-1).time>1200){
          const candidate=available.find(c=>c.url===state?.video)||available.filter(c=>/mpegurl|m3u8/i.test(c.url+' '+c.mime)).at(-1)||available.at(-1);
          const headers=cleanHeaders({...candidate.headers,cookie:await this.cookies(candidate.url)});
          return {url:candidate.url,header:headers,type:candidate.mime,parse:0,credentialOrigin:new URL(candidate.url).origin};
        }
        await delay(250,undefined,{signal});
      }
      throw Object.assign(new Error(media?'浏览器未取得媒体地址，可能需要登录或手动选择线路':'站点浏览器读取超时'),{status:428,verifyUrl:url});
    }finally{this.events=null;try{await this.command('Target.closeTarget',{targetId:target.targetId});}catch{}}
  }
  async stop(){
    const socket=this.socket,child=this.child;
    const disconnected=new Promise(resolve=>{if(!socket||socket.readyState===WebSocket.CLOSED){resolve();return;}const timer=setTimeout(resolve,2000);socket.once('close',()=>{clearTimeout(timer);resolve();});});
    try{if(socket?.readyState===WebSocket.OPEN)await this.command('Browser.close');}catch{}socket?.close();
    if(this.socket===socket)this.socket=null;if(this.child===child)this.child=null;
    this.visible=false;await disconnected;
    const exited=ms=>new Promise(resolve=>{if(!child||child.exitCode!==null){resolve();return;}const done=()=>{clearTimeout(timer);resolve();};const timer=setTimeout(()=>{child.off('exit',done);resolve();},ms);child.once('exit',done);});
    await exited(2000);if(child&&child.exitCode===null){child.kill();await exited(1000);}
    if(!child||child.exitCode!==null)await delay(200);
  }
  async close(){this.closed=true;await this.starting?.catch(()=>{});await this.stop();}
}
module.exports={SourceBrowser};
