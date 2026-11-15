const { XMLParser } = require('fast-xml-parser');
const { resource, postResource } = require('./http');
const { json, webUrl, decodeFtyExtension, cleanHeaders } = require('./format');
const htmlSites = require('./providers');
const playback = require('./playback');

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', trimValues: true });
const array = value => value == null ? [] : Array.isArray(value) ? value : [value];
const text = value => String(value?.['#text'] ?? value ?? '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const MAX_ITEMS = 500;

function describeSite(raw, base, index) {
  const site = { key: String(raw.key || index), name: text(raw.name || raw.key || '未命名站点'), type: Number(raw.type ?? 1), api: String(raw.api || ''), headers: cleanHeaders(raw.header || raw.headers), searchable: Number(raw.searchable ?? 1) === 1, quickSearch: Number(raw.quickSearch ?? 1) === 1, changeable: Number(raw.changeable ?? 1) === 1, supported: false, reason: '' };
  try {
    const adapter = htmlSites.describe(raw, base);
    if (adapter) return Object.assign(site, adapter);
    let endpoint = site.api;
    if (/^csp_T4(?:Guard)?$/.test(site.api)) {
      const extension = decodeFtyExtension(raw.ext);
      endpoint = extension.siteUrl;
      site.type = Number(extension.type ?? 1);
      site.categories = Array.isArray(extension.categories) ? extension.categories : [];
      site.implementation = 'node-fty-t4';
    }
    if (![0, 1, 4].includes(site.type)) {
      site.reason = /^csp_AiDj/.test(endpoint) ? 'AI剧的原生设备注册、请求签名与加密媒体链路仍待移植' : /\.js(?:[?;]|$)/i.test(endpoint) ? '此 JavaScript 站点尚需移植为 Node.js 适配器' : '此站点的 Android 插件业务接口尚未移植';
      return site;
    }
    site.api = webUrl(endpoint, base);
    site.playUrl = String(raw.playUrl || '');
    site.extension = /^csp_T4(?:Guard)?$/.test(raw.api) ? '' : typeof raw.ext === 'string' ? raw.ext : raw.ext && typeof raw.ext === 'object' ? JSON.stringify(raw.ext) : '';
    site.supported = true;
    site.implementation ||= site.type === 4 ? 'node-catvod-api' : site.type === 0 ? 'node-cms-xml' : 'node-cms-json';
  } catch (error) { site.reason = error.message; }
  return site;
}

function normalizeVideo(item, base) {
  const value = key => text(item[key]);
  let picture = '';
  try { if (item.vod_pic || item.pic) picture = webUrl(item.vod_pic || item.pic, base); } catch {}
  let from = value('vod_play_from'), play = String(item.vod_play_url || '');
  if (!play && item.dl?.dd) {
    const lines = array(item.dl.dd);
    from = lines.map(line => line['@_flag'] || '播放线路').join('$$$');
    play = lines.map(line => typeof line === 'string' ? line : line['#text'] || '').join('$$$');
  }
  const flags = from.split('$$$');
  const lines = play ? play.split('$$$').slice(0, 30).map((entry, line) => ({
    name: flags[line] || `线路 ${line + 1}`,
    episodes: entry.split('#').filter(Boolean).slice(0, 2000).map((episode, index) => {
      const separator = episode.indexOf('$');
      return { name: separator >= 0 ? text(episode.slice(0, separator)) : `第 ${index + 1} 集`, id: separator >= 0 ? episode.slice(separator + 1).trim() : episode.trim() };
    }),
  })).filter(line => line.episodes.length) : [];
  const id = value('vod_id') || value('id'), title = value('vod_name') || value('name') || '未命名视频';
  const searchTitle = value('searchTitle') || (id.startsWith('msearch:') ? title : '');
  return { id, title, picture, remarks: value('vod_remarks') || value('note'), year: value('vod_year') || value('year'), area: value('vod_area') || value('area'), actor: value('vod_actor') || value('actor'), director: value('vod_director') || value('director'), description: value('vod_content') || value('des'), category: value('type_name') || value('type'), lines, ...(searchTitle ? { searchTitle } : {}), ...(item.schedule ? { schedule: require('./schedule').schedule(item.schedule) } : {}) };
}

function normalizeCatalog(data, base) {
  let root = data;
  if (root.rss) {
    const rss = root.rss, list = rss.list || {};
    root = { list: array(list.video), class: array(rss.class?.ty).map(item => ({ type_id: item['@_id'], type_name: item['#text'] })), page: list['@_page'], pagecount: list['@_pagecount'], total: list['@_recordcount'] };
  } else if (!root.list && root.data) root = Array.isArray(root.data) ? { ...root, list: root.data } : { ...root, ...root.data };
  const classes = array(root.class || root.classes).filter(item => item && item.type_id != null).map(item => ({ id: String(item.type_id), name: text(item.type_name) }));
  return { classes, filters: root.filters || {}, notice: text(root.notice), list: array(root.list).filter(item => item && typeof item === 'object').slice(0, MAX_ITEMS).map(item => ({...normalizeVideo(item, base),folder:Boolean(item.folder)})), page: Math.max(1, Number(root.page) || 1), pageCount: Math.max(1, Number(root.pagecount || root.pageCount) || 1), total: Math.max(0, Number(root.total) || 0) };
}

async function requestCatalog(site, params, signal) {
  if (!site.supported) throw Object.assign(new Error(site.reason || '该站点尚不兼容'), { status: 422 });
  const url = new URL(site.api);
  for (const [key, value] of Object.entries(params)) if (value != null && value !== '') url.searchParams.set(key, String(value));
  const extension = typeof site.extension === 'string' ? site.extension : '';
  if (extension) url.searchParams.set('extend', extension);
  let response;
  if (extension.length > 1000) {
    const query = new URL(site.api);
    response = await postResource(query.href, new URLSearchParams({...params,extend:extension}).toString(), {headers:site.headers,signal,contentType:'application/x-www-form-urlencoded'});
  } else response = await resource(url.href, { headers: site.headers, signal });
  let data;
  try { data = /^\s*</.test(response.text) ? xml.parse(response.text) : json(response.text); } catch { throw new Error('站点未返回可识别的点播数据'); }
  if (!data || typeof data !== 'object') throw new Error('站点返回了空数据');
  return { data, url: response.url };
}

async function home(site, signal) {
  if (site.adapter) return normalizeCatalog(await htmlSites.list(site, {}, signal), site.api);
  const result = await requestCatalog(site, site.type === 4 ? { filter: 'true' } : {}, signal);
  let normalized = normalizeCatalog(result.data, result.url);
  if (!normalized.classes.length && site.type !== 4) {
    const categories = await requestCatalog(site, { ac: 'list' }, signal);
    normalized.classes = normalizeCatalog(categories.data, categories.url).classes;
  }
  if (site.categories?.length) {
    const desired = new Set(site.categories);
    const subset = normalized.classes.filter(category => desired.has(category.name));
    if (subset.length) normalized.classes = subset;
  }
  return normalized;
}

async function category(site, { id = '', page = 1, keyword = '', filters = {} } = {}, signal) {
  if (site.adapter) return normalizeCatalog(await htmlSites.list(site, { id, page, keyword, filters }, signal), site.api);
  const params = { ac: site.type === 0 ? 'videolist' : 'detail', pg: Math.max(1, Math.min(100000, Number(page) || 1)) };
  if (id) params.t = id;
  if (keyword) { params.wd = String(keyword).slice(0, 200); params.quick = 'false'; delete params.ac; delete params.t; }
  if (site.type === 4) params.ext = Buffer.from(JSON.stringify(filters)).toString('base64url');
  if (site.type === 1 && Object.keys(filters).length) params.f = JSON.stringify(filters);
  const result = await requestCatalog(site, params, signal);
  return normalizeCatalog(result.data, result.url);
}

async function detail(site, id, signal) {
  if (site.adapter) {
    const raw = await htmlSites.detail(site, id, signal);
    return { ...normalizeVideo(raw, site.api), lines: raw.lines, ...(raw.searchTitle ? { searchTitle: text(raw.searchTitle) } : {}) };
  }
  const result = await requestCatalog(site, { ac: site.type === 0 ? 'videolist' : 'detail', ids: String(id).slice(0, 4000) }, signal);
  const data = normalizeCatalog(result.data, result.url);
  const video = data.list.find(item => item.id === String(id)) || data.list[0];
  if (!video) throw new Error('站点没有返回影片详情');
  return video;
}

function mediaHint(url, hint = '') {
  const value = String(hint).toLowerCase();
  if (/m3u8|mpegurl|hls/.test(value) || /\.m3u8?(?:[?#]|$)/i.test(url)) return 'application/vnd.apple.mpegurl';
  if (/flv/.test(value) || /\.flv(?:[?#]|$)/i.test(url)) return 'video/x-flv';
  if (/mpegts|mp2t/.test(value) || /\.ts(?:[?#]|$)/i.test(url)) return 'video/mp2t';
  return '';
}

function directMedia(url, hint) { return Boolean(mediaHint(url, hint) || /\.(mp4|m4v|webm|mp3|m4a|aac|ogg|wav)(?:[?#]|$)/i.test(url)); }

async function resolve(site, line, episode, parsers, parserKey, signal, options = {}) {
  let result = { url: episode.id, parse: directMedia(episode.id) ? 0 : 1, playUrl: site.playUrl || '' };
  if (site.adapter) result = await htmlSites.resolve(site, episode, signal);
  else if (site.type === 4) result = (await requestCatalog(site, { play: episode.id, flag: line.name }, signal)).data;
  return playback.resolvePlayback(site, result, { parsers, parserKey, signal, flag: line.name, quality: options.quality });
}

module.exports = { describeSite, normalizeCatalog, normalizeVideo, home, category, detail, resolve, mediaHint };
