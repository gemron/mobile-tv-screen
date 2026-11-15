const catalog = require('./catalog');
const {compileQuery,rankResults}=require('./search-match');

function canSearch(site) {
  if (!site.supported || site.searchable === false) return false;
  if (/^(sports-|discovery-|yueting)/.test(site.adapter || '')) return false;
  if (/^cloud-/.test(site.adapter || '')) return !['cloud-MyDrive', 'cloud-Push'].includes(site.adapter);
  return !['huya', 'douyu', 'alllive', 'xiaobei', 'extra-Kanqiu', 'extra-Music', 'extra-XPath', 'extra-YGP', 'extra-SixV'].includes(site.adapter);
}

async function searchSources(sites, keyword, { signal, onProgress, query = catalog.category, timeout = 15000, siteTimeout = 6000, isCurrent = () => true } = {}) {
  keyword = String(keyword || '').trim().slice(0, 200);
  if (!keyword) throw Object.assign(new Error('请输入片名'), { status: 400 });
  signal?.throwIfAborted();
  const deadline = AbortSignal.timeout(timeout), combined = signal ? AbortSignal.any([signal, deadline]) : deadline;
  const sources = sites.filter(canSearch), errors = [], seen = new Set(),compiled=compileQuery(keyword),sourceOrder=new Map(sources.map((site,index)=>[site.key,index]));let results=[];
  let cursor = 0, completed = 0;
  const snapshot = done => ({
    list: results.slice(), errors: errors.slice(), keyword, completed, sources: sources.length, done,
    timedOut: deadline.aborted, page: 1, pageCount: 1,
    notice: `${done ? '搜索完成' : '正在搜索'} · ${results.length} 个结果 · ${completed}/${sources.length} 个片源${deadline.aborted ? '（部分站点超时，可单独重试）' : ''}`,
  });
  const emit = done => { if (!signal?.aborted && isCurrent()) onProgress?.(snapshot(done)); };
  emit(false);
  async function worker() {
    while (cursor < sources.length && !combined.aborted && isCurrent()) {
      const site = sources[cursor++];
      try {
        const data = await query(site, { keyword, page: 1 }, AbortSignal.any([combined, AbortSignal.timeout(siteTimeout)]));
        if (combined.aborted || !isCurrent()) return;
        for (const item of data.list.slice(0, 20)) {
          const key = site.key + '\0' + item.id;
          if (!item.id || item.folder || seen.has(key)) continue;
          seen.add(key);
          // Search cards need metadata, not complete playlists or signed URLs.
          const { id, title, picture, remarks, year, area, category, searchTitle, actor } = item;
          const card = { id, title, picture, remarks, year, area, category, actor, ...(searchTitle ? { searchTitle } : {}) };
          results.push({ ...card, siteKey: site.key, sourceName: site.name });
        }
        results=rankResults(results,compiled,sourceOrder).slice(0,300);
      } catch (error) {
        if (!signal?.aborted && isCurrent()) errors.push({ siteKey: site.key, name: site.name, error: String(error.message).replace(/https?:\/\/\S+/g, '[URL]').slice(0, 240) });
      } finally { completed++; emit(false); }
    }
  }
  await Promise.all([worker(), worker(), worker()]);
  signal?.throwIfAborted();
  if (!isCurrent()) throw Object.assign(new Error('配置已切换，本次搜索已取消'), { status: 409 });
  emit(true);
  return snapshot(true);
}

module.exports = { canSearch, searchSources };
