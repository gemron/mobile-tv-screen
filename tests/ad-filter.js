const assert = require('assert/strict');
const fs = require('fs'); const os = require('os'); const path = require('path');
const http = require('http'); const express = require('express');
const { filterPlaylist } = require('../src/services/hlsAdFilterWorker');
const { HlsAdFilter, domains, rules } = require('../src/services/hlsAdFilter');
const { createProxyRouter } = require('../src/services/proxy');
const source = `#EXTM3U\n#EXT-X-VERSION:3\n#EXT-X-TARGETDURATION:10\n#EXT-X-MEDIA-SEQUENCE:7\n#EXT-X-KEY:METHOD=AES-128,URI="key.bin"\n#EXTINF:10,\na.ts\n#EXTINF:2,\nhttps://ads.example.test/ad.ts\n#EXTINF:10,\nb.ts\n#EXT-X-ENDLIST\n`;
async function run() {
  const options = { domains: ['ads.example.test'], rules: [] }, address = 'https://media.example.test/play.m3u8';
  const result = filterPlaylist(source, address, options);
  assert.equal(result.removed, 1); assert.equal(result.seconds, 2); assert.ok(!result.content.includes('/ad.ts'));
  assert.match(result.content, /IV=0x00000000000000000000000000000007/);
  assert.match(result.content, /IV=0x00000000000000000000000000000009/);
  assert.match(result.content, /#EXT-X-DISCONTINUITY/);
  assert.equal(filterPlaylist(source.replace('#EXT-X-ENDLIST', ''), address, options).content, source.replace('#EXT-X-ENDLIST', ''), 'Live sequences stay untouched');
  assert.equal(filterPlaylist(source.replace('#EXTINF:2,', '#EXT-X-BYTERANGE:123@0\n#EXTINF:2,'), address, options).reason, 'complex-playlist');
  const normal = source.replace('https://ads.example.test/ad.ts', 'https://notads.example.test/program.ts');
  assert.equal(filterPlaylist(normal, address, options).content, normal, 'Domain matching uses label boundaries');
  const discontinuities = normal.replace(/#EXTINF/g, '#EXT-X-DISCONTINUITY\n#EXTINF');
  assert.equal(filterPlaylist(discontinuities, address, options).content, discontinuities, 'Discontinuities alone never identify ads');
  const cue = source.replace('#EXTINF:2,', '#EXT-X-CUE-OUT:2\n#EXTINF:2,').replace('#EXTINF:10,\nb.ts', '#EXT-X-CUE-IN\n#EXTINF:10,\nb.ts');
  assert.equal(filterPlaylist(cue, address, { domains: [], rules: [] }).removed, 1);
  const rule = { hosts: ['media.example.test'], regex: ['#EXTINF:2,[\\s\\S]*?ad\\.ts\\n'] };
  assert.equal(filterPlaylist(source, address, { domains: [], rules: [rule] }).removed, 1);
  assert.equal(filterPlaylist(source, address, { domains: [], rules: [{ hosts: ['other.test'], regex: rule.regex }] }).removed, 0);
  assert.equal(filterPlaylist(source, address, { domains: [], rules: [{ hosts: ['media.example.test'], regex: ['.*m3u8.*','2'] }] }).removed, 0, 'Sniffer rules are not ad removal rules');
  assert.equal(filterPlaylist(source, address, { domains: ['example.test'], rules: [] }).reason, 'guarded');
  assert.equal(filterPlaylist(source.replace('a.ts','https://ads.example.test/a.ts').replace('b.ts','https://ads.example.test/b.ts'), address, options).reason, 'guarded', 'Rules cannot delete the whole video');
  assert.deepEqual(domains('*.ads.example.test\nhttps://ads.example.test/a\ninvalid\nevil@example.test'), ['ads.example.test']);
  assert.equal(rules([{ hosts:['media.example.test'],regex:['x','#EXTINF:2,[\\s\\S]*?ad.ts'] }])[0].regex.length,1);
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'MobileTV adfilter test '));
  const filter = new HlsAdFilter({ dataDir: directory }); let upstream, receiver;
  try {
    filter.save({ enabled: true, domains: ['ads.example.test'] });
    assert.equal((await filter.filter(source, address)).removed, 1);
    const slow = '#EXTM3U\n#EXTINF:10,\n' + 'a'.repeat(30000) + '!\n#EXT-X-ENDLIST';
    filter.setSubscription({ rules: [{ hosts: ['media.example.test'], regex: ['#EXTINF:[\\s\\S]*?(a+)+$'] }] });
    const started = Date.now(); const timed = await filter.filter(slow, address); assert.equal(timed.reason, 'timeout'); assert.ok(Date.now() - started < 1500, 'Malicious regular expressions are terminated off the HTTP thread');
    filter.setSubscription({});
    const app = express(); app.use(express.json()); const router = createProxyRouter({ adFilter: filter }); app.use('/api', router);
    receiver = http.createServer(app); upstream = http.createServer((req,res) => { res.setHeader('Content-Type','application/vnd.apple.mpegurl'); res.end(source); });
    await new Promise(resolve => upstream.listen(0,'127.0.0.1',resolve)); await new Promise(resolve => receiver.listen(0,'127.0.0.1',resolve));
    const base = 'http://127.0.0.1:' + receiver.address().port, target = 'http://127.0.0.1:' + upstream.address().port + '/main.m3u8';
    const response = await fetch(base + '/api/proxy?url=' + encodeURIComponent(target));
    assert.equal(response.headers.get('x-ad-filter-segments'), '1'); const playlist = await response.text(); assert.ok(!playlist.includes('ad.ts')); assert.match(playlist, /%2Fkey.bin/); assert.match(playlist, /%2Fb.ts/);
    const save = await fetch(base + '/api/adfilter', { method: 'POST', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ enabled:false }) }); assert.equal(save.status,200);
    const disabled = await fetch(base + '/api/proxy?url=' + encodeURIComponent(target)); assert.equal(disabled.headers.get('x-ad-filter'), 'disabled'); assert.match(await disabled.text(), /ads.example.test/);
    assert.equal(new HlsAdFilter({dataDir:directory}).summary().enabled, false);
    router.mediaCache.clear(); console.log('PASS: HLS ads, host-scoped rules, cue markers, AES sequence IVs, live/byterange safety, regex timeout, proxy integration and persisted disable');
  } finally {
    await filter.close(); for (const server of [receiver,upstream]) if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
    const target=path.resolve(directory);assert.equal(path.dirname(target),path.resolve(os.tmpdir()));assert.ok(path.basename(target).startsWith('MobileTV adfilter test '));fs.rmSync(target,{recursive:true,force:true});
  }
}
run().catch(error => { console.error(error); process.exitCode=1; });
