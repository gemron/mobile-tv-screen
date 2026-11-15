const { randomBytes } = require('crypto');
const { cleanHeaders } = require('../content/format');
const hmys = require('./hmysTransport');
const contexts = new Map();
const LIFETIME = 6 * 60 * 60 * 1000;

function create(headers, address = '', playlistContext) {
  const value = cleanHeaders(headers);
  const playlist = playlistContext ? hmys.normalize(playlistContext) : null;
  if (!Object.keys(value).length && !playlist) return '';
  const id = randomBytes(18).toString('hex');
  let origin='';try{origin=new URL(address).origin;}catch{}
  contexts.set(id, { value, origin, playlist, expires: Date.now() + LIFETIME });
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

function hasPlaylistContext(id, address) { const item = contexts.get(String(id)); return Boolean(item?.playlist && item.expires > Date.now() && (!address || new URL(address).origin === item.origin)); }
function requestUrl(id, address) { return hasPlaylistContext(id, address) ? hmys.signedUrl(address, contexts.get(String(id)).playlist) : address; }
function cleanPlaylist(id, content, baseUrl) {
  if (!hasPlaylistContext(id, baseUrl)) return content;
  const clean = value => { const url = new URL(value, baseUrl); if (hasPlaylistContext(id, url.href)) { url.search = ''; url.hash = ''; } return url.href; };
  return content.split(/\r?\n/).map(line => {
    const trimmed = line.trim(); if (!trimmed) return line;
    if (trimmed.startsWith('#')) return line.replace(/URI="([^"]+)"/g, (original, uri) => { try { return 'URI="' + clean(uri) + '"'; } catch { return original; } });
    try { return clean(trimmed); } catch { return line; }
  }).join('\n');
}
function mediaUrl(url, headers, audioUrl = '', mimeType = '', playlistContext) {
  if(/^\/api\/library\/torrent\//.test(url))return url;
  const id = create(headers, url, playlistContext);
  if (audioUrl) return `/api/transcode?url=${encodeURIComponent(url)}&audioUrl=${encodeURIComponent(audioUrl)}${id ? `&headerContext=${id}` : ''}`;
  if (!/^https?:/i.test(url)) return `/api/transcode?url=${encodeURIComponent(url)}${id ? `&headerContext=${id}` : ''}`;
  return id || /mpegurl/i.test(mimeType) ? `/api/proxy?url=${encodeURIComponent(url)}${id ? '&headerContext='+id : ''}${/mpegurl/i.test(mimeType)?'&hls=1':''}` : url;
}

module.exports = { create, get, mediaUrl, hasPlaylistContext, requestUrl, cleanPlaylist };
