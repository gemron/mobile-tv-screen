const { createHash } = require('crypto');

// The playback API grants a query envelope and signing material for one media
// origin. Keep both on the receiver; each playlist/segment gets a fresh timestamp.
function normalize(context) {
  if (context?.kind !== 'hmys' || typeof context.ck !== 'string' || typeof context.sign !== 'string' || context.ck.length > 4096 || !/^[\x21-\x7e]{16,128}$/.test(context.sign)) throw new Error('海绵播放凭据格式无效，请重新选择剧集');
  let query = context.ck.trim();
  if (query.startsWith('?')) query = query.slice(1);
  if (!/(?:^|&)(?:Time|k|az)=/.test(query)) {
    if (!/^[A-Za-z0-9+/_=-]+$/.test(query)) throw new Error('海绵播放凭据编码无效');
    query = Buffer.from(query, 'base64').toString('utf8').trim();
  }
  if (query.startsWith('?')) query = query.slice(1);
  if (!/(?:^|&)(?:Time|k|az)=/.test(query) || /[\s#\\\x00-\x1f]/.test(query) || query.length > 4096) throw new Error('海绵播放凭据已变化，请更新订阅');
  return { kind: 'hmys', query, sign: context.sign };
}
function signedUrl(address, context, seconds = Math.floor(Date.now() / 1000)) {
  const target = new URL(address), value = context.query ? context : normalize(context);
  if (!['http:', 'https:'].includes(target.protocol) || !Number.isSafeInteger(seconds) || seconds < 0) throw new Error('海绵媒体地址无效');
  const time = seconds.toString(16), secret = createHash('md5').update(value.sign + decodeURIComponent(target.pathname) + time).digest('hex');
  target.hash = ''; target.search = '?' + value.query + '&wsSecret=' + secret + '&wsTime=' + time;
  return target.href;
}
module.exports = { normalize, signedUrl };
