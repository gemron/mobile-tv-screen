// Bounded protobuf wire codec for the documented fields used by native adapters.
function varint(value) { let n=BigInt(value),bytes=[];if(n<0n)throw new Error('负数 protobuf 整数');do{bytes.push(Number(n&127n)|(n>127n?128:0));n>>=7n;}while(n);return Buffer.from(bytes); }
function encode(fields) { return Buffer.concat(fields.map(([id,value])=>Buffer.isBuffer(value)||typeof value==='string'?Buffer.concat([varint(id*8+2),varint(Buffer.byteLength(value)),Buffer.from(value)]):Buffer.concat([varint(id*8),varint(value)]))); }
function decode(input) {
  const data=Buffer.from(input);if(data.length>8*1024*1024)throw new Error('protobuf 响应过大');
  let p=0,count=0;const out=new Map();
  const read=()=>{let n=0n;for(let i=0;i<10;i++){if(p>=data.length)throw new Error('protobuf 数据截断');const b=data[p++];n|=BigInt(b&127)<<BigInt(i*7);if(!(b&128))return n;}throw new Error('protobuf 整数越界');};
  while(p<data.length){if(++count>50000)throw new Error('protobuf 字段过多');const tag=Number(read()),id=tag>>>3,wire=tag&7;if(!id)throw new Error('protobuf 字段无效');let value;
    if(wire===0){const n=read();value=n<=BigInt(Number.MAX_SAFE_INTEGER)?Number(n):n.toString();}
    else if(wire===2){const size=Number(read());if(!Number.isSafeInteger(size)||size<0||p+size>data.length)throw new Error('protobuf 字段越界');value=data.subarray(p,p+size);p+=size;}
    else if(wire===1||wire===5){const size=wire===1?8:4;if(p+size>data.length)throw new Error('protobuf 字段截断');value=data.subarray(p,p+size);p+=size;}
    else throw new Error('不支持的 protobuf 字段');
    if(!out.has(id))out.set(id,[]);out.get(id).push(value);
  }return out;
}
const first=(data,id)=>data.get(id)?.[0];
const text=(data,id)=>String(first(data,id)??'');
module.exports={encode,decode,first,text};
