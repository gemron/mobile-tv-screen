const express = require('express');
const { Library } = require('./library');

function createLibraryRouter(options) {
  const router = express.Router(), library = new Library(options);
  const task = handler => async (req, res) => {
    try { const result = await handler(req); if (!res.destroyed) res.json(result); }
    catch (error) { if (!res.destroyed) res.status(error.status || (error.name === 'AbortError' ? 409 : 502)).json({ error: error.name === 'AbortError' ? '操作已取消或被新的请求替代' : error.message }); }
  };
  router.get('/config', task(() => library.summary()));
  router.post('/config', task(req => library.import(req.body?.url)));
  router.get('/home', task(req => library.home(req.query.site)));
  router.get('/list', task(req => library.list(req.query.site, { id: String(req.query.category || ''), page: req.query.page, keyword: String(req.query.keyword || '') })));
  router.get('/detail', task(req => library.detail(req.query.site, req.query.id)));
  router.get('/channels', task(async req => ({ channels: (await library.channels(req.query.source, req.query.refresh === '1')).map(({ id, name, group, logo, urls }) => ({ id, name, group, logo, lines: urls.length })) })));
  router.get('/playback', task(() => ({ playback: library.playbackSummary() })));
  router.post('/play', task(req => library.play(req.body || {})));
  router.post('/live/play', task(req => library.playLive(req.body || {})));
  router.post('/next', task(req => library.next(req.body?.direction, req.body?.sessionId)));
  router.library = library;
  return router;
}

module.exports = { createLibraryRouter };
