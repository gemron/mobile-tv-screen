const { resource } = require('../http');
const { json, webUrl } = require('../format');
const { extract } = require('../literals');
const cheerio = require('cheerio');
function describe(raw) {
  const plugin = /^csp_(DouDou|Sssp)(?:Guard)?$/.exec(raw.api)?.[1]; if (!plugin) return null;
  return { adapter: 'discovery-' + plugin, plugin, api: plugin === 'DouDou' ? 'https://movie.douban.com/' : 'https://play.ruanyazyk.com/', supported: true, implementation: 'node-' + plugin.toLowerCase(), headers: { 'user-agent': 'Mozilla/5.0', referer: plugin === 'DouDou' ? 'https://movie.douban.com/' : 'https://play.ruanyazyk.com/' } };
}
async function shortSources(site, signal) {
  if (site.sourceList) return site.sourceList;
  const script = (await resource(new URL('/static/js/mm-api.js', site.api).href, { headers: site.headers, signal })).text;
  const rows = extract(script, /(?:const|let|var)\s+_apiList\s*=/);
  const list = (rows || []).flatMap(row => { const data = row.apiData; if (!data?.api) return []; try { return [{ vod_id: webUrl(data.api), vod_name: data.apiTitle || row.title || '短视频', vod_remarks: '随机视频' }]; } catch { return []; } });
  if (!list.length) throw new Error('短视频源列表格式已变化'); return site.sourceList = list;
}
async function list(site, { id = 'movie', page = 1, keyword = '' } = {}, signal) {
  if (site.plugin === 'Sssp') return { class: [], list: (await shortSources(site, signal)).filter(v => !keyword || v.vod_name.includes(keyword)), page: 1, pagecount: 1 };
  const data = json((await resource(new URL('/j/search_subjects?' + new URLSearchParams({ type: id === 'tv' ? 'tv' : 'movie', tag: '热门', page_limit: '20', page_start: String((Number(page) - 1) * 20) }), site.api).href, { headers: site.headers, signal })).text);
  return { class: [{ type_id: 'movie', type_name: '热门电影' }, { type_id: 'tv', type_name: '热门剧集' }], list: (data.subjects || []).filter(v => !keyword || v.title.includes(keyword)).map(v => ({ vod_id: v.url, vod_name: v.title, vod_pic: v.cover, vod_remarks: '豆瓣 ' + v.rate })), page, pagecount: data.subjects?.length >= 20 ? Number(page) + 1 : Number(page), notice: '豆瓣提供片单。打开影片后点击“查找片源”，从你导入的点播源中选择播放。' };
}
async function detail(site, id, signal) {
  if (site.plugin === 'Sssp') return { vod_id: id, vod_name: '随机短视频', lines: [{ name: '短视频', episodes: Array.from({ length: 100 }, (_, i) => ({ name: '第 ' + (i + 1) + ' 条', id })) }] };
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
