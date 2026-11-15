const { resource } = require('../http');
const { json, rc4, webUrl } = require('../format');
const { resolvePage } = require('./websites');
function describe(raw) {
  const plugin = /^csp_(JPJ|JumiTv)(?:Guard)?$/.exec(raw.api)?.[1]; if (!plugin) return null;
  return { plugin, adapter: 'legacy-' + plugin, api: raw.ext?.siteUrl || (plugin === 'JPJ' ? 'http://fan123.cqxkn.com/' : 'http://43.248.117.149:1122/api.php/localhost/'), supported: true, implementation: 'node-' + plugin.toLowerCase(), headers: { 'user-agent': plugin === 'JPJ' ? 'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Version/4.0 Chrome/131.0.0.0 Mobile Safari/537.36 appVersion:416;packageName:com.jp3.xg3' : 'okhttp/3.12.0' } };
}
function decodeText(text) { const value = text.trim(); return /^[a-f0-9]+$/i.test(value) && value.length % 2 === 0 ? rc4(Buffer.from(value, 'hex'), '520720ygq').toString() : value; }
function decode(text) { return json(decodeText(text)); }
async function request(site, path, signal) {
  let addresses = [site.api];
  if (site.plugin === 'JumiTv' && !site.endpointOverride && site.material) {
    const facts = await site.material.get('JumiTv', signal);
    addresses = [...new Set([site.api, ...facts.strings.filter(v => /^(?:\d{1,3}\.){3}\d{1,3}$/.test(v)).map(v => `http://${v}:1122/api.php/localhost/`)])].slice(0, 4);
  }
  let last;
  const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(18000)]) : AbortSignal.timeout(18000);
  for (const base of addresses) try {
    const address = new URL(path.replace(/^\//, ''), base.endsWith('/') ? base : base + '/').href;
    const response = await resource(address, { headers: { ...site.headers, referer: base }, signal: deadline, timeout: 5000 });
    const data = decode(response.text); site.workingApi = base; return data;
  } catch (error) { last = error; if (deadline.aborted) break; }
  throw new Error(`${site.plugin === 'JPJ' ? '荐片' : '橘猫'}接口暂时无法访问：${last?.message || '没有可用节点'}。可以在站点设置更新接口地址。`);
}
const array = value => Array.isArray(value) ? value : [];
function normalize(row, base) {
  let picture = row.thumbnail || row.path || row.img_url || row.pic || row.tjpicurl || '';
  try { picture = picture ? webUrl(picture, base) : ''; } catch { picture = ''; }
  return { vod_id: String(row.id || row.vod_id || /ids=(\d+)/.exec(row.nextlink || row.tjurl || '')?.[1] || ''), vod_name: row.title || row.name || row.tjinfo, vod_pic: picture, vod_remarks: row.mask || row.playlist?.title || row.trunk || row.state || '', vod_year: row.year || row.pubtime, vod_area: Array.isArray(row.area) ? row.area.join(' / ') : row.area, vod_content: row.description || row.intro, vod_actor: array(row.actors || row.actor).map(v => v.name || v.title || v).join(' / '), vod_director: array(row.directors || row.director).map(v => v.name || v.title || v).join(' / ') };
}
async function list(site, { id = '', page = 1, keyword = '', filters = {} } = {}, signal) {
  const classes = [['1', '电影'], ['2', '电视剧'], ['3', '动漫'], ['4', '综艺'], ['50', '纪录片'], ['99', 'Netflix']].map(([type_id, type_name]) => ({ type_id, type_name }));
  if (!id && !keyword && site.plugin === 'JPJ') return { class: classes, list: [], notice: '请选择分类或输入关键词。', page: 1, pagecount: 1 };
  let path;
  if (site.plugin === 'JPJ') path = keyword ? '/api/v2/search/videoV2?' + new URLSearchParams({ key: keyword, category_id: '88', page: String(page), pageSize: '20' }) : '/api/crumb/list?' + new URLSearchParams({ fcate_pid: id || '1', area: filters.area || '', year: filters.year || '', type: '0', sort: filters.by || 'updata', page: String(page), category_id: '' });
  else path = keyword ? '/So/?ac=list&zm=' + encodeURIComponent(keyword) + '&page=' + page : !id ? '/top' : '/vod/?ac=list&class=' + encodeURIComponent(id) + '&page=' + page;
  const data = await request(site, path, signal), rows = data.data?.dataList || data.dataList || data.data?.list || data.data || data.list || [], items = array(rows).map(v => normalize(v, site.workingApi));
  if (!id && !keyword && site.plugin === 'JumiTv') {
    try { const types = await request(site, '/Category?key=&tt=' + Date.now(), signal); const rows = array(types.data || types); if (rows.length) classes.splice(0, classes.length, ...rows.filter(t => Number(t.type_status) !== 0).map(t => ({ type_id: t.type_en, type_name: t.type_name }))); } catch { /* Lists remain usable if the optional category endpoint fails. */ }
  }
  return { class: classes, list: items, page, pagecount: data.totalpage || data.data?.totalPage || (items.length >= 20 ? Number(page) + 1 : Number(page)) };
}
async function detail(site, id, signal) {
  const data = await request(site, site.plugin === 'JPJ' ? '/api/video/detailv2?id=' + encodeURIComponent(id) : '/vod/?ac=detail&ids=' + encodeURIComponent(id), signal), row = Array.isArray(data.data) ? data.data[0] : data.data || data;
  if (!row) throw new Error('影片不存在');
  let groups = row.source_list_source;
  if (site.plugin === 'JumiTv') {
    let players=[];try{players=decode(row.player);}catch{}
    groups = Object.entries(row.videolist || {}).map(([name, entries]) => ({ name:array(players).find(p=>p.from===name)?.show||name, source_list: (typeof entries === 'string' ? decode(entries) : entries).map(v=>({...v,url:decodeText(v.url)})) }));
  }
  const lines = array(groups).map(group => ({ name: group.name || '线路', episodes: array(group.source_list).map(v => ({ name: v.source_name || v.title || v.name, id: v.url })) })).filter(v => v.episodes.length);
  if (!lines.length) throw new Error('此影片没有可播放线路'); return { ...normalize(row, site.workingApi), vod_id: id, lines };
}
async function resolve(site, episode, signal) {
  if(site.plugin==='JumiTv'&&!/^https?:/i.test(episode.id)){
    const origin=new URL(site.workingApi||site.api);origin.port='6001';origin.pathname='/Client/';origin.search=new URLSearchParams({url:episode.id}).toString();
    const data=decode((await resource(origin.href,{headers:{...site.headers,app:'10000',key:String(Date.now())},signal,timeout:12000})).text);
    if(!data.url)throw new Error(data.msg||data.message||'橘猫解析未返回媒体地址');return {url:data.url,parse:0,header:data.header||{}};
  }
  if (/^(ftp|tvbox-xg|jianpian):/i.test(episode.id)) throw new Error('该线路使用荐片专有下载协议，请选择 HTTP/HLS 线路');
  try { return await resolvePage(site, episode.id, signal); }
  catch (error) { if (!site.browser) throw error; return site.browser.run(webUrl(episode.id, site.api), { media: true, signal }); }
}
module.exports = { describe, list, detail, resolve, decode };
