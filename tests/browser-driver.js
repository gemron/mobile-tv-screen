const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { setTimeout: delay } = require('timers/promises');
const WebSocket = require('ws');

async function browserDriver(profile, { gpu = false, media = false, extraArgs = [], executablePath } = {}) {
  const executable = executablePath || ['C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe', 'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe'].find(file => fs.existsSync(file));
  if (!executable) throw new Error('This optional browser test requires Microsoft Edge on Windows.');
  const child = spawn(executable, ['--headless=new', ...(gpu ? [] : ['--disable-gpu']), ...extraArgs, '--hide-scrollbars', '--no-first-run', '--no-default-browser-check', '--autoplay-policy=no-user-gesture-required', '--remote-debugging-port=0', '--user-data-dir=' + profile, 'about:blank'], { windowsHide: true, stdio: ['ignore', 'ignore', 'pipe'] });
  const endpoint = await new Promise((resolve, reject) => {
    let output = '';
    const timer = setTimeout(() => { child.kill(); reject(new Error('Browser startup timed out')); }, 15000);
    child.once('error', error => { clearTimeout(timer); reject(error); });
    child.stderr.on('data', chunk => { output += chunk; const match = output.match(/DevTools listening on (ws:\/\/\S+)/); if (match) { clearTimeout(timer); resolve(match[1]); } });
  });
  const socket = new WebSocket(endpoint), pending = new Map(), networkLog=[], mediaProperties={}; let sequence = 0;
  const command = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
    const id = ++sequence, timer = setTimeout(() => { pending.delete(id); reject(new Error('CDP timeout: ' + method)); }, 15000);
    pending.set(id, { resolve, reject, timer }); socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
  });
  socket.on('message', raw => {
    const message = JSON.parse(raw), item = pending.get(message.id);
    if (message.method === 'Media.playerPropertiesChanged') {
      const properties = mediaProperties[message.params.playerId] ||= {};
      for (const property of message.params.properties) if (/^(kVideoDecoderName|kIsPlatformVideoDecoder|kVideoTracks|kAudioDecoderName|kResolution|kVideoPlaybackRoughness|kVideoPlaybackFreezing)$/.test(property.name)) properties[property.name] = property.value;
    }
    if(message.method==='Network.requestWillBeSent'){const request=message.params.request,url=new URL(request.url);networkLog.push({event:'request',id:message.params.requestId,path:url.protocol==='data:'?'[data]':url.pathname,range:request.headers.Range||request.headers.range});}
    if(message.method==='Network.responseReceived'){const response=message.params.response;networkLog.push({event:'response',id:message.params.requestId,status:response.status,type:response.mimeType,range:response.headers['Content-Range']||response.headers['content-range'],length:response.headers['Content-Length']||response.headers['content-length']});}
    if(message.method==='Network.loadingFailed')networkLog.push({event:'failed',id:message.params.requestId,error:message.params.errorText});
    if(networkLog.length>100)networkLog.splice(0,networkLog.length-100);
    if (!item) return;
    pending.delete(message.id); clearTimeout(item.timer); message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result);
  });
  await new Promise((resolve, reject) => { socket.once('open', resolve); socket.once('error', reject); });
  const target = await command('Target.createTarget', { url: 'about:blank' });
  const session = (await command('Target.attachToTarget', { targetId: target.targetId, flatten: true })).sessionId;
  await command('Page.enable', {}, session);
  await command('Network.enable', {}, session);
  if (media) await command('Media.enable', {}, session);
  await command('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1000, deviceScaleFactor: 1, mobile: false }, session);
  const evaluate = async expression => {
    const result = await command('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }, session);
    if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails)); return result.result.value;
  };
  return {
    evaluate,
    networkLog:()=>networkLog.slice(),
    mediaProperties:()=>Object.values(mediaProperties),
    async gpuDiagnostics() {const { gpu } = await command('SystemInfo.getInfo');return {devices:gpu.devices.map(({vendorString,deviceString})=>({vendorString,deviceString})),features:gpu.featureStatus,renderer:gpu.auxAttributes?.glRenderer};},
    async key(key,{shift=false}={}) {const code=key.length===1?(/^\d$/.test(key)?'Digit':'Key')+key.toUpperCase():key,virtual=({Tab:9,Enter:13,Escape:27,ArrowUp:38,ArrowDown:40,ArrowLeft:37,ArrowRight:39,PageUp:33,PageDown:34})[key]||(key.length===1?key.toUpperCase().charCodeAt(0):0);for(const type of ['keyDown','keyUp'])await command('Input.dispatchKeyEvent',{type,key,code,windowsVirtualKeyCode:virtual,nativeVirtualKeyCode:virtual,modifiers:shift?8:0},session);},
    async viewport(width, height) { await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false }, session); },
    async click(selector) {const point=await evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);await command('Input.dispatchMouseEvent',{type:'mouseMoved',...point},session);for(const type of ['mousePressed','mouseReleased'])await command('Input.dispatchMouseEvent',{type,...point,button:'left',clickCount:1},session);},
    async navigate(url) { await command('Page.navigate', { url }, session); },
    async wait(expression, timeout = 30000) {
      const deadline = Date.now() + timeout;
      while (Date.now() < deadline) { const value = await evaluate(expression); if (value) return value; await delay(150); }
      throw new Error('Browser condition timed out: ' + expression + '\n' + JSON.stringify(await evaluate('({page:document.title,error:document.querySelector("#libraryStatus")?.textContent,dialog:document.querySelector("#libraryDetailStatus")?.textContent,videoError:document.querySelector("video")?.error?.message,title:window.MobileTVPlayerState?.()?.metadata?.title,focused:document.activeElement?.textContent?.slice(0,100),drawer:document.querySelector("#libraryChannelDrawer")?.hidden})')));
    },
    async screenshot(file) { const result = await command('Page.captureScreenshot', { format: 'png' }, session); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(result.data, 'base64')); },
    async close() {
      if (socket.readyState === WebSocket.OPEN) { try { await command('Browser.close'); } catch {} socket.close(); }
      if (child.exitCode === null) { await Promise.race([new Promise(resolve => child.once('exit', resolve)), delay(2500)]); if (child.exitCode === null) child.kill(); }
      for (const item of pending.values()) { clearTimeout(item.timer); item.reject(new Error('Browser closed')); }
    },
  };
}

module.exports = { browserDriver };
