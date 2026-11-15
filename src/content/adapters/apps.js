const { createHash, randomUUID } = require('crypto');
const { resource, postResource } = require('../http');
const { json, webUrl, cleanHeaders, decodeFtyValue } = require('../format');
const hash = (type, input) => createHash(type).update(input).digest('hex');
const definitions = { AppTT: { endpoint: 'http://v.rbotv.cn', kind: 'apptt' }, Jpys: { endpoint: 'https://www.ghw9zwp5.com', kind: 'jpys' } };
function describe(raw, base) {
  const plugin = /^csp_(\w+?)(?:Guard)?$/.exec(raw.api)?.[1], definition = definitions[plugin];
  if (!definition) return null;
  const ext = typeof raw.ext === 'object' && raw.ext || {};
  const endpoint = typeof raw.ext === 'string' && plugin === 'AppTT' ? decodeFtyValue(raw.ext) : '';
  return { adapter: definition.kind, api: webUrl(ext.siteUrl || endpoint || definition.endpoint, base), supported: true, implementation: 'node-' + definition.kind, deviceId: randomUUID(), headers: cleanHeaders({ 'user-agent': plugin === 'AppTT' ? 'okhttp-okgo/jeasonlzy' : 'Mozilla/5.0 (X11; Linux aarch64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/148.0.0.0 Safari/537.36', ...raw.header, ...raw.headers }) };
}
async function call(site, path, params, signal) {
  const stamp = String(site.adapter === 'apptt' ? Math.floor(Date.now()/1000) : Date.now());
  let result;
  if (site.adapter === 'apptt') {
    const sign = hash('md5', '7gp0bnd2sr85ydii2j32pcypscoc4w6c7g5spl' + stamp);
    const form = new FormData(); for (const [key,value] of Object.entries({ sign, timestamp: stamp, ...params })) form.append(key,value);
    result = json((await postResource(new URL(path, site.api).href, form, { headers: site.headers, signal })).text);
  } else {
    const sorted = Object.keys(params).sort().map(k=>`${k}=${params[k]}`).join('&');
    const sign = hash('sha1', hash('md5', (sorted ? sorted+'&' : '') + 'key=cb808529bae6b6be45ecfab29a4889bc&t=' + stamp));
    const url = new URL(path, site.api); for (const [k,v] of Object.entries(params)) url.searchParams.set(k,v);
    result = json((await resource(url.href, { headers: { ...site.headers, sign, t: stamp, deviceid: site.deviceId }, signal })).text);
  }
  if (result.code && ![0,1,200].includes(Number(result.code))) throw new Error(result.msg || result.message || '站点接口拒绝请求');
  return result.data ?? result;
}
function video(item) {
  return { vod_id: String(item.vod_id || item.vodId || item.id), vod_name: item.vod_name || item.vodName || item.name, vod_pic: item.vod_pic || item.vodPic || item.vod_pic_thumb, vod_remarks: item.vod_remarks || item.vodRemarks || item.vodVersion, vod_year: item.vod_year || item.vodYear, vod_area: item.vod_area || item.vodArea, vod_actor: item.vod_actor || item.vodActor, vod_director: item.vod_director || item.vodDirector, vod_content: item.vod_content || item.vodContent || item.vodBlurb };
}
async function list(site, { id='', page=1, keyword='', filters={} }={}, signal) {
  let data, classes=[];
  if (site.adapter==='apptt') {
    if (!id && !keyword) {
      const top=await call(site,'/v3/type/top_type',{},signal); classes=top.list || [];
      id=String(classes[0]?.type_id || '1');
    }
    data=await call(site,keyword?'/v3/home/search':'/v3/home/type_search',keyword?{keyword,page:String(page),limit:'20'}:{type_id:id,page:String(page),limit:'20'},signal);
  } else {
    classes=[['1','电影'],['2','电视剧'],['4','动漫'],['3','综艺']].map(([type_id,type_name])=>({type_id,type_name}));
    data=await call(site,keyword?'/api/mw-movie/anonymous/video/searchByWord':'/api/mw-movie/anonymous/video/list',keyword?{keyword,pageNum:String(page),pageSize:'20'}:{type1:id || '1',pageNum:String(page),area:filters.area || '',year:filters.year || ''},signal);
    data=data.result || data;
  }
  const items=data.list || data.records || (Array.isArray(data)?data:[]);
  return { class:classes,list:items.map(video),page,pagecount:Number(data.pages || data.pagecount || (items.length>=12?Number(page)+1:page)),total:Number(data.total || 0) };
}
async function detail(site,id,signal) {
  const data=await call(site,site.adapter==='apptt'?'/v3/home/vod_details':'/api/mw-movie/anonymous/video/detail',site.adapter==='apptt'?{vod_id:id}:{id},signal);
  const result={...video(data),vod_id:id,lines:[]};
  if(site.adapter==='jpys') result.lines=[{name:'主线路',episodes:(data.episodeList || []).map(e=>({name:e.name,id:id+'@'+e.nid}))}];
  else if(data.vod_play_url) {
    const flags=String(data.vod_play_from || '').split('$$$');
    result.lines=String(data.vod_play_url).split('$$$').map((line,index)=>({name:flags[index] || `线路 ${index+1}`,episodes:line.split('#').filter(Boolean).map((entry,index)=>{const split=entry.indexOf('$');return {name:split>=0?entry.slice(0,split):`第 ${index+1} 集`,id:split>=0?entry.slice(split+1):entry};})}));
  } else {
    const groups=data.vod_play_list || data.vod_url_with_player || data.play_list || [];
    result.lines=(Array.isArray(groups)?groups:Object.values(groups)).map((group,index)=>({name:group.name || group.player_info?.show || `线路 ${index+1}`,episodes:(group.urls || group.list || []).map((e,index)=>({name:e.name || `第 ${index+1} 集`,id:'app-play:' + Buffer.from(JSON.stringify({ url:e.url, parsers:group.parse_urls || [], headers:cleanHeaders({...(group.ua?{'user-agent':group.ua}:{}),...(group.referer?{referer:group.referer}:{})}) })).toString('base64url')}))}));
  }
  if(!result.lines.some(l=>l.episodes.length)) throw new Error('站点未返回剧集列表');
  return result;
}
async function resolve(site,episode,signal) {
  if(site.adapter==='apptt') {
    const data=episode.id.startsWith('app-play:') ? JSON.parse(Buffer.from(episode.id.slice(9),'base64url').toString()) : {url:episode.id};
    const headers={...site.headers,...data.headers};
    if (/\.(mp4|m3u8|flv)(?:[?#]|$)/i.test(data.url)) return {url:data.url,parse:0,header:headers};
    let last;
    for (const parser of (data.parsers || []).slice(0,5)) {
      try {
        const parsed=json((await resource(webUrl(parser + encodeURIComponent(data.url)),{headers:site.headers,signal})).text);
        const url=parsed.data?.url || parsed.url;
        if(url) return {url,parse:0,type:/\.(mp4|flv)(?:[?#]|$)/i.test(url)?'':'hls',header:{...headers,...cleanHeaders(parsed.header || parsed.headers)}};
      } catch(error) {last=error;}
    }
    if(last) throw last;
    return {url:data.url,parse:1,header:headers};
  }
  const [id,nid]=episode.id.split('@');
  const data=await call(site,'/api/mw-movie/anonymous/v2/video/episode/url',{clientType:'3',id,nid},signal);
  const url=data.list?.[0]?.url || data.url;
  if(!url) throw new Error('站点没有返回播放地址');
  return {url,parse:0,header:{...site.headers,referer:site.api,origin:new URL(site.api).origin}};
}
module.exports={describe,list,detail,resolve};
