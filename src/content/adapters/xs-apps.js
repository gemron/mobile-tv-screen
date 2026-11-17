const crypto = require('crypto');
const { inflateSync } = require('zlib');
const { resource, postResource } = require('../http');
const { json, webUrl, cleanHeaders, decodeFtyValue } = require('../format');
const { resolvePage } = require('./websites');
const array = v => Array.isArray(v) ? v : [];
const encode = value => 'xs-app:' + Buffer.from(JSON.stringify(value)).toString('base64url');
function aes(value, key, iv, encrypt = false) {
  key = Buffer.from(key || ''); iv = Buffer.from(iv || '');
  if (![16,24,32].includes(key.length) || iv.length !== 16) throw new Error('片源 AES 参数无效，请更新订阅');
  const cipher = (encrypt ? crypto.createCipheriv : crypto.createDecipheriv)('aes-' + key.length * 8 + '-cbc', key, iv);
  return Buffer.concat([cipher.update(value), cipher.final()]);
}
function describe(raw, base) {
  if(raw.api==='csp_AppSxGuard'){
    const ext=json(decodeFtyValue(raw.ext));
    return describe({...raw,api:'csp_AppGet',ext:{url:ext.host,dataKey:ext.key,dataIv:ext.iv||ext.key,version:ext.version||'113',init:ext.init||'init'}},base);
  }
  const plugin = /^csp_(AppGet|AppQi|App99)$/.exec(raw.api)?.[1]; if (!plugin) return null;
  const extension = typeof raw.ext === 'object' && raw.ext || {};
  const endpoint = extension.url || extension.host;
  if (!endpoint && !extension.site) return { supported: false, reason: '订阅未提供此 App 的接口地址' };
  return { adapter: 'xs-app-' + plugin, plugin, extension, api: webUrl(endpoint || extension.site, base), bootstrap: !endpoint, supported: true, implementation: 'node-' + plugin.toLowerCase(), deviceId: extension.deviceId || crypto.randomUUID(), headers: cleanHeaders({ 'user-agent': extension.ua || 'okhttp/3.14.9', ...raw.header, ...raw.headers }) };
}
async function endpoint(site, signal) {
  if (!site.bootstrap) return;
  const text = (await resource(site.api, { signal, limit: 65536 })).text;
  const url = text.split(/\s+/).find(v => /^https?:\/\//.test(v));
  if (!url) throw new Error('App 地址发布页未返回接口地址');
  site.api = webUrl(url); site.bootstrap = false;
}
async function getCall(site, method, body, signal, parse = false) {
  await endpoint(site, signal);
  const ext = site.extension, time = String(Math.floor(Date.now() / 1000));
  const prefix = site.plugin === 'AppQi' ? 'qijiappapi.index' : 'getappapi.index';
  const headers = { ...site.headers, 'app-user-device-id': site.deviceId, 'app-version-code': ext.version || '', 'app-api-verify-time': time, 'app-ui-mode': 'light', ...(ext.token ? { 'app-user-token': ext.token } : {}) };
  if (parse) headers['app-api-verify-sign'] = aes(Buffer.from(time), ext.dataKey, ext.dataIv, true).toString('base64');
  const path = '/api.php/' + prefix + '/' + method;
  const response = json((await postResource(webUrl(path, site.api), parse ? new URLSearchParams(body).toString() : JSON.stringify(body), { headers, signal, contentType: 'application/x-www-form-urlencoded', timeout: 12000 })).text);
  if (Number(response.code) === 1001) throw Object.assign(new Error('此片源需要在官方页面手动完成验证后重试'), { verifyUrl: site.api });
  if (response.code && ![0,1,200].includes(Number(response.code))) throw new Error(response.msg || response.message || 'App 接口拒绝请求');
  if (typeof response.data === 'object') return response.data;
  if (!response.data) throw new Error('App 接口未返回数据，请检查片源地址');
  return json(aes(Buffer.from(response.data, 'base64'), ext.dataKey, ext.dataIv).toString());
}
function decode99(site, text) {
  if (/^\s*\{/.test(text)) return json(text);
  const bytes = Buffer.from(text.trim(), 'base64'), key = site.deviceId.replace(/-/g, '');
  let plain = aes(bytes.subarray(16), key, bytes.subarray(0,16));
  try { plain = inflateSync(plain, { maxOutputLength: 8 * 1024 * 1024 }); } catch { /* Some replies omit zlib. */ }
  return json(plain.toString());
}
async function call99(site, path, body, signal) {
  const time = String(Date.now()), nonce = crypto.randomBytes(16).toString('base64'), iv = crypto.randomBytes(16);
  const payload = Buffer.concat([iv, aes(Buffer.from(JSON.stringify({ ...body, token: site.token || '', timestamp: time, nonce })), site.deviceId.replace(/-/g,''), iv, true)]).toString('base64');
  const sign = crypto.createHash('sha256').update(payload + ':' + time + ':' + nonce + ':' + (site.token || '')).digest('hex');
  const headers = { ...site.headers, client_type: 'android', uuid: site.deviceId, timestamp: time, nonce, sign, version: site.extension.versionName || '2.0.0', api_version: 'v1', accept: 'application/json' };
  const response = await postResource(new URL(site.api.replace(/\/$/,'') + path).href, payload, { headers, contentType: 'application/json', signal, timeout: 12000 });
  return decode99(site, response.text);
}
async function init99(site, signal) {
  if (site.init99) return site.init99;
  if (site.info99) return;
  if (!site.init99) site.init99 = (async()=>{
    const e = site.extension;
    site.info99 = await call99(site, '/app/systemInit', { v: e.versionName, n: e.name, s: e.buildSignature, pl: '1', apiVersion: 'v2' }, signal);
    const result = await call99(site, e.LoginPath || '/app/userInfo', { os: 'android', name: 'MobileTV', version: '15', sdkInt: 32, device: 'MobileTV', brand: 'xiaomi', manufacturer: 'xiaomi', product: 'b0q', hardware: 'xiaomi', isPhysicalDevice: true, androidId: site.deviceId, app: { version: e.versionName, name: e.name, package: e.package, buildNumber: e.buildNumber, buildSignature: e.buildSignature, install: Date.now(), update: Date.now() }, did: site.deviceId, apiVersion: 'v2', channel: '' }, signal);
    site.token = result.userInfo?.user_token || '';
  })().catch(error=>{site.info99=null;throw error;}).finally(()=>{site.init99=null;});
  return site.init99;
}
function video(v) { return { ...v, vod_id: String(v.vod_id || v.id), vod_name: v.vod_name || v.name, vod_pic: v.vod_pic || v.pic, vod_remarks: v.vod_remarks || v.remarks, vod_content: v.vod_content || v.content || v.blurb, vod_actor: v.vod_actor || v.actor, vod_director: v.vod_director || v.director, vod_year: v.vod_year || v.year }; }
function groups(row) {
  return String(row.play_url || row.vod_play_url || '').split('$$$').map((line,index)=>({ name: String(row.play_from || row.vod_play_from || '').split('$$$')[index] || '线路', episodes: line.split('#').filter(Boolean).map(item=>{const p=item.indexOf('$');return { name: p<0?'播放':item.slice(0,p), id: encode({ url:p<0?item:item.slice(p+1), flag:String(row.play_from || '').split('$$$')[index] }) };}) })).filter(line=>line.episodes.length);
}
async function list(site, { id = '', page = 1, keyword = '', filters = {} } = {}, signal) {
  let data, classes;
  if (site.plugin === 'App99') {
    await init99(site, signal);
    classes = array(site.info99.categorys?.data).map(t=>({type_id:String(t.id),type_name:t.name}));
    data = await call99(site, '/vod/search', { kw: keyword, page:String(page), limit:21, pid:keyword?'':id || '1', orderBy:filters.by || 'time', isCategory: keyword?0:1 }, signal);
    return { class:classes, list:array(data.data).map(video), page, pagecount:data.page_count || page };
  }
  const home = !id && !keyword;
  const method = home ? site.extension.init || (site.plugin === 'AppQi' ? 'initV120' : 'initV119') : keyword ? site.extension.search || 'searchList' : 'typeFilterVodList?page=' + page;
  data = await getCall(site, method, home ? {} : keyword ? { type_id:0, keywords:keyword, page:Number(page) } : { ...filters, type_id:id, page:String(page), sort:filters.by || '' }, signal);
  classes = array(data.type_list).map(t=>({type_id:String(t.type_id),type_name:t.type_name}));
  const items = array(data.recommend_list || data.search_list);
  return { class:classes, list:items.map(video), page, pagecount: Number(data.pagecount || data.total_page) || (items.length>=12?Number(page)+1:Number(page)) };
}
async function detail(site, id, signal) {
  if (site.plugin === 'App99') { await init99(site, signal); const d = (await call99(site,'/vod/detail',{id,eps:'1',v:'2.0.0',pl:1},signal)).data; if (!d) throw new Error('App 未返回影片详情'); return {...video(d),lines:groups(d)}; }
  const data = await getCall(site, 'vodDetail', { vod_id:id }, signal), row = data.vod;
  if (!row) throw new Error('App 未返回影片详情');
  const lines = array(data.vod_play_list).map(group=>({name:group.player_info?.show || group.name || '线路',episodes:array(group.urls).map(e=>({name:e.name || '播放',id:encode({url:e.url,parse:group.player_info?.parse,parseApi:e.parse_api_url,token:e.token})}))})).filter(line=>line.episodes.length);
  return { ...video(row), lines };
}
async function resolve(site, episode, signal) {
  if (!episode.id.startsWith('xs-app:') || episode.id.length > 16000) throw new Error('App 剧集参数无效');
  const data = json(Buffer.from(episode.id.slice(7),'base64url').toString());
  if (site.plugin === 'App99') {
    const player = site.info99?.player?.[data.flag];
    if (Number(player?.parse) === 1) {
      const parser = array(site.info99?.parser_api).find(p=>!p.flags || String(p.flags).includes(data.flag));
      if (parser) { const result = await call99(site,'/app/vodParser',{id:parser.id,url:data.url},signal); data.url = typeof result.data==='string'?result.data:result.data?.url; }
    }
  } else if (data.parseApi && /^https?:\/\//.test(data.parseApi)) return resolvePage(site,data.parseApi,signal);
  else if (!/\.(?:m3u8|mp4|mkv|mp3|flv)(?:[?#]|$)/i.test(data.url || '')) {
    const result = await getCall(site, 'vodParse', { parse_api:data.parse || '', url:aes(Buffer.from(data.url || ''),site.extension.dataKey,site.extension.dataIv,true).toString('base64'),token:data.token || '' }, signal, true);
    const parsed = typeof result.json === 'string' ? json(result.json) : result.json || result;
    data.url = parsed.url;
  }
  if (!data.url) throw new Error('App 未返回播放地址');
  if (/\.(mkv|webm|mov|avi|m4v|ts|aac|ogg|wav)(?:[?#]|$)/i.test(data.url)) return { url:webUrl(data.url,site.api), parse:0, header:site.headers };
  return resolvePage(site,webUrl(data.url,site.api),signal);
}
module.exports = { describe, list, detail, resolve, aes, decode99 };
