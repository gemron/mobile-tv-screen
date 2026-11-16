// Indexed Matroska text subtitles. CueRelativePosition lets us read the selected
// BlockGroup directly, without downloading the interleaved 4K video packets.
const { OriginalHttpPool } = require('./originalHttpPool');
const { parseSubtitle } = require('./subtitleFormat');
const unsupported = () => Object.assign(new Error('此容器没有可直接读取的字幕索引'), { code:'MKV_SUBTITLE_FALLBACK' });
function vint(b, at, id=false) {
  const first=b[at];if(!first)throw unsupported();let width=1;while(width<=8&&!(first&(0x80>>(width-1))))width++;
  if(width>8||at+width>b.length||id&&width>4)throw unsupported();
  let value=BigInt(id?first:first&((0x80>>(width-1))-1));for(let i=1;i<width;i++)value=value*256n+BigInt(b[at+i]);
  const unknown=!id&&value===(1n<<BigInt(7*width))-1n;if(!unknown&&value>BigInt(Number.MAX_SAFE_INTEGER))throw unsupported();
  return {width,value:unknown?Infinity:Number(value)};
}
function header(b,at=0) { const id=vint(b,at,true),size=vint(b,at+id.width),data=at+id.width+size.width;return {id:id.value,data,size:size.value,end:data+size.value}; }
function children(b) {const values=[];for(let at=0;at<b.length;){const e=header(b,at);if(e.end>b.length||e.end<=at||values.length>=100000)throw unsupported();values.push({...e,body:b.subarray(e.data,e.end)});at=e.end;}return values;}
function uint(b) {if(!b?.length||b.length>8)throw unsupported();let n=0n;for(const v of b)n=n*256n+BigInt(v);if(n>BigInt(Number.MAX_SAFE_INTEGER))throw unsupported();return Number(n);}
const field=(list,id)=>list.find(e=>e.id===id)?.body;
const number=(list,id,fallback=0)=>{const b=field(list,id);return b?uint(b):fallback;};
const timestamp=value=>{const ms=Math.max(0,Math.round(value*1000));return `${Math.floor(ms/3600000)}:${String(Math.floor(ms/60000)%60).padStart(2,'0')}:${String(Math.floor(ms/1000)%60).padStart(2,'0')}.${String(ms%1000).padStart(3,'0')}`;};

class RangeReader {
  constructor(source,open,signal) {this.source=source;this.signal=signal;this.pool=new OriginalHttpPool({fallback:open});this.cache=new Map();this.bytes=0;this.total=Infinity;}
  async read(at,length) {
    this.signal.throwIfAborted();if(!Number.isSafeInteger(at)||at<0||!Number.isSafeInteger(length)||length<1||length>4*1024*1024)throw unsupported();
    for(const [start,b] of this.cache)if(at>=start&&at+length<=start+b.length)return b.subarray(at-start,at-start+length);
    const count=Math.min(Math.max(length,8192),this.total-at);if(count<=0)throw unsupported();
    this.bytes+=count;if(this.bytes>16*1024*1024)throw unsupported();
    const headers={...this.source.headers};for(const name of Object.keys(headers))if(/^(range|if-range)$/i.test(name))delete headers[name];
    headers.Range=`bytes=${at}-${at+count-1}`;
    const {upRes}=await this.pool.open(this.source.url,headers,5,this.signal);
    try {
      const range=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(upRes.headers['content-range']||'');
      if(upRes.statusCode!==206||!range||Number(range[1])!==at)throw unsupported();
      const total=Number(range[3]),end=Number(range[2]);if(!Number.isSafeInteger(total)||end!==Math.min(at+count,total)-1||this.total!==Infinity&&this.total!==total)throw unsupported();this.total=total;
      const parts=[];let received=0;for await(const chunk of upRes){received+=chunk.length;if(received>count)throw unsupported();parts.push(chunk);}
      if(received!==end-at+1)throw unsupported();const b=Buffer.concat(parts);this.cache.set(at,b);while(this.cache.size>96)this.cache.delete(this.cache.keys().next().value);return b.subarray(0,length);
    }finally{upRes.destroy();}
  }
  async element(at) {const h=header(await this.read(at,12));return {...h,offset:at,data:at+h.data,end:at+h.end};}
  async body(e) {return this.read(e.data,e.size);}
  close(){this.pool.close();this.cache.clear();}
}

