const assert = require('assert/strict');
const http = require('http');
const catalog = require('../src/content/catalog');
const { scriptObject } = require('../src/content/html-sites');
const { postJson } = require('../src/content/http');

async function run() {
  let base;
  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://fixture');
    if (req.method === 'POST' && url.pathname === '/parse') {
      let body = ''; for await (const chunk of req) body += chunk;
      assert.deepEqual(JSON.parse(body), { url: 'opaque', client_fallback: false });
      assert.equal(req.headers['content-type'], 'application/json');
      res.end(JSON.stringify({ url: base + '/master.m3u8' })); return;
    }
    const pages = {
      '/dm/': '<ul class="nav_row"><li><a href="/list-12.html">动漫</a></li></ul><div class="item"><a class="title" href="/v/1.html">动画一</a><a class="cover" data-bg="/poster.png"></a><span class="desc">更新两集</span></div>',
      '/show-12--time---2026-2.html': '<div class="item"><a class="title" href="/v/1.html">分类结果</a></div><div class="page"><a>3</a></div>',
      '/s----------.html': '<div class="item"><a class="title" href="/v/1.html">搜索结果</a></div>',
      '/v/1.html': '<h1 class="v_title">动画一</h1><meta property="og:image" content="/poster.png"><meta name="og:video:actor" content="甲"><ul class="tab_control"><li>高清</li></ul><ul class="play_list"><li><a href="/p/one.html">第一集</a><a href="/p/two.html">第二集</a></li></ul>',
      '/p/one.html': '<iframe src="/frame.html"></iframe>',
      '/frame.html': '<script>var player_a={"url":"' + encodeURIComponent(base + '/master.m3u8') + '","encrypt":1};</script>',
      '/au/': '<ul class="navbar-nav"><li><a href="/Movie/">电影</a></li></ul><ul class="threadlist"><li><h2><a href="/Movie/a/" title="影片甲">影片甲</a></h2><a class="pic"><img src="/poster.png"></a><span class="hdtag">1080P</span></li></ul>',
      '/Movie/a/': '<h1 class="detail-title">影片甲</h1><div class="detail-poster"><img src="/poster.png"></div><p class="detail-des">影片简介</p><div class="play-card" id="player_list"><div class="card-header"><span><b>云播</b></span></div><ul class="episode-list"><li><a href="/Movie/a/play.html">正片</a></li></ul></div>',
      '/Movie/a/play.html': '<script>var now=base64decode("' + Buffer.from(base + '/movie.mp4').toString('base64') + '");</script>',
      '/jijiu': '<img class="block100" src="/poster.png"><div class="jj-title-li"><li class="list-br3"><a href="/aid/video">急救示例</a></li></div>',
      '/aid/video': '<h1 class="video-title h1-title">急救示例</h1><div class="video-cover"><img src="/poster.png"></div><div class="img-text-con">教学简介</div><video id="video"><source src="/aid.mp4"></video>',
    };
    if (!pages[url.pathname]) { res.writeHead(404); res.end(); return; }
    res.setHeader('Content-Type', 'text/html; charset=utf-8'); res.end(pages[url.pathname]);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve)); base = 'http://127.0.0.1:' + server.address().port;
  try {
    for (const [plugin, path, expected] of [['Dm84', '/dm/', 2], ['Auete', '/au/', 1], ['FirstAid', '/aid/', 1]]) {
      const site = catalog.describeSite({ key: plugin, type: 3, api: 'csp_' + plugin + 'Guard', ext: { siteUrl: base + path } }, base, 0);
      assert.equal(site.supported, true);
      const home = await catalog.home(site); assert.ok(home.classes.length); assert.equal(home.list.length, 1);
      const video = await catalog.detail(site, home.list[0].id); assert.equal(video.lines[0].episodes.length, expected);
      const media = await catalog.resolve(site, video.lines[0], video.lines[0].episodes[0], [], '');
      assert.ok(media.url.startsWith(base)); assert.match(media.url, /\.(mp4|m3u8)$/);
      assert.ok(media.headers['user-agent']);
      if (plugin === 'Dm84') {
        const result = await catalog.category(site, { id: '12', page: 2, filters: { year: '2026' } }); assert.equal(result.page, 2); assert.equal(result.pageCount, 3);
        const search = await catalog.category(site, { keyword: '动画 & test' }); assert.equal(search.list[0].title, '搜索结果');
      }
    }
    assert.deepEqual(scriptObject('var player_a={"x":"escaped \\\" } bracket","nested":{"x":1}}; untrusted()', /var\s+player_\w+\s*=/), { x: 'escaped " } bracket', nested: { x: 1 } });
    assert.equal(scriptObject('var player_a={url: executeDangerousCode()};', /var\s+player_\w+\s*=/), null, 'Executable expressions are never evaluated');
    assert.equal((await postJson(base + '/parse', { url: 'opaque', client_fallback: false })).url, base + '/master.m3u8');
    console.log('PASS: Node HTML adapters browse, search, paginate, parse details, resolve iframe/base64 media without executing page scripts');
  } finally { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)); }
}
run().catch(error => { console.error(error); process.exitCode = 1; });
