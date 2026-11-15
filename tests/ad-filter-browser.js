const assert = require('assert/strict'); const fs = require('fs'); const os = require('os'); const path = require('path'); const http = require('http'); const crypto = require('crypto');
const { execFileSync } = require('child_process');
const { browserDriver } = require('./browser-driver');
const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV encrypted ads '));
process.env.MOBILETV_DATA_DIR = path.join(directory, 'data');
const { createAppServer } = require('../src/server');
async function run() {
  let upstream, receiver, browser;
  try {
    execFileSync('ffmpeg', ['-hide_banner','-loglevel','error','-f','lavfi','-i','testsrc2=size=320x180:rate=25:duration=12','-c:v','libx264','-preset','ultrafast','-g','50','-sc_threshold','0','-hls_time','2','-hls_playlist_type','vod','-hls_segment_filename',path.join(directory,'seg-%03d.ts'),path.join(directory,'test.m3u8')], {windowsHide:true,timeout:60000});
    const key = crypto.randomBytes(16), files = fs.readdirSync(directory).filter(f=>f.endsWith('.ts')).sort(), media = new Map();
    files.forEach((file,index)=>{const iv=Buffer.alloc(16);iv.writeUInt32BE(index,12);const cipher=crypto.createCipheriv('aes-128-cbc',key,iv);media.set(file,Buffer.concat([cipher.update(fs.readFileSync(path.join(directory,file))),cipher.final()]));});
    let playlist = fs.readFileSync(path.join(directory,'test.m3u8'),'utf8').replace('#EXT-X-MEDIA-SEQUENCE:0','#EXT-X-MEDIA-SEQUENCE:0\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"').replace(files[2],'https://ads.example.test/ad.ts');
    upstream = http.createServer((req,res)=>{const name=path.basename(req.url.split('?')[0]);if(name==='config'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({sites:[],ads:['ads.example.test']}));}else if(name==='test.m3u8'){res.setHeader('Content-Type','application/vnd.apple.mpegurl');res.end(playlist);}else if(name==='key.bin')res.end(key);else if(media.has(name)){res.setHeader('Content-Type','video/mp2t');res.end(media.get(name));}else{res.statusCode=404;res.end();}});
    await new Promise(resolve=>upstream.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+upstream.address().port;
    receiver = await createAppServer({port:0,enableDlna:false,enableAirplay:false,enableTvbox:false});const base='http://127.0.0.1:'+receiver.port;
    await fetch(base+'/api/library/config',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({url:origin+'/config'})});
    browser=await browserDriver(path.join(directory,'browser'));await browser.navigate(base);await browser.wait('window.MobileTVPlayerState && document.getElementById("adFilterEnabled")?.checked');
    const response=await fetch(base+'/api/control',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({action:'cast',url:origin+'/test.m3u8',title:'Encrypted HLS ad filter fixture'})});assert.equal(response.status,200);
    await browser.wait('tvVideo.videoWidth===320 && tvVideo.currentTime>6 && !tvVideo.paused',30000);
    const playback=await browser.evaluate('({time:tvVideo.currentTime,duration:tvVideo.duration,width:tvVideo.videoWidth,error:tvVideo.error?.message})');assert.ok(Math.abs(playback.duration-10)<0.2,JSON.stringify(playback));assert.ok(!playback.error);
    await browser.evaluate('document.getElementById("playerOptions").open=true;document.getElementById("adFilterSettings").click()');await browser.wait('document.getElementById("adFilterDialog").open');
    assert.ok((await browser.evaluate('document.getElementById("adFilterDialog").innerText')).includes('1'));
    const previews=path.resolve('data/ui-previews');fs.mkdirSync(previews,{recursive:true});await browser.screenshot(path.join(previews,'ad-filter-settings.png'));
    await browser.evaluate('document.getElementById("adFilterDomains").value="extra.ads.example.test";document.querySelector("#adFilterDialog form").requestSubmit()');await browser.wait('!document.getElementById("adFilterDialog").open');
    await browser.wait('document.getElementById("adFilterSettings") && !document.querySelector("#adFilterDialog button[type=submit]").disabled');
    const settings=await(await fetch(base+'/api/adfilter')).json();assert.deepEqual(settings.domains,['extra.ads.example.test']);assert.ok(settings.stats.segments>=1);
    console.log('PASS: real Edge plays AES-128 HLS across a removed ad, preserves implicit IV decryption, shortens duration, and saves filtering rules in the UI');
  } finally {if(browser)await browser.close();if(receiver)await receiver.close();if(upstream){upstream.closeAllConnections();await new Promise(resolve=>upstream.close(resolve));}const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('MobileTV encrypted ads '));try{fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch(e){if(!['EBUSY','EPERM','ENOTEMPTY'].includes(e.code))throw e;}}
}
run().catch(error=>{console.error(error);process.exitCode=1;});
