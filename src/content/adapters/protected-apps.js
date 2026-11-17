const crypto=require('crypto');
const {resource,postResource}=require('../http');
const {json,webUrl,cleanHeaders}=require('../format');
const hash=(type,text)=>crypto.createHash(type).update(text).digest('hex');
function describe(raw,base){
  const name=/^csp_(Appgz|Gz360|Hmys)(?:Guard)?$/.exec(raw.api)?.[1];if(!name)return null;
  const plugin=name==='Gz360'?'Appgz':name;
  const ext=typeof raw.ext==='object'&&raw.ext||{};
  if(name==='Gz360')return {adapter:'appgz',materialPlugin:'Gz360',api:webUrl(ext.siteUrl||'https://api.h27sq4f.com/',base),extension:ext,supported:true,implementation:'node-gz360',headers:cleanHeaders(raw.header||raw.headers),deviceId:crypto.randomUUID().replace(/-/g,'')};
  return {adapter:plugin==='Hmys'?'hmys':'appgz',api:webUrl(ext.siteUrl||(plugin==='Hmys'?'https://u.gslock.com/':'http://api.nstpsw.com/'),base),extension:ext,supported:true,implementation:'node-'+plugin.toLowerCase(),headers:cleanHeaders(raw.header||raw.headers),deviceId:crypto.randomUUID().replace(/-/g,'')};
}
function aes(data,key,iv,encrypt=false){
  const k=Buffer.from(key),v=Buffer.from(iv);if(![16,24,32].includes(k.length)||v.length!==16)throw new Error('站点加密参数格式已变化');
  const cipher=encrypt?crypto.createCipheriv('aes-'+k.length*8+'-cbc',k,v):crypto.createDecipheriv('aes-'+k.length*8+'-cbc',k,v);
  return Buffer.concat([cipher.update(data),cipher.final()]);
}
function rsaEncrypt(text,encoded){const key=crypto.createPublicKey({key:Buffer.from(encoded,'base64'),format:'der',type:'spki'}),width=Math.ceil(key.asymmetricKeyDetails.modulusLength/8)-11,bytes=Buffer.from(text),parts=[];for(let p=0;p<bytes.length;p+=width)parts.push(crypto.publicEncrypt({key,padding:crypto.constants.RSA_PKCS1_PADDING},bytes.subarray(p,p+width)));return Buffer.concat(parts).toString('base64');}
function rsaDecode(encoded,keyData){
  const key=crypto.createPrivateKey({key:Buffer.from(keyData,'base64'),format:'der',type:'pkcs8'}),width=Math.ceil(key.asymmetricKeyDetails.modulusLength/8),input=Buffer.from(encoded,'base64'),parts=[];
  if(input.length%width)throw new Error('站点密钥响应格式错误');
  for(let p=0;p<input.length;p+=width){const block=crypto.privateDecrypt({key,padding:crypto.constants.RSA_NO_PADDING},input.subarray(p,p+width));const end=block.indexOf(0,2);if(block[0]!==0||block[1]!==2||end<10)throw new Error('站点密钥响应校验失败');parts.push(block.subarray(end+1));}return Buffer.concat(parts).toString('utf8');
}
async function facts(site,signal){
  if(!site.material)throw new Error('该源需要订阅声明的插件配置数据');
  const data=await site.material.get(site.materialPlugin||(site.adapter==='hmys'?'Hmys':'Appgz'),signal);
  if(site.materialPlugin==='Gz360'){
    const strip=s=>(s||'').replace(/-----[^-]+-----|\s/g,'');
    data.fields.N=strip(data.strings.find(s=>s.startsWith('-----BEGIN PUBLIC KEY-----')));
    data.fields.SN=strip(data.strings.find(s=>s.startsWith('-----BEGIN RSA PRIVATE KEY-----')));
  }
  return data;
}
async function appgzCall(site,path,body,signal,token=site.appToken||''){
  const material=await facts(site,signal),fields=material.fields;
  if(!fields.N||!fields.SN)throw new Error('未识别到瓜子接口加密参数，请更新订阅');
  const key=crypto.randomBytes(8).toString('hex'),iv=crypto.randomBytes(8).toString('hex'),time=String(Math.floor(Date.now()/1000));
  const keys=rsaEncrypt(JSON.stringify({iv,key}),fields.N),request_key=aes(Buffer.from(JSON.stringify(body)),key,iv,true).toString('hex').toUpperCase();
  const signature=hash('md5',`token_id=,token=${token},phone_type=1,request_key=${request_key},app_id=1,time=${time},keys=${keys}*&zvdvdvddbfikkkumtmdwqppp?|4Y!s!2br`).toUpperCase();
  const payload={token,token_id:'',phone_type:'1',time,phone_model:'oneplus-hd1900',keys,request_key,signature,app_id:'1',ad_version:'1'};
  const headers={'user-agent':'okhttp/3.12.0',version:'2603002',ver:'3.0.4.0','api-ver':'1',packagename:'com.r3ac892153.q1ed27199a.wf930fc6bf20260401',code:'GZ0001',referer:site.api,...site.headers};
  if(site.materialPlugin==='Gz360')Object.assign(headers,{version:'2606029',ver:'3.0.4.8',packagename:material.strings.find(s=>/^com\.[a-z0-9]+\.[a-z0-9]+\.[a-z0-9]+$/i.test(s))||'',code:material.strings.find(s=>/^GZ\d+$/.test(s))||''});
  const response=json((await postResource(webUrl(path,site.api),new URLSearchParams(payload).toString(),{headers,signal,contentType:'application/x-www-form-urlencoded'})).text);
  if(!response.data?.keys){if(response.code&&![0,1,200].includes(Number(response.code)))throw new Error(response.msg||response.message||'瓜子接口拒绝请求');return response.data||response;}
  const envelope=json(rsaDecode(response.data.keys,fields.SN)),cipher=String(response.data.response_key||'').replace(/\\/g,'');
  return json(aes(Buffer.from(cipher,'hex'),envelope.key,envelope.iv).toString('utf8'));
}
async function hmysCall(site,path,body,signal){
  const {fields}=await facts(site,signal),time=String(Date.now());
  const headers={'user-agent':'okhttp/4.12.0',app_id:fields.i,channel_code:fields.t0,cur_time:time,device_id:site.deviceId,mob_mfr:'OnePlus',mobmodel:'HD1900',package_name:fields.M,sign:hash('md5',fields.N+site.deviceId+time).toUpperCase(),sys_platform:'2',sysrelease:'12',token:site.appToken||'',version:fields.Gc,...site.headers};
  const response=await postResource(webUrl(path,site.api),new URLSearchParams(body).toString(),{headers,signal,contentType:'application/x-www-form-urlencoded'});
  const plain=/^\s*[\[{]/.test(response.text)?response.text:aes(Buffer.from(response.text.trim(),'base64'),fields.yq,fields.SN).toString('utf8'),data=json(plain);
  if(data.code&&![0,1,200,10000].includes(Number(data.code)))throw new Error(data.message||data.msg||'海绵接口拒绝请求');return data.result??data.data??data;
}
async function initialize(site,signal){
  if(site.initialized)return; if(site.initializing)return site.initializing;
  site.initializing=(async()=>{
    const saved=site.runtime?.get() || {};
    site.deviceId=saved.deviceId || site.deviceId;site.appToken=saved.token || '';
    site.runtime?.set({deviceId:site.deviceId});
    if(site.adapter==='hmys'){
      const info=await hmysCall(site,'/api/new_public/init_v2',{invited_by:'',user_agent:'Mozilla/5.0 (Linux; Android 12) AppleWebKit/537.36 Chrome/131.0.0.0 Mobile Safari/537.36'},signal);
      site.appToken=info.user_info?.token||'';
    }else{
      const deviceKey=saved.deviceKey || crypto.randomBytes(18).toString('base64');
      site.runtime?.set({deviceKey});
      if(saved.token){site.initialized=true;return;}
      const response=await appgzCall(site,'/App/Authentication/Device/signUp',{old_key:site.deviceId.slice(0,16),new_key:deviceKey,phone_type:1,code:'',recommend_id:''},signal,'');
      site.appToken=response.token||response.data?.token||'';
    }
    site.runtime?.set({token:site.appToken});site.initialized=true;
  })();try{await site.initializing;}finally{site.initializing=null;}
}
function video(item){return {vod_id:String(item.vod_id||item.d_id||item.id),vod_name:item.vod_name||item.title,vod_pic:item.vod_pic||item.c_pic||item.pic,vod_remarks:item.vod_remarks||item.new_continue||item.collection_new_title||item.serial,vod_year:item.vod_year,vod_area:item.vod_area,vod_actor:item.vod_actor,vod_director:item.vod_director,vod_content:item.vod_content||item.intro};}
async function list(site,{id='',page=1,keyword='',filters={}}={},signal){
  await initialize(site,signal);let classes=[],data;
  if(site.adapter==='hmys'){
    if(!id&&!keyword){const types=await hmysCall(site,'/api/new_type/list_v2',{},signal);classes=(Array.isArray(types)?types:types.list||[]).filter(t=>t.name&&t.name!=='待添加').map(t=>({type_id:String(t.id),type_name:t.name}));id=classes[0]?.type_id||'1';}
    data=await hmysCall(site,keyword?'/api/new_search/result_v2':'/api/new_search/screen_v2',keyword?{pn:String(page),kw:keyword}:{pn:String(page),type_id:id,tag_type:'',...filters},signal);
  }else{
    classes=[['1','电影'],['2','电视剧'],['4','动漫'],['3','综艺']].map(([type_id,type_name])=>({type_id,type_name}));
    data=await appgzCall(site,keyword?'/App/Index/findMoreVod':'/App/IndexList/indexList',keyword?{keywords:keyword,order_val:'1'}:{tid:id||'1',page:String(page),pageSize:'30',sort:'d_id',year:filters.year||'',area:filters.area||'',sub:''},signal);
  }
  const items=Array.isArray(data)?data:data.list||data.data||[];
  return {class:classes,list:(Array.isArray(items)?items:[]).map(video),page,pagecount:items.length>=20?Number(page)+1:Number(page),total:0};
}
async function detail(site,id,signal){
  await initialize(site,signal);
  if(site.adapter==='hmys'){
    const data=await hmysCall(site,'/api/new_video/result_v2',{vod_id:id,sig:'',nc_token:'',session_id:'',code:'',phone:''},signal),time=String(data.server_time||Math.floor(Date.now()/1000));
    return {...video(data),vod_id:id,lines:[{name:'秒播',episodes:(data.vod_collection||[]).map(e=>({name:e.title,id:Buffer.from(JSON.stringify({collection_id:String(e.id),vod_token:e.vod_token,cur_time:time,vod_id:id})).toString('base64url')}))}]};
  }
  const data=await appgzCall(site,'/App/IndexPlay/playInfo',{vod_id:id,token_id:'',token:site.appToken,mobile_time:String(Math.floor(Date.now()/1000))},signal),item=data.vodInfo||data,lines=[];
  const groups=await appgzCall(site,'/App/Resource/Vurl/show',{vurl_cloud_id:'2',vod_d_id:id},signal);
  for(const quality of site.materialPlugin==='Gz360'?['3840','2160','1080','720','480','360','240']:['1080','720','480']){
    const episodes=[];
    for(const item of groups.list||[]){
      if(String(item.pay_playable)==='0')continue;
      const param=item.play?.[quality]?.param;if(!param)continue;
      const values=Object.fromEntries(new URLSearchParams(param));values.vod_id=values.vod_d_id;delete values.vod_d_id;
      episodes.push({name:item.title||String(item.sort||episodes.length+1),id:Buffer.from(JSON.stringify(values)).toString('base64url')});
    }
    if(episodes.length)lines.push({name:quality+'P',episodes});
  }
  if(!lines.length)throw new Error('当前账号没有该影片可播放的剧集或画质');
  return {...video(item),vod_id:id,lines};
}
async function resolve(site,episode,signal){
  await initialize(site,signal);const entry=json(Buffer.from(episode.id,'base64url').toString());
  if(site.adapter==='hmys'){
    const data=await hmysCall(site,'/api/new_video/collection_v2',{...entry,nc_token:'',sig:'',code:'',phone:'',session_id:''},signal);
    if(data.check_url||data.check_page_url)throw Object.assign(new Error('此线路需要完成站点播放验证'),{status:428,verifyUrl:data.check_url||data.check_page_url});
    if(!data.vod_url)throw new Error('海绵没有返回播放地址');
    return {url:data.vod_url,parse:0,type:'hls',header:{'user-agent':'Mozi',accept:'*/*'},playlistContext:data.ck?{kind:'hmys',ck:data.ck,sign:(await facts(site,signal)).fields.KJ}:null};
  }
  const data=await appgzCall(site,'/App/Resource/VurlDetail/showOne',entry,signal);
  const url=data.url||data.play_url||data.vod_url;if(!url)throw new Error('瓜子未返回播放地址');return {url,parse:0,header:{...site.headers,'user-agent':'Lavf/57.83.100'}};
}
module.exports={describe,list,detail,resolve,aes,rsaDecode,rsaEncrypt,appgzCall,hmysCall};
