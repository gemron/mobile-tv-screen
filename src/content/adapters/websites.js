const cheerio = require('cheerio');
const { createHmac } = require('crypto');
const { resource } = require('../http');
const { json, webUrl, cleanHeaders } = require('../format');
const { scriptObject } = require('../html-sites');
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const definitions={NewCz:['newcz','https://www.4kcz.com/'],Bttwoo:['bttwoo','https://www.bttwo.life/'],Libvio:['libvio','https://www.libvio.pw/'],Nmyswv:['nmys','https://vip.wwgz.cn:5200/']};
const trim=v=>String(v||'').replace(/\s+/g,' ').trim();
const media=u=>/\.(mp4|m3u8|flv|mp3|m4a)(?:[?#]|$)/i.test(u||'');
function describe(raw,base){
  const name=/^csp_(\w+?)(?:Guard)?$/.exec(raw.api)?.[1],def=definitions[name];if(!def)return null;
  const ext=typeof raw.ext==='object'&&raw.ext||{};
  const api=webUrl(ext.siteUrl||def[1],base);
  return {adapter:def[0],api,supported:true,implementation:'node-html-'+def[0],headers:cleanHeaders({'user-agent':UA,referer:api,...raw.header,...raw.headers})};
}
async function page(site,path,signal){
  const address=webUrl(path,site.api);let r;
  try{r=await resource(address,{headers:site.headers,signal,limit:4*1024*1024});}
  catch(error){if(!site.browser||!/403|503/.test(error.message))throw error;r=await site.browser.run(address,{signal});}
  if(site.browser&&/<title>[^<]*(?:人机验证|Just a moment|Checking your browser)/i.test(r.text))r=await site.browser.run(address,{signal});
  if(r.cookie)site.headers.cookie=r.cookie;
  return {...r,$:cheerio.load(r.text)};
}
function cards($,kind){
  const rows=kind==='newcz'?$('div.mi_ne_kd > ul > li'):kind==='bttwoo'?$('[data-vod-id]'):$('.stui-vodlist__box, .myui-vodlist__box, .hl-vod-list li, .fed-list-item, .module-item, .myui-vodlist li');
  const result=[];
  rows.slice(0,300).each((_,e)=>{const row=$(e),a=row.find('h3 a,h4 a,h2 a,a[title]').first().length?row.find('h3 a,h4 a,h2 a,a[title]').first():row.find('a[href]').first();const img=row.find('img').first(),id=a.attr('href');
    const name=trim(a.attr('title')||a.find('h3').text()||row.find('h3,h4,h2').first().text()||img.attr('alt'));
    if(id&&name)result.push({vod_id:id,vod_name:name,vod_pic:img.attr('data-original')||img.attr('data-src')||img.attr('src')||a.attr('data-original'),vod_remarks:trim(row.find('.pic-text,.qb,.hdtag,.text-right').first().text())});
  });
  return [...new Map(result.map(r=>[r.vod_id,r])).values()];
}
async function list(site,{id='',page:pg=1,keyword='',filters={}}={},signal){
  let path=site.api;
  if(site.adapter==='newcz')path=keyword?'/?s='+encodeURIComponent(keyword):id?'/'+id.replace(/^\/+|\/+$/g,'')+'/page/'+pg+'/':path;
  if(site.adapter==='bttwoo')path=keyword?'/search?q='+encodeURIComponent(keyword)+'&page='+pg:id?'/filter?classify='+encodeURIComponent(id)+'&page='+pg:path;
  if(site.adapter==='libvio')path=keyword?'/search/-------------.html?wd='+encodeURIComponent(keyword):id?`/show/${encodeURIComponent(id)}--------${pg}---.html`:path;
  if(site.adapter==='nmys')path=keyword?'/index.php?m=vod-search&wd='+encodeURIComponent(keyword):id?`/index.php?m=vod-list-id-${encodeURIComponent(id)}-pg-${pg}-order--by-${encodeURIComponent(filters.by||'')}-class--year-${encodeURIComponent(filters.year||'')}-letter--area-${encodeURIComponent(filters.area||'')}-lang-.html`:path;
  const {$,url}=await page(site,path,signal),items=cards($,site.adapter),classes=[];
  if(site.adapter==='bttwoo')classes.push(...[['1','电影'],['2','电视剧'],['3','动漫']].map(([type_id,type_name])=>({type_id,type_name})));
  else if(!id&&!keyword)$('ul.stui-header__menu a,.nav-menu a,.navlist a,.nav a,header a').each((_,el)=>{const a=$(el),name=trim(a.text()),href=a.attr('href')||'';if(!/^(电影|电视剧|剧集|动漫|番剧|综艺|国产剧|美剧|韩剧|日韩|欧美|纪录片)$/.test(name))return;
    let value;
    if(site.adapter==='newcz')value=new URL(href,url).pathname.replace(/^\/+|\/+$/g,'');
    else value=/\/(?:type|list)\/(\d+)/.exec(href)?.[1]||/id-(\d+)/.exec(href)?.[1]||/type\/(\d+)/.exec(href)?.[1];
    if(value)classes.push({type_id:value,type_name:name});
  });
  if(!classes.length&&!keyword&&!id)classes.push(...[['1','电影'],['2','电视剧'],['3','综艺'],['4','动漫']].map(([type_id,type_name])=>({type_id,type_name})));
  const nums=$('.pagination a,.nav-links a,.stui-page a,.myui-page a').map((_,e)=>Number(trim($(e).text()))).get().filter(x=>x>0&&x<100000);
  if(!items.length&&!keyword)throw new Error('未读取到影片，站点可能更换域名或需要浏览器验证');
  return {class:[...new Map(classes.map(c=>[c.type_id,c])).values()],list:items,page:pg,pagecount:Math.max(Number(pg),...nums,items.length>=20?Number(pg)+1:pg),total:0};
}
async function detail(site,id,signal){
  const {$,url}=await page(site,id,signal);
  const title=trim($('h1').first().text()),img=$('.dyimg img,.stui-content__thumb img,.myui-content__thumb img,img[alt]').first();
  const result={vod_id:id,vod_name:title,vod_pic:img.attr('data-original')||img.attr('data-src')||img.attr('src'),vod_content:trim($('.yp_context,.stui-content__desc,.detail-content,.text-text-secondary').first().text()),lines:[]};
  if(site.adapter==='bttwoo'){
    const user=/userlink:\s*'([^']*)'/.exec($('nav#navbar').attr('x-data')||'')?.[1]||'0';
    const groups=new Map();
    $('a.episode-link,a[data-line][href]').slice(0,5000).each((_,e)=>{const a=$(e),line=a.attr('data-line')||'1',playId=a.attr('dataid')||/handleEpisodeClick\(.*?,\s*'(\d+)'/.exec(a.attr('@click.prevent')||'')?.[1];if(!playId)return;
      if(!groups.has(line))groups.set(line,{name:'线路 '+line,episodes:[]});
      groups.get(line).episodes.push({name:trim(a.text()),id:'bt:'+Buffer.from(JSON.stringify({path:a.attr('href'),playId,user})).toString('base64url')});
    });result.lines=[...groups.values()];
  }else if(site.adapter==='newcz'){
    const episodes=$('a[href*="v_play"]').map((_,e)=>({name:trim($(e).text()),id:webUrl($(e).attr('href'),url)})).get();
    result.lines=[{name:'专线',episodes}];
  }else{
    $('.stui-content__playlist,.myui-content__playlist,.play_list,.playlist,.play-list,.module-play-list').slice(0,30).each((index,e)=>{const episodes=$(e).find('a[href]').slice(0,2000).map((_,a)=>({name:trim($(a).text()),id:webUrl($(a).attr('href'),url)})).get();if(episodes.length)result.lines.push({name:trim($('.stui-pannel__head h3,.myui-panel__head h3,.tab_control li').eq(index).text())||'线路 '+(index+1),episodes});});
  }
  if(!title||!result.lines.some(l=>l.episodes.length))throw new Error('未找到剧集，站点页面结构可能变化');
  return result;
}
function encodePlayKey(input){if(input==='0')return input;const key=Buffer.from('nbmovie2024secretkey'),bytes=Buffer.from(input);return Buffer.from(bytes.map((b,i)=>b^key[i%key.length])).toString('base64').replace(/\+/g,'-').replace(/\//g,'_');}
async function resolve(site,episode,signal){
  if(site.adapter==='bttwoo'&&episode.id.startsWith('bt:')){
    const data=JSON.parse(Buffer.from(episode.id.slice(3),'base64url').toString()),value=data.path.replace(/^\/?play\//,''),time=String(Date.now());
    const signature=createHmac('sha256',value).update(`${data.playId}:${time}:${value}`).digest('hex').slice(0,32);
    const u=new URL('/video/play',site.api);u.search=new URLSearchParams({p:data.playId,v:value,q:'1080',s:signature,t:time,k:encodePlayKey(data.user)}).toString();
    const r=json((await resource(u.href,{headers:site.headers,signal})).text),urls=r.data?.quality_urls||[];
    const values=urls.filter(v=>v.url).map((v,index)=>({n:String(v.name||v.label||v.quality||`画质 ${index+1}`),v:v.url}));
    if(!values.length)throw new Error(r.msg||r.message||'比特未返回媒体地址');
    return {url:{values,position:values.length-1},parse:0,inheritHeaders:false,header:{'user-agent':UA}};
  }
  try{return await resolvePage(site,episode.id,signal);}catch(error){if(!site.browser)throw error;return site.browser.run(webUrl(episode.id,site.api),{media:true,signal});}
}
async function resolvePage(site,address,signal){
  const visited=new Set();let next=webUrl(address,site.api),referer=site.api,origin='';
  for(let depth=0;depth<4;depth++){
    if(media(next))return {url:next,parse:0,header:{...site.headers,referer,...(origin?{origin}:{})}};
    if(visited.has(next))break;visited.add(next);
    const response=await page(site,next,signal),{$}=response;referer=response.url;
    const type=String(response.headers['content-type']||'');
    if(/mpegurl|video\/|audio\//i.test(type)||/^\s*#EXTM3U/.test(response.text))return {url:response.url,parse:0,type:/mpegurl|#EXTM3U/i.test(type+' '+response.text.slice(0,20))?'hls':'',header:site.headers};
    let found=$('video[src],source[src]').first().attr('src');
    const player=scriptObject(response.text,/var\s+player_\w+\s*=/);
    if(!found&&player?.url){found=String(player.url);if(Number(player.encrypt)===2)found=Buffer.from(found,'base64').toString('utf8');if([1,2].includes(Number(player.encrypt)))try{found=decodeURIComponent(found);}catch{}}
    if(!found){const frame=$('iframe[src]').first().attr('src');if(frame){const u=new URL(frame,response.url),value=u.searchParams.get('url')||u.searchParams.get('v');found=media(value)?value:u.href;origin=u.origin;if(media(value))referer=u.origin+'/';}}
    if(!found)found=/(?:url|src|file)\s*[:=]\s*['"](https?:[^'"\r\n]+\.(?:m3u8|mp4)(?:\?[^'"\r\n]*)?)['"]/i.exec(response.text.replace(/\\\//g,'/'))?.[1];
    if(!found)break;next=webUrl(found,response.url);
  }
  throw new Error('该线路需要浏览器解析或登录验证，未读到媒体地址');
}
module.exports={describe,list,detail,resolve,resolvePage,encodePlayKey};
