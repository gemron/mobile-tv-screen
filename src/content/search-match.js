const segmenter=new Intl.Segmenter('zh-CN',{granularity:'word'});
const ignored=new Set(['的','了','和','与','之','the','a','an','of','and']);
function normalize(value){return String(value||'').normalize('NFKC').toLowerCase().replace(/<[^>]*>/g,'').replace(/[\p{P}\p{S}\s]/gu,'');}
function compileQuery(keyword){
 const text=String(keyword||'').trim().slice(0,200),full=normalize(text);
 const chunks=[...text.matchAll(/[\p{L}\p{N}]+/gu)].map(match=>match[0]);
 const split=chunk=>{
  if(/\p{Script=Han}/u.test(chunk)&&chunk.length<=3)return [normalize(chunk)];
  const parts=[...segmenter.segment(chunk)].filter(part=>part.isWordLike).map(part=>normalize(part.segment));
  if(parts.some(word=>word.length===1&&/\p{Script=Han}/u.test(word)&&!ignored.has(word))){const chars=[...normalize(chunk)];for(let index=0;index<chars.length-1;index++)if(chars.slice(index,index+2).every(char=>/\p{Script=Han}/u.test(char)&&!ignored.has(char)))parts.push(chars[index]+chars[index+1]);}
  return parts;
 };
 const words=[...new Set(chunks.flatMap(split).filter(word=>word&&!ignored.has(word)&&(word.length>1||full.length===1)))].slice(0,20);
 return {full,words:words.length?words:[full]};
}
function actorsOf(item){
 const raw=item.actor||item.actors||item.cast||item.vod_actor||'';
 const value=Array.isArray(raw)?raw.map(actor=>typeof actor==='object'?actor?.name||'':actor).join('/') : String(raw);
 return value.slice(0,4000).split(/[、,，/|;；]+|\s+(?=[\p{Script=Han}])/u).map(name=>name.trim()).filter(Boolean).slice(0,80);
}
function matchVideo(item,query){
 if(typeof query==='string')query=compileQuery(query);
 const title=normalize(item.title||item.vod_name),actors=actorsOf(item),cast=actors.map(normalize),full=query.full;
 const fullActors=actors.filter((_,index)=>full&&cast[index].includes(full));
 const matchedActors=(fullActors.length?fullActors:actors.filter((_,index)=>query.words.some(word=>word&&cast[index].includes(word)))).slice(0,4);
 if(!full)return {tier:6,coverage:0,titleCoverage:0,gap:title.length,type:'none',actors:[]};
 const titleWords=query.words.filter(word=>title.includes(word)),allWords=query.words.filter(word=>title.includes(word)||cast.some(name=>name.includes(word)));
 const weight=words=>words.reduce((total,word)=>total+word.length,0),coverage=weight(allWords),titleCoverage=weight(titleWords);
 let tier=6,type='none';
 if(title===full){tier=0;type='title-exact';}
 else if(title.includes(full)){tier=1;type='title-full';}
 else if(cast.some(name=>name.includes(full))){tier=2;type='actor-full';}
 else if(allWords.length===query.words.length&&allWords.length){tier=3;type='words';}
 else if(titleWords.length){tier=4;type='title-partial';}
 else if(matchedActors.length){tier=5;type='actor-partial';}
 return {tier,coverage,titleCoverage,gap:Math.abs(title.length-full.length),type,actors:matchedActors};
}
function rankResults(list,keyword,sourceOrder=new Map()){
 const query=typeof keyword==='object'?keyword:compileQuery(keyword);
 return list.map((item,index)=>({item,index,match:matchVideo(item,query)})).sort((a,b)=>a.match.tier-b.match.tier||b.match.coverage-a.match.coverage||b.match.titleCoverage-a.match.titleCoverage||a.match.gap-b.match.gap||(sourceOrder.get(a.item.siteKey)||0)-(sourceOrder.get(b.item.siteKey)||0)||a.index-b.index).map(({item,match})=>{
  const label=match.actors.length?'演员：'+match.actors.join('、'):match.type==='title-exact'?'片名一致':match.type==='title-full'?'片名包含':'';
  return {...item,match:{type:match.type,label,actors:match.actors}};
 });
}
module.exports={normalize,compileQuery,matchVideo,rankResults};
