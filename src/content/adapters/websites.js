const cheerio = require('cheerio');
const { createHmac } = require('crypto');
const { resource } = require('../http');
const { json, webUrl, cleanHeaders } = require('../format');
const { scriptObject } = require('../html-sites');
const acorn = require('acorn');
const { value: literalValue } = require('../literals');
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const MOBILE_UA='Mozilla/5.0 (Linux; Android 12; Pixel 6) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36';
const definitions={NewCz:['newcz','https://www.4kcz.com/'],Bttwoo:['bttwoo','https://www.bttwo.life/'],Libvio:['libvio','https://www.libvio.pw/'],Nmyswv:['nmys','https://vip.wwgz.cn:5200/']};
const trim=v=>String(v||'').replace(/[\u200b-\u200d\ufeff]/g,'').replace(/\s+/g,' ').trim();
const media=u=>/\.(mp4|m3u8|flv|mp3|m4a)(?:[?#]|$)/i.test(u||'');
function describe(raw,base){
  const name=/^csp_(\w+?)(?:Guard)?$/.exec(raw.api)?.[1],def=definitions[name];if(!def)return null;
  const ext=typeof raw.ext==='object'&&raw.ext||{};
  const api=webUrl(ext.siteUrl||def[1],base);
  const mobile=def[0]==='nmys';
  return {adapter:def[0],api,supported:true,implementation:'node-html-'+def[0],...(mobile?{fixedUserAgent:true}:{}),headers:cleanHeaders({'user-agent':mobile?MOBILE_UA:UA,referer:api,...raw.header,...raw.headers})};
}
async function page(site,path,signal){
  const address=webUrl(path,site.api);let r;
  try{r=await resource(address,{headers:site.headers,signal,limit:4*1024*1024});}
  catch(error){
    if(error.status===428||error.code==='SOURCE_REGION_BLOCKED'||!site.browser||!/403|503/.test(error.message))throw error;
    r=await site.browser.run(address,{signal});
  }
  if(r.cookie&&!site.cookieOverride)site.headers.cookie=r.cookie;
  if(r.userAgent&&!site.fixedUserAgent)site.headers['user-agent']=r.userAgent;
  return {...r,$:cheerio.load(r.text)};
}
function cards($,kind){
  const rows=kind==='newcz'?$('div.mi_ne_kd > ul > li'):kind==='bttwoo'?$('[data-vod-id]'):kind==='nmys'?$('.resize_list li, .swiper-slide, .stui-vodlist__box, .myui-vodlist__box, .hl-vod-list li, .fed-list-item, .module-item, .myui-vodlist li'):$('.stui-vodlist__box, .myui-vodlist__box, .hl-vod-list li, .fed-list-item, .module-item, .myui-vodlist li');
  const result=[];
  rows.slice(0,300).each((_,e)=>{const row=$(e),a=row.find('h3 a,h4 a,h2 a,a[title]').first().length?row.find('h3 a,h4 a,h2 a,a[title]').first():row.find('a[href]').first();const img=row.find('img').first(),id=a.attr('href');
    const name=trim(a.attr('title')||a.find('h3').text()||row.find('h3,h4,h2,p').first().text()||img.attr('alt'));
    if(id&&name)result.push({vod_id:id,vod_name:name,vod_pic:img.attr('data-echo')||img.attr('data-original')||img.attr('data-src')||img.attr('src')||a.attr('data-original'),vod_remarks:trim(row.find('.pic-text,.qb,.hdtag,.text-right,.sStyle,.sDes').first().text())});
  });
  return [...new Map(result.map(r=>[r.vod_id,r])).values()];
}
async function list(site,{id='',page:pg=1,keyword='',filters={}}={},signal){
  let path=site.api;
  if(site.adapter==='newcz')path=keyword?'/?s='+encodeURIComponent(keyword):id?'/'+id.replace(/^\/+|\/+$/g,'')+'/page/'+pg+'/':path;
  if(site.adapter==='bttwoo')path=keyword?'/search?q='+encodeURIComponent(keyword)+'&page='+pg:id?'/filter?classify='+encodeURIComponent(id)+'&page='+pg:path;
  if(site.adapter==='libvio')path=keyword?'/search/-------------.html?wd='+encodeURIComponent(keyword):id?`/show/${encodeURIComponent(id)}--------${pg}---.html`:path;
  if(site.adapter==='nmys')path=keyword?'/index.php?m=vod-search&wd='+encodeURIComponent(keyword):id?`/index.php?m=vod-list-id-${encodeURIComponent(id)}-pg-${pg}-order--by-${encodeURIComponent(filters.by||'')}-class--year-${encodeURIComponent(filters.year||'')}-letter--area-${encodeURIComponent(filters.area||'')}-lang-.html`:path;
  const {$,url,text:htmlText}=await page(site,path,signal);
  if(site.adapter==='nmys'&&keyword&&/缺少文件/.test(htmlText||'')){
    return {class:[],list:[],page:pg,pagecount:1,total:0,notice:'糯米当前暂不支持站内搜索，请按分类浏览或勾选“全站搜索”。'};
  }
  const items=cards($,site.adapter),classes=[];
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
  const pageTitle=trim($('title').first().text());
  const extractedTitle=/《([^》]+)》/.exec(pageTitle)?.[1]||pageTitle.split(/[-_|]/)[0];
  const title=site.adapter==='nmys'?trim(extractedTitle||$('h1').last().text()):trim($('h1,.detail-title').first().text()||extractedTitle);
  const img=$('.dyimg img,.stui-content__thumb img,.myui-content__thumb img,.pic img,img[alt]').first();
  const result={vod_id:id,vod_name:title,vod_pic:img.attr('data-echo')||img.attr('data-original')||img.attr('data-src')||img.attr('src'),vod_content:trim($('.yp_context,.stui-content__desc,.detail-content,.text-text-secondary,.detail-intro').first().text()),lines:[]};
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
    $('.stui-content__playlist,.myui-content__playlist,.play_list,.playlist,.play-list,.module-play-list,.numList ul').slice(0,30).each((index,e)=>{const episodes=$(e).find('a[href]').slice(0,2000).map((_,a)=>({name:trim($(a).text()),id:webUrl($(a).attr('href'),url)})).get();if(episodes.length)result.lines.push({name:trim($('.stui-pannel__head h3,.myui-panel__head h3,.tab_control li,.play-tab li').eq(index).text())||'线路 '+(index+1),episodes});});
  }
  if(!title||!result.lines.some(l=>l.episodes.length))throw new Error('未找到剧集，站点页面结构可能变化');
  return result;
}
function encodePlayKey(input){if(input==='0')return input;const key=Buffer.from('nbmovie2024secretkey'),bytes=Buffer.from(input);return Buffer.from(bytes.map((b,i)=>b^key[i%key.length])).toString('base64').replace(/\+/g,'-').replace(/\//g,'_');}
function artplayerMedia(html) {
  const $=cheerio.load(html),bindings=new Map(),players=new Map();
  const read = node => node?.type==='Identifier' ? bindings.get(node.name) : literalValue(node);
  const property = node => node.computed ? literalValue(node.property) : node.property?.name;
  $('script:not([src])').slice(0,30).each((_,element)=>{
    const script=$(element).html()||'';if(script.length>256*1024)return;
    let program;try{program=acorn.parse(script,{ecmaVersion:'latest',sourceType:'script'});}catch{return;}
    for(const statement of program.body.slice(0,1000)) {
      if(statement.type==='VariableDeclaration')for(const declaration of statement.declarations){
        if(declaration.id.type!=='Identifier')continue;
        const name=declaration.id.name,init=declaration.init;
        if(init?.type==='NewExpression'&&init.callee.type==='Identifier'&&init.callee.name==='Artplayer'){
          const object=init.arguments[0],options={};
          if(object?.type==='ObjectExpression')for(const field of object.properties){if(field.type!=='Property'||field.computed||field.kind!=='init'||field.method)continue;const key=field.key.name??field.key.value;if(['url','type','container'].includes(key))options[key]=read(field.value);}
          else Object.assign(options,read(object)||{});
          if(players.size<20)players.set(name,options);
        }else if(bindings.size<5000)bindings.set(name,read(init));
      }
      else if(statement.type==='ExpressionStatement'&&statement.expression.type==='AssignmentExpression'&&statement.expression.operator==='='){
        const assignment=statement.expression,left=assignment.left;
        if(left.type==='Identifier'&&bindings.size<5000)bindings.set(left.name,read(assignment.right));
        else if(left.type==='MemberExpression'&&left.object.type==='Identifier'&&players.has(left.object.name)&&['url','type'].includes(property(left)))players.get(left.object.name)[property(left)]=read(assignment.right);
      }
    }
  });
  const candidates=[...players.values()].filter(player=>typeof player.url==='string'&&player.url.trim()&&!/(?:^|[-_#.\s])(?:ads?|advert|preroll)(?:$|[-_\s])/i.test(String(player.container||'')));
  const selected=candidates.find(player=>['#player','#artplayer','#video'].includes(player.container))||candidates[0];
  return selected?{url:selected.url,type:typeof selected.type==='string'?selected.type:''}:null;
}
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
  let found;
  try{found=await resolvePage(site,episode.id,signal);}catch(error){
    if(error.status===428||error.code==='SOURCE_REGION_BLOCKED'||!site.browser)throw error;
    found=await site.browser.run(error.playerUrl||webUrl(episode.id,site.api),{media:true,signal,...(error.playerReferer?{headers:{referer:error.playerReferer}}:{})});
  }
  // NewCz's external image/TS CDN rejects the catalog/player Referer and Origin.
  // Catalog requests keep their own headers; only the public media request changes.
  if(site.adapter==='newcz'&&new URL(found.url).origin!==new URL(site.api).origin)return {...found,inheritHeaders:false,header:{'user-agent':UA}};
  return found;
}
function macV8Media(html,url){
  const m=/\bmac_url\s*=\s*(['"])([\s\S]*?)\1/.exec(html);
  if(!m)return '';
  const groups=m[2].split('$$$');
  const srcIndex=Math.max(0,(Number(/src-(\d+)/i.exec(url)?.[1])||1)-1);
  const numIndex=Math.max(0,(Number(/num-(\d+)/i.exec(url)?.[1])||1)-1);
  const episodes=(groups[srcIndex]||groups[0]||'').split('#').filter(Boolean);
  const entry=episodes[numIndex]||episodes[0]||'';
  const sep=entry.indexOf('$');
  const candidate=(sep>=0?entry.slice(sep+1):entry).trim();
  return media(candidate)?candidate:'';
}
async function macPlayerParseUrl(site,$,baseUrl,from,signal){
  if(!from)return '';
  const scriptSrc=$('script[src*="playerconfig.js"]').first().attr('src');
  if(!scriptSrc)return '';
  const configUrl=webUrl(scriptSrc,baseUrl);
  site._playerLists ||= new Map();
  let list=site._playerLists.get(configUrl);
  if(!list){
    try{
      const js=(await resource(configUrl,{headers:site.headers,signal,timeout:8000,limit:512*1024})).text;
      list=scriptObject(js,/MacPlayerConfig\.player_list\s*=/)||{};
      site._playerLists.set(configUrl,list);
    }catch{list={};}
  }
  const parse=list?.[from]?.parse;
  return typeof parse==='string'&&/^https?:\/\//i.test(parse)?parse:'';
}
async function resolvePage(site,address,signal){
  const visited=new Set();let next=webUrl(address,site.api),referer=site.api,origin='',playerUrl='',playerReferer='';
  for(let depth=0;depth<4;depth++){
    if(media(next))return {url:next,parse:0,header:{...site.headers,referer,...(origin?{origin}:{})}};
    if(visited.has(next))break;visited.add(next);
    const response=await page(site,next,signal),{$}=response;referer=response.url;
    const type=String(response.headers['content-type']||'');
    if(/mpegurl|video\/|audio\//i.test(type)||/^\s*#EXTM3U/.test(response.text))return {url:response.url,parse:0,type:/mpegurl|#EXTM3U/i.test(type+' '+response.text.slice(0,20))?'hls':'',header:site.headers};
    const macV8=macV8Media(response.text,response.url);
    if(macV8)return {url:webUrl(macV8,response.url),parse:0,inheritHeaders:false,header:{'user-agent':UA}};
    let found=$('video[src],source[src]').first().attr('src');
    const player=scriptObject(response.text,/var\s+player_\w+\s*=/);
    if(!found&&player?.url){
      found=String(player.url);
      if(Number(player.encrypt)===2)found=Buffer.from(found,'base64').toString('utf8');
      if([1,2].includes(Number(player.encrypt)))try{found=decodeURIComponent(found);}catch{}
      if(!/^(?:https?:)?\/\/|^\//i.test(found)&&player.from){
        const parsePrefix=await macPlayerParseUrl(site,$,response.url,String(player.from),signal);
        if(parsePrefix){found=parsePrefix+found;playerUrl=found;playerReferer=response.url;}else found='';
      }
    }
    const configured = !found && artplayerMedia(response.text);
    if(configured)return {url:webUrl(configured.url,response.url),parse:0,type:configured.type,header:{...site.headers,referer,...(origin?{origin}:{})}};
    if(!found){const frame=$('iframe[src]').first().attr('src');if(frame){const u=new URL(frame,response.url),value=u.searchParams.get('url')||u.searchParams.get('v');found=media(value)?value:u.href;origin=u.origin;if(media(value))referer=u.origin+'/';else{playerUrl=u.href;playerReferer=response.url;}}}
    if(!found)found=/(?:url|src|file)\s*[:=]\s*['"](https?:[^'"\r\n]+\.(?:m3u8|mp4)(?:\?[^'"\r\n]*)?)['"]/i.exec(response.text.replace(/\\\//g,'/'))?.[1];
    if(!found)break;next=webUrl(found,response.url);
  }
  throw Object.assign(new Error('该线路需要浏览器解析或登录验证，未读到媒体地址'),{...(playerUrl?{playerUrl,playerReferer}:{})});
}
module.exports={describe,list,detail,resolve,resolvePage,encodePlayKey,artplayerMedia};
