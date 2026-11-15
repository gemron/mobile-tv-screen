(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { config: null, mode: 'cast', site: '', category: '', keyword: '', page: 1, pages: 1, detail: null, line: 0, channels: [], channelLimit: 300, liveSource: '', playback: null, request: 0, fetching: null };
  const toast = message => window.MobileTVUI?.toast(message);
  const node = (tag, className, value) => { const element = document.createElement(tag); if (className) element.className = className; if (value != null) element.textContent = value; return element; };
  const option = (value, label, disabled = false) => { const element = node('option', '', label); element.value = value; element.disabled = disabled; return element; };
  const status = (message, error = false) => { $('libraryStatus').textContent = message; $('libraryStatus').classList.toggle('error', error); };
  async function api(route, body, signal) {
    const response = await fetch('/api/library' + route, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error || '操作失败，请重试');
    return result;
  }
  function begin() { state.fetching?.abort(); state.fetching = new AbortController(); return { id: ++state.request, signal: state.fetching.signal }; }
  function report(error) { if (error.name !== 'AbortError') status(error.message, true); }
  function placeholder(message) { $('libraryResults').replaceChildren(node('div', 'library-empty', message)); $('libraryPager').hidden = true; }

  function setMode(mode) {
    state.mode = mode;
    $('standbyView').hidden = mode !== 'cast'; $('libraryView').hidden = mode === 'cast';
    $('libraryVod').hidden = mode !== 'vod'; $('libraryLive').hidden = mode !== 'live';
    for (const button of document.querySelectorAll('[data-library-nav]')) { const active = button.dataset.libraryNav === mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
    try { localStorage.setItem('mobiletv-section', mode); } catch {}
    if (mode === 'vod') { $('libraryTitle').textContent = '找到想看的，直接开播。'; if (state.site) loadHome(); else placeholder('先导入影视配置，选择一个已适配的站点。'); }
    if (mode === 'live') { $('libraryTitle').textContent = '打开频道，享受直播。'; if (state.liveSource) loadChannels(); else renderChannels(); }
  }

  function renderConfig(config) {
    state.config = config; $('librarySourceUrl').value = config.url || '';
    const supported = config.sites.filter(site => site.supported);
    $('libraryCompatibility').textContent = config.url ? `${config.sites.length} 个站点 · ${supported.length} 个已适配 · ${config.lives.length} 组直播` : '支持 TVBox 配置、通用点播接口与 M3U / TXT / JSON 直播列表';
    const siteSelect = $('librarySite'); siteSelect.replaceChildren();
    for (const site of [...supported, ...config.sites.filter(item => !item.supported)]) siteSelect.append(option(site.key, site.name + (site.supported ? '' : '（待适配）'), !site.supported));
    state.site = supported.some(item => item.key === state.site) ? state.site : supported[0]?.key || ''; siteSelect.value = state.site;
    const liveSelect = $('libraryLiveSource'); liveSelect.replaceChildren();
    for (const source of config.lives) liveSelect.append(option(source.key, source.name + (source.supported ? '' : '（待适配）'), !source.supported));
    state.liveSource = config.lives.some(item => item.key === state.liveSource && item.supported) ? state.liveSource : config.lives.find(item => item.supported)?.key || ''; liveSelect.value = state.liveSource;
    $('libraryParser').replaceChildren(option('', '自动 / 直链播放'), ...config.parsers.filter(item => [1, 2].includes(item.type)).map(item => option(item.key, item.name)));
    const pending = config.sites.filter(site => !site.supported);
    $('libraryUnsupported').replaceChildren(...pending.map(site => { const row = node('div', 'compatibility-row'); row.append(node('strong', '', site.name), node('span', '', site.reason)); return row; }));
    $('libraryCompatibilityDetails').hidden = !pending.length;
    $('libraryRepositories').replaceChildren(); $('libraryRepositories').hidden = !config.repositories.length;
    for (const item of config.repositories) { const button = node('button', 'btn', item.name); button.type = 'button'; button.addEventListener('click', () => importSource(item.url)); $('libraryRepositories').append(button); }
  }

  async function importSource(url) {
    if (!url.trim()) { $('librarySourceUrl').focus(); return; }
    $('libraryImport').disabled = true; status('正在读取配置…');
    try {
      const config = await api('/config', { url: url.trim() }); renderConfig(config); state.channels = []; state.category = ''; state.keyword = ''; $('librarySearch').value = '';
      status('配置已保存到本机。请选择站点或直播源。');
      if (state.mode === 'live') { if (state.liveSource) await loadChannels(); else renderChannels(); }
      else if (state.site) await loadHome(); else placeholder('该配置中的点播站点需要专用适配，当前可切换到直播使用已兼容频道组。');
    } catch (error) { report(error); }
    finally { $('libraryImport').disabled = false; }
  }

  function renderCategories(classes) {
    $('libraryCategories').replaceChildren();
    for (const category of [{ id: '', name: '推荐' }, ...classes]) {
      const button = node('button', 'category-pill' + (state.category === category.id ? ' active' : ''), category.name); button.type = 'button';
      button.addEventListener('click', () => { state.category = category.id; state.keyword = ''; $('librarySearch').value = ''; for (const item of $('libraryCategories').children) item.classList.toggle('active', item === button); if (!category.id) loadHome(); else loadList(1); });
      $('libraryCategories').append(button);
    }
  }

  function renderVideos(data) {
    state.page = data.page; state.pages = data.pageCount;
    $('libraryResults').replaceChildren();
    if (!data.list.length) placeholder('没有找到影片，换个关键词或分类试试。');
    else for (const video of data.list) {
      const card = node('button', 'vod-card'); card.type = 'button'; card.title = video.title;
      const artwork = node('div', 'vod-artwork');
      if (video.picture) { const img = node('img'); img.src = video.picture; img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.addEventListener('error', () => { img.hidden = true; }); artwork.append(img); }
      if (video.remarks) artwork.append(node('span', 'vod-remark', video.remarks));
      card.append(artwork, node('strong', 'vod-title', video.title), node('span', 'vod-meta', [video.year, video.area, video.category].filter(Boolean).join(' · ')));
      card.addEventListener('click', () => showDetail(video.id)); $('libraryResults').append(card);
    }
    $('libraryPager').hidden = !data.list.length || data.pageCount <= 1;
    $('libraryPage').textContent = `${data.page} / ${data.pageCount}`;
    $('libraryPrevious').disabled = data.page <= 1; $('libraryMore').disabled = data.page >= data.pageCount;
    status(`${data.list.length} 个结果${data.total ? ` · 共 ${data.total} 项` : ''}`);
  }

  async function loadHome() {
    if (!state.site) return;
    const request = begin(); state.category = ''; state.keyword = ''; state.page = 1; status('正在加载影片…'); placeholder('正在加载…');
    try { const data = await api('/home?site=' + encodeURIComponent(state.site), undefined, request.signal); if (request.id !== state.request) return; renderCategories(data.classes); renderVideos(data); }
    catch (error) { if (error.name !== 'AbortError') { placeholder('站点暂时没有响应，可切换其他站点或重试。'); report(error); } }
  }
  async function loadList(page) {
    const request = begin(); status('正在读取列表…');
    try { const query = new URLSearchParams({ site: state.site, category: state.category, keyword: state.keyword, page: String(page) }); const data = await api('/list?' + query, undefined, request.signal); if (request.id === state.request) renderVideos(data); }
    catch (error) { report(error); }
  }

  async function showDetail(id) {
    const request = begin(); status('正在读取影片详情…');
    try {
      const video = await api('/detail?' + new URLSearchParams({ site: state.site, id }), undefined, request.signal); if (request.id !== state.request) return;
      state.detail = video; state.line = 0; $('libraryDetailTitle').textContent = video.title; $('libraryDetailInfo').textContent = [video.year, video.area, video.category].filter(Boolean).join(' · ');
      $('libraryDetailDescription').textContent = video.description || '暂无简介'; $('libraryDetailCast').textContent = [video.director && '导演：' + video.director, video.actor && '主演：' + video.actor].filter(Boolean).join('　');
      $('libraryDetailPicture').hidden = !video.picture; if (video.picture) $('libraryDetailPicture').src = video.picture;
      $('libraryLines').replaceChildren(...video.lines.map((line, index) => option(index, line.name + ` · ${line.episodes.length} 集`)));
      renderEpisodes(); $('libraryDetail').showModal(); status('选择剧集开始播放');
    } catch (error) { report(error); }
  }
  function renderEpisodes() {
    $('libraryEpisodes').replaceChildren();
    const episodes = state.detail?.lines[state.line]?.episodes || [];
    if (!episodes.length) { $('libraryEpisodes').append(node('p', 'field-hint', '站点没有返回可选剧集')); return; }
    for (let index = 0; index < episodes.length; index++) { const button = node('button', 'episode-button', episodes[index].name); button.type = 'button'; if (state.playback?.vodId === state.detail.id && state.playback?.line === state.line && state.playback?.index === index) button.classList.add('active'); button.addEventListener('click', () => playEpisode(index, button)); $('libraryEpisodes').append(button); }
  }
  async function playEpisode(index, button) {
    button.disabled = true; $('libraryDetailStatus').textContent = '正在解析播放地址…';
    try { const result = await api('/play', { siteKey: state.site, vodId: state.detail.id, line: state.line, index, parserKey: $('libraryParser').value }); state.playback = result.playback; $('libraryDetail').close(); $('libraryDetailStatus').textContent = ''; updateControls(); }
    catch (error) { $('libraryDetailStatus').textContent = error.message; }
    finally { button.disabled = false; }
  }

  async function loadChannels(refresh = false) {
    if (!state.liveSource) return;
    const request = begin(); status('正在读取直播频道…'); $('libraryChannelList').replaceChildren(node('p', 'library-empty', '正在加载频道…'));
    try {
      const data = await api('/channels?' + new URLSearchParams({ source: state.liveSource, refresh: refresh ? '1' : '0' }), undefined, request.signal); if (request.id !== state.request) return;
      state.channels = data.channels; $('libraryLiveGroup').replaceChildren(option('', '全部分组'), ...[...new Set(data.channels.map(channel => channel.group))].map(group => option(group, group))); renderChannels(); status(`已载入 ${data.channels.length} 个频道`);
    } catch (error) { state.channels = []; renderChannels(); report(error); }
  }
  function renderChannels() {
    const group = $('libraryLiveGroup').value, keyword = $('libraryLiveSearch').value.toLowerCase().trim();
    const channels = state.channels.filter(channel => (!group || group === channel.group) && (!keyword || channel.name.toLowerCase().includes(keyword)));
    $('libraryChannelList').replaceChildren();
    if (!channels.length) { $('libraryChannelList').append(node('p', 'library-empty', state.channels.length ? '没有找到匹配频道' : '导入配置并选择直播源')); return; }
    for (const channel of channels.slice(0, state.channelLimit)) {
      const button = node('button', 'live-channel'); button.type = 'button'; button.append(node('strong', '', channel.name), node('span', '', `${channel.group}${channel.lines > 1 ? ` · ${channel.lines} 条线路` : ''}`));
      button.addEventListener('click', () => playChannel(channel.id, 0, button)); $('libraryChannelList').append(button);
    }
    $('libraryMoreChannels').hidden = channels.length <= state.channelLimit;
    $('libraryMoreChannels').textContent = `再显示更多频道（${Math.min(state.channelLimit, channels.length)} / ${channels.length}）`;
  }
  async function playChannel(channelId, line = 0, button) {
    if (button) button.disabled = true; status('正在连接频道…');
    try { const result = await api('/live/play', { sourceKey: state.liveSource, channelId, line }); state.playback = result.playback; updateControls(); }
    catch (error) { report(error); toast(error.message); }
    finally { if (button) button.disabled = false; }
  }

  function currentPlayback() { const current = window.MobileTVPlayerState?.(); return current && state.playback?.sessionId === current.sessionId && ['Library', 'Live'].includes(current.protocol) && !['IDLE', 'STOPPED'].includes(current.status) ? state.playback : null; }
  function updateControls() {
    const playback = currentPlayback(); $('libraryPlayerTools').hidden = !playback;
    if (!playback) return;
    const vod = playback.kind === 'vod';
    $('libraryPlayerTitle').textContent = vod ? `${playback.index + 1} / ${playback.episodes.length} 集` : playback.title;
    $('libraryPlayerPrevious').textContent = vod ? '上一集' : '上一台'; $('libraryPlayerNext').textContent = vod ? '下一集' : '下一台';
    $('libraryPlayerPrevious').disabled = vod && playback.index === 0; $('libraryPlayerNext').disabled = vod && playback.index >= playback.episodes.length - 1;
    $('libraryChooseEpisode').hidden = !vod; $('libraryAutoNextLabel').hidden = !vod;
    const channel = !vod && playback.channels?.find(value => value.id === playback.channelId);
    $('librarySwitchLine').hidden = vod || !channel || channel.lines <= 1;
    if (channel?.lines > 1) $('librarySwitchLine').textContent = `换线 ${playback.channelLine + 1}/${channel.lines}`;
  }
  async function next(direction, automatic = false) {
    const playback = currentPlayback(); if (!playback) return;
    try { const result = await api('/next', { direction, sessionId: playback.sessionId }); state.playback = result.playback; updateControls(); }
    catch (error) { if (!automatic || !/边界/.test(error.message)) toast(error.message); }
  }

  for (const button of document.querySelectorAll('[data-library-nav]')) button.addEventListener('click', () => setMode(button.dataset.libraryNav));
  $('librarySourceForm').addEventListener('submit', event => { event.preventDefault(); importSource($('librarySourceUrl').value); });
  $('librarySite').addEventListener('change', () => { state.site = $('librarySite').value; $('librarySearch').value = ''; loadHome(); });
  $('librarySearchForm').addEventListener('submit', event => { event.preventDefault(); if (!state.site) return; state.keyword = $('librarySearch').value.trim(); state.category = ''; loadList(1); });
  $('libraryPrevious').addEventListener('click', () => loadList(state.page - 1)); $('libraryMore').addEventListener('click', () => loadList(state.page + 1));
  $('libraryCloseDetail').addEventListener('click', () => $('libraryDetail').close()); $('libraryLines').addEventListener('change', () => { state.line = Number($('libraryLines').value); renderEpisodes(); });
  $('libraryLiveSource').addEventListener('change', () => { state.liveSource = $('libraryLiveSource').value; loadChannels(); }); $('libraryLiveRefresh').addEventListener('click', () => loadChannels(true));
  $('libraryLiveGroup').addEventListener('change', () => { state.channelLimit = 300; renderChannels(); }); $('libraryLiveSearch').addEventListener('input', () => { state.channelLimit = 300; renderChannels(); });
  $('libraryMoreChannels').addEventListener('click', () => { state.channelLimit += 300; renderChannels(); });
  $('libraryPlayerPrevious').addEventListener('click', () => next(-1)); $('libraryPlayerNext').addEventListener('click', () => next(1));
  $('libraryChooseEpisode').addEventListener('click', () => { const current = currentPlayback(); if (!current || current.kind !== 'vod') return; state.site = current.siteKey; showDetail(current.vodId); });
  $('librarySwitchLine').addEventListener('click', () => { const current = currentPlayback(); if (!current || current.kind !== 'live') return; const channel = current.channels.find(value => value.id === current.channelId); state.liveSource = current.sourceKey; playChannel(current.channelId, (current.channelLine + 1) % channel.lines); });
  try { $('libraryAutoNext').checked = localStorage.getItem('mobiletv-auto-next') !== 'off'; } catch {}
  $('libraryAutoNext').addEventListener('change', () => { try { localStorage.setItem('mobiletv-auto-next', $('libraryAutoNext').checked ? 'on' : 'off'); } catch {} });
  $('tvVideo').addEventListener('ended', () => { const current = currentPlayback(); if (current?.kind === 'vod' && $('libraryAutoNext').checked) next(1, true); });
  setInterval(updateControls, 800);
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '') || event.target?.isContentEditable || document.querySelector('dialog[open]') || $('logDrawer')?.classList.contains('open')) return;
    if (currentPlayback() && ['n', 'p'].includes(event.key.toLowerCase())) { event.preventDefault(); next(event.key.toLowerCase() === 'n' ? 1 : -1); }
  });
  (async () => {
    try { renderConfig(await api('/config')); state.playback = (await api('/playback')).playback; let mode = 'cast'; try { mode = localStorage.getItem('mobiletv-section') || 'cast'; } catch {} setMode(['cast', 'vod', 'live'].includes(mode) ? mode : 'cast'); updateControls(); }
    catch (error) { status(error.message, true); }
  })();
})();
