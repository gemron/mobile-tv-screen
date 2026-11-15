// Read subscription-owned interoperability data from the declared container.
// This is a ZIP/DEX data reader, not a bytecode interpreter or Android loader.
const {inflateRawSync,crc32}=require('zlib');
const {createHash}=require('crypto');
const {resource}=require('./http');
const {webUrl}=require('./format');
const MAX=32*1024*1024;
function unzip(input){
  const files=new Map();let end=-1;
  for(let p=input.length-22;p>=Math.max(0,input.length-65557);p--)if(input.readUInt32LE(p)===0x06054b50){end=p;break;}
  if(end<0)throw new Error('插件配置容器不是有效 ZIP');
  const count=input.readUInt16LE(end+10);let offset=input.readUInt32LE(end+16),total=0;
  if(count>2048)throw new Error('插件配置容器条目过多');
  for(let i=0;i<count;i++){
    if(offset+46>input.length||input.readUInt32LE(offset)!==0x02014b50)throw new Error('插件容器目录损坏');
    const method=input.readUInt16LE(offset+10),checksum=input.readUInt32LE(offset+16),packed=input.readUInt32LE(offset+20),size=input.readUInt32LE(offset+24),nameSize=input.readUInt16LE(offset+28),extra=input.readUInt16LE(offset+30),comment=input.readUInt16LE(offset+32),local=input.readUInt32LE(offset+42);
    const name=input.toString('utf8',offset+46,offset+46+nameSize);offset+=46+nameSize+extra+comment;
    if(size>MAX||(total+=size)>MAX*2||local+30>input.length)throw new Error('插件配置容器超过大小限制');
    if(!/^(?:classes\.dex|assets\/[^/]+\.guard)$/.test(name))continue;
    if(input.readUInt32LE(local)!==0x04034b50)throw new Error('插件容器条目损坏');
    const start=local+30+input.readUInt16LE(local+26)+input.readUInt16LE(local+28);
    if(start+packed>input.length)throw new Error('插件容器被截断');
    const compressed=input.subarray(start,start+packed),data=method===0?Buffer.from(compressed):method===8?inflateRawSync(compressed,{maxOutputLength:MAX}):null;
    if(!data||data.length!==size||crc32(data)!==checksum)throw new Error('插件容器校验失败');files.set(name,data);
  }
  return files;
}
function unwrap(input){
  const files=unzip(input),guard=[...files].find(([name])=>name.endsWith('.guard'));
  if(!guard)return files.get('classes.dex');
  const bytes=Buffer.from(guard[1]);for(let i=0;i<bytes.length;i++)bytes[i]=bytes[i]===1?6:bytes[i]===6?1:bytes[i]===2?5:bytes[i]===5?2:bytes[i];
  return unzip(bytes).get('classes.dex');
}
class DexData {
  constructor(buffer){
    if(!buffer||buffer.length<112||buffer.length>MAX||buffer.toString('ascii',0,4)!=='dex\n'||buffer.readUInt32LE(32)!==buffer.length)throw new Error('插件数据不是有效 DEX 容器');
    this.data=buffer;this.strings=this.table(56,60,4,p=>this.string(buffer.readUInt32LE(p)));this.types=this.table(64,68,4,p=>this.strings[buffer.readUInt32LE(p)]);
    this.protos=this.table(72,76,12,p=>{const at=buffer.readUInt32LE(p+8),args=[];if(at){const n=buffer.readUInt32LE(at);if(n>256||at+4+n*2>buffer.length)throw new Error('DEX 参数表越界');for(let i=0;i<n;i++)args.push(this.types[buffer.readUInt16LE(at+4+i*2)]);}return {returns:this.types[buffer.readUInt32LE(p+4)],args};});
    this.fields=this.table(80,84,8,p=>({owner:this.types[buffer.readUInt16LE(p)],name:this.strings[buffer.readUInt32LE(p+4)]}));
    this.methods=this.table(88,92,8,p=>({owner:this.types[buffer.readUInt16LE(p)],name:this.strings[buffer.readUInt32LE(p+4)],proto:this.protos[buffer.readUInt16LE(p+2)]}));
    this.classes=this.table(96,100,32,p=>({name:this.types[buffer.readUInt32LE(p)],offset:buffer.readUInt32LE(p+24)}));
  }
  table(sizePos,offsetPos,width,read){const n=this.data.readUInt32LE(sizePos),p=this.data.readUInt32LE(offsetPos);if(n>300000||p+n*width>this.data.length)throw new Error('DEX 表越界');return Array.from({length:n},(_,i)=>read(p+i*width));}
  uleb(cursor){let result=0,shift=0;for(let i=0;i<5;i++){if(cursor.p>=this.data.length)throw new Error('DEX 数据截断');const b=this.data[cursor.p++];result|=(b&127)<<shift;if(!(b&128))return result>>>0;shift+=7;}throw new Error('DEX 整数格式无效');}
  string(offset){const c={p:offset};this.uleb(c);let end=this.data.indexOf(0,c.p);if(end<0||end-c.p>MAX)throw new Error('DEX 字符串截断');return this.data.toString('utf8',c.p,end);}
  facts(name){
    const definition=this.classes.find(c=>c.name===`Lcom/github/catvod/spider/${name};`);if(!definition?.offset)throw new Error('插件容器中未找到 '+name);
    const cursor={p:definition.offset},sizes=Array.from({length:4},()=>this.uleb(cursor));
    for(let i=0;i<sizes[0]+sizes[1];i++){this.uleb(cursor);this.uleb(cursor);}
    const methods=[];
    for(const count of sizes.slice(2)){let index=0;for(let i=0;i<count;i++){index+=this.uleb(cursor);this.uleb(cursor);const code=this.uleb(cursor);if(code)methods.push({name:this.methods[index]?.name,offset:code});}}
    const result={fields:{},strings:[],arrays:[],arrayOffsets:new Set()};
    for(const method of methods)this.readCode(method,result);
    for(const method of methods)this.readCode(method,result);
    delete result.arrayOffsets;result.strings=[...new Set(result.strings)];return result;
  }
  readCode(method,out){
    const data=this.data,start=method.offset+16,length=data.readUInt32LE(method.offset+12);if(length>MAX/2||start+length*2>data.length)throw new Error('DEX 指令区越界');
    const registers=new Map(),u16=p=>data.readUInt16LE(start+p*2);let literalResult;
    for(let p=0;p<length;){
      const word=u16(p),op=word&255;let width=1;
      if(op===0&&word!==0){
        if(word===0x0100)width=4+u16(p+1)*2;
        else if(word===0x0200)width=2+u16(p+1)*4;
        else if(word===0x0300){const bytes=u16(p+1),n=u16(p+2)+(u16(p+3)*65536);if(![1,2,4,8].includes(bytes)||n>1000000)throw new Error('DEX 数组越界');width=4+Math.ceil(bytes*n/2);if(p+width>length)throw new Error('DEX 数组截断');if([1,2,4].includes(bytes)&&!out.arrayOffsets.has(start+p*2)){out.arrayOffsets.add(start+p*2);const values=[];for(let i=0;i<n;i++){const at=start+(p+4)*2+i*bytes;values.push(bytes===1?data.readInt8(at):bytes===2?data.readInt16LE(at):data.readInt32LE(at));}out.arrays.push(values);}}
      }else{
        if([0x02,0x05,0x08,0x13,0x15,0x16,0x19,0x1a,0x1c,0x1f,0x20,0x22,0x23,0x29,0xfe,0xff].includes(op)||(op>=0x2d&&op<=0x3d)||(op>=0x44&&op<=0x6d)||(op>=0x90&&op<=0xaf)||(op>=0xd0&&op<=0xe2))width=2;
        if([0x03,0x06,0x09,0x14,0x17,0x1b,0x24,0x25,0x26,0x2a,0x2b,0x2c,0xfc,0xfd].includes(op)||(op>=0x6e&&op<=0x78))width=3;
        if(op===0x18)width=5;if(op===0xfa||op===0xfb)width=4;
        if(p+width>length)throw new Error('DEX 指令区截断');
        if(op===0x1a||op===0x1b){const index=op===0x1a?u16(p+1):u16(p+1)+u16(p+2)*65536,literal=this.strings[index];registers.set(word>>>8,literal);if(literal!=null)out.strings.push(literal);}
        if(op===0x12)registers.set((word>>>8)&15,(word>>12)>=8?(word>>12)-16:word>>12);
        if(op===0x13)registers.set(word>>>8,data.readInt16LE(start+(p+1)*2));
        if(op===0x14)registers.set(word>>>8,data.readInt32LE(start+(p+1)*2));
        if(op===0x15)registers.set(word>>>8,u16(p+1)<<16);
        if(op===0x01||op===0x07)registers.set((word>>>8)&15,registers.get(word>>>12));
        if(op===0x02||op===0x08)registers.set(word>>>8,registers.get(u16(p+1)));
        if(op===0x03||op===0x09)registers.set(u16(p+1),registers.get(u16(p+2)));
        if(op>=0x6e&&op<=0x78){
          literalResult=undefined;const called=this.methods[u16(p+1)],args=[];
          if(op>=0x74){for(let i=0;i<(word>>>8);i++)args.push(registers.get(u16(p+2)+i));}
          else{const packed=u16(p+2),r=[packed&15,(packed>>>4)&15,(packed>>>8)&15,packed>>>12,(word>>>8)&15];for(let i=0;i<(word>>>12);i++)args.push(registers.get(r[i]));}
          // The only recognized transforms are an array data reference and the
          // fixed XOR string format. No arbitrary method/control flow is run.
          if(called?.proto.returns==='[S'&&called.proto.args.length===0)literalResult=out.arrays[0];
          if(called?.proto.returns==='Ljava/lang/String;'&&called.proto.args.join(',')==='[S,I,I,I'){
            const [array,offset,n,key]=args;
            if(Array.isArray(array)&&Number.isInteger(offset)&&Number.isInteger(n)&&Number.isInteger(key)&&offset>=0&&n>=0&&n<=100000&&offset+n<=array.length){literalResult=String.fromCharCode(...array.slice(offset,offset+n).map(v=>(v^key)&65535));out.strings.push(literalResult);}
          }
        }
        if(op===0x0a||op===0x0c)registers.set(word>>>8,literalResult);
        if(op===0x5b||op===0x69){const field=this.fields[u16(p+1)],reg=op===0x5b?(word>>>8)&15:word>>>8;if(field&&typeof registers.get(reg)==='string')out.fields[field.name]=registers.get(reg);}
      }
      if(width<=0)throw new Error('DEX 区段格式错误');p+=width;
    }
  }
}
class SourceMaterial {
  constructor(declaration,base){this.declaration=String(declaration||'');this.base=base;this.loading=null;}
  async get(name,signal){
    if(!this.loading)this.loading=this.load(signal).catch(e=>{this.loading=null;throw e;});
    return (await this.loading).facts(name);
  }
  async load(signal){
    const [url,expected]=this.declaration.split(';md5;');if(!url)throw new Error('该适配器需要订阅声明的插件配置数据');
    const response=await resource(webUrl(url,this.base),{signal,limit:8*1024*1024});
    if(expected&&createHash('md5').update(response.body).digest('hex')!==expected.toLowerCase())throw new Error('订阅插件配置 MD5 校验失败，请更新订阅');
    return new DexData(unwrap(response.body));
  }
}
module.exports={unzip,unwrap,DexData,SourceMaterial};
