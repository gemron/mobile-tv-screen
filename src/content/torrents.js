const fs=require('fs');const path=require('path');const {randomBytes}=require('crypto');
const {pipeline}=require('stream');
const {resource}=require('./http');
const media=/\.(mp4|mkv|webm|m4v|mov|avi|ts|mp3|flac|m4a|aac)$/i;
class Torrents{
  constructor(directory,{maxBytes=2*1024*1024*1024,clientOptions={}}={}){this.root=path.resolve(directory,'torrent-cache');this.maxBytes=maxBytes;this.options=clientOptions;this.active=null;this.loading=null;this.closed=false;}
  async load(identifier,signal){
    if(this.closed)throw new Error('磁力播放服务已关闭');
    if(this.active?.identifier===identifier)return this.active;
    if(this.loading)return this.loading.then(()=>this.load(identifier,signal));
    this.loading=this.open(identifier,signal);try{return await this.loading;}finally{this.loading=null;}
  }
  async open(identifier,signal){
    if(!/^(?:magnet:\?|https?:\/\/)/i.test(identifier))throw new Error('只接受磁力或 HTTP 种子文件地址');
    await this.stop();
    let bytes=identifier;if(/^https?:/i.test(identifier))bytes=new Uint8Array((await resource(identifier,{signal,limit:8*1024*1024})).body);
    const [{default:WebTorrent},{default:Storage}]=await Promise.all([import('webtorrent'),import('fs-chunk-store')]);
    fs.mkdirSync(this.root,{recursive:true});const directory=fs.mkdtempSync(path.join(this.root,'session-'));
    const limit=this.maxBytes;
    class BoundedStore extends Storage{
      constructor(chunkLength,options){
        if(chunkLength>16*1024*1024||options.files.length>2000)throw new Error('种子分片或文件数超过限制');
        // Keep provider-controlled names out of operating-system paths.
        const files=options.files.map((f,index)=>({path:'file-'+index+'.bin',length:f.length,offset:f.offset}));
        super(chunkLength,{...options,path:directory,files,addUID:false});this.written=new Set();this.bytes=0;
      }
      put(index,buffer,callback){if(!this.written.has(index)){if(this.bytes+buffer.length>limit){callback(new Error('磁力缓存达到 2 GiB 上限，请停止后选择较小文件'));return;}this.written.add(index);this.bytes+=buffer.length;}super.put(index,buffer,callback);}
    }
    const client=new WebTorrent({maxConns:32,utp:false,lsd:false,natUpnp:false,natPmp:false,uploadLimit:256*1024,...this.options});client.on('error',()=>{});
    const active=this.active={identifier,directory,client,id:randomBytes(16).toString('hex'),torrent:null,selected:-1};
    try{
      const torrent=await new Promise((resolve,reject)=>{
        const timer=setTimeout(()=>reject(new Error('未取得种子信息，可能没有在线做种者；请换一个磁力来源')),45000);
        active.cancel=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(new Error('磁力读取已取消'));};
        const abort=()=>{clearTimeout(timer);reject(signal.reason||new Error('磁力读取已取消'));};signal?.addEventListener('abort',abort,{once:true});
        const t=client.add(bytes,{path:directory,store:BoundedStore,deselect:true,storeCacheSlots:8,strategy:'sequential'},torrent=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);resolve(torrent);});
        t.on('error',error=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(error);});active.torrent=t;
      });
      if(this.closed||this.active!==active||signal?.aborted)throw new Error('磁力读取已被新的操作替代');active.cancel=null;active.torrent=torrent;return active;
    }catch(error){if(this.active===active)await this.stop();throw error;}
  }
  async detail(identifier,signal){
    const active=await this.load(identifier,signal),files=active.torrent.files.map((f,index)=>({name:f.name,index,length:f.length})).filter(f=>media.test(f.name));
    if(!files.length)throw new Error('种子中没有可播放音视频文件');
    return {vod_id:identifier,vod_name:active.torrent.name, vod_content:'磁力边下边播会连接 P2P 网络，临时缓存上限为 2 GiB。可拖动进度；速度取决于在线做种者。',lines:[{name:'种子文件',episodes:files.map(f=>({name:f.name+' · '+Math.round(f.length/1024/1024)+' MiB',id:'torrent:'+Buffer.from(JSON.stringify({identifier,index:f.index})).toString('base64url')}))}]};
  }
  async resolve(id,signal){
    const entry=JSON.parse(Buffer.from(id.slice(8),'base64url').toString());let active=await this.load(entry.identifier,signal);
    if(active.selected>=0&&active.selected!==entry.index){await this.stop();active=await this.load(entry.identifier,signal);}
    const file=active.torrent.files[Number(entry.index)];if(!file||!media.test(file.name))throw new Error('种子媒体文件不存在');
    if(file.length>this.maxBytes)throw new Error('此文件超过磁力缓存 2 GiB 上限，请选择较小版本');
    const free=fs.statfsSync(this.root);if(free.bavail*free.bsize<Math.min(file.length,512*1024*1024)+256*1024*1024)throw new Error('磁力缓存磁盘剩余空间不足');
    active.selected=Number(entry.index);file.select();
    return {url:`/api/library/torrent/${active.id}/${entry.index}/stream${path.extname(file.name).toLowerCase()}`,localUrl:true,parse:0,header:{}};
  }
  serve(req,res){
    const active=this.active,file=active?.id===req.params.id?active.torrent?.files[Number(req.params.index)]:null;
    if(!file||active.selected!==Number(req.params.index)){res.status(410).end('磁力播放已结束，请重新选择文件');return;}
    let start=0,end=file.length-1;const range=req.headers.range;
    if(range){const match=/^bytes=(\d*)-(\d*)$/.exec(range);if(!match){res.status(416).set('Content-Range','bytes */'+file.length).end();return;}if(!match[1]){const n=Number(match[2]);start=Math.max(0,file.length-n);}else{start=Number(match[1]);if(match[2])end=Math.min(end,Number(match[2]));}if(start>end||start>=file.length){res.status(416).set('Content-Range','bytes */'+file.length).end();return;}}
    const ext=path.extname(file.name).toLowerCase(),mime={'.mp4':'video/mp4','.m4v':'video/mp4','.mkv':'video/x-matroska','.webm':'video/webm','.mp3':'audio/mpeg','.m4a':'audio/mp4','.ts':'video/mp2t'}[ext]||'application/octet-stream';
    res.status(range?206:200).set({'Content-Type':mime,'Content-Length':String(end-start+1),'Accept-Ranges':'bytes','Cache-Control':'no-store',...(range?{'Content-Range':`bytes ${start}-${end}/${file.length}`}:{})});if(req.method==='HEAD'){res.end();return;}
    const stream=file.createReadStream({start,end});res.once('close',()=>stream.destroy());pipeline(stream,res,()=>{});
  }
  status(){const a=this.active,t=a?.torrent;return {active:Boolean(t),name:t?.name||'',peers:t?.numPeers||0,downloaded:t?.downloaded||0,speed:t?.downloadSpeed||0,maxBytes:this.maxBytes};}
  async stop(){const active=this.active;this.active=null;if(!active)return;active.cancel?.();await new Promise(resolve=>{const timer=setTimeout(resolve,5000);active.client.destroy(()=>{clearTimeout(timer);resolve();});});const target=path.resolve(active.directory);if(path.dirname(target)!==this.root||!path.basename(target).startsWith('session-'))throw new Error('拒绝清理非磁力临时目录');try{fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:100});}catch(error){if(!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code))throw error;}}
  async close(){this.closed=true;await this.stop();}
}
module.exports={Torrents};
