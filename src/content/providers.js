const html = require('./html-sites');
const bili = require('./adapters/bili');
const apps = require('./adapters/apps');
const websites = require('./adapters/websites');
const platforms = require('./adapters/platforms');
const protectedApps = require('./adapters/protected-apps');
const cloud = require('./adapters/cloud-sources');
const extras = require('./adapters/extras');
const audiobooks = require('./adapters/audiobooks');
const sports = require('./adapters/sports');
const discovery = require('./adapters/discovery');
const legacy = require('./adapters/legacy-api');
const mdd = require('./adapters/mdd');
const xsSearch = require('./adapters/xs-search');
const xsApps = require('./adapters/xs-apps');
const xsWeb = require('./adapters/xs-web');
const xsDrama = require('./adapters/xs-drama');
const xsApi = require('./adapters/xs-api');
const xsRule = require('./adapters/xs-rule');
const modules = [bili,apps,websites,platforms,protectedApps,cloud,extras,audiobooks,sports,discovery,legacy,mdd,xsSearch,xsApps,xsWeb,xsDrama,xsApi,xsRule,html];
const handlers = new Map();
function provider(site) { const handler = handlers.get(site.adapter); if (!handler) throw new Error('站点适配器尚未注册，请重新导入配置'); return handler; }
module.exports = {
  describe(raw, base) { for (const candidate of modules) { const site = candidate.describe(raw, base); if (site) { handlers.set(site.adapter, candidate); return site; } } return null; },
  async list(site, options, signal) { await syncCookies(site); return provider(site).list(site, options, signal); },
  async detail(site, id, signal) { await syncCookies(site); return provider(site).detail(site, id, signal); },
  async resolve(site, episode, signal) { await syncCookies(site); return provider(site).resolve(site, episode, signal); },
};
async function syncCookies(site) { if(site.browser){const cookies=await site.browser.cookies(site.api);if(cookies)site.headers.cookie=cookies;} }
