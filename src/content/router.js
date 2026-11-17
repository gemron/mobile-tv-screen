const express = require('express');
const { Library } = require('./library');

function createLibraryRouter(options) {
  const router = express.Router(), library = new Library(options);
  const task = handler => async (req, res) => {
    try { const result = await handler(req, res); if (!res.destroyed) res.json(result); }
    catch (error) { if (!res.destroyed) res.status(error.status || (error.name === 'AbortError' ? 409 : 502)).json({ error: error.name === 'AbortError' ? '操作已取消或被新的请求替代' : error.message, ...(error.code === 'SOURCE_REGION_BLOCKED' ? { code: error.code } : {}), ...(error.capacityLimited?{capacityLimited:true}:{}),...(error.verifyUrl ? { verifyUrl: error.verifyUrl } : {}),...(error.requiresSave ? {requiresSave:true,saveFile:{...error.saveFile,cleanupMode:library.cloud.cleanup.mode}} : {}) }); }
  };
  const playbackTask = handler => task(async (req, res) => {
    const controller = new AbortController(), cancel = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', cancel);
    try { return await handler(req, controller.signal); }
    finally { res.off('close', cancel); }
  });
  const accountTask = handler => task(async req => { library.cloud.cleanup.invalidate();library.invalidateCloudCache();try { return { accounts: await handler(req) }; } finally { library.cloud.cleanup.invalidate();library.invalidateCloudCache(); } });
  router.get('/config', task(() => library.summary()));
  router.get('/torrent/status', task(() => library.torrents.status()));
  router.get('/torrent/:id/:index/:name', (req,res) => library.torrents.serve(req,res));
  router.get('/accounts', task(() => ({accounts:library.accounts.summary()})));
  router.get('/quark/cleanup', task(() => library.cloud.cleanup.summary()));
  router.post('/quark/cleanup/settings', task(req => library.cloud.cleanup.configure(req.body?.mode)));
  router.post('/quark/cleanup', playbackTask((req,signal) => library.cloud.cleanup.clean('manual',{signal})));
  router.post('/accounts', accountTask(req => library.accounts.set(req.body?.provider,req.body||{})));
  router.post('/accounts/login', task(req => library.accounts.login(req.body?.provider)));
  router.post('/accounts/sync', accountTask(req => library.accounts.sync(req.body?.provider)));
  router.post('/accounts/check', accountTask(req => library.accounts.check(req.body?.provider)));
  router.post('/accounts/logout', accountTask(req => library.accounts.logout(req.body?.provider)));
  router.post('/browser/open', task(req => {const site=library.site(req.body?.siteKey);return library.browser.open(req.body?.verifyUrl||(site.adapter==='bili'?'https://www.bilibili.com/':site.api));}));
  router.get('/site/settings', task(req => library.siteSettings(req.query.site)));
  router.post('/site/settings', task(req => library.saveSiteSettings(req.body||{})));
  router.post('/config', task(req => library.import(req.body?.url, req.body?.name)));
  router.post('/sources/select', task(req => library.selectSource(req.body?.id)));
  router.post('/sources/rename', task(req => library.renameSource(req.body?.id, req.body?.name)));
  router.post('/sources/remove', task(req => library.removeSource(req.body?.id)));
  router.get('/collection', task(() => library.collection.summary()));
  router.post('/favorites', task(req => library.favorite(req.body || {})));
  router.post('/collection/remove', task(req => library.collection.remove(req.body?.kind, req.body?.id, req.body?.clear === true)));
  router.post('/resume', task(req => library.resume(req.body || {})));
  router.get('/home', task(req => library.home(req.query.site)));
  router.get('/list', task(req => {
    let filters = {};
    if(req.query.filters){const raw=String(req.query.filters);if(raw.length>4096)throw Object.assign(new Error('筛选条件过长'),{status:400});try{const value=JSON.parse(raw);if(!value||Array.isArray(value)||typeof value!=='object')throw new Error();filters=Object.fromEntries(Object.entries(value).slice(0,20).map(([k,v])=>[k,String(v).slice(0,200)]));}catch{throw Object.assign(new Error('筛选条件格式无效'),{status:400});}}
    return library.list(req.query.site, { id: String(req.query.category || ''), page: req.query.page, keyword: String(req.query.keyword || ''),filters });
  }));
  router.get('/detail', task(req => library.detail(req.query.site, req.query.id, req.query.refresh === '1')));
  router.get('/search/all', task(req => library.searchAll(req.query.keyword)));
  router.get('/search/stream', async (req, res) => {
    const controller = new AbortController(), abort = () => controller.abort();
    res.on('close', abort);
    res.set({ 'Content-Type': 'text/event-stream; charset=utf-8', 'Cache-Control': 'no-store', 'X-Accel-Buffering': 'no' });
    res.flushHeaders();
    const send = value => { if (!res.destroyed && !controller.signal.aborted) { if (res.writableLength > 1024 * 1024) { controller.abort(); res.end(); } else res.write('data: ' + JSON.stringify(value) + '\n\n'); } };
    try { await library.searchAll(req.query.keyword, { signal: controller.signal, onProgress: send }); }
    catch (error) { if (!controller.signal.aborted) send({ done: true, error: error.message }); }
    finally { res.off('close', abort); if (!res.destroyed) res.end(); }
  });
  router.get('/channels', task(async req => ({ channels: (await library.channels(req.query.source, req.query.refresh === '1')).map(({ id, name, group, logo, urls }) => ({ id, name, group, logo, lines: urls.length })) })));
  router.get('/playback', task(() => ({ playback: library.playbackSummary() })));
  router.post('/play', playbackTask((req, signal) => library.play(req.body || {}, { signal })));
  router.post('/live/play', task(req => library.playLive(req.body || {})));
  router.post('/next', task(req => library.next(req.body?.direction, req.body?.sessionId)));
  router.library = library;
  return router;
}

module.exports = { createLibraryRouter };
