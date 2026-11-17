// Read only bounded MP4 metadata; media payload is counted and never copied.
// Timing is derived from complete fragments, not from file-size/bitrate guesses.
const MAX_METADATA = 2 * 1024 * 1024;
function boxes(buffer, visit) {
  for (let at=0;at+8<=buffer.length;) {
    let size=buffer.readUInt32BE(at),header=8;
    if(size===1){if(at+16>buffer.length)return;size=Number(buffer.readBigUInt64BE(at+8));header=16;}
    if(!size)size=buffer.length-at;
    if(!Number.isSafeInteger(size)||size<header||at+size>buffer.length)return;
    visit(buffer.toString('ascii',at+4,at+8),buffer.subarray(at+header,at+size));at+=size;
  }
}
const safeTime = value => Number.isFinite(value) && value >= -604800 && value <= 1209600;
function merge(ranges, next) {
  if(!safeTime(next[0])||!safeTime(next[1])||next[1]<=next[0])return;
  let from=0;while(from<ranges.length&&ranges[from][1]+.025<next[0])from++;
  const merged=[...next];let to=from;
  while(to<ranges.length&&ranges[to][0]<=merged[1]+.025){merged[0]=Math.min(merged[0],ranges[to][0]);merged[1]=Math.max(merged[1],ranges[to][1]);to++;}
  ranges.splice(from,to-from,merged);if(ranges.length>256)ranges.shift();
}
function intersect(a,b) {
  const result=[];let i=0,j=0;
  while(i<a.length&&j<b.length){const start=Math.max(a[i][0],b[j][0]),end=Math.min(a[i][1],b[j][1]);if(end>start)merge(result,[Math.max(0,start),end]);if(a[i][1]<b[j][1])i++;else j++;}
  return result;
}
class Mp4Timeline {
  constructor(){this.header=Buffer.alloc(0);this.remaining=0;this.kind='';this.parts=[];this.keep=false;this.disabled=false;this.tracks=new Map();this.defaults=new Map();this.pending=null;this.movieScale=1000;this.valid=false;}
  write(chunk) {
    if(this.disabled)return;
    try {
      let at=0;
      while(at<chunk.length){
        if(!this.remaining){
          const needed=this.header.length>=8&&this.header.readUInt32BE(0)===1?16:8;
          const take=Math.min(needed-this.header.length,chunk.length-at);
          if(take){this.header=Buffer.concat([this.header,chunk.subarray(at,at+take)]);at+=take;}
          if(this.header.length<8)break;
          if(this.header.readUInt32BE(0)===1&&this.header.length<16)continue;
          const headerSize=this.header.length,size=this.header.readUInt32BE(0)===1?Number(this.header.readBigUInt64BE(8)):this.header.readUInt32BE(0);
          if(!Number.isSafeInteger(size)||size<headerSize){this.disabled=true;break;}
          this.kind=this.header.toString('ascii',4,8);this.remaining=size-headerSize;this.header=Buffer.alloc(0);this.parts=[];
          this.keep=['moov','moof'].includes(this.kind);if(this.keep&&this.remaining>MAX_METADATA){this.disabled=true;break;}
          if(!this.remaining){this.complete();continue;}
        }
        const take=Math.min(this.remaining,chunk.length-at);
        if(this.keep)this.parts.push(Buffer.from(chunk.subarray(at,at+take)));
        at+=take;this.remaining-=take;if(!this.remaining)this.complete();
      }
    }catch{this.disabled=true;this.pending=null;}
  }
  complete(){
    if(this.kind==='moov')this.moov(Buffer.concat(this.parts));
    else if(this.kind==='moof')this.pending=this.moof(Buffer.concat(this.parts));
    else if(this.kind==='mdat'&&this.pending){
      for(const [id,range]of this.pending){const track=this.tracks.get(id);if(track)merge(track.ranges,range);}
      this.valid=true;this.pending=null;
    }
    this.parts=[];this.keep=false;
  }
  moov(body){
    boxes(body,(kind,b)=>{if(kind==='mvhd'&&b.length>=24)this.movieScale=b.readUInt32BE(b[0]===1?20:12)||1000;});
    boxes(body,(kind,b)=>{
      if(kind==='mvex')boxes(b,(type,x)=>{if(type==='trex'&&x.length>=20)this.defaults.set(x.readUInt32BE(4),x.readUInt32BE(12));});
      if(kind!=='trak')return;
      const track={id:0,scale:0,kind:'',shift:0,ranges:[]};let edits;
      boxes(b,(type,x)=>{
        if(type==='tkhd'&&x.length>=24)track.id=x.readUInt32BE(x[0]===1?20:12);
        if(type==='edts')boxes(x,(t,e)=>{if(t==='elst')edits=e;});
        if(type==='mdia')boxes(x,(t,m)=>{
          if(t==='mdhd'&&m.length>=24)track.scale=m.readUInt32BE(m[0]===1?20:12);
          if(t==='hdlr'&&m.length>=12)track.kind=m.toString('ascii',8,12);
        });
      });
      if(!track.id||!track.scale||!['vide','soun'].includes(track.kind))return;
      if(edits&&edits.length>=8){
        const version=edits[0],count=Math.min(16,edits.readUInt32BE(4));let cursor=8,empty=0;
        for(let n=0;n<count;n++){
          const bytes=version===1?20:12;if(cursor+bytes>edits.length)break;
          const duration=version===1?Number(edits.readBigUInt64BE(cursor)):edits.readUInt32BE(cursor),media=version===1?Number(edits.readBigInt64BE(cursor+8)):edits.readInt32BE(cursor+4);
          if(media===-1)empty+=duration/this.movieScale;else{track.shift=empty-media/track.scale;break;}cursor+=bytes;
        }
      }
      this.tracks.set(track.id,track);
    });
  }
  moof(body){
    const output=new Map();
    boxes(body,(kind,b)=>{
      if(kind!=='traf')return;
      let id=0,base=0,duration=0;const runs=[];
      boxes(b,(type,x)=>{
        if(type==='tfhd'&&x.length>=8){const flags=x.readUInt32BE(0)&0xffffff;id=x.readUInt32BE(4);let at=8;if(flags&1)at+=8;if(flags&2)at+=4;if(flags&8&&at+4<=x.length)duration=x.readUInt32BE(at);}
        if(type==='tfdt'&&x.length>=8){if(x[0]===1&&x.length>=12)base=Number(x.readBigUInt64BE(4));else base=x.readUInt32BE(4);}
        if(type==='trun')runs.push(x);
      });
      const track=this.tracks.get(id);if(!track||!Number.isSafeInteger(base))return;
      duration ||= this.defaults.get(id)||0;let cursor=base,start=Infinity,end=-Infinity;
      for(const run of runs){
        if(run.length<8)continue;const version=run[0],flags=run.readUInt32BE(0)&0xffffff,count=run.readUInt32BE(4);if(count>100000){this.disabled=true;return;}
        let at=8;if(flags&1)at+=4;if(flags&4)at+=4;
        const stride=(flags&0x100?4:0)+(flags&0x200?4:0)+(flags&0x400?4:0)+(flags&0x800?4:0);
        if(at+count*stride>run.length)return;
        for(let sample=0;sample<count;sample++){
          const d=flags&0x100?run.readUInt32BE(at):duration;if(flags&0x100)at+=4;if(flags&0x200)at+=4;if(flags&0x400)at+=4;
          const composition=flags&0x800?(version===1?run.readInt32BE(at):run.readUInt32BE(at)):0;if(flags&0x800)at+=4;
          if(!d)return;const time=(cursor+composition)/track.scale+track.shift;start=Math.min(start,time);end=Math.max(end,time+d/track.scale);cursor+=d;
        }
      }
      if(safeTime(start)&&safeTime(end)&&end>start)output.set(id,[start,end]);
    });
    return output;
  }
  ranges(){
    if(this.disabled||!this.valid)return [];
    const video=[...this.tracks.values()].find(t=>t.kind==='vide'),audio=[...this.tracks.values()].find(t=>t.kind==='soun');
    return video&&audio?intersect(video.ranges,audio.ranges):(video||audio)?.ranges.map(([a,b])=>[Math.max(0,a),b])||[];
  }
}
module.exports={Mp4Timeline};
