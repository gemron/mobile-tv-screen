// Read-only media checks. HTTP success and sampled bytes are deliberately
// reported separately from decoding frames in an actual player.
const fs=require('fs');const os=require('os');const path=require('path');
const {openUpstreamStream,resolveUpstreamHeaders}=require('../src/services/proxy');
const {resource}=require('../src/content/http');
const {Library}=require('../src/content/library');const catalog=require('../src/content/catalog');
function scopedHeaders(headers,origin,address){const copy={...headers};if(new URL(address).origin!==origin){delete copy.cookie;delete copy.authorization;}return copy;}
async function sample(url,headers,signal,withRange=true){
  const deadline=signal?AbortSignal.any([signal,AbortSignal.timeout(6000)]):AbortSignal.timeout(6000);
  const {upRes,finalUrl}=await openUpstreamStream(url,{...headers,...(withRange?{range:'bytes=0-65535'}:{}),'accept-encoding':'identity'},3,deadline);
  if(withRange&&[403,416].includes(upRes.statusCode)){upRes.destroy();return sample(url,headers,signal,false);}
  try{if(upRes.statusCode<200||upRes.statusCode>=300)throw new Error('媒体请求返回 HTTP '+upRes.statusCode);const chunks=[];let length=0;for await(const chunk of upRes){const bytes=chunk.subarray(0,65536-length);chunks.push(bytes);length+=bytes.length;if(length>=65536)break;}return {body:Buffer.concat(chunks),url:finalUrl,type:String(upRes.headers['content-type']||'')};}finally{upRes.destroy();}
}
async function probeMedia(resolved,signal){
  if(!/^https?:/i.test(resolved.url))return {sampled:false,reason:'本地代理/P2P 入口需要播放器验证'};
  let url=resolved.url;const origin=new URL(url).origin,headers=resolved.headers||{};
  const effective=address=>({...Object.fromEntries(Object.entries(resolveUpstreamHeaders(Object.keys(headers).length?'':address)).map(([key,value])=>[key.toLowerCase(),value])),...scopedHeaders(headers,origin,address)});
  for(let depth=0;depth<4;depth++){
    const data=await sample(url,effective(url),signal),text=data.body.toString('utf8').replace(/^\uFEFF/,'').trimStart();
    if(/^<!doctype|^<html/i.test(text))throw new Error('媒体地址实际返回网页');
    if(text.startsWith('#EXTM3U')){
      let playlist=text;if(data.body.length>=65536)playlist=(await resource(data.url,{headers:effective(data.url),signal,limit:4*1024*1024,timeout:6000})).text;
      const lines=playlist.replace(/\r/g,'').split('\n').map(s=>s.trim()),entries=lines.filter(s=>s&&!s.startsWith('#'));
      if(!entries.length)throw new Error('HLS 清单没有媒体分片或子清单');
      if(lines.some(s=>s.startsWith('#EXT-X-STREAM-INF:'))){url=new URL(entries[0],data.url).href;continue;}
      if(!lines.some(s=>s.startsWith('#EXTINF:')))throw new Error('HLS 正文缺少有效分片信息');
      const key=lines.find(s=>s.startsWith('#EXT-X-KEY:')&&/METHOD=AES-128/.test(s)),keyUri=key&&/URI="([^"]+)"/.exec(key)?.[1];
      if(keyUri){const keyUrl=new URL(keyUri,data.url).href,keyData=await sample(keyUrl,effective(keyUrl),signal);if(keyData.body.length!==16)throw new Error('AES-128 密钥不是 16 字节');}
      const segmentUrl=new URL(entries[0],data.url).href,segment=await sample(segmentUrl,effective(segmentUrl),signal);
      if(!segment.body.length||/^<!doctype|^<html/i.test(segment.body.toString('utf8',0,128).trimStart()))throw new Error('HLS 分片为空或实际返回网页');
      if(/json/i.test(segment.type)&&/^[\[{]/.test(segment.body.toString('utf8',0,128).trimStart()))throw new Error('HLS 分片实际返回 JSON 错误信息');
      if(!keyUri&&/^image\//.test(segment.type))return {sampled:false,kind:'nonstandard',bytes:segment.body.length,reason:'分片被标为图片，需要专用处理及播放器验证',decoded:false};
      return {sampled:true,kind:'hls',bytes:segment.body.length,encrypted:Boolean(keyUri),decoded:false};
    }
    if(/mpegurl/i.test(resolved.mimeType||data.type))throw new Error('声明为 HLS 的地址未返回 M3U8 正文');
    if(!data.body.length)throw new Error('媒体响应为空');
    if(/json/i.test(data.type)&&/^[\[{]/.test(text))throw new Error('媒体地址实际返回 JSON 接口数据');
    if(/^image\//.test(data.type))return {sampled:false,kind:'nonstandard',bytes:data.body.length,reason:'返回图片类型，需要播放器进一步验证',decoded:false};
    if(resolved.audioUrl)await sample(resolved.audioUrl,effective(resolved.audioUrl),signal);
    return {sampled:true,kind:/audio\//.test(data.type)?'audio':'media',bytes:data.body.length,decoded:false};
  }
  throw new Error('HLS 子清单层级超过检查上限');
}
async function main(){
  const args=process.argv.slice(2),arg=key=>{const index=args.indexOf(key);return index<0?'':args[index+1]||'';},url=arg('--url');
  if(!url)throw new Error('Usage: node scripts/check-sources.js --url <configuration URL> [--site <key>] [--json <report path>]');
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV source check ')),library=new Library({dataDir:directory});
  const report={checkedAt:new Date().toISOString(),decoded:false,sites:[]};let cursor=0;
  try{
    await library.import(url);const sites=library.sites.filter(site=>!arg('--site')||site.key===arg('--site'));if(!sites.length)throw new Error('No matching site');
    async function worker(){while(cursor<sites.length){const site=sites[cursor++],row={key:site.key,name:site.name,stage:'unsupported',supported:site.supported};report.sites.push(row);
      if(!site.supported){row.error=site.reason;continue;}
      const signal=AbortSignal.timeout(22000);
      try{row.stage='home';let home=await catalog.home(site,signal);if(!home.list.length&&arg('--keyword')){row.stage='search';home=await catalog.category(site,{keyword:arg('--keyword'),page:1},signal);}else if(!home.list.length&&home.classes.length&&!site.adapter?.startsWith('cloud-'))home=await catalog.category(site,{id:home.classes[0].id,page:1},signal);row.list=home.list.length;
        if(!home.list.length){row.stage='input-required';row.notice=home.notice||'需要选择分类、关键词或登录账号';continue;}
        if(site.adapter==='discovery-Sssp'){row.stage='catalog-only';row.notice='随机短视频仅检查分类，不抽取实际内容';continue;}
        row.stage='detail';const detail=await catalog.detail(site,home.list[0].id,signal);row.lines=detail.lines.length;row.episodes=detail.lines[0]?.episodes.length||0;
        if(!row.episodes){row.stage='catalog-only';row.notice=detail.searchTitle?'片单需要跨源搜索':'未返回剧集';continue;}
        if(site.adapter==='extra-SixV'){row.stage='magnet-list';row.notice='真实磁力未自动下载';continue;}
        row.stage='resolve';const resolved=await catalog.resolve(site,detail.lines[0],detail.lines[0].episodes[0],library.parsers,'',signal);row.resolved=true;
        row.stage='media';row.probe=await probeMedia(resolved,signal);row.stage=row.probe.sampled?'media-sampled':'player-required';
      }catch(error){row.error=String(error.message).replace(/https?:\/\/\S+/g,'[URL]').slice(0,240);row.loginRequired=error.status===428;}
      finally{process.stdout.write(JSON.stringify(row)+'\n');}
    }}
    await Promise.all([worker(),worker()]);report.counts={total:report.sites.length,resolved:report.sites.filter(s=>s.resolved).length,mediaSampled:report.sites.filter(s=>s.probe?.sampled).length,errors:report.sites.filter(s=>s.error).length};
    if(arg('--json')){const output=path.resolve(arg('--json'));fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(report,null,2));}
    process.stdout.write(JSON.stringify(report.counts)+'\n');
  }finally{await library.close();const target=path.resolve(directory);if(path.dirname(target)!==path.resolve(os.tmpdir())||!path.basename(target).startsWith('MobileTV source check '))throw new Error('Unsafe cleanup directory');try{fs.rmSync(target,{recursive:true,force:true,maxRetries:5,retryDelay:200});}catch(error){if(!['EPERM','EBUSY','ENOTEMPTY'].includes(error.code))throw error;process.stderr.write('临时浏览器缓存仍在释放，检查结果已保存。\n');}}
}
if(require.main===module)main().catch(error=>{console.error(error.message);process.exitCode=1;});
module.exports={probeMedia};
