const assert=require('assert/strict');const http=require('http');const {probeMedia}=require('../scripts/check-sources');
async function run(){let base,noRange=0;const server=http.createServer((req,res)=>{
  if(req.url==='/range.m3u8'){if(req.headers.range){res.statusCode=403;res.end();return;}noRange++;res.setHeader('Content-Type','application/vnd.apple.mpegurl');res.end('#EXTM3U\n#EXT-X-TARGETDURATION:6\n#EXT-X-KEY:METHOD=AES-128,URI="/key"\n#EXTINF:6,\n/segment\n#EXT-X-ENDLIST');return;}
  if(req.url==='/key'){res.end(Buffer.alloc(16));return;}
  if(req.url==='/segment'){res.setHeader('Content-Type','application/octet-stream');res.end(Buffer.alloc(2000,71));return;}
  if(req.url==='/fake'){res.setHeader('Content-Type','application/json');res.end('{"error":"permission denied"}');return;}
  res.setHeader('Content-Type','text/html');res.end('<!doctype html><title>login required</title>');
});await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));base='http://127.0.0.1:'+server.address().port;
try{const result=await probeMedia({url:base+'/range.m3u8',headers:{}});assert.equal(result.sampled,true);assert.equal(result.decoded,false);assert.equal(result.encrypted,true);assert.equal(noRange,1,'CDNs that reject Range are tested again using a bounded normal GET');await assert.rejects(probeMedia({url:base+'/fake',headers:{}}),/JSON/);await assert.rejects(probeMedia({url:base+'/login',headers:{}}),/网页/);console.log('PASS: source checks sample playlist/key/segment bytes, retry Range restrictions, reject HTML/JSON false success and never claim frame decoding');}
finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}
run().catch(e=>{console.error(e);process.exitCode=1;});
