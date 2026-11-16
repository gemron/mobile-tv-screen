(() => {
  'use strict';
  const $ = id => document.getElementById(id), video = $('tvVideo'), dialog = $('subtitleDialog');
  if (!video || !dialog) return;
  let state = null, identity = '', base = 0, delay = 0, cues = [], selectedName = '', track = null, enabled = false, pending = null, sequence = 0, nextPosition = 0, lastKeyword = '';
  const text = (tag, value, className = '') => { const item = document.createElement(tag); item.textContent = value; item.className = className; return item; };
  const message = (value, error = false) => { $('subtitleStatus').textContent = value; $('subtitleStatus').classList.toggle('error', error); };
  const active = () => state?.url && !['IDLE','STOPPED'].includes(state.status);
  function cancel() { sequence++; pending?.abort(); pending = null; dialog.setAttribute('aria-busy','false'); $('subtitleCancel').hidden = true; }
  async function api(route, body, signal) {
    const form = body instanceof FormData;
    const response = await fetch('/api/subtitles/' + route, { ...(body === undefined ? {} : { method: 'POST', ...(form ? {} : { headers: {'Content-Type':'application/json'} }), body: form ? body : JSON.stringify(body) }), signal });
    const result = await response.json(); signal?.throwIfAborted();
    if (!response.ok) throw new Error(result.error || '字幕读取失败，请重试'); return result;
  }
  async function run(task, hint) {
    cancel(); const id = sequence, session = state?.sessionId, controller = pending = new AbortController();
    const deadline = setTimeout(()=>controller.abort(new DOMException('字幕请求超时，请重试','TimeoutError')),25000);
    dialog.setAttribute('aria-busy','true'); $('subtitleCancel').hidden = false; message(hint);
    try { const result = await task(controller.signal); if (id !== sequence || session !== state?.sessionId) return; return result; }
    catch (error) { if (id === sequence && error.name !== 'AbortError') message(error.message, true); }
    finally { clearTimeout(deadline); if (id === sequence) { pending = null; dialog.setAttribute('aria-busy','false'); $('subtitleCancel').hidden = true; } }
  }
  const scope = body => ({ ...body, sessionId: state?.sessionId });
  function renderTrack() {
    if (!track && cues.length) track = video.addTextTrack('subtitles', 'MobileTV 外挂字幕', '');
    if (!track) return;
    track.mode = 'hidden'; while (track.cues?.length) track.removeCue(track.cues[0]);
    if (enabled) for (const cue of cues) {
      const start = cue.start + delay - base, end = cue.end + delay - base; if (end <= 0) continue;
      const content = String(cue.text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
      const item=new VTTCue(Math.max(0,start), end, content);item.snapToLines=false;item.line=84;item.position=50;item.size=90;track.addCue(item);
    }
    track.mode = enabled ? 'showing' : 'disabled';
  }
  function disable(notify = true) { if(notify)window.MobileTVTracks?.off();enabled = false; for (const item of video.textTracks) item.mode = 'disabled'; renderTrack(); $('subtitleCurrent').textContent = '字幕已关闭'; $('subtitleOff').textContent=cues.length?'启用字幕':'关闭字幕';$('subtitleOff').disabled=!cues.length; $('btnSubtitles').setAttribute('aria-pressed','false'); }
  function apply(result, embedded = false, close = true) {
    if (result.files) { files(result.files, $('subtitleResults')); message('请选择具体字幕文件'); return; }
    if (!Array.isArray(result.cues) || !embedded && !result.cues.length) { message('该文件没有可显示的字幕',true); return; }
    if(!embedded)window.MobileTVTracks?.off();
    cues = result.cues; selectedName = result.name || '外挂字幕'; enabled = true;
    for (const item of video.textTracks) item.mode = 'disabled'; renderTrack();
    $('subtitleCurrent').textContent = selectedName; $('btnSubtitles').setAttribute('aria-pressed','true');
    $('subtitleOff').textContent='关闭字幕';$('subtitleOff').disabled=false;
    if(close){dialog.close(); window.MobileTVUI?.toast('已加载字幕：' + selectedName);}
  }
  async function load(id) { const result = await run(signal => api('load',scope({id}),signal),'正在读取字幕…'); if (result) apply(result); }
  function files(items, target) {
    target.replaceChildren(); if (!items.length) { if(target.id!=='subtitleSources')target.append(text('p','没有可用字幕，可搜索或加载本地文件。','field-hint')); return; }
    for (const item of items) {
      const button = text('button','', 'subtitle-result'); button.type = 'button';
      button.append(text('strong',item.name),text('span',item.lang || '文本字幕'));
      button.addEventListener('click',()=>load(item.id)); target.append(button);
    }
  }
  function config(value) {
    $('subtitleProvider').textContent=value.provider||'免费字幕';
    $('subtitleTokenStatus').textContent = value.tokenSource === 'subscription' ? '使用当前订阅提供的 Token；不可用时尝试免费字幕' : value.configured ? '已保存本机 Token；不可用时尝试免费字幕' : '当前订阅未提供 Token，默认使用迅雷免费字幕，无需配置';
    $('subtitleToken').placeholder = value.configured ? '已配置；需要替换时输入新 Token' : '输入自己的 32 位 Assrt Token';
  }
  async function open() {
    if (!active() || state.mediaType !== 'video') return;
    $('subtitleCurrent').textContent = enabled ? selectedName : '字幕已关闭'; $('subtitleDelay').value = String(delay);$('subtitleOff').disabled=!enabled&&!cues.length;
    $('subtitleKeyword').value = (state.metadata?.title || '').replace(/\.(mkv|mp4|avi|webm)\b/gi,'').replace(/ · /g,' ').slice(0,160);
    $('subtitleResults').replaceChildren(); $('subtitleMore').hidden = true; dialog.showModal();
    window.MobileTVTracks?.read();
    const result = await run(signal => api('list?sessionId='+state.sessionId,undefined,signal),'正在读取可用字幕…');
    if (result) { files(result.files,$('subtitleSources')); config(result); message('选择字幕，或按片名搜索。'); }
  }
  async function search(more = false) {
    const keyword = $('subtitleKeyword').value.trim(); if (!keyword) { $('subtitleKeyword').focus(); return; }
    if (!more || keyword !== lastKeyword) { nextPosition = 0; $('subtitleResults').replaceChildren(); } lastKeyword = keyword;
    const result = await run(signal => api('search',scope({keyword,position:nextPosition}),signal),'正在搜索字幕…'); if (!result) return;
    if (!more) $('subtitleResults').replaceChildren(); nextPosition = result.nextPosition; $('subtitleMore').hidden = !result.hasMore;
    for (const item of result.items) {
      const button = text('button','','subtitle-result'); button.type='button'; button.append(text('strong',item.name),text('span',[item.lang,item.format].filter(Boolean).join(' · ')));
      button.addEventListener('click',async()=>{ const detail = await run(signal=>api('detail',scope({id:item.id}),signal),'正在读取字幕文件列表…'); if (detail) { files(detail.files,$('subtitleResults')); $('subtitleMore').hidden=true; message('请选择字幕文件'); } }); $('subtitleResults').append(button);
    }
    $('subtitleProvider').textContent=result.provider||'Assrt';
    message(result.notice || (result.items.length ? '选择结果查看字幕文件' : '没有找到匹配字幕，试试其他片名或剧集编号'));
  }
  $('btnSubtitles').addEventListener('click',open); $('subtitleClose').addEventListener('click',()=>dialog.close()); dialog.addEventListener('close',cancel);
  $('subtitleCancel').addEventListener('click',()=>{cancel();message('已取消，可重新选择字幕或搜索。');});
  $('subtitleOff').addEventListener('click',()=>{if(enabled)disable();else if(cues.length){enabled=true;renderTrack();$('subtitleCurrent').textContent=selectedName;$('subtitleOff').textContent='关闭字幕';$('btnSubtitles').setAttribute('aria-pressed','true');}});
  $('subtitleSearch').addEventListener('submit',event=>{event.preventDefault();search();}); $('subtitleMore').addEventListener('click',()=>search(true));
  $('subtitleDelay').addEventListener('change',()=>{delay=Math.max(-300,Math.min(300,Number($('subtitleDelay').value)||0));$('subtitleDelay').value=String(delay);renderTrack();});
  $('subtitleSize').addEventListener('input',()=>{const size=Number($('subtitleSize').value);video.style.setProperty('--subtitle-size',size+'px');try{localStorage.setItem('mobiletv-subtitle-size',String(size));}catch{}});
  try { const size = Number(localStorage.getItem('mobiletv-subtitle-size')); if (size>=14 && size<=64) { $('subtitleSize').value=String(size);video.style.setProperty('--subtitle-size',size+'px'); } } catch {}
  $('subtitleFile').addEventListener('change',async()=>{const file=$('subtitleFile').files[0];if(!file)return;const form=new FormData();form.set('file',file);form.set('sessionId',String(state.sessionId));const result=await run(signal=>api('upload',form,signal),'正在载入字幕文件…');$('subtitleFile').value='';if(result)apply(result);});
  $('subtitleUrlForm').addEventListener('submit',async event=>{event.preventDefault();const url=$('subtitleUrl').value.trim();if(!url)return;const result=await run(signal=>api('url',scope({url}),signal),'正在读取字幕链接…');if(result)apply(result);});
  $('subtitleTokenForm').addEventListener('submit',async event=>{event.preventDefault();const token=$('subtitleToken').value.trim();if(!token)return;const result=await run(signal=>api('config',{token},signal),'正在保存字幕搜索设置…');if(result){config(result);$('subtitleToken').value='';message('搜索设置已保存，可按片名搜索。');}});
  $('subtitleResetToken').addEventListener('click',async()=>{const result=await run(signal=>api('config',{token:''},signal),'正在恢复默认搜索…');if(result){config(result);$('subtitleToken').value='';message(result.configured?'已恢复使用订阅提供的 Token。':'已启用免 Token 的免费字幕搜索。');}});
  window.MobileTVSubtitles = {
    open,
    showEmbedded(result, close = true) { apply(result,true,close); },
    clearEmbedded() { cues=[];selectedName='';disable(false); },
    showEmbeddedImage(name) { cues=[];disable(false);enabled=true;selectedName=name;$('subtitleCurrent').textContent=name;$('subtitleOff').disabled=false;$('btnSubtitles').setAttribute('aria-pressed','true'); },
    setTimeline(value) { base=Math.max(0,Number(value)||0);renderTrack(); },
    setState(next) {
      const key=next?.url&&!['IDLE','STOPPED'].includes(next.status)?[next.protocol,next.metadata?.title,next.metadata?.bilibili?.cid||''].join('|'):'';
      if (next?.sessionId !== state?.sessionId || key !== identity) { cancel(); if(dialog.open)dialog.close(); }
      if (key !== identity) { cues=[];selectedName='';delay=0;base=0;disable(false);identity=key; }
      state=next;
    }
  };
})();
