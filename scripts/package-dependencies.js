const fs=require('fs');
const path=require('path');
// Keep runtime sources, native binaries and license notices. Prune only known
// development artifacts, and select the exact browser bundles the app serves.
function include(packageName,relative){
  const parts=relative.replace(/\\/g,'/').split('/').filter(Boolean),name=parts.at(-1)||'';
  if(!parts.length)return true;
  if(/^(?:licen[cs]e|copying|notice|copyright|authors)(?:[._-]|$)/i.test(name))return true;
  if(packageName==='hls.js')return ['package.json','LICENSE','dist','dist/hls.min.js'].includes(parts.join('/'));
  if(packageName==='mpegts.js')return ['package.json','LICENSE','dist','dist/mpegts.js'].includes(parts.join('/'));
  if(['test','tests','doc','docs','example','examples','benchmark','benchmarks','bench','coverage','.github','.nyc_output','.git','fixtures','__tests__'].includes(parts[0]))return false;
  if(parts[0]==='node_modules')return false; // Nested locked packages are staged separately.
  if(/\.map$|\.d\.(?:ts|cts|mts)$|\.(?:tsbuildinfo|log)$/.test(name))return false;
  if(['.eslintrc','.eslintrc.json','.travis.yml','.npmignore','.prettierrc','tsconfig.json'].includes(name))return false;
  if(packageName==='webtorrent'&&parts[0]==='dist')return false; // Browser build; Node uses index.js/lib.
  if(parts[0]==='prebuilds'&&parts[1]&&!parts[1].startsWith('win32-x64'))return false;
  return true;
}
function stage(root,target,packages){
  const dependencies=[];let originalBytes=0,shippedBytes=0;
  for(const [relative,entry] of Object.entries(packages)){
    if(!relative.startsWith('node_modules/')||entry.dev)continue;
    const source=path.join(root,relative);if(!fs.existsSync(source)){if(entry.optional)continue;throw new Error('Missing locked dependency: '+relative);}
    const packageName=JSON.parse(fs.readFileSync(path.join(source,'package.json'),'utf8')).name;
    fs.cpSync(source,path.join(target,relative),{recursive:true,filter:file=>{
      const rel=path.relative(source,file),stat=fs.statSync(file);
      const keep=include(packageName,rel);
      if(stat.isFile()){originalBytes+=stat.size;if(keep)shippedBytes+=stat.size;}return keep;
    }});
    dependencies.push({name:relative.replace(/^node_modules\//,''),version:entry.version,license:entry.license||'See bundled package'});
  }
  return {dependencies,originalBytes,shippedBytes};
}
module.exports={include,stage};
