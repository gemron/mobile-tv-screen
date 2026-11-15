const assert=require('assert/strict');
const fs=require('fs');const os=require('os');const path=require('path');const http=require('http');
const {SourceBrowser}=require('../src/content/browser');
async function run(){
  const sandbox=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV source browser \u4e2d\u6587 ')),server=http.createServer((req,res)=>{res.setHeader('Content-Type','text/html; charset=utf-8');res.end('<!doctype html><title>Source browser regression</title><p>ready</p>');});
  const browser=new SourceBrowser(path.relative(process.cwd(),sandbox));
  assert.ok(path.isAbsolute(browser.profile),'Chromium must always receive an absolute profile directory');
  assert.equal(browser.profile,path.join(sandbox,'source-browser'));
  try{
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    const result=await browser.run('http://127.0.0.1:'+server.address().port,{timeout:15000});
    assert.match(result.text,/Source browser regression/);assert.match(result.text,/ready/);
    assert.ok(fs.existsSync(path.join(browser.profile,'Default')),'Isolated profile was created successfully');
    console.log('PASS: relative input becomes an absolute writable Edge profile, including spaces and Chinese characters; headless startup, navigation and shutdown work');
  }finally{
    await browser.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));
    const target=fs.realpathSync(sandbox);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(target).startsWith('MobileTV source browser '));
    try{fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch(error){if(!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code))throw error;}
  }
}
run().catch(error=>{console.error(error);process.exitCode=1;});
