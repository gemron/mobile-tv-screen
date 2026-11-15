const express = require('express');
const { Library } = require('./library');

function createLibraryRouter(options) {
  const router = express.Router(), library = new Library(options);
  const task = handler => async (req, res) => {
    try { const result = await handler(req); if (!res.destroyed) res.json(result); }
    catch (error) { if (!res.destroyed) res.status(error.status || (error.name === 'AbortError' ? 409 : 502)).json({ error: error.name === 'AbortError' ? '操作已取消或被新的请求替代' : error.message, ...(error.verifyUrl ? { verifyUrl: error.verifyUrl } : {}) }); }
  };
  router.get('/config', task(() => library.summary()));
  router.get('/torrent/status', task(() => library.torrents.status()));
  router.get('/torrent/:id/:index/:name', (req,res) => library.torrents.serve(req,res));
  router.get('/accounts', task(() => ({accounts:library.accounts.summary()})));
  router.post('/accounts', task(req => ({accounts:library.accounts.set(req.body?.provider,req.body||{})})));
  router.post('/accounts/login', task(req => library.accounts.login(req.body?.provider)));
  router.post('/accounts/sync', task(async req => ({accounts:await library.accounts.sync(req.body?.provider)})));
  router.post('/browser/open', task(req => {const site=library.site(req.body?.siteKey);return library.browser.open(req.body?.verifyUrl||(site.adapter==='bili'?'https://www.bilibili.com/':site.api));}));
  router.get('/site/settings', task(req => library.siteSettings(req.query.site)));
  router.post('/site/settings', task(req => library.saveSiteSettings(req.body||{})));
  router.post('/config', task(req => library.import(req.body?.url)));
  router.get('/home', task(req => library.home(req.query.site)));
  router.get('/list', task(req => {
    let filters = {};
    if(req.query.filters){const raw=String(req.query.filters);if(raw.length>4096)throw Object.assign(new Error('筛选条件过长'),{status:400});try{const value=JSON.parse(raw);if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();filters=Object.fromEntries(Object.entries(value).slice(0,20).map(([k,v])=>[k,String(v).slice(0,200)]));}catch{throw Object.assign(new Error('筛选条件格式无效'),{status:400});}}
    return library.list(req.query.site, { id: String(req.query.category || ''), page: req.query.page, keyword: String(req.query.keyword || ''),filters });
  }));
  router.get('/detail', task(req => library.detail(req.query.site, req.query.id)));
  router.get('/search/all', task(req => library.searchAll(req.query.keyword)));
  router.get('/channels', task(async req => ({ channels: (await library.channels(req.query.source, req.query.refresh === '1')).map(({ id, name, group, logo, urls }) => ({ id, name, group, logo, lines: urls.length })) })));
  router.get('/playback', task(() => ({ playback: library.playbackSummary() })));
  router.post('/play', task(req => library.play(req.body || {})));
  router.post('/live/play', task(req => library.playLive(req.body || {})));
  router.post('/next', task(req => library.next(req.body?.direction, req.body?.sessionId)));
  router.library = library;
  return router;
}

module.exports = { createLibraryRouter };
