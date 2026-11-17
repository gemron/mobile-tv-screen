// XBPQ's literal delimiter rules only. JavaScript, imports and eval are not run.
const {resource}=require('../http');
const {json,webUrl,cleanHeaders}=require('../format');
function describe(raw,base){
  if(raw.api==='csp_Config'||raw.api==='csp_LocalFile')return {adapter:'xs-info',plugin:raw.api.slice(4),api:'https://example.invalid/',supported:true,searchable:false,implementation:'node-desktop-entry',headers:{}};
  if(raw.api!=='csp_XBPQ')return null;
  const rule=typeof raw.ext==='object'?raw.ext:null;
  return {adapter:'xs-rule',ruleUrl:rule?'':webUrl(raw.ext,base),rule,api:base,supported:true,implementation:'node-xbpq-literal',headers:cleanHeaders(raw.header||raw.headers)};
}
async function load(site,signal){
  if(!site.rule)site.rule=json((await resource(site.ruleUrl,{signal,limit:256*1024,timeout:10000})).text);
  if(!site.rule||typeof site.rule!=='object'||!site.rule['分类url'])throw new Error('XBPQ 配置缺少分类地址');
  return site.rule;
}
function extract(text,rule){
  if(typeof rule!=='string'||rule.length>2000)return '';
  const tokens=rule.split('&&');if(tokens.length!==2)throw new Error('此 XBPQ 规则需要脚本或复杂表达式，尚不支持');
  let [start,end]=tokens,prefix='';
  // A literal prefix before + is commonly used to repair abbreviated URLs.
  const plus=start.indexOf('+');if(plus>=0){prefix=start.slice(0,plus);start=start.slice(plus+1);}
  const at=text.indexOf(start);if(at<0)return '';const from=at+start.length,to=end?text.indexOf(end,from):text.length;
  return to<0?'':prefix+text.slice(from,to).replace(/\\\//g,'/').replace(/&amp;/g,'&');
}
function chunks(text,rule){const parts=String(rule||'').split('&&');if(parts.length!==2||!parts[0]||!parts[1])throw new Error('XBPQ 数组规则不受支持');const [start,end]=parts,out=[];let p=0;while(out.length<500){const a=text.indexOf(start,p);if(a<0)break;const b=text.indexOf(end,a+start.length);if(b<0)break;out.push(text.slice(a,b+end.length));p=b+end.length;}return out;}
async function list(site,{id='',page=1,keyword=''}={},signal){
  if(site.adapter==='xs-info')return {class:[],list:[],page:1,pagecount:1,notice:site.plugin==='Config'?'电脑端请使用片库顶部的“账号”和“片源管理”完成配置。':'电脑本地视频请在“本地文件”中选择文件播放；此条目原本用于 Android 的文件目录。'};
  const r=await load(site,signal),classes=String(r['分类']||'').split('#').map(v=>{const p=v.indexOf('$');return p>=0?{type_id:v.slice(p+1),type_name:v.slice(0,p)}:null;}).filter(Boolean);
  if(keyword&&!r['搜索url'])return {class:classes,list:[],page:1,pagecount:1,notice:'此订阅规则没有提供搜索接口，请按分类浏览。'};
  const path=String(keyword?r['搜索url']:r['分类url']).replace(/\{cateId\}/g,encodeURIComponent(id||classes[0]?.type_id||'')).replace(/\{catePg\}/g,String(Math.max(1,Number(page)||1))).replace(/\{wd\}|\{key\}/g,encodeURIComponent(keyword));
  const response=await resource(webUrl(path),{headers:site.headers,signal,timeout:12000,limit:8*1024*1024}),rows=chunks(response.text,r['数组']);
  if(!rows.length&&!keyword)throw new Error('订阅规则未读到分类内容，源站接口或规则可能已变化');
  const items=rows.map(text=>{const link=extract(text,r['链接']);if(!link)return null;return {vod_id:webUrl((r['链接前缀']||'')+link),vod_name:extract(text,r['标题']),vod_pic:extract(text,r['图片']),vod_remarks:extract(text,r['副标题'])};}).filter(Boolean);
  return {class:classes,list:items,page,pagecount:items.length>=20?Number(page)+1:Number(page)};
}
async function detail(site,id,signal){
  const rule=await load(site,signal),text=(await resource(webUrl(id),{headers:site.headers,signal,timeout:12000})).text;
  const episodes=chunks(text,rule['播放列表']).map((part,i)=>({name:extract(part,rule['播放标题'])||'线路 '+(i+1),id:extract(part,rule['播放链接'])})).filter(e=>e.id);
  if(!episodes.length)throw new Error('订阅规则未读取到播放地址，请更新规则或换源');
  return {vod_id:id,vod_name:'视频',lines:[{name:'可用清晰度',episodes}]};
}
async function resolve(site,episode){return {url:webUrl(episode.id),parse:0,header:site.headers};}
module.exports={describe,list,detail,resolve,extract,chunks};
