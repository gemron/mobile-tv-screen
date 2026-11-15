const cheerio=require('cheerio');
const {resource,postJson}=require('./http');
const {webUrl,json}=require('./format');
const {extract}=require('./literals');
const {loginUrls}=require('./accounts');
const UA='Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
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
  constructor(accounts,browser,{endpoints={}}={}){this.accounts=accounts;this.browser=browser;this.endpoints={...apiBases,...endpoints};}
  async headers(provider){const cookie=await this.accounts.cookie(provider,this.endpoints[provider]);return {'user-agent':UA,referer:loginUrls[provider],origin:new URL(loginUrls[provider]).origin,...(cookie?{cookie}:{})};}
  async mediaHeaders(provider,url){const headers=await this.headers(provider);if(new URL(url).origin!==new URL(this.endpoints[provider]).origin){delete headers.cookie;delete headers.authorization;}return headers;}
  async request(provider,path,body,extra={},signal){
    const url=new URL(path,this.endpoints[provider]);
    if(provider==='quark'||provider==='uc'){url.searchParams.set('pr',provider==='quark'?'ucpro':'UCBrowser');url.searchParams.set('fr','pc');url.searchParams.set('uc_param_str','');}
    const headers={...await this.headers(provider),...extra};
    let result;
    if(body===undefined)result=json((await resource(url.href,{headers,signal})).text);else result=await postJson(url.href,body,{headers,signal});
    if(result.status&&Number(result.status)>=400||result.code&&![0,200].includes(Number(result.code))||result.errno&&Number(result.errno)!==0)throw Object.assign(new Error(result.message||result.msg||result.code||'网盘请求失败，请检查账号登录与分享密码'),{status:result.status===401?428:502});
    if(result.error)throw new Error(result.message||result.error_description||result.error);
    return result;
  }
  async authorization(signal){
    const account=this.accounts.get('ali');
    let expires=account.expiresAt||0;try{const jwt=json(Buffer.from(account.accessToken.split('.')[1],'base64url').toString());if(jwt.exp)expires=Number(jwt.exp)*1000;}catch{}
    if(account.accessToken&&(!account.refreshToken||expires>Date.now()+60000))return {authorization:'Bearer '+account.accessToken};
    if(!account.refreshToken)return {};
    const response=await postJson(new URL('/v2/account/token',this.endpoints.ali).href,{refresh_token:account.refreshToken,grant_type:'refresh_token'},{signal,headers:{'user-agent':UA}});
    if(!response.access_token)throw new Error(response.message||'阿里账号已过期，请重新登录');
    this.accounts.set('ali',{accessToken:response.access_token,refreshToken:response.refresh_token||account.refreshToken,expiresAt:Date.now()+Math.max(60,Number(response.expires_in)||3600)*1000});
    return {authorization:'Bearer '+response.access_token};
  }
  async token(info,signal){
    if(info.provider==='quark'||info.provider==='uc'){
      const r=await this.request(info.provider,'share/sharepage/token',{pwd_id:info.share,passcode:info.password},{},signal);if(!r.data?.stoken)throw new Error('分享口令无效、过期或需要登录');return r.data.stoken;
    }
    if(info.provider==='ali'){
      const r=await this.request('ali','/v2/share_link/get_share_token',{share_id:info.share,share_pwd:info.password},{},signal);if(!r.share_token)throw new Error('阿里分享已失效或提取码有误');return r.share_token;
    }
  }
  async detail(input,signal){
    if(String(input).startsWith('drive:'))return this.driveDetail(input,signal);
    const info=shareAddress(input);
    if(info.provider==='baidu')return this.baiduDetail(info,signal);
    const bounded=signal?AbortSignal.any([signal,AbortSignal.timeout(45000)]):AbortSignal.timeout(45000),token=await this.token(info,bounded),queue=[{id:info.provider==='ali'?'root':'0',name:'',depth:0}],groups=new Map();let calls=0;
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
          if(file.dir===true||file.file_type===0||file.type==='folder'){if(queue.length<1000)queue.push({id,name:(folder.name?folder.name+'/':'')+name,depth:folder.depth+1});continue;}
          if(!video.test(name)&&file.category!=='video'&&file.category!==1)continue;
          const groupName=folder.name||'视频';if(!groups.has(groupName))groups.set(groupName,[]);
          if([...groups.values()].reduce((sum,v)=>sum+v.length,0)<2000)groups.get(groupName).push({name,id:encode({...info,fid:id,fileToken:file.share_fid_token||'',name})});
        }
        page++;if(!more||calls>=80)break;
      }while(true);
    }
    if(!groups.size)throw new Error('分享中没有可播放音视频，或当前账号没有访问权限');
    const lines=[...groups].map(([name,episodes])=>({name,episodes:episodes.sort((a,b)=>a.name.localeCompare(b.name,'zh-CN',{numeric:true}))}));
    return {vod_id:input,vod_name:info.provider.toUpperCase()+' 分享',vod_content:queue.length?'分享目录较多，本次仅列出已读取的媒体文件。':'网盘分享文件',lines};
  }
  async resolve(id,signal){
    const file=decode(id),provider=file.provider;
    if(file.drive)return this.resolveDrive(file,signal);
    if(provider==='baidu'){
      if(file.dlink)return {url:file.dlink,parse:0,header:await this.mediaHeaders(provider,file.dlink)};
      return this.browser.run(file.url,{media:true,signal,selectText:file.name});
    }
    const token=await this.token(file,signal);
    if(provider==='ali'){
      const auth=await this.authorization(signal),r=await this.request('ali','/v2/file/get_share_link_video_preview_play_info',{share_id:file.share,file_id:file.fid,category:'live_transcoding',template_id:'',get_preview_url:true},{...auth,'x-share-token':token},signal);
      const tasks=r.video_preview_play_info?.live_transcoding_task_list||r.live_transcoding_task_list||[],chosen=tasks.filter(v=>v.url).sort((a,b)=>(Number(b.template_width)||0)*(Number(b.template_height)||0)-(Number(a.template_width)||0)*(Number(a.template_height)||0))[0];
      if(!chosen)throw new Error('阿里未返回可播放画质，请登录并确认此文件的观看权限');return {url:chosen.url,parse:0,type:'hls',header:await this.mediaHeaders('ali',chosen.url)};
    }
    const r=await this.request(provider,'share/sharepage/video',{pwd_id:file.share,stoken:token,fid:file.fid,share_fid_token:file.fileToken,resolutions:'normal,low,high,super,2k,4k',supports:'fmp4'},{},signal);
    const options=r.data?.video_list||r.data?.list||[],chosen=options.filter(v=>v.video_info?.url||v.url).sort((a,b)=>(b.video_info?.width||b.width||0)*(b.video_info?.height||b.height||0)-(a.video_info?.width||a.width||0)*(a.video_info?.height||a.height||0))[0];
    if(!chosen)throw Object.assign(new Error('网盘未返回可播放地址，请在网盘账号中登录并确认分享权限'),{status:428});
    const url=chosen.video_info?.url||chosen.url;return {url,parse:0,type:'hls',header:await this.mediaHeaders(provider,url)};
  }
  async baiduDetail(info,signal){
    const response=await resource(info.url,{headers:await this.headers('baidu'),signal});
    let data=extract(response.text,/(?:locals\.mset\(|(?:var\s+)?yunData\s*=|window\.yunData\s*=)/);
    if(!data?.file_list&&!data?.file_list?.list){const r=await this.browser.run(info.url,{signal});data=extract(r.text,/(?:locals\.mset\(|(?:var\s+)?yunData\s*=|window\.yunData\s*=)/);}
    const list=data?.file_list?.list||data?.file_list||data?.list||[];
    const files=Array.isArray(list)?list.filter(f=>!f.isdir&&video.test(f.server_filename||f.filename||'')):[];
    if(!files.length)throw Object.assign(new Error('请在独立站点浏览器打开此百度分享，输入提取码或登录后重试'),{status:428,verifyUrl:info.url});
    return {vod_id:info.url,vod_name:data.share_name||'百度分享',lines:[{name:'百度',episodes:files.map(f=>({name:f.server_filename||f.filename,id:encode({...info,fid:String(f.fs_id),name:f.server_filename||f.filename,dlink:f.dlink||''})}))}]};
  }
  async driveList(provider,parent='0',page=1,signal){
    if(!apiBases[provider])return {class:Object.entries(loginUrls).map(([type_id])=>({type_id,type_name:{quark:'夸克',uc:'UC',ali:'阿里',baidu:'百度'}[type_id]})),list:[],notice:'先登录网盘账号，再选择要浏览的网盘。',page:1,pagecount:1};
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
  async driveDetail(id){const [,provider,encoded]=id.split(':'),file=json(Buffer.from(encoded,'base64url').toString());return {vod_id:id,vod_name:file.name,folder:file.folder,lines:file.folder?[]:[{name:'原文件',episodes:[{name:file.name,id:encode({...file,provider})}]}]};}
  async resolveDrive(file,signal){
    if(file.provider==='quark'||file.provider==='uc'){
      const r=await this.request(file.provider,'file/v2/play',{fid:file.fid,resolutions:'normal,low,high,super,2k,4k',supports:'fmp4'},{},signal),options=r.data?.video_list||r.data?.list||[],chosen=options.filter(v=>v.video_info?.url||v.url).at(-1);
      if(!chosen)throw new Error('当前网盘账号无法播放此文件');const url=chosen.video_info?.url||chosen.url;return {url,parse:0,type:'hls',header:await this.mediaHeaders(file.provider,url)};
    }
    if(file.provider==='ali'){
      const auth=await this.authorization(signal),r=await this.request('ali','/v2/file/get_video_preview_play_info',{drive_id:file.driveId,file_id:file.fid,category:'live_transcoding',template_id:'',get_preview_url:true},auth,signal),tasks=r.video_preview_play_info?.live_transcoding_task_list||r.live_transcoding_task_list||[],url=tasks.filter(t=>t.url).at(-1)?.url;if(!url)throw new Error('阿里账号无法播放此文件');return {url,parse:0,type:'hls',header:await this.mediaHeaders('ali',url)};
    }
    const params=new URLSearchParams({app_id:'250528',clienttype:'0',type:'M3U8_AUTO_480',path:file.fid});
    return {url:new URL('/api/streaming?'+params,this.endpoints.baidu).href,parse:0,type:'hls',header:await this.headers('baidu')};
  }
}
module.exports={Cloud,shareAddress,encode,decode,apiBases};
