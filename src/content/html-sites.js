// Original Node adapters for the public HTML interfaces used by these spiders.
// No Android bytecode, native library or third-party page script is executed.
const cheerio = require('cheerio');
const { resource, postJson } = require('./http');
const { webUrl, json, cleanHeaders } = require('./format');

const definitions = {
  Dm84: { url: 'http://dmbus.cc/', kind: 'dm84' },
  Auete: { url: 'https://www.au1080.top/', kind: 'auete' },
  FirstAid: { url: 'https://m.youlai.cn/', kind: 'firstaid' },
};
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const trim = value => String(value || '').replace(/\s+/g, ' ').trim();
const aidClasses = ['急救技能', '家庭生活', '急危重症', '常见损伤', '动物致伤', '海洋急救', '中毒急救', '意外事故'].map((type_name, i) => ({ type_id: 'jijiu|' + i, type_name }));

function describe(raw, base) {
  const name = /^csp_(\w+?)(?:Guard)?$/.exec(raw.api)?.[1], definition = definitions[name];
  if (!definition) return null;
  // An explicit endpoint also makes private/self-hosted compatible mirrors usable.
  const extension = typeof raw.ext === 'object' && raw.ext || {};
  return { api: webUrl(extension.siteUrl || definition.url, base), adapter: definition.kind, implementation: 'node-html-' + definition.kind, headers: cleanHeaders({ 'user-agent': UA, ...raw.header, ...raw.headers }), supported: true };
}

async function page(site, address, signal) {
  const response = await resource(webUrl(address, site.api), { headers: site.headers, signal, limit: 4 * 1024 * 1024 });
  return { $: cheerio.load(response.text), url: response.url, text: response.text };
}

function cards($, kind) {
  const selector = kind === 'dm84' ? 'div.item' : 'ul.threadlist li';
  const items = [];
  $(selector).slice(0, 300).each((_, element) => {
    const card = $(element), anchor = card.find(kind === 'dm84' ? 'a.title' : 'h2 a').first();
    const id = anchor.attr('href'), title = trim(anchor.attr('title') || anchor.text());
    if (id && title) items.push({ vod_id: id, vod_name: title, vod_pic: kind === 'dm84' ? card.find('a.cover').attr('data-bg') : card.find('a.pic img').attr('src'), vod_remarks: card.find(kind === 'dm84' ? 'span.desc' : 'span.hdtag').text() });
  });
  return [...new Map(items.map(item => [item.vod_id, item])).values()];
}

function pagination($, pageNumber, count) {
  const numbers = $('ul.pagination a, .page a, .pages a').map((_, element) => Number($(element).text().trim())).get().filter(n => Number.isInteger(n) && n > 0 && n < 100000);
  // A visible next link still works when the site shows only nearby page numbers.
  const next = $('a').filter((_, element) => /^(下一页|下页|Next|›|»)$/.test(trim($(element).text()))).length;
  return { page: pageNumber, pagecount: Math.max(pageNumber, ...numbers, next ? pageNumber + 1 : pageNumber), total: count };
}

async function list(site, { id = '', page: requested = 1, keyword = '', filters = {} } = {}, signal) {
  const pg = Math.max(1, Math.min(100000, Number(requested) || 1));
  if (site.adapter === 'firstaid') return aidList(site, id, keyword, signal);
  let address = site.api;
  if (site.adapter === 'dm84') {
    if (keyword) address = '/s----------.html?wd=' + encodeURIComponent(keyword) + '&page=' + pg;
    else if (id) address = `/show-${encodeURIComponent(id)}--${encodeURIComponent(filters.by || 'time')}-${encodeURIComponent(filters.type || '')}--${encodeURIComponent(filters.year || '')}-${pg}.html`;
  } else {
    if (keyword) address = '/auete4so.php?searchword=' + encodeURIComponent(keyword) + (pg > 1 ? '&page=' + pg : '');
    else if (id) address = '/' + String(id).replace(/^\/+|\/+$/g, '') + '/index' + (pg > 1 ? pg : '') + '.html';
  }
  const { $, url } = await page(site, address, signal), items = cards($, site.adapter);
  const classes = [];
  if (!id && !keyword) $(site.adapter === 'dm84' ? 'ul.nav_row a' : 'ul.navbar-nav a').each((_, element) => {
    const a = $(element), href = a.attr('href') || '', name = trim(a.text());
    if (site.adapter === 'dm84') {
      const match = /\/list-([^/.]+)\.html/.exec(href);
      if (match) classes.push({ type_id: match[1], type_name: name });
    } else if (['电影', '电视剧', '综艺', '动漫', '其他'].includes(name)) classes.push({ type_id: new URL(href, url).pathname.replace(/^\/|\/$/g, '').replace(/\/index\.html$/, ''), type_name: name });
  });
  if (!items.length && !classes.length && !keyword) throw new Error('站点页面结构已变化或暂不可用，未读到影片列表');
  return { list: items, class: classes, ...pagination($, pg, items.length) };
}

async function aidList(site, id, keyword, signal) {
  const index = Math.max(0, Math.min(7, Number(String(id || 'jijiu|0').split('|')[1]) || 0));
  const { $ } = await page(site, keyword ? '/cse/search?q=' + encodeURIComponent(keyword) : '/jijiu', signal);
  const items = [], selector = keyword ? '.search-video-li' : '.jj-title-li';
  const containers = keyword ? $(selector) : $(selector).eq(index).find('.list-br3');
  containers.slice(0, 300).each((_, element) => {
    const item = $(element), a = item.find('a').first(), href = a.attr('href');
    if (href) items.push({ vod_id: href, vod_name: trim(item.find('h5').text() || a.text()), vod_pic: item.find('img').attr('src') || $('.block100').eq(index).attr('src') });
  });
  return { list: items, class: aidClasses, page: 1, pagecount: 1, total: items.length };
}

