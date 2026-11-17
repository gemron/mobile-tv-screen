const crypto=require('crypto');
const {resource,postResource}=require('../http');
const {json,webUrl,cleanHeaders}=require('../format');
const pb=require('../protobuf');
const {aes}=require('./xs-apps');
const random=n=>crypto.randomBytes(n).toString('hex').slice(0,n);
function describe(raw,base){
  if(raw.api!=='csp_AppDrama')return null;
  const extension=raw.ext&&typeof raw.ext==='object'?raw.ext:{};
  return {adapter:'xs-drama',extension,api:webUrl(extension.host||extension.site,base),bootstrap:!extension.host,supported:true,implementation:'node-appdrama',deviceId:crypto.randomUUID().replace(/-/g,''),headers:cleanHeaders(raw.header||raw.headers)};
}
function ecb(text,key){const k=Buffer.from(key||'');if(![16,24,32].includes(k.length))throw new Error('片源签名参数无效');const cipher=crypto.createCipheriv('aes-'+k.length*8+'-ecb',k,null);return Buffer.concat([cipher.update(text),cipher.final()]).toString('base64');}
function rsa(text,key){return crypto.publicEncrypt({key:crypto.createPublicKey({key:Buffer.from(key,'base64'),format:'der',type:'spki'}),padding:crypto.constants.RSA_PKCS1_PADDING},Buffer.from(text)).toString('base64');}
function headers(site,signed=true){
  const e=site.extension,now=Date.now(),r=random(16),base={country:'CN',vName:e.version,pkg:e.pkg,uuid:site.deviceId,udid:site.deviceId,resolution:'1080x2272',mac:'02%3A00%3A00%3A00%3A00',abid:'397',model:'MobileTV',facturer:'xiaomi',plat:'android',dpi:'440',net:'1',lang:'zh',brand:'xiaomi',density:'2.75',appName:e.appName,cpu:'arm64-v8a',chid:'10000',_vOsCode:35,vOs:'15',v:1,tenantId:'',vApp:String(e.version||'').replace(/\./g,''),device:0,androidID:site.deviceId,young:0};
  if(signed){const sig=ecb(String(now)+r,e.dataIv);Object.assign(base,{sig:rsa(String(now)+r+base.vApp,site.publicKey||e.publicKey),random_str:r,timestamp:now,sig2:sig.slice(0,8),sig3:sig.slice(8)});}
  Object.assign(base,{cpuId:'MT6893Z%2FCZA',facturer:'OnePlus',model:'HD1900',brand:'OnePlus',carrier:'%E8%81%94%E9%80%9A',androidID:site.deviceId.slice(0,16),uuid:site.deviceId.toUpperCase(),udid:site.deviceId.toUpperCase()});
  const encoded=aes(Buffer.from(JSON.stringify(base)),site.publicParamsKey,site.publicParamsKey,true).toString('hex');
  return {'user-agent':'okhttp/3.12.1',accept:signed?'application/x-protobuf':'application/json',publicParams:JSON.stringify({paramsData:encoded}),...site.headers};
}
async function rawCall(site,path,body,signal){
  const response=await postResource(webUrl(path,site.api),body,{headers:headers(site),contentType:'application/x-protobuf',signal,timeout:12000});
  const result=pb.decode(response.body),data=pb.first(result,3);
  if(!Buffer.isBuffer(data))throw new Error(pb.text(result,2)||'AppDrama 未返回业务数据');return data;
}
async function initialize(site,signal){
  if(site.initializing)return site.initializing;if(site.ready)return;
  site.initializing=(async()=>{
    if(site.bootstrap){const data=json((await resource(site.api,{signal,limit:65536,timeout:8000})).text);site.api=webUrl(data.domain);site.bootstrap=false;}
    const facts=await site.material.get('AppDrama',signal);site.publicParamsKey=facts.fields.c;
    if(!site.publicParamsKey)throw new Error('订阅插件缺少 AppDrama 请求参数');
    const time=Date.now(),r=random(16),request=pb.encode([[1,time],[2,rsa(String(time)+r,site.extension.publicKey)],[3,random(16)],[4,r],[5,random(16)]]);
    const data=pb.decode(await rawCall(site,'/api/v5/find/app/zone',request,signal));
    const key=[2,3,4,5].map(id=>pb.text(data,id)).join('');if(!key)throw new Error('AppDrama 密钥协商失败');site.publicKey=key;site.ready=true;
  })();try{await site.initializing;}finally{site.initializing=null;}
}
function body(site,params){const time=Date.now(),r=random(8),query=Object.entries(params).filter(([,v])=>v!=null&&String(v)!=='').map(([k,v])=>k+'='+v).join('&'),data=r+ecb(query+time,site.extension.dataKey);return pb.encode([[1,data.slice(0,20)],[2,data.slice(20)],[3,random(20)],[4,time],[5,r]]);}
async function call(site,path,params,signal){await initialize(site,signal);return pb.decode(await rawCall(site,path,body(site,params),signal));}
function video(data,detail=false){
  const cover=pb.first(data,2);let picture='';if(Buffer.isBuffer(cover)){const image=pb.decode(cover);picture=pb.text(image,2)||pb.text(image,1);}
  return {vod_id:pb.text(data,detail?4:3),vod_name:pb.text(data,detail?9:5),vod_pic:picture,vod_remarks:pb.text(data,detail?26:13),vod_actor:pb.text(data,detail?25:12),vod_director:pb.text(data,detail?12:7),vod_year:pb.text(data,detail?18:14),vod_content:pb.text(data,detail?6:4)};
}
async function list(site,{id='',page=1,keyword='',filters={}}={},signal){
  await initialize(site,signal);
  let classes=[];
  if(!keyword&&!id){const data=json((await resource(webUrl('/api/v3/drama/getCategory?orderBy=type_id',site.api),{headers:headers(site,false),signal})).text);classes=(data.data||[]).filter(t=>t.name!=='公告').map(t=>({type_id:String(t.id),type_name:t.name}));id=classes[0]?.type_id||'1';}
  const result=await call(site,keyword?'/api/proto/v5/drama/search':'/api/proto/v5/drama/category',keyword?{searchKeys:keyword,page,pagesize:21}:{pagesize:21,typeId1:id,page,vodOrderBy:filters.extend_sort||'最新',vodArea:filters.area||'',vodLang:filters.lang||'',vodClass:filters.class||'',vodYear:filters.year||''},signal);
  const items=(result.get(1)||[]).filter(Buffer.isBuffer).map(v=>video(pb.decode(v)));
  return {class:classes,list:items,page,pagecount:items.length>=21?Number(page)+1:Number(page)};
}
async function detail(site,id,signal){
  const data=await call(site,'/api/proto/v5/drama/getDetail',{id},signal),groups=new Map();
  for(const bytes of data.get(29)||[]){const v=pb.decode(bytes),name=pb.text(v,10)||'线路';if(!groups.has(name))groups.set(name,[]);groups.get(name).push({name:pb.text(v,2)||'播放',id:'xs-drama:'+Buffer.from(JSON.stringify({vodPlayFrom:pb.text(v,9),playUrl:pb.text(v,4)})).toString('base64url')});}
  if(!groups.size)throw new Error('AppDrama 影片未返回剧集');
  return {...video(data,true),lines:[...groups].map(([name,episodes])=>({name,episodes}))};
}
async function resolve(site,episode,signal){
  if(!episode.id.startsWith('xs-drama:')||episode.id.length>16000)throw new Error('AppDrama 剧集参数无效');
  const params=json(Buffer.from(episode.id.slice(9),'base64url').toString());
  if(/\.(mp4|m3u8|flv|mkv|mp3)(?:[?#]|$)/i.test(params.playUrl))return {url:webUrl(params.playUrl),parse:0,header:site.headers};
  const data=await call(site,'/api/proto/v5/videoUsableUrl',params,signal),header={};for(const row of data.get(6)||[]){const entry=pb.decode(row);header[pb.text(entry,1)]=pb.text(entry,2);}
  const url=pb.text(data,1);if(!url)throw new Error(pb.text(data,9)||'AppDrama 解析未返回媒体');return {url:webUrl(url),parse:0,header:cleanHeaders(header)};
}
module.exports={describe,list,detail,resolve,ecb,body,video};
