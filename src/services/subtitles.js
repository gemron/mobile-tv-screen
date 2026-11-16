const fs = require('fs'), path = require('path'), { randomBytes } = require('crypto');
const { resource } = require('../content/http'), { webUrl, cleanHeaders } = require('../content/format');
const { parseSubtitle, subtitleZip, supported } = require('./subtitleFormat');
const failure = (message, status = 400) => Object.assign(new Error(message), { status });
class Subtitles {
  constructor({ dataDir, request = resource, apiBase = 'https://api.assrt.net/', freeApi = 'https://api-shoulei-ssl.xunlei.com/oracle/subtitle' }) {
    this.file = path.join(dataDir, 'subtitles.json'); this.request = request; this.apiBase = apiBase; this.freeApi = freeApi; this.generation = 0; this.sources = []; this.files = new Map(); this.cache = new Map(); this.token = '';
    try { const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (/^[a-z0-9]{32}$/i.test(saved.token)) this.token = saved.token; } catch {}
  }
  effectiveToken() { return this.token || this.subscriptionToken || ''; }
  config() { return { configured: Boolean(this.effectiveToken()), searchAvailable: true, tokenSource: this.token ? 'manual' : this.subscriptionToken ? 'subscription' : 'none', provider: this.effectiveToken() ? 'Assrt' : '迅雷字幕', fallbackProvider: '迅雷字幕', sourceUrl: this.effectiveToken() ? 'https://assrt.net/api/doc' : 'https://www.xunlei.com/' }; }
  invalidateApi() { this.generation++; this.cache.clear(); for (const [id, item] of this.files) if (item.origin !== 'source') this.files.delete(id); }
  setSubscriptionToken(value) { const before = this.effectiveToken(); this.subscriptionToken = typeof value === 'string' && /^[a-z0-9]{32}$/i.test(value) ? value : ''; if (this.effectiveToken() !== before) this.invalidateApi(); }
  configure(token) {
    if (typeof token !== 'string' || token !== '' && !/^[a-z0-9]{32}$/i.test(token.trim())) throw failure('Assrt Token 应为 32 位字母或数字');
    this.token = token.trim(); this.invalidateApi();
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file + '.tmp', JSON.stringify({ token: this.token }), { mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file);
    return this.config();
  }
  current(sessionId, state) { if (!state.url || ['IDLE','STOPPED'].includes(state.status) || Number(sessionId) !== state.sessionId) throw failure('播放已切换，请重新打开字幕面板', 409); }
  reset(sessionId) { if (this.sessionId !== sessionId) { this.sessionId = sessionId; this.generation++; this.sources = []; this.files.clear(); this.cache.clear(); } }
  put(item) {
    const id = randomBytes(15).toString('hex'); this.files.set(id, { ...item, expires: Date.now() + 15 * 60000 });
    while (this.files.size > 300 || [...this.files.values()].reduce((sum, value) => sum + (value.body?.length || 0), 0) > 16 * 1024 * 1024) this.files.delete(this.files.keys().next().value);
    return { id, name: String(item.name || '字幕').slice(0, 240), lang: String(item.lang || '').slice(0, 80) };
  }
  setSources(sessionId, items, base, mediaAddress, defaults = {}) {
    this.reset(sessionId); this.sources = (Array.isArray(items) ? items : []).slice(0, 50).flatMap(item => {
      try {
        if (!item || typeof item !== 'object') return [];
        const url = webUrl(item.url, base), headers = { ...cleanHeaders(defaults), ...cleanHeaders(item.header || item.headers) };
        if (new URL(url).origin !== new URL(mediaAddress).origin) { delete headers.cookie; delete headers.authorization; }
        return [this.put({ origin: 'source', name: item.name || item.lang || '片源字幕', lang: item.lang || '', url, headers })];
      } catch { return []; }
    }); return this.sources;
  }
  async api(action, values, signal) {
    const token = this.effectiveToken(); if (!token) throw failure('订阅未提供 Assrt Token，请在字幕搜索设置中添加', 428);
    const generation = this.generation, target = new URL('v1/sub/' + action, this.apiBase); target.search = new URLSearchParams(values).toString();
    let response; try { response = await this.request(target.href, { headers: { authorization: 'Bearer ' + token }, limit: 2 * 1024 * 1024, timeout: 12000, signal }); } catch (error) { if (signal?.aborted) throw error; throw failure('字幕服务暂时无法访问，请稍后重试', 502); }
    signal?.throwIfAborted();
    if (generation !== this.generation) throw failure('字幕搜索账号已变化，请重试', 409);
    let data; try { data = JSON.parse(response.text); } catch { throw failure('字幕服务返回了无效数据', 502); }
    if (Number(data.status) !== 0) throw failure(({101:'搜索词至少需要 3 个字符',20001:'Assrt Token 无效，请重新设置',30900:'字幕服务请求过于频繁，请稍后重试',20900:'该字幕已不存在'})[Number(data.status)] || '字幕服务暂时未返回可用结果', 502);
    return Array.isArray(data.sub?.subs) ? data.sub.subs.slice(0, 100) : [];
  }
  async search(keyword, position, signal) {
    keyword = String(keyword || '').trim().slice(0, 200); position = Math.max(0, Math.min(3000, Math.floor(Number(position) || 0)));
    if ([...keyword].length < 3) throw failure('请输入至少 3 个字符搜索字幕');
    const key = keyword + ':' + position, cached = this.cache.get(key); if (cached?.expires > Date.now()) return cached.value;
    let raw, notice='';
    if(this.effectiveToken()) {
      try { raw=await this.api('search', { q: keyword, pos: String(position), cnt: '15', filelist: '1' }, signal); }
      catch(error) { signal?.throwIfAborted(); if(error.status===409)throw error; notice='Assrt 暂不可用，已使用免 Token 的迅雷字幕'; }
    }
    const value = raw?.length ? { provider:'Assrt', items: raw.filter(item => Number.isSafeInteger(item.id) && item.id > 0).map(item => ({ id: item.id, name: String(item.native_name || item.title || item.videoname || '字幕').slice(0, 240), lang: String(item.lang?.desc || '').slice(0, 80), format: String(item.subtype || '').slice(0, 60) })), nextPosition: position + raw.length, hasMore: raw.length >= 15 } : await this.freeSearch(keyword,position,signal);
    if(notice)value.notice=notice;
    this.cache.set(key, { value, expires: Date.now() + 5 * 60000 }); while (this.cache.size > 40) this.cache.delete(this.cache.keys().next().value);
    return value;
  }
  async freeSearch(keyword,position,signal) {
    const generation=this.generation,target=new URL(this.freeApi);target.searchParams.set('name',keyword);
    let data;try { const response=await this.request(target.href,{headers:{accept:'application/json'},limit:2*1024*1024,timeout:12000,signal});data=JSON.parse(response.text); }
    catch(error) { signal?.throwIfAborted(); throw failure('免费字幕服务暂时无法访问，可稍后重试或配置 Assrt Token',502); }
    signal?.throwIfAborted();if(generation!==this.generation)throw failure('字幕搜索设置已变化，请重试',409);
    if(Number(data.code)!==0||!Array.isArray(data.data))throw failure('免费字幕服务暂未返回有效结果，请稍后重试',502);
    const rows=data.data.slice(0,300).flatMap(item=>{
      try { const name=String(item.name||item.simple_name||'字幕').slice(0,240),ext=String(item.ext||'').toLowerCase();if(!supported(name)&&!['srt','vtt','ass','ssa'].includes(ext))return [];
        return [{name:supported(name)?name:name+'.'+ext,lang:(Array.isArray(item.languages)?item.languages.join(' / '):'').slice(0,80),url:webUrl(item.url),headers:{},origin:'thunder',format:ext.toUpperCase()}];
      }catch{return [];}
    });
    return {provider:'迅雷字幕',items:rows.slice(position,position+15).map(item=>{const file=this.put(item);return {...file,id:'thunder:'+file.id,format:item.format};}),nextPosition:position+15,hasMore:rows.length>position+15};
  }
  async detail(id, signal) {
    if(typeof id==='string'&&id.startsWith('thunder:')) {
      const key=id.slice(8),item=this.files.get(key);if(!item||item.origin!=='thunder'||item.expires<Date.now())throw failure('字幕结果已过期，请重新搜索',410);
      return {files:[{id:key,name:item.name,lang:item.lang}]};
    }
    id = Number(id); if (!Number.isSafeInteger(id) || id < 1 || id > 1e10) throw failure('字幕编号无效');
    const raw = await this.api('detail', { id: String(id) }, signal), files = [];
    for (const item of raw) {
      let rows = Array.isArray(item.filelist) ? item.filelist : []; if (!rows.some(row => row.url)) rows = [{ f: item.filename || item.native_name, url: item.url }];
      for (const row of rows.slice(0, 100)) if (row.url && (supported(row.f || row.url) || /\.zip(?:[?#]|$)/i.test(row.f || row.url))) {
        try { files.push(this.put({ name: row.f || item.native_name || '字幕', lang: item.lang?.desc || '', url: webUrl(row.url), headers: {} })); } catch {}
      }
    }
    if (!files.length) throw failure('此结果没有可直接读取的文本字幕，RAR、7z 和图像字幕暂不支持');
    return { files };
  }
  async load(id, signal) {
    const item = this.files.get(String(id)); if (!item || item.expires < Date.now()) throw failure('字幕链接已过期，请重新搜索', 410);
    let bytes = item.body;
    if (!bytes) {
      try { bytes = (await this.request(item.url, { headers: item.headers || {}, limit: 8 * 1024 * 1024, timeout: 15000, signal })).body; }
      catch (error) { if (signal?.aborted) throw error; throw failure('字幕文件读取失败，请重试或选择其他字幕', 502); }
    }
    signal?.throwIfAborted(); return this.parse(bytes, item.name, item.lang);
  }
  parse(bytes, name, lang = '') {
    if (bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50 || /\.zip$/i.test(name)) return { files: subtitleZip(bytes).map(item => this.put({ ...item, lang })) };
    return { name: String(name || '字幕').slice(0, 240), lang, cues: parseSubtitle(bytes, name) };
  }
  async fromUrl(url, signal) { const item = this.put({ name: (() => { try { return decodeURIComponent(new URL(webUrl(url)).pathname.split('/').pop()) || '字幕'; } catch { return '字幕'; } })(), url: webUrl(url), headers: {} }); return this.load(item.id, signal); }
}
module.exports = { Subtitles };
