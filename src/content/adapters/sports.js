const crypto = require('crypto');
const { resource, postResource } = require('../http');
const { json, cleanHeaders, webUrl } = require('../format');
const definitions = { LiveGz: 'https://api.5h5hbfhh.com/', Doubao: 'https://www.doubaozhibo.com/' };
function describe(raw) {
  const plugin = /^csp_(\w+?)(?:Guard)?$/.exec(raw.api)?.[1]; if (!definitions[plugin]) return null;
  return { plugin, adapter: 'sports-' + plugin, api: raw.ext?.siteUrl || definitions[plugin], supported: true, implementation: 'node-' + plugin.toLowerCase(), headers: cleanHeaders({ 'user-agent': 'okhttp/3.12.0', 'client-version': '3.0.4.0', ...raw.header, ...raw.headers }) };
}
function crypt(value, encrypt) {
  const transform = encrypt ? crypto.createCipheriv : crypto.createDecipheriv;
  const cipher = transform('aes-128-cbc', Buffer.from('KANGEQIU@8868!~.'), Buffer.from('0200010900030207'));
  return Buffer.concat([cipher.update(Buffer.from(value, encrypt ? 'utf8' : 'base64')), cipher.final()]).toString(encrypt ? 'base64' : 'utf8');
}
async function gz(site, path, body, signal) {
  const response = json((await postResource(new URL(path + '?parameter=key', site.api).href, new URLSearchParams({ parameter: crypt(JSON.stringify(body), true) }).toString(), { contentType: 'application/x-www-form-urlencoded', headers: site.headers, signal, timeout: 10000 })).text);
  if (!response.data) throw new Error(response.message || response.msg || '体育接口没有返回内容');
  return typeof response.data === 'string' ? json(crypt(response.data, false)) : response.data;
}
async function db(site, path, signal) {
  const result = json((await resource(new URL(path, site.api).href, { headers: { ...site.headers, origin: new URL(site.api).origin, referer: site.api }, signal, timeout: 10000 })).text);
  if (!result.success) throw new Error(result.message || '赛事接口暂时不可用'); return result.data;
}
const encoded = data => 'sports:' + Buffer.from(JSON.stringify(data)).toString('base64url');
const unpack = value => json(Buffer.from(value.slice(7), 'base64url').toString());
async function list(site, { id = '', page = 1, keyword = '' } = {}, signal) {
  if (site.plugin === 'LiveGz') {
    const classes = [['0-0-0', '全部赛事'], ['0-0-1', '足球'], ['0-0-2', '篮球']].map(([type_id, type_name]) => ({ type_id, type_name }));
    const [hot = '0', tag = '0', type = '0'] = (id || '0-0-0').split('-');
    const rows = await gz(site, '/gz/live/sports', { frame: '0', hot, tag, type }, signal);
    const items = (Array.isArray(rows) ? rows : rows.list || []).map(v => ({ vod_id: [v.mid, v.match_id, v.ball_type].join('-'), vod_name: (v.home?.name || '') + ' vs ' + (v.visiting?.name || ''), vod_pic: v.home?.logo, vod_remarks: [v.league?.name || v.league_name, v.m_status === 2 ? '直播中' : v.match_time].filter(Boolean).join(' · ') }));
    return { class: classes, list: items.filter(v => !keyword || v.vod_name.includes(keyword)), page: 1, pagecount: 1 };
  }
  const replay = id.startsWith('replay'), path = replay ? '/api/v1/playbacks?page=' + page + '&pageSize=30&category=' + (id.endsWith('football') ? 'football' : 'basketball') : '/api/v1/home/schedules?date=' + new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Shanghai' }).format(Date.now()) + '&days=5&category=all&continuous=true&pageSize=30&q=' + encodeURIComponent(keyword);
  const data = await db(site, path, signal), items = (data.items || []).map(v => {
    const match = v.schedule || v; return { vod_id: encoded(v), vod_name: match.title || [match.home, match.away].filter(Boolean).join(' VS '), vod_pic: v.cover || match.homeLogo, vod_remarks: [match.league, match.matchTime].filter(Boolean).join(' · ') };
  });
  return { class: [['live', '直播'], ['replay_football', '足球回放'], ['replay_basketball', '篮球回放']].map(([type_id, type_name]) => ({ type_id, type_name })), list: items, page, pagecount: data.totalPages || (items.length >= 30 ? Number(page) + 1 : Number(page)) };
}
function signals(value) {
  const found = [];
  const visit = (v, depth) => {
    if (!v || typeof v !== 'object' || depth > 8 || found.length >= 300) return;
    if (v.url && typeof v.url === 'string') { found.push({ name: v.name || v.title || '线路 ' + (found.length + 1), id: v.url }); return; }
    if (v.signalId || v.playable != null && v.id) { found.push({ name: v.name || '线路 ' + (found.length + 1), id: 'signal:' + (v.signalId || v.id) }); return; }
    for (const row of Object.values(v)) visit(row, depth + 1);
  }; visit(value, 0); return found;
}
async function detail(site, id, signal) {
  if (site.plugin === 'LiveGz') {
    const [mid, match_id, ball_type] = id.split('-'), row = await gz(site, '/gz/live/detail', { ball_type, match_id, mid }, signal);
    const lines = (row.live_line || []).map(v => ({ name: v.name || '直播', episodes: [{ name: '播放', id: v.m3u8 }] }));
    if (!lines.length) throw new Error('比赛尚未开始或没有可用直播线路');
    return { vod_id: id, vod_name: (row.home?.name || '') + ' vs ' + (row.visiting?.name || ''), lines };
  }
  const row = unpack(id), episodes = signals(row.rooms || row.signals || row.playbacks || row);
  if (!episodes.length) throw new Error('该赛事没有返回可用线路，可能尚未开始或回放未发布');
  return { vod_id: id, vod_name: row.title || [row.schedule?.home || row.home, row.schedule?.away || row.away].filter(Boolean).join(' VS '), lines: [{ name: '赛事线路', episodes }] };
}
async function resolve(site, episode, signal) {
  if (episode.id.startsWith('signal:')) {
    const data = await db(site, '/api/v1/public/signals/' + encodeURIComponent(episode.id.slice(7)) + '/play', signal);
    if (!data.playable || !data.url) throw new Error(data.message || '当前直播线路不可播放'); return { url: data.url, parse: 0, isLive: true, header: site.headers };
  }
  return { url: webUrl(episode.id, site.api), parse: 0, isLive: site.plugin === 'LiveGz', header: { ...site.headers, referer: site.api } };
}
module.exports = { describe, list, detail, resolve, crypt, signals };
