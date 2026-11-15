const fs=require('fs');const path=require('path');const {createHash}=require('crypto');
class RuntimeData {
  constructor(directory){this.file=path.join(directory,'source-runtime.json');try{this.values=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{this.values={};}}
  scope(provider,endpoint){const key=createHash('sha256').update(provider+'\n'+endpoint).digest('hex');return {get:()=>({...this.values[key]}),set:patch=>{this.values[key]={...this.values[key],...patch};fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.values),{encoding:'utf8',mode:0o600});fs.renameSync(this.file+'.tmp',this.file);}};}
}
module.exports={RuntimeData};
