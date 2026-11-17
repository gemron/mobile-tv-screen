const { resource } = require('../http');
const { json, webUrl } = require('../format');
const { extract } = require('../literals');
const cheerio = require('cheerio');
const douban = require('./douban');
function describe(raw) {
  const name = /^csp_(DouDou|Douban|Sssp)(?:Guard)?$/.exec(raw.api)?.[1]; if (!name) return null;
  const plugin = name === 'Douban' ? 'DouDou' : name;
  const extension = raw.ext && typeof raw.ext === 'object' ? raw.ext : {};
  if (name === 'Douban') return { adapter: 'discovery-DouDou', plugin: 'DouDou', discovery: true, materialPlugin: 'Douban', api: 'https://movie.douban.com/', supported: true, implementation: 'node-douban', headers: { 'user-agent': 'Mozilla/5.0', referer: 'https://movie.douban.com/' } };
  return { adapter: 'discovery-' + plugin, plugin, discovery: plugin === 'DouDou', metadataApi: extension.metadataApi, metadataKey: extension.metadataKey, api: plugin === 'DouDou' ? 'https://movie.douban.com/' : 'https://play.ruanyazyk.com/', supported: true, implementation: 'node-' + plugin.toLowerCase(), headers: { 'user-agent': 'Mozilla/5.0', referer: plugin === 'DouDou' ? 'https://movie.douban.com/' : 'https://play.ruanyazyk.com/' } };
}
async function shortSources(site, signal) {
  if (site.sourceList) return site.sourceList;
  const script = (await resource(new URL('/static/js/mm-api.js', site.api).href, { headers: site.headers, signal })).text;
  const rows = extract(script, /(?:const|let|var)\s+_apiList\s*=/);
  const list = (rows || []).flatMap(row => { const data = row.apiData; if (!data?.api) return []; try { return [{ vod_id: webUrl(data.api), vod_name: data.apiTitle || row.title || '短视频', vod_remarks: '随机视频' }]; } catch { return []; } });
  if (!list.length) throw new Error('短视频源列表格式已变化'); return site.sourceList = list;
}
async function list(site, { id = '', page = 1, keyword = '', filters = {} } = {}, signal) {
  if (site.plugin === 'Sssp') return { class: [], list: (await shortSources(site, signal)).filter(v => !keyword || v.vod_name.includes(keyword)), page: 1, pagecount: 1 };
  return douban.list(site, { id, page, keyword, filters }, signal);
}
async function detail(site, id, signal) {
  if (site.plugin === 'Sssp') return { vod_id: id, vod_name: '随机短视频', lines: [{ name: '短视频', episodes: Array.from({ length: 100 }, (_, i) => ({ name: '第 ' + (i + 1) + ' 条', id })) }] };
  const cached = site.discoveryCards?.get(id); if (cached) return { ...cached, lines: [] };
  const response = await resource(webUrl(id, site.api), { headers: site.headers, signal });
  const $ = cheerio.load(response.text), title = $('#content h1 span[property="v:itemreviewed"]').text() || $('h1').first().text();
  return { vod_id: id, vod_name: title, vod_pic: $('#mainpic img').attr('src'), vod_content: $('#link-report').text().trim(), searchTitle: title.replace(/\s*\(\d{4}\).*$/, '').trim(), lines: [] };
}
async function resolve(site, episode, signal) {
  const response = await resource(webUrl(episode.id), { headers: site.headers, signal });
  if (/video\/|audio\//i.test(response.headers['content-type'] || '')) return { url: response.url, parse: 0, header: {} };
  let data; try { data = json(response.text); } catch { throw new Error('短视频接口未返回媒体，请换一个分类'); }
  const url = data.data?.url || data.data?.video || data.url || data.video;
  if (!url) throw new Error(data.msg || data.message || '短视频接口没有返回媒体地址'); return { url: webUrl(url), parse: 0, header: {} };
}
module.exports = { describe, list, detail, resolve };
