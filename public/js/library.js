(() => {
  'use strict';
  const $ = id => document.getElementById(id);
  const state = { config: null, mode: 'cast', site: '', category: '', keyword: '', filters: {}, filterDefinitions: {}, page: 1, pages: 1, detail: null, line: 0, channels: [], channelLimit: 300, liveSource: '', playback: null, request: 0, fetching: null };
  const toast = message => window.MobileTVUI?.toast(message);
  const node = (tag, className, value) => { const element = document.createElement(tag); if (className) element.className = className; if (value != null) element.textContent = value; return element; };
  const option = (value, label, disabled = false) => { const element = node('option', '', label); element.value = value; element.disabled = disabled; return element; };
  const artworkUrl = value => window.MobileTVArtwork.url(value, location.href);
  const status = (message, error = false) => { $('libraryStatus').textContent = message; $('libraryStatus').classList.toggle('error', error); $('libraryVerify').hidden = !error || !state.verifyUrl; $('libraryVerifyRetry').hidden = !error; };
  state.shelf = 'browse'; state.collection = { history: [], favorites: [] };
  async function api(route, body, signal) {
    const response = await fetch('/api/library' + route, { ...(body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }), signal });
    const result = await response.json();
    signal?.throwIfAborted();
    if (!response.ok) { if(result.verifyUrl&&!route.startsWith('/accounts')) state.verifyUrl=result.verifyUrl; throw Object.assign(new Error(result.error || '操作失败，请重试'),{verifyUrl:result.verifyUrl,requiresSave:result.requiresSave,saveFile:result.saveFile,capacityLimited:result.capacityLimited}); }
    return result;
  }
  function begin() { cancelEpisodeRequest(); state.fetching?.abort(); $('libraryCancelSearch').hidden = true; state.fetching = new AbortController(); return { id: ++state.request, signal: state.fetching.signal }; }
  function report(error) { if (error.name !== 'AbortError') status(error.message, true); }
  function placeholder(message) { $('libraryResults').classList.remove('is-schedule'); $('libraryScheduleFilters').hidden = true; $('libraryResults').replaceChildren(node('div', 'library-empty', message)); $('libraryPager').hidden = true; }
  function syncSearchUi() {
    const site=state.config?.sites.find(item=>item.key===state.site),discovery=Boolean(site?.discovery);
    if(discovery)$('librarySearchAll').checked=true;
    $('librarySearchAll').disabled=discovery;
    $('librarySearchAll').title=discovery?'片单提供推荐，搜索会查找全部可用片源':'勾选搜索全部片源，取消只搜索当前片源';
    const all=$('librarySearchAll').checked;
    $('librarySearchHint').textContent=state.keyword?`${all?'全部片源':site?.name||'当前片源'} · “${state.keyword}” 的搜索结果`:discovery?'片单提供推荐；点击海报可查找播放线路，也可直接搜索片名、演员。':`正在浏览 ${site?.name||'当前片源'} · 搜索范围：${all?'全部片源':'当前片源'}`;
    $('libraryResetSearch').hidden=!state.keyword;$('libraryCategories').hidden=Boolean(state.keyword);if(state.keyword)$('libraryFilters').hidden=true;
  }

  function setMode(mode) {
    if (state.mode !== mode) begin();
    state.mode = mode;
    window.MobileTVUI?.updateTitle?.({ section: ({ cast: '投屏', vod: '影视片库', live: '直播电视' })[mode] || 'MobileTV' });
    $('standbyView').hidden = mode !== 'cast'; $('libraryView').hidden = mode === 'cast';
    $('libraryVod').hidden = mode !== 'vod'; $('libraryLive').hidden = mode !== 'live';
    for (const button of document.querySelectorAll('[data-library-nav]')) { const active = button.dataset.libraryNav === mode; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
    try { localStorage.setItem('mobiletv-section', mode); } catch {}
    state.shelf = 'browse'; renderShelf();
    if (mode === 'vod') { $('libraryTitle').textContent = '影视片库'; if (state.site) loadHome(); else placeholder('先添加订阅地址，选择一个已适配的站点。'); }
    if (mode === 'live') { $('libraryTitle').textContent = '直播电视'; if (state.liveSource) loadChannels(); else renderChannels(); }
  }

  function renderConfig(config) {
    state.config = config; $('librarySourceUrl').value = config.url || '';
    $('librarySavedSource').replaceChildren(...(config.sources?.length ? config.sources.map(item => option(item.id, item.name)) : [option('', '添加订阅地址')]));
    $('librarySavedSource').value = config.sourceId || ''; renderSavedSources();
    const supported = config.sites.filter(site => site.supported);
    $('libraryCompatibility').textContent = config.url ? `${config.sites.length} 个条目 · ${supported.length} 个已接入 · ${config.lives.length} 组直播（可播性取决于源与账号）` : '支持 TVBox 配置、通用点播接口与 M3U / TXT / JSON 直播列表';
    const siteSelect = $('librarySite'); siteSelect.replaceChildren();
    for (const site of [...supported, ...config.sites.filter(item => !item.supported)]) siteSelect.append(option(site.key, site.name + (site.supported ? '' : '（待适配）'), !site.supported));
    state.site = supported.some(item => item.key === state.site) ? state.site : supported[0]?.key || ''; siteSelect.value = state.site;
    $('librarySearchAll').checked = Boolean(supported.find(item => item.key === state.site)?.discovery);
    const liveSelect = $('libraryLiveSource'); liveSelect.replaceChildren();
    for (const source of config.lives) liveSelect.append(option(source.key, source.name + (source.supported ? '' : '（待适配）'), !source.supported));
    state.liveSource = config.lives.some(item => item.key === state.liveSource && item.supported) ? state.liveSource : config.lives.find(item => item.supported)?.key || ''; liveSelect.value = state.liveSource;
    $('libraryParser').replaceChildren(option('', '自动 / 直链播放'), ...config.parsers.map(item => option(item.key, item.name + (item.supported === false ? '（待移植）' : item.type === 0 ? '（网页）' : '（JSON）'),item.supported===false)));
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
      const config = await api('/config', { url: url.trim(), name: $('librarySourceName').value.trim() }); renderConfig(config); resetSourceView(); $('librarySourcesDialog').close();
      status('配置已保存到本机。请选择站点或直播源。');
      if (state.mode === 'live') { if (state.liveSource) await loadChannels(); else renderChannels(); }
      else if (state.site) await loadHome(); else placeholder('该配置中的点播站点需要专用适配，当前可切换到直播使用已兼容频道组。');
    } catch (error) { report(error); $('librarySourceStatus').textContent = error.message; }
    finally { $('libraryImport').disabled = false; }
  }

  function resetSourceView() { begin(); state.channels = []; state.category = ''; state.keyword = ''; state.filters = {}; state.verifyUrl = ''; state.drawerSource = ''; $('librarySearch').value = ''; $('librarySourceName').value = ''; state.shelf = 'browse'; renderShelf(); }
  async function switchSource(id) {
    $('librarySavedSource').disabled = true;
    try { const config = await api('/sources/select', { id }); renderConfig(config); resetSourceView(); if (state.mode === 'live') await loadChannels(); else await loadHome(); }
    catch (error) { report(error); $('librarySavedSource').value = state.config?.sourceId || ''; }
    finally { $('librarySavedSource').disabled = false; }
  }
  function renderSavedSources() {
    $('librarySavedSources').replaceChildren();
    for (const source of state.config?.sources || []) {
      const row = node('div', 'saved-source'), name = node('input', 'input-box'), meta = node('span', 'saved-source-url', source.url), actions = node('div', 'saved-source-actions');
      name.value = source.name; name.maxLength = 80; name.setAttribute('aria-label', '订阅名称：' + source.name); meta.title = source.url;
      const use = node('button', 'btn', source.id === state.config.sourceId ? '使用中' : '切换'), save = node('button', 'btn', '改名'), remove = node('button', 'text-button', '移除');
      use.type = save.type = remove.type = 'button'; use.disabled = remove.disabled = source.id === state.config.sourceId;
      use.addEventListener('click', async () => { await switchSource(source.id); $('librarySourcesDialog').close(); });
      save.addEventListener('click', async () => { try { renderConfig(await api('/sources/rename', { id: source.id, name: name.value })); $('librarySourceStatus').textContent = '名称已保存'; } catch (error) { $('librarySourceStatus').textContent = error.message; } });
      remove.addEventListener('click', async () => { try { renderConfig(await api('/sources/remove', { id: source.id })); } catch (error) { $('librarySourceStatus').textContent = error.message; } });
      actions.append(use, save, remove); row.append(name, meta, actions); $('librarySavedSources').append(row);
    }
  }
  async function refreshCollection() { state.collection = await api('/collection'); renderCollectionCounts(); if (state.shelf !== 'browse') renderCollection(); }
  function renderCollectionCounts() {
    $('libraryHistoryCount').textContent = state.collection.history.length; $('libraryFavoriteCount').textContent = state.collection.favorites.length;
    updateFavoriteButtons();
    const last = state.collection.history.find(item => item.kind === 'live'); $('libraryLiveResume').hidden = !last; if (last) $('libraryLiveResume').textContent = '继续观看 · ' + last.title;
  }
  function renderShelf() {
    $('libraryVod').hidden = state.mode !== 'vod' || state.shelf !== 'browse'; $('libraryLive').hidden = state.mode !== 'live' || state.shelf !== 'browse'; $('libraryCollection').hidden = state.shelf === 'browse';
    for (const button of document.querySelectorAll('[data-library-shelf]')) { const active = button.dataset.libraryShelf === state.shelf; button.classList.toggle('active', active); button.setAttribute('aria-pressed', String(active)); }
    if (state.shelf !== 'browse') renderCollection();
  }
  const timeLabel = seconds => { seconds = Math.floor(Number(seconds) || 0); return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`; };
  function renderCollection() {
    const history = state.shelf === 'history', list = state.collection[history ? 'history' : 'favorites'];
    $('libraryCollectionNote').textContent = history ? '保留最近 200 条记录 · 点击继续观看' : '影片与频道收藏 · 仅保存在本机'; $('libraryClearHistory').hidden = !history || !list.length;
    $('libraryCollectionList').replaceChildren();
    if (!list.length) { $('libraryCollectionList').append(node('div', 'library-empty', history ? '还没有播放记录，开始观看后会自动保留进度。' : '还没有收藏，可在影片详情或频道旁点击 ☆。')); return; }
    for (const item of list) {
      const card = node('article', 'collection-card'), open = node('button', 'collection-open'), body = node('div', 'collection-info'), picture = artworkUrl(item.picture), poster = node('div', 'collection-poster', item.kind === 'live' ? 'TV' : '▶');
      open.type = 'button';
      if (picture) { const image = node('img'); image.alt = ''; image.loading = 'lazy'; image.src = picture; image.addEventListener('error', () => image.remove()); poster.replaceChildren(image); }
      const source = state.config?.sources?.find(source => source.id === item.sourceId);
      body.append(node('strong', '', item.title), node('span', '', [item.kind === 'live' ? '直播' : item.episode, source?.name || '订阅已移除'].filter(Boolean).join(' · ')));
      if (history && item.kind === 'vod') { body.append(node('small', '', item.duration > 0 && item.position >= item.duration - Math.min(20, item.duration * .05) ? '已看完 · 重新播放' : '看到 ' + timeLabel(item.position))); if (item.duration > 0) { const track = node('div', 'collection-progress'), fill = node('i'); fill.style.width = Math.min(100, 100 * item.position / item.duration) + '%'; track.append(fill); body.append(track); } }
      open.append(poster, body); open.disabled = !source; open.addEventListener('click', () => history || item.kind === 'live' ? resumeItem(item.id, !history, open) : openFavorite(item, open));
      const remove = node('button', 'collection-remove', '×'); remove.type = 'button'; remove.setAttribute('aria-label', (history ? '删除记录：' : '取消收藏：') + item.title);
      remove.addEventListener('click', async () => { try { state.collection = await api('/collection/remove', { kind: state.shelf, id: item.id }); renderCollectionCounts(); renderCollection(); } catch (error) { toast(error.message); } });
      card.append(open, remove); $('libraryCollectionList').append(card);
    }
  }
  async function openFavorite(item, button) {
    button.disabled = true;
    try {
      if (item.sourceId !== state.config?.sourceId) { renderConfig(await api('/sources/select', { id: item.sourceId })); state.channels = []; state.drawerSource = ''; }
      state.site = item.siteKey; $('librarySite').value = item.siteKey; await showDetail(item.vodId, false, item.title);
    } catch (error) { report(error); toast(error.message); }
    finally { button.disabled = false; }
  }
  async function resumeItem(id, favorite = false, button) {
    if (button) button.disabled = true; status('正在恢复播放…');
    try { const result = await api('/resume', { id, favorite }); state.playback = result.playback; const config = await api('/config'); if (config.sourceId !== state.config?.sourceId) { state.channels = []; state.drawerSource = ''; $('libraryDrawerGroup').replaceChildren(option('', '全部分组')); } renderConfig(config); updateControls(); await refreshCollection(); }
    catch (error) { report(error); toast(error.message); }
    finally { if (button) button.disabled = false; }
  }
  function isFavorite(selection) { return state.collection.favorites.some(item => item.sourceId === (selection.sourceId || state.config?.sourceId) && item.kind === selection.kind && (item.kind === 'live' ? item.sourceKey === selection.sourceKey && item.channelId === selection.channelId : item.siteKey === selection.siteKey && String(item.vodId) === String(selection.vodId))); }
  function updateFavoriteButtons() {
    const detail = { kind: 'vod', siteKey: state.site, vodId: state.detail?.id };
    for (const [button, selection] of [[$('libraryDetailFavorite'), detail], [$('libraryPlayerFavorite'), currentPlayback()]]) if (selection) { const saved = isFavorite(selection); button.textContent = saved ? '★ 已收藏' : '☆ 收藏'; button.setAttribute('aria-pressed', String(saved)); }
  }
  async function toggleFavorite(selection, button) {
    if (!selection) return; if (button) button.disabled = true;
    try { state.collection = await api('/favorites', { ...selection, saved: !isFavorite(selection) }); renderCollectionCounts(); if (state.channels.length) renderChannels(); renderDrawer(); }
    catch (error) { toast(error.message); }
    finally { if (button) button.disabled = false; }
  }

  function renderCategories(classes) {
    $('libraryCategories').replaceChildren();
    for (const category of [{ id: '', name: '推荐' }, ...classes]) {
      const button = node('button', 'category-pill' + (state.category === category.id ? ' active' : ''), category.name); button.type = 'button';
      button.addEventListener('click', () => { state.category = category.id; state.keyword = ''; state.filters = {}; renderFilters(); $('librarySearch').value = ''; for (const item of $('libraryCategories').children) item.classList.toggle('active', item === button); if (!category.id) loadHome(); else loadList(1); });
      $('libraryCategories').append(button);
    }
  }

  function renderFilters() {
    const definitions = state.filterDefinitions[state.category] || [];
    $('libraryFilters').replaceChildren(); $('libraryFilters').hidden = !definitions.length;
    for (const field of definitions.slice(0, 12)) {
      if (!field.key || !Array.isArray(field.value)) continue;
      const label = node('label', '', field.name || field.key), select = node('select', 'library-select');
      for (const choice of field.value.slice(0, 1000)) select.append(option(String(choice.v ?? ''), String(choice.n ?? choice.v ?? '全部')));
      select.value = state.filters[field.key] ?? select.options[0]?.value ?? ''; state.filters[field.key] = select.value;
      select.addEventListener('change', () => { state.filters[field.key] = select.value; loadList(1); }); label.append(select); $('libraryFilters').append(label);
    }
  }

  function renderVideos(data, append = false) {
    if (data.list.some(item => item.schedule)) { renderEvents(data); return; }
    $('libraryScheduleFilters').hidden = true; $('libraryResults').classList.remove('is-schedule');
    state.page = data.page; state.pages = data.pageCount;
    if (!append) $('libraryResults').replaceChildren();
    const container=$('libraryResults'),focused=document.activeElement;
    const existing = new Map([...container.querySelectorAll('.vod-card')].map(card => [card.dataset.key,card]));
    const retained=new Set();
    if (data.list.length) $('libraryResults').querySelectorAll('.library-empty').forEach(element => element.remove());
    let before=container.firstElementChild;
    if (!data.list.length && (!append || data.done)) placeholder(data.done ? '没有找到片源，可换个关键词或稍后重试。' : data.notice || '没有找到影片，换个关键词或分类试试。');
    else for (const video of data.list) {
      const key = JSON.stringify([video.siteKey || state.site, video.id]);
      retained.add(key);
      if (append && existing.has(key)) {
        const card=existing.get(key),label=card.querySelector('.vod-match');if(label){label.textContent=video.match?.label||'';label.hidden=!label.textContent;}
        if(card!==before){if(typeof container.moveBefore==='function')container.moveBefore(card,before);else container.insertBefore(card,before);}before=card.nextElementSibling;continue;
      }
      const card = node('button', 'vod-card'); card.type = 'button'; card.title = video.title;
      card.dataset.key = key;
      const artwork = node('div', 'vod-artwork');
      const picture = artworkUrl(video.picture), fallback = node('span', 'vod-poster-placeholder', '暂无海报'); fallback.hidden = Boolean(picture); artwork.append(fallback);
      if (picture) { const img = node('img'); img.alt = ''; img.loading = 'lazy'; img.decoding = 'async'; img.addEventListener('error', () => { img.hidden = true; fallback.textContent = '海报暂不可用'; fallback.hidden = false; }); img.src = picture; artwork.append(img); }
      if (video.remarks) artwork.append(node('span', 'vod-remark', video.remarks));
      card.append(artwork, node('strong', 'vod-title', video.title), node('span', 'vod-meta', [video.sourceName, video.year, video.area, video.category].filter(Boolean).join(' · ')));
      const label=node('span','vod-match',video.match?.label||'');label.hidden=!label.textContent;card.append(label);
      card.addEventListener('click', () => { if(video.searchTitle){searchSources(video.searchTitle);return;} if(video.siteKey){state.site=video.siteKey;$('librarySite').value=video.siteKey;} if(video.folder){state.category=video.id;loadList(1);}else showDetail(video.id,false,video.title); }); container.insertBefore(card,before);before=card.nextElementSibling;
    }
    if(append){for(const [key,card]of existing)if(!retained.has(key)&&!card.contains(focused))card.remove();if(focused?.isConnected&&document.activeElement!==focused)focused.focus({preventScroll:true});}
    $('libraryPager').hidden = !data.list.length || data.pageCount <= 1;
    $('libraryPage').textContent = `${data.page} / ${data.pageCount}`;
    $('libraryPrevious').disabled = data.page <= 1; $('libraryMore').disabled = data.page >= data.pageCount;
    status(data.notice || `${data.list.length} 个结果${data.total ? ` · 共 ${data.total} 项` : ''}`);
  }

  function renderEvents(data) {
    if (state.events !== data) { const previous = $('libraryMatchDate').value; state.events = data; const days = [...new Set(data.list.map(item => item.schedule?.day).filter(Boolean))]; $('libraryMatchDate').replaceChildren(option('', '全部日期'), ...days.map(day => option(day, day))); if (days.includes(previous)) $('libraryMatchDate').value = previous; }
    const container = $('libraryResults'), day = $('libraryMatchDate').value, matchStatus = $('libraryMatchStatus').value;
    const items = data.list.filter(item => (!day || item.schedule?.day === day) && (!matchStatus || item.schedule?.status === matchStatus));
    container.classList.add('is-schedule'); container.replaceChildren(); $('libraryScheduleFilters').hidden = false; $('libraryPager').hidden = true;
    let previousDay = null;
    for (const item of items) {
      const match = item.schedule || {}, date = match.day || '日期待确认';
      if (date !== previousDay) { container.append(node('h3', 'schedule-day', date)); previousDay = date; }
      const row = node('button', 'schedule-match'); row.type = 'button';
      const info = node('div', 'schedule-match-info'); info.append(node('span', 'schedule-league', match.league || '赛事直播'));
      if(match.teams?.length===2){const teams=node('div','schedule-teams');match.teams.forEach((team,i)=>{if(i)teams.append(node('span','match-versus','VS'));teams.append(teamCard(team));});info.append(teams);}else{const entry=node('div','schedule-team');if(item.picture)entry.append(teamImage(item.picture,item.title));entry.append(node('strong','',item.title));info.append(entry);}
      const badge = node('span', 'schedule-status', match.statusLabel || '状态待确认'); badge.dataset.status = match.status;
      row.append(node('time', 'schedule-time', match.time || '--:--'), info, badge, node('span', 'schedule-watch', match.status === 'upcoming' ? '查看线路 →' : '观看 →'));
      row.addEventListener('click', () => { if (item.siteKey) state.site = item.siteKey; showDetail(item.id, false, item.title); }); container.append(row);
    }
    if (!items.length) container.append(node('div', 'library-empty', '此日期 / 状态下没有赛事'));
    status(`${items.length} 场赛事 · 按日期与状态排序`);
  }
  function teamImage(url,name) {
    const image=node('img');image.src=artworkUrl(url);image.alt=name+'队标';image.loading='lazy';image.decoding='async';image.addEventListener('error',()=>{image.hidden=true;});return image;
  }
  function teamCard(team) {
    const card=node('div','schedule-team');if(team.logo)card.append(teamImage(team.logo,team.name));else card.append(node('span','team-initial',Array.from(team.name||'球队').slice(0,2).join('')));card.append(node('strong','',team.name));return card;
  }

  async function searchSources(title) {
    title = String(title || '').trim(); if (!title) { $('librarySearch').focus(); return; }
    const request = begin(); state.keyword = title; state.category = ''; state.filters = {};
    $('librarySearch').value = title; $('librarySearchAll').checked = true; $('libraryFilters').hidden = true;
    syncSearchUi();
    placeholder('正在搜索片源…'); status('正在搜索片源，有结果后即可选择播放。'); $('libraryCancelSearch').hidden = false;
    let reader;
    try {
      const response = await fetch('/api/library/search/stream?keyword=' + encodeURIComponent(title), { signal: request.signal });
      if (!response.ok || !response.body) throw new Error('搜索服务暂时不可用，请重试');
      reader = response.body.getReader(); const decoder = new TextDecoder(); let pending = '';
      while (request.id === state.request) {
        const chunk = await reader.read(); if (chunk.done) break;
        pending += decoder.decode(chunk.value, { stream: true });
        if (pending.length > 2 * 1024 * 1024) throw new Error('搜索结果过大，请缩小关键词范围');
        let end;
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const event = pending.slice(0, end); pending = pending.slice(end + 2);
          const line = event.split('\n').find(value => value.startsWith('data: ')); if (!line || request.id !== state.request) continue;
          const data = JSON.parse(line.slice(6)); if (data.error) throw new Error(data.error);
          renderVideos(data, true);
        }
      }
    } catch (error) { if (request.id === state.request) report(error); }
    finally { try { await reader?.cancel(); } catch {} if (request.id === state.request) $('libraryCancelSearch').hidden = true; }
  }

  async function loadHome() {
    if (!state.site) return;
    const request = begin(); state.category = ''; state.keyword = ''; state.page = 1; status('正在加载影片…'); placeholder('正在加载…');
    syncSearchUi();
    $('libraryCategories').replaceChildren(); state.filterDefinitions = {}; state.filters = {}; renderFilters();
    try { const data = await api('/home?site=' + encodeURIComponent(state.site), undefined, request.signal); if (request.id !== state.request) return; state.filterDefinitions = data.filters || {}; state.filters = {}; renderCategories(data.classes); renderFilters(); renderVideos(data); }
    catch (error) { if (request.id === state.request && error.name !== 'AbortError') { placeholder('站点暂时没有响应，可切换其他站点或重试。'); report(error); } }
  }
  async function loadList(page) {
    syncSearchUi();
    const request = begin(); status('正在读取列表…');
    try { const query = new URLSearchParams({ site: state.site, category: state.category, keyword: state.keyword, page: String(page), filters: JSON.stringify(state.filters) }); const data = await api('/list?' + query, undefined, request.signal); if (request.id === state.request) renderVideos(data); }
    catch (error) { if (request.id === state.request) report(error); }
  }

  function detailLoading(loading) {
    $('libraryDetail').classList.toggle('is-loading',loading);$('libraryDetail').setAttribute('aria-busy',String(loading));$('libraryDetailLoading').hidden=!loading;
    $('libraryLines').disabled=loading||!state.detail;$('libraryParser').disabled=loading;
  }
  async function showDetail(id, refresh = false, title = '') {
    const previousProvider = refresh ? state.detail?.lines[state.line]?.provider : '';
    title=title||(state.detail?.id===id?state.detail.title:'影片详情');
    const request = begin();state.detailRequest=request.id;state.detail=null;status('正在读取影片详情…'); $('libraryDetailStatus').replaceChildren();
    $('libraryDetailTitle').textContent=title;for(const key of ['libraryDetailInfo','libraryDetailDescription','libraryDetailCast'])$(key).textContent='';
    $('libraryDetailPicture').hidden=true;$('libraryDetailPicture').removeAttribute('src');$('libraryMatchTeams').hidden=true;$('libraryMatchTeams').replaceChildren();$('libraryDetail').classList.remove('is-match');$('libraryLines').replaceChildren();$('libraryEpisodes').replaceChildren();
    $('libraryDetailFavorite').hidden = true; detailLoading(true);if(!$('libraryDetail').open)$('libraryDetail').showModal();
    try {
      const video = await api('/detail?' + new URLSearchParams({ site: state.site, id, ...(refresh ? {refresh:'1'} : {}) }), undefined, request.signal); if (request.id !== state.request) return;
      state.detail = video; state.line = 0; $('libraryDetailTitle').textContent = video.title; $('libraryDetailInfo').textContent = [video.year, video.area, video.category].filter(Boolean).join(' · ');
      if(previousProvider)state.line=Math.max(0,video.lines.findIndex(line=>line.provider===previousProvider));
      $('libraryDetailDescription').textContent = video.description || '暂无简介'; $('libraryDetailCast').textContent = [video.director && '导演：' + video.director, video.actor && '主演：' + video.actor].filter(Boolean).join('　');
      const picture = artworkUrl(video.picture); $('libraryDetailPicture').hidden = !picture; if (picture) $('libraryDetailPicture').src = picture;
      const isMatch=Boolean(video.schedule);$('libraryDetail').classList.toggle('is-match',isMatch);
      if(video.schedule?.teams?.length===2){const container=$('libraryMatchTeams');container.hidden=false;video.schedule.teams.forEach((team,i)=>{if(i)container.append(node('span','match-versus','VS'));container.append(teamCard(team));});$('libraryDetailPicture').hidden=true;}
      const providers = { quark: '夸克', uc: 'UC', ali: '阿里', baidu: '百度' };
      $('libraryLines').replaceChildren(...video.lines.map((line, index) => option(index, (providers[line.provider] ? providers[line.provider] + ' · ' : '') + line.name + (line.notice && !line.episodes.length ? ' · 待验证' : ` · ${line.episodes.length} ${isMatch?'条':'集'}`))));
      $('libraryLines').value=String(state.line);
      $('libraryDetailFavorite').hidden = Boolean(video.searchTitle); updateFavoriteButtons(); renderEpisodes();status(isMatch?'选择一条直播线路；不可用时可尝试其他线路。':'选择剧集开始播放');
    } catch (error) {
      if(request.id===state.request&&error.name!=='AbortError'&&$('libraryDetail').open){
        report(error);$('libraryDetailStatus').textContent=error.message;
        if(error.verifyUrl)verificationButton($('libraryDetailStatus'),error.verifyUrl);
        const retry=node('button','btn','重试读取选集');retry.type='button';retry.addEventListener('click',()=>showDetail(id,refresh,title));$('libraryDetailStatus').append(retry);
      }
    } finally {if(state.detailRequest===request.id){state.detailRequest=null;detailLoading(false);}}
  }
  function verificationButton(container, url, label='打开登录 / 验证页面') {
    const button = node('button', 'btn', label); button.type = 'button';
    button.addEventListener('click', async () => { try { await api('/browser/open', { siteKey: state.site, verifyUrl: url }); toast('在已打开的官方页面完成操作后重试。'); } catch(error) { toast(error.message); } });
    container.append(button);
  }
  function renderEpisodes() {
    cancelEpisodeRequest(); $('libraryDetailStatus').classList.remove('is-resolving');
    $('libraryDetailStatus').replaceChildren();
    $('libraryEpisodes').replaceChildren();
    const episodes = state.detail?.lines[state.line]?.episodes || [];
    $('libraryEpisodes').classList.toggle('has-file-names', episodes.some(episode => String(episode.name || '').length > 24));
    if (!episodes.length) {
      const line = state.detail?.lines[state.line];
      if (line?.notice) {
        const panel=node('div','library-verification');panel.append(node('p', 'field-hint', line.notice));
        if(line.verifyUrl)verificationButton(panel,line.verifyUrl);
        const retry=node('button','btn','重新读取线路');retry.type='button';retry.addEventListener('click',()=>showDetail(state.detail.id,true));panel.append(retry);$('libraryEpisodes').append(panel);
      } else if (state.detail?.searchTitle) {
        const button=node('button','btn btn-primary','查找片源');button.type='button';
        button.addEventListener('click', ()=>{const title=state.detail.searchTitle;$('libraryDetail').close();searchSources(title);});
        $('libraryEpisodes').append(button);
      } else $('libraryEpisodes').append(node('p', 'field-hint', '站点没有返回可选剧集')); return;
    }
    for (let index = 0; index < episodes.length; index++) {
      const name = String(episodes[index].name || `第${index + 1}集`), button = node('button', 'episode-button');
      button.type = 'button'; button.title = name; button.setAttribute('aria-label', name);
      const code=/S\d{1,2}[\s._-]*E\d{1,3}/i.exec(name)?.[0]?.replace(/[\s._-]/g,'').toUpperCase();
      const number = node('span', 'episode-number', code || String(index + 1).padStart(2, '0')); number.setAttribute('aria-hidden', 'true');
      button.append(number, node('span', 'episode-label', name.replace(/[_\.](?=[^\d]|$)/g,' ')));
      if (state.playback?.vodId === state.detail.id && state.playback?.line === state.line && state.playback?.index === index) { button.classList.add('active'); button.setAttribute('aria-current', 'true'); }
      button.addEventListener('click', () => playEpisode(index, button)); $('libraryEpisodes').append(button);
    }
  }
  async function playEpisode(index, button, saveToDrive=false) {
    cancelEpisodeRequest();
    const selection={siteKey:state.site,vodId:state.detail?.id,line:state.line,index};
    const detail = state.detail, selected=()=>state.site===selection.siteKey&&state.detail===detail&&state.line===selection.line&&$('libraryDetail').open;
    const episode = state.detail?.lines[state.line]?.episodes[index];
    if (episode?.id.startsWith('magnet:?')) { $('libraryDetail').close(); await showDetail(episode.id); return; }
    const attempt = { controller: new AbortController(), button, started: Date.now() }; state.episodeRequest = attempt;
    const current = () => state.episodeRequest === attempt && selected();
    button.disabled = true;
    const panel=$('libraryDetailStatus'), spinner=node('span','detail-spinner'), text=node('span','',`正在解析播放地址… ${episode?.name || ''}`), cancel=node('button','btn','取消');
    panel.classList.add('is-resolving'); panel.replaceChildren(spinner,text,cancel); cancel.type='button';
    cancel.addEventListener('click',()=>{if(current()){cancelEpisodeRequest();panel.classList.remove('is-resolving');panel.textContent='已取消解析，可重新选择剧集。';}});
    attempt.timer=setInterval(()=>{if(current())text.textContent=`正在解析播放地址… ${episode?.name || ''} · 已等待 ${Math.floor((Date.now()-attempt.started)/1000)} 秒`;},1000);
    attempt.timeout=setTimeout(()=>{attempt.timedOut=true;attempt.controller.abort();},45000);
    try {
      const result = await api('/play', { ...selection, parserKey: $('libraryParser').value,saveToDrive }, attempt.controller.signal);
      if(!current())return;
      state.playback = result.playback; state.episodeRequest=null; panel.classList.remove('is-resolving'); $('libraryDetail').close(); panel.textContent = ''; updateControls(); refreshCollection().catch(() => {});
    }
    catch (error) {
      if(!current())return;
      panel.classList.remove('is-resolving');panel.textContent=attempt.timedOut?'解析等待超时，请重试或更换线路。':error.message;
      if(error.requiresSave){
        const file=error.saveFile||{},size=file.size>0?'（约 '+(file.size/1024**3).toFixed(1)+' GiB）':'';
        const temporary=file.cleanupMode&&file.cleanupMode!=='off',rule=({both:'播完／换集后或空间不足时自动清理',space:'空间不足时自动清理',playback:'播完／换集后自动清理'})[file.cleanupMode]||'文件保留在你的网盘中';
        panel.append(node('span','field-hint','仅转存这一集到'+(temporary?'MobileTV 临时播放目录':'夸克网盘根目录')+'：'+(file.name||episode.name)+size+'。'+rule+'。'));
        const save=node('button','btn btn-primary','保存这一集并播放');save.type='button';save.addEventListener('click',()=>{if(selected())playEpisode(index,save,true);});panel.append(save);
      }
      if(error.verifyUrl)verificationButton(panel,error.verifyUrl,error.requiresSave?'打开官方分享页':'打开登录 / 验证页面');
      if(error.capacityLimited){const clean=node('button','btn','清理转存并重试');clean.type='button';clean.addEventListener('click',async()=>{clean.disabled=true;try{const result=await api('/quark/cleanup',{});if(!selected())return;if(result.removed>0){toast(`已清理 ${result.removed} 集，正在重试`);playEpisode(index,clean,saveToDrive);}else toast(result.message||'没有可清理的转存剧集；正在播放的文件会保留。');}catch(e){toast(e.message);}finally{clean.disabled=false;}});panel.append(clean);}
      if(!error.requiresSave){const retry=node('button','btn',detail.schedule?'重试线路':'重试本集');retry.type='button';retry.addEventListener('click',()=>{if(selected())playEpisode(index,retry,saveToDrive);});panel.append(retry);}
      if(detail.schedule){const refresh=node('button','btn','刷新赛事线路');refresh.type='button';refresh.addEventListener('click',()=>{if(selected())showDetail(detail.id,true,detail.title);});panel.append(refresh);}
    }
    finally { clearInterval(attempt.timer);clearTimeout(attempt.timeout);if(state.episodeRequest===attempt)state.episodeRequest=null;if(state.episodeRequest?.button!==button)button.disabled=false; }
  }
  function cancelEpisodeRequest() {
    const pending=state.episodeRequest;if(!pending)return;state.episodeRequest=null;
    clearInterval(pending.timer);clearTimeout(pending.timeout);pending.controller.abort();pending.button.disabled=false;
  }

  async function loadChannels(refresh = false) {
    if (!state.liveSource) return;
    const request = begin(); status('正在读取直播频道…'); $('libraryChannelList').replaceChildren(node('p', 'library-empty', '正在加载频道…'));
    try {
      const data = await api('/channels?' + new URLSearchParams({ source: state.liveSource, refresh: refresh ? '1' : '0' }), undefined, request.signal); if (request.id !== state.request) return;
      state.channels = data.channels; state.channelLimit = 300; const groups = [...new Set(data.channels.map(channel => channel.group))]; $('libraryLiveGroup').replaceChildren(option('', '全部分组'), ...groups.map(group => option(group, group))); $('libraryDrawerGroup').replaceChildren(option('', '全部分组'), ...groups.map(group => option(group, group))); state.drawerSource = state.liveSource; renderChannels(); renderDrawer(); status(`已载入 ${data.channels.length} 个频道`);
    } catch (error) { if(request.id === state.request){state.channels = []; renderChannels(); report(error);} }
  }
  function renderChannels() {
    const focusedRow = document.activeElement?.closest?.('.live-channel-row'), focusedChannel = focusedRow?.dataset.channel, focusedFavorite = document.activeElement?.classList.contains('live-favorite');
    const group = $('libraryLiveGroup').value, keyword = $('libraryLiveSearch').value.toLowerCase().trim();
    const channels = state.channels.filter((channel, index) => (!group || group === channel.group) && (!keyword || channel.name.toLowerCase().includes(keyword) || String(index + 1) === keyword) && (!state.liveFavorites || isFavorite({ kind: 'live', sourceKey: state.liveSource, channelId: channel.id })));
    $('libraryChannelList').replaceChildren();
    $('libraryMoreChannels').hidden = channels.length <= state.channelLimit;
    if (!channels.length) { $('libraryChannelList').append(node('p', 'library-empty', state.channels.length ? '没有找到匹配频道' : '添加订阅地址并选择直播源')); return; }
    for (const channel of channels.slice(0, state.channelLimit)) {
      const row = node('article', 'live-channel-row'), button = node('button', 'live-channel'), info = node('div'), number = node('span', 'live-channel-number', String(state.channels.indexOf(channel) + 1).padStart(2, '0'));
      row.dataset.channel = channel.id;
      button.type = 'button'; info.append(node('strong', '', channel.name), node('span', '', `${channel.group}${channel.lines > 1 ? ` · ${channel.lines} 条线路` : ''}`)); button.append(number, info);
      button.classList.toggle('active', currentPlayback()?.channelId === channel.id);
      const selection = { kind: 'live', sourceKey: state.liveSource, channelId: channel.id }, saved = isFavorite(selection), favorite = node('button', 'live-favorite', saved ? '★' : '☆'); favorite.type = 'button'; favorite.setAttribute('aria-label', '收藏频道：' + channel.name); favorite.setAttribute('aria-pressed', String(saved));
      favorite.addEventListener('click', () => toggleFavorite(selection, favorite));
      button.addEventListener('click', () => playChannel(channel.id, 0, button)); row.append(button, favorite); $('libraryChannelList').append(row);
    }
    $('libraryMoreChannels').hidden = channels.length <= state.channelLimit;
    $('libraryMoreChannels').textContent = `再显示更多频道（${Math.min(state.channelLimit, channels.length)} / ${channels.length}）`;
    if (focusedChannel) [...$('libraryChannelList').children].find(row => row.dataset.channel === focusedChannel)?.querySelector(focusedFavorite ? '.live-favorite' : '.live-channel')?.focus({ preventScroll: true });
  }
  async function playChannel(channelId, line = 0, button) {
    clearTimeout(state.digitTimer); state.channelDigits = '';
    if (button) button.disabled = true; status('正在连接频道…');
    try { const result = await api('/live/play', { sourceKey: state.liveSource, channelId, line }); state.playback = result.playback; updateControls(); showChannelOsd(); renderDrawer(); refreshCollection().catch(() => {}); }
    catch (error) { report(error); toast(error.message); }
    finally { if (button) button.disabled = false; }
  }

  function showChannelOsd(text) {
    const current = currentPlayback(); if (!current || current.kind !== 'live') return;
    const index = current.channels.findIndex(channel => channel.id === current.channelId);
    $('libraryChannelOsd').textContent = text || `${String(index + 1).padStart(2, '0')}  ${current.title}`; $('libraryChannelOsd').hidden = false;
    clearTimeout(state.osdTimer); state.osdTimer = setTimeout(() => { $('libraryChannelOsd').hidden = true; }, 2800);
  }
  function renderDrawer() {
    const current = currentPlayback(); if (current?.kind !== 'live') return;
    const channels = state.drawerSource === current.sourceKey ? state.channels : current.channels;
    const groups = [...new Set(channels.map(channel => channel.group).filter(Boolean))], signature = JSON.stringify([current.sourceId, current.sourceKey, groups]);
    if ($('libraryDrawerGroup').dataset.groups !== signature) { const previous = $('libraryDrawerGroup').value; $('libraryDrawerGroup').replaceChildren(option('', '全部分组'), ...groups.map(group => option(group, group))); if (groups.includes(previous)) $('libraryDrawerGroup').value = previous; $('libraryDrawerGroup').dataset.groups = signature; }
    const query = $('libraryDrawerSearch').value.toLowerCase().trim(), group = $('libraryDrawerGroup').value, focusedChannel = document.activeElement?.closest?.('.live-drawer-channel')?.dataset.channel;
    const list = $('libraryDrawerList'); list.replaceChildren();
    for (const [index, channel] of channels.entries()) {
      if (group && group !== channel.group || query && !channel.name.toLowerCase().includes(query) && String(index + 1) !== query) continue;
      const button = node('button', 'live-drawer-channel' + (channel.id === current.channelId ? ' active' : ''), `${String(index + 1).padStart(2, '0')}  ${channel.name}`); button.type = 'button'; button.dataset.channel = channel.id; button.setAttribute('aria-current', channel.id === current.channelId ? 'true' : 'false');
      button.addEventListener('click', () => { state.liveSource = current.sourceKey; playChannel(channel.id, 0, button); }); list.append(button);
      if (list.childElementCount >= 300) break;
    }
    if (!list.childElementCount) list.append(node('p', 'field-hint', '没有匹配的频道'));
    if (focusedChannel && !$('libraryChannelDrawer').hidden) [...list.children].find(button => button.dataset.channel === focusedChannel)?.focus({ preventScroll: true });
  }
  function toggleChannels(open = $('libraryChannelDrawer').hidden) {
    $('libraryChannelDrawer').hidden = !open;
    if (open) { renderDrawer(); ($('libraryDrawerList').querySelector('.active') || $('libraryDrawerSearch')).focus(); }
    else $('playerStage').focus({ preventScroll: true });
  }

  function currentPlayback() { const current = window.MobileTVPlayerState?.(); return current && state.playback?.sessionId === current.sessionId && ['Library', 'Live'].includes(current.protocol) && !['IDLE', 'STOPPED'].includes(current.status) ? state.playback : null; }
  window.MobileTVLibraryPlayback=currentPlayback;
  window.MobileTVLibrarySkipNext=async()=>{const current=currentPlayback();return current?.kind==='vod'&&current.index<current.episodes.length-1&&$('libraryAutoNext').checked&&!window.MobileTVPlayerState?.()?.metadata?.isLive?next(1,true):false;};
  function updateControls() {
    window.MobileTVSkips?.setState(window.MobileTVPlayerState?.());
    const playback = currentPlayback(); $('libraryPlayerTools').hidden = !playback;
    if (!playback) { $('libraryChannelDrawer').hidden = true; $('libraryChannelOsd').hidden = true; return; }
    const vod = playback.kind === 'vod';
    $('libraryPlayerTitle').textContent = vod ? `${playback.index + 1} / ${playback.episodes.length} 集` : playback.title;
    const liveEvent=vod&&Boolean(window.MobileTVPlayerState?.()?.metadata?.isLive),multiple=vod&&!liveEvent&&playback.episodes.length>1;
    for(const [id,name,key]of [['libraryPlayerPrevious',vod?'上一集':'上一台','P'],['libraryPlayerNext',vod?'下一集':'下一台','N']]){const button=$(id);button.hidden=vod&&!multiple;button.setAttribute('aria-label',name);button.title=`${name} (${key})`;}
    $('libraryPlayerPrevious').disabled = vod && playback.index === 0; $('libraryPlayerNext').disabled = vod && playback.index >= playback.episodes.length - 1;
    $('libraryChooseEpisode').hidden = !vod; $('libraryChooseEpisode').textContent=liveEvent?`线路 ${playback.index+1} / ${playback.episodes.length}`:multiple?`选集 ${playback.index+1} / ${playback.episodes.length}`:'播放线路'; $('libraryAutoNextLabel').hidden = !multiple;
    $('libraryChannelToggle').hidden = vod; updateFavoriteButtons();
    if (vod) $('libraryChannelDrawer').hidden = true;
    $('libraryQualityLabel').hidden = !vod || !playback.qualities || playback.qualities.length <= 1;
    if(vod&&playback.qualities?.length){const signature=JSON.stringify(playback.qualities);if($('libraryQuality').dataset.choices!==signature){$('libraryQuality').replaceChildren(...playback.qualities.map((name,index)=>option(index,name)));$('libraryQuality').dataset.choices=signature;}$('libraryQuality').value=String(playback.quality||0);}
    const channel = !vod && playback.channels?.find(value => value.id === playback.channelId);
    $('librarySwitchLine').hidden = vod || !channel || channel.lines <= 1;
    if (channel?.lines > 1) $('librarySwitchLine').textContent = `换线 ${playback.channelLine + 1}/${channel.lines}`;
  }
  async function next(direction, automatic = false) {
    clearTimeout(state.digitTimer); state.channelDigits = '';
    const playback = currentPlayback(); if (!playback) return;
    try { const result = await api('/next', { direction, sessionId: playback.sessionId }); state.playback = result.playback; updateControls(); showChannelOsd(); renderDrawer(); refreshCollection().catch(() => {});return true; }
    catch (error) { if (!automatic || !/边界/.test(error.message)) toast(error.message);return false; }
  }

  for (const button of document.querySelectorAll('[data-library-nav]')) button.addEventListener('click', () => setMode(button.dataset.libraryNav));
  for (const button of document.querySelectorAll('[data-library-shelf]')) button.addEventListener('click', () => { begin(); state.shelf = button.dataset.libraryShelf; renderShelf(); if (state.shelf !== 'browse') refreshCollection().catch(report); else if (state.mode === 'live') loadChannels(); else loadHome(); });
  $('librarySavedSource').addEventListener('change', () => switchSource($('librarySavedSource').value));
  $('libraryManageSources').addEventListener('click', () => { $('librarySourceStatus').textContent = ''; $('librarySourcesDialog').showModal(); });
  $('libraryCloseSources').addEventListener('click', () => $('librarySourcesDialog').close());
  $('libraryVerify').addEventListener('click', async () => { try { await api('/browser/open', { siteKey: state.site, verifyUrl: state.verifyUrl }); toast('完成验证或登录后，点击“重试”。'); } catch (error) { toast(error.message); } });
  $('libraryVerifyRetry').addEventListener('click', () => state.mode === 'live' ? loadChannels(true) : loadHome());
  $('libraryClearHistory').addEventListener('click', async () => { try { state.collection = await api('/collection/remove', { kind: 'history', clear: true }); renderCollectionCounts(); renderCollection(); } catch (error) { toast(error.message); } });
  $('libraryDetailFavorite').addEventListener('click', event => toggleFavorite({ kind: 'vod', siteKey: state.site, vodId: state.detail?.id }, event.currentTarget));
  $('libraryPlayerFavorite').addEventListener('click', event => toggleFavorite(currentPlayback(), event.currentTarget));
  $('libraryLiveFavorites').addEventListener('click', () => { state.liveFavorites = !state.liveFavorites; $('libraryLiveFavorites').setAttribute('aria-pressed', String(state.liveFavorites)); renderChannels(); });
  $('libraryLiveResume').addEventListener('click', event => { const last = state.collection.history.find(item => item.kind === 'live'); if (last) resumeItem(last.id, false, event.currentTarget); });
  $('libraryChannelToggle').addEventListener('click', () => toggleChannels()); $('libraryCloseChannels').addEventListener('click', () => toggleChannels(false));
  $('libraryDrawerSearch').addEventListener('input', renderDrawer); $('libraryDrawerGroup').addEventListener('change', renderDrawer);
  $('libraryChannelDrawer').addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); toggleChannels(false); return; }
    if (event.key === 'Enter' && event.target.closest('.live-drawer-channel')) { event.preventDefault(); if (!event.repeat) event.target.closest('.live-drawer-channel').click(); return; }
    if (!['ArrowUp', 'ArrowDown'].includes(event.key) || /INPUT|SELECT/.test(event.target.tagName)) return;
    const buttons = [...$('libraryDrawerList').querySelectorAll('button')], index = buttons.indexOf(document.activeElement); event.preventDefault(); buttons[(index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length]?.focus();
  });
  document.addEventListener('pointerdown', event => { if (!$('libraryChannelDrawer').hidden && !event.target.closest('#libraryChannelDrawer, #libraryChannelToggle')) toggleChannels(false); });
  $('librarySourceForm').addEventListener('submit', event => { event.preventDefault(); importSource($('librarySourceUrl').value); });
  $('libraryRetry').addEventListener('click', () => state.mode === 'live' ? loadChannels(true) : loadHome());
  $('librarySiteBrowser').addEventListener('click', async () => { if (!state.site) return; try { await api('/browser/open', { siteKey: state.site, verifyUrl:state.verifyUrl||'' }); status('已打开独立站点浏览器，完成验证或登录后点击“重试”。'); } catch(error) { report(error); } });
  $('librarySiteSettings').addEventListener('click', async () => {
    if (!state.site) return;
    try { const value = await api('/site/settings?site=' + encodeURIComponent(state.site)); $('librarySettingsTitle').textContent = value.name; $('libraryEndpoint').value = /^https?:/.test(value.endpoint) ? value.endpoint : ''; $('libraryCookie').value = ''; $('libraryRemoveCookie').checked = false; $('libraryAccountStatus').textContent = value.hasCookie ? '已保存账号，留空不会覆盖。站点浏览器使用独立的本机登录状态。' : '尚未手动保存账号。可粘贴自己的 Cookie，或使用站点浏览器完成登录。'; $('librarySettingsStatus').textContent = ''; $('librarySettingsDialog').showModal(); } catch(error) { report(error); }
  });
  $('libraryCloseSettings').addEventListener('click', () => $('librarySettingsDialog').close());
  let accounts = [];
  async function renderCleanup() {
    $('libraryQuarkCleanup').hidden=$('libraryAccountProvider').value!=='quark';
    if($('libraryQuarkCleanup').hidden)return;
    try{const data=await api('/quark/cleanup');$('libraryCleanupMode').value=data.mode;$('libraryCleanupStatus').textContent=data.last?`最近清理 ${data.last.removed} 集 · ${(data.last.bytes/1024**3).toFixed(2)} GiB`:`已记录 ${data.tracked} 集转存；当前播放不会被清理。`;}catch(e){$('libraryCleanupStatus').textContent=e.message;}
  }
  $('libraryCleanupMode').addEventListener('change',async event=>{event.target.disabled=true;try{await api('/quark/cleanup/settings',{mode:event.target.value});toast('自动清理设置已保存');}catch(e){toast(e.message);}finally{event.target.disabled=false;renderCleanup();}});
  $('libraryCleanupNow').addEventListener('click',async event=>{const button=event.currentTarget;button.disabled=true;$('libraryCleanupStatus').textContent='正在核对文件归属并清理…';try{const data=await api('/quark/cleanup',{});$('libraryCleanupStatus').textContent=data.message||`已清理 ${data.removed} 集 · ${(data.bytes/1024**3).toFixed(2)} GiB，文件已进入夸克回收站。`;}catch(e){$('libraryCleanupStatus').textContent=e.message;}finally{button.disabled=false;}});
  function renderAccount() {
    const provider = $('libraryAccountProvider').value, account = accounts.find(a => a.provider === provider);
    $('libraryAliTokens').hidden = provider !== 'ali'; $('libraryAccountCookie').value = ''; $('libraryAccessToken').value = ''; $('libraryRefreshToken').value = ''; $('libraryClearAccount').checked = false;
    $('libraryAccountSummary').textContent = !account?.configured ? '尚未保存账号，可在官方页面登录后保存浏览器登录状态。' : account.status==='verified' ? '上次会话检查通过：'+new Date(account.checkedAt).toLocaleString() : account.status==='expired' ? '登录已失效，请重新登录并同步。' : account.status==='unavailable' ? '账号资料已保存，最近一次检查未完成，请检查网络后重试。' : '账号资料已保存，尚未验证登录；留空不会覆盖已有配置。';
    $('libraryAccountMessage').textContent = '';
    renderCleanup();
  }
  $('libraryAccounts').addEventListener('click', async () => { try { accounts = (await api('/accounts')).accounts; renderAccount(); $('libraryAccountsDialog').showModal(); } catch(error) { report(error); } });
  document.addEventListener('mobiletv-accounts',async event=>{try{accounts=(await api('/accounts')).accounts;if(event.detail?.provider)$('libraryAccountProvider').value=event.detail.provider;renderAccount();if(!$('libraryAccountsDialog').open)$('libraryAccountsDialog').showModal();}catch(error){toast(error.message);}});
  $('libraryCloseAccounts').addEventListener('click', () => $('libraryAccountsDialog').close());
  $('libraryAccountProvider').addEventListener('change', renderAccount);
  $('libraryAccountLogin').addEventListener('click', async () => { try { await api('/accounts/login', {provider:$('libraryAccountProvider').value}); $('libraryAccountMessage').textContent = '在已打开的官方页面完成登录，再点击“保存浏览器登录状态”。'; } catch(error) { $('libraryAccountMessage').textContent = error.message; } });
  async function accountAction(route,message,button){const provider=$('libraryAccountProvider').value;button.disabled=true;try{accounts=(await api('/accounts/'+route,{provider})).accounts;if($('libraryAccountProvider').value===provider){renderAccount();$('libraryAccountMessage').textContent=message;}}catch(error){try{accounts=(await api('/accounts')).accounts;}catch{}if($('libraryAccountProvider').value===provider){renderAccount();$('libraryAccountMessage').textContent=error.message;}}finally{button.disabled=false;}}
  $('libraryAccountSync').addEventListener('click',event=>accountAction('sync','浏览器登录状态已验证并保存。',event.currentTarget));
  $('libraryAccountCheck').addEventListener('click',event=>accountAction('check','登录检查通过。',event.currentTarget));
  $('libraryAccountLogout').addEventListener('click',event=>accountAction('logout','当前账号已退出，保存的凭据及独立浏览器会话已清除。',event.currentTarget));
  $('libraryAccountForm').addEventListener('submit', async event => {
    event.preventDefault(); const body = {provider:$('libraryAccountProvider').value};
    if ($('libraryClearAccount').checked) Object.assign(body,{cookie:'',accessToken:'',refreshToken:''});
    else { if($('libraryAccountCookie').value.trim())body.cookie=$('libraryAccountCookie').value.trim(); if($('libraryAccessToken').value.trim())body.accessToken=$('libraryAccessToken').value.trim(); if($('libraryRefreshToken').value.trim())body.refreshToken=$('libraryRefreshToken').value.trim(); }
    try { accounts = (await api('/accounts',body)).accounts; renderAccount(); $('libraryAccountMessage').textContent = '账号已保存到本机。'; } catch(error) { $('libraryAccountMessage').textContent = error.message; }
  });
  $('librarySettingsForm').addEventListener('submit', async event => {
    event.preventDefault(); const body = { siteKey: state.site, endpoint: $('libraryEndpoint').value.trim() }; if ($('libraryRemoveCookie').checked) body.cookie = ''; else if ($('libraryCookie').value.trim()) body.cookie = $('libraryCookie').value.trim();
    try { await api('/site/settings', body); $('librarySettingsDialog').close(); status('设置已保存'); loadHome(); } catch(error) { $('librarySettingsStatus').textContent = error.message; }
  });
  function submitSearch() {
    if(!state.site)return;state.keyword=$('librarySearch').value.trim();state.category='';state.filters={};renderFilters();syncSearchUi();
    if(!state.keyword){loadHome();return;}
    if($('librarySearchAll').checked)searchSources(state.keyword);else loadList(1);
  }
  $('librarySite').addEventListener('change', () => { const searching=Boolean(state.keyword);state.site = $('librarySite').value;state.verifyUrl='';$('librarySearchAll').checked=Boolean(state.config?.sites.find(item=>item.key===state.site)?.discovery);syncSearchUi();if(searching)submitSearch();else loadHome(); });
  $('librarySearchForm').addEventListener('submit', event => { event.preventDefault();submitSearch(); });
  $('librarySearchAll').addEventListener('change',()=>{syncSearchUi();if(state.keyword)submitSearch();});
  $('libraryResetSearch').addEventListener('click',()=>{$('librarySearch').value='';loadHome();});
  $('librarySearch').addEventListener('search',()=>{if(!$('librarySearch').value.trim()&&state.keyword)loadHome();});
  $('libraryCancelSearch').addEventListener('click', () => { state.fetching?.abort(); state.request++; $('libraryCancelSearch').hidden = true; const count=$('libraryResults').querySelectorAll('.vod-card').length;if(!count)placeholder('搜索已停止，可修改关键词后重试。');status(`已停止搜索 · ${count} 个结果`); });
  $('libraryPrevious').addEventListener('click', () => loadList(state.page - 1)); $('libraryMore').addEventListener('click', () => loadList(state.page + 1));
  $('libraryMatchDate').addEventListener('change', () => { if (state.events) renderEvents(state.events); }); $('libraryMatchStatus').addEventListener('change', () => { if (state.events) renderEvents(state.events); });
  $('libraryCloseDetail').addEventListener('click', () => $('libraryDetail').close()); $('libraryLines').addEventListener('change', () => { state.line = Number($('libraryLines').value); renderEpisodes(); });
  $('libraryDetail').addEventListener('close',()=>{if(!$('libraryDetail').open){cancelEpisodeRequest();$('libraryDetailStatus').classList.remove('is-resolving');if(state.detailRequest!=null){if(state.detailRequest===state.request){state.fetching?.abort();state.request++;status('已取消读取选集');}state.detailRequest=null;detailLoading(false);}}});
  $('libraryDetailPicture').addEventListener('error', () => { $('libraryDetailPicture').hidden = true; });
  $('libraryLiveSource').addEventListener('change', () => { state.liveSource = $('libraryLiveSource').value; loadChannels(); }); $('libraryLiveRefresh').addEventListener('click', () => loadChannels(true));
  $('libraryLiveGroup').addEventListener('change', () => { state.channelLimit = 300; renderChannels(); }); $('libraryLiveSearch').addEventListener('input', () => { state.channelLimit = 300; renderChannels(); });
  $('libraryMoreChannels').addEventListener('click', () => { state.channelLimit += 300; renderChannels(); });
  $('libraryPlayerPrevious').addEventListener('click', () => next(-1)); $('libraryPlayerNext').addEventListener('click', () => next(1));
  $('libraryQuality').addEventListener('change',async event=>{const current=currentPlayback();if(!current||current.kind!=='vod')return;event.target.disabled=true;try{const result=await api('/play',{...current,quality:Number(event.target.value),resumePosition:window.MobileTVPlayerState()?.position||0,sessionId:current.sessionId});state.playback=result.playback;updateControls();}catch(error){toast(error.message);updateControls();}finally{event.target.disabled=false;}});
  $('libraryChooseEpisode').addEventListener('click', () => { const current = currentPlayback(); if (!current || current.kind !== 'vod') return; state.site = current.siteKey; showDetail(current.vodId,false,current.title); });
  $('librarySwitchLine').addEventListener('click', () => { const current = currentPlayback(); if (!current || current.kind !== 'live') return; const channel = current.channels.find(value => value.id === current.channelId); state.liveSource = current.sourceKey; playChannel(current.channelId, (current.channelLine + 1) % channel.lines); });
  try { $('libraryAutoNext').checked = localStorage.getItem('mobiletv-auto-next') !== 'off'; } catch {}
  $('libraryAutoNext').addEventListener('change', () => { try { localStorage.setItem('mobiletv-auto-next', $('libraryAutoNext').checked ? 'on' : 'off'); } catch {} });
  $('tvVideo').addEventListener('ended', () => { const current = currentPlayback(); if (current?.kind === 'vod' && !window.MobileTVPlayerState?.()?.metadata?.isLive && current.episodes.length>1 && $('libraryAutoNext').checked) next(1, true); });
  setInterval(updateControls, 800);
  document.addEventListener('keydown', event => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing || event.repeat || /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '') || event.target?.isContentEditable || document.querySelector('dialog[open]') || $('logDrawer')?.classList.contains('open')) return;
    const current = currentPlayback();
    if (current?.kind === 'live') {
      if (event.key.toLowerCase() === 'c') { event.preventDefault(); toggleChannels(); return; }
      if (['PageUp', 'PageDown'].includes(event.key)) { event.preventDefault(); next(event.key === 'PageUp' ? -1 : 1); return; }
      if (/^\d$/.test(event.key)) {
        event.preventDefault(); state.digitSession = current.sessionId; state.channelDigits = ((state.channelDigits || '') + event.key).slice(-4); showChannelOsd('选台 ' + state.channelDigits + ' · Enter 确认');
        clearTimeout(state.digitTimer); state.digitTimer = setTimeout(tuneNumber, 1400); return;
      }
      if (event.key === 'Enter' && state.channelDigits) { event.preventDefault(); clearTimeout(state.digitTimer); tuneNumber(); return; }
    }
    if (current && ['n', 'p'].includes(event.key.toLowerCase())) { event.preventDefault(); next(event.key.toLowerCase() === 'n' ? 1 : -1); }
  });
  function tuneNumber() { const current = currentPlayback(), digits = Number(state.channelDigits); state.channelDigits = ''; if (current?.kind !== 'live' || current.sessionId !== state.digitSession) return; const channel = current.channels[digits - 1]; if (channel) { state.liveSource = current.sourceKey; playChannel(channel.id); } else showChannelOsd('没有这个频道'); }
  (async () => {
    try { renderConfig(await api('/config')); await refreshCollection(); state.playback = (await api('/playback')).playback; let mode = 'cast'; try { mode = localStorage.getItem('mobiletv-section') || 'cast'; } catch {} setMode(['cast', 'vod', 'live'].includes(mode) ? mode : 'cast'); updateControls(); }
    catch (error) { status(error.message, true); }
  })();
})();
