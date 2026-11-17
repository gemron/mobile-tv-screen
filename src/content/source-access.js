// Only recognize an explicit denial document, not text quoted in a film page.
function assertRegionAccess(document) {
  const value = String(document || '').slice(0, 16384);
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(value)?.[1] || value;
  const text = body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  if (/^Access denied by geographic restriction\b/i.test(text)) {
    throw Object.assign(new Error('此站点限制当前网络所在地区访问，请切换其他片源。'), { status: 403, code: 'SOURCE_REGION_BLOCKED' });
  }
}
module.exports = { assertRegionAccess };
