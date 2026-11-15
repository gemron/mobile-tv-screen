const assert = require('assert/strict'); const http = require('http'); const crypto = require('crypto'); const { crc32 } = require('zlib');
const { unzip, unwrap, DexData, SourceMaterial } = require('../src/content/material');
// Small, synthetic DEX data. No third-party bytecode or keys are test fixtures.
function dex() {
  const b=Buffer.alloc(512);b.write('dex\n035\0');b.writeUInt32LE(112,36);
  const strings=['Lcom/github/catvod/spider/Fixture;','V','Ljava/lang/String;','value','<init>','fixture-data'];
  b.writeUInt32LE(strings.length,56);b.writeUInt32LE(112,60);b.writeUInt32LE(3,64);b.writeUInt32LE(136,68);[0,1,2].forEach((n,i)=>b.writeUInt32LE(n,136+i*4));
  b.writeUInt32LE(1,72);b.writeUInt32LE(148,76);b.writeUInt32LE(1,152);
  b.writeUInt32LE(1,80);b.writeUInt32LE(160,84);b.writeUInt16LE(2,162);b.writeUInt32LE(3,164);
  b.writeUInt32LE(1,88);b.writeUInt32LE(168,92);b.writeUInt32LE(4,172);
  b.writeUInt32LE(1,96);b.writeUInt32LE(176,100);b.writeUInt32LE(208,200);
  Buffer.from([0,0,1,0,0,1,0xe0,1]).copy(b,208); // method index=0, public, code_off=224
  b.writeUInt16LE(2,224);b.writeUInt32LE(5,236);[0x001a,5,0x105b,0,0x000e].forEach((n,i)=>b.writeUInt16LE(n,240+i*2));
  let p=252;strings.forEach((s,i)=>{b.writeUInt32LE(p,112+i*4);b[p++]=s.length;p+=b.write(s,p);b[p++]=0;});
  b.writeUInt32LE(p,32);return b.subarray(0,p);
}
function zip(name,data) {
  const filename=Buffer.from(name),local=Buffer.alloc(30),central=Buffer.alloc(46),end=Buffer.alloc(22);local.writeUInt32LE(0x04034b50);central.writeUInt32LE(0x02014b50);
  for(const [buffer,checksum,size,raw,names]of [[local,14,18,22,26],[central,16,20,24,28]]){buffer.writeUInt32LE(crc32(data),checksum);buffer.writeUInt32LE(data.length,size);buffer.writeUInt32LE(data.length,raw);buffer.writeUInt16LE(filename.length,names);}
  end.writeUInt32LE(0x06054b50);end.writeUInt16LE(1,8);end.writeUInt16LE(1,10);end.writeUInt32LE(central.length+filename.length,12);end.writeUInt32LE(local.length+filename.length+data.length,16);
  return Buffer.concat([local,filename,data,central,filename,end]);
}
async function run(){
  const data=dex();assert.deepEqual(new DexData(data).facts('Fixture').fields,{value:'fixture-data'});
  const plain=zip('classes.dex',data);assert.deepEqual(unzip(plain).get('classes.dex'),data);
  const masked=Buffer.from(plain).map(v=>v===1?6:v===6?1:v===2?5:v===5?2:v);assert.deepEqual(unwrap(zip('assets/fixture.guard',masked)),data);
  assert.equal(unzip(zip('../../arbitrary.js',Buffer.from('throw new Error("must not execute")'))).size,0);
  const corrupt=Buffer.from(plain);corrupt[60]^=1;assert.throws(()=>unzip(corrupt),/校验/);
  const overflow=Buffer.from(data);overflow.writeUInt32LE(999999,56);assert.throws(()=>new DexData(overflow),/越界/);
  const server=http.createServer((req,res)=>res.end(plain));await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  try{const url='http://127.0.0.1:'+server.address().port+'/fixture.jar';const material=new SourceMaterial(url+';md5;'+crypto.createHash('md5').update(plain).digest('hex'),url);assert.equal((await material.get('Fixture')).fields.value,'fixture-data');await assert.rejects(new SourceMaterial(url+';md5;'+'0'.repeat(32),url).get('Fixture'),/MD5/);}
  finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
  console.log('PASS: bounded synthetic ZIP/DEX data, guard envelope, literal fields, ignored arbitrary code, integrity and subscription MD5 validation');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
