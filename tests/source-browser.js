const assert=require('assert/strict');
const fs=require('fs');const os=require('os');const path=require('path');const http=require('http');
const {SourceBrowser}=require('../src/content/browser');
async function launcherExitRegression(){
  const {EventEmitter}=require('events'),{createRequire}=require('module'),vm=require('vm');
  const source=path.resolve('src/content/browser.js'),load=createRequire(source),module={exports:{}};
  const child=new EventEmitter();child.stderr=new EventEmitter();child.exitCode=null;child.kill=()=>{throw new Error('A successful detached launcher must not be killed');};let readyAt=Infinity;
  const context={module,process:{env:{MOBILETV_BROWSER_PATH:process.execPath}},Buffer,URL,setTimeout,clearTimeout,require:id=>id==='child_process'?{spawn:()=>{readyAt=Date.now()+2000;queueMicrotask(()=>{child.exitCode=0;child.emit('exit',0);});return child;}}:load(id)};
  vm.runInNewContext(fs.readFileSync(source,'utf8'),context,{filename:source});
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV detached launcher ')),browser=new module.exports.SourceBrowser(directory);
  browser.reconnect=async()=>{if(Date.now()<readyAt)return false;browser.socket={readyState:1};return true;};
  try{await browser.start();assert.equal(browser.socket.readyState,1,'A successful launcher exit must wait for the real browser endpoint, including slow startup');}
  finally{browser.socket=null;await browser.close();const target=fs.realpathSync(directory);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(target).startsWith('MobileTV detached launcher '));fs.rmSync(target,{recursive:true,force:true});}
}
async function run(){
  await launcherExitRegression();
  let protectedRequests=0;
  const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV source browser \u4e2d\u6587 '));
  const nestedPage=`<!doctype html><meta charset="utf-8"><div id="files"></div><script>
    const show=(name,next)=>{const e=document.createElement('div');e.className='file-click-wrap';e.title=name;e.textContent=name;e.ondblclick=next;document.getElementById('files').replaceChildren(e)};
    show('Season 1',()=>show('Disc',()=>show('Movie.mp4',()=>fetch('/selected.m3u8'))));
    fetch('/background.m3u8');
  </script>`;
  const server=http.createServer((req,res)=>{
    res.setHeader('Content-Type','text/html; charset=utf-8');
    if(req.url==='/protected'){if(req.headers['x-requested-with']!=='FixtureLogin'||req.headers.cookie!=='session=fixture'){res.statusCode=403;res.end('denied');return;}protectedRequests++;}
    if(/\.m3u8$/.test(req.url)){res.setHeader('Content-Type','application/vnd.apple.mpegurl');res.end('#EXTM3U\n#EXTINF:2,\nsegment.ts\n#EXT-X-ENDLIST');return;}
    if(req.url==='/missing-file'){res.end('<!doctype html><p>No selected file</p><script>fetch("/background.m3u8")</script>');return;}
    if(req.url==='/files'){res.end(`<a title="Movie.mp4" onclick="fetch('/selected.m3u8')">Movie.mp4</a><script>fetch("/background.m3u8")</script>`);return;}
    if(req.url==='/nested'){res.end(nestedPage);return;}
    res.end('<!doctype html><title>Source browser regression</title><p>ready</p><script>localStorage.setItem("token",JSON.stringify({accessToken:"fixture-access",refreshToken:"fixture-refresh"}))</script>');
  });
  const browser=new SourceBrowser(path.relative(process.cwd(),sandbox));
  const restored=new SourceBrowser(path.relative(process.cwd(),sandbox));
  assert.ok(path.isAbsolute(browser.profile),'Chromium must always receive an absolute profile directory');
  assert.equal(browser.profile,path.join(sandbox,'source-browser'));
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const result=await browser.run('http://127.0.0.1:'+server.address().port,{timeout:15000});
    assert.match(result.text,/Source browser regression/);assert.match(result.text,/ready/);
    assert.ok(fs.existsSync(path.join(browser.profile,'Default')),'Isolated profile was created successfully');
    const base='http://127.0.0.1:'+server.address().port;
    const protectedPage=await browser.run(base+'/protected',{headers:{'x-requested-with':'FixtureLogin',cookie:'session=fixture'}});assert.match(protectedPage.text,/ready/);assert.equal(protectedRequests,1,'Browser parser receives configured same-origin request headers');
    await assert.rejects(browser.run(base+'/missing-file',{media:true,selectText:'Movie.mp4',timeout:4000}),error=>error.status===428,'Background media must not be returned before the requested file is selected');
    const chosen=await browser.run(base+'/files',{media:true,selectText:'Movie.mp4',timeout:8000});assert.equal(chosen.url,base+'/selected.m3u8','Only media requested after file selection is returned');
    const nested=await browser.run(base+'/nested',{media:true,selectText:'Movie.mp4',folders:['Season 1','Disc'],timeout:10000});assert.equal(nested.url,base+'/selected.m3u8','Browser traverses the exact directory chain before selecting nested media');
    const tab=await browser.command('Target.createTarget',{url:base+'/login'});
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.deepEqual(await browser.loginTokens(base+'/'),{accessToken:'fixture-access',refreshToken:'fixture-refresh'});
    await browser.command('Storage.setCookies',{cookies:[{name:'root',value:'fixture',domain:'127.0.0.1',path:'/'},{name:'private',value:'fixture',domain:'127.0.0.1',path:'/private'},{name:'other',value:'keep',domain:'example.test',path:'/'}]});
    assert.ok(!(await browser.cookies(base+'/')).includes('private='));assert.ok((await browser.cookies(base+'/private/video')).includes('private='));
    assert.equal(await browser.cookies('http://sub.example.test/'),'','Host-only cookies are not copied to subdomains');
    await browser.clearLogin([base]);assert.equal(await browser.cookies(base+'/'),'');assert.match(await browser.cookies('http://example.test/'),/other=keep/,'Logging out does not clear other provider sessions');
    const disconnected=new Promise(resolve=>browser.socket.once('close',resolve));browser.socket.close();await disconnected;
    await Promise.all([restored.start(),restored.start()]);assert.equal(restored.child,undefined,'A new owner reconnects to the existing profile without launching another Edge process');assert.equal(restored.visible,false);
    await restored.open(base+'/login');assert.equal(restored.visible,true,'An adopted headless browser can restart as a visible login window');
    const closed=new Promise(resolve=>restored.socket.once('close',resolve));await restored.command('Browser.close');await closed;
    await restored.open(base+'/login');assert.equal(restored.visible,true,'Closing the browser does not prevent a later login action from reopening it');
    await new Promise(resolve=>setTimeout(resolve,500));assert.deepEqual(await restored.loginTokens(base+'/'),{accessToken:'fixture-access',refreshToken:'fixture-refresh'});
    console.log('PASS: relative input becomes an absolute writable Edge profile, including spaces and Chinese characters; headless startup, navigation and shutdown work');
    console.log('PASS: browser parser headers, owned-profile token sync, cookie path scope and provider-only logout');
    console.log('PASS: orphaned-profile reconnect, concurrent startup, headless-to-visible login, manual close/reopen and preserved browser storage');
  }finally{
    await restored.close();await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    const target=fs.realpathSync(sandbox);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(target).startsWith('MobileTV source browser '));
    try{fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch(error){if(!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code))throw error;}
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
