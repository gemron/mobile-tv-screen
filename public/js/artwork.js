(function () {
  function artworkUrl(value, base) {
    if (!value) return '';
    try {
      const url = new URL(value, base || 'http://localhost/');
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      if (/(^|\.)doubanio\.com$/i.test(url.hostname)) {
        return '/api/proxy?' + new URLSearchParams({ url: url.href, referer: 'https://movie.douban.com/' });
      }
      return url.href;
    } catch { return ''; }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { artworkUrl };
  else window.MobileTVArtwork = { url: artworkUrl };
})();
