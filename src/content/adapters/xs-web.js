const cheerio = require('cheerio');
const { resource, postResource } = require('../http');
const { json, webUrl, cleanHeaders } = require('../format');
const { resolvePage } = require('./websites');
const cloud = require('./cloud-sources');
const definitions = {
  '4KZhinan': ['https://4kzn.cc/', '.posts-item.book-item', 'cloud'],
  RenRen: ['https://www.rrdynb.com/', '#movielist li', 'cloud'],
  ShuangXing: ['https://1.star2.cn/', '.erx-list li,.ranking-box li', 'cloud'],
  MeijuMi: ['https://www.meijumi.net/', '#post_list_box article,ul.search-page article,#main a[href$=".html"]', 'torrent'],
  Xunlei8: ['https://xunlei8.me/', 'div.bc3ba,div.b59a2b64df1', 'torrent'],
  SaoHuo: ['http://shapp.us/', '.v_list li,.v_list div,.v_list ul li', 'video'],
  Ikanbot: ['https://www1.ikanbot.com/', '.v-list .item,#video-list .item,.reslut-list .media', 'video'],
  Djuu: ['https://m.djuu.com/', '.musicList li,.music-list li,.music_list li,.play_list li', 'music'],
};
const clean = value => String(value || '').replace(/<[^>]*>/g, '').replace(/\s+/g,' ').trim();
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36';
function describe(raw, base) {
  const plugin = /^csp_(\w+)$/.exec(raw.api)?.[1], definition = definitions[plugin]; if (!definition) return null;
  const api = webUrl(raw.ext?.siteUrl || (typeof raw.ext==='string' && /^https?:/.test(raw.ext) ? raw.ext : definition[0]), base);
  return { adapter: 'xs-web-' + plugin, plugin, api, supported: true, implementation: 'node-html-' + plugin.toLowerCase(), headers: cleanHeaders({ 'user-agent': UA, referer: api, ...raw.header, ...raw.headers }) };
}
async function page(site, address, signal) {
  const url = webUrl(address, site.api);
  let r;
  try { r = await resource(url, { headers:site.headers, signal, timeout:12000, limit:4*1024*1024 }); }
  catch (error) { if (error.code==='SOURCE_REGION_BLOCKED' || !site.browser || !/403|503/.test(error.message)) throw error; r = await site.browser.run(url,{signal}); }
  return { ...r, $:cheerio.load(r.text) };
}
function cards($, selector, base) {
  const result = [];
  $(selector).slice(0,300).each((_,node)=>{
    const row = $(node), a = row.is('a') ? row : row.find('h3 a,h2 a,h5 a,.title a,a[title]').first().length ? row.find('h3 a,h2 a,h5 a,.title a,a[title]').first() : row.find('a[href]').first(), image=row.find('img').first(),href=a.attr('href');
    const title=clean(a.attr('title') || row.find('h2,h3,h5,.title,.title-text').first().text() || image.attr('alt') || a.text());
    if(!href || !title)return;
    let picture=image.attr('data-original') || image.attr('data-src') || image.attr('src') || '';
    try { if(picture)picture=webUrl(picture,base); result.push({vod_id:webUrl(href,base),vod_name:title,vod_pic:picture,vod_remarks:clean(row.find('.note,.v_note,.gxts,.b9b4a,.desc').first().text())}); } catch { /* Ignore decorative links. */ }
  });
  return [...new Map(result.map(row=>[row.vod_id,row])).values()];
}
function pathFor(site,id,pg,word) {
  const q=encodeURIComponent(word),p=site.plugin;
  if(p==='4KZhinan')return word?'/?s='+q:id?id.replace(/\/$/,'')+'/page/'+pg+'/':'/';
  if(p==='RenRen')return word?'/plus/search.php?q='+q:id?id+(id.includes('?')?'&':'?')+'page='+pg:'/';
  if(p==='ShuangXing')return word?'/search/?keyword='+q:id?'/'+id.replace(/^\//,'')+'_'+pg:'/';
  if(p==='MeijuMi')return word?'/?s='+q:id?id.replace(/\/$/,'')+(pg>1?'/page/'+pg+'/':'/'):'/';
  if(p==='Xunlei8')return word?'/s/'+q+'.html':'/'+(id||'list')+'-0-0-0-date-'+pg+'-30.html';
  if(p==='SaoHuo')return word?'/s----------.html?wd='+q:id?'/list/'+encodeURIComponent(id)+'.html':'/';
  if(p==='Ikanbot')return word?'/search?q='+q+'&p='+pg:id?'/'+id.replace(/^\//,'').replace(/\.html$/,'')+(pg>1?'-p-'+pg:'')+'.html':'/';
  if(p==='Djuu')return word?'/search?musicname='+q:id||'/';
  return '/';
}
async function list(site,{id='',page:pg=1,keyword=''}={},signal) {
  pg=Math.max(1,Math.min(10000,Number(pg)||1));
  const r=await page(site,pathFor(site,id,pg,keyword),signal),{$}=r;
  const items=cards($,definitions[site.plugin][1],r.url),classes=[];
  if(site.plugin==='Djuu'){
    site.songs ||= new Map();
    $('.djuu-list-item[data-bs-id]').slice(0,200).each((_,node)=>{const row=$(node),id=row.attr('data-bs-id'),name=row.find('[data-bs-whatever]').attr('data-bs-whatever')||clean(row.find('.djuu-musicname,.musicname').first().text());if(!/^\d+$/.test(id)||!name)return;const song={vod_id:'djuu:'+id,vod_name:name};items.push(song);site.songs.set(id,song);});
    while(site.songs.size>500)site.songs.delete(site.songs.keys().next().value);
  }
  if(!id&&!keyword) $('nav a,.nav a,.nav-menu a,.header-nav a,.navbar a,.menu a,.filter a').slice(0,120).each((_,node)=>{
    const a=$(node),name=clean(a.text()),href=a.attr('href');
    if(!href||name.length>10||!name||/登录|注册|会员|下载|反馈|关于|留言|首页/.test(name))return;
    try { const url=new URL(href,r.url);if(url.origin!==new URL(r.url).origin)return;classes.push({type_id:url.pathname,type_name:name}); } catch {}
  });
  const unique=[...new Map(classes.map(c=>[c.type_id,c])).values()].slice(0,25);
  const next=$('a').filter((_,e)=>/^(下一页|下页|Next|›|»)$/.test(clean($(e).text()))).length>0;
  if(!items.length && !keyword)throw new Error('源站未返回可识别内容，地址可能失效或页面结构已变化');
  return {class:unique,list:items,page:pg,pagecount:next||items.length>=20?pg+1:pg};
}
function tokenFor(id,token) {
  if(!/\d{4}$/.test(id))throw new Error('影片播放令牌无效');
  let out='';for(const digit of id.slice(-4)){const i=Number(digit)%3;if(token.length<i+9)throw new Error('影片令牌已失效，请刷新重试');out+=token.slice(i+1,i+9);token=token.slice(i+9);}return out;
}
async function detail(site,id,signal) {
  if(site.plugin==='Djuu'&&/^djuu:\d+$/.test(id)){const song=site.songs?.get(id.slice(5));return {...song,vod_id:id,vod_name:song?.vod_name||'DJ 音乐',lines:[{name:'音乐',episodes:[{name:song?.vod_name||'播放',id:id.slice(5)}]}]};}
  if(id.startsWith('magnet:?'))return site.torrents.detail(id,signal);
  if(definitions[site.plugin][2]==='cloud')return cloud.detail(site,id,signal);
  const r=await page(site,id,signal),{$}=r;
  const result={vod_id:id,vod_name:clean($('h1,.entry-title,.video-title,.play_list h1').first().text()) || '播放',vod_pic:$('meta[property="og:image"]').attr('content') || $('.poster img,.detail-pic img,.single-content img').first().attr('src'),vod_content:clean($('.description,.detail,.single-content').first().text()).slice(0,6000),lines:[]};
  if(site.plugin==='Ikanbot') {
    const videoId=$('#current_id').val(),type=$('#mtype').val(),token=$('#e_token').val();
    if(!videoId||!token)throw new Error('源站未返回影片令牌，请更新片源');
    const data=json((await resource(webUrl('/api/getResN?'+new URLSearchParams({videoId,mtype:type,token:tokenFor(videoId,token)}),site.api),{headers:{...site.headers,'x-requested-with':'XMLHttpRequest'},signal})).text);
    for(const row of data.data?.list || []) {
      const entries=typeof row.resData==='string'?json(row.resData):row.resData;
      const episodes=(entries||[]).flatMap(e=>String(e.url||'').split('#').filter(Boolean).map((url,i)=>{const parts=url.split('$');return {name:parts[0]||'第 '+(i+1)+' 集',id:parts[1]||parts[0]};}));
      if(episodes.length)result.lines.push({name:entries[0]?.flag||'线路',episodes});
    }
  } else if(definitions[site.plugin][2]==='torrent') {
    const episodes=[];$('a[href^="magnet:"]').slice(0,500).each((_,e)=>{const a=$(e);episodes.push({name:clean(a.text())||'磁力文件',id:a.attr('href')});});
    if(episodes.length)result.lines=[{name:'磁力文件',episodes:[...new Map(episodes.map(e=>[e.id,e])).values()]}];
    if(!episodes.length&&$('a[href^="ed2k:"],a[href^="thunder:"]').length)throw new Error('此影片只有 ED2K／迅雷专有下载地址，请选择含磁力或 HTTP 的片源');
  } else if(site.plugin==='Djuu') {
    const song=/\/(?:play|music)\/(\d+)/.exec(id)?.[1] || $('input[name="id"]').val();
    if(song)result.lines=[{name:'音乐',episodes:[{name:result.vod_name,id:song}]}];
  } else {
    $('.playlist,.play_list,.play-list,.play-list-box,.video_list,.playurl').slice(0,30).each((i,node)=>{
      const episodes=[];$(node).find('a[href]').slice(0,2000).each((_,e)=>{const a=$(e),href=a.attr('href');if(!href||/javascript:|^#/.test(href))return;episodes.push({name:clean(a.text())||'播放',id:webUrl(href,r.url)});});
      if(episodes.length)result.lines.push({name:'线路 '+(i+1),episodes});
    });
  }
  if(!result.lines.length)throw new Error('源站未返回可播放线路，请换源或刷新');
  return result;
}
async function resolve(site,episode,signal) {
  if(episode.id.startsWith('torrent:'))return site.torrents.resolve(episode.id,signal);
  if(episode.id.startsWith('cloud:'))return site.cloud.resolve(episode.id,signal);
  if(site.plugin==='Djuu') {
    const result=json((await postResource(webUrl('/play/music',site.api),new URLSearchParams({id:episode.id}).toString(),{headers:site.headers,contentType:'application/x-www-form-urlencoded',signal})).text);
    if(!result.data?.url)throw new Error('音乐接口未返回播放地址');return {url:webUrl(result.data.url),parse:0,header:site.headers};
  }
  try {return await resolvePage(site,webUrl(episode.id,site.api),signal);} catch(error) {if(!site.browser||signal?.aborted)throw error;return site.browser.run(webUrl(episode.id,site.api),{media:true,signal});}
}
module.exports={describe,list,detail,resolve,tokenFor,pathFor,cards};
