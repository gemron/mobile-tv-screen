const express = require('express'), multer = require('multer'), castState = require('./castState');
function createSubtitleRouter(subtitles) {
  const router = express.Router(), upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024, files: 1, fields: 2 } });
  const scoped = handler => async (req, res) => {
    const snapshot = castState.getSnapshot(), sessionId = req.body?.sessionId ?? req.query.sessionId, controller = new AbortController();
    const changed = state => { if (state.sessionId !== snapshot.sessionId || !state.url || ['IDLE','STOPPED'].includes(state.status)) controller.abort(); };
    const disconnected = () => { if (!res.writableEnded) controller.abort(); };
    try {
      subtitles.current(sessionId, snapshot); subtitles.reset(snapshot.sessionId); castState.on('stateChange', changed); res.on('close', disconnected);
      const result = await handler(req, controller.signal); controller.signal.throwIfAborted(); subtitles.current(sessionId, castState.getSnapshot());
      if (!res.destroyed) res.json({ ...result, sessionId: snapshot.sessionId });
    } catch (error) { if (!res.destroyed) res.status(controller.signal.aborted ? 409 : error.status || 400).json({ error: controller.signal.aborted ? '播放或字幕选择已变化，请重试' : error.message }); }
    finally { castState.off('stateChange', changed); res.off('close', disconnected); }
  };
  router.get('/config', (_, res) => res.json(subtitles.config()));
  router.post('/config', (req, res) => { try { res.json(subtitles.configure(req.body?.token)); } catch (error) { res.status(error.status || 400).json({ error: error.message }); } });
  router.get('/list', scoped(() => ({ files: subtitles.sources, ...subtitles.config() })));
  router.post('/search', scoped((req, signal) => subtitles.search(req.body.keyword, req.body.position, signal)));
  router.post('/detail', scoped((req, signal) => subtitles.detail(req.body.id, signal)));
  router.post('/load', scoped((req, signal) => subtitles.load(req.body.id, signal)));
  router.post('/url', scoped((req, signal) => subtitles.fromUrl(req.body.url, signal)));
  router.post('/upload', (req, res, next) => upload.single('file')(req, res, error => error ? res.status(400).json({ error: '字幕文件超过 8 MiB 或上传格式无效' }) : next()), scoped(req => {
    if (!req.file) throw new Error('请选择字幕文件');
    return subtitles.parse(req.file.buffer, Buffer.from(req.file.originalname, 'latin1').toString('utf8'));
  }));
  return router;
}
module.exports = { createSubtitleRouter };
