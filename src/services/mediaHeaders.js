const { randomBytes } = require('crypto');
const { cleanHeaders } = require('../content/format');
const contexts = new Map();
const LIFETIME = 6 * 60 * 60 * 1000;

function create(headers, address = '') {
  const value = cleanHeaders(headers);
  if (!Object.keys(value).length) return '';
  const id = randomBytes(18).toString('hex');
  let origin='';try{origin=new URL(address).origin;}catch{}
  contexts.set(id, { value, origin, expires: Date.now() + LIFETIME });
  while (contexts.size > 256) contexts.delete(contexts.keys().next().value);
  return id;
}

function get(id, address = '') {
  const item = contexts.get(String(id));
  if (!item || item.expires <= Date.now()) { contexts.delete(String(id)); return null; }
  item.expires = Date.now() + LIFETIME;
  contexts.delete(String(id)); contexts.set(String(id), item);
  const value={...item.value};
  if(address&&item.origin){try{if(new URL(address).origin!==item.origin){delete value.cookie;delete value.authorization;}}catch{delete value.cookie;delete value.authorization;}}
  return value;
}

function mediaUrl(url, headers, audioUrl = '', mimeType = '') {
  if(/^\/api\/library\/torrent\//.test(url))return url;
  const id = create(headers, url);
  if (audioUrl) return `/api/transcode?url=${encodeURIComponent(url)}&audioUrl=${encodeURIComponent(audioUrl)}${id ? `&headerContext=${id}` : ''}`;
  if (!/^https?:/i.test(url)) return `/api/transcode?url=${encodeURIComponent(url)}${id ? `&headerContext=${id}` : ''}`;
  return id || /mpegurl/i.test(mimeType) ? `/api/proxy?url=${encodeURIComponent(url)}${id ? '&headerContext='+id : ''}${/mpegurl/i.test(mimeType)?'&hls=1':''}` : url;
}

module.exports = { create, get, mediaUrl };