async function detail(site, id, signal) {
  const { $, url } = await page(site, id, signal), meta = name => $(`meta[property="${name}"], meta[name="${name}"]`).first().attr('content') || '';
  const video = { vod_id: id, vod_name: trim($('h1.v_title, h1.detail-title, .video-title.h1-title').first().text() || meta('og:title')), vod_pic: meta('og:image') || $('.detail-poster img, .video-cover img').first().attr('src'), vod_content: meta('og:description') || trim($('.detail-des, .img-text-con').first().text()), vod_actor: meta('og:video:actor') || trim($('span.doc-name').text()), vod_director: meta('og:video:director'), vod_year: meta('og:video:release_date'), vod_area: meta('og:video:area'), type_name: meta('og:video:class'), lines: [] };
  if (site.adapter === 'firstaid') {
    const source = $('#video source, video source, video[src]').first(), src = source.attr('src');
    if (src) video.lines.push({ name: '公开视频', episodes: [{ name: video.vod_name, id: webUrl(src, url) }] });
  } else {
    const groups = site.adapter === 'dm84' ? $('ul.play_list') : $('div.play-card#player_list');
    groups.slice(0, 30).each((index, element) => {
      const group = $(element), name = trim(site.adapter === 'dm84' ? $('ul.tab_control > li').eq(index).text() : group.find('.card-header b').text());
      const episodes = [];
      group.find(site.adapter === 'dm84' ? 'a[href]' : 'ul.episode-list a[href]').slice(0, 2000).each((_, anchor) => {
        const a = $(anchor); episodes.push({ name: trim(a.text()), id: webUrl(a.attr('href'), url) });
      });
      if (episodes.length) video.lines.push({ name: name || '线路 ' + (index + 1), episodes });
    });
  }
  if (!video.vod_name || !video.lines.length) throw new Error('未读到影片详情或剧集，站点可能暂时维护');
  return video;
}

// Read a JSON object from script text using balanced brackets and quoted-string
// handling. Page JavaScript is never evaluated, including base64 expressions.
function scriptObject(source, marker) {
  const match = marker.exec(source);
  if (!match) return null;
  const start = source.indexOf('{', match.index + match[0].length);
  if (start < 0) return null;
  let depth = 0, quoted = false, escaped = false;
  for (let i = start; i < Math.min(source.length, start + 200000); i++) {
    const c = source[i];
    if (quoted) { if (escaped) escaped = false; else if (c === '\\') escaped = true; else if (c === '"') quoted = false; }
    else if (c === '"') quoted = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) { try { return json(source.slice(start, i + 1)); } catch { return null; } }
  }
  return null;
}

async function resolve(site, episode, signal) {
  if (site.adapter === 'firstaid') return { url: webUrl(episode.id, site.api), parse: 0, header: site.headers };
  let response = await page(site, episode.id, signal);
  const headers = { ...site.headers, referer: response.url };
  const direct = value => /\.(m3u8|mp4|flv)(?:[?#]|$)/i.test(value || '');
  let url = response.$('video[src], source[src]').first().attr('src');
  if (site.adapter === 'dm84') {
    const frame = response.$('iframe[src]').first().attr('src');
    if (!url && frame) {
      const address = new URL(frame, response.url), media = address.searchParams.get('url');
      if (direct(media)) url = media;
      else if (direct(address.href)) url = address.href;
      else response = await page(site, address.href, signal);
    }
    const bootstrap = scriptObject(response.text, /window\.__HHJX_BOOTSTRAP__\s*=|var\s+player_\w+\s*=/);
    if (bootstrap?.key && bootstrap.url) {
      const parsed = await postJson('https://hhjx.hhplayer.com/api/parse', { url: bootstrap.url, t: Number(bootstrap.t) || 0, key: bootstrap.key, client_fallback: false }, { headers: { ...headers, origin: 'https://hhjx.hhplayer.com' }, signal });
      url = parsed.url;
    } else if (bootstrap?.url) url = decodePlayerUrl(bootstrap);
    if (!url) {
      const frame = response.$('iframe[src]').first().attr('src');
      if (frame) { const u = new URL(frame, response.url); url = u.searchParams.get('url') || (direct(u.href) ? u.href : ''); }
    }
  } else {
    const literal = /\bvar\s+now\s*=\s*(["'])([^"'\r\n]+)\1/.exec(response.text);
    if (literal) url = literal[2];
      const encoded = /\bvar\s+now\s*=\s*base64(?:decode)?\s*\(\s*["']([A-Za-z0-9+/=]+)["']\s*\)/.exec(response.text);
    if (encoded) url = Buffer.from(encoded[1], 'base64').toString('utf8');
  }
  if (!url || !direct(url)) throw new Error('该线路未返回直链媒体，请选择其他线路或 JSON 解析器');
  // Dm84's MP4 CDN rejects a page Referer. Use only its declared media headers.
  return { url: webUrl(url, response.url), parse: 0, header: site.adapter === 'dm84' ? site.headers : headers };
}

function decodePlayerUrl(player) {
  let url = String(player.url || '');
  if (Number(player.encrypt) === 2) url = Buffer.from(url, 'base64').toString('utf8');
  if ([1, 2].includes(Number(player.encrypt))) { try { url = decodeURIComponent(url); } catch {} }
  return url;
}

module.exports = { describe, list, detail, resolve, scriptObject };
