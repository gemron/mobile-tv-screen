const assert = require('assert/strict');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');
const catalog = require('../src/content/catalog');
const { searchSources, canSearch } = require('../src/content/search');
const { createLibraryRouter } = require('../src/content/router');
const { Cloud, encode } = require('../src/content/cloud');

async function run() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV discovery test '));
  let base, appServer, metadataCalls = 0, releaseSlow, slowClosed = false, browserCalls = 0;
  const seen = [], slowGate = new Promise(resolve => { releaseSlow = resolve; });
  const origin = http.createServer(async (req, res) => {
    const url = new URL(req.url, base); seen.push(url); res.setHeader('Content-Type', 'application/json');
    if (url.pathname.startsWith('/metadata/')) {
      metadataCalls++; assert.equal(url.searchParams.get('apikey'), 'fixture');
      res.end(JSON.stringify({ start: Number(url.searchParams.get('start')), count: 20, total: 41, items: [{ id: '11', title: 'Discovery fixture', pic: { large: base + '/cover.png' }, rating: { value: 8.1 }, year: '2025' }] })); return;
    }
    if (url.pathname.startsWith('/vodsearch/')) {
      res.setHeader('Content-Type', 'text/html'); res.end('<div class="module-search-item"><a title="Cloud fixture" href="/voddetail/1.html">Cloud fixture</a></div>'); return;
    }
    if (url.pathname === '/slow') { res.on('close', () => { slowClosed = true; }); await slowGate; if (!res.destroyed) res.end(JSON.stringify({ list: [{ vod_id: 'slow', vod_name: 'Slow fixture' }] })); return; }
    if(url.pathname==='/detail-fixture'){res.setHeader('Content-Type','text/html');res.end('<h1>Mixed cloud fixture</h1><a href="https://pan.quark.cn/s/fixture">Quark</a><a href="https://pan.baidu.com/s/fixture">Baidu</a>');return;}
    if(url.pathname==='/baidu-share'){res.setHeader('Content-Type','text/html');res.end('<h1>Login required</h1>');return;}
    if(url.pathname==='/api-matching'){res.end(JSON.stringify({list:[{vod_id:'unrelated',vod_name:'其他影片'},{vod_id:'actor',vod_name:'狂飙',vod_actor:'张译/张颂文'},{vod_id:'title',vod_name:'张译'}]}));return;}
    if (url.pathname.endsWith('/share/sharepage/token')) { res.end(JSON.stringify({ code: 0, data: { stoken: 'fixture-share-token' } })); return; }
    if (url.pathname.endsWith('/share/sharepage/detail')) { res.end(JSON.stringify({code:0,data:{list:[{fid:'file',file_name:'Movie.mp4',share_fid_token:'fixture-file-token'}]}}));return; }
    if (url.pathname.endsWith('/share/sharepage/video')) { res.statusCode = 404; res.end('{}'); return; }
    res.statusCode = 404; res.end('{}');
  });
  await new Promise(resolve => origin.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + origin.address().port;
  const router = createLibraryRouter({ dataDir: directory });
  try {
    const discovery = catalog.describeSite({ api: 'csp_DouDouGuard', type: 3, searchable: 0, ext: { metadataApi: base + '/metadata/', metadataKey: 'fixture' } }, base, 0);
    const home = await catalog.home(discovery); assert.equal(home.classes.length, 7); assert.equal(home.list[0].searchTitle, 'Discovery fixture'); assert.equal(home.filters.movie.length, 4);
    const before = metadataCalls, detail = await catalog.detail(discovery, home.list[0].id); assert.equal(detail.searchTitle, 'Discovery fixture'); assert.equal(metadataCalls, before, 'Metadata cards open without another remote detail request');
    await catalog.category(discovery, { id: 'movie', page: 2, filters: { genre: 'Action', region: 'US', year: '2025', sort: 'S' } });
    assert.equal(seen.at(-1).searchParams.get('tags'), 'Action,US,2025'); assert.equal(seen.at(-1).searchParams.get('sort'), 'S'); assert.equal(seen.at(-1).searchParams.get('start'), '20');
    await catalog.category(discovery, { id: 'movie_rank', filters: { collection: 'https://untrusted.test/' } }); assert.ok(seen.at(-1).pathname.endsWith('/subject_collection/movie_top250/items'), 'Rank identifiers are selected from supported collections');
    const cloudSite = catalog.describeSite({ key: 'cloud', api: 'csp_WoGGGuard', type: 3 }, base, 1);
    assert.equal(canSearch(cloudSite), true); assert.equal(canSearch(discovery), false);
    assert.equal(canSearch({ supported: true, searchable: true, adapter: 'cloud-MyDrive' }), false, 'Private drive browsing is excluded from public search');
    assert.equal(canSearch({ supported: true, adapter: 'cloud-Push' }), false);
    const disabled = catalog.describeSite({ api: base, searchable: '0' }, base, 2); assert.equal(canSearch(disabled), false);

    let release, first, finished = false;
    const gate = new Promise(resolve => { release = resolve; }), early = new Promise(resolve => { first = resolve; });
    const pending = searchSources([cloudSite, { key: 'slow', name: 'Slow', supported: true }], 'fixture', {
      query: async site => { if (site.key === 'slow') await gate; return { list: [{ id: site.key, title: 'Fixture', lines: [{ episodes: [{ id: 'private-playlist' }] }] }] }; },
      onProgress: progress => { if (progress.list.length && !progress.done) first(progress); },
    }).then(value => { finished = true; return value; });
    const partial = await early; assert.equal(finished, false); assert.equal(partial.list[0].siteKey, 'cloud'); assert.equal(partial.list[0].lines, undefined);
    release(); assert.equal((await pending).list.length, 2);
    const controller = new AbortController(); let aborted = false;
    const cancelled = searchSources([cloudSite], 'fixture', { signal: controller.signal, query: (_, options, signal) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => { aborted = true; reject(signal.reason); }, { once: true }); }) });
    controller.abort(); await assert.rejects(cancelled, error => error.name === 'AbortError'); assert.equal(aborted, true);

    router.library.apply({ sites: [{ key: 'wogg', name: 'Wogg fixture', type: 3, api: 'csp_WoGGGuard', ext: { siteUrl: base } }, { key: 'slow', name: 'Slow', type: 1, api: base + '/slow' }] }, base);
    const app = express(); app.use(express.json()); app.use('/api/library', router); appServer = http.createServer(app); await new Promise(resolve => appServer.listen(0, '127.0.0.1', resolve));
    const streamController = new AbortController(), response = await fetch('http://127.0.0.1:' + appServer.address().port + '/api/library/search/stream?keyword=fixture', { signal: streamController.signal });
    assert.match(response.headers.get('content-type'), /text\/event-stream/);
    const reader = response.body.getReader(), decoder = new TextDecoder(); let buffer = '', found;
    while (!found) { const value = await reader.read(); assert.equal(value.done, false); buffer += decoder.decode(value.value, { stream: true }); for (const event of buffer.split('\n\n').slice(0, -1)) { const data = JSON.parse(event.slice(6)); if (data.list?.some(item => item.siteKey === 'wogg')) found = data; } }
    assert.equal(found.done, false, 'HTTP stream returns cloud search results while a slow source is pending');
    streamController.abort(); await reader.cancel().catch(() => {});
    for (let attempt = 0; attempt < 50 && !slowClosed; attempt++) await new Promise(resolve => setTimeout(resolve, 10));
    assert.equal(slowClosed, true, 'Disconnecting the search stream cancels its upstream request');
    await router.library.cached('cloud-cache',60000,async()=>({private:'fixture'}),true);await router.library.cached('public-cache',60000,async()=>({public:'fixture'}));
    let releaseCached;const cacheGate=new Promise(resolve=>{releaseCached=resolve;});const staleCached=router.library.cached('pending-cloud',60000,()=>cacheGate,true);
    const accountResponse=await fetch('http://127.0.0.1:'+appServer.address().port+'/api/library/accounts',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'quark',cookie:'fixture=changed'})});assert.equal(accountResponse.ok,true);
    assert.equal(router.library.cache.has('cloud-cache'),false);assert.equal(router.library.cache.has('public-cache'),true,'Account changes keep unrelated public metadata cached');releaseCached({private:'old'});await assert.rejects(staleCached,error=>error.status===409);
    const beforeRefresh=router.library.cloudGeneration;router.library.site('wogg').cloud={detail:async()=>({lines:[{name:'Season',provider:'quark',episodes:[{id:'cloud:fixture',name:'One'}]}]})};await router.library.detail('wogg',base+'/detail-fixture',true);assert.equal(router.library.cloudGeneration,beforeRefresh+1,'Explicit cloud retry invalidates pending results from before browser verification');

    const cloud = new Cloud({ cookie: async () => '', get: () => ({}) }, { run: async (url, options) => { browserCalls++; assert.equal(url, 'https://pan.quark.cn/s/fixture'); assert.equal(options.selectText, 'Movie.mp4'); return { url: base + '/video.mp4', header: {}, parse: 0 }; } }, { endpoints: { quark: base + '/cloud/' } });
    const fallback = await cloud.resolve(encode({ provider: 'quark', url: 'https://pan.quark.cn/s/fixture', share: 'fixture', fid: 'file', name: 'Movie.mp4' })); assert.equal(fallback.url, base + '/video.mp4'); assert.equal(browserCalls, 1);
    const qualities = await cloud.mediaChoices('quark', [{ video_info: { width: 640, height: 360, url: 'https://cdn.test/360.mp4' } }, { video_info: { width: 3840, height: 2160, url: 'https://cdn.test/4k.mp4' } }]);
    assert.equal(qualities.url.values[0].n, '3840 × 2160'); assert.equal(qualities.url.values.length, 2); assert.equal(qualities.header.cookie, undefined);
    const media = await require('../src/content/playback').resolvePlayback({ api: base, headers: {} }, qualities, { quality: 1 }); assert.equal(media.url, 'https://cdn.test/360.mp4'); assert.notEqual(media.mimeType, 'application/vnd.apple.mpegurl', 'MP4 quality URLs are not forced through an HLS demuxer');
    await assert.rejects(cloud.baiduDetail({provider:'baidu',url:base+'/baidu-share'}),error=>error.status===428&&error.verifyUrl===base+'/baidu-share');assert.equal(browserCalls,1,'An anonymous Baidu share does not launch a browser that would stall the playable provider');
    const mixed=await require('../src/content/adapters/cloud-sources').detail({api:base,headers:{},cloud:{detail:async url=>{if(url.includes('baidu'))throw Object.assign(new Error('Login required'),{status:428,verifyUrl:url});return {lines:[{name:'Season',provider:'quark',episodes:[{id:'cloud:fixture',name:'One'}]}]};}}},base+'/detail-fixture');
    assert.equal(mixed.lines.length,2);assert.equal(mixed.lines[1].provider,'baidu');assert.equal(mixed.lines[1].notice,'Login required');assert.equal(mixed.lines[1].episodes.length,0,'A failed provider remains visible alongside the playable cloud line');
    const authenticated=new Cloud({cookie:async()=> 'session=fixture',get:()=>({})},null,{endpoints:{quark:base}}),mixedQualities=await authenticated.mediaChoices('quark',[{width:3840,height:2160,url:'https://cdn.test/4k.mp4'},{width:640,height:360,url:base+'/360.mp4'}]);
    const resolve=require('../src/content/playback').resolvePlayback;assert.equal((await resolve({api:'https://pan.quark.cn/',headers:{}},mixedQualities)).headers.cookie,undefined);assert.equal((await resolve({api:'https://pan.quark.cn/',headers:{}},mixedQualities,{quality:1})).headers.cookie,'session=fixture','Quality changes scope credentials to the selected media origin');
    router.library.apply({sites:[{key:'matching',type:1,api:base+'/api-matching'}]},base);const matched=await router.library.list('matching',{keyword:'张译',page:1});assert.deepEqual(matched.list.map(item=>item.id),['title','actor','unrelated']);assert.equal(matched.list[1].match.label,'演员：张译','Single-site search uses actor metadata and the same relevance order as all-source search');
    console.log('PASS: rich discovery, filters/ranks, direct search metadata, public cloud inclusion, search cancellation/progress, bounded SSE, provider identity and browser fallback/multiple cloud qualities');
  } finally {
    releaseSlow(); await router.library.close();
    if (appServer) { appServer.closeAllConnections(); await new Promise(resolve => appServer.close(resolve)); }
    origin.closeAllConnections(); await new Promise(resolve => origin.close(resolve));
    const target = path.resolve(directory); assert.equal(path.dirname(target), path.resolve(os.tmpdir())); assert.ok(path.basename(target).startsWith('MobileTV discovery test ')); fs.rmSync(target, { recursive: true, force: true });
  }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
