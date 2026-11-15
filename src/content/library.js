const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');
const { resource } = require('./http');
const { decodeDocument, webUrl, cleanHeaders } = require('./format');
const { parseLive } = require('./live');
const catalog = require('./catalog');
const mediaHeaders = require('../services/mediaHeaders');
const { DATA_DIR } = require('../utils/paths');
const castState = require('../services/castState');
const { SourceBrowser } = require('./browser');
const { SourceMaterial } = require('./material');
const { RuntimeData } = require('./runtime-data');
const { Accounts } = require('./accounts');
const { Cloud } = require('./cloud');
const { Torrents } = require('./torrents');

const idFor = value => createHash('sha256').update(String(value)).digest('hex').slice(0, 16);
const failure = (message, status = 400) => Object.assign(new Error(message), { status });

class Library {
  constructor({ dataDir = DATA_DIR, fetchResource = resource, adFilter } = {}) {
    this.adFilter = adFilter;
    this.file = path.join(dataDir, 'library-config.json');
    this.overridesFile = path.join(dataDir, 'library-overrides.json'); this.overrides = {};
    try { this.overrides = JSON.parse(fs.readFileSync(this.overridesFile, 'utf8')); } catch {}
    this.browser = new SourceBrowser(dataDir);
    this.runtime = new RuntimeData(dataDir);
    this.accounts = new Accounts(dataDir,this.browser); this.cloud = new Cloud(this.accounts,this.browser);
    this.accounts.validator = (provider,credentials,signal) => this.cloud.checkAccount(provider,credentials,signal);
    this.torrents = new Torrents(dataDir);
    this.onCastChange = state => {
      if (this.torrents.active?.selected >= 0 && (state.protocol !== 'Library' || !state.url.startsWith('/api/library/torrent/') || ['IDLE', 'STOPPED'].includes(state.status))) this.torrents.stop().catch(() => {});
    };
    castState.on('stateChange', this.onCastChange);
    this.fetchResource = fetchResource;
    this.config = null; this.sites = []; this.liveSources = []; this.parsers = []; this.repositories = [];
    this.cache = new Map(); this.cacheBytes = 0; this.generation = 0; this.playback = null; this.importController = null; this.playController = null;
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (stored.version === 1 && stored.document && stored.url) this.apply(stored.document, stored.url, stored.importedAt);
    } catch { /* A missing or invalid saved source does not stop casting. */ }
  }

  apply(document, url, importedAt = Date.now()) {
    if (!document || typeof document !== 'object' || Array.isArray(document) || !['sites', 'lives', 'live', 'urls'].some(key => Array.isArray(document[key]))) throw failure('未找到点播站点、直播列表或配置仓');
    this.config = { url, importedAt, document };
    this.adFilter?.setSubscription(document);
    this.sites = (document.sites || []).filter(site => site && typeof site === 'object').slice(0, 300).map((site, index) => catalog.describeSite(site, url, index));
    const seen = new Set(); this.sites = this.sites.filter(site => { if (seen.has(site.key)) return false; seen.add(site.key); return true; });
    const material = new SourceMaterial(document.spider, url);
    for (const site of this.sites) {
      site.browser = this.browser;
      site.material = material;
      site.accounts = this.accounts; site.cloud = this.cloud;
      site.parseFlags = Array.isArray(document.flags) ? document.flags.map(String).slice(0,100) : [];
      site.torrents = this.torrents;
      const override = this.overrides?.[site.key];
      if (override?.endpoint) { site.api = override.endpoint; site.endpointOverride = true; site.headers.referer = new URL(override.endpoint).origin + '/'; }
      if (override?.cookie) site.headers.cookie = override.cookie;
      site.runtime = this.runtime?.scope(site.adapter || site.implementation, site.api);
    }
    this.liveSources = (document.lives || document.live || []).filter(item => item && typeof item === 'object').slice(0, 200).map((item, index) => {
      const source = { key: idFor(index + ':' + (item.name || item.url)), name: String(item.name || `直播源 ${index + 1}`), headers: cleanHeaders({ ...(item.header || item.headers || {}), ...(item.ua ? { 'user-agent': item.ua } : {}) }), channels: Array.isArray(item.channels) ? item.channels : null, supported: true };
      try {
        if (item.url) source.url = webUrl(item.url, url);
        if (source.url && ['127.0.0.1', 'localhost', '[::1]'].includes(new URL(source.url).hostname) && new URL(source.url).pathname === '/proxy') { source.supported = false; source.reason = '这个频道组依赖尚未移植的 Android 插件本地代理'; }
        if (!source.url && !source.channels) throw new Error('直播源没有频道或地址');
      } catch (error) { source.supported = false; source.reason = error.message; }
      return source;
    });
    this.parsers = (document.parses || []).slice(0, 100).flatMap((item, index) => {
      try {
        const type=Number(item.type||0),supported=[0,1].includes(type);
        const parserUrl=item.url?webUrl(item.url,url):[0,4].includes(type)?'':webUrl(item.url);
        return [{key:String(index),name:String(item.name||`解析器 ${index+1}`),type,url:parserUrl,headers:cleanHeaders(item.ext?.header||item.header),flags:Array.isArray(item.ext?.flag)?item.ext.flag.map(String):[],supported,reason:supported?'':[2,3].includes(type)?'依赖 Android 扩展解析器，尚未移植':type===4?'聚合解析尚未实现':'未知解析器类型'}];
      } catch { return []; }
    });
    this.repositories = (document.urls || []).slice(0, 100).flatMap(item => { try { return [{ name: String(item.name || item.url), url: webUrl(item.url, url) }]; } catch { return []; } });
    this.cache.clear(); this.cacheBytes = 0; this.generation++;
    this.playController?.abort();
  }

  summary() {
    return { url: this.config?.url || '', importedAt: this.config?.importedAt || null, sites: this.sites.map(({ key, name, type, supported, reason, implementation }) => ({ key, name, type, supported, reason, implementation })), lives: this.liveSources.map(({ key, name, supported, reason }) => ({ key, name, supported, reason })), parsers: this.parsers.map(({ key, name, type, supported, reason }) => ({ key, name, type, supported, reason })), repositories: this.repositories, implementation: 'nodejs' };
  }

  siteSettings(key) {
    const site = this.sites.find(value => value.key === String(key));
    if (!site) throw failure('站点不存在', 404);
    const value = this.overrides[site.key] || {};
    return { siteKey: site.key, name: site.name, endpoint: value.endpoint || site.api, hasCookie: Boolean(value.cookie), browser: Boolean(this.browser) };
  }

  saveSiteSettings({siteKey, endpoint, cookie}) {
    this.siteSettings(siteKey);
    const next = {...this.overrides[siteKey]};
    if (endpoint != null) { if (String(endpoint).trim()) next.endpoint = webUrl(endpoint); else delete next.endpoint; }
    if (cookie != null) { if (String(cookie).length > 16000 || /[\r\n\0]/.test(cookie)) throw failure('Cookie 格式或长度不符合要求'); if(cookie)next.cookie=String(cookie);else delete next.cookie; }
    const overrides = {...this.overrides,[siteKey]:next};
    fs.mkdirSync(path.dirname(this.overridesFile),{recursive:true});
    fs.writeFileSync(this.overridesFile+'.tmp',JSON.stringify(overrides),{encoding:'utf8',mode:0o600});fs.renameSync(this.overridesFile+'.tmp',this.overridesFile);
    this.overrides = overrides;
    if(this.config)this.apply(this.config.document,this.config.url,this.config.importedAt);
    return this.siteSettings(siteKey);
  }

  async import(address) {
    const url = webUrl(address);
    this.importController?.abort();
    const controller = this.importController = new AbortController();
    const response = await this.fetchResource(url, { signal: controller.signal });
    let document;
    if (/^\s*#EXTM3U|#genre#/i.test(response.text)) document = { lives: [{ name: '直播列表', url: response.url || url }] };
    else {
      document = decodeDocument(response.body);
      if (Array.isArray(document)) document = { lives: [{ name: '直播列表', channels: document }] };
    }
    if (controller !== this.importController || controller.signal.aborted) throw failure('已被新的配置导入替代', 409);
    // Validate using an independent instance before replacing a working source.
    const staging = Object.create(Library.prototype);
    staging.cache = new Map(); staging.cacheBytes = 0; staging.generation = 0;
    staging.apply(document, response.url || url);
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const importedAt = Date.now(), temporary = this.file + '.tmp';
    fs.writeFileSync(temporary, JSON.stringify({ version: 1, url: response.url || url, importedAt, document }), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(temporary, this.file);
    this.apply(document, response.url || url, importedAt);
    this.playback = null;
    return this.summary();
  }

  site(key) {
    const site = this.sites.find(value => value.key === String(key));
    if (!site) throw failure('站点不存在，请重新导入配置', 404);
    if (!site.supported) throw failure(site.reason, 422);
    return site;
  }

  async cached(key, ttl, load) {
    const existing = this.cache.get(key);
    if (existing && existing.expires > Date.now()) { this.cache.delete(key); this.cache.set(key, existing); return existing.data; }
    if (existing) { this.cacheBytes -= existing.bytes; this.cache.delete(key); }
    const generation = this.generation, data = await load();
    if (generation !== this.generation) throw failure('配置已切换，请重新选择', 409);
    const bytes = Buffer.byteLength(JSON.stringify(data));
    if (bytes <= 4 * 1024 * 1024) {
      const replaced = this.cache.get(key);
      if (replaced) { this.cacheBytes -= replaced.bytes; this.cache.delete(key); }
      while ((this.cacheBytes + bytes > 16 * 1024 * 1024 || this.cache.size >= 32) && this.cache.size) {
        const oldest = this.cache.keys().next().value; this.cacheBytes -= this.cache.get(oldest).bytes; this.cache.delete(oldest);
      }
      this.cache.set(key, { data, bytes, expires: Date.now() + ttl }); this.cacheBytes += bytes;
    }
    return data;
  }

  home(key) { const site = this.site(key); return this.cached('home:' + key, 120000, () => catalog.home(site)); }
  list(key, options) { const site = this.site(key); return this.cached('list:' + key + JSON.stringify(options), 60000, () => catalog.category(site, options)); }
  detail(key, id) { const site = this.site(key); return this.cached('detail:' + key + ':' + id, 300000, () => catalog.detail(site, id)); }

  async searchAll(keyword) {
    keyword = String(keyword || '').trim().slice(0, 200);
    if (!keyword) throw failure('请输入片名');
    const sources = this.sites.filter(site => site.supported && !/^(cloud-|sports-|discovery-|yueting)/.test(site.adapter || '') && !['huya','douyu','alllive','xiaobei','extra-Kanqiu','extra-Music','extra-XPath','extra-YGP','extra-SixV'].includes(site.adapter));
    const deadline = AbortSignal.timeout(15000), results = [], errors = []; let cursor = 0;
    const worker = async () => {
      while (cursor < sources.length && !deadline.aborted) {
        const site = sources[cursor++];
        try {
          const data = await catalog.category(site, { keyword, page: 1 }, AbortSignal.any([deadline, AbortSignal.timeout(6000)]));
          for (const item of data.list.slice(0, 20)) results.push({ ...item, siteKey: site.key, sourceName: site.name });
        } catch (error) { errors.push({ siteKey: site.key, name: site.name, error: error.message }); }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
    return { list: results.slice(0, 300), errors, page: 1, pageCount: 1, notice: results.length ? `在导入的源中找到 ${results.length} 个结果，请核对片名和年份后选择。` : '本次未找到片源，可切换站点单独搜索或稍后重试。' };
  }

  async channels(key, refresh = false) {
    const source = this.liveSources.find(item => item.key === String(key));
    if (!source) throw failure('直播源不存在', 404);
    if (!source.supported) throw failure(source.reason, 422);
    const cacheKey = 'live:' + key;
    if (refresh) { const old = this.cache.get(cacheKey); if (old) this.cacheBytes -= old.bytes; this.cache.delete(cacheKey); }
    return this.cached(cacheKey, 5 * 60 * 1000, async () => {
      const response = source.channels ? { text: JSON.stringify(source.channels), url: this.config.url } : await this.fetchResource(source.url, { headers: source.headers });
      const channels = parseLive(response.text, response.url, source.headers);
      if (!channels.length) throw new Error('直播源未返回可识别频道，支持 M3U、TXT 和 JSON 分组列表');
      return channels;
    });
  }

  playbackSummary() {
    const current = castState.getSnapshot();
    if (!this.playback || this.playback.sessionId !== current.sessionId || ['IDLE', 'STOPPED'].includes(current.status)) return null;
    const { kind, siteKey, vodId, title, line, index, sourceKey, channelId, channelLine, episodes, channels, parserKey, qualities, quality } = this.playback;
    return { kind, siteKey, vodId, title, line, index, sourceKey, channelId, channelLine, episodes, channels, parserKey, qualities, quality, sessionId: this.playback.sessionId };
  }

  async play({ siteKey, vodId, line = 0, index = 0, parserKey = '', quality, resumePosition = 0, sessionId }) {
    if(sessionId!=null&&Number(sessionId)!==castState.getSnapshot().sessionId)throw failure('播放已切换，本次画质选择已取消',409);
    this.playController?.abort();
    const controller = this.playController = new AbortController(), generation = this.generation, previousSession = castState.getSnapshot().sessionId;
    const site = this.site(siteKey), video = await this.detail(siteKey, vodId);
    const group = video.lines[Number(line)], episode = group?.episodes[Number(index)];
    if (!episode) throw failure('所选播放线路或剧集不存在');
    const resolved = await catalog.resolve(site, group, episode, this.parsers, parserKey, controller.signal,{quality});
    if (controller.signal.aborted || generation !== this.generation || controller !== this.playController || previousSession !== castState.getSnapshot().sessionId) throw failure('已被新的播放操作替代', 409);
    const state = castState.setMedia({ url: mediaHeaders.mediaUrl(resolved.url, resolved.headers, resolved.audioUrl, resolved.mimeType), protocol: 'Library', mediaType: 'video', metadata: { title: video.title + ' · ' + episode.name, artist: site.name, artwork: video.picture, mimeType: resolved.mimeType, isLive: resolved.isLive }, clientName: '电脑独立点播', autoPlay: true,startPosition:Math.max(0,Math.min(604800,Number(resumePosition)||0)),startPositionUnit:'seconds' });
    this.playback = { kind: 'vod', siteKey, vodId, title: video.title, line: Number(line), index: Number(index), parserKey, qualities:resolved.qualities,quality:resolved.quality,episodes: group.episodes.map(item => item.name), sessionId: state.sessionId };
    return { state, playback: this.playbackSummary() };
  }

  async playLive({ sourceKey, channelId, line = 0 }) {
    this.playController?.abort();
    const controller = this.playController = new AbortController(), generation = this.generation, previousSession = castState.getSnapshot().sessionId;
    const channels = await this.channels(sourceKey), channel = channels.find(item => item.id === channelId), selected = channel?.urls[Number(line)];
    if (!selected) throw failure('频道或播放线路不存在');
    if (generation !== this.generation || controller !== this.playController || previousSession !== castState.getSnapshot().sessionId) throw failure('已被新的播放操作替代', 409);
    const state = castState.setMedia({ url: mediaHeaders.mediaUrl(selected.url, selected.headers), protocol: 'Live', mediaType: 'video', metadata: { title: channel.name, artist: channel.group, artwork: channel.logo, mimeType: /^https?:/i.test(selected.url) ? catalog.mediaHint(selected.url) : '', isLive: true }, clientName: '电脑独立直播', autoPlay: true });
    this.playback = { kind: 'live', title: channel.name, sourceKey, channelId, channelLine: Number(line), channels: channels.map(item => ({ id: item.id, name: item.name, lines: item.urls.length })), sessionId: state.sessionId };
    return { state, playback: this.playbackSummary() };
  }

  async next(direction = 1, expectedSessionId) {
    const current = this.playback;
    if (!this.playbackSummary() || (expectedSessionId != null && Number(expectedSessionId) !== current.sessionId)) throw failure('当前播放已经切换', 409);
    const step = Number(direction) < 0 ? -1 : 1;
    if (current.kind === 'vod') {
      const index = current.index + step;
      if (index < 0 || index >= current.episodes.length) throw failure('已经到达剧集边界', 409);
      return this.play({ ...current, index,quality:undefined });
    }
    const index = current.channels.findIndex(item => item.id === current.channelId);
    const next = current.channels[(index + step + current.channels.length) % current.channels.length];
    return this.playLive({ sourceKey: current.sourceKey, channelId: next.id });
  }

  close() { castState.off('stateChange',this.onCastChange); this.importController?.abort(); this.playController?.abort(); this.cache.clear(); this.cacheBytes = 0; return Promise.allSettled([this.browser.close(),this.torrents.close()]); }
}

module.exports = { Library };
