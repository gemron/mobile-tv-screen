const assert = require('assert/strict'), http = require('http');
const { checkHls, checkFlv, huyaUrl } = require('../src/content/adapters/platforms');
const websites = require('../src/content/adapters/websites');
const extras = require('../src/content/adapters/extras');
const { resource } = require('../src/content/http');
const playerHtml = '<script>const ad=artplayerPluginAds({url:"https://ads.test/advert.mp4"});const media="https://cdn.test/opaque?signature=fixture";var art=new Artplayer({container:"#player",poster:"https://ads.test/poster.png",plugins:[ad]});art.type="mp4";art.url=media;</script>';
assert.deepEqual(websites.artplayerMedia(playerHtml), {url:'https://cdn.test/opaque?signature=fixture',type:'mp4'});
assert.equal(websites.artplayerMedia('<script>const art=new Artplayer({url:runUntrustedCode()});</script>'),null);
assert.equal(websites.artplayerMedia('<script>const ad=new Artplayer({container:"#ads",url:"https://ads.test/advert.mp4"});</script>'),null);
(async () => {
  let base;
  const server = http.createServer((req, res) => {
    if (req.url === '/region' || req.url === '/region-ok' || req.url === '/region-compressed') {
      const body = '<html><head><title>Site</title></head><body><pre>Access denied by geographic restriction</pre></body></html>';
      res.statusCode = req.url === '/region-ok' ? 200 : 403; res.setHeader('Content-Type', 'text/html');
      if (req.url === '/region-compressed') { res.setHeader('Content-Encoding', 'gzip'); res.end(require('zlib').gzipSync(body)); } else res.end(body);
      return;
    }
    if (req.url === '/quoted-region') { res.setHeader('Content-Type', 'text/html'); res.end('<h1>Movie title</h1><p>The story quotes Access denied by geographic restriction.</p>'); return; }
    if (req.url === '/region-stalled') { res.writeHead(403, { 'Content-Type': 'text/plain' }); res.write('Access denied by geographic restriction'); return; }
    if(req.url==='/missing.m3u8'){res.writeHead(404).end('Gone');return;}
    if (req.url === '/play') { res.setHeader('content-type', 'text/html'); res.end('<iframe src="/frame?url=' + encodeURIComponent(base.replace('127.0.0.1', 'localhost') + '/good.m3u8') + '"></iframe>'); return; }
    if (req.url === '/art-player') { res.setHeader('content-type','text/html'); res.end(playerHtml);return; }
    if (req.url.endsWith('.m3u8')) { res.setHeader('content-type', 'application/vnd.apple.mpegurl'); res.end('#EXTM3U\n#EXT-X-TARGETDURATION:2\n#EXTINF:2,\n' + (req.url === '/bad.m3u8' ? '/denied' : req.url === '/empty.m3u8' ? '/empty' : '/segment.ts') + '\n'); return; }
    if (req.url === '/denied') { res.statusCode = 403; res.end('Denied'); return; }
    if (req.url === '/empty') { res.end(); return; }
    if (req.url === '/stream.flv') { res.end(Buffer.from('FLV\x01\x05\0\0\0\x09')); return; }
    if (req.url === '/wrong.flv') { res.end('<html>not media</html>'); return; }
    assert.equal(req.headers['user-agent'], 'FixtureBrowser/1'); assert.equal(req.headers.referer, undefined); res.setHeader('content-type', 'video/mp2t'); res.end(Buffer.alloc(188 * 5, 0x47));
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  try {
    const headers = { 'user-agent': 'FixtureBrowser/1' };
    for (const route of ['/region', '/region-ok', '/region-compressed']) await assert.rejects(resource(base + route), error => error.code === 'SOURCE_REGION_BLOCKED' && error.status === 403 && !error.verifyUrl);
    assert.ok((await resource(base + '/quoted-region')).text.includes('Movie title'), 'A film synopsis mentioning a restriction is not a denial page');
    await assert.rejects(resource(base + '/denied'), error => /HTTP 403/.test(error.message) && !error.code);
    const started=Date.now();await assert.rejects(resource(base+'/region-stalled'),error=>error.code==='SOURCE_REGION_BLOCKED');assert.ok(Date.now()-started<2500,'A stalled error body does not hold the source request for its full timeout');
    assert.equal(await checkHls(base + '/good.m3u8', headers), base + '/good.m3u8');
    const sports={plugin:'Kanqiu',api:base,headers};
    await assert.rejects(extras.resolve(sports,{id:base+'/frame?url='+encodeURIComponent(base+'/missing.m3u8')}),/此直播线路暂不可用.*404.*其他线路/);
    const live=await extras.resolve(sports,{id:base+'/frame?url='+encodeURIComponent(base+'/good.m3u8')});assert.equal(live.isLive,true);assert.equal(live.url,base+'/good.m3u8');
    await assert.rejects(checkHls(base + '/bad.m3u8', headers), /403/); await assert.rejects(checkHls(base + '/empty.m3u8', headers), /为空/);
    assert.equal(await checkFlv(base + '/stream.flv', headers), base + '/stream.flv'); await assert.rejects(checkFlv(base + '/wrong.flv', headers), /未返回 FLV/);
    const now=1794758400123,uid='1234',fm=Buffer.from('prefix_$0_$1_$2_$3').toString('base64'),signed=new URL(huyaUrl({sHlsUrl:'https://live.test/',sStreamName:'stream',sHlsAntiCode:'fm='+encodeURIComponent(fm)+'&ctype=tars_mp&t=102&fs=1'},now,uid,true)),query=signed.searchParams,time=(Math.floor(now/1000)+21600).toString(16),seq='1794758400124234',md5=value=>require('crypto').createHash('md5').update(value).digest('hex');
    assert.equal(query.get('seqid'),seq);assert.equal(query.get('wsTime'),time);assert.equal(query.get('u'),uid);assert.equal(query.get('ctype'),'huya_live');assert.equal(query.get('wsSecret'),md5('prefix_'+uid+'_stream_'+md5(seq+'|huya_live|huya_live')+'_'+time));assert.equal(query.has('fm'),false);
    const found = await websites.resolve({ adapter: 'newcz', api: base, headers: { ...headers, referer: base, origin: base } }, { id: base + '/play' });
    assert.equal(found.inheritHeaders, false); assert.equal(found.header.referer, undefined); assert.equal(found.header.origin, undefined); assert.ok(found.header['user-agent'].includes('Mozilla'));
    const configured=await websites.resolve({adapter:'newcz',api:base,headers},{id:base+'/art-player'});assert.equal(configured.url,'https://cdn.test/opaque?signature=fixture');assert.equal(configured.type,'mp4');
    console.log('PASS: live selection checks the first segment and NewCz separates catalog headers from external media headers');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
})().catch(error => { console.error(error); process.exitCode = 1; });
