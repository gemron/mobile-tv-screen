const cheerio=require('cheerio');
const fs=require('fs');
const path=require('path');
const {createHash}=require('crypto');
const {setTimeout:delay}=require('timers/promises');
const {resource,postJson,postResource}=require('./http');
const {webUrl,json}=require('./format');
const {extract}=require('./literals');
const {loginUrls}=require('./accounts');
const {QuarkCleanup}=require('./quark-cleanup');
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const QUARK_DESKTOP_UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) quark-cloud-drive/2.5.56 Chrome/100.0.4896.160 Electron/18.3.5.12-a038f7b798 Safari/537.36 Channel/pckk_other_ch';
const apiBases={quark:'https://drive-pc.quark.cn/1/clouddrive/',uc:'https://pc-api.uc.cn/1/clouddrive/',ali:'https://api.aliyundrive.com/',baidu:'https://pan.baidu.com/'};
const video=/\.(mp4|mkv|mov|m4v|flv|ts|m3u8|avi|webm|mp3|m4a|aac|flac|wav)(?:[?#]|$)/i;
const encode=v=>'cloud:'+Buffer.from(JSON.stringify(v)).toString('base64url');
function decode(v){if(!String(v).startsWith('cloud:'))throw new Error('网盘剧集地址无效');return json(Buffer.from(v.slice(6),'base64url').toString());}
function shareAddress(input){
  const raw=String(input||''),matched=/https?:\/\/[^\s<>"'，。；]+/i.exec(raw)?.[0];if(!matched)throw new Error('未找到网盘分享地址');
  const url=new URL(matched),host=url.hostname;
  const provider=host==='pan.quark.cn'?'quark':host==='drive.uc.cn'?'uc':/^(?:www\.)?(?:aliyundrive|alipan)\.com$/.test(host)?'ali':host==='pan.baidu.com'?'baidu':'';
  if(!provider)throw new Error('目前支持夸克、UC、阿里和百度分享链接');
  const id=/\/s\/([^/?#]+)/.exec(url.pathname)?.[1]||url.searchParams.get('surl');if(!id)throw new Error('网盘分享地址不完整');
  const password=url.searchParams.get('pwd')||url.searchParams.get('passcode')||/(?:提取码|密码|pwd)\s*[:：=]?\s*([a-zA-Z0-9]{4,8})/.exec(raw)?.[1]||'';
  return {provider,share:id,password,url:url.href};
}
class Cloud{
  constructor(accounts,browser,{endpoints={}}={}){
    this.accounts=accounts;this.browser=browser;this.endpoints={...apiBases,bili:'https://api.bilibili.com/',...endpoints};this.shareSaves=new Map();this.shareSaving=new Map();
    this.shareFile=accounts.file?path.join(path.dirname(accounts.file),'cloud-shares.json'):null;
    try{const records=json(fs.readFileSync(this.shareFile,'utf8'));for(const [key,value]of Object.entries(records))if(/^[a-f0-9]{64}$/.test(key)&&value?.provider==='quark'&&(typeof value.fid==='string'||typeof value.taskId==='string'))this.shareSaves.set(key,value);}catch{}
    this.cleanup=new QuarkCleanup(this);
  }
  shareKey(file){return createHash('sha256').update(JSON.stringify([file.provider,file.share,file.fid])).digest('hex');}
  async recordKey(file){
    const base=this.shareKey(file),owner=file.provider==='quark'?await this.cleanup.owner():'';
    if(!owner)return base;
    const scoped=createHash('sha256').update(base+':'+owner).digest('hex'),legacy=this.shareSaves.get(base);
    return this.shareSaves.has(scoped)?scoped:legacy&&(!legacy.ownerHash||legacy.ownerHash===owner)?base:scoped;
  }
  async holdEpisode(id,signal){
    signal?.throwIfAborted();
    if(!String(id).startsWith('cloud:'))return null;
    const file=decode(id);if(file.provider!=='quark')return null;
    const key=file.drive?[...this.shareSaves].find(([,r])=>r.fid===file.fid)?.[0]||'':await this.recordKey(file);
    await this.cleanup.waitForDeletion(key);
    signal?.throwIfAborted();
    const release=this.cleanup.hold(key),abort=()=>release();signal?.addEventListener('abort',abort,{once:true});
    return {key,fid:file.drive?file.fid:'',release:()=>{signal?.removeEventListener('abort',abort);release();}};
  }
  rememberShare(key,value){
    this.shareSaves.delete(key);if(value)this.shareSaves.set(key,value);while(this.shareSaves.size>500)this.shareSaves.delete(this.shareSaves.keys().next().value);
    if(this.shareFile){fs.mkdirSync(path.dirname(this.shareFile),{recursive:true});fs.writeFileSync(this.shareFile+'.tmp',JSON.stringify(Object.fromEntries(this.shareSaves)),{mode:0o600});fs.renameSync(this.shareFile+'.tmp',this.shareFile);}
  }
  async saveShare(id,{consent=false,signal}={}){
    if(consent!==true)throw Object.assign(new Error('请先确认将所选文件保存到你的网盘'),{status:400});
    const file=decode(id);if(file.provider!=='quark'||file.drive||!file.share||!file.fid||!file.fileToken)throw Object.assign(new Error('此线路暂不支持保存播放'),{status:422});
    const key=await this.recordKey(file);await this.cleanup.waitForDeletion(key);if(this.shareSaving.has(key))return this.shareSaving.get(key);
    const work=this.saveSharedFile(file,signal,key);this.shareSaving.set(key,work);
    try{return await work;}finally{if(this.shareSaving.get(key)===work)this.shareSaving.delete(key);}
  }
  async saveSharedFile(file,signal,key,spaceRetried=false){
    const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000);
    bounded.throwIfAborted();
    try{
    let record=this.shareSaves.get(key);
    if(record?.fid)return this.resolveDrive({provider:file.provider,fid:record.fid},bounded);
    if(!record?.taskId){
      await this.accounts.check(file.provider,bounded);
      const destination=await this.cleanup.destination(bounded);
      const fresh=await this.freshSharedFile(file,bounded);bounded.throwIfAborted();
      const saved=await this.request(file.provider,'share/sharepage/save',{pwd_id:file.share,stoken:fresh.token,fid_list:[file.fid],fid_token_list:[fresh.fileToken],to_pdir_fid:destination.parent,scene:'link'},{},bounded);
      if(!saved.data?.task_id)throw new Error('网盘未返回保存任务，请在官方页面检查保存结果后重试');
      record={provider:file.provider,taskId:String(saved.data.task_id),...destination,name:String(file.name||''),size:Number(file.size)||0,createdAt:Date.now()};this.rememberShare(key,record);
    }
    for(let attempt=0;attempt<35;attempt++){
      let response;
      try{response=await this.request(file.provider,'task?'+new URLSearchParams({task_id:record.taskId,retry_index:String(attempt)}),undefined,{},bounded);}
      catch(error){if(error.remoteCode===32003||error.capacityLimited)this.rememberShare(key,null);throw error;}
      const task=response.data||{};
      if(Number(task.status)===3){this.rememberShare(key,null);throw new Error('夸克保存失败，请检查网盘空间、分享权限或官方限制');}
      if(Number(task.status)===2){
        const ids=task.save_as?.save_as_top_fids||task.save_as_top_fids;
        if(!Array.isArray(ids)||ids.length!==1)throw new Error('文件已保存，但未取得唯一文件编号，请从“我的网盘”选择文件播放');
        const {taskId,...info}=record;record={...info,provider:file.provider,fid:String(ids[0]),lastUsedAt:Date.now()};this.rememberShare(key,record);
        return this.resolveDrive({provider:file.provider,fid:record.fid},bounded);
      }
      await delay(750,undefined,{signal:bounded});
    }
    throw Object.assign(new Error('网盘保存仍在处理中，请稍后重试；不会重复提交同一保存任务'),{status:428});
    }catch(error){
      if(error.capacityLimited&&!spaceRetried&&this.cleanup.enabled('space')){
        this.rememberShare(key,null);
        let freed;try{freed=await this.cleanup.clean('space',{signal:bounded,targetBytes:Number(file.size)||Infinity});}catch(cleanupError){bounded.throwIfAborted();error.message+=' 自动清理未完成：'+cleanupError.message;}
        if(freed?.removed>0)return this.saveSharedFile(file,signal,key,true);
      }
      throw error;
    }
  }
  async headers(provider){const cookie=await this.accounts.cookie(provider,this.endpoints[provider]);return {'user-agent':UA,referer:loginUrls[provider],origin:new URL(loginUrls[provider]).origin,...(cookie?{cookie}:{})};}
  credentialOrigin(provider,url){
    const address=new URL(url),apiOrigin=new URL(this.endpoints[provider]).origin;
    if(address.origin===apiOrigin)return address.origin;
    // Quark's authenticated HLS origin rejects both playlists and segments
    // without its session cookie. Keep this exception limited to its HTTPS
    // video hosts; arbitrary URLs returned by an API remain untrusted.
    if(provider==='quark'&&address.protocol==='https:'&&!address.port&&/^(?:video-play(?:-[a-z0-9]+)*|dl-pc-[a-z0-9-]+)\.drive\.quark\.cn$/i.test(address.hostname))return address.origin;
    return '';
  }
  async mediaHeaders(provider,url){const headers=await this.headers(provider);if(!this.credentialOrigin(provider,url)){delete headers.cookie;delete headers.authorization;}return headers;}
  async mediaResult(provider,url,extra={}){const header=await this.mediaHeaders(provider,url);return {url,parse:0,header,...extra,credentialOrigin:header.cookie?new URL(url).origin:''};}
  async mediaChoices(provider,options){
    const unique=new Map();
    for(const option of (Array.isArray(options)?options:[]).slice(0,64)){
      if(!option||typeof option!=='object'||option.accessable===false)continue;
      const info=option.video_info||option;
      try{const url=webUrl(info.url||option.url,this.endpoints[provider]);if(!info.url&&!option.url)continue;
        const width=Number(info.width||option.width||option.template_width)||0,height=Number(info.height||option.height||option.template_height)||0;
        const resolution=height?(width?`${width} × ${height}`:`${height}p`):String(option.resolution||option.template_id||info.resolution||'默认').slice(0,80);
        const original=option.original===true,name=original?'原文件（原画）':option.preview===true?'预览 · '+resolution:resolution;
        if(unique.get(url)?.original&&!original)continue;
        unique.set(url,{url,name,original,type:String(option.type||'').slice(0,100),header:option.header,pixels:width*height||height});
      }catch{}
    }
    const values=[...unique.values()].sort((a,b)=>Number(b.original)-Number(a.original)||b.pixels-a.pixels).slice(0,32);
    if(!values.length)throw Object.assign(new Error('网盘未返回可播放画质，请确认文件权限或更换线路'),{status:428,verifyUrl:loginUrls[provider]});
    const credentialOrigins=[...new Set(values.map(value=>this.credentialOrigin(provider,value.url)).filter(Boolean))];
    const header=credentialOrigins.length?await this.headers(provider):await this.mediaHeaders(provider,values[0].url);
    return {url:{values:values.map(({name,url,type,header})=>({n:name,v:url,...(type?{type}:{}),...(header?{header}:{})})),position:0},parse:0,header,credentialOrigins};
  }
  async browserShare(file,signal){
    if(!this.browser?.run)throw new Error('分享播放接口不可用，请更换线路或使用已登录的官方浏览器');
    try{return await this.browser.run(file.url,{media:true,signal,selectText:file.name||'',folders:file.folders||[],timeout:25000});}
    catch(error){signal?.throwIfAborted();if(error.requiresSave)throw Object.assign(error,{saveFile:{name:file.name,size:Number(file.size)||0}});throw Object.assign(new Error('未取得'+({quark:'夸克',uc:'UC',ali:'阿里',baidu:'百度'}[file.provider]||'网盘')+'分享媒体，请在官方页面确认此文件是否可播放后重试'),{status:428,verifyUrl:file.url});}
  }
  async request(provider,path,body,extra={},signal,retried=false,beforeSend){
    const url=new URL(path,this.endpoints[provider]);
    if(provider==='quark'||provider==='uc'){url.searchParams.set('pr',provider==='quark'?'ucpro':'UCBrowser');url.searchParams.set('fr','pc');url.searchParams.set('uc_param_str','');}
    const headers={...await this.headers(provider),...extra};
    signal?.throwIfAborted();
    if(beforeSend&&beforeSend()!==true)throw Object.assign(new Error('文件已进入播放或保存，本次清理已跳过'),{status:409});
    try {
      const response=body===undefined?await resource(url.href,{headers,signal}):await postResource(url.href,body,{headers,signal});
      const result=json(response.text);
      if(result.status&&Number(result.status)>=400||result.code&&![0,200].includes(Number(result.code))||result.errno&&Number(result.errno)!==0||result.error){
        const message=String(result.message||result.msg||result.error_description||result.error||result.code||'网盘请求失败，请检查账号登录与分享密码');
        const capacityLimited=Number(result.code)===32003||/capacity.?limit|insufficient.?space|空间不足|容量不足/i.test(message);
        const expired=Number(result.status)===401||Number(result.errno)===-6||[31001,41001].includes(Number(result.code))||/AccessToken(?:Invalid|Expired)|InvalidAccessToken|not.?login|未登录|登录.*失效|token.*expired/i.test(message);
        throw Object.assign(new Error(capacityLimited?'网盘空间不足，无法保存这一集。请释放网盘空间后重试，或选择其他可用线路。':message),{status:expired?428:capacityLimited?409:502,remoteCode:Number(result.code)||0,capacityLimited});
      }
      // Quark/UC rotate this session cookie on normal API responses.
      const updates=(response.headers['set-cookie']||[]),values=Array.isArray(updates)?updates:[updates];
      if(['quark','uc'].includes(provider)&&headers.cookie&&values.length){
        const jar=new Map(String(headers.cookie).split(';').map(item=>{const at=item.indexOf('=');return [item.slice(0,at).trim(),item.slice(at+1).trim()];}).filter(([key])=>key));
        let changed=false;for(const value of values){const match=/^(__puus|__pus)=([^;]*)/.exec(value);if(match){jar.set(match[1],match[2]);changed=true;}}
        if(changed){const previous=this.accounts.get(provider);if(previous.cookie===headers.cookie)this.accounts.set(provider,{cookie:[...jar].map(([key,value])=>key+'='+value).join('; ')},{checkedAt:previous.checkedAt||0,valid:previous.valid===true,status:previous.status||'unchecked'});}
      }
      return result;
    } catch(error) {
      if(/HTTP 401/.test(error.message))error.status=428;
      if(provider==='ali'&&error.status===428&&extra.authorization&&!retried&&this.accounts.get('ali').refreshToken){const auth=await this.authorization(signal,true);return this.request(provider,path,body,{...extra,...auth},signal,true);}
      if(error.status===428)error.verifyUrl=loginUrls[provider];throw error;
    }
  }
  async authorization(signal,force=false){
    const account=this.accounts.get('ali');
    let expires=account.expiresAt||0;try{const jwt=json(Buffer.from(account.accessToken.split('.')[1],'base64url').toString());if(jwt.exp)expires=Number(jwt.exp)*1000;}catch{}
    if(!force&&account.accessToken&&(!account.refreshToken||expires>Date.now()+60000))return {authorization:'Bearer '+account.accessToken};
    if(!account.refreshToken)return {};
    if(this.refreshing)return this.refreshing;
    this.refreshing=(async()=>{
      let response;try{response=await postJson(new URL('/v2/account/token',this.endpoints.ali).href,{refresh_token:account.refreshToken,grant_type:'refresh_token'},{signal,headers:{'user-agent':UA}});}catch(error){if(/HTTP 400|HTTP 401/.test(error.message))throw Object.assign(new Error('阿里登录已过期，请重新登录并保存浏览器状态'),{status:428,verifyUrl:loginUrls.ali});throw error;}
      if(!response.access_token)throw Object.assign(new Error('阿里账号已过期，请重新登录'),{status:428,verifyUrl:loginUrls.ali});
      if(this.accounts.get('ali').refreshToken!==account.refreshToken)throw Object.assign(new Error('账号已切换，本次令牌刷新已取消'),{status:409});
      this.accounts.set('ali',{accessToken:response.access_token,refreshToken:response.refresh_token||account.refreshToken,expiresAt:Date.now()+Math.max(60,Number(response.expires_in)||3600)*1000});
      return {authorization:'Bearer '+response.access_token};
    })();try{return await this.refreshing;}finally{this.refreshing=null;}
  }
  async checkAccount(provider,credentials,signal){
    const candidate={...credentials};
    const scoped={get:p=>p===provider?{...candidate}:this.accounts.get(p),cookie:async p=>p===provider?candidate.cookie||'':this.accounts.cookie(p),set:(p,patch)=>{if(p===provider)Object.assign(candidate,patch);}};
    const cloud=new Cloud(scoped,this.browser,{endpoints:this.endpoints});
    if(provider==='bili'){
      if(!candidate.cookie)throw Object.assign(new Error('请先在 B站官方页面登录并保存浏览器登录状态'),{status:428});
      const result=await cloud.request('bili','/x/web-interface/nav',undefined,{},signal);if(result.data?.isLogin!==true)throw Object.assign(new Error('B站登录已失效，请重新登录并保存浏览器登录状态'),{status:428});
    }else if(provider==='ali'){
      const auth=await cloud.authorization(signal);if(!auth.authorization)throw Object.assign(new Error('未读取到阿里登录令牌，请在官方页面登录后重新同步'),{status:428});
      const user=await cloud.request(provider,'/v2/user/get',{},auth,signal);if(!user.user_id&&!user.default_drive_id)throw Object.assign(new Error('阿里账号未返回有效会话'),{status:428});
    }else{
      if(!candidate.cookie)throw Object.assign(new Error('没有读取到登录 Cookie，请先在官方页面完成登录'),{status:428});
      const path=provider==='baidu'?'/api/list?clienttype=0&app_id=250528&web=1&dir=%2F&num=1&page=1':'file/sort?pdir_fid=0&_page=1&_size=1&_fetch_total=1';
      const result=await cloud.request(provider,path,undefined,{},signal),list=provider==='baidu'?result.list:result.data?.list;
      if(!Array.isArray(list))throw Object.assign(new Error('未读取到有效网盘会话，请重新登录后同步'),{status:428});
    }
    return candidate;
  }
  async token(info,signal){
    if(info.provider==='quark'||info.provider==='uc'){
      const r=await this.request(info.provider,'share/sharepage/token',{pwd_id:info.share,passcode:info.password},{},signal);if(!r.data?.stoken)throw new Error('分享口令无效、过期或需要登录');return r.data.stoken;
    }
    if(info.provider==='ali'){
      const r=await this.request('ali','/v2/share_link/get_share_token',{share_id:info.share,share_pwd:info.password},{},signal);if(!r.share_token)throw new Error('阿里分享已失效或提取码有误');return r.share_token;
    }
  }
  async freshSharedFile(file,signal){
    if(file.parent==null){
      const detail=await this.detail(file.url,signal),matched=detail.lines.flatMap(line=>line.episodes).map(episode=>decode(episode.id)).find(item=>item.fid===file.fid);
      if(!matched)throw new Error('分享中的文件已变化，请重新读取线路');
      file={...file,parent:matched.parent};
    }
    const token=await this.token(file,signal);
    for(let page=1;page<=20;page++){
      const params=new URLSearchParams({pwd_id:file.share,stoken:token,pdir_fid:file.parent,_page:String(page),_size:'100',force:'0'});
      const response=await this.request(file.provider,'share/sharepage/detail?'+params,undefined,{},signal),items=response.data?.list||[];
      const selected=items.find(item=>String(item.fid)===String(file.fid));
      if(selected?.share_fid_token)return {token,fileToken:selected.share_fid_token};
      if(items.length<100)break;
    }
    throw new Error('未取得所选文件的有效分享凭据，请重新读取线路');
  }
  async detail(input,signal){
    if(String(input).startsWith('drive:'))return this.driveDetail(input,signal);
    const info=shareAddress(input);
    if(info.provider==='baidu')return this.baiduDetail(info,signal);
    const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000),token=await this.token(info,bounded),queue=[{id:info.provider==='ali'?'root':'0',name:'',folders:[],depth:0}],groups=new Map();let calls=0;
    while(queue.length&&calls<80){
      const folder=queue.shift();if(folder.depth>12)continue;let page=1,marker='';
      do{
        let items,more=false;
        if(info.provider==='ali'){
          const r=await this.request('ali','/adrive/v2/file/list_by_share',{share_id:info.share,parent_file_id:folder.id,limit:100,order_by:'name',order_direction:'ASC',marker},{'x-share-token':token},bounded);items=r.items||r.data?.items||[];marker=r.next_marker||'';more=Boolean(marker);
        }else{
          const params=new URLSearchParams({pwd_id:info.share,stoken:token,pdir_fid:folder.id,force:'0',_page:String(page),_size:'100',_fetch_total:'1',_sort:'file_type:asc,file_name:asc'});
          const r=await this.request(info.provider,'share/sharepage/detail?'+params,undefined,{},bounded);items=r.data?.list||[];more=items.length===100&&page*100<Number(r.metadata?._total||r.data?.metadata?._total||10000);
        }
        calls++;for(const file of items){
          const name=file.file_name||file.name||'文件',id=String(file.fid||file.file_id||'');
          if(file.dir===true||file.file_type===0||file.type==='folder'){if(queue.length<1000)queue.push({id,name:(folder.name?folder.name+'/':'')+name,folders:[...folder.folders,name],depth:folder.depth+1});continue;}
          if(!video.test(name)&&file.category!=='video'&&file.category!==1)continue;
          const groupName=folder.name||'视频';if(!groups.has(groupName))groups.set(groupName,[]);
          if([...groups.values()].reduce((sum,v)=>sum+v.length,0)<2000)groups.get(groupName).push({name,id:encode({...info,fid:id,fileToken:file.share_fid_token||'',name,parent:folder.id,folders:folder.folders,size:Number(file.size)||0})});
        }
        page++;if(!more||calls>=80)break;
      }while(true);
    }
    if(!groups.size)throw new Error('分享中没有可播放音视频，或当前账号没有访问权限');
    const lines=[...groups].map(([name,episodes])=>({name,provider:info.provider,episodes:episodes.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}))}));
    return {vod_id:input,vod_name:info.provider.toUpperCase()+' 分享',vod_content:queue.length?'分享目录较多，本次仅列出已读取的媒体文件。':'网盘分享文件',lines};
  }
  async resolve(id,signal){
    const file=decode(id),provider=file.provider;
    if(file.drive)return this.resolveDrive(file,signal);
    const savedKey=await this.recordKey(file),saved=this.shareSaves.get(savedKey);
    if(saved?.fid){try{const result=await this.resolveDrive({provider,fid:saved.fid},signal);this.rememberShare(savedKey,{...saved,lastUsedAt:Date.now()});return result;}catch(error){signal?.throwIfAborted();if(error.status===428||!(/HTTP (403|404)|not.?found|不存在/i.test(error.message)))throw error;this.rememberShare(savedKey,null);}}
    if(provider==='baidu'){
      if(file.dlink)return this.mediaResult(provider,file.dlink);
      return this.browserShare(file,signal);
    }
    const fresh=['quark','uc'].includes(provider)?await this.freshSharedFile(file,signal):null,token=fresh?.token||await this.token(file,signal);
    if(provider==='ali'){
      const auth=await this.authorization(signal),r=await this.request('ali','/v2/file/get_share_link_video_preview_play_info',{share_id:file.share,file_id:file.fid,category:'live_transcoding',template_id:'',get_preview_url:true},{...auth,'x-share-token':token},signal);
      const tasks=r.video_preview_play_info?.live_transcoding_task_list||r.live_transcoding_task_list||[];
      return this.mediaChoices('ali',tasks);
    }
    let r;try{r=await this.request(provider,'share/sharepage/video',{pwd_id:file.share,stoken:token,fid:file.fid,share_fid_token:fresh.fileToken,resolutions:'normal,low,high,super,2k,4k',supports:'fmp4'},{},signal);}
    catch(error){if(/HTTP (404|405|410)\b/.test(error.message)&&this.browser?.run)return this.browserShare(file,signal);throw error;}
    return this.mediaChoices(provider,r.data?.video_list||r.data?.list||[]);
  }
  async baiduDetail(info,signal){
    const headers=await this.headers('baidu'),response=await resource(info.url,{headers,signal});
    let data=extract(response.text,/(?:locals\.mset\(|(?:var\s+)?yunData\s*=|window\.yunData\s*=)/);
    if(!Array.isArray(data?.file_list?.list||data?.file_list||data?.list)){
      if(!headers.cookie||!this.browser?.run)throw Object.assign(new Error('百度分享需要登录或提取码验证，请在官方页面完成后重新读取线路'),{status:428,verifyUrl:info.url});
      const r=await this.browser.run(info.url,{signal});data=extract(r.text,/(?:locals\.mset\(|(?:var\s+)?yunData\s*=|window\.yunData\s*=)/);
    }
    const list=data?.file_list?.list||data?.file_list||data?.list||[];
    const files=Array.isArray(list)?list.filter(f=>!f.isdir&&video.test(f.server_filename||f.filename||'')):[];
    if(!files.length)throw Object.assign(new Error('请在独立站点浏览器打开此百度分享，输入提取码或登录后重试'),{status:428,verifyUrl:info.url});
    return {vod_id:info.url,vod_name:data.share_name||'百度分享',lines:[{name:'百度',provider:'baidu',episodes:files.map(f=>({name:f.server_filename||f.filename,id:encode({...info,fid:String(f.fs_id),name:f.server_filename||f.filename,dlink:f.dlink||''})}))}]};
  }
  async driveList(provider,parent='0',page=1,signal){
    if(!apiBases[provider])return {class:Object.keys(apiBases).map(type_id=>({type_id,type_name:{quark:'夸克',uc:'UC',ali:'阿里',baidu:'百度'}[type_id]})),list:[],notice:'先登录网盘账号，再选择要浏览的网盘。',page:1,pagecount:1};
    let items=[],total=0,driveId='';
    if(provider==='quark'||provider==='uc'){
      const params=new URLSearchParams({pdir_fid:parent,_page:String(page),_size:'50',_fetch_total:'1',_fetch_sub_dirs:'0',_sort:'file_type:asc,file_name:asc'}),r=await this.request(provider,'file/sort?'+params,undefined,{},signal);items=r.data?.list||[];total=r.metadata?._total||0;
    }else if(provider==='ali'){
      const auth=await this.authorization(signal);if(!auth.authorization)throw new Error('请先设置阿里访问 Token 或 Refresh Token');
      const account=await this.request('ali','/v2/user/get',{},auth,signal);driveId=account.default_drive_id;
      const r=await this.request('ali','/adrive/v3/file/list',{drive_id:driveId,parent_file_id:parent==='0'?'root':parent,limit:100,order_by:'name',order_direction:'ASC'},auth,signal);items=r.items||[];
    }else{
      const params=new URLSearchParams({clienttype:'0',app_id:'250528',web:'1',dir:parent==='0'?'/':parent,order:'name',desc:'0',num:'100',page:String(page)}),r=await this.request('baidu','/api/list?'+params,undefined,{},signal);items=r.list||[];total=items.length===100?Number(page)*100+1:items.length;
    }
    return {list:items.filter(f=>f.dir||f.isdir||f.type==='folder'||f.file_type===0||video.test(f.file_name||f.name||f.server_filename||'')).map(f=>{const folder=Boolean(f.dir||f.isdir||f.type==='folder'||f.file_type===0),id=String(f.fid||f.file_id||f.path||f.fs_id);return {vod_id:'drive:'+provider+':'+Buffer.from(JSON.stringify({fid:id,name:f.file_name||f.name||f.server_filename,folder,drive:true,driveId:f.drive_id||driveId})).toString('base64url'),vod_name:f.file_name||f.name||f.server_filename,folder};}),page,pagecount:Math.max(Number(page),Math.ceil(total/(provider==='baidu'?100:50))),total};
  }
  async driveDetail(id){const [,provider,encoded]=id.split(':'),file=json(Buffer.from(encoded,'base64url').toString());return {vod_id:id,vod_name:file.name,folder:file.folder,lines:file.folder?[]:[{name:'原文件',provider,episodes:[{name:file.name,id:encode({...file,provider})}]}]};}
  async quarkDriveMedia(file,signal){
    const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(12000)]):AbortSignal.timeout(12000);
    const [original,preview]=await Promise.allSettled([
      this.request('quark','file/download?sys=win32&ve=2.5.56&ut=&guid=',{fids:[String(file.fid)]},{'user-agent':QUARK_DESKTOP_UA},bounded),
      this.request('quark','file/v2/play',{fid:file.fid,resolutions:'normal,low,high,super,2k,4k',supports:'fmp4'},{},bounded),
    ]);
    signal?.throwIfAborted();
    const options=[];
    if(original.status==='fulfilled'){
      const rows=Array.isArray(original.value.data)?original.value.data:original.value.data?.list||[];
      const entry=rows.find(item=>String(item.fid)===String(file.fid))||(rows.length===1&&rows[0].fid==null?rows[0]:null);
      if(entry?.download_url){
        const name=String(entry.file_name||file.name||''),extension=/\.([a-z0-9]+)$/i.exec(name)?.[1]||'';
        options.push({url:entry.download_url,original:true,type:entry.format_type||extension,header:{'user-agent':QUARK_DESKTOP_UA}});
      }
    }
    if(preview.status==='fulfilled'){
      const rows=preview.value.data?.video_list||preview.value.data?.list||[];
      if(Array.isArray(rows))options.push(...rows.slice(0,64).map(row=>({...row,preview:true})));
    }
    if(!options.length){
      if(original.status==='rejected')throw original.reason;
      if(preview.status==='rejected')throw preview.reason;
    }
    return this.mediaChoices('quark',options);
  }
  async resolveDrive(file,signal){
    if(file.provider==='quark')return this.quarkDriveMedia(file,signal);
    if(file.provider==='uc'){
      const r=await this.request(file.provider,'file/v2/play',{fid:file.fid,resolutions:'normal,low,high,super,2k,4k',supports:'fmp4'},{},signal);return this.mediaChoices(file.provider,r.data?.video_list||r.data?.list||[]);
    }
    if(file.provider==='ali'){
      const auth=await this.authorization(signal),r=await this.request('ali','/v2/file/get_video_preview_play_info',{drive_id:file.driveId,file_id:file.fid,category:'live_transcoding',template_id:'',get_preview_url:true},auth,signal),tasks=r.video_preview_play_info?.live_transcoding_task_list||r.live_transcoding_task_list||[];return this.mediaChoices('ali',tasks);
    }
    const params=new URLSearchParams({app_id:'250528',clienttype:'0',type:'M3U8_AUTO_480',path:file.fid});
    return this.mediaResult('baidu',new URL('/api/streaming?'+params,this.endpoints.baidu).href,{type:'hls'});
  }
}
module.exports={Cloud,shareAddress,encode,decode,apiBases};
