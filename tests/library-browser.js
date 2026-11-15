const assert = require('assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
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
  const header = { 'User-Agent': 'DesktopNative/1.0', Referer: 'https://fixture.test/watch' };
  origin = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (url.pathname === '/config') {
      const ext = { siteUrl: originBase + '/api', type: 1, categories: ['电影', '剧集'] };
      const encoded = rc4(Buffer.from(JSON.stringify(ext).split('').map(character => String.fromCharCode(character.charCodeAt(0) + 2)).join('')), 'fantaiying921').toString('base64');
      res.end(JSON.stringify({ sites: [{ key: 'native', name: '原生点播示例', type: 3, api: 'csp_T4Guard', ext: encoded, header },{key:'quality',name:'多画质协议测试',type:4,api:originBase+'/quality'},{key:'web',name:'网页解析测试',type:4,api:originBase+'/web'}], lives: [{ name: '直播示例', url: originBase + '/channels', headers: header }] })); return;
    }
    if (url.pathname === '/api') {
      const video = { vod_id: '1', vod_name: '独立点播测试', vod_remarks: '全 2 集', type_name: '电影', vod_year: '2026', vod_content: '本地合成测试片源，用于验证电脑独立播放。', vod_play_from: '原画线路', vod_play_url: `第 1 集$${originBase}/media/master.m3u8?ep=1#第 2 集$${originBase}/media/master.m3u8?ep=2` };
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
  receiver = await createAppServer({ port: 0, enableDlna: false, enableAirplay: false, enableTvbox: false });
  const base = 'http://127.0.0.1:' + receiver.port;
  browser = await browserDriver(path.join(sandbox, 'browser'));
  await browser.navigate(base);
  await browser.wait('document.readyState === "complete" && window.MobileTVPlayerState');
  await browser.evaluate('document.querySelector("[data-library-nav=vod]").click()');
  await browser.evaluate(`document.getElementById('librarySourceUrl').value=${JSON.stringify(originBase + '/config')};document.getElementById('librarySourceForm').requestSubmit()`);
  await browser.wait('document.querySelectorAll(".vod-card").length===1');
  assert.equal(await browser.evaluate('document.querySelectorAll("#libraryCategories button").length'), 3);
  assert.equal(await browser.evaluate('document.documentElement.scrollWidth <= innerWidth'), true, 'Library layout fits viewport');
  const screenshots = path.resolve('data', 'ui-previews');
  await browser.screenshot(path.join(screenshots, 'native-library-vod.png'));
  await browser.evaluate('document.querySelector(".vod-card").click()');
  await browser.wait('document.getElementById("libraryDetail").open && document.querySelectorAll(".episode-button").length===2');
  await browser.evaluate('document.querySelector(".episode-button").click()');
  await browser.wait('window.MobileTVPlayerState()?.protocol==="Library" && tvVideo.readyState>=3 && tvVideo.currentTime>0.5 && !tvVideo.paused');
  assert.equal(await browser.evaluate('tvVideo.videoWidth'), 640);
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
  await browser.wait('document.querySelector(".vod-card")?.title==="Rendition fixture"');await browser.evaluate('document.querySelector(".vod-card").click()');await browser.wait('document.getElementById("libraryDetail").open');await browser.evaluate('document.querySelector(".episode-button").click()');
  await browser.wait(`window.MobileTVPlayerState()?.url.includes('quality%3D0') && tvVideo.currentTime>2 && !tvVideo.paused && !document.getElementById('libraryQualityLabel').hidden`);
  const position=await browser.evaluate('tvVideo.currentTime');await browser.evaluate('document.getElementById("libraryQuality").value="1";document.getElementById("libraryQuality").dispatchEvent(new Event("change"))');
  await browser.wait('window.MobileTVPlayerState()?.url.includes("quality%3D1") && tvVideo.currentTime>2 && !tvVideo.paused');
  assert.ok(await browser.evaluate('tvVideo.currentTime')>=position-1);console.log('PASS: rendition URL arrays appear in the player and switching resumes playback');
  await browser.evaluate('document.getElementById("btnStopCast").click()');await browser.wait('!document.body.classList.contains("casting-active")');
  await browser.evaluate('document.getElementById("librarySite").value="web";document.getElementById("librarySite").dispatchEvent(new Event("change"))');await browser.wait('document.querySelector(".vod-card")?.title==="Web parser fixture"');await browser.evaluate('document.querySelector(".vod-card").click()');await browser.wait('document.getElementById("libraryDetail").open');await browser.evaluate('document.querySelector(".episode-button").click()');
  await browser.wait('window.MobileTVPlayerState()?.url.includes("parsed%3Dweb") && tvVideo.currentTime>1 && !tvVideo.paused',30000);console.log('PASS: browser parser resolves dynamic HLS and preserves required headers through actual playback');
  await browser.evaluate('document.getElementById("btnStopCast").click()');await browser.wait('!document.body.classList.contains("casting-active")');
  await browser.evaluate('document.getElementById("libraryAccounts").click()');await browser.wait('document.getElementById("libraryAccountsDialog").open');
  await browser.evaluate('document.getElementById("libraryAccountCookie").value="fixture=saved";document.getElementById("libraryAccountForm").requestSubmit()');
  await browser.wait('document.getElementById("libraryAccountSummary").textContent.includes("尚未验证")');assert.ok(await browser.evaluate('!!document.getElementById("libraryAccountCheck") && !!document.getElementById("libraryAccountLogout")'));
  await browser.screenshot(path.resolve('data/ui-previews/cloud-account-check.png'));await browser.evaluate('document.getElementById("libraryCloseAccounts").click()');
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
