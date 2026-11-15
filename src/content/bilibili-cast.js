const {resource}=require('./http');
const {json,cleanHeaders,webUrl}=require('./format');
const cheerio=require('cheerio');

const number=value=>/^\d{1,20}$/.test(String(value||''))?String(value):'';
const flag=value=>value===true||value===1||value==='1'||value==='true';
function qualityDescription(data,current,desired){
  const formats=Array.isArray(data.support_formats)?data.support_formats:[];
  const supported=formats.length?formats:(data.accept_quality||[]).map((quality,index)=>({quality,description:data.accept_description?.[index]}));
  const seen=new Set(),supportQnList=[];
  for(const item of supported.slice(0,32)){
    const quality=Number(item.quality);if(!Number.isInteger(quality)||quality<1||seen.has(quality))continue;seen.add(quality);
    supportQnList.push({quality,description:String(item.description||item.new_description||quality).slice(0,80),displayDesc:String(item.display_desc||item.new_description||item.description||quality).slice(0,80),needLogin:flag(item.need_login),needVip:flag(item.need_vip),superscript:String(item.superscript||'').slice(0,30)});
  }
  if(!supportQnList.length)supportQnList.push({quality:current||0,description:'自动',displayDesc:'自动',needLogin:false,needVip:false,superscript:''});
  return {curQn:Number(current)||0,userDesireQn:desired,supportQnList};
}

function createBilibiliResolver({getSite=()=>({}),apiBase='https://api.bilibili.com/',liveBase='https://api.live.bilibili.com/',commentBase='https://comment.bilibili.com/'}={}){
  const comments=new Map();
  const headers=()=>({'user-agent':'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',referer:'https://www.bilibili.com/',...cleanHeaders(getSite()?.headers)});
  async function call(route,params,signal,base=apiBase){
    const url=new URL(route,base);for(const [key,value]of Object.entries(params))if(value!==undefined&&value!=='')url.searchParams.set(key,String(value));
    const result=json((await resource(url.href,{headers:headers(),signal,timeout:12000})).text);
    if(result.code&&Number(result.code)!==0)throw new Error('B站接口：'+String(result.message||result.msg||result.code).slice(0,180));
    return result.data||result.result||{};
  }
  const resolve=async(params,signal)=>{
    const aid=number(params.aid),cid=number(params.cid),epId=number(params.epId||params.epid),roomId=number(params.roomId||params.room_id);
    const requested=Number(params.qn??params.userDesireQn)||0,desired=Number.isInteger(requested)&&requested>=0&&requested<=100000?requested:0;
    const accessKey=String(params.accessKey||params.access_key||'');
    if(accessKey.length>4096||/[\r\n\0]/.test(accessKey))throw new Error('B站登录会话格式无效');
    const authentication=accessKey?{access_key:accessKey}:{};
    if(Number(params.contentType)===4||roomId){
      if(!roomId)throw new Error('缺少直播间编号');
      const data=await call('/room/v1/Room/playUrl',{cid:roomId,platform:'h5',quality:desired||4,...authentication},signal,liveBase),entry=data.durl?.[0];
      if(!entry?.url)throw new Error('B站未返回当前账号可播放的直播地址');
      return {url:webUrl(entry.url),headers:headers(),mimeType:/\.m3u8(?:[?#]|$)/i.test(entry.url)?'application/vnd.apple.mpegurl':'video/x-flv',isLive:true,title:String(params.title||'B站直播 '+roomId).slice(0,200),playItem:{contentType:4,roomId},nva:qualityDescription(data,data.current_quality||0,desired),episodes:[]};
    }
    if(!aid||!cid)throw new Error('缺少有效的视频 AID/CID');
    const course=Number(params.contentType)===2,route=course?'/pugv/player/web/playurl':epId?'/pgc/player/web/playurl':'/x/player/playurl';
    const data=await call(route,{avid:aid,cid,...(epId?{ep_id:epId}:{}),qn:desired||127,fnval:4048,fourk:1,...authentication},signal);
    if(data.is_drm||Number(data.drm_tech_type)>0)throw new Error('该视频需要 DRM 授权播放，当前接收端不支持');
    const requestHeaders=headers();delete requestHeaders.cookie;delete requestHeaders.authorization;
    let url,audioUrl='',current=Number(data.quality)||0,mimeType='video/mp4';
    if(data.dash){
      const available=(data.dash.video||[]).filter(video=>video.baseUrl||video.base_url),matching=available.filter(video=>!desired||Number(video.id)<=desired),pool=matching.length?matching:available;
      const ordered=pool.sort((a,b)=>Number(b.id)-Number(a.id)||Number(/avc|h264/i.test(b.codecs||''))-Number(/avc|h264/i.test(a.codecs||''))||Number(b.bandwidth)-Number(a.bandwidth));
      const selected=ordered[0],audio=(data.dash.audio||[]).sort((a,b)=>Number(b.bandwidth)-Number(a.bandwidth))[0];
      if(!selected)throw new Error('B站未返回当前账号可播放的视频档位');
      url=selected.baseUrl||selected.base_url;audioUrl=audio?.baseUrl||audio?.base_url||'';current=Number(selected.id)||current;
    }else if(data.durl?.length===1)url=data.durl[0].url;
    else throw new Error('当前视频未返回可播放的 DASH 或单文件地址');
    let title=String(params.title||''),episodes=[];
    if(!epId&&!course){
      const info=await call('/x/web-interface/view',{aid},signal).catch(()=>null);
      if(info){title=title||info.title||'';episodes=(info.pages||[]).slice(0,500).filter(item=>number(item.cid)).map(item=>({aid,cid:String(item.cid),title:String(item.part||info.title||'').slice(0,200)}));}
    }
    return {url:webUrl(url),audioUrl:audioUrl?webUrl(audioUrl):'',headers:requestHeaders,mimeType,duration:Number(data.timelength)/1000||Number(data.dash?.duration)||0,title:title.slice(0,200)||'B站投屏',playItem:{aid,cid,contentType:Number(params.contentType)||1,epId:epId||0,seasonId:number(params.seasonId)||0},episodes,nva:qualityDescription(data,current,desired)};
  };
  resolve.danmaku=async(cid,signal)=>{
    if(!number(cid))throw new Error('弹幕编号无效');const cached=comments.get(String(cid));if(cached&&cached.expires>Date.now())return cached.items;
    const xml=(await resource(new URL(cid+'.xml',commentBase).href,{headers:{referer:'https://www.bilibili.com/'},signal,limit:4*1024*1024,timeout:10000})).text,$=cheerio.load(xml,{xmlMode:true}),items=[];
    $('d[p]').slice(0,5000).each((_,node)=>{const p=String($(node).attr('p')).split(','),time=Number(p[0]),mode=Number(p[1]),text=$(node).text().slice(0,160);if(Number.isFinite(time)&&time>=0&&text&&[1,4,5,6].includes(mode))items.push({time,mode,size:Math.max(16,Math.min(36,Number(p[2])||25)),color:(Number(p[3])>>>0)&0xffffff,text});});
    items.sort((a,b)=>a.time-b.time);comments.set(String(cid),{items,expires:Date.now()+15*60*1000});while(comments.size>4)comments.delete(comments.keys().next().value);return items;
  };
  return resolve;
}
module.exports={createBilibiliResolver,qualityDescription};
