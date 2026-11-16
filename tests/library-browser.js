const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const net = require('net');
const nvaCodec = require('../src/protocols/nva-codec');
const { execFileSync } = require('child_process');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV library browser '));
process.env.MOBILETV_DATA_DIR = path.join(sandbox, 'data');
const { createAppServer } = require('../src/server');
const { rc4 } = require('../src/content/format');
const { browserDriver } = require('./browser-driver');
let origin, receiver, browser;

async function run() {
  const media = path.join(sandbox, 'media'); fs.mkdirSync(media);
  execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'testsrc2=size=640x360:rate=25:duration=12', '-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '28', '-g', '50', '-sc_threshold', '0', '-hls_time', '2', '-hls_playlist_type', 'vod', '-hls_segment_filename', path.join(media, 'seg-%03d.ts'), path.join(media, 'master.m3u8')], { windowsHide: true, timeout: 60000 });
  let originBase;
  const pendingSearch = [];
  const header = { 'User-Agent': 'DesktopNative/1.0', Referer: 'https://fixture.test/watch' };
  origin = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/config') {
      const ext = { siteUrl: originBase + '/api', type: 1, categories: ['电影', '剧集'] };
      const encoded = rc4(Buffer.from(JSON.stringify(ext).split('').map(character => String.fromCharCode(character.charCodeAt(0) + 2)).join('')), 'fantaiying921').toString('base64');
      res.end(JSON.stringify({ sites: [{ key: 'native', name: '原生点播示例', type: 3, api: 'csp_T4Guard', ext: encoded, header },{key:'quality',name:'多画质协议测试',type:4,api:originBase+'/quality'},{key:'web',name:'网页解析测试',type:4,api:originBase+'/web'},{key:'discovery',name:'豆豆片单示例',type:3,api:'csp_DouDouGuard',searchable:0,ext:{metadataApi:originBase+'/metadata/',metadataKey:'fixture'}},{key:'wogg',name:'玩偶片源示例',type:3,api:'csp_WoGGGuard',ext:{siteUrl:originBase}},{key:'slow',name:'Slow source',type:1,api:originBase+'/slow'}], lives: [{ name: '直播示例', url: originBase + '/channels', headers: header }] })); return;
    }
    if(url.pathname.startsWith('/metadata/')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({start:0,count:20,total:1,items:[{id:'meta1',title:'独立点播测试',rating:{value:8}}]}));return;}
    if(url.pathname.startsWith('/vodsearch/')){res.setHeader('Content-Type','text/html');res.end('<div class="module-search-item"><a title="独立点播测试" href="/voddetail/fixture.html">独立点播测试</a></div>');return;}
    if(url.pathname==='/slow'){const ranking=url.searchParams.get('wd')==='rank fixture';const pending={ranking,closed:false,release:()=>{if(!res.destroyed)res.end(JSON.stringify({list:[{vod_id:'slow',vod_name:ranking?'Rank Fixture':'Slow result'}]}));}};res.on('close',()=>{pending.closed=true;});pendingSearch.push(pending);return;}
    if (url.pathname === '/api') {
      const video = { vod_id: '1', vod_name: '独立点播测试', vod_remarks: '全 2 集', type_name: '电影', vod_year: '2026', vod_content: '本地合成测试片源，用于验证电脑独立播放。', vod_play_from: '原画线路', vod_play_url: `第 1 集$${originBase}/media/master.m3u8?ep=1#第 2 集$${originBase}/media/master.m3u8?ep=2` };
      video.vod_actor='Fixture Actor / Guest';if(url.searchParams.get('wd')==='rank fixture')video.vod_name='rank fixture extra';
      res.setHeader('Content-Type', 'application/json'); res.end(JSON.stringify({ class: [{ type_id: '1', type_name: '电影' }, { type_id: '2', type_name: '剧集' }], list: [video], page: Number(url.searchParams.get('pg')) || 1, pagecount: 2, total: 2 })); return;
    }
    if(url.pathname==='/quality'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(url.searchParams.has('play')?{url:['默认',originBase+'/media/master.m3u8?quality=0','备用',originBase+'/media/master.m3u8?quality=1'],parse:0,header}:{class:[],list:[{vod_id:'1',vod_name:'Rendition fixture',vod_play_from:'main',vod_play_url:'One$opaque-id'}]}));return;}
    if(url.pathname==='/web'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify(url.searchParams.has('play')?{url:'platform-token',playUrl:originBase+'/web-parse?url=',parse:1,header}:{class:[],list:[{vod_id:'1',vod_name:'Web parser fixture',vod_play_from:'main',vod_play_url:'One$opaque-id'}]}));return;}
    if (req.headers['user-agent'] !== header['User-Agent'] || req.headers.referer !== header.Referer) { res.writeHead(403); res.end('headers required'); return; }
    if(url.pathname==='/web-parse'){res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>Web parser fixture</title><script>setTimeout(()=>fetch("/media/master.m3u8?parsed=web"),200)</script>');return;}
    if (url.pathname === '/channels') { res.end(`#EXTM3U\n#EXTINF:-1 group-title="新闻",测试频道一\n${originBase}/media/master.m3u8?ch=1\n#EXTINF:-1 group-title="纪录",测试频道二\n${originBase}/media/master.m3u8?ch=2\n`); return; }
    if (url.pathname.startsWith('/media/')) {
      const file = path.join(media, path.basename(url.pathname));
      if (fs.existsSync(file)) { res.setHeader('Content-Type', file.endsWith('.m3u8') ? 'application/vnd.apple.mpegurl' : 'video/mp2t'); fs.createReadStream(file).pipe(res); return; }
    }
    res.writeHead(404); res.end();
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve)); originBase = 'http://127.0.0.1:' + origin.address().port;
  const biliResolver=async params=>({url:originBase+'/media/master.m3u8?bili='+params.cid,headers:header,mimeType:'application/vnd.apple.mpegurl',title:'NVA playback fixture',duration:12,playItem:{aid:'1',cid:String(params.cid)},episodes:[{aid:'1',cid:'2'},{aid:'1',cid:'3'}]});
  biliResolver.danmaku=async()=>[{time:1,mode:1,color:16777215,size:25,text:'Fixture <safe> comment'},{time:5,mode:5,color:255,size:25,text:'Fixed comment'}];
  receiver = await createAppServer({ port: 0, enableDlna: false, enableAirplay: false, enableTvbox: false,bilibiliPort:0,bilibiliResolveMedia:biliResolver });
  const library=receiver.app._router.stack.find(layer=>layer.handle?.library).handle.library;
  const base = 'http://127.0.0.1:' + receiver.port;
  browser = await browserDriver(path.join(sandbox, 'browser'));
  await browser.navigate(base);
  await browser.wait('document.readyState === "complete" && window.MobileTVPlayerState');
  await browser.click('#btnSettings');await browser.wait('!document.getElementById("bilibiliCastEnabled").disabled');await browser.click('#bilibiliCastEnabled');await browser.wait('document.getElementById("bilibiliCastHint").textContent.includes("已开启")');await browser.click('#btnCloseSettings');
  const nvaSocket=net.connect(receiver.bilibiliService.port,'127.0.0.1');let nvaReady=false,nvaSequence=0;nvaSocket.on('error',()=>{});nvaSocket.on('data',bytes=>{if(bytes.toString().includes('200 OK'))nvaReady=true;});
  await new Promise(resolve=>nvaSocket.once('connect',resolve));nvaSocket.write('SETUP /projection NVA/1.0\r\nSession: browser-fixture\r\nUUID: browser-phone\r\n\r\n');for(let i=0;i<200&&!nvaReady;i++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(nvaReady,true);
  const nvaCommand=(method,data)=>nvaSocket.write(nvaCodec.command(++nvaSequence,method,data));
  try{
    nvaCommand('Play',{aid:1,cid:2});await browser.wait('window.MobileTVPlayerState()?.protocol==="BilibiliCast" && tvVideo.readyState>=3 && tvVideo.currentTime>0.5 && !tvVideo.paused');assert.equal(await browser.evaluate('tvVideo.videoWidth'),640);
    await browser.wait('document.getElementById("danmakuLayer").textContent.includes("Fixture <safe> comment")');assert.equal(await browser.evaluate('document.getElementById("danmakuLayer").querySelector("safe")'),null,'Comments render as text');
    nvaCommand('SwitchDanmaku',{open:false});await browser.wait('document.getElementById("danmakuLayer").hidden');nvaCommand('SwitchDanmaku',{open:true});await browser.wait('!document.getElementById("danmakuLayer").hidden');
    nvaCommand('SendDanmaku',{content:'Immediate fixture comment',type:5,color:255});await browser.wait('document.getElementById("danmakuLayer").textContent.includes("Immediate fixture comment")');
    nvaCommand('Pause');await browser.wait('tvVideo.paused');nvaCommand('Seek',{seekTs:3});await browser.wait('Math.abs(tvVideo.currentTime-3)<0.5');nvaCommand('Resume');await browser.wait('!tvVideo.paused && tvVideo.currentTime>3');
    nvaCommand('SetVolume',{volume:42});await browser.wait('Math.abs(tvVideo.volume-0.42)<0.01');await browser.evaluate('tvVideo.currentTime=11.7');await browser.wait('window.MobileTVPlayerState()?.metadata?.bilibili?.cid==="3" && tvVideo.currentTime>0.5');nvaCommand('Stop');await browser.wait('!document.body.classList.contains("casting-active")');
  }finally{nvaSocket.destroy();}
  await browser.click('#btnSettings');await browser.wait('!document.getElementById("bilibiliCastEnabled").disabled');await browser.click('#bilibiliCastEnabled');await browser.wait('document.getElementById("bilibiliCastHint").textContent.includes("已关闭")');await browser.click('#btnCloseSettings');
  console.log('PASS: NVA settings, actual Edge playback/controls, safe timed/live comments, danmaku toggle and automatic episode advance');
  await browser.evaluate('document.querySelector("[data-library-nav=vod]").click()');
  await browser.evaluate(`document.getElementById('librarySourceUrl').value=${JSON.stringify(originBase + '/config')};document.getElementById('librarySourceForm').requestSubmit()`);
  await browser.wait('document.querySelectorAll(".vod-card").length===1');
  assert.equal(await browser.evaluate('document.querySelectorAll("#libraryCategories button").length'), 3);
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Library layout fits viewport');
  await browser.evaluate('librarySearch.value="连贯搜索";librarySearchForm.requestSubmit()');await browser.wait('!libraryResetSearch.hidden && librarySearchHint.textContent.includes("连贯搜索")');
  await browser.evaluate('librarySite.value="quality";librarySite.dispatchEvent(new Event("change"))');await browser.wait('document.querySelector(".vod-card")?.title==="Rendition fixture"');
  assert.equal(await browser.evaluate('librarySearch.value==="连贯搜索" && !librarySearchAll.checked && libraryCategories.hidden'),true,'Source switches retain the submitted keyword and apply the current-source scope');
  await browser.click('#libraryResetSearch');await browser.wait('librarySearch.value==="" && libraryResetSearch.hidden && !libraryCategories.hidden');
  await browser.evaluate('librarySite.value="native";librarySite.dispatchEvent(new Event("change"))');await browser.wait('document.querySelectorAll("#libraryCategories button").length===3');
  console.log('PASS: source/search controls retain keywords, explicitly scope results and return to recommendations in one click');
  const screenshots = path.resolve('data', 'ui-previews');
  await browser.screenshot(path.join(screenshots, 'native-library-vod.png'));
  const initialDetail=library.detail;let releaseDetail,startedDetail,finishedDetail;
  const detailGate=new Promise(resolve=>{releaseDetail=resolve;}),started=new Promise(resolve=>{startedDetail=resolve;}),finished=new Promise(resolve=>{finishedDetail=resolve;});
  library.detail=async function(...args){startedDetail();await detailGate;try{return await initialDetail.call(this,...args);}finally{finishedDetail();}};
  await browser.evaluate('document.querySelector(".vod-card").click()');await started;
  await browser.wait('document.getElementById("libraryDetail").open && !document.getElementById("libraryDetailLoading").hidden');
  assert.equal(await browser.evaluate('document.querySelectorAll(".episode-button").length'),0);assert.equal(await browser.evaluate('document.getElementById("libraryLines").disabled'),true);
  assert.equal(await browser.evaluate('document.querySelector(".detail-spinner").getAnimations().some(animation=>animation.playState==="running")'),true);
  await browser.screenshot(path.join(screenshots,'detail-loading.png'));await browser.evaluate('document.getElementById("libraryCloseDetail").click()');releaseDetail();await finished;
  assert.equal(await browser.evaluate('document.getElementById("libraryDetail").open'),false,'Cancelled detail requests cannot reopen the dialog');
  library.detail=async()=>{throw Object.assign(new Error('Fixture detail unavailable'),{status:502});};
  await browser.evaluate('document.querySelector(".vod-card").click()');
  await browser.wait('document.getElementById("libraryDetailStatus").textContent.includes("Fixture detail unavailable") && document.getElementById("libraryDetailLoading").hidden');
  library.detail=initialDetail;await browser.evaluate('document.querySelector("#libraryDetailStatus button").click()');
  await browser.wait('document.getElementById("libraryDetail").open && document.querySelectorAll(".episode-button").length===2');
  console.log('PASS: episode dialog opens immediately with animation, cancels safely and retries failed loads');
  await browser.evaluate(`window.layoutEpisodes=Array.from(libraryEpisodes.children);window.layoutClasses=libraryEpisodes.className;libraryEpisodes.classList.add('has-file-names');libraryEpisodes.replaceChildren(...Array.from({length:18},(_,i)=>{const b=layoutEpisodes[0].cloneNode(true),name='Long.Movie.Name.2026.S05E'+String(i+1).padStart(2,'0')+'.2160p.WEB-DL.DDP5.1.HDR10.H265.Multilingual.mkv';b.title=name;b.setAttribute('aria-label',name);b.querySelector('.episode-number').textContent=String(i+1).padStart(2,'0');b.querySelector('.episode-label').textContent=name;return b;}));document.documentElement.dataset.theme='dark';`);
  for(const width of [1200,768,390]){
    await browser.viewport(width,1000);
    const layout=await browser.evaluate(`({dialog:libraryDetail.scrollWidth<=libraryDetail.clientWidth+1,grid:libraryEpisodes.scrollWidth<=libraryEpisodes.clientWidth+1,rows:Array.from(libraryEpisodes.children).map(b=>Math.round(b.getBoundingClientRect().height)),titles:Array.from(libraryEpisodes.children).every(b=>b.title.length>60&&b.getAttribute('aria-label')===b.title)})`);
    assert.ok(layout.dialog&&layout.grid&&layout.titles,JSON.stringify({width,layout}));assert.equal(new Set(layout.rows).size,1,'Long filenames retain equal-height cards');
    if(width===1200)await browser.screenshot(path.resolve('data/ui-previews/episode-long-names.png'));
  }
  await browser.viewport(1440,1000);await browser.evaluate(`libraryEpisodes.replaceChildren(...layoutEpisodes);libraryEpisodes.className=layoutClasses;document.documentElement.dataset.theme='light';`);
  console.log('PASS: long episode filenames have uniform cards, full accessible titles and no horizontal overflow at desktop/tablet/mobile widths');
  await browser.evaluate(`window.originalEpisodeFetch=window.fetch;window.episodeReplies=[];
    window.fetch=(url,options)=>url==='/api/library/play'?new Promise((resolve,reject)=>{
      const entry={body:JSON.parse(options.body),signal:options.signal};window.episodeReplies.push(entry);
      entry.reply=(ok,data)=>resolve({ok,status:ok?200:502,json:async()=>{entry.processed=true;return data;}});
      entry.reject=reject;
    }):window.originalEpisodeFetch(url,options);`);
  await browser.evaluate('document.querySelectorAll(".episode-button")[0].click();document.querySelectorAll(".episode-button")[1].click()');
  assert.equal(await browser.evaluate('window.episodeReplies[0].signal.aborted'),true);
  await browser.evaluate('window.episodeReplies[0].reply(false,{error:"操作已取消或被新的请求替代"})');
  await browser.wait('window.episodeReplies[0].processed');
  assert.equal(await browser.evaluate('document.getElementById("libraryDetailStatus").classList.contains("is-resolving") && !document.getElementById("libraryDetailStatus").textContent.includes("替代")'),true);
  await browser.evaluate('window.episodeReplies[1].reply(false,{error:"Fixture current parse failure"})');
  await browser.wait('document.getElementById("libraryDetailStatus").textContent.includes("Fixture current parse failure")');
  assert.equal(await browser.evaluate('document.querySelector("#libraryDetailStatus button").textContent'),'重试本集');
  await browser.evaluate('document.querySelectorAll(".episode-button")[0].click();document.querySelectorAll(".episode-button")[1].click();document.querySelectorAll(".episode-button")[0].click();window.episodeReplies[2].reply(true,{playback:{sessionId:999}});window.episodeReplies[3].reply(false,{error:"Old episode failure"})');
  await browser.wait('window.episodeReplies[2].processed && window.episodeReplies[3].processed');
  assert.equal(await browser.evaluate('document.getElementById("libraryDetail").open && document.getElementById("libraryDetailStatus").classList.contains("is-resolving")'),true,'A 1 → 2 → 1 sequence ignores both stale success and failure');
  await browser.evaluate('window.episodeReplies[4].reply(false,{error:"Fixture latest parse failure"})');
  await browser.wait('document.getElementById("libraryDetailStatus").textContent.includes("Fixture latest parse failure")');
  await browser.evaluate('document.querySelector(".episode-button").click();document.getElementById("libraryDetail").close()');
  await browser.wait('window.episodeReplies[5].signal.aborted');
  await browser.evaluate('window.episodeReplies[5].reply(true,{playback:{sessionId:999}})');
  await browser.wait('window.episodeReplies[5].processed');
  assert.equal(await browser.evaluate('document.getElementById("libraryDetail").open'),false);
  await browser.evaluate('document.querySelector(".vod-card").click()');
  await browser.wait('document.getElementById("libraryDetail").open && document.querySelectorAll(".episode-button").length===2');
  await browser.evaluate(`window.originalEpisodeTimeout=window.setTimeout;
    window.setTimeout=(fn,ms,...args)=>window.originalEpisodeTimeout(fn,ms===45000?80:ms,...args);
    document.querySelector('.episode-button').click();
    const entry=window.episodeReplies[6];entry.signal.addEventListener('abort',()=>entry.reject(new DOMException('Aborted','AbortError')),{once:true});`);
  await browser.wait('document.getElementById("libraryDetailStatus").textContent.includes("解析等待超时")');
  assert.equal(await browser.evaluate('document.getElementById("libraryDetailStatus").classList.contains("is-resolving")'),false);
  await browser.evaluate('window.fetch=window.originalEpisodeFetch;window.setTimeout=window.originalEpisodeTimeout');
  console.log('PASS: rapid episode changes ignore stale success/errors, closing aborts parsing, and stalled requests show a bounded timeout with retry');
  await browser.evaluate('window.toastFocus=document.activeElement;window.MobileTVUI.toast("站点浏览器已退出（提示层级验证）")');
  await browser.wait('document.getElementById("toast").matches(":popover-open") && Number(getComputedStyle(document.getElementById("toast")).opacity)>0.9');
  assert.equal(await browser.evaluate('document.activeElement===window.toastFocus'),true,'A status toast does not steal keyboard focus');
  assert.equal(await browser.evaluate('(()=>{const e=document.getElementById("toast"),r=e.getBoundingClientRect();e.style.pointerEvents="auto";const top=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)===e;e.style.pointerEvents="";return top&&r.top>=0&&r.bottom<=innerHeight})()'),true,'Toast paints above a modal backdrop inside the viewport');
  await browser.screenshot(path.resolve('data/ui-previews/toast-above-detail.png'));
  await browser.evaluate('document.getElementById("keyboardDialog").showModal();window.MobileTVUI.toast("Nested dialog toast")');
  assert.equal(await browser.evaluate('document.getElementById("toast").closest("dialog").id'),'keyboardDialog');
  await browser.evaluate('document.getElementById("keyboardDialog").close()');await browser.wait('document.getElementById("toast").parentElement.id==="libraryDetail" && document.getElementById("toast").matches(":popover-open")');
  console.log('PASS: native modal toasts stay above the backdrop, preserve focus and survive nested dialog closing');
  await browser.evaluate('document.querySelector(".episode-button").click()');
  await browser.wait('window.MobileTVPlayerState()?.protocol==="Library" && tvVideo.readyState>=3 && tvVideo.currentTime>0.5 && !tvVideo.paused');
  assert.equal(await browser.evaluate('tvVideo.videoWidth'), 640);
  await browser.click('#btnMute');assert.equal(await browser.evaluate('document.documentElement.dataset.inputMode'),'pointer');
  await browser.evaluate('document.getElementById("btnFullscreen").focus()');await browser.key('k');await browser.wait('tvVideo.paused');
  assert.equal(await browser.evaluate('getComputedStyle(document.getElementById("btnFullscreen")).outlineStyle'),'none','Playback shortcuts do not leave a mouse-selected button highlighted');
  await browser.key('k');await browser.wait('!tvVideo.paused');await browser.key('Tab');
  for(let attempt=0;attempt<12&&await browser.evaluate('document.activeElement.tagName!=="BUTTON"');attempt++)await browser.key('Tab');
  assert.equal(await browser.evaluate('document.documentElement.dataset.inputMode'), 'keyboard');
  assert.equal(await browser.evaluate('document.activeElement.tagName'), 'BUTTON');assert.equal(await browser.evaluate('getComputedStyle(document.activeElement).outlineWidth'),'3px','Tab navigation keeps a visible focus indicator');
  await browser.click('#btnMute');assert.equal(await browser.evaluate('getComputedStyle(document.getElementById("btnMute")).outlineStyle'),'none');
  console.log('PASS: mouse controls and playback hotkeys avoid persistent focus rings; real Tab navigation keeps its focus indicator');
  await browser.evaluate('tvVideo.dispatchEvent(new Event("ended"))');
  await browser.wait('window.MobileTVPlayerState()?.url.includes("ep%3D2") && tvVideo.currentTime>0.5 && !tvVideo.paused');
  const playback = await (await fetch(base + '/api/library/playback')).json(); assert.equal(playback.playback.index, 1);
  console.log('PASS: real Edge imports protected-format source, browses categories/details, plays HLS with headers and automatically advances episodes');
  await browser.evaluate('document.getElementById("btnStopCast").click()');
  await browser.wait('!document.body.classList.contains("casting-active")');
  await browser.evaluate('document.querySelector("[data-library-nav=live]").click()');
  await browser.wait('document.querySelectorAll(".live-channel").length===2');
  await browser.screenshot(path.join(screenshots, 'native-library-live.png'));
  await browser.evaluate('document.querySelector(".live-channel").click()');
  await browser.wait('window.MobileTVPlayerState()?.protocol==="Live" && tvVideo.currentTime>0.5 && !tvVideo.paused');
  const liveSession = await browser.evaluate('window.MobileTVPlayerState().sessionId');
  await browser.evaluate('document.getElementById("libraryLiveSearch").dispatchEvent(new KeyboardEvent("keydown",{key:"n",bubbles:true}))');
  assert.equal(await browser.evaluate('window.MobileTVPlayerState().sessionId'), liveSession, 'Typing in search does not change channel');
  await browser.evaluate('document.dispatchEvent(new KeyboardEvent("keydown",{key:"n",bubbles:true}))');
  await browser.wait('window.MobileTVPlayerState()?.url.includes("ch%3D2") && tvVideo.currentTime>0.5 && !tvVideo.paused');
  console.log('PASS: live groups, channel list, playback and next-channel control work without a phone or Android runtime');
  await browser.evaluate('document.querySelector("[data-library-nav=vod]").click();document.getElementById("librarySite").value="quality";document.getElementById("librarySite").dispatchEvent(new Event("change"))');
  await browser.wait('document.querySelector(".vod-card")?.title==="Rendition fixture"');await browser.evaluate('document.querySelector(".vod-card").click()');await browser.wait('document.getElementById("libraryDetail").open && document.getElementById("libraryDetail").getAttribute("aria-busy")==="false"');await browser.evaluate('document.querySelector(".episode-button").click()');
  await browser.wait(`window.MobileTVPlayerState()?.url.includes('quality%3D0') && tvVideo.currentTime>2 && !tvVideo.paused && !document.getElementById('libraryQualityLabel').hidden`);
  assert.equal(await browser.evaluate('libraryPlayerPrevious.hidden && libraryPlayerNext.hidden && libraryAutoNextLabel.hidden && libraryChooseEpisode.textContent==="播放线路"'),true,'Single videos retain line selection without disabled episode controls');
  const position=await browser.evaluate('tvVideo.currentTime');await browser.evaluate('document.getElementById("libraryQuality").value="1";document.getElementById("libraryQuality").dispatchEvent(new Event("change"))');
  await browser.wait('window.MobileTVPlayerState()?.url.includes("quality%3D1") && tvVideo.currentTime>2 && !tvVideo.paused');
  assert.ok(await browser.evaluate('tvVideo.currentTime')>=position-1);console.log('PASS: rendition URL arrays appear in the player and switching resumes playback');
  await browser.evaluate('document.getElementById("btnStopCast").click()');await browser.wait('!document.body.classList.contains("casting-active")');
  await browser.evaluate('document.getElementById("librarySite").value="web";document.getElementById("librarySite").dispatchEvent(new Event("change"))');await browser.wait('document.querySelector(".vod-card")?.title==="Web parser fixture"');await browser.evaluate('document.querySelector(".vod-card").click()');await browser.wait('document.getElementById("libraryDetail").open && document.getElementById("libraryDetail").getAttribute("aria-busy")==="false"');await browser.evaluate('document.querySelector(".episode-button").click()');
  await browser.wait('window.MobileTVPlayerState()?.url.includes("parsed%3Dweb") && tvVideo.currentTime>1 && !tvVideo.paused',30000);console.log('PASS: browser parser resolves dynamic HLS and preserves required headers through actual playback');
  await browser.evaluate('document.getElementById("btnStopCast").click()');await browser.wait('!document.body.classList.contains("casting-active")');
  await browser.evaluate('document.getElementById("libraryAccounts").click()');await browser.wait('document.getElementById("libraryAccountsDialog").open');
  assert.equal(await browser.evaluate('libraryAccountAdvanced.open'),false,'Manual credentials are optional rather than filling the main account layout');
  for(const [theme,width,height]of [['dark',1200,850],['light',390,650]]){
    await browser.viewport(width,height);await browser.evaluate(`document.documentElement.dataset.theme=${JSON.stringify(theme)}`);
    const layout=await browser.evaluate(`(()=>{const d=libraryAccountsDialog,r=d.getBoundingClientRect(),option=libraryAccountProvider.options[1],s=getComputedStyle(option);d.scrollTop=d.scrollHeight;const h=libraryCloseAccounts.getBoundingClientRect();return {top:r.top,bottom:r.bottom,left:r.left,right:r.right,closeTop:h.top,closeBottom:h.bottom,scrollbar:getComputedStyle(d).scrollbarWidth,fg:s.color,bg:s.backgroundColor};})()`);
    assert.ok(layout.top>=-1&&layout.bottom<=height+1&&layout.left>=-1&&layout.right<=width+1&&layout.closeTop>=layout.top&&layout.closeBottom<=layout.bottom,JSON.stringify(layout));
    assert.equal(layout.scrollbar,'thin');assert.notEqual(layout.fg,layout.bg);assert.notEqual(layout.bg,'rgba(0, 0, 0, 0)');
    await browser.evaluate('libraryAccountsDialog.scrollTop=0');await browser.screenshot(path.resolve('data/ui-previews/account-compact-'+theme+'.png'));
  }
  await browser.viewport(1440,1000);await browser.evaluate('document.documentElement.dataset.theme="light"');
  await browser.evaluate('document.getElementById("libraryAccountCookie").value="fixture=saved";document.getElementById("libraryAccountForm").requestSubmit()');
  await browser.wait('document.getElementById("libraryAccountSummary").textContent.includes("尚未验证")');assert.ok(await browser.evaluate('!!document.getElementById("libraryAccountCheck") && !!document.getElementById("libraryAccountLogout")'));
  await browser.screenshot(path.resolve('data/ui-previews/cloud-account-check.png'));await browser.evaluate('document.getElementById("libraryCloseAccounts").click()');
  const originalHome=library.home,originalDetail=library.detail,originalResolve=library.cloud.resolve,originalSave=library.cloud.saveShare;
  const cloudEpisode=require('../src/content/cloud').encode({provider:'quark',share:'fixture',fid:'selected',fileToken:'fixture',name:'Only this episode.mp4'});let saveCalls=0;
  library.home=async function(key){return key==='wogg'?{classes:[],list:[{id:'cloud-fixture',title:'Cloud consent fixture',picture:''}],page:1,pagecount:1}:originalHome.call(this,key);};
  library.detail=async function(key,id,...rest){return key==='wogg'?{id,title:'Cloud consent fixture',lines:[{name:'Share',provider:'quark',episodes:[{name:'Only this episode.mp4',id:cloudEpisode}]},{name:'Other',provider:'quark',episodes:[{name:'Other episode.mp4',id:cloudEpisode}]}]}:originalDetail.call(this,key,id,...rest);};
  library.cloud.resolve=async()=>{throw Object.assign(new Error('Save required'),{status:428,verifyUrl:'https://pan.quark.cn/s/fixture',requiresSave:true,saveFile:{name:'Only this episode.mp4',size:5*1024**3}});};
  library.cloud.saveShare=async(id,options)=>{saveCalls++;assert.equal(id,cloudEpisode);assert.equal(options.consent,true);return {url:originBase+'/media/master.m3u8?cloud=saved',header,parse:0};};
  await browser.evaluate('document.getElementById("librarySite").value="wogg";document.getElementById("librarySite").dispatchEvent(new Event("change"))');
  await browser.wait('document.querySelector(".vod-card")?.title==="Cloud consent fixture"');await browser.evaluate('document.querySelector(".vod-card").click()');await browser.wait('document.getElementById("libraryDetail").open && document.getElementById("libraryDetail").getAttribute("aria-busy")==="false"');await browser.evaluate('document.querySelector(".episode-button").click()');
  await browser.wait('document.querySelector("#libraryDetailStatus .btn-primary")');assert.equal(saveCalls,0);assert.ok(await browser.evaluate('document.getElementById("libraryDetailStatus").textContent.includes("5.0 GiB")'));
  await browser.screenshot(path.resolve('data/ui-previews/cloud-save-consent.png'));
  await browser.evaluate('document.getElementById("libraryLines").value="1";document.getElementById("libraryLines").dispatchEvent(new Event("change"))');assert.equal(await browser.evaluate('!!document.querySelector("#libraryDetailStatus .btn-primary")'),false,'Switching lines removes consent for the previous selection');
  await browser.evaluate('document.getElementById("libraryLines").value="0";document.getElementById("libraryLines").dispatchEvent(new Event("change"));document.querySelector(".episode-button").click()');await browser.wait('document.querySelector("#libraryDetailStatus .btn-primary")');await browser.evaluate('document.querySelector("#libraryDetailStatus .btn-primary").click()');
  await browser.wait('window.MobileTVPlayerState()?.url.includes("cloud%3Dsaved") && tvVideo.currentTime>0.5 && !tvVideo.paused');assert.equal(saveCalls,1);
  await browser.evaluate('document.getElementById("btnStopCast").click()');await browser.wait('!document.body.classList.contains("casting-active")');
  library.home=originalHome;library.detail=originalDetail;library.cloud.resolve=originalResolve;library.cloud.saveShare=originalSave;
  console.log('PASS: cloud save consent names one file and its space cost, clears on line change, and plays only after explicit confirmation');
  await browser.evaluate('document.getElementById("librarySite").value="discovery";document.getElementById("librarySite").dispatchEvent(new Event("change"))');
  await browser.wait('document.querySelector(".vod-card")?.dataset.key.includes("discovery")');assert.equal(await browser.evaluate('document.querySelectorAll("#libraryCategories button").length'),8);
  await browser.evaluate('document.querySelector(".vod-card").click()');
  await browser.wait('!document.getElementById("libraryDetail").open && !document.getElementById("libraryCancelSearch").hidden && document.getElementById("libraryResults").textContent.includes("玩偶片源示例")');
  assert.ok(pendingSearch.length>0,'A slow source remains pending after fast/cloud results appear');
  await browser.evaluate('window.searchCard=document.querySelector(".vod-card");window.searchCard.focus()');
  await browser.screenshot(path.resolve('data/ui-previews/discovery-source-search.png'));
  pendingSearch.forEach(value=>value.release());await browser.wait('document.getElementById("libraryCancelSearch").hidden');
  assert.equal(await browser.evaluate('document.querySelector(".vod-card")===window.searchCard && document.activeElement===window.searchCard'),true,'Incremental results retain card identity and keyboard focus');
  const previousSearchCount=pendingSearch.length;await browser.evaluate('document.getElementById("librarySearchForm").requestSubmit()');
  await browser.wait('!document.getElementById("libraryCancelSearch").hidden && document.querySelectorAll(".vod-card").length>0');
  for(let attempt=0;attempt<100&&pendingSearch.length===previousSearchCount;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.ok(pendingSearch.length>previousSearchCount);
  await browser.evaluate('document.getElementById("libraryCancelSearch").click()');await browser.wait('document.getElementById("libraryStatus").textContent.includes("已停止搜索")');
  for(let attempt=0;attempt<100&&!pendingSearch.at(-1).closed;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(pendingSearch.at(-1).closed,true,'Stopping the UI search cancels upstream work');pendingSearch.forEach(value=>value.release());
  console.log('PASS: discovery cards directly stream public/cloud search results, preserve keyboard focus and cancel pending sources');
  await browser.evaluate('document.getElementById("librarySearch").value="rank fixture";document.getElementById("librarySearchForm").requestSubmit()');
  await browser.wait('Array.from(document.querySelectorAll(".vod-card")).some(card=>card.title==="rank fixture extra")');await browser.evaluate('window.rankingCard=Array.from(document.querySelectorAll(".vod-card")).find(card=>card.title==="rank fixture extra");window.rankingCard.focus()');
  for(let attempt=0;attempt<100&&!pendingSearch.at(-1)?.ranking;attempt++)await new Promise(resolve=>setTimeout(resolve,10));assert.equal(pendingSearch.at(-1).ranking,true);pendingSearch.at(-1).release();
  await browser.wait('document.querySelector(".vod-card")?.title==="Rank Fixture" && document.getElementById("libraryCancelSearch").hidden');
  assert.equal(await browser.evaluate('document.activeElement===window.rankingCard && Array.from(document.querySelectorAll(".vod-card")).find(card=>card.title==="rank fixture extra")===window.rankingCard'),true,'Late exact matches move before earlier partial results while their keyboard focus and DOM identity remain intact');
  await browser.evaluate('document.getElementById("librarySearch").value="Fixture Actor";document.getElementById("librarySearchForm").requestSubmit()');
  await browser.wait('document.querySelector(".vod-card .vod-match")?.textContent==="演员：Fixture Actor"');
  await browser.screenshot(path.resolve('data/ui-previews/search-actor-match.png'));await browser.evaluate('document.getElementById("libraryCancelSearch").click()');pendingSearch.forEach(value=>value.release());
  console.log('PASS: streamed exact-title priority retains focus and actor-name searches display the matched cast member');
  await browser.evaluate('document.getElementById("librarySite").value="native";document.getElementById("librarySite").dispatchEvent(new Event("change"))');
  await browser.wait('document.querySelector(".vod-card")?.title==="独立点播测试"');
  assert.ok(await browser.evaluate('document.getElementById("libraryCategories").getBoundingClientRect().bottom < 350'), 'The compact browsing controls leave space for posters');
  await browser.screenshot(path.resolve('data/ui-previews/compact-library-vod.png'));
  await browser.evaluate('document.querySelector(".vod-card").click()');await browser.wait('!document.getElementById("libraryDetailFavorite").hidden && document.getElementById("libraryDetail").getAttribute("aria-busy")==="false"');
  await browser.click('#libraryDetailFavorite');await browser.wait('document.getElementById("libraryDetailFavorite").getAttribute("aria-pressed")==="true"');
  await browser.evaluate('document.querySelector(".episode-button").click()');await browser.wait('tvVideo.currentTime>1 && !tvVideo.paused');
  await browser.wait('document.getElementById("seekBuffered").style.background.includes("gradient")');
  assert.ok(await browser.evaluate('parseFloat(document.getElementById("seekPlayed").style.width)>0'));
  await browser.click('#playerOptions summary');await browser.wait('document.getElementById("playerOptions").open');await browser.click('#hudTitle');await browser.wait('!document.getElementById("playerOptions").open');
  await browser.evaluate('document.getElementById("btnPlayPause").click()');await browser.wait('tvVideo.paused');
  await browser.click('#playerRate summary');await browser.wait('playerRate.open');
  await browser.click('#playerRateMenu button[data-rate="1.5"]');await browser.wait('!playerRate.open && MobileTVPlayerState().playbackRate===1.5 && tvVideo.playbackRate===1.5');
  await browser.evaluate('selectRate.value="1";selectRate.dispatchEvent(new Event("change"))');await browser.wait('MobileTVPlayerState().playbackRate===1 && tvVideo.playbackRate===1');await browser.click('#playerRate summary');
  await browser.key('ArrowDown');await browser.key('ArrowRight');await browser.key('Enter');
  await browser.wait('!playerRate.open && MobileTVPlayerState().playbackRate===1.25 && playerRateLabel.textContent==="1.25×"');
  await browser.click('#playerRate summary');await browser.key('ArrowDown');await browser.key('Escape');
  assert.equal(await browser.evaluate('!playerRate.open && document.activeElement===playerRate.querySelector("summary")'),true,'Escape returns focus to the speed trigger');
  await browser.click('#playerRate summary');await browser.click('#hudTitle');assert.equal(await browser.evaluate('playerRate.open'),false,'Clicking outside closes the speed menu');
  for(const width of [1440,768,390]){
    await browser.viewport(width,900);await browser.click('#playerRate summary');
    const layout=await browser.evaluate(`(()=>{const ids=['libraryPlayerTools','btnStopCast','playerRate','playerRateMenu','btnFullscreen'];return ids.map(id=>{const e=document.getElementById(id),r=e.getBoundingClientRect();return {id,left:r.left,right:r.right,width:r.width,visible:r.width>0};});})()`);
    assert.ok(layout.every(r=>r.visible&&r.left>=-1&&r.right<=width+1),JSON.stringify({width,layout}));
    if(width===1440)await browser.screenshot(path.resolve('data/ui-previews/compact-player-menu.png'));
    if(width===390)await browser.screenshot(path.resolve('data/ui-previews/compact-player-mobile.png'));
    await browser.key('Escape');
  }
  await browser.viewport(1440,1000);await browser.evaluate('selectRate.value="1";selectRate.dispatchEvent(new Event("change"))');
  console.log('PASS: compact single/multiple-episode controls and keyboard speed menu remain inside desktop/tablet/mobile viewports');
  await browser.click('#playerOptions summary');await browser.wait('playerOptions.open');
  await browser.click('#skipSettings summary');await browser.evaluate('skipIntro.value="2";skipEnding.value="3";skipEnabled.checked=true;skipForm.requestSubmit();libraryAutoNext.checked=true');
  await browser.screenshot(path.resolve('data/ui-previews/player-skip-settings.png'));
  await browser.click('#btnClosePlayerOptions');assert.equal(await browser.evaluate('playerOptions.open'),false);
  await browser.click('#btnPlayPause');await browser.wait('tvVideo.currentTime>=2 && !tvVideo.paused');
  await browser.wait('MobileTVLibraryPlayback()?.index===1 && Number(skipIntro.value)===2 && tvVideo.currentTime>=2 && !tvVideo.paused',20000);
  assert.equal(await browser.evaluate('Number(skipEnding.value)'),3,'The next episode retains the series skip durations');
  await browser.evaluate('libraryAutoNext.checked=false;tvVideo.currentTime=8.5');await browser.wait('tvVideo.paused && tvVideo.currentTime>=9 && tvVideo.currentTime<11',10000);
  await browser.evaluate('skipIntro.value="0";skipEnding.value="0";skipEnabled.checked=false;skipForm.requestSubmit();libraryAutoNext.checked=true');
  console.log('PASS: intro seeking, series persistence and early outro advance/pause follow playback and auto-next settings');
  await browser.screenshot(path.resolve('data/ui-previews/player-buffer-progress.png'));
  await browser.evaluate('document.getElementById("btnStopCast").click()');await browser.wait('!document.body.classList.contains("casting-active")');
  await browser.click('[data-library-shelf=history]');await browser.wait('document.querySelectorAll(".collection-card").length>0');
  assert.ok(await browser.evaluate('document.getElementById("libraryCollectionList").textContent.includes("看到")'));
  await browser.screenshot(path.resolve('data/ui-previews/library-history.png'));
  await browser.click('[data-library-shelf=favorites]');await browser.wait('document.querySelector(".collection-card strong")?.textContent==="独立点播测试"');
  await browser.click('.collection-open');await browser.wait('document.getElementById("libraryDetail").open && document.getElementById("libraryDetail").getAttribute("aria-busy")==="false"');await browser.click('.episode-button');await browser.wait('tvVideo.currentTime>0.5 && !tvVideo.paused');await browser.evaluate('document.getElementById("btnStopCast").click()');await browser.wait('!document.body.classList.contains("casting-active")');
  await browser.click('#libraryManageSources');await browser.wait('document.getElementById("librarySourcesDialog").open');
  await browser.click('#libraryTitle');await browser.wait('!document.getElementById("librarySourcesDialog").open');
  await browser.click('#libraryManageSources');await browser.evaluate(`document.getElementById('librarySourceName').value='备用订阅';document.getElementById('librarySourceUrl').value=${JSON.stringify(originBase+'/config?second=1')};document.getElementById('librarySourceForm').requestSubmit()`);
  await browser.wait('!document.getElementById("librarySourcesDialog").open && document.getElementById("librarySavedSource").options.length===2');
  await browser.click('#libraryManageSources');await browser.wait('document.querySelectorAll(".saved-source").length===2');await browser.screenshot(path.resolve('data/ui-previews/library-source-manager.png'));await browser.click('#libraryCloseSources');
  await browser.evaluate('document.getElementById("librarySavedSource").selectedIndex=0;document.getElementById("librarySavedSource").dispatchEvent(new Event("change"))');await browser.wait('!document.getElementById("librarySavedSource").disabled && document.getElementById("librarySavedSource").selectedIndex===0');
  await browser.click('[data-library-nav=live]');await browser.wait('document.querySelectorAll(".live-channel").length===2');await browser.click('.live-favorite');await browser.wait('document.querySelector(".live-favorite").getAttribute("aria-pressed")==="true"');
  await browser.click('#libraryLiveFavorites');await browser.wait('document.querySelectorAll(".live-channel").length===1');await browser.screenshot(path.resolve('data/ui-previews/television-channels.png'));
  await browser.click('.live-channel');await browser.wait('window.MobileTVPlayerState()?.protocol==="Live" && tvVideo.currentTime>0.5');await browser.key('c');await browser.wait('!document.getElementById("libraryChannelDrawer").hidden');
  await browser.key('ArrowDown');assert.ok((await browser.evaluate('document.activeElement.textContent')).includes('测试频道二'), 'ArrowDown selects the next channel');await browser.key('Enter');await browser.wait('window.MobileTVPlayerState()?.url.includes("ch%3D2")');await browser.screenshot(path.resolve('data/ui-previews/television-channel-drawer.png'));
  await browser.key('c');await browser.wait('document.getElementById("libraryChannelDrawer").hidden');await browser.key('1');await browser.key('Enter');await browser.wait('window.MobileTVPlayerState()?.url.includes("ch%3D1")');
  assert.equal(await browser.evaluate('getComputedStyle(document.getElementById("seekRow")).display'), 'none', 'Live television does not offer a VOD seek bar');
  await browser.evaluate('document.getElementById("btnStopCast").click()');await browser.wait('!document.body.classList.contains("casting-active")');
  await browser.viewport(390,844);await browser.click('[data-library-nav=vod]');await browser.wait('document.querySelector(".vod-card")?.title==="独立点播测试"');
  assert.ok(await browser.evaluate('document.documentElement.scrollWidth<=innerWidth'), 'Compact navigation does not overflow a narrow screen');await browser.screenshot(path.resolve('data/ui-previews/compact-library-narrow.png'));
  await browser.click('#libraryManageSources');await browser.wait('document.getElementById("librarySourcesDialog").open');assert.ok(await browser.evaluate('document.getElementById("librarySourcesDialog").getBoundingClientRect().width<=innerWidth'));await browser.screenshot(path.resolve('data/ui-previews/library-source-manager-narrow.png'));await browser.click('#libraryCloseSources');await browser.viewport(1440,1000);
  let verifiedUrl = ''; const originalOpen = library.browser.open;
  library.home = async () => { throw Object.assign(new Error('请先打开站点浏览器完成验证或登录，再重试'), { verifyUrl: 'https://fixture.test/verify' }); }; library.browser.open = async url => { verifiedUrl=url;return { opened:true }; };
  await browser.click('[data-library-nav=vod]');await browser.wait('!document.getElementById("libraryVerify").hidden');await browser.click('#libraryVerify');await browser.wait('document.getElementById("toast").textContent.includes("完成验证或登录后")');assert.equal(verifiedUrl, 'https://fixture.test/verify');assert.equal(await browser.evaluate('document.getElementById("libraryVerifyRetry").hidden'), false);
  library.home = originalHome;library.browser.open = originalOpen;
  const schedules = require('../src/content/schedule'), formatDay=new Intl.DateTimeFormat('en-CA',{timeZone:'Asia/Shanghai'}),day = formatDay.format(Date.now()),tomorrow=formatDay.format(Date.now()+86400000);
  library.home = async () => ({ classes: [], list: schedules.sortEvents([{ id:'fixture-live', title:'Home VS Away', schedule:schedules.schedule({date:day,time:'12:00',status:'live',league:'League'}) },{ id:'fixture-finished',title:'Finished match',schedule:schedules.schedule({date:day,time:'09:00',status:'finished'}) },{ id:'fixture-soon',title:'Upcoming match',schedule:schedules.schedule({date:tomorrow,time:'18:00',status:'upcoming'}) }]), page:1,pageCount:1 });
  await browser.click('#libraryRetry');await browser.wait('document.querySelectorAll(".schedule-match").length===3');assert.equal(await browser.evaluate('document.querySelector(".schedule-status").textContent'), '直播中');
  assert.equal(await browser.evaluate('document.querySelectorAll(".schedule-day").length'), 2);await browser.screenshot(path.resolve('data/ui-previews/sports-schedule.png'));
  await browser.evaluate('document.getElementById("libraryMatchStatus").value="upcoming";document.getElementById("libraryMatchStatus").dispatchEvent(new Event("change"))');await browser.wait('document.querySelectorAll(".schedule-match").length===1');assert.ok(await browser.evaluate('document.querySelector(".schedule-match").textContent.includes("Upcoming match")'));
  library.home = originalHome;
  console.log('PASS: compact header, persistent source switching, favorites/history, buffer track, outside-click dismissal, TV channel drawer/number tuning and verification actions');
  if (process.argv.includes('--real-source') || process.argv.includes('--real-live')) {
    await browser.evaluate('document.getElementById("btnStopCast").click()');
    await browser.wait('!document.body.classList.contains("casting-active")');
    const response = await fetch(base + '/api/library/config', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'http://www.\u996d\u592a\u786c.cc/tv' }) });
    assert.ok(response.ok); const config = await response.json(), sites = config.sites.filter(value => value.supported), failures = [];
    const onlySite = process.argv.find(value => value.startsWith('--site='))?.slice(7);
    const selectedSites = sites.filter(item => process.argv.includes('--real-source') && (!onlySite || item.key === onlySite || item.implementation?.toLowerCase().endsWith('-' + onlySite.toLowerCase())));
    if (process.argv.includes('--real-source')) assert.ok(selectedSites.length, 'No site matched --site=' + onlySite);
    for (const site of selectedSites) {
      try {
        let home = await (await fetch(base + '/api/library/home?site=' + encodeURIComponent(site.key))).json();
        if (!home.list?.length && home.classes?.length) home = await (await fetch(base + '/api/library/list?' + new URLSearchParams({site:site.key,category:home.classes[0].id,page:'1'}))).json();
        assert.ok(home.list?.length, JSON.stringify(home));
        const play = await fetch(base + '/api/library/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ siteKey: site.key, vodId: home.list[0].id }) });
        const result = await play.json(); assert.ok(play.ok, JSON.stringify(result));
        await browser.wait(`window.MobileTVPlayerState()?.sessionId===${result.state.sessionId} && tvVideo.readyState>=3 && tvVideo.currentTime>1 && !tvVideo.paused`, 45000);
        console.log('PASS: real subscription / ' + site.key + ': ' + JSON.stringify(await browser.evaluate('({width:tvVideo.videoWidth,height:tvVideo.videoHeight,seconds:tvVideo.currentTime})')));
      } catch (error) { failures.push(site.key + ': ' + error.message); console.error('FAIL: ' + failures.at(-1)); }
      await browser.evaluate('document.getElementById("btnStopCast").click()');
      await browser.wait('!document.body.classList.contains("casting-active")');
    }
    assert.equal(failures.length, 0, failures.join('\n'));
    if (process.argv.includes('--real-live')) {
      const source = config.lives.find(value => value.name === 'Kimentanm'); assert.ok(source);
      const list = await (await fetch(base + '/api/library/channels?source=' + source.key)).json();
      const channel = list.channels.find(value => value.name.startsWith('CGTN')); assert.ok(channel);
      const response = await fetch(base + '/api/library/live/play', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sourceKey: source.key, channelId: channel.id }) });
      const play = await response.json(); assert.ok(response.ok, JSON.stringify(play));
      await browser.wait(`window.MobileTVPlayerState()?.sessionId===${play.state.sessionId} && tvVideo.readyState>=3 && tvVideo.currentTime>1 && !tvVideo.paused`, 45000);
      console.log('PASS: real live channel / ' + channel.name + ': ' + JSON.stringify(await browser.evaluate('({width:tvVideo.videoWidth,height:tvVideo.videoHeight,seconds:tvVideo.currentTime})')));
    }
  }
}

run().catch(error => { console.error(error); process.exitCode = 1; }).finally(async () => {
  if (browser) await browser.close();
  if (receiver) await receiver.close();
  if (origin) { origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve)); }
  const target = fs.realpathSync(sandbox); assert.equal(path.dirname(target).toLowerCase(), fs.realpathSync(os.tmpdir()).toLowerCase()); assert.ok(path.basename(target).startsWith('MobileTV library browser '));
  try { fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch (error) { if (!['EPERM', 'EBUSY', 'ENOTEMPTY'].includes(error.code)) throw error; }
});
