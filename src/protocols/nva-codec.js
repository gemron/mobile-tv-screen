// Independent implementation of the public NVA framing description:
// https://www.xfangfang.cn/028 (not a bundled Android SDK).
const MAX_JSON=128*1024;
function jsonBytes(value){const bytes=Buffer.from(JSON.stringify(value));if(bytes.length>MAX_JSON)throw new Error('NVA payload is too large');return bytes;}
function response(id,data){const bytes=data===undefined?null:jsonBytes(data),head=Buffer.alloc(bytes?10:6);head[0]=0xc0;head[1]=bytes?1:0;head.writeUInt32BE(id>>>0,2);if(bytes)head.writeUInt32BE(bytes.length,6);return bytes?Buffer.concat([head,bytes]):head;}
function ping(id){const bytes=Buffer.alloc(6);bytes[0]=0xe4;bytes.writeUInt32BE(id>>>0,2);return bytes;}
function command(id,method,data){const name=Buffer.from(method);if(!name.length||name.length>128)throw new Error('Invalid NVA command');const body=data===undefined?null:jsonBytes(data),head=Buffer.alloc(16+name.length+(body?4:0));head[0]=0xe0;head[1]=body?3:2;head.writeUInt32BE(id>>>0,2);head[6]=1;head[7]=7;head.write('Command',8);head[15]=name.length;name.copy(head,16);if(body)head.writeUInt32BE(body.length,16+name.length);return body?Buffer.concat([head,body]):head;}
class Decoder{
 constructor(){this.buffer=Buffer.alloc(0);}
 push(bytes){
  if(this.buffer.length+bytes.length>MAX_JSON*2)throw new Error('NVA buffer limit exceeded');this.buffer=Buffer.concat([this.buffer,bytes]);const frames=[];
  while(this.buffer.length>=6){
   const data=this.buffer,kind=data[0],count=data[1],id=data.readUInt32BE(2);let length=6,method,body;
   if(kind===0xe4){if(count!==0)throw new Error('Invalid NVA heartbeat');}
   else if(kind===0xc0){if(count>1)throw new Error('Invalid NVA response');if(count){if(data.length<10)break;const size=data.readUInt32BE(6);if(size>MAX_JSON)throw new Error('NVA payload is too large');length=10+size;if(data.length<length)break;body=JSON.parse(data.subarray(10,length).toString('utf8'));}}
   else if(kind===0xe0){
    if(count!==2&&count!==3)throw new Error('Invalid NVA argument count');if(data.length<16)break;
    if(data[6]!==1||data[7]!==7||data.toString('ascii',8,15)!=='Command'||!data[15]||data[15]>128)throw new Error('Invalid NVA command header');
    length=16+data[15];if(data.length<length)break;method=data.toString('utf8',16,length);
    if(count===3){if(data.length<length+4)break;const size=data.readUInt32BE(length);if(size>MAX_JSON)throw new Error('NVA payload is too large');length+=4+size;if(data.length<length)break;body=JSON.parse(data.subarray(length-size,length).toString('utf8'));}
   }else throw new Error('Unknown NVA frame');
   frames.push({kind:kind===0xe0?'command':kind===0xc0?'response':'ping',id,method,data:body});this.buffer=this.buffer.subarray(length);
  }
  return frames;
 }
}
module.exports={Decoder,command,response,ping,MAX_JSON};
