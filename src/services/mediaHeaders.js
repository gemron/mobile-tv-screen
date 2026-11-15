const { randomBytes } = require('crypto');
const { cleanHeaders } = require('../content/format');
const contexts = new Map();
const LIFETIME = 6 * 60 * 60 * 1000;

function create(headers) {
  const value = cleanHeaders(headers);
  if (!Object.keys(value).length) return '';
  const id = randomBytes(18).toString('hex');
  contexts.set(id, { value, expires: Date.now() + LIFETIME });
  while (contexts.size > 256) contexts.delete(contexts.keys().next().value);
  return id;
}

function get(id) {
  const item = contexts.get(String(id));
  if (!item || item.expires <= Date.now()) { contexts.delete(String(id)); return null; }
  item.expires = Date.now() + LIFETIME;
  contexts.delete(String(id)); contexts.set(String(id), item);
  return item.value;
}

function mediaUrl(url, headers) {
  const id = create(headers);
  if (!/^https?:/i.test(url)) return `/api/transcode?url=${encodeURIComponent(url)}${id ? `&headerContext=${id}` : ''}`;
  return id ? `/api/proxy?url=${encodeURIComponent(url)}&headerContext=${id}` : url;
}

module.exports = { create, get, mediaUrl };
