const cheerio=require('cheerio');
const {createHash}=require('crypto');
const {resource,postResource}=require('../http');
const {json,webUrl,cleanHeaders}=require('../format');
const {extract}=require('../literals');
const {openUpstreamStream}=require('../../services/proxy');
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
async function biliApi(site, path, signal) {
  const cookie = await site.accounts?.cookie?.('bili');
  const headers = { 'user-agent': desktop, referer: 'https://live.bilibili.com/', ...(cookie ? { cookie } : {}) };
  const result = await get({ ...site, api: bases.bililive, headers }, path, signal);
  if (result.code) throw new Error('B站直播接口：' + (result.message || result.code));
  return result.data || {};
}
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
    data=await biliApi(site,'/xlive/web-interface/v1/webMain/getList?platform=web',signal);
    items=(data.recommend_room_list||[]).map(i=>({vod_id:String(i.roomid||i.room_id),vod_name:i.title,vod_pic:i.cover||i.user_cover,vod_remarks:i.uname}));count=1;
  }
  site.platformRooms ||= new Map();
  for (const item of items) site.platformRooms.set(kind + ':' + item.vod_id, { title: item.vod_name, picture: item.vod_pic, expires: Date.now() + 180000 });
  while (site.platformRooms.size > 500) site.platformRooms.delete(site.platformRooms.keys().next().value);
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
  const cached = site.platformRooms?.get(kind + ':' + room);
  if (cached?.expires > Date.now()) return { vod_id:id, vod_name:cached.title, vod_pic:cached.picture, lines:[{name:'直播',episodes:[{name:'直播',id:kind+':'+room}]}] };
  if(kind==='huya'){const r=await get(proxy,'https://mp.huya.com/cache.php?m=Live&do=profileRoom&roomid='+encodeURIComponent(room),signal);title=r.data?.liveData?.introduction||r.data?.profileInfo?.nick||room;picture=r.data?.liveData?.screenshot;description=r.data?.liveStatus==='OFF'?'主播暂未开播':'';}
  if(kind==='douyu'){title='斗鱼直播 · '+room;}
  if(kind==='bililive'){try{const r=await biliApi(site,'/room/v1/Room/get_info?room_id='+encodeURIComponent(room),signal);title=r.title||room;picture=r.user_cover;}catch{title='B站直播 · '+room;}}
  return {vod_id:id,vod_name:title,vod_pic:picture,vod_content:description,lines:[{name:'直播',episodes:[{name:'直播',id:kind+':'+room}]}]};
}
function huyaUrl(stream,now=Date.now(),uid='0',web=false){
  const query=new URLSearchParams(stream.sHlsAntiCode||stream.sFlvAntiCode),seq=(BigInt(uid)+BigInt(Math.floor(now))*1000n).toString(),ctype=web?'huya_live':query.get('ctype')||'tars_mp',t=web?ctype:query.get('t')||'102',time=(Math.floor(now/1000)+21600).toString(16);
  const md5=s=>createHash('md5').update(s).digest('hex'),template=Buffer.from(query.get('fm')||'','base64').toString();
  const secret=md5(template.replace('$0',uid).replace('$1',stream.sStreamName).replace('$2',md5(seq+'|'+ctype+'|'+t)).replace('$3',time));
  query.delete('fm');query.set('wsSecret',secret);query.set('wsTime',time);query.set('ctype',ctype);query.set('t',t);query.set('u',uid);query.set('seqid',seq);query.set('ver','1');query.set('ratio','0');
  return (stream.sHlsUrl||stream.sFlvUrl).replace(/^http:/,'https:')+'/'+stream.sStreamName+'.'+(stream.sHlsUrlSuffix||'m3u8')+'?'+query;
}
async function huyaGuest(site, signal) {
  if (site.huyaGuest?.expires > Date.now()) return site.huyaGuest.uid;
  try {
    const result = json((await postResource('https://udblgn.huya.com/web/anonymousLogin', JSON.stringify({appId:5002,byPass:3,context:'',version:'2.4',data:{}}), {headers:{'user-agent':desktop},signal,timeout:6000})).text);
    const uid = String(result.data?.uid || '');
    if (/^\d{1,20}$/.test(uid)) { site.huyaGuest = { uid, expires: Date.now() + 300000 }; return uid; }
  } catch (error) { if (signal?.aborted) throw error; }
  return '0';
}
async function checkHls(url, headers, signal) {
  const response = await resource(url, { headers, signal, timeout: 5000, limit: 256 * 1024 });
  if (!/^\s*#EXTM3U/.test(response.text)) throw new Error('直播线路未返回 HLS 清单');
  const entry = response.text.split(/\r?\n/).find(line => line.trim() && !line.trim().startsWith('#'));
  if (!entry) throw new Error('直播清单没有可读分片');
  const child = new URL(entry.trim(), response.url).href;
  const controller = new AbortController(), deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(4000), ...(signal ? [signal] : [])]);
  let upstream;
  try {
    upstream = await openUpstreamStream(child, headers, 3, deadline);
    if (upstream.upRes.statusCode < 200 || upstream.upRes.statusCode >= 300) throw new Error('直播分片返回 HTTP ' + upstream.upRes.statusCode);
    for await (const chunk of upstream.upRes) { if (chunk.length) return response.url; }
    throw new Error('直播分片为空');
  } finally { upstream?.upRes.destroy(); controller.abort(); }
}
async function checkFlv(url, headers, signal) {
  const controller = new AbortController(), deadline = AbortSignal.any([controller.signal, AbortSignal.timeout(4000), ...(signal ? [signal] : [])]); let upstream;
  try {
    upstream = await openUpstreamStream(url, headers, 3, deadline);
    if (upstream.upRes.statusCode < 200 || upstream.upRes.statusCode >= 300) throw new Error('直播流返回 HTTP ' + upstream.upRes.statusCode);
    let prefix = Buffer.alloc(0);
    for await (const chunk of upstream.upRes) { prefix = Buffer.concat([prefix, chunk.subarray(0, 3 - prefix.length)]); if (prefix.length >= 3) { if (prefix.toString() !== 'FLV') throw new Error('直播线路未返回 FLV'); return upstream.finalUrl; } }
    throw new Error('直播流为空');
  } finally { upstream?.upRes.destroy(); controller.abort(); }
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
    const streams=(r.data?.stream?.baseSteamInfoList||[]).filter(s=>s.sHlsUrl||s.sFlvUrl).slice(0,6);
    if(!streams.length)throw new Error('主播暂未开播或没有可用线路');
    const headers={'user-agent':desktop},uid=await huyaGuest(site,signal);let last;
    // Different CDN routes have different region/network availability. Confirm
    // a real manifest, rather than returning the first opaque signed URL.
    for(const stream of streams){
      if (stream.sFlvUrl) {
        const flv = { ...stream, sHlsUrl: stream.sFlvUrl, sHlsUrlSuffix: stream.sFlvUrlSuffix || 'flv', sHlsAntiCode: stream.sFlvAntiCode };
        const rawFlv = stream.sFlvUrl + '/' + stream.sStreamName + '.' + (stream.sFlvUrlSuffix || 'flv') + '?' + stream.sFlvAntiCode;
        for (const url of [huyaUrl(flv,Date.now(),uid,true),huyaUrl(flv,Date.now(),uid),rawFlv]) try { const final=await checkFlv(url,headers,signal);return {url:final,parse:0,type:'flv',header:headers,isLive:true}; } catch(error) { last=error; }
      }
      if (!stream.sHlsUrl) continue;
      const raw=stream.sHlsUrl+'/'+stream.sStreamName+'.'+(stream.sHlsUrlSuffix||'m3u8')+'?'+stream.sHlsAntiCode;
      for(const url of [huyaUrl(stream,Date.now(),uid,true),huyaUrl(stream,Date.now(),uid),raw])try{const final=await checkHls(url,headers,signal);return {url:final,parse:0,type:'hls',header:headers,isLive:true};}catch(error){last=error;}
    }
    throw new Error('虎牙当前 CDN 均不可用：'+(last?.message||'未返回 HLS 清单'));
  }
  if(kind==='bililive'){
    const data=await biliApi(site,'/xlive/web-room/v2/index/getRoomPlayInfo?room_id='+encodeURIComponent(id)+'&protocol=0,1&format=0,1,2&codec=0&qn=10000&platform=h5&ptype=8',signal);
    if (data.live_status != null && Number(data.live_status) !== 1) throw new Error('主播暂未开播');
    const streams=data.playurl_info?.playurl?.stream||[], choices=[];
    for(const stream of streams)for(const format of stream.format||[])for(const codec of format.codec||[])for(const route of codec.url_info||[])if(codec.codec_name==='avc'&&codec.base_url&&route.host)choices.push({url:route.host+codec.base_url+(route.extra||''),type:format.format_name==='flv'?'flv':'hls'});
    const selected=choices.find(c=>c.type==='hls'&&c.url.startsWith('https:'))||choices.find(c=>c.type==='hls')||choices[0];
    if(!selected)throw new Error('B站直播未返回当前账号可播放的地址');return {...selected,parse:0,isLive:true,header:{'user-agent':desktop,referer:'https://live.bilibili.com/'}};
  }
  if(kind==='douyu'){
    if(!site.browser)throw new Error('斗鱼动态播放器需要站点浏览器');return {...await site.browser.run('https://m.douyu.com/'+encodeURIComponent(id),{media:true,signal,timeout:40000,headers:{'user-agent':mobile,referer:'https://m.douyu.com/'}}),isLive:true};
  }
  throw new Error('未识别的直播平台');
}
module.exports={describe,list,detail,resolve,huyaUrl,checkHls,checkFlv};
