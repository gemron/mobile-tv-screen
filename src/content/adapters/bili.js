const { createHash } = require('crypto');
const { resource } = require('../http');
const { json, webUrl, cleanHeaders } = require('../format');
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const text = value => String(value || '').replace(/<[^>]*>/g, '').trim();
const permutation = [46,47,18,2,53,8,23,32,15,50,10,31,58,3,45,35,27,43,5,49,33,9,42,19,29,28,14,39,12,38,41,13,37,48,7,16,24,55,40,61,26,17,0,1,60,51,30,4,22,25,54,21,56,59,6,63,57,62,11,36,20,34,44,52];

function describe(raw, base) {
  if (!/^csp_Bili(?:Guard)?$/.test(raw.api)) return null;
  const ext = typeof raw.ext === 'object' && raw.ext || {};
  return { adapter: 'bili', implementation: 'node-bilibili', supported: true, api: webUrl(ext.apiUrl || 'https://api.bilibili.com/', base), extension: ext, headers: cleanHeaders({ 'user-agent': UA, referer: 'https://www.bilibili.com/', ...raw.header, ...raw.headers, ...(ext.cookie ? { cookie: ext.cookie } : {}) }) };
}

function sign(params, image, sub, seconds = Math.floor(Date.now() / 1000)) {
  const combined = image + sub, key = permutation.map(i => combined[i] || '').join('').slice(0, 32);
  const data = { ...params, wts: seconds };
  const query = Object.keys(data).sort().map(k => encodeURIComponent(k) + '=' + encodeURIComponent(String(data[k]).replace(/[!'()*]/g, ''))).join('&');
  return query + '&w_rid=' + createHash('md5').update(query + key).digest('hex');
}

async function api(site, path, params = {}, signal) {
  const url = new URL(path, site.api); for (const [key, value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await resource(url.href, { headers: site.headers, signal });
  const result = json(response.text);
  if (result.code && result.code !== 0) throw new Error(`B站接口：${result.message || result.msg || result.code}`);
  return result.data || result.result || {};
}

async function search(site, keyword, page = 1, filters = {}, signal) {
  const params = { search_type: 'video', keyword: String(filters.tid || keyword), page, order: filters.order || 'totalrank', duration: filters.duration || '0' };
  try { return await api(site, '/x/web-interface/search/type', params, signal); }
  catch (error) {
    if (!/412|风控|校验|签名|-352/.test(error.message)) throw error;
    const nav = json((await resource(new URL('/x/web-interface/nav', site.api).href, { headers: site.headers, signal })).text).data;
    const key = value => new URL(value).pathname.split('/').at(-1).split('.')[0];
    if (!nav?.wbi_img) throw error;
    return api(site, '/x/web-interface/wbi/search/type?' + sign(params, key(nav.wbi_img.img_url), key(nav.wbi_img.sub_url)), {}, signal);
  }
}

async function configuration(site, signal) {
  if (!site.extension.json) return { class: [{ type_id: '综合', type_name: '综合' }] };
  if (site.biliConfig && site.biliConfig.expires > Date.now()) return site.biliConfig.data;
  const data = json((await resource(webUrl(site.extension.json), { signal })).text);
  site.biliConfig = { data, expires: Date.now() + 300000 }; return data;
}

function video(item) {
  return { vod_id: String(item.bvid || item.aid || item.id), vod_name: text(item.title), vod_pic: item.pic || item.cover, vod_remarks: item.duration ? String(item.duration) : '', vod_actor: item.author || item.owner?.name, vod_content: text(item.description || item.desc) };
}

async function list(site, { id = '', page = 1, keyword = '', filters = {} } = {}, signal) {
  const config = await configuration(site, signal);
  const classes = (config.class || []).filter(c => c.type_id !== 'peizhi');
  const word = keyword || id || classes[0]?.type_id;
  const data = word ? await search(site, word, page, filters, signal) : await api(site, '/x/web-interface/popular', { ps: 20, pn: page }, signal);
  return { class: classes, filters: config.filters || {}, list: (data.result || data.list || []).map(video), page: Number(data.page || page), pagecount: Math.min(1000, Number(data.numPages) || Math.ceil((data.total || data.count || 20) / 20)), total: Number(data.numResults || data.total || 0) };
}

async function detail(site, id, signal) {
  const data = await api(site, '/x/web-interface/view', /^BV/.test(id) ? { bvid: id } : { aid: id }, signal);
  const pages = data.pages?.length ? data.pages : [{ cid: data.cid, part: data.title }];
  const episodes = pages.map(p => ({ name: text(p.part || data.title), id: Buffer.from(JSON.stringify({ aid: data.aid, cid: p.cid, bvid: data.bvid })).toString('base64url') }));
  return { ...video(data), vod_id: id, lines: [{ name: 'B站', episodes }] };
}

async function resolve(site, episode, signal) {
  const mediaHeaders={...site.headers};delete mediaHeaders.cookie;delete mediaHeaders.authorization;
  let data; try { data = JSON.parse(Buffer.from(episode.id, 'base64url').toString()); } catch { throw new Error('B站剧集信息无效'); }
  const result = await api(site, '/x/player/playurl', { avid: data.aid, cid: data.cid, qn: 127, fnval: 1, fourk: 1 }, signal);
  if (result.durl?.length === 1) return { url: result.durl[0].url, parse: 0, header: mediaHeaders, type: 'mp4' };
  const dash = result.dash || (await api(site, '/x/player/playurl', { avid: data.aid, cid: data.cid, qn: 127, fnval: 4048, fourk: 1 }, signal)).dash;
  const videos = (dash?.video || []).filter(v => /avc|h264/i.test(v.codecs || '')).sort((a,b) => b.id - a.id || b.bandwidth - a.bandwidth);
  const audio = (dash?.audio || []).sort((a,b) => b.bandwidth - a.bandwidth)[0], selected = videos[0];
  if (!selected) throw new Error('B站未返回可播放视频，请在账号设置中登录并确认该视频的观看权限');
  return { url: selected.baseUrl || selected.base_url, audioUrl: audio?.baseUrl || audio?.base_url || '', parse: 0, header: mediaHeaders, type: 'mp4' };
}

module.exports = { describe, list, detail, resolve, sign };
