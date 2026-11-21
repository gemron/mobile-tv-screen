// Only recognize an explicit denial or verification document, not text quoted in a film page.
function visibleText(document) {
  const value = String(document || '').slice(0, 16384);
  const body = /<body\b[^>]*>([\s\S]*?)<\/body>/i.exec(value)?.[1] || value;
  return body.replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1>/gi, '').replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function assertRegionAccess(document) {
  const text = visibleText(document);
  if (/^Access denied by geographic restriction\b/i.test(text)) {
    throw Object.assign(new Error('此站点限制当前网络所在地区访问，请切换其他片源。'), { status: 403, code: 'SOURCE_REGION_BLOCKED' });
  }
}

function detectVerificationChallenge(document, { status = 0, headers = {} } = {}) {
  const lowerHeaders = {};
  for (const [k, v] of Object.entries(headers || {})) lowerHeaders[String(k).toLowerCase()] = String(v ?? '');
  if (/challenge/i.test(lowerHeaders['cf-mitigated'] || '')) return true;
  const raw = String(document || '').slice(0, 16384);
  if (!raw.trim()) return false;
  const title = (/<title\b[^>]*>([\s\S]*?)<\/title>/i.exec(raw)?.[1] || '').replace(/\s+/g, ' ').trim();
  const text = visibleText(raw);
  const isErrorStatus = [403, 429, 503].includes(Number(status));
  // Explicit WAF / anti-bot challenge DOM or script signatures
  if (/(?:_cf_chl_opt|cf-browser-verification|challenges\.cloudflare\.com\/turnstile|cdn-cgi\/challenge-platform|id=["']wss-captcha["']|_jsc_ch_conf|safeline-waf|captcha-verify)/i.test(raw)) {
    if (isErrorStatus || text.length < 1500) return true;
  }
  if (/^(?:Just a moment\b|Attention Required!\s*\|\s*Cloudflare|Checking your browser|One more step\b|DDoS-Guard\b|Security Check\b|Human Verification\b|Bot Verification\b|Access Verification\b)/i.test(title)) {
    return true;
  }
  if (/(?:人机验证|安全验证|访问验证|行为验证|滑动验证|网站防火墙|浏览器安全检查|请完成验证)/.test(title)) {
    return true;
  }
  if (isErrorStatus || text.length < 1200) {
    if (/(?:Before accessing the website, it is necessary to verify|Verifying browser environment|Checking if the site connection is secure|Enable JavaScript and cookies to continue|Verifying you are human|人机验证|请完成安全验证|滑动滑块完成验证|拖动滑块完成验证|请点击下方按钮完成验证)/i.test(text)) {
      return true;
    }
  }
  return false;
}

function assertSourceAccess(document, { status = 0, headers = {}, url = '' } = {}) {
  assertRegionAccess(document);
  if (detectVerificationChallenge(document, { status, headers })) {
    throw Object.assign(
      new Error('此站点需要人机验证或登录，请点击“打开验证页面”在浏览器中完成后重试'),
      { status: 428, code: 'SOURCE_VERIFY_REQUIRED', ...(url ? { verifyUrl: url } : {}) }
    );
  }
}

module.exports = { assertRegionAccess, detectVerificationChallenge, assertSourceAccess };
