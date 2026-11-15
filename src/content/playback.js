const { resource } = require('./http');
const { json, cleanHeaders, webUrl } = require('./format');
const { openUpstreamStream, resolveUpstreamHeaders } = require('../services/proxy');
const { resolvePage } = require('./adapters/websites');

function variants(value) {
  let position = 0, rows = [];
  if (typeof value === 'string') rows = [{ name: '默认', url: value }];
  else if (Array.isArray(value)) {
    for (let i = 0; i + 1 < Math.min(value.length, 64); i += 2) rows.push({ name: value[i], url: value[i + 1] });
  } else if (value && typeof value === 'object') {
    position = Math.max(0, Math.floor(Number(value.position) || 0));
    rows = (Array.isArray(value.values) ? value.values : []).slice(0, 32).map(v => ({ name: v.n, url: v.v, type: v.type,header:v.header }));
  }
  return { position, values: rows.filter(v => typeof v.url === 'string' && v.url.trim() && v.url.length <= 32768).map((v, i) => ({ name: String(v.name || `画质 ${i + 1}`).slice(0, 100), url: v.url.trim(), ...(v.type?{type:String(v.type).slice(0,100)}:{}),...(v.header?{header:cleanHeaders(v.header)}:{}) })) };
}
function mimeType(url, hint = '') {
  const type = String(hint).toLowerCase();
  if (/m3u8|mpegurl|hls/.test(type) || /\.m3u8?(?:[?#]|$)/i.test(url)) return 'application/vnd.apple.mpegurl';
  if (/flv/.test(type) || /\.flv(?:[?#]|$)/i.test(url)) return 'video/x-flv';
  if (/mpegts|mp2t/.test(type) || /\.ts(?:[?#]|$)/i.test(url)) return 'video/mp2t';
  if (/dash|mpd/.test(type) || /\.mpd(?:[?#]|$)/i.test(url)) return 'application/dash+xml';
  if (['mp4','webm','m4v'].includes(type)) return type === 'webm' ? 'video/webm' : 'video/mp4';
  if (['mp3','m4a','aac','wav','ogg','flac'].includes(type)) return {mp3:'audio/mpeg',m4a:'audio/mp4',aac:'audio/aac',wav:'audio/wav',ogg:'audio/ogg',flac:'audio/flac'}[type];
  if (/^(?:video|audio)\/[\w.+-]+$/.test(type)) return type;
  return '';
}
function requestHeaders(result, defaults = {}) {
  return { ...cleanHeaders(defaults), ...cleanHeaders(result.header || result.headers), ...cleanHeaders(Object.fromEntries(Object.entries(result).filter(([name]) => /^(ua|user-agent|referer|referrer|cookie)$/i.test(name)))) };
}
function parserAddress(prefix, address) {
  return prefix.includes('{url}') ? prefix.replaceAll('{url}', encodeURIComponent(address)) : prefix + address;
}
async function sniffType(url, headers, signal) {
  const combined = signal ? AbortSignal.any([signal, AbortSignal.timeout(6000)]) : AbortSignal.timeout(6000);
  const defaults=Object.fromEntries(Object.entries(resolveUpstreamHeaders(Object.keys(headers).length?'':url)).map(([key,value])=>[key.toLowerCase(),value]));
  const { upRes } = await openUpstreamStream(url, { ...defaults,...headers, range: 'bytes=0-4095', 'accept-encoding': 'identity' }, 3, combined);
  try {
    if (upRes.statusCode < 200 || upRes.statusCode >= 300) throw new Error(`媒体探测返回 HTTP ${upRes.statusCode}`);
    const type = String(upRes.headers['content-type'] || '').split(';')[0];
    if (/^(?:video|audio)\/|mpegurl|dash\+xml/.test(type)) return mimeType(url, type) || type;
    for await (const data of upRes) {
      const bytes = data.subarray(0, 4096), text = bytes.toString('utf8').replace(/^\uFEFF/, '').trimStart();
      if (text.startsWith('#EXTM3U')) return 'application/vnd.apple.mpegurl';
      if (bytes.toString('ascii', 4, 8) === 'ftyp') return 'video/mp4';
      if (/^<!doctype|^<html|^<head/i.test(text)) throw new Error('播放地址返回了网页，未得到媒体数据');
      break;
    }
    return '';
  } finally { upRes.destroy(); }
}
function sameOrigin(a, b) { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } }

async function resolvePlayback(site, raw, { parsers = [], parserKey = '', flag = '', signal, quality } = {}) {
  let result = raw && typeof raw === 'object' ? raw : {};
  if (result.url == null && result.data && typeof result.data === 'object') result = { ...result, ...result.data };
  if (result.drm) throw new Error('该资源声明了 DRM，当前播放器尚未支持这种授权播放方式');
  if (result.playlistContext) {
    if (result.playlistContext.kind !== 'hmys') throw new Error('该线路的清单格式尚未支持');
    require('../services/hmysTransport').normalize(result.playlistContext);
    if (parserKey) throw new Error('海绵线路请使用自动 / 直链播放');
  }
  let choices = variants(result.url);
  const requested = quality == null ? null : Number(quality);
  if(requested!=null&&(!Number.isInteger(requested)||requested<0||requested>31))throw Object.assign(new Error('画质参数无效'),{status:400});
  let selected = requested != null && choices.values.length > 1 ? requested : choices.position;
  if (!choices.values.length) throw new Error(result.msg || result.message || '站点没有返回播放地址');
  if (!Number.isInteger(selected) || selected < 0 || selected >= choices.values.length) throw Object.assign(new Error('所选画质已不存在，请重新选择'), { status: 400 });
  let url = choices.values[selected].url;
  if (result.localUrl && /^\/api\/library\/torrent\/[a-f0-9]+\/\d+\/stream\.[a-z0-9]+$/.test(url)) return { url, headers: {}, mimeType: '', qualities: [], quality: 0 };
  const defaults = result.inheritHeaders === false ? {} : { ...site.headers };
  if (!sameOrigin(webUrl(url, site.api), site.api)) { delete defaults.cookie; delete defaults.authorization; }
  const selectedOrigin=new URL(webUrl(url,site.api)).origin;
  let headers = {...requestHeaders(result, defaults),...cleanHeaders(choices.values[selected].header)}, credentialOrigin = Array.isArray(result.credentialOrigins)&&result.credentialOrigins.includes(selectedOrigin)?selectedOrigin:result.credentialOrigin||'';
  let parser = parserKey ? parsers.find(p => p.key === parserKey) : null;
  if (parserKey && !parser) throw Object.assign(new Error('所选解析器不存在'), { status: 400 });
  const prefix = String(result.playUrl || (!site.adapter && site.playUrl) || '');
  if (!parser && prefix.startsWith('json:')) parser = { type: 1, url: webUrl(prefix.slice(5), site.api), headers: {} };
  else if (!parser && prefix.startsWith('parse:')) {
    parser = parsers.find(p => p.name === prefix.slice(6) || p.key === prefix.slice(6));
    if (!parser) throw new Error('源指定的解析器不存在：' + prefix.slice(6));
  } else if (!parser && prefix) parser = { type: 0, url: webUrl(prefix, site.api), headers: {} };
  if (!parser && (Number(result.jx) === 1 || (site.parseFlags || []).includes(result.flag || flag))) {
    parser = parsers.find(p => p.supported !== false && [0, 1].includes(p.type) && (!p.flags?.length || p.flags.includes(result.flag || flag)));
    if (!parser && Number(result.jx) === 1) throw new Error('该资源要求解析，但未配置可用的网页或 JSON 解析器');
  }
  let hint = choices.values[selected].type || result.format || result.type || '', needsWeb = Number(result.parse || result.jx || 0) === 1;
  if (parser) {
    if (![0, 1].includes(Number(parser.type))) throw Object.assign(new Error([2,3].includes(Number(parser.type))?'此解析器依赖 Android 扩展加载器，当前仅支持网页与 JSON 解析器':'此解析器类型尚未实现，当前支持网页与 JSON 解析器'), { status: 422 });
    const address = webUrl(parserAddress(parser.url, url), site.api);
    const configured = cleanHeaders(parser.headers), parserHeaders = Object.keys(configured).length ? configured : {...headers};
    if (!Object.keys(configured).length && !sameOrigin(address,site.api) && credentialOrigin !== new URL(address).origin) { delete parserHeaders.cookie; delete parserHeaders.authorization; }
    if (Number(parser.type) === 0) {
      url = address; headers = parserHeaders; needsWeb = true;
    } else {
      const response = await resource(address, { headers: parserHeaders, signal });
      let parsed; try { parsed = json(response.text); } catch { throw new Error('JSON 解析器返回了网页或无效数据，请选择网页解析器或更换接口'); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('JSON 解析器返回的播放信息格式无效');
      if (parsed?.url == null && parsed?.data && typeof parsed.data === 'object') parsed = { ...parsed, ...parsed.data };
      if (parsed?.url == null && typeof parsed?.data?.playUrl === 'string') parsed = { ...parsed, url: parsed.data.playUrl };
      const returned = variants(parsed?.url);
      if (!returned.values.length) throw new Error(parsed?.msg || parsed?.message || '解析器没有返回可播放地址');
      // A parser can return its own rendition list. Keep the requested index
      // when present; a single returned rendition is the resolved selection.
      if (returned.values.length > 1) { choices = returned; selected = quality == null ? returned.position : Number(quality); if (!returned.values[selected]) throw new Error('解析器未返回所选画质'); }
      url = returned.values[returned.values.length === 1 ? 0 : selected]?.url;
      headers = requestHeaders(parsed, parserHeaders); credentialOrigin = new URL(webUrl(url, response.url)).origin;
      hint = parsed.format || parsed.type || hint; needsWeb = Number(parsed.parse || parsed.jx || 0) === 1;
    }
  }
  url = webUrl(url, site.api);
  if (needsWeb) {
    try { const found = await resolvePage({ ...site, headers }, url, signal); url = found.url; headers = requestHeaders(found, headers); hint = found.format || found.type || hint; }
    catch (error) {
      if (!site.browser) throw error;
      const found = await site.browser.run(url, { media: true, signal, headers, click: result.click || '' });
      url = found.url; headers = requestHeaders(found, headers); hint = found.type || hint; credentialOrigin = found.credentialOrigin || '';
    }
  }
  url = webUrl(url, site.api);
  if (result.playlistContext && new URL(url).origin !== selectedOrigin) throw new Error('专用播放线路地址已变化，请使用自动播放重试');
  if (!sameOrigin(url, site.api) && credentialOrigin !== new URL(url).origin) { delete headers.cookie; delete headers.authorization; }
  let mime = mimeType(url, hint);
  if (!mime && !/\.(mp4|webm|m4v|mp3|m4a|aac|wav|ogg)(?:[?#]|$)/i.test(url)) mime = await sniffType(url, headers, signal);
  if (mime === 'application/dash+xml') throw new Error('该线路返回 DASH 清单；当前支持分离音视频地址转封装，请选择 HLS 或 MP4 线路');
  if(requested!=null&&choices.values.length===1&&requested!==0)throw Object.assign(new Error('该资源只返回了一个画质'),{status:400});
  return { url, headers, mimeType: mime, audioUrl: result.audioUrl ? webUrl(result.audioUrl, site.api) : '', isLive: Boolean(result.isLive), qualities: choices.values.map(v => v.name), quality: selected, ...(result.playlistContext ? { playlistContext: result.playlistContext } : {}) };
}
module.exports = { resolvePlayback, variants, mimeType, parserAddress, requestHeaders, sniffType };
