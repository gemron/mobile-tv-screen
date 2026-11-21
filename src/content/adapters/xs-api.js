const {resource,postJson}=require('../http');
const {json,webUrl,cleanHeaders}=require('../format');
const {resolvePage}=require('./websites');
const {cards}=require('./xs-web');
const cheerio=require('cheerio');
const bases={SP360:'https://api.web.360kan.com/',Duboku:'https://api.dbokutv.com/',AppLY:'https://fly.daoran.tv/',Web1905:'https://www.1905.com/'};
const array=v=>Array.isArray(v)?v:[];
const classes=[['1','电影'],['2','电视剧'],['3','综艺'],['4','动漫']].map(([type_id,type_name])=>({type_id,type_name}));
function describe(raw,base){const plugin=/^csp_(\w+)$/.exec(raw.api)?.[1];if(!bases[plugin])return null;const api=webUrl(raw.ext?.siteUrl||bases[plugin],base);return {adapter:'xs-api-'+plugin,plugin,api,supported:true,implementation:'node-'+plugin.toLowerCase(),headers:cleanHeaders({'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36',referer:plugin==='Duboku'?'https://www.duboku.tv/':api,...raw.header,...raw.headers})};}
function jsonp(text){try{return json(text);}catch{const match=/^[\w.$]+\s*\(([\s\S]*)\)\s*;?\s*$/.exec(text.trim());if(!match)throw new Error('接口未返回 JSON 数据');return json(match[1]);}}
class JavaRandom{
  constructor(seed){this.seed=(BigInt(seed)^0x5deece66dn)&((1n<<48n)-1n);}
  next(bits){this.seed=(this.seed*0x5deece66dn+11n)&((1n<<48n)-1n);return Number(this.seed>>BigInt(48-bits));}
  int(bound){if((bound&-bound)===bound)return Math.floor(bound*this.next(31)/2147483648);let b,v;do{b=this.next(31);v=b%bound;}while(b-v+bound-1>2147483647);return v;}
}
function dubokuSign(ms=Date.now()){
  const time=Math.floor(ms/1000),n=new JavaRandom(time).int(800000000),digits=String(100000000+n)+String(900000000-n),stamp=String(ms);let mixed='';for(let i=0;i<Math.max(digits.length,stamp.length);i++)mixed+=(digits[i]||'')+(stamp[i]||'');
  const chars=(length,seed,alphabet)=>{const random=new JavaRandom(seed);return Array.from({length},()=>alphabet[random.int(alphabet.length)]).join('');};
  return new URLSearchParams({sign:chars(60,60+2*time,'0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ'),ssid:Buffer.from(mixed).toString('base64').replace(/=/g,'.'),token:chars(38,38+2*time,'XYZ0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVW')}).toString();
}
function dubokuDecode(text){if(/^https?:|^\//.test(text))return text;let out='';for(let i=0;i<text.length;i+=10)out+=text.slice(i,i+10).split('').reverse().join('');return Buffer.from(out.replace(/\./g,'='),'base64').toString();}
async function get(site,path,signal){let address=webUrl(path,site.api);if(site.plugin==='Duboku'){const u=new URL(address);for(const [key,value] of new URLSearchParams(dubokuSign()))u.searchParams.set(key,value);address=u.href;}return jsonp((await resource(address,{headers:site.headers,signal,timeout:12000})).text);}
async function ly(site,path,body,signal){
  const facts=await site.material.get('AppLY',signal),key=facts.strings.find(s=>/^[A-Za-z0-9+/]{50,}==$/.test(s));if(!key)throw new Error('订阅缺少戏曲接口参数');
  return postJson(webUrl('/API_ROP/'+path,site.api),body,{headers:{...site.headers,'user-agent':'okhttp/3.9.1',md5:key},signal});
}
async function list(site,{id='',page=1,keyword='',filters={}}={},signal){
  if(site.plugin==='Duboku'){
    const data=await get(site,keyword?'/vodsearch?wd='+encodeURIComponent(keyword):id?'/vodshow/'+[id,filters.area||'',filters.by||'',filters.class||'',filters.lang||'','','','',page,'','',filters.year||''].map(encodeURIComponent).join('-'):'/home',signal);
    const rows=Array.isArray(data)?data.flatMap(v=>v.VodList||v.DId&&v||[]):data.VodList||[];
    return {class:classes,list:rows.map(v=>({vod_id:dubokuDecode(v.DId),vod_name:v.Name,vod_pic:dubokuDecode(v.TnId),vod_remarks:v.Tag||v.Rating||''})),page,pagecount:rows.length>=20?Number(page)+1:Number(page)};
  }
  if(site.plugin==='SP360'){
    if(keyword)return {class:classes,list:[],notice:'360 提供正版站点片单，请选择分类；全站搜索可使用其他片源。',page:1,pagecount:1};
    const data=await get(site,'/v1/filter/list?'+new URLSearchParams({catid:id||'1',rank:filters.by||'ranklatest',cat:filters.class||'',year:filters.year||'',area:filters.area||'',act:filters.actor||'',size:35,pageno:page,callback:''}),signal);
    const rows=array(data.data?.movies);return {class:classes,list:rows.map(v=>({vod_id:(id||'1')+':'+v.id,vod_name:v.title,vod_pic:v.cdncover||v.cover,vod_remarks:v.tag||v.upinfo||''})),page,pagecount:Number(data.data?.total?Math.ceil(data.data.total/35):rows.length>=35?Number(page)+1:page)};
  }
  if(site.plugin==='AppLY'){
    if(keyword)return {list:[],page:1,pagecount:1,notice:'此戏曲接口仅支持分类浏览。'};
    if(!id){const data=await ly(site,'page/setinf/get',{leastNum:'0',memberId:'yszyz',project:'lyhxcx',userId:'yszyz'},signal);return {class:array(data.sects).map(t=>({type_id:t.code,type_name:t.name})),list:[],page:1,pagecount:1};}
    const data=await ly(site,'search/album/list',{cur:String(page),free:'0',item:'o5',pageSize:'20',sect:[id]},signal),rows=array(data.pb?.dataList);
    return {list:rows.map(v=>({vod_id:v.code,vod_name:v.name,vod_pic:'https://ottphoto.daoran.tv/HD/'+v.img,vod_remarks:v.publishTime})),page,pagecount:rows.length>=20?Number(page)+1:page};
  }
  const path=keyword?'/search/index-p-type-all-q-'+encodeURIComponent(keyword)+'.html':id||'/vod/list/';
  const r=await resource(webUrl(path,site.api),{headers:site.headers,signal}),$=cheerio.load(r.text),items=cards($,'.grid .grid-box,.pic-pack-outer,.list-pic li,.mod-cover-list li,.search-list .movie-pic-list',r.url);
  if(!items.length)throw new Error('1905 片单未返回内容，可能需要更新片源');return {class:[{type_id:'/vod/list/',type_name:'电影'}],list:items,page,pagecount:items.length>=20?Number(page)+1:Number(page)};
}
async function detail(site,id,signal){
  if(site.plugin==='Duboku'){const d=await get(site,id,signal);return {vod_id:id,vod_name:d.Name,vod_pic:dubokuDecode(d.TnId),vod_content:d.Description,vod_year:d.ReleaseYear,vod_actor:array(d.Actor).join(' / '),lines:[{name:'独播',episodes:array(d.Playlist).map(v=>({name:v.EpisodeName,id:dubokuDecode(v.VId)}))}]};}
  if(site.plugin==='SP360'){
    const [cat,key]=id.split(':'),d=(await get(site,'/v1/detail?'+new URLSearchParams({cat,id:key}),signal)).data;
    if(!d)throw new Error('360 没有返回影片详情');const groups=d.allepidetail||d.defaultepisode||d.playlinksdetail||{},lines=[];
    for(const [name,value] of Object.entries(groups)){const episodes=(Array.isArray(value)?value:[value]).flatMap((row,i)=>{const url=row.url||row.default_url||row.playlink;return url?[{name:row.name||row.period||'第 '+(i+1)+' 集',id:url}]:[];});if(episodes.length)lines.push({name,episodes});}
    if(!lines.length)throw new Error('360 此影片暂无可用正版站点链接');return {vod_id:id,vod_name:d.title,vod_pic:d.cdncover||d.cover,vod_content:d.description,lines};
  }
  if(site.plugin==='AppLY'){const d=await ly(site,'album/res/list',{albumCode:id,cur:'1',project:'lyhxcx',pageSize:'2000',selectFlag:'0',userId:'yszyz'},signal),v=d.album||{};return {vod_id:id,vod_name:v.name,vod_pic:'https://ottphoto.daoran.tv/HD/'+v.img,vod_content:v.des,vod_actor:v.artistName,lines:[{name:'在线戏曲',episodes:array(d.pb?.dataList).map(e=>({name:e.name,id:e.code}))}]};}
  const r=await resource(webUrl(id,site.api),{headers:site.headers,signal}),$=cheerio.load(r.text),links=[];$('a[href*="/vod/play/"]').slice(0,100).each((_,e)=>{const a=$(e);links.push({name:a.text().trim()||'正片',id:webUrl(a.attr('href'),r.url)});});
  if(!links.length)links.push({name:'官方播放页',id:r.url});return {vod_id:id,vod_name:$('h1').first().text().trim()||'1905 电影',lines:[{name:'1905',episodes:links}]};
}
async function resolve(site,episode,signal){
  if(site.plugin==='Duboku'){const d=await get(site,episode.id,signal);return {url:webUrl(dubokuDecode(d.HId)),parse:0,header:{...site.headers,origin:'https://w.duboku.io',referer:'https://w.duboku.io/'}};}
  if(site.plugin==='AppLY'){const facts=await site.material.get('AppLY',signal),id=facts.strings.find(s=>/^[0-9a-f]{32}$/.test(s));if(!id)throw new Error('订阅缺少戏曲播放参数');const d=await ly(site,'play/get/playurl',{item:'y9',nodeCode:'001000',project:'lyhxcx',px:'2',resCode:episode.id,userId:id},signal);if(!d.playres?.playurl)throw new Error('戏曲接口未返回可播放地址');return {url:webUrl(d.playres.playurl),parse:0,header:site.headers};}
  try{return await resolvePage(site,episode.id,signal);}catch(error){if(error.status===428||error.code==='SOURCE_REGION_BLOCKED'||!site.browser||signal?.aborted)throw error;return site.browser.run(error.playerUrl||webUrl(episode.id,site.api),{media:true,signal,...(error.playerReferer?{headers:{referer:error.playerReferer}}:{})});}
}
module.exports={describe,list,detail,resolve,JavaRandom,dubokuSign,dubokuDecode,jsonp};
