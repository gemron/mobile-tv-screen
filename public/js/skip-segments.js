(() => {
  'use strict';
  const $=id=>document.getElementById(id),video=$('tvVideo'),panel=$('skipSettings'),form=$('skipForm');
  const storeKey='mobiletv-skip-settings-v1',defaults=()=>({intro:0,ending:0,enabled:true});
  let state=null,context='',session='',settings=defaults(),introDone=false,endingDone=false,automaticSeekUntil=0;
  function fingerprint(value) { let a=2166136261,b=5381;for(const c of value){a=Math.imul(a^c.charCodeAt(0),16777619);b=Math.imul(b,33)^c.charCodeAt(0);}return (a>>>0).toString(16)+(b>>>0).toString(16); }
  function readAll() { try{const data=JSON.parse(localStorage.getItem(storeKey)||'{}');return data&&typeof data==='object'&&!Array.isArray(data)?data:{};}catch{return {};} }
  function valid(value) { const n=Number(value);return Number.isInteger(n)&&n>=0&&n<=1800; }
  function load(key) { const value=readAll()[key];return value&&valid(value.intro)&&valid(value.ending)&&typeof value.enabled==='boolean'?{intro:value.intro,ending:value.ending,enabled:value.enabled}:defaults(); }
  function render() {
    $('skipIntro').value=settings.intro;$('skipEnding').value=settings.ending;$('skipEnabled').checked=settings.enabled;
    $('skipBadge').textContent=!settings.enabled?'未开启':settings.intro||settings.ending?`${settings.intro}s / ${settings.ending}s`:'未设置';
    $('skipStatus').textContent='';const current=window.MobileTVLibraryPlayback?.();$('skipContext').textContent=current?.kind==='vod'?`仅用于《${current.title}》，换集后沿用。`:'仅用于当前影片。';
  }
  function active() { return state?.url&&state.mediaType==='video'&&!state.metadata?.isLive&&!['IDLE','STOPPED'].includes(state.status); }
  function position() { return Number(window.MobileTVPlaybackPosition?.())||0; }
  function duration() { return Number(window.MobileTVPlaybackDuration?.())||0; }
  function setState(next) {
    state=next;panel.hidden=!active();if(!active()){context='';session='';return;}
    const playback=window.MobileTVLibraryPlayback?.(),identity=playback?.kind==='vod'?['library',playback.sourceId,playback.siteKey,playback.vodId]:[state.protocol,state.metadata?.title||state.url];
    const key=fingerprint(JSON.stringify(identity)),nextSession=state.sessionId+'|'+state.url;
    if(key!==context){context=key;settings=load(key);render();introDone=false;endingDone=false;}
    if(nextSession!==session){session=nextSession;introDone=false;endingDone=false;automaticSeekUntil=0;}
  }
  async function tick() {
    if(!active()||!settings.enabled||state.status!=='PLAYING'||video.paused||video.readyState<2)return;
    const p=position(),d=duration();if(!(d>settings.intro+settings.ending+1))return;
    if(!introDone){introDone=true;if(settings.intro>0&&p<settings.intro-.25){automaticSeekUntil=Date.now()+3000;window.MobileTVPlaybackControl?.({action:'seek',position:settings.intro});window.MobileTVUI?.toast(`已跳过片头 ${settings.intro} 秒`);return;}}
    if(!endingDone&&settings.ending>0&&p>=d-settings.ending&&p<d){
      endingDone=true;const expected=session;
      let advanced=false;try{advanced=Boolean(await window.MobileTVLibrarySkipNext?.());}catch{}
      if(advanced){window.MobileTVUI?.toast('已跳过片尾，进入下一集');return;}
      if(session===expected){window.MobileTVPlaybackControl?.({action:'pause'});window.MobileTVUI?.toast('已到达片尾跳过位置，播放已暂停');}
    }
  }
  form.addEventListener('submit',event=>{
    event.preventDefault();const intro=Number($('skipIntro').value),ending=Number($('skipEnding').value),d=duration();
    if(!valid(intro)||!valid(ending)){ $('skipStatus').textContent='请输入 0～1800 的整数秒数。';return; }
    if(d>0&&intro+ending+1>=d){$('skipStatus').textContent='片头与片尾合计须小于影片时长。';return;}
    const next={intro,ending,enabled:$('skipEnabled').checked},entries=Object.entries(readAll()).filter(([key])=>key!==context).slice(-99);
    try{localStorage.setItem(storeKey,JSON.stringify(Object.fromEntries([...entries,[context,next]])));}catch{$('skipStatus').textContent='设置未能保存，请检查浏览器存储。';return;}
    settings=next;introDone=false;endingDone=false;render();$('skipStatus').textContent='已保存';tick();
  });
  video.addEventListener('seeking',()=>{if(Date.now()<automaticSeekUntil)return;introDone=true;endingDone=settings.ending>0&&position()>=duration()-settings.ending;});
  for(const event of ['timeupdate','playing','loadedmetadata','seeked'])video.addEventListener(event,tick);
  window.MobileTVSkips={setState};setState(window.MobileTVPlayerState?.());
})();
