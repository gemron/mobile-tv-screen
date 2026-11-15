const crypto = require('crypto');
const { resource, postResource, postJson } = require('../http');
const { json } = require('../format');

function describe(raw) {
  if (!/^csp_YueTing(?:Guard)?$/.test(raw.api)) return null;
  return { adapter: 'yueting', api: 'https://json.tingyou8.vip/azybk/json_v1/', supported: true, implementation: 'node-yueting', headers: { 'user-agent': 'zybk/1.0.6' } };
}
const rotate = (v, n) => v << n | v >>> (32 - n);
function hchacha(key, nonce) {
  const words = [...[0x61707865, 0x3320646e, 0x79622d32, 0x6b206574], ...Array.from({ length: 8 }, (_, i) => key.readUInt32LE(i * 4)), ...Array.from({ length: 4 }, (_, i) => nonce.readUInt32LE(i * 4))];
  const quarter = (a, b, c, d) => { words[a] = words[a] + words[b] | 0; words[d] = rotate(words[d] ^ words[a], 16); words[c] = words[c] + words[d] | 0; words[b] = rotate(words[b] ^ words[c], 12); words[a] = words[a] + words[b] | 0; words[d] = rotate(words[d] ^ words[a], 8); words[c] = words[c] + words[d] | 0; words[b] = rotate(words[b] ^ words[c], 7); };
  for (let i = 0; i < 10; i++) { quarter(0, 4, 8, 12); quarter(1, 5, 9, 13); quarter(2, 6, 10, 14); quarter(3, 7, 11, 15); quarter(0, 5, 10, 15); quarter(1, 6, 11, 12); quarter(2, 7, 8, 13); quarter(3, 4, 9, 14); }
  const out = Buffer.alloc(32); [0, 1, 2, 3, 12, 13, 14, 15].forEach((n, i) => out.writeInt32LE(words[n] | 0, i * 4)); return out;
}
function decrypt(payload, key) {
  if (!/^[a-f0-9]+$/i.test(payload || '') || payload.length < 82 || payload.length % 2) throw new Error('有声源返回的加密数据格式不正确');
  const bytes = Buffer.from(payload, 'hex');
  if (![1, 2].includes(bytes[0])) throw new Error('有声源数据版本尚不支持');
  const nonce = bytes.subarray(1, 25), body = Buffer.from(bytes.subarray(25)); if (bytes[0] === 2) body.reverse();
  const iv = Buffer.alloc(12); nonce.copy(iv, 4, 16);
  const cipher = crypto.createDecipheriv('chacha20-poly1305', hchacha(key, nonce.subarray(0, 16)), iv, { authTagLength: 16 });
  cipher.setAuthTag(body.subarray(-16)); return json(Buffer.concat([cipher.update(body.subarray(0, -16)), cipher.final()]).toString());
}
async function keyFor(site, signal) {
  if (site.envelopeKey) return site.envelopeKey;
  const facts = await site.material.get('YueTingCrypto', signal), key = facts.strings.find(s => /^[a-f0-9]{64}$/i.test(s));
  if (!key) throw new Error('订阅插件中没有识别到有声接口数据参数'); return site.envelopeKey = Buffer.from(key, 'hex');
}
async function read(site, path, signal) { const result = json((await resource(new URL(path, site.api).href, { headers: site.headers, signal })).text); return result.payload ? decrypt(result.payload, await keyFor(site, signal)) : result; }
const video = v => ({ vod_id: v.id, vod_name: v.title, vod_pic: v.cover_url, vod_actor: v.teller, vod_remarks: v.teller });
async function list(site, { id = '', page = 1, keyword = '', filters = {} } = {}, signal) {
  const classes = [{ type_id: '2', type_name: '小说' }, { type_id: '1', type_name: '评书' }];
  if (!id && !keyword) return { class: classes, list: [], notice: '选择小说或评书分类，或搜索书名和主播。', page: 1, pagecount: 1 };
  let data;
  if (keyword) {
    const key = await keyFor(site, signal), nonce = crypto.randomBytes(12), cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
    const body = Buffer.concat([Buffer.from([1]), nonce, cipher.update(JSON.stringify({ keyword, page: Number(page) })), cipher.final(), cipher.getAuthTag()]).toString('hex');
    const r = json((await postResource('https://tingyou.fm/api/search', body, { headers: site.headers, contentType: 'text/plain', signal })).text);
    data = decrypt(r.payload, key).results;
  } else data = (await read(site, `${filters.class ? 'types/' + encodeURIComponent(filters.class) : 'categories/' + encodeURIComponent(id)}/comprehensive/p${page}`, signal)).data;
  const items = (data || []).map(video);
  return { class: classes, list: items, page, pagecount: items.length >= 20 ? Number(page) + 1 : Number(page) };
}
async function detail(site, id, signal) {
  const [info, chapters] = await Promise.all([read(site, 'album_info/' + encodeURIComponent(id), signal), read(site, 'album_chapters/' + encodeURIComponent(id), signal)]);
  return { ...video(info), vod_id: id, vod_content: info.intro || info.description || info.title, lines: [{ name: '有声', episodes: (chapters.chapters || []).map(c => ({ name: c.title, id: id + '|||' + c.index })) }] };
}
async function playbackHosts(site, signal) {
  if (site.playbackHosts && site.hostExpiry > Date.now()) return site.playbackHosts;
  const fallbacks = ['https://appp.fdhtbz.cn/api', 'https://laopaoaappi.oobyvy.vip/api'];
  for (const host of ['toudnbbaa.tou1laopao.cc', 'toudnbbaa.toulaopao1.cc']) try {
    const data = (await resource('https://' + host + '/api/startup-head/h5api.dat', { signal, timeout: 7000 })).body;
    if (data.length < 64 || (data.length - 48) % 16) continue;
    const cipher = crypto.createDecipheriv('aes-256-cbc', data.subarray(-48, -16), data.subarray(-16));
    const envelope = json(Buffer.concat([cipher.update(data.subarray(0, -48)), cipher.final()]).toString());
    const head = json(Buffer.from(envelope.signed_payload, 'base64url').toString());
    if (head.schema !== 'av-api-bootstrap-v2' || head.head_version !== 'h5api') continue;
    const hosts = (head.api_hosts || []).flatMap(v => { try { const u = new URL(v); return u.protocol === 'https:' && !u.username && !u.password && /^\/?(?:api)?\/?$/.test(u.pathname) ? [u.origin + '/api'] : []; } catch { return []; } });
    if (hosts.length) { site.hostExpiry = Math.min(Number(head.expires_at) * 1000, Date.now() + 900000); return site.playbackHosts = hosts; }
  } catch (error) { if (signal?.aborted) throw error; }
  site.hostExpiry = Date.now() + 60000; return site.playbackHosts = fallbacks;
}
async function resolve(site, episode, signal) {
  const [album_id, chapter] = episode.id.split('|||'); if (!album_id || !/^\d+$/.test(chapter)) throw new Error('有声剧集参数错误');
  site.listeningSession ||= crypto.randomUUID(); let last;
  for (const host of await playbackHosts(site, signal)) try {
    const result = await postJson(host + '/h5/listening/play', { album_id, chapter_idx: Number(chapter) }, { headers: { 'user-agent': 'Mozilla/5.0 Chrome/131.0.0.0', origin: 'https://tingyou.fm', referer: 'https://tingyou.fm/', 'x-listening-session': site.listeningSession, 'x-listening-timezone': 'Asia/Shanghai' }, signal, timeout: 10000 });
    const data = result.payload ? decrypt(result.payload, await keyFor(site, signal)) : result;
    if (!data.play_url) throw new Error(data.message || '有声接口未返回播放地址'); return { url: data.play_url, parse: 0, header: { 'user-agent': 'Mozilla/5.0 Chrome/131.0.0.0', referer: 'https://tingyou.fm/' } };
  } catch (e) { last = e; if (signal?.aborted) throw e; }
  throw last || new Error('有声播放服务暂时不可用');
}
module.exports = { describe, list, detail, resolve, decrypt, hchacha };
