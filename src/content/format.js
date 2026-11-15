const { parse, printParseErrorCode } = require('jsonc-parser');

const MAX_DOCUMENT = 8 * 1024 * 1024;

function json(text) {
  const errors = [];
  const result = parse(String(text).replace(/^\uFEFF/, ''), errors, { allowTrailingComma: true, disallowComments: false });
  if (errors.length) throw new Error(`配置格式错误：${printParseErrorCode(errors[0].error)}（位置 ${errors[0].offset}）`);
  return result;
}

function decodeDocument(input) {
  const buffer = Buffer.isBuffer(input) ? input : Buffer.from(input);
  if (buffer.length > MAX_DOCUMENT) throw new Error('配置文件超过 8 MiB 限制');
  let text = buffer.toString('utf8').replace(/^\uFEFF/, '').trim();
  // Some TVBox subscriptions append a marked Base64 document to an image.
  // It is a transport envelope: no image or embedded code is executed.
  if (!/^[\[{]/.test(text)) {
    const marker = text.lastIndexOf('**');
    if (marker >= 0) text = text.slice(marker + 2).trim();
    if (/^[A-Za-z0-9+/=\r\n\s]+$/.test(text)) text = Buffer.from(text, 'base64').toString('utf8').trim();
  }
  if (/^<!doctype|^<html/i.test(text)) throw new Error('地址返回的是网页，请填写配置订阅地址');
  return json(text);
}

// Compatibility implementation for the extension encoding used by the
// imported FTY T4 adapter. Implements the wire format, without loading its
// Android DEX, JNI or ARM libraries. The shared format identifier is not an
// account credential; no provider binaries or content are bundled here.
function rc4(input, key) {
  const bytes = Buffer.from(key, 'utf8');
  const state = Array.from({ length: 256 }, (_, i) => i);
  let j = 0;
  for (let i = 0; i < 256; i++) { j = (j + state[i] + bytes[i % bytes.length]) & 255; [state[i], state[j]] = [state[j], state[i]]; }
  let i = 0; j = 0;
  return Buffer.from(input).map(value => { i = (i + 1) & 255; j = (j + state[i]) & 255; [state[i], state[j]] = [state[j], state[i]]; return value ^ state[(state[i] + state[j]) & 255]; });
}

function decodeFtyValue(value) {
  const text = String(value || '').trim();
  if (/^https?:\/\//.test(text)) return text;
  if (!text || text.length > 128 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(text)) throw new Error('站点扩展配置格式不兼容');
  const decoded = rc4(Buffer.from(text, 'base64'), 'fantaiying921').toString('utf8');
  return decoded.split('').map(character => String.fromCharCode((character.charCodeAt(0) - 2) & 65535)).join('');
}
function decodeFtyExtension(value) {
  if (value && typeof value === 'object') return value;
  const text = String(value || '').trim();
  if (text.startsWith('{')) return json(text);
  if (!text || text.length > 128 * 1024 || !/^[A-Za-z0-9+/=]+$/.test(text)) throw new Error('站点扩展配置格式不兼容');
  // The shift applies to UTF-16 code units, rather than UTF-8 bytes.
  const plain = decodeFtyValue(text);
  const result = json(plain);
  if (!result || typeof result !== 'object' || !result.siteUrl) throw new Error('站点扩展配置未包含有效接口');
  return result;
}

function webUrl(value, base) {
  const url = new URL(String(value || '').trim(), base);
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('仅支持 HTTP / HTTPS 网络地址');
  return url.href;
}

function cleanHeaders(value = {}) {
  if (typeof value === 'string') { try { value = json(value); } catch { value = {}; } }
  const allowed = new Set(['user-agent', 'referer', 'origin', 'cookie', 'authorization', 'accept', 'accept-language', 'content-type', 'sign', 't', 'deviceid', 'version', 'app-version', 'app-id', 'appkey', 'timestamp', 'token', 'os', 'app', 'plat', 'platform', 'x-requested-with', 'x-listening-session', 'x-listening-timezone']);
  const result = {};
  for(const name of ['key','api-ver','ver','code','client-version','packagename','app_id','channel_code','cur_time','device_id','mob_mfr','mobmodel','package_name','sys_platform','sysrelease','x-share-token','x-device-id','x-signature'])allowed.add(name);
  for (const [original, raw] of Object.entries(value && typeof value === 'object' && !Array.isArray(value) ? value : {})) {
    const alias = original.toLowerCase();
    const name = alias === 'ua' ? 'user-agent' : alias === 'referrer' ? 'referer' : original;
    const text = String(raw);
    if (allowed.has(name.toLowerCase()) && text.length <= (name.toLowerCase()==='cookie'?16000:4096) && !/[\r\n\0]/.test(text)) result[name.toLowerCase()] = text;
  }
  return result;
}

module.exports = { json, decodeDocument, decodeFtyExtension, decodeFtyValue, rc4, webUrl, cleanHeaders, MAX_DOCUMENT };
