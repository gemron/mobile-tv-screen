const { inflateRawSync, crc32 } = require('zlib');
const MAX_TEXT = 4 * 1024 * 1024, MAX_CUES = 30000;
const supported = name => /\.(srt|vtt|ass|ssa)(?:[?#]|$)/i.test(name || '');
function decode(buffer) {
  if (buffer[0] === 0xff && buffer[1] === 0xfe) return buffer.subarray(2).toString('utf16le');
  if (buffer[0] === 0xfe && buffer[1] === 0xff) return new TextDecoder('utf-16be').decode(buffer.subarray(2));
  try { return new TextDecoder('utf-8', { fatal: true }).decode(buffer); }
  catch { return new TextDecoder('gb18030').decode(buffer); }
}
function seconds(text) {
  const match = /^(?:(\d{1,3}):)?(\d{1,2}):(\d{2})(?:[.,](\d{1,3}))?$/.exec(text.trim());
  if (!match || Number(match[2]) > 59 || Number(match[3]) > 59) return NaN;
  return Number(match[1] || 0) * 3600 + Number(match[2]) * 60 + Number(match[3]) + Number((match[4] || '').padEnd(3, '0')) / 1000;
}
function plain(text) {
  return text.replace(/\{[^}\r\n]*\}/g, '').replace(/\\[Nn]/g, '\n').replace(/\\h/g, ' ').replace(/<[^>\r\n]*>/g, '').replace(/&(?:amp|lt|gt|quot|apos|nbsp);/g, entity => ({'&amp;':'&','&lt;':'<','&gt;':'>','&quot;':'"','&apos;':"'",'&nbsp;':' '})[entity]).trim().slice(0, 4000);
}
function parseSubtitle(buffer, name = '') {
  if (!buffer.length || buffer.length > MAX_TEXT) throw new Error('字幕文件为空或超过 4 MiB');
  const text = decode(buffer).replace(/^\uFEFF/, '').replace(/\r\n?/g, '\n');
  if (/^\s*(?:<!doctype|<html|\{\s*"(?:error|status)")/i.test(text)) throw new Error('该地址返回了网页或接口错误，没有取得字幕');
  const cues = [], add = (start, end, value) => { const content = plain(value); if (Number.isFinite(start) && Number.isFinite(end) && start >= 0 && end > start && end <= 604800 && content && cues.length < MAX_CUES) cues.push({ start, end, text: content }); };
  if (/\[Events\]/i.test(text) || /\.(?:ass|ssa)$/i.test(name)) {
    let columns = ['layer','start','end','style','name','marginl','marginr','marginv','effect','text'], events = false;
    for (const line of text.split('\n')) {
      if (/^\[/.test(line)) events = /^\[Events\]/i.test(line.trim());
      if (!events) continue;
      if (/^Format:/i.test(line)) columns = line.slice(line.indexOf(':') + 1).split(',').map(value => value.trim().toLowerCase());
      if (!/^Dialogue:/i.test(line) || columns.indexOf('text') !== columns.length - 1) continue;
      const values = line.slice(line.indexOf(':') + 1).split(','), count = columns.length - 1;
      if (values.length <= count) continue;
      add(seconds(values[columns.indexOf('start')] || ''), seconds(values[columns.indexOf('end')] || ''), values.slice(count).join(','));
    }
  } else {
    for (const block of text.split(/\n{2,}/)) {
      const lines = block.trim().split('\n');
      if (/^(WEBVTT|NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0] || '')) continue;
      const index = lines.findIndex(line => line.includes('-->')); if (index < 0 || index > 1) continue;
      const match = /^(\S+)\s+-->\s+(\S+)/.exec(lines[index]); if (!match) continue;
      add(seconds(match[1]), seconds(match[2]), lines.slice(index + 1).join('\n'));
    }
  }
  if (!cues.length) throw new Error('没有识别到文本字幕，请选择 SRT、VTT、ASS 或 SSA 文件');
  return cues.sort((a, b) => a.start - b.start || a.end - b.end);
}
function subtitleZip(input) {
  if (input.length > 8 * 1024 * 1024) throw new Error('字幕压缩包超过 8 MiB');
  let end = -1;
  for (let at = input.length - 22; at >= Math.max(0, input.length - 65557); at--) if (input.readUInt32LE(at) === 0x06054b50) { end = at; break; }
  if (end < 0) throw new Error('不是有效 ZIP 字幕包，RAR 和 7z 暂不支持');
  const count = input.readUInt16LE(end + 10); if (count > 128) throw new Error('字幕包文件数超过 128');
  let at = input.readUInt32LE(end + 16), expanded = 0; const files = [];
  for (let i = 0; i < count; i++) {
    if (at + 46 > input.length || input.readUInt32LE(at) !== 0x02014b50) throw new Error('字幕包目录损坏');
    const flags = input.readUInt16LE(at + 8), method = input.readUInt16LE(at + 10), checksum = input.readUInt32LE(at + 16), packed = input.readUInt32LE(at + 20), size = input.readUInt32LE(at + 24), names = input.readUInt16LE(at + 28), extra = input.readUInt16LE(at + 30), comment = input.readUInt16LE(at + 32), local = input.readUInt32LE(at + 42);
    if (at + 46 + names + extra + comment > input.length) throw new Error('字幕包目录被截断');
    const name = decode(input.subarray(at + 46, at + 46 + names)); at += 46 + names + extra + comment;
    if (/^(?:[\\/]|[a-z]:)/i.test(name) || name.split(/[\\/]/).includes('..')) throw new Error('字幕包包含无效路径');
    if (!supported(name)) continue;
    if (flags & 1 || ![0, 8].includes(method)) throw new Error('不支持加密或此压缩方式的字幕包');
    if (size > MAX_TEXT || (expanded += size) > 16 * 1024 * 1024) throw new Error('解压后的字幕超过大小限制');
    if (local + 30 > input.length || input.readUInt32LE(local) !== 0x04034b50) throw new Error('字幕包内容损坏');
    const start = local + 30 + input.readUInt16LE(local + 26) + input.readUInt16LE(local + 28);
    if (start + packed > input.length) throw new Error('字幕包内容被截断');
    const bytes = input.subarray(start, start + packed), body = method === 0 ? Buffer.from(bytes) : inflateRawSync(bytes, { maxOutputLength: MAX_TEXT });
    if (body.length !== size || crc32(body) !== checksum) throw new Error('字幕文件校验失败');
    files.push({ name: name.split(/[\\/]/).pop(), body });
  }
  if (!files.length) throw new Error('压缩包中没有支持的文本字幕');
  return files;
}
module.exports = { parseSubtitle, subtitleZip, supported, decode, MAX_TEXT };
