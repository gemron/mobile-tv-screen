const fs=require('fs'),path=require('path'),os=require('os'),assert=require('assert/strict'),{execFileSync}=require('child_process');
const {Mp4Timeline}=require('../src/services/mp4Timeline');
const directory=fs.mkdtempSync(path.join(os.tmpdir(),'MobileTV MP4 timeline '));
const run=(bin,args)=>execFileSync(bin,args,{windowsHide:true,timeout:30000,maxBuffer:4*1024*1024});
try{
 const source=path.join(directory,'source.mkv');run('ffmpeg',['-v','error','-f','lavfi','-i','testsrc2=size=160x90:rate=24:duration=8','-f','lavfi','-i','sine=frequency=440:sample_rate=48000:duration=8','-c:v','libx264','-preset','ultrafast','-bf','3','-g','96','-c:a','eac3',source]);
 for(const start of [0,2.37]){
  const file=path.join(directory,'out-'+start+'.mp4');run('ffmpeg',['-v','error','-ss',String(start),'-i',source,'-c:v','copy','-c:a','aac','-ac','2','-movflags','frag_keyframe+empty_moov+delay_moov+default_base_moof','-frag_duration','1000000','-f','mp4',file]);
  const bytes=fs.readFileSync(file),timeline=new Mp4Timeline(),sizes=[1,3,7,64,511,4093];let at=0,part=0;
  while(at<bytes.length){const end=Math.min(bytes.length,at+sizes[part++%sizes.length]);timeline.write(bytes.subarray(at,end));at=end;}
  const probe=JSON.parse(run('ffprobe',['-v','error','-show_packets','-show_entries','packet=stream_index,pts_time,duration_time','-of','json',file]));
  const ranges=[0,1].map(index=>{const packets=probe.packets.filter(p=>p.stream_index===index&&Number.isFinite(Number(p.pts_time)));return [Math.max(0,Math.min(...packets.map(p=>Number(p.pts_time)))),Math.max(...packets.map(p=>Number(p.pts_time)+Number(p.duration_time||0)))];});
  const actual=timeline.ranges(),expected=[Math.max(ranges[0][0],ranges[1][0]),Math.min(ranges[0][1],ranges[1][1])];
  assert.ok(actual.length,JSON.stringify({start,disabled:timeline.disabled,tracks:[...timeline.tracks]}));
  // FFprobe serializes packet times to decimal microseconds. Older FFmpeg
  // versions can reach the intended 2 ms edit-list rounding boundary exactly;
  // include that boundary and one microsecond of serialization precision.
  const tolerance=.002+.000001;
  assert.ok(Math.abs(actual[0][0]-expected[0])<=tolerance,JSON.stringify({start,actual,expected}));assert.ok(Math.abs(actual.at(-1)[1]-expected[1])<=tolerance,JSON.stringify({start,actual,expected}));
  let firstMdatEnd=0;for(let offset=0;offset+8<bytes.length;){const size=bytes.readUInt32BE(offset);if(bytes.toString('ascii',offset+4,offset+8)==='mdat'){firstMdatEnd=offset+size;break;}offset+=size;}
  const partial=new Mp4Timeline();partial.write(bytes.subarray(0,firstMdatEnd-1));assert.equal(partial.ranges().length,0,'An unfinished media fragment never contributes playable seconds');partial.write(bytes.subarray(firstMdatEnd-1,firstMdatEnd));assert.ok(partial.ranges().length);
 }
 const oversized=new Mp4Timeline(),header=Buffer.alloc(8);header.writeUInt32BE(4*1024*1024);header.write('moov',4);oversized.write(header);assert.equal(oversized.disabled,true);assert.deepEqual(oversized.ranges(),[]);
 const malformed=new Mp4Timeline();malformed.write(Buffer.from([0,0,0,2,109,111,111,102]));assert.equal(malformed.disabled,true);
 console.log('PASS: complete-fragment A/V ranges match FFprobe with B-frames/edit lists and non-keyframe seeks; partial payloads, split headers and oversized metadata stay safe');
}finally{const target=fs.realpathSync(directory);assert.equal(path.dirname(target).toLowerCase(),fs.realpathSync(os.tmpdir()).toLowerCase());assert.ok(path.basename(target).startsWith('MobileTV MP4 timeline '));fs.rmSync(target,{recursive:true,force:true});}
