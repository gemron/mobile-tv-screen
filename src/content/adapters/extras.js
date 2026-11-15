const cheerio = require('cheerio');
const { resource, postResource } = require('../http');
const { json, webUrl, cleanHeaders } = require('../format');
const { resolvePage } = require('./websites');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const definitions = {
  SixV: 'https://www.xb6v.com/', YGP: 'https://www.6huo.com/',
  Music: 'http://www.4c44.com/', Fy: 'https://maihaolian.com/',
  Kanqiu: 'http://www.88kanqiu.pw/', XPath: 'https://example.invalid/',
};
const text = value => String(value || '').replace(/\s+/g, ' ').trim();
function describe(raw, base) {
  const plugin = /^csp_(\w+?)(?:Guard)?$/.exec(raw.api)?.[1];
  if (!definitions[plugin] || plugin === 'XPath' && raw.key !== 'cc') return null;
  const endpoint = typeof raw.ext === 'string' && /^https?:/.test(raw.ext) ? raw.ext : raw.ext?.siteUrl || definitions[plugin];
  const api = webUrl(endpoint, base);
  return { adapter: 'extra-' + plugin, plugin, api, supported: true, implementation: 'node-' + plugin.toLowerCase(), headers: cleanHeaders({ 'user-agent': UA, referer: api, ...raw.header, ...raw.headers }) };
}
async function page(site, address, signal) {
  const url = webUrl(address, site.api);
  let result;
  try { result = await resource(url, { headers: site.headers, signal, timeout: 12000 }); }
  catch (error) {
    if (!site.browser || !/403|503/.test(error.message)) throw error;
    result = await site.browser.run(url, { signal });
  }
  if (/<title>[^<]*(?:人机验证|Just a moment)/i.test(result.text)) {
    throw Object.assign(new Error('此站需要人机验证，请点击“打开站点浏览器”完成验证后重试'), { status: 428, verifyUrl: url });
  }
  return { ...result, $: cheerio.load(result.text) };
}
function cards($, selector, base, kind) {
  const items = [];
  $(selector).slice(0, 300).each((_, element) => {
    const row = $(element), a = row.is('a') ? row : row.find('a.zoom,a.public-list-exp,a[href]').first(), img = a.find('img').first();
    const href = a.attr('href'), name = text(a.attr('title') || a.find('span[title]').attr('title') || img.attr('alt') || a.text());
    if (!href || !name) return;
    items.push({ vod_id: webUrl(href, base), vod_name: name, vod_pic: img.attr('data-src') || img.attr('src'), vod_remarks: text(row.find(kind === 'SixV' ? '[rel="category tag"]' : '.ft2,.public-list-prb,.note').first().text()) });
  });
  return [...new Map(items.map(item => [item.vod_id, item])).values()];
}
const sixCategories = ['dianshiju/guoju', 'dianshiju/rihanju', 'dianshiju/oumeiju', 'xijupian', 'dongzuopian', 'aiqingpian', 'kehuanpian', 'kongbupian', 'juqingpian', 'zhanzhengpian', 'jilupian', 'donghuapian'];
const classRows = (ids, names) => ids.map((type_id, i) => ({ type_id, type_name: names[i] }));
async function list(site, { id = '', page: pg = 1, keyword = '', filters = {} } = {}, signal) {
  const kind = site.plugin;
  if (kind === 'XPath') return { class: [], list: [], notice: '这是原配置中的提示条目：请勿相信视频中的广告。它没有影片或直播接口。', page: 1, pagecount: 1 };
  let address = site.api, classes = [], selector;
  if (kind === 'SixV') {
    classes = classRows(sixCategories, ['国剧', '日韩剧', '欧美剧', '喜剧片', '动作片', '爱情片', '科幻片', '恐怖片', '剧情片', '战争片', '纪录片', '动画片']);
    address = '/' + (id || sixCategories[0]) + (Number(pg) > 1 ? '/index_' + pg + '.html' : '/');
    selector = '#post_container .post_hover';
  } else if (kind === 'YGP') {
    classes = [{ type_id: 'movlist/', type_name: '新片预告' }];
    address = keyword ? '/?keyword=' + encodeURIComponent(keyword) + '&view=search' : id ? '/' + id.replace(/^\//, '') + (Number(pg) > 1 ? '?page=' + pg : '') : '/';
    selector = 'div.movlist > ul li > a';
  } else if (kind === 'Fy') {
    classes = classRows(['1', '2', '3', '4'], ['电影', '电视剧', '综艺', '动漫']);
    address = keyword ? '/search/-------------.html?wd=' + encodeURIComponent(keyword) : id ? `/cupfox-list/${id}-${filters.area || ''}--${filters.class || ''}-${filters.lang || ''}-${filters.letter || ''}-${filters.orderBy || ''}--${pg}---${filters.year || ''}.html` : '/';
    selector = 'a.public-list-exp';
  } else if (kind === 'Music') {
    address = keyword ? '/so/' + encodeURIComponent(keyword) + '.html' : id ? '/' + id.replace(/^\//, '').replace(/\.html$/, '') + '.html' : '/';
    selector = '.lksinger_list > ul > li,.singer_list > ul > li';
  } else if (kind === 'Kanqiu') {
    classes = classRows(['all', '1', '8', '21'], ['全部直播', '篮球直播', '足球直播', '其他直播']);
    address = !id || id === 'all' ? '/' : '/match/' + encodeURIComponent(id) + '/live';
  }
  let r;
  if (kind === 'SixV' && keyword) {
    r = await postResource(new URL('/e/search/11index.php', site.api).href, new URLSearchParams({ show: 'title', tempid: '1', tbname: 'article', mid: '1', dopost: 'search', submit: '', keyboard: keyword }).toString(), { headers: site.headers, contentType: 'application/x-www-form-urlencoded', signal });
    r.$ = cheerio.load(r.text);
  } else r = await page(site, address, signal);
  let items;
  if (kind === 'Kanqiu') {
    items = [];
    r.$('.list-group-item').each((_, e) => {
      const row = r.$(e), a = row.find('a[href*="/play/"],a[href$="/play"]').first(), name = text(row.find('.row.d-none').text());
      if (a.length && name) items.push({ vod_id: webUrl(a.attr('href'), r.url), vod_name: name, vod_pic: row.find('.col-xs-1 img').first().attr('data-src'), vod_remarks: text(row.find('.btn-default').text()) });
    });
  } else items = cards(r.$, selector, r.url, kind);
  if (kind === 'Music') r.$('div.pull-right > div > ul > li > a').each((_, e) => { const a = r.$(e); if (a.attr('href')) classes.push({ type_id: a.attr('href'), type_name: text(a.attr('title') || a.text()) }); });
  if (!items.length && !keyword && kind !== 'Kanqiu') throw new Error('未读取到内容，源站可能已变更地址或页面结构');
  return { class: classes, list: items, page: pg, pagecount: items.length >= 20 ? Number(pg) + 1 : Number(pg) };
}
async function detail(site, id, signal) {
  if (id.startsWith('magnet:?')) return site.torrents.detail(id, signal);
  if (site.plugin === 'Kanqiu') {
    const data = json((await resource(id.replace(/\/play\/?$/, '/source').replace('/play/', '/source/'), { headers: site.headers, signal })).text).data;
    const decoded = typeof data === 'string' ? json(Buffer.from(data.slice(6, -2), 'base64').toString()) : data;
    const episodes = (decoded?.links || []).map(row => ({ name: row.name, id: row.url }));
    if (!episodes.length) throw new Error('比赛尚未开始或没有可用线路');
    return { vod_id: id, vod_name: '赛事直播', lines: [{ name: '直播', episodes }] };
  }
  const { $, url } = await page(site, id, signal), kind = site.plugin;
  const result = { vod_id: id, vod_name: text($('h1.movie-name,.article_container > h1,h3.slide-info-title,.play_list h1,h1').first().text()), vod_pic: $('#post_content img,.movie-title-mpic img,img.lazy,.play_list img').first().attr('data-src') || $('#post_content img,.movie-title-mpic img,.play_list img').first().attr('src'), vod_content: text($('#height_limit,.context,.movie-title-detail,.description').first().text()), lines: [] };
  const selectors = kind === 'SixV' ? ['#post_content table'] : kind === 'Fy' ? ['.anthology-list-box'] : kind === 'Music' ? ['.play_list > ul'] : ['#tabwrapper-all'];
  for (const selector of selectors) $(selector).slice(0, 50).each((i, node) => {
    const episodes = [];
    $(node).find('a[href]').slice(0, 3000).each((_, element) => {
      const a = $(element), href = a.attr('href');
      if (kind === 'SixV' ? !href.startsWith('magnet:?') : kind === 'YGP' ? !/\/trailer\//.test(href) && !a.hasClass('tlist-bbs-tdtitle') : kind === 'Fy' ? !/\/play\//.test(href) : !/\.html|radio/.test(href)) return;
      episodes.push({ name: text(a.text()) || '播放', id: href.startsWith('magnet:') ? href : webUrl(href, url) });
    });
    if (episodes.length) result.lines.push({ name: kind === 'SixV' ? '磁力 ' + (i + 1) : '线路 ' + (i + 1), episodes: [...new Map(episodes.map(e => [e.id, e])).values()] });
  });
  if (!result.lines.length) throw new Error(kind === 'YGP' ? '该影片暂未发布预告片' : '详情中没有可播放剧集');
  return result;
}
function xxteaDecrypt(bytes, password) {
  if (!bytes.length || bytes.length % 4) throw new Error('赛事播放参数无效');
  const values = Array.from({ length: bytes.length / 4 }, (_, i) => bytes.readUInt32LE(i * 4));
  const keyBytes = Buffer.alloc(16); Buffer.from(password).copy(keyBytes, 0, 0, 16);
  const key = Array.from({ length: 4 }, (_, i) => keyBytes.readUInt32LE(i * 4)), n = values.length - 1;
  let sum = Math.imul(Math.floor(6 + 52 / values.length), 0x9e3779b9) >>> 0, y = values[0];
  while (sum) {
    const e = sum >>> 2 & 3;
    for (let p = n; p >= 0; p--) {
      const z = values[p ? p - 1 : n];
      const mx = ((z >>> 5 ^ y << 2) + (y >>> 3 ^ z << 4) ^ (sum ^ y) + (key[(p & 3) ^ e] ^ z)) >>> 0;
      y = values[p] = values[p] - mx >>> 0;
    }
    sum = sum - 0x9e3779b9 >>> 0;
  }
  const output = Buffer.alloc(values.length * 4); values.forEach((v, i) => output.writeUInt32LE(v, i * 4));
  const length = values[n];
  if (length > output.length - 4 || length < output.length - 7) throw new Error('赛事播放参数解码失败');
  return output.subarray(0, length).toString();
}
async function resolve(site, episode, signal) {
  if (episode.id.startsWith('torrent:')) return site.torrents.resolve(episode.id, signal);
  if (episode.id.startsWith('magnet:?')) throw new Error('请先打开磁力文件列表再选择文件播放');
  if (site.plugin === 'YGP') {
    const id = new URL(episode.id).pathname.split('/').filter(Boolean).at(-1);
    const data = json((await resource(new URL('/?view=api&mode=download-data&rand=' + Math.random() + '&ttid=' + encodeURIComponent(id), site.api).href, { headers: site.headers, signal })).text);
    if (!data?.[0]?.movurl) throw new Error('预告接口未返回媒体地址');
    return { url: data[0].movurl, parse: 0, header: site.headers };
  }
  if (site.plugin === 'Music') {
    const id = /\/([^/]+)\.html/.exec(episode.id)?.[1];
    if (/mp4/.test(episode.id) && id) return { url: new URL('/data/down.php?ac=vplay&id=' + id + '&q=1080', site.api).href, parse: 0, header: site.headers };
  }
  if (site.plugin === 'Kanqiu') {
    const url = new URL(episode.id), direct = url.searchParams.get('url');
    if (direct) return { url: direct, parse: 0, isLive: true, header: site.headers };
    const r = await page(site, episode.id, signal), encoded = /encodedStr\s*=\s*['"]([^'"]+)['"]/.exec(r.text)?.[1];
    if (encoded) return { url: json(xxteaDecrypt(Buffer.from(encoded, 'base64'), 'ABCDEFGHIJKLMNOPQRSTUVWX')).url, parse: 0, isLive: true, header: site.headers };
  }
  try { return await resolvePage(site, episode.id, signal); }
  catch (error) { if (!site.browser) throw error; return site.browser.run(episode.id, { media: true, signal }); }
}
module.exports = { describe, list, detail, resolve, xxteaDecrypt };
