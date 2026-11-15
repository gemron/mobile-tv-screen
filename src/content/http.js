const { createGunzip, createBrotliDecompress, createInflate } = require('zlib');
const { openUpstreamStream } = require('../services/proxy');
const { webUrl, MAX_DOCUMENT, cleanHeaders } = require('./format');

async function resource(address, { headers = {}, signal, limit = MAX_DOCUMENT, timeout = 20000 } = {}) {
  const url = webUrl(address);
  const deadline = AbortSignal.timeout(timeout);
  const combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const requestHeaders = { 'user-agent': 'okhttp/4.12.0', accept: '*/*', 'accept-encoding': 'identity', ...cleanHeaders(headers) };
  const { upRes, finalUrl } = await openUpstreamStream(url, requestHeaders, 5, combined);
  if (upRes.statusCode < 200 || upRes.statusCode >= 300) { upRes.destroy(); throw new Error(`远端接口返回 HTTP ${upRes.statusCode}`); }
  const encoding = String(upRes.headers['content-encoding'] || '').toLowerCase();
  let stream = upRes;
  if (encoding === 'gzip') stream = upRes.pipe(createGunzip());
  else if (encoding === 'br') stream = upRes.pipe(createBrotliDecompress());
  else if (encoding === 'deflate') stream = upRes.pipe(createInflate());
  if (stream !== upRes) upRes.once('error', error => stream.destroy(error));
  const chunks = []; let size = 0;
  try {
    for await (const chunk of stream) {
      size += chunk.length;
      if (size > limit) throw new Error(`远端响应超过 ${Math.round(limit / 1024 / 1024)} MiB 限制`);
      chunks.push(Buffer.from(chunk));
    }
    const body = Buffer.concat(chunks);
    const charset = /charset\s*=\s*["']?([^;\s"']+)/i.exec(String(upRes.headers['content-type'] || ''))?.[1] || 'utf-8';
    let text;
    try { text = new TextDecoder(charset).decode(body); } catch { text = body.toString('utf8'); }
    return { body, text, url: finalUrl, headers: upRes.headers };
  } finally { if (stream !== upRes) stream.destroy(); upRes.destroy(); }
}

module.exports = { resource };

async function postResource(address, body, { headers = {}, signal, timeout = 20000, contentType = 'application/json' } = {}) {
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeout)]) : AbortSignal.timeout(timeout);
  const requestHeaders = cleanHeaders(headers);
  const multipart = body instanceof FormData;
  if (multipart) delete requestHeaders['content-type']; else requestHeaders['content-type'] = contentType;
  const response = await fetch(webUrl(address), { method: 'POST', headers: requestHeaders, body: multipart || typeof body === 'string' ? body : JSON.stringify(body), signal: combined, redirect: 'error' });
  if (!response.ok) { await response.body?.cancel(); throw new Error(`远端接口返回 HTTP ${response.status}`); }
  const chunks = []; let size = 0;
  for await (const chunk of response.body) {
    size += chunk.length;
    if (size > MAX_DOCUMENT) throw new Error('解析接口响应超过大小限制');
    chunks.push(chunk);
  }
  const buffer = Buffer.concat(chunks);
  return { body: buffer, text: buffer.toString('utf8'), url: response.url, headers: Object.fromEntries(response.headers) };
}
module.exports.postResource = postResource;
module.exports.postJson = async (url, body, options) => JSON.parse((await postResource(url, body, options)).text);
