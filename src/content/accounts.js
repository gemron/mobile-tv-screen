const fs=require('fs');const path=require('path');
const loginUrls={quark:'https://pan.quark.cn/',uc:'https://drive.uc.cn/',ali:'https://www.alipan.com/',baidu:'https://pan.baidu.com/'};
class Accounts{
  constructor(directory,browser){this.file=path.join(directory,'cloud-accounts.json');this.browser=browser;try{this.data=JSON.parse(fs.readFileSync(this.file,'utf8'));}catch{this.data={};}}
  summary(){return Object.entries(loginUrls).map(([provider,url])=>({provider,url,configured:Boolean(this.data[provider]?.cookie||this.data[provider]?.accessToken||this.data[provider]?.refreshToken),hasCookie:Boolean(this.data[provider]?.cookie),hasToken:Boolean(this.data[provider]?.accessToken||this.data[provider]?.refreshToken)}));}
  get(provider){if(!loginUrls[provider])throw new Error('不支持的网盘类型');return {...this.data[provider]};}
  set(provider,patch){
    this.get(provider);const next={...this.data[provider]};
    for(const key of ['cookie','accessToken','refreshToken'])if(patch[key]!=null){const value=String(patch[key]).trim();if(value.length>(key==='cookie'?16000:8192)||/[\r\n\0]/.test(value))throw new Error('账号信息格式或长度不符合要求');if(value)next[key]=value;else delete next[key];}
    if(patch.accessToken!=null)next.expiresAt=Number.isFinite(patch.expiresAt)?patch.expiresAt:0;
    this.data={...this.data,[provider]:next};fs.mkdirSync(path.dirname(this.file),{recursive:true});fs.writeFileSync(this.file+'.tmp',JSON.stringify(this.data),{encoding:'utf8',mode:0o600});fs.renameSync(this.file+'.tmp',this.file);return this.summary();
  }
  async cookie(provider,api){const saved=this.get(provider).cookie;if(saved)return saved;return this.browser.cookies(api||loginUrls[provider]);}
  async login(provider){this.get(provider);return this.browser.open(loginUrls[provider]);}
  async sync(provider){const cookie=await this.browser.cookies(loginUrls[provider]),tokens=provider==='ali'?await this.browser.loginTokens(loginUrls.ali):{};if(!cookie&&!tokens.refreshToken&&!tokens.accessToken)throw new Error('还未读取到登录状态，请先在独立站点浏览器完成登录');this.set(provider,{...(cookie?{cookie}:{}),...tokens});return this.summary();}
}
module.exports={Accounts,loginUrls};
