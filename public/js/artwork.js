(function () {
  function artworkUrl(value, base, depth = 0) {
    if (!value) return '';
    try {
      const url = new URL(value, base || 'http://localhost/');
      if (!['http:', 'https:'].includes(url.protocol)) return '';
      // WoGG mirrors also relay Douban posters through db.php. Reuse our
      // existing protected image route rather than that unreliable relay.
      if (depth < 2 && url.pathname === '/db.php' && url.searchParams.has('url')) {
        try {
          const raw = /(?:^|&)url=([^&]*)/.exec(url.search.slice(1))?.[1] || '';
          const target = new URL(/^https?:\/\//i.test(raw) ? raw : decodeURIComponent(raw));
          if (['http:', 'https:'].includes(target.protocol) && /(^|\.)doubanio\.com$/i.test(target.hostname) && !target.username && !target.password) return artworkUrl(target.href, base, depth + 1);
        } catch { /* Keep unsupported relay targets unchanged. */ }
      }
      // Some providers wrap posters in Baidu's image relay. It can return a
      // tiny broken placeholder even though the original poster still works.
      // The relay puts src in either its query or its /gimg/app=... path.
      if (depth < 2 && /^gimg\d*\.baidu\.com$/i.test(url.hostname) && /^\/(?:gimg(?:\/|$)|image_search\/)/.test(url.pathname)) {
        const source = /(?:[/?&])src=([^&]+)/.exec(url.pathname + url.search)?.[1];
        if (source) {
          let original;
          try { original = /^(?:https?:\/\/|\/\/|[a-z\d.-]+\.[a-z]{2,}(?::\d+)?\/)/i.test(source) ? source : decodeURIComponent(source); } catch { /* Keep malformed wrappers unchanged. */ }
          if (original && /^(?:https?:\/\/|\/\/|[a-z\d.-]+\.[a-z]{2,}(?::\d+)?\/)/i.test(original)) {
            const target = new URL(original.startsWith('//') ? 'https:' + original : /^https?:\/\//i.test(original) ? original : 'https://' + original);
            if (['http:', 'https:'].includes(target.protocol) && !target.username && !target.password) return artworkUrl(target.href, base, depth + 1);
          }
        }
      }
      if (/(^|\.)doubanio\.com$/i.test(url.hostname)) {
        return '/api/proxy?' + new URLSearchParams({ url: url.href, referer: 'https://movie.douban.com/' });
      }
      return url.href;
    } catch { return ''; }
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = { artworkUrl };
  else window.MobileTVArtwork = { url: artworkUrl };
})();
