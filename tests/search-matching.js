const assert=require('assert/strict');
const {compileQuery,rankResults}=require('../src/content/search-match');
const {searchSources}=require('../src/content/search');
async function run(){
 const input=[{id:'irrelevant',title:'其他影片'},{id:'partial',title:'走马的故事'},{id:'split',title:'上任后走马'},{id:'contains',title:'走马上任（臻彩）'},{id:'exact',title:'走马上任'}];
 assert.deepEqual(rankResults(input,'走马上任').map(v=>v.id),['exact','contains','split','partial','irrelevant']);
 assert.equal(rankResults([{id:'width',title:' ＬＯＫＩ · 2 '}],'loki 2')[0].match.type,'title-exact');
 assert.equal(compileQuery('权力的游戏').words.includes('的'),false);
 const actor=rankResults([{id:'partial',title:'张译访谈'},{id:'movie',title:'狂飙',actor:'张译 / 张颂文'},{id:'other',title:'其他电影',actor:'其他人'}],'张译');
 assert.equal(actor[1].id,'movie');assert.equal(actor[1].match.label,'演员：张译');
 const mixed=rankResults([{id:'title-only',title:'狂飙'},{id:'cast-and-title',title:'狂飙',actor:'张译 / 张颂文'}],'狂飙 张译');assert.equal(mixed[0].id,'cast-and-title');
 const english=rankResults([{id:'film',title:'Forrest Gump',actor:'Tom Hanks, Robin Wright'}],'Tom Hanks');assert.equal(english[0].match.type,'actor-full');
 let release;const gate=new Promise(resolve=>{release=resolve;});const snapshots=[];
 const pending=searchSources([{key:'fast',name:'Fast',supported:true},{key:'slow',name:'Slow',supported:true}],'走马上任',{query:async site=>{if(site.key==='slow')await gate;return {list:site.key==='fast'?[{id:'partial',title:'走马的故事'}]:[{id:'exact',title:'走马上任',actor:'张译'}]};},onProgress:data=>{snapshots.push(data.list.map(item=>item.id));if(data.list.length===1)release();}});
 const result=await pending;assert.deepEqual(result.list.map(item=>item.id),['exact','partial']);assert.ok(snapshots.some(list=>list.length===1&&list[0]==='partial'),'Early fuzzy results remain usable while the exact source loads');assert.equal(result.list[0].actor,'张译');
 const sites=Array.from({length:16},(_,index)=>({key:String(index),name:String(index),supported:true}));
 const capped=await searchSources(sites,'目标影片',{query:async site=>({list:site.key==='15'?[{id:'last',title:'目标影片'}]:Array.from({length:20},(_,index)=>({id:String(index),title:'其他结果'+index}))})});
 assert.equal(capped.list.length,300);assert.equal(capped.list[0].id,'last','A late exact result cannot be discarded when fuzzy results filled the cap');
 console.log('PASS: full-title priority, Unicode normalization, Chinese split words, cast and mixed queries, incremental reordering and late exact results at capacity');
}
run().catch(e=>{console.error(e);process.exitCode=1;});
