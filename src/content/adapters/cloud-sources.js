const cheerio=require('cheerio');
const {resource,postJson}=require('../http');
const {json,webUrl,cleanHeaders}=require('../format');
const {shareAddress}=require('../cloud');
const {resolvePage}=require('./websites');
const defaults={MyDrive:'https://pan.quark.cn/',WoGG:'http://woggpan.333232.xyz/',Seedhub:'https://seedog.cc/',S_zps:'https://so.252035.xyz/',YpanSo:'https://www.melost.cn/',BpanSo:'https://www.melost.cn/',KkSs:'http://xiaocge.fun/',UuSs:'http://123.666291.xyz/',Push:'https://pan.quark.cn/'};
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
function describe(raw,base){const plugin=/^csp_(\w+?)(?:Guard)?$/.exec(raw.api)?.[1];if(!defaults[plugin])return null;const ext=typeof raw.ext==='object'&&raw.ext||{};return {adapter:'cloud-'+plugin,plugin,api:webUrl(ext.siteUrl||defaults[plugin],base),extension:ext,supported:true,implementation:'node-cloud-'+plugin.toLowerCase(),headers:cleanHeaders({'user-agent':UA,...raw.header,...raw.headers})};}
const text=v=>String(v||'').replace(/<[^>]*>/g,'').trim();
function cards($,base){const output=[];$('.module-item,.module-search-item,.post-item,.movie-item,.movies .item,.card').slice(0,300).each((_,e)=>{const row=$(e),a=row.find('a[title],h2 a,h3 a,a[href*="detail"],a[href*="movie"]').first(),href=a.attr('href');if(!href)return;const title=text(a.attr('title')||row.find('h2,h3,.title').first().text()||a.text()),img=row.find('img').first();if(title)output.push({vod_id:webUrl(href,base),vod_name:title,vod_pic:img.attr('data-src')||img.attr('data-original')||img.attr('src'),vod_remarks:text(row.find('.module-item-note,.note,.state').first().text())});});return [...new Map(output.map(v=>[v.vod_id,v])).values()];}
async function page(site,url,signal){let r;try{r=await resource(url,{headers:site.headers,signal,timeout:12000});}catch(e){if(!site.browser||!/403/.test(e.message))throw e;r=await site.browser.run(url,{signal});}return {...r,$:cheerio.load(r.text)};}
function flattened(value){const found=[],walk=(v,depth=0)=>{if(!v||typeof v!=='object'||depth>10||found.length>=500)return;if(Array.isArray(v)){for(const row of v)walk(row,depth+1);return;}const url=v.url||v.link;if(typeof url==='string'&&/https?:\/\/.*(?:quark\.cn|drive\.uc\.cn|alipan\.com|aliyundrive\.com|pan\.baidu\.com)/i.test(url))found.push({vod_id:url,vod_name:text(v.note||v.disk_name||v.title||v.name||'网盘分享'),vod_remarks:text(v.datetime||v.shared_time||v.disk_type)});else for(const row of Object.values(v))walk(row,depth+1);};walk(value);return found;}
async function list(site,{id='',page:pg=1,keyword='',filters={}}={},signal){
  if(!site.cloud)throw new Error('网盘服务尚未初始化');
  if(site.plugin==='MyDrive'){
    let provider=id,parent='0';if(id.startsWith('drive:')){const [,p,encoded]=id.split(':'),entry=json(Buffer.from(encoded,'base64url').toString());provider=p;parent=entry.fid;}
    return site.cloud.driveList(provider,parent,pg,signal);
  }
  if(site.plugin==='Push'){
    if(!keyword)return {class:[],list:[],notice:'在搜索框粘贴媒体网址、网页、网盘分享或磁力链接，然后打开播放。',page:1,pagecount:1};
    return {list:[{vod_id:keyword,vod_name:'打开链接',vod_remarks:keyword}],page:1,pagecount:1};
  }
  if(['YpanSo','BpanSo','S_zps','KkSs','UuSs'].includes(site.plugin)&&!keyword)return {class:[],list:[],notice:'这是网盘搜索源，请输入影片或剧集名称。网盘播放需要登录你自己的账号。',page:1,pagecount:1};
  if(site.plugin==='YpanSo'||site.plugin==='BpanSo'){
    const result=await postJson(new URL('/v1/search/disk',site.api).href,{page:Number(pg),q:keyword,user:'',exact:true,distinct:true,format:['.mp4','.mkv','.flv','.m3u8','.avi'],share_time:'',order:'create_desc',size:15,type:site.plugin==='BpanSo'?'BDY':'QUARK',exclude_user:[],adv_params:{wechat_pwd:'',platform:'pc'}},{headers:{...site.headers,referer:new URL('/film/'+encodeURIComponent(keyword),site.api).href,origin:new URL(site.api).origin},signal});
    const items=flattened(result.data||result);return {list:items,page:pg,pagecount:items.length>=15?Number(pg)+1:Number(pg)};
  }
  if(site.plugin==='S_zps'){
    const template=site.extension.searchApi||'api/search?kw=@',url=new URL(template.replace('@',encodeURIComponent(keyword)),site.api);
    const result=json((await resource(url.href,{headers:site.headers,signal})).text),items=flattened(result.data||result);
    return {list:items,page:1,pagecount:1,total:items.length};
  }
  const paths=site.plugin==='Seedhub'?(keyword?'/?s='+encodeURIComponent(keyword):id?'/categories/'+encodeURIComponent(id)+'/movies/?page='+pg:'/'):keyword?'/vodsearch/-------------.html?wd='+encodeURIComponent(keyword)+'&page='+pg:id?'/vodshow/'+encodeURIComponent(id)+'--------'+pg+'---.html':'/';
  let sites=[site.api];
  if(['KkSs','UuSs'].includes(site.plugin)&&site.material){const data=await site.material.get(site.plugin,signal);sites=[...new Set([site.api,...data.strings.filter(s=>/^https?:\/\/[^/]+\/$/.test(s))])].slice(0,8);}
  const merged=[];let last;
  for(let i=0;i<sites.length;i++)try{const r=await page(site,new URL(paths,sites[i]).href,signal);merged.push(...cards(r.$,r.url));if(merged.length&&sites.length===1)break;}catch(e){last=e;}
  if(!merged.length&&last)throw last;
  const classes=site.plugin==='WoGG'?[['1','电影'],['2','剧集'],['3','综艺'],['4','动漫']]:site.plugin==='Seedhub'?[['movie','电影'],['tv','剧集'],['anime','动漫']]:[];
  return {class:classes.map(([type_id,type_name])=>({type_id,type_name})),list:merged,page:pg,pagecount:merged.length>=20?Number(pg)+1:Number(pg)};
}
async function detail(site,id,signal){
  if(/^magnet:\?/i.test(id))return site.torrents.detail(id,signal);
  if(site.plugin==='MyDrive')return site.cloud.driveDetail(id,signal);
  try{shareAddress(id);return await site.cloud.detail(id,signal);}catch(error){if(!/未找到|目前支持/.test(error.message))throw error;}
  if(site.plugin==='Push')return {vod_id:id,vod_name:'链接播放',lines:[{name:'自动解析',episodes:[{name:'播放',id}]}]};
  const r=await page(site,webUrl(id,site.api),signal),{$}=r,links=[];
  $('[data-clipboard-text],[data-link],a[href]').each((_,e)=>{const node=$(e),value=node.attr('data-clipboard-text')||node.attr('data-link')||node.attr('href');if(value&&/pan\.quark\.cn|drive\.uc\.cn|alipan\.com|aliyundrive\.com|pan\.baidu\.com/.test(value))links.push(value);});
  for(const m of r.text.replace(/\\\//g,'/').matchAll(/https?:\/\/(?:pan\.quark\.cn|drive\.uc\.cn|www\.(?:alipan|aliyundrive)\.com|pan\.baidu\.com)\/s\/[^\s"'<>]+/g))links.push(m[0].replace(/&amp;/g,'&'));
  const lines=[],errors=[];
  for(const link of [...new Set(links)].slice(0,12))try{const data=await site.cloud.detail(link,signal);lines.push(...data.lines);}catch(e){errors.push(e);}
  if(!lines.length)throw errors[0]||new Error('该详情页没有识别到网盘分享地址');
  return {vod_id:id,vod_name:text($('h1,.video-info-header h1').first().text())||'网盘影视',vod_pic:$('.module-item-pic img,.video-cover img,.poster img').first().attr('data-src'),vod_content:text($('.video-info-content,.description,.entry-content').first().text()),lines};
}
async function resolve(site,episode,signal){if(episode.id.startsWith('torrent:'))return site.torrents.resolve(episode.id,signal);if(episode.id.startsWith('cloud:'))return site.cloud.resolve(episode.id,signal);try{return await resolvePage(site,episode.id,signal);}catch(error){if(!site.browser)throw error;return site.browser.run(webUrl(episode.id,site.api),{media:true,signal});}}
module.exports={describe,list,detail,resolve,flattened};
