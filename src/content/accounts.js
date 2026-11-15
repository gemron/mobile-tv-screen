const fs = require('fs');
const path = require('path');
const loginUrls = { quark: 'https://pan.quark.cn/', uc: 'https://drive.uc.cn/', ali: 'https://www.alipan.com/', baidu: 'https://pan.baidu.com/' };
const apiUrls = { quark: 'https://drive-pc.quark.cn/', uc: 'https://pc-api.uc.cn/', ali: 'https://api.aliyundrive.com/', baidu: 'https://pan.baidu.com/' };
const logoutScopes = { quark: ['https://quark.cn', loginUrls.quark, apiUrls.quark], uc: ['https://uc.cn', loginUrls.uc, apiUrls.uc], ali: ['https://alipan.com', 'https://aliyundrive.com', loginUrls.ali, apiUrls.ali], baidu: ['https://baidu.com', loginUrls.baidu] };
class Accounts {
  constructor(directory, browser) {
    this.file = path.join(directory, 'cloud-accounts.json'); this.browser = browser; this.versions = new Map();
    try { this.data = JSON.parse(fs.readFileSync(this.file, 'utf8')); } catch { this.data = {}; }
    if(!this.data||Array.isArray(this.data)||typeof this.data!=='object')this.data={};
  }
  summary() {
    return Object.entries(loginUrls).map(([provider, url]) => {
      const value = this.get(provider);
      return { provider, url, configured: Boolean(value.cookie || value.accessToken || value.refreshToken), hasCookie: Boolean(value.cookie), hasToken: Boolean(value.accessToken || value.refreshToken), checkedAt: value.checkedAt || 0, valid: value.valid === true, status: value.status || 'unchecked' };
    });
  }
  get(provider) { if (!Object.hasOwn(loginUrls, provider)) throw Object.assign(new Error('不支持的网盘类型'), { status: 400 }); return { ...this.data[provider] }; }
  set(provider, patch, verification) {
    const next = this.get(provider);
    for (const key of ['cookie', 'accessToken', 'refreshToken']) if (patch[key] != null) {
      const value = String(patch[key]).trim();
      if (value.length > (key === 'cookie' ? 16000 : 8192) || /[\r\n\0]/.test(value)) throw Object.assign(new Error('账号信息格式或长度不符合要求'), { status: 400 });
      if (value) next[key] = value; else delete next[key];
    }
    if (patch.accessToken != null) next.expiresAt = Number.isFinite(patch.expiresAt) ? patch.expiresAt : 0;
    Object.assign(next, verification || { checkedAt: 0, valid: false, status: 'unchecked' });
    const data = { ...this.data, [provider]: next };
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file + '.tmp', JSON.stringify(data), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); this.data = data; this.versions.set(provider,(this.versions.get(provider)||0)+1);
    return this.summary();
  }
  async cookie(provider, api) { const saved = this.get(provider).cookie; if (saved) return saved; return this.browser.cookies(api || apiUrls[provider]); }
  async login(provider) { this.get(provider); return this.browser.open(loginUrls[provider]); }
  async validate(provider, candidate, signal) {
    if (!this.validator) throw new Error('账号检查服务尚未初始化');
    const deadline = signal ? AbortSignal.any([signal, AbortSignal.timeout(12000)]) : AbortSignal.timeout(12000);
    return this.validator(provider, candidate, deadline);
  }
  async check(provider, signal) {
    const saved = this.get(provider);
    const version=this.versions.get(provider)||0;
    if (!saved.cookie && !saved.accessToken && !saved.refreshToken) throw Object.assign(new Error('尚未保存账号，请先登录并同步浏览器登录状态'), { status: 428 });
    try { const checked = await this.validate(provider, saved, signal); if((this.versions.get(provider)||0)!==version)throw Object.assign(new Error('账号已切换，请重新检查'),{status:409});return this.set(provider, checked, { checkedAt: Date.now(), valid: true, status: 'verified' }); }
    catch (error) { if((this.versions.get(provider)||0)===version)this.set(provider, {}, { checkedAt: Date.now(), valid: false, status: error.status === 428 ? 'expired' : 'unavailable' }); throw error; }
  }
  async sync(provider, signal) {
    this.get(provider);
    const version=this.versions.get(provider)||0;await this.browser.start?.();
    const [pageCookies, apiCookies, tokens] = await Promise.all([this.browser.cookies(loginUrls[provider]), this.browser.cookies(apiUrls[provider]), provider === 'ali' ? this.browser.loginTokens(loginUrls.ali) : {}]);
    const cookies = new Map();
    for (const item of (pageCookies + '; ' + apiCookies).split(';')) { const at = item.indexOf('='); if (at > 0) cookies.set(item.slice(0, at).trim(), item.slice(at + 1).trim()); }
    const cookie = [...cookies].map(([key, value]) => key + '=' + value).join('; ');
    if (!cookie && !tokens.refreshToken && !tokens.accessToken) throw Object.assign(new Error('浏览器尚未登录，请先在官方页面完成登录'), { status: 428 });
    // Do not replace a working saved account with anonymous browser cookies.
    const candidate = { cookie, ...tokens }, checked = await this.validate(provider, candidate, signal);
    if((this.versions.get(provider)||0)!==version)throw Object.assign(new Error('账号已切换，本次同步已取消'),{status:409});
    return this.set(provider, { cookie: '', accessToken: '', refreshToken: '', ...checked }, { checkedAt: Date.now(), valid: true, status: 'verified' });
  }
  async logout(provider) { this.get(provider); this.versions.set(provider,(this.versions.get(provider)||0)+1);await this.browser.clearLogin(logoutScopes[provider]); return this.set(provider, { cookie: '', accessToken: '', refreshToken: '' }); }
}
module.exports = { Accounts, loginUrls, apiUrls };
