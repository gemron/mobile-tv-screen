// Native implementations of the public search and radio interfaces declared by XS.
const { resource, postJson } = require('../http');
const { json, webUrl, cleanHeaders } = require('../format');
const cloud = require('./cloud-sources');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
const endpoints = { Baiku: 'https://api.kuleu.com/', GuiGui: 'https://api.guiguiya.com/', QuPanSo: 'https://b.funletu.com/', Jike: 'https://api.uuuka.com/', QingtingFM: 'https://www.qtfm.cn/' };
const clean = value => String(value || '').replace(/<[^>]*>/g, '').trim();
function describe(raw, base) {
  const plugin = /^csp_(\w+)$/.exec(raw.api)?.[1];
  if (!endpoints[plugin]) return null;
  const api = webUrl(raw.ext?.siteUrl || endpoints[plugin], base);
  return { adapter: 'xs-search-' + plugin, plugin, api, supported: true, implementation: 'node-' + plugin.toLowerCase(), headers: cleanHeaders({ 'user-agent': UA, referer: api, ...raw.header, ...raw.headers }) };
}
async function get(site, path, signal) { return json((await resource(webUrl(path, site.api), { headers: site.headers, signal, timeout: 12000 })).text); }
const rows = value => Array.isArray(value) ? value : [];
function share(row) {
  const url = row.source_link || row.viewlink || row.url || row.link;
  if (!url || !/^https?:\/\//i.test(url)) return null;
  return { vod_id: url, vod_name: clean(row.title || row.name || '网盘分享'), vod_pic: row.cover || row.pic || '', vod_remarks: clean(row.update_time || row.updatetime || row.addtime || (row.episodes ? row.episodes + ' 集' : '')) };
}
const radioClasses = [['433','资讯'],['442','音乐'],['429','交通'],['439','经济'],['432','文艺'],['441','都市'],['430','体育'],['217','广东'],['7','北京'],['19','上海']].map(([type_id,type_name])=>({type_id,type_name}));
async function radio(site, id, page, keyword, signal) {
  // GraphQL string arguments are JSON-escaped, never interpolated as syntax.
  const query = keyword ? `{searchResultsPage(keyword:${JSON.stringify(keyword)},page:${page},include:"channel_live"){searchData,numFound}}` : `{radioPage(cid:${Number(id) || 433},page:${page}){contents}}`;
  const data = await postJson('https://webbff.qtfm.cn/www', { query }, { headers: site.headers, signal });
  if (data.errors?.length) throw new Error('蜻蜓接口未返回电台列表');
  let result = keyword ? data.data?.searchResultsPage?.searchData : data.data?.radioPage?.contents;
  if (typeof result === 'string') result = json(result);
  const items = rows(result?.items || result?.channel_live || result).map(row => ({ vod_id: String(row.id), vod_name: row.title, vod_pic: row.imgUrl || row.cover, vod_remarks: row.desc || row.description }));
  return { class: radioClasses, list: items, page, pagecount: items.length >= 12 ? page + 1 : page };
}
async function list(site, { id = '', page = 1, keyword = '' } = {}, signal) {
  page = Math.max(1, Math.min(10000, Number(page) || 1));
  if (site.plugin === 'QingtingFM') return radio(site, id, page, keyword, signal);
  if (!keyword && site.plugin !== 'Jike') return { class: [], list: [], page: 1, pagecount: 1, notice: '输入片名搜索网盘分享；播放时使用你自己的网盘账号。' };
  let data, items, classes = [];
  if (site.plugin === 'Baiku') data = await get(site, '/api/bddj?text=' + encodeURIComponent(keyword), signal), items = data.data;
  if (site.plugin === 'GuiGui') data = await get(site, '/api/video/duanju?act=search&name=' + encodeURIComponent(keyword), signal), items = data.data;
  if (site.plugin === 'QuPanSo') {
    data = await postJson(webUrl('/search', site.api), { keyword, categoryid: 0, filetypeid: 1, courseid: 1, page, pageSize: 15, sortBy: 'sort', order: 'desc', offset: 0 }, { headers: { ...site.headers, origin: new URL(site.api).origin }, signal });
    items = data.data?.list;
  }
  if (site.plugin === 'Jike') {
    classes = [['movie','电影'],['tv','电视剧'],['dongman','动漫'],['post','短剧']].map(([type_id,type_name])=>({type_id,type_name}));
    data = await get(site, keyword ? '/api/search?' + new URLSearchParams({ keyword, page, limit: 20 }) : '/api/contents/' + encodeURIComponent(id || 'movie') + '?page=' + page + '&limit=20', signal);
    items = data.data?.items || data.data?.list || data.data;
  }
  if (data?.success === false || data?.code && ![0,1,200].includes(Number(data.code))) throw new Error(clean(data.message || data.msg || '搜索接口暂不可用'));
  const found = rows(items).map(share).filter(Boolean);
  return { class: classes, list: found, page, pagecount: Number(data?.data?.total_pages) || (found.length >= 15 ? page + 1 : page) };
}
async function detail(site, id, signal) {
  if (site.plugin !== 'QingtingFM') return site.cloud.detail(id, signal);
  if (!/^\d+$/.test(id)) throw new Error('电台编号无效');
  const data = json((await resource('https://webapi.qtfm.cn/api/pc/radio/' + id, { headers: site.headers, signal })).text).album;
  if (!data) throw new Error('蜻蜓电台详情不存在');
  return { vod_id: id, vod_name: data.title, vod_pic: data.cover, vod_content: data.description, lines: [{ name: '在线电台', episodes: [{ name: data.title, id: String(data.id || id) }] }] };
}
async function resolve(site, episode, signal) {
  if (site.plugin === 'QingtingFM') {
    if (!/^\d+$/.test(episode.id)) throw new Error('电台编号无效');
    return { url: 'https://lhttp-hw.qtfm.cn/live/' + episode.id + '/64k.mp3', parse: 0, isLive: true, header: site.headers };
  }
  return cloud.resolve(site, episode, signal);
}
module.exports = { describe, list, detail, resolve };
