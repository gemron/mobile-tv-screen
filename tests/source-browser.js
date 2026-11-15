const assert=require('assert/strict');
const fs=require('fs');const os=require('os');const path=require('path');const http=require('http');
const {SourceBrowser}=require('../src/content/browser');
async function run(){
  let protectedRequests=0;
  const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV source browser \u4e2d\u6587 ')),server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');if(req.url==='/protected'){if(req.headers['x-requested-with']!=='FixtureLogin'||req.headers.cookie!=='session=fixture'){res.statusCode=403;res.end('denied');return;}protectedRequests++;}res.end('<!doctype html><title>Source browser regression</title><p>ready</p><script>localStorage.setItem("token",JSON.stringify({accessToken:"fixture-access",refreshToken:"fixture-refresh"}))</script>');});
  const browser=new SourceBrowser(path.relative(process.cwd(),sandbox));
  assert.ok(path.isAbsolute(browser.profile),'Chromium must always receive an absolute profile directory');
  assert.equal(browser.profile,path.join(sandbox,'source-browser'));
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const result=await browser.run('http://127.0.0.1:'+server.address().port,{timeout:15000});
    assert.match(result.text,/Source browser regression/);assert.match(result.text,/ready/);
    assert.ok(fs.existsSync(path.join(browser.profile,'Default')),'Isolated profile was created successfully');
    const base='http://127.0.0.1:'+server.address().port;
    const protectedPage=await browser.run(base+'/protected',{headers:{'x-requested-with':'FixtureLogin',cookie:'session=fixture'}});assert.match(protectedPage.text,/ready/);assert.equal(protectedRequests,1,'Browser parser receives configured same-origin request headers');
    const tab=await browser.command('Target.createTarget',{url:base+'/login'});
    await new Promise(resolve=>setTimeout(resolve,500));
    assert.deepEqual(await browser.loginTokens(base+'/'),{accessToken:'fixture-access',refreshToken:'fixture-refresh'});
    await browser.command('Storage.setCookies',{cookies:[{name:'root',value:'fixture',domain:'127.0.0.1',path:'/'},{name:'private',value:'fixture',domain:'127.0.0.1',path:'/private'},{name:'other',value:'keep',domain:'example.test',path:'/'}]});
    assert.ok(!(await browser.cookies(base+'/')).includes('private='));assert.ok((await browser.cookies(base+'/private/video')).includes('private='));
    assert.equal(await browser.cookies('http://sub.example.test/'),'','Host-only cookies are not copied to subdomains');
    await browser.clearLogin([base]);assert.equal(await browser.cookies(base+'/'),'');assert.match(await browser.cookies('http://example.test/'),/other=keep/,'Logging out does not clear other provider sessions');
    console.log('PASS: relative input becomes an absolute writable Edge profile, including spaces and Chinese characters; headless startup, navigation and shutdown work');
    console.log('PASS: browser parser headers, owned-profile token sync, cookie path scope and provider-only logout');
  }finally{
    await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    const target=fs.realpathSync(sandbox);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(target).startsWith('MobileTV source browser '));
    try{fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch(error){if(!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code))throw error;}
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
