const cheerio=require('cheerio');
const {createHash}=require('crypto');
const {resource,postResource}=require('../http');
const {json,webUrl,cleanHeaders}=require('../format');
const {extract}=require('../literals');
const desktop='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const mobile='Mozilla/5.0 (iPhone; CPU iPhone OS 13_2_3 like Mac OS X) AppleWebKit/605.1.15 Version/13.0.3 Mobile/15E148 Safari/604.1';
const bases={huya:'https://www.huya.com/',douyu:'https://m.douyu.com/',xiaobei:'https://www.tuxiaobei.com/',bililive:'https://api.live.bilibili.com/'};
const classes={huya:[['8','娱乐'],['1','网游'],['2','单机'],['3','手游']],douyu:[['yl','娱乐天地'],['PCgame','网游竞技'],['djry','单机热游'],['syxx','手游休闲'],['yz','颜值'],['kjwh','科技文化']],xiaobei:[['2','儿歌'],['3','故事'],['4','国学'],['25','启蒙']],alllive:[['huya','虎牙'],['douyu','斗鱼'],['bililive','B站直播']]};
function describe(raw,base){
  let kind;
  if(/^csp_Alllive(?:Guard)?$/.test(raw.api))kind='alllive';
  else if(/\.js(?:[?;]|$)/i.test(raw.api)){const name=decodeURIComponent(String(raw.ext||''))+' '+raw.key;if(/虎牙|huya/i.test(name))kind='huya';else if(/斗鱼|douyu/i.test(name))kind='douyu';else if(/兔小贝|tuxiaobei/i.test(name))kind='xiaobei';}
  if(!kind)return null;
  return {adapter:kind,api:bases[kind]||bases.huya,ruleUrl:kind!=='alllive'&&typeof raw.ext==='string'?webUrl(raw.ext,base):'',supported:true,implementation:'node-platform-'+kind,headers:cleanHeaders({'user-agent':kind==='huya'?desktop:mobile,...raw.header,...raw.headers})};
}
async function metadata(site,signal){if(!site.ruleUrl)return {};if(site.ruleMeta)return site.ruleMeta;const r=await resource(site.ruleUrl,{signal,limit:256*1024});return site.ruleMeta=extract(r.text,/\b(?:var|let|const)\s+rule\s*=/)||{};}
function parse(text){const stripped=text.trim().replace(/^\(/,'').replace(/\);?$/,'');return json(stripped);}
async function get(site,address,signal){return parse((await resource(webUrl(address,site.api),{headers:site.headers,signal})).text);}
async function list(site,{id='',page=1,keyword='',filters={}}={},signal){
  const rule=await metadata(site,signal),kind=site.adapter==='alllive'?(id||'huya'):site.adapter;
  const api=site.adapter==='alllive'?bases[kind]:site.api;
  const proxy={...site,api};let data,items=[],count=1;
  if(kind==='huya'){
    if(keyword){data=await get(proxy,'https://search.cdn.huya.com/?m=Search&do=getSearchContent&q='+encodeURIComponent(keyword)+'&uid=0&v=4&typ=-5&livestate=0&rows=20&start='+(page-1)*20,signal);items=(data.response?.['3']?.docs||[]).map(i=>({vod_id:String(i.room_id),vod_name:i.gameName||i.liveIntro,vod_pic:i.game_screenshot,vod_remarks:i.game_nick}));}
    else{const game=filters.cateId||rule.filter_def?.[id||'8']?.cateId||({'8':'2135','1':'1','2':'1732','3':'2336'}[id])||'2135';data=await get(proxy,'/cache.php?m=LiveList&do=getLiveListByPage&gameId='+encodeURIComponent(game)+'&tagAll=0&page='+page,signal);items=(data.data?.datas||[]).map(i=>({vod_id:String(i.profileRoom),vod_name:i.introduction||i.roomName,vod_pic:i.screenshot,vod_remarks:i.nick}));count=Number(data.data?.totalPage)||1;}
  }else if(kind==='douyu'){
    if(keyword){const r=await postResource(new URL('/api/search/liveRoom',api).href,new URLSearchParams({did:'10000000000000000000000000001501',limit:'20',offset:String((page-1)*20),sk:keyword}).toString(),{headers:site.headers,signal,contentType:'application/x-www-form-urlencoded'});data=parse(r.text);}
    else data=await get(proxy,'/api/room/list?page='+page+'&type='+encodeURIComponent(filters.cateId||rule.filter_def?.[id||'yl']?.cateId||({yl:'yqk',PCgame:'LOL',djry:'TVgame',syxx:'wzry'}[id])||'yqk'),signal);
    items=(data.data?.list||[]).map(i=>({vod_id:String(i.rid||i.roomId),vod_name:i.roomName,vod_pic:i.roomSrc,vod_remarks:i.nickname}));count=items.length>=20?Number(page)+1:Number(page);
  }else if(kind==='xiaobei'){
    if(keyword){const r=await resource(new URL('/search/index?key='+encodeURIComponent(keyword),api).href,{headers:site.headers,signal}),$=cheerio.load(r.text);items=$('.list-con .items').map((_,e)=>({vod_id:$(e).find('a').attr('href'),vod_name:$(e).find('.text').text(),vod_pic:$(e).find('mip-img,img').attr('src'),vod_remarks:$(e).find('.time').text()})).get();}
    else{data=await get(proxy,'/list/mip-data?typeId='+encodeURIComponent(id||'2')+'&page='+page+'&callback=',signal);items=(data.data?.items||[]).map(i=>({vod_id:String(i.video_id),vod_name:i.name,vod_pic:i.image,vod_remarks:i.duration_string}));count=items.length?Number(page)+1:Number(page);}
  }else if(kind==='bililive'){
    data=await get(proxy,'/xlive/web-interface/v1/second/getListByArea?platform=web&parent_area_id=0&area_id=0&sort_type=online&page_size=30&page='+page,signal);
    items=(data.data?.list||[]).map(i=>({vod_id:String(i.roomid||i.room_id),vod_name:i.title,vod_pic:i.cover||i.user_cover,vod_remarks:i.uname}));count=items.length>=20?Number(page)+1:Number(page);
  }
  if(site.adapter==='alllive')items=items.map(i=>({...i,vod_id:kind+':'+i.vod_id}));
  return {class:(classes[site.adapter]||[]).map(([type_id,type_name])=>({type_id,type_name})),filters:rule.filter||{},list:items,page,pagecount:count,total:0};
}
async function detail(site,id,signal){
  let kind=site.adapter,room=id;if(kind==='alllive'){const split=id.indexOf(':');kind=id.slice(0,split);room=id.slice(split+1);}
  const api=site.adapter==='alllive'?bases[kind]:site.api,proxy={...site,api};let title=room,picture='',description='';
  if(kind==='xiaobei'){
    const url=webUrl(/^\//.test(room)?room:'/play/'+room,api),r=await resource(url,{headers:site.headers,signal}),$=cheerio.load(r.text);
    title=$('h1,.video-title,.play-title').first().text()||$('title').text();picture=$('mip-img,img').first().attr('src')||'';
    return {vod_id:id,vod_name:title,vod_pic:picture,lines:[{name:'视频',episodes:[{name:'播放',id:url}]}]};
  }
  if(kind==='huya'){const r=await get(proxy,'https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid='+encodeURIComponent(room),signal);title=r.data?.liveData?.introduction||r.data?.profileInfo?.nick||room;picture=r.data?.liveData?.screenshot;description=r.data?.liveStatus==='OFF'?'主播暂未开播':'';}
  if(kind==='douyu'){const r=await get(proxy,'/api/room/room?roomId='+encodeURIComponent(room),signal);title=r.data?.room?.roomName||r.data?.roomName||room;picture=r.data?.room?.roomSrc||r.data?.roomSrc;}
  if(kind==='bililive'){const r=await get(proxy,'/room/v1/Room/get_info?room_id='+encodeURIComponent(room),signal);title=r.data?.title||room;picture=r.data?.user_cover;}
  return {vod_id:id,vod_name:title,vod_pic:picture,vod_content:description,lines:[{name:'直播',episodes:[{name:'直播',id:kind+':'+room}]}]};
}
function huyaUrl(stream,now=Date.now()){
  const query=new URLSearchParams(stream.sHlsAntiCode||stream.sFlvAntiCode),uid='0',seq=String(now)+'0000',ctype=query.get('ctype')||'tars_mp',t=query.get('t')||'102',time=query.get('wsTime');
  const md5=s=>createHash('md5').update(s).digest('hex'),template=Buffer.from(query.get('fm')||'','base64').toString();
  const secret=md5(template.replace('$0',uid).replace('$1',stream.sStreamName).replace('$2',md5(seq+'|'+ctype+'|'+t)).replace('$3',time));
  query.delete('fm');query.set('wsSecret',secret);query.set('u',uid);query.set('seqid',seq);query.set('ratio','0');
  return (stream.sHlsUrl||stream.sFlvUrl).replace(/^http:/,'https:')+'/'+stream.sStreamName+'.'+(stream.sHlsUrlSuffix||'m3u8')+'?'+query;
}
async function resolve(site,episode,signal){
  if(site.adapter==='xiaobei'){
    const r=await resource(episode.id,{headers:{...site.headers,'user-agent':mobile},signal}),$=cheerio.load(r.text),url=$('#videoWrap').attr('video-src')||$('video,source').attr('src');
    if(!url)throw new Error('兔小贝未返回媒体地址');return {url:webUrl(url,r.url),parse:0,header:site.headers};
  }
  const [kind,...rest]=episode.id.split(':'),id=rest.join(':'),proxy={...site,api:bases[kind]||site.api};
  if(kind==='huya'){
    const r=await get(proxy,'https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid='+encodeURIComponent(id),signal);
    if(r.data?.isRoomPay)throw new Error('该房间需要登录并取得观看权限');
    const streams=(r.data?.stream?.baseSteamInfoList||[]).filter(s=>s.sHlsUrl).slice(0,6);
    if(!streams.length)throw new Error('主播暂未开播或没有可用线路');
    const headers={'user-agent':'Mozilla/5.0',referer:'https://www.huya.com/'};let last;
    // Different CDN routes have different region/network availability. Confirm
    // a real manifest, rather than returning the first opaque signed URL.
    for(const stream of streams){
      const raw=stream.sHlsUrl+'/'+stream.sStreamName+'.'+(stream.sHlsUrlSuffix||'m3u8')+'?'+stream.sHlsAntiCode;
      for(const url of [raw,huyaUrl(stream)])try{const response=await resource(url,{headers,signal,timeout:5000,limit:256*1024});if(/^\s*#EXTM3U/.test(response.text))return {url,parse:0,type:'hls',header:headers,isLive:true};}catch(error){last=error;}
    }
    throw new Error('虎牙当前 CDN 均不可用：'+(last?.message||'未返回 HLS 清单'));
  }
  if(kind==='bililive'){
    const r=await get(proxy,'/room/v1/Room/playUrl?cid='+encodeURIComponent(id)+'&platform=h5&quality=4',signal),url=r.data?.durl?.[0]?.url;
    if(!url)throw new Error('B站直播未返回可播放地址');return {url,parse:0,type:'hls',isLive:true,header:{'user-agent':desktop,referer:'https://live.bilibili.com/'}};
  }
  if(kind==='douyu'){
    if(!site.browser)throw new Error('斗鱼动态播放器需要站点浏览器');return {...await site.browser.run('https://m.douyu.com/'+encodeURIComponent(id),{media:true,signal,timeout:40000}),isLive:true};
  }
  throw new Error('未识别的直播平台');
}
module.exports={describe,list,detail,resolve,huyaUrl};
