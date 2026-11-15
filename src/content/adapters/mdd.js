const crypto = require('crypto');
const { postJson } = require('../http');
function describe(raw) {
  if (!/^csp_MaiDuiDui(?:Guard)?$/.test(raw.api)) return null;
  return { adapter: 'mdd', api: 'https://mob.mddcloud.com.cn/', supported: true, implementation: 'node-mdd', headers: {} };
}
function canonical(params) {
  return Object.keys(params).sort().map(key => `${key}=${typeof params[key] === 'object' ? JSON.stringify(params[key]) : String(params[key])}&`).join('');
}
async function call(site, path, params, signal, web = false) {
  const { fields } = await site.material.get('MaiDuiDui', signal);
  if (!fields.SN || !fields.N) throw new Error('未识别到粤迷接口数据参数，请更新订阅');
  const time = Date.now(), version = fields.t0 || '5.6.01', action = '/' + path.replace(/^\//, '');
  let payload, endpoint, headers;
  if (web) {
    endpoint = (fields.tF || 'https://activity.mddcloud.com.cn') + action;
    const sign = crypto.createHash('md5').update(`time:${time}|privateKey:${fields.N}|data:${canonical(params)}`).digest('hex');
    payload = { time, sign, data: params };
    headers = { 'user-agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 Version/17.0 Mobile/15E148 Safari/604.1', origin: fields.zH || 'https://m.mddcloud.com.cn', referer: (fields.zH || 'https://m.mddcloud.com.cn') + '/', 'x-requested-with': 'XMLHttpRequest' };
  } else {
    endpoint = new URL(action, site.api).href;
    const sign = crypto.createHash('md5').update(`os:Android|version:${version}|action:${action}|time:${time}|appToken:|privateKey:${fields.SN}|data:${canonical(params)}`).digest('hex');
    const saved = site.runtime?.get() || {}; const deviceNum = saved.deviceId || crypto.randomUUID(); if (!saved.deviceId) site.runtime?.set({ deviceId: deviceNum });
    payload = { channel: fields.i || '2250', data: params, deviceNum, deviceType: 0, jsonSign: 0, os: 'Android', sign, sourceVersion: 0, terminalType: 'APP', thirdStatus: 0, time, version, visitorStatus: 0 };
    headers = { 'user-agent': 'Mdd/5.6.01 (Android+32+)', version, referer: 'mdd' };
  }
  const result = await postJson(endpoint, payload, { headers, signal, timeout: 12000 });
  if (result.code != null && ![0, 1, 200].includes(Number(result.code))) throw new Error(result.msg || result.message || '粤迷接口拒绝请求');
  return result.data ?? result;
}
function video(v) { return { vod_id: v.uuid || v.vodUuid, vod_name: v.name, vod_pic: v.coverImage || v.sideImage || v.downImage, vod_remarks: v.updateNum ? '更新至 ' + v.updateNum + ' 集' : '', vod_year: v.yearName, type_name: v.materialName, vod_actor: v.starring, vod_director: v.director, vod_content: v.introduction }; }
function videos(data) {
  const list = [];
  const visit = (v, depth = 0) => { if (!v || typeof v !== 'object' || depth > 8 || list.length >= 300) return; if ((v.uuid || v.vodUuid) && v.name && (v.coverImage || v.sideImage || v.materialName)) { list.push(video(v)); return; } for (const child of Object.values(v)) visit(child, depth + 1); };
  visit(data); return [...new Map(list.map(v => [v.vod_id, v])).values()];
}
async function list(site, { id = '', page = 1, keyword = '' } = {}, signal) {
  const classes = [['0', '剧集'], ['1', '电影'], ['2', '综艺']].map(([type_id, type_name]) => ({ type_id, type_name }));
  if (!id && !keyword) return { class: classes, list: [], notice: '请选择分类或搜索片名。播放使用源站正常提供的试看接口，完整内容以账号观看权限为准。', page: 1, pagecount: 1 };
  const data = keyword ? await call(site, 'searchApi/search/getAllSearchResult4820.action', { keyWord: keyword }, signal) : await call(site, 'api/vod/classify/word/search.action', { rows: 24, startRow: (Number(page) - 1) * 24, uuidList: [], vodType: Number(id) || 0 }, signal);
  const items = videos(data); return { class: classes, list: items, page, pagecount: items.length >= 24 ? Number(page) + 1 : Number(page) };
}
async function detail(site, id, signal) {
  const [info, episodes] = await Promise.all([call(site, '/api/vod/getVodInfo.action/', { vodUuid: id }, signal, true), call(site, '/api/vod/listVodSactions.action/', { hasIntroduction: 0, vodUuid: id }, signal)]);
  const rows = Array.isArray(episodes) ? episodes : episodes.list || [];
  return { ...video(info), vod_id: id, lines: [{ name: '源站试看', episodes: rows.map((v, i) => ({ name: v.name || v.title || '第 ' + (v.num || i + 1) + ' 集', id: id + '@' + (v.num || i + 1) })) }] };
}
async function resolve(site, episode, signal) {
  const [vodUuid, num] = episode.id.split('@'), data = await call(site, '/api/vod/getTrySaction.action/', { vodUuid, num: Number(num) }, signal, true), url = data.tryM3u8Url || data.tryUrl || data.tryMp4Url;
  if (!url) throw new Error('源站未提供当前剧集的试看地址，请在官方站点确认账号观看权限');
  return { url, parse: 0, header: { 'user-agent': 'Mozilla/5.0', referer: 'https://m.mddcloud.com.cn/', origin: 'https://m.mddcloud.com.cn' } };
}
module.exports = { describe, list, detail, resolve, canonical, videos };
