const { createHash } = require('crypto');
const { cleanHeaders } = require('./format');

function channelId(group, name, urls) { return createHash('sha256').update(JSON.stringify([group, name, urls])).digest('hex').slice(0, 20); }
function mediaUrl(value, base) {
  const url = new URL(String(value || '').trim(), base);
  if (!['http:', 'https:', 'rtsp:', 'rtmp:', 'udp:'].includes(url.protocol) || url.username || url.password) return '';
  return url.href;
}

function parseLive(text, baseUrl, defaultHeaders = {}) {
  const channels = [];
  const add = (name, group, values, headers = {}, logo = '') => {
    const urls = [];
    for (const value of Array.isArray(values) ? values : [values]) {
      try {
        const raw = typeof value === 'object' ? value.url : value;
        if (!raw) continue;
        const [address, opts] = String(raw).split('|', 2);
        const extra = {};
        if (opts) for (const [key, val] of new URLSearchParams(opts)) extra[key] = val;
        const url = mediaUrl(address, baseUrl);
        if (url) urls.push({ url, headers: cleanHeaders({ ...defaultHeaders, ...headers, ...extra }) });
      } catch { /* Skip an individual invalid channel URL. */ }
    }
    if (!urls.length || channels.length >= 10000) return;
    let picture = '';
    try { if (logo) picture = mediaUrl(logo, baseUrl); } catch {}
    const title = String(name || '未命名频道').slice(0, 200), category = String(group || '未分组').slice(0, 100);
    channels.push({ id: channelId(category, title, urls.map(value => value.url)), name: title, group: category, logo: picture, urls });
  };
  const raw = String(text).replace(/^\uFEFF/, '').trim();
  if (/^[\[{]/.test(raw)) {
    const value = JSON.parse(raw);
    const walk = (items, group = '') => {
      for (const item of Array.isArray(items) ? items : []) {
        if (!item || typeof item !== 'object') continue;
        const children = item.channels || item.data;
        if (Array.isArray(children)) walk(children, item.group || item.groupTitle || item.name || group);
        else add(item.name || item.channel || item.title, item.group || item.groupTitle || group, item.urls || item.url, item.headers || {}, item.logo || item.tvgLogo);
      }
    };
    walk(Array.isArray(value) ? value : value.channels || value.data || value.groups || []);
  } else if (/^#EXTM3U/i.test(raw)) {
    if (/^#EXT-X-(?:TARGETDURATION|STREAM-INF|MEDIA-SEQUENCE):/m.test(raw)) {
      add('直播频道', '未分组', baseUrl);
      return channels;
    }
    let entry = null;
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (line.startsWith('#EXTINF:')) {
        const attributes = {};
        for (const match of line.matchAll(/([\w-]+)="([^"]*)"/g)) attributes[match[1]] = match[2];
        const comma = /,(?=(?:[^"]*"[^"]*")*[^"]*$)/.exec(line);
        entry = { name: (comma ? line.slice(comma.index + 1).trim() : '') || attributes['tvg-name'], group: attributes['group-title'], logo: attributes['tvg-logo'], headers: {} };
      } else if (/^#EXTVLCOPT:/i.test(line) && entry) {
        const option = line.slice(line.indexOf(':') + 1), equals = option.indexOf('=');
        const key = option.slice(0, equals).toLowerCase();
        if (key === 'http-user-agent') entry.headers['user-agent'] = option.slice(equals + 1);
        if (key === 'http-referrer' || key === 'http-referer') entry.headers.referer = option.slice(equals + 1);
      } else if (line && !line.startsWith('#')) {
        if (entry) add(entry.name, entry.group, line, entry.headers, entry.logo);
        entry = null;
      }
    }
  } else {
    let group = '未分组';
    for (const rawLine of raw.split(/\r?\n/)) {
      const line = rawLine.trim(), comma = line.indexOf(',');
      if (comma < 0 || line.startsWith('#')) continue;
      const name = line.slice(0, comma).trim(), value = line.slice(comma + 1).trim();
      if (value.toLowerCase() === '#genre#') group = name;
      else add(name, group, value.split('#'));
    }
  }
  const merged = new Map();
  for (const channel of channels) {
    const key = channel.group + '\n' + channel.name;
    const previous = merged.get(key);
    if (!previous) merged.set(key, channel);
    else for (const line of channel.urls) if (!previous.urls.some(value => value.url === line.url)) previous.urls.push(line);
  }
  return [...merged.values()];
}

module.exports = { parseLive, mediaUrl };