async function indexedSubtitles(reader,{index,from,duration}) {
  if((await reader.read(0,4)).readUInt32BE()!==0x1a45dfa3)return null;
  let at=0,segment;for(let i=0;i<8;i++){const e=await reader.element(at);if(e.id===0x18538067){segment=e;break;}at=e.end;}if(!segment)throw unsupported();
  const locations=new Map(),visited=new Set();let firstCluster;
  const seekHead=async e=>{
    if(visited.has(e.data))return;visited.add(e.data);if(visited.size>8)throw unsupported();
    for(const entry of children(await reader.body(e)).filter(x=>x.id===0x4dbb)){
      const v=children(entry.body),id=uint(field(v,0x53ab)),offset=segment.data+number(v,0x53ac);if(!Number.isSafeInteger(offset)||offset<segment.data||offset>=Math.min(segment.end,reader.total))throw unsupported();locations.set(id,offset);
    }
    const next=locations.get(0x114d9b74);if(next!==undefined)await seekHead(await reader.element(next));
  };
  at=segment.data;for(let i=0;i<32;i++){
    const e=await reader.element(at);locations.set(e.id,at);if(e.id===0x114d9b74)await seekHead(e);
    if(e.id===0x1f43b675){firstCluster=at;break;}at=e.end;
  }
  if(firstCluster===undefined||!locations.has(0x1654ae6b)||!locations.has(0x1c53bb6b))throw unsupported();
  let scale=.001;const infoAt=locations.get(0x1549a966);if(infoAt!==undefined)scale=number(children(await reader.body(await reader.element(infoAt))),0x2ad7b1,1000000)/1e9;
  const tracks=children(await reader.body(await reader.element(locations.get(0x1654ae6b)))).filter(e=>e.id===0xae).map(e=>children(e.body));
  const track=tracks[index];if(!track||number(track,0x83)!==17||field(track,0x6d80)||field(track,0x23314f)||number(track,0x56aa))throw unsupported();
  const codec=field(track,0x86)?.toString('utf8'),trackNumber=number(track,0xd7);if(!['S_TEXT/UTF8','S_TEXT/ASS','S_TEXT/SSA','S_TEXT/WEBVTT'].includes(codec))throw unsupported();
  const cues=children(await reader.body(await reader.element(locations.get(0x1c53bb6b)))).filter(e=>e.id===0xbb),positions=[];
  for(const cue of cues){const v=children(cue.body),time=number(v,0xb3)*scale;for(const point of v.filter(e=>e.id===0xb7)){const p=children(point.body);if(number(p,0xf7)!==trackNumber)continue;
    const relative=field(p,0xf0),end=time+number(p,0xb2)*scale;if(!relative)throw unsupported();if(time<from+duration&&(end>from||time>=from))positions.push({time,duration:Math.max(0,end-time),cluster:segment.data+number(p,0xf1),relative:uint(relative)});
  }}
  // A file with video-only cues needs the bounded FFmpeg fallback, not a false
  // empty subtitle window. Empty windows on an indexed subtitle track are valid.
  const hasTrack=cues.some(c=>children(c.body).filter(e=>e.id===0xb7).some(p=>number(children(p.body),0xf7)===trackNumber));if(!hasTrack)throw unsupported();
  if(positions.length>2000)throw unsupported();const result=[];
  for(let start=0;start<positions.length;start+=8)await Promise.all(positions.slice(start,start+8).map(async p=>{
    const cluster=await reader.element(p.cluster);if(cluster.id!==0x1f43b675)throw unsupported();
    const element=await reader.element(cluster.data+p.relative);if(element.end>cluster.end||element.size>65536)throw unsupported();
    let block,seconds=p.duration;
    if(element.id===0xa0){const group=children(await reader.body(element));block=field(group,0xa1);seconds=number(group,0x9b,seconds/scale)*scale;}else if(element.id===0xa3)block=await reader.body(element);else throw unsupported();
    if(!block)throw unsupported();const numberId=vint(block,0);if(numberId.value!==trackNumber||block.length<numberId.width+3||(block[numberId.width+2]&6))throw unsupported();
    if(!(seconds>0))throw unsupported();let text=block.subarray(numberId.width+3).toString('utf8');
    if(codec==='S_TEXT/ASS'||codec==='S_TEXT/SSA'){let skip=0;for(let i=0;i<8;i++){skip=text.indexOf(',',skip)+1;if(!skip)throw unsupported();}text=text.slice(skip);}if(!text.trim())return;
    const parsed=parseSubtitle(Buffer.from(`1\n${timestamp(p.time)} --> ${timestamp(p.time+seconds)}\n${text}\n`),'embedded.srt');result.push(...parsed);
  }));
  return result.sort((a,b)=>a.start-b.start||a.end-b.end);
}
async function readMatroskaSubtitles(source,open,signal,window) {
  const reader=new RangeReader(source,open,signal);
  try{return await indexedSubtitles(reader,window);}catch(error){signal.throwIfAborted();if(error.code==='MKV_SUBTITLE_FALLBACK')return null;throw error;}finally{reader.close();}
}
module.exports={readMatroskaSubtitles,indexedSubtitles,RangeReader};
