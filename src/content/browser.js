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
    if (this.socket?.readyState === WebSocket.OPEN && (!visible || this.visible)) return;
    if (this.starting) { await this.starting; if (!visible || this.visible) return; }
    if (visible && this.child) await this.stop();
    this.starting = this.launch(visible);
    try { await this.starting; } finally { this.starting = null; }
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
    const endpoint=await new Promise((resolve,reject)=>{
      let output='';const timer=setTimeout(()=>{child.kill();reject(new Error('站点浏览器启动超时'));},15000);
      child.once('error',e=>{clearTimeout(timer);reject(e);});child.once('exit',()=>{clearTimeout(timer);reject(new Error('站点浏览器已退出'));});
      child.stderr.on('data',c=>{output=(output+c).slice(-12000);const m=/DevTools listening on (ws:\/\/\S+)/.exec(output);if(m){clearTimeout(timer);resolve(m[1]);}});
    });
    const socket=this.socket=new WebSocket(endpoint,{maxPayload:8*1024*1024});
    socket.on('message',raw=>{const msg=JSON.parse(raw),pending=this.pending.get(msg.id);if(pending){clearTimeout(pending.timer);this.pending.delete(msg.id);msg.error?pending.reject(new Error(msg.error.message)):pending.resolve(msg.result);}else this.events?.(msg);});
    socket.on('close',()=>{for(const item of this.pending.values()){clearTimeout(item.timer);item.reject(new Error('站点浏览器连接已关闭'));}this.pending.clear();});
    await new Promise((resolve,reject)=>{socket.once('open',resolve);socket.once('error',reject);});
  }
  command(method,params={},sessionId){return new Promise((resolve,reject)=>{if(this.socket?.readyState!==WebSocket.OPEN){reject(new Error('站点浏览器未连接'));return;}const id=++this.sequence,timer=setTimeout(()=>{this.pending.delete(id);reject(new Error('站点浏览器请求超时'));},12000);this.pending.set(id,{resolve,reject,timer});this.socket.send(JSON.stringify({id,method,params,...(sessionId?{sessionId}:{})}));});}
  async cookies(url){if(this.socket?.readyState!==WebSocket.OPEN)return '';const result=await this.command('Storage.getCookies');const host=new URL(url).hostname;return (result.cookies||[]).filter(c=>host===c.domain.replace(/^\./,'')||host.endsWith('.'+c.domain.replace(/^\./,''))).map(c=>c.name+'='+c.value).join('; ');}
  async open(address){await this.start(true);await this.command('Target.createTarget',{url:webUrl(address)});return {opened:true};}
  async loginTokens(address){
    if(this.socket?.readyState!==WebSocket.OPEN)return {};
    const origin=new URL(address).origin,targets=await this.command('Target.getTargets'),tab=targets.targetInfos?.find(t=>t.type==='page'&&t.url.startsWith(origin+'/'));
    if(!tab)return {};
    const session=(await this.command('Target.attachToTarget',{targetId:tab.targetId,flatten:true})).sessionId;
    try{
      const response=await this.command('Runtime.evaluate',{expression:'(()=>{const result={};for(const key of ["token","refresh_token","access_token","aliyundrive_token","alipan_token"]){try{const v=localStorage.getItem(key);if(v)result[key]=v}catch{}}return result})()',returnByValue:true},session);
      const result={};
      const walk=(value,depth=0)=>{if(depth>4||!value||typeof value!=='object')return;for(const [key,v]of Object.entries(value)){if(['access_token','refresh_token'].includes(key)&&typeof v==='string')result[key==='access_token'?'accessToken':'refreshToken']=v;else if(typeof v==='object')walk(v,depth+1);else if(typeof v==='string'&&/^[\[{]/.test(v))try{walk(JSON.parse(v),depth+1);}catch{}}};
      walk(response.result?.value);return result;
    }finally{try{await this.command('Target.detachFromTarget',{sessionId:session});}catch{}}
  }
  run(address,options={}) {
    const task=this.queue.catch(()=>{}).then(()=>this.navigate(address,options));this.queue=task.catch(()=>{});return task;
  }
  async navigate(address,{media=false,signal,timeout=30000,selectText=''}={}) {
    await this.start();if(signal?.aborted)throw signal.reason;
    const url=webUrl(address),target=await this.command('Target.createTarget',{url:'about:blank'});
    const session=(await this.command('Target.attachToTarget',{targetId:target.targetId,flatten:true})).sessionId;
    const requests=new Map(),candidates=[],deadline=Date.now()+timeout;
    const evaluate=async expression=>{const r=await this.command('Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true},session);return r.result?.value;};
    this.events=event=>{
      if(event.sessionId!==session)return;
      if(event.method==='Network.requestWillBeSent')requests.set(event.params.requestId,event.params.request.headers);
      if(event.method==='Network.responseReceived'){
        const r=event.params.response;
        if(r.status>=200&&r.status<300&&/^https?:/.test(r.url)&&(/mpegurl|video\/(?:mp4|x-flv)|audio\/mpeg/i.test(r.mimeType)||/\.(m3u8|mp4|flv)(?:[?#]|$)/i.test(r.url))&&!/\/(?:ads?|advert|preview)\//i.test(r.url))candidates.push({url:r.url,mime:r.mimeType,headers:requests.get(event.params.requestId)||{},time:Date.now()});
      }
    };
    try{
      await this.command('Page.enable',{},session);await this.command('Network.enable',{},session);
      await this.command('Page.navigate',{url},session);
      let documentReady=0,clicked=false,selected=!selectText;
      while(Date.now()<deadline){
        if(this.closed||signal?.aborted)throw signal?.reason||new Error('站点浏览器已关闭');
        const state=await evaluate('({ready:document.readyState,title:document.title,html:document.documentElement?.outerHTML,url:location.href,video:document.querySelector("video")?.currentSrc})');
        if(state?.ready==='complete')documentReady ||= Date.now();
        if(media&&documentReady&&!selected){selected=await evaluate(`(()=>{const name=${JSON.stringify(selectText)};const e=Array.from(document.querySelectorAll('[title],a,span')).find(e=>(e.getAttribute('title')||e.textContent||'').trim()===name);if(!e)return false;e.click();e.dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));return true})()`);}
        if(!media&&documentReady&&Date.now()-documentReady>1500){
          if(/人机验证|Just a moment|Checking your browser|Access denied|Attention Required/i.test((state.title||'')+' '+(state.html||'').slice(0,1800)))throw Object.assign(new Error('请先打开站点浏览器完成人机验证或登录，再重试'),{status:428,verifyUrl:url});
          if(Buffer.byteLength(state.html||'')>4*1024*1024)throw new Error('站点页面超过 4 MiB 限制');
          return {text:state.html,body:Buffer.from(state.html||''),url:state.url,headers:{'content-type':'text/html'},cookie:await this.cookies(state.url)};
        }
        if(media&&documentReady&&!clicked){clicked=true;await evaluate('(()=>{const v=document.querySelector("video");if(v)v.play().catch(()=>{});document.querySelector(".art-video-player,.dplayer-play-icon,.vjs-big-play-button,.art-icon-playback")?.click();return true})()');}
        if(media&&candidates.length&&Date.now()-candidates.at(-1).time>1200){
          const selected=candidates.find(c=>c.url===state?.video)||candidates.filter(c=>/mpegurl|m3u8/i.test(c.url+' '+c.mime)).at(-1)||candidates.at(-1);
          const headers=cleanHeaders({...selected.headers,cookie:await this.cookies(selected.url)});
          return {url:selected.url,header:headers,type:selected.mime,parse:0,credentialOrigin:new URL(selected.url).origin};
        }
        await delay(250,undefined,{signal});
      }
      throw Object.assign(new Error(media?'浏览器未取得媒体地址，可能需要登录或手动选择线路':'站点浏览器读取超时'),{status:428,verifyUrl:url});
    }finally{this.events=null;try{await this.command('Target.closeTarget',{targetId:target.targetId});}catch{}}
  }
  async stop(){const socket=this.socket;try{if(socket?.readyState===WebSocket.OPEN)await this.command('Browser.close');}catch{}socket?.close();this.child?.kill();this.child=null;this.socket=null;}
  async close(){this.closed=true;await this.stop();}
}
module.exports={SourceBrowser};
