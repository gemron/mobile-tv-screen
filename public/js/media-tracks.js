(() => {
  'use strict';
  const $=id=>document.getElementById(id),video=$('tvVideo');
  let state=null,data=null,identity='',movie='',probe=null,selected=null,windowRange=null,captionRequest=null,serial=0,retryAt=0;
  const language={jpn:'日语',ja:'日语',chi:'中文',zho:'中文',zh:'中文',eng:'英语',en:'英语',yue:'粤语',kor:'韩语',fra:'法语',und:'未标注语言'};
  const position=()=>window.MobileTVPlaybackPosition?.()||video.currentTime||0;
  const message=(text,error=false)=>{ $('mediaTracksStatus').textContent=text;$('mediaTracksStatus').classList.toggle('error',error); };
  const captionMessage=(text='',busy=false,error=false)=>{const status=$('subtitleEmbeddedStatus');status.textContent=text;status.classList.toggle('error',error);status.parentElement.setAttribute('aria-busy',String(busy));$('subtitleEmbeddedCancel').hidden=!busy;};
  const label=(t,index)=>[t.title||language[t.language]||t.language||`轨道 ${index+1}`,t.codec.toUpperCase(),t.channels?(t.channels===6?'5.1 声道':t.channels===2?'立体声':t.channels+' 声道'):t.forced?'强制字幕':''].filter(Boolean).join(' · ');
  const element=(tag,text,className)=>{const e=document.createElement(tag);e.textContent=text;if(className)e.className=className;return e;};
  async function request(route,body,signal) {
    const response=await fetch('/api/media/'+route,{...(body===undefined?{}:{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)}),signal});
    const result=await response.json();signal?.throwIfAborted();if(!response.ok)throw new Error(result.error||'轨道读取失败');return result;
  }
  function display(values) { window.MobileTVPlayerDisplay?.({...values,sessionId:state?.sessionId}); }
  function off() { captionRequest?.abort();captionRequest=null;selected=null;windowRange=null;retryAt=0;captionMessage();if(state?.burnSubtitle!=null)display({burnSubtitle:null});render(); }
  function render() {
    const select=$('mediaAudioTrack');select.replaceChildren(new Option('自动音轨',''));
    (data?.audio||[]).forEach((t,index)=>select.append(new Option(`${index+1} · ${label(t,index)}`,String(index))));
    select.disabled=!data?.audio?.length;select.value=state?.audioTrack==null?'':String(state.audioTrack);
    const list=$('subtitleEmbedded');list.replaceChildren();
    if(!data){list.append(element('p','点击“读取内置轨道”查看文件中的音轨与字幕。','field-hint'));return;}
    if(!data.subtitles.length)list.append(element('p','此文件没有可切换的内置字幕流；已压在画面上的字幕无法关闭。','field-hint'));
    data.subtitles.forEach((t,index)=>{
      const button=element('button','','subtitle-result');button.type='button';
      button.setAttribute('aria-pressed',String(t.index===selected?.index));
      button.append(element('strong',`${index+1} · ${label(t,index)}`),element('span',t.kind==='image'?'图像字幕 · 需要兼容转码':t.kind==='text'?'内置文字字幕':'暂不支持的字幕格式'));
      button.disabled=t.kind==='unsupported';button.addEventListener('click',()=>choose(t,index));list.append(button);
    });
  }
  async function read({automatic=false}={}) {
    if(!state?.url||['IDLE','STOPPED'].includes(state.status))return;
    if(data){render();return data;}if(probe)return probe.promise;
    const controller=new AbortController(),id=++serial,session=state.sessionId;
    message('正在读取内置音轨与字幕…');captionMessage('正在读取内置轨道…',true);$('mediaTracksRead').disabled=true;$('subtitleEmbeddedRead').disabled=true;
    const promise=(async()=>{try{
      const result=await request('tracks?sessionId='+session,undefined,controller.signal);
      if(id!==serial||session!==state?.sessionId)return;
      data=result;render();message(`${data.audio.length} 条音轨 · ${data.subtitles.length} 条内置字幕`);captionMessage();
      if(selected?.kind==='text'){
        const match=data.subtitles.find(t=>t.kind==='text'&&t.language===selected.language&&t.codec===selected.codec&&(t.title||'')===(selected.title||''));
        if(match){selected={...match,name:selected.name};captions(false);}else{off();window.MobileTVSubtitles?.clearEmbedded();}
      }
      const audio=data.audio[state.audioTrack??0];
      const remuxing=state.streamMode==='transcode'||window.MobileTVActiveStreamMode?.()==='transcode';
      if(automatic&&!remuxing&&audio&&['ac3','eac3','dts','truehd','mlp','wmav2','wmapro','pcm_bluray','pcm_dvd','pcm_s24le','pcm_s32le','alac','mp2'].includes(audio.codec)){
        display({audioTrack:state.audioTrack??0,streamMode:'transcode'});window.MobileTVUI?.toast('已将 '+audio.codec.toUpperCase()+' 音轨转换为 AAC 立体声，保留视频画质');
      }
      return result;
    }catch(error){if(id===serial&&error.name!=='AbortError'){message(error.message,true);captionMessage(error.message,false,true);}}finally{if(id===serial){probe=null;$('mediaTracksRead').disabled=false;$('subtitleEmbeddedRead').disabled=false;}}})();
    probe={controller,promise};return promise;
  }
  async function choose(track,index) {
    off();selected={...track,name:label(track,index)};render();
    if(track.kind==='image'){
      const status=$('subtitleEmbeddedStatus');status.replaceChildren(element('span','此字幕需要视频转码，可能增加 CPU 占用。'));
      const accept=element('button','启用图像字幕兼容播放','btn');accept.type='button';accept.addEventListener('click',()=>{
        if(!selected||selected.index!==track.index)return;
        display({burnSubtitle:index,streamMode:'transcode'});window.MobileTVSubtitles?.showEmbeddedImage(selected.name);$('subtitleDialog').close();
      });status.append(accept);return;
    }
    if(state.burnSubtitle!=null)display({burnSubtitle:null});await captions(true);
  }
  async function captions(close=false,{targetPosition,exact=false}={}) {
    if(!selected||selected.kind!=='text')return;
    const now=targetPosition!=null?targetPosition:position(),from=exact?Math.floor(now):Math.floor(now/20)*20,session=state?.sessionId,index=selected.index;
    if(captionRequest?.from===from&&captionRequest?.exact===exact)return;
    captionRequest?.abort();const controller=new AbortController();controller.from=from;controller.exact=exact;captionRequest=controller;
    captionMessage(close?'正在读取内置字幕…':'正在更新当前位置的字幕…',true);
    const deadline=setTimeout(()=>controller.abort(new DOMException('内置字幕读取超时，请点击语言重试','TimeoutError')),48000);
    try{
      const result=await request('subtitles',{sessionId:session,index,position:now,...(exact?{exact:true}:{})},controller.signal);
      if(controller!==captionRequest||session!==state?.sessionId||index!==selected?.index)return;
      windowRange={from:result.from,to:result.to};retryAt=0;captionMessage(result.cues.length?'已加载内置字幕':'当前时间段没有对白，将在播放时自动更新');window.MobileTVSubtitles?.showEmbedded({...result,name:selected.name},close);
    }catch(error){if(error.name!=='AbortError'&&controller===captionRequest){retryAt=Infinity;captionMessage(error.message+'，点击语言可重试',false,true);}}
    finally{clearTimeout(deadline);if(controller===captionRequest)captionRequest=null;}
  }
  const update=()=>{
    if(!selected||selected.kind!=='text'||captionRequest||Date.now()<retryAt)return;
    const now=position();
    if(!windowRange||now<windowRange.from){captions(false);return;}
    const span=Math.max(1,windowRange.to-windowRange.from),lead=Math.min(12,span/3);
    if(now>=windowRange.to-lead){
      const shortWindow=span<20;
      captions(false,shortWindow?{targetPosition:Math.max(now,windowRange.to-1),exact:true}:{});
    }
  };
  video.addEventListener('timeupdate',update);video.addEventListener('seeking',()=>{captionRequest?.abort();captionRequest=null;windowRange=null;retryAt=0;update();});
  $('subtitleEmbeddedCancel').addEventListener('click',()=>{serial++;probe?.controller.abort();probe=null;$('mediaTracksRead').disabled=false;$('subtitleEmbeddedRead').disabled=false;captionRequest?.abort();captionRequest=null;retryAt=Infinity;captionMessage('已取消读取，点击语言可重试');});
  $('mediaTracksRead').addEventListener('click',()=>read());$('subtitleEmbeddedRead').addEventListener('click',()=>read());
  $('mediaAudioTrack').addEventListener('change',event=>{const index=event.target.value===''?null:Number(event.target.value);display({audioTrack:index,streamMode:'transcode'});});
  window.MobileTVTracks={
    read,off,
    setState(next){
      const nextIdentity=next?.url&&!['IDLE','STOPPED'].includes(next.status)?[next.sessionId,next.url].join('|'):'',nextMovie=nextIdentity?[next.protocol,next.metadata?.title,next.metadata?.bilibili?.cid||''].join('|'):'';
      const changed=nextIdentity!==identity;
      if(changed){serial++;probe?.controller.abort();probe=null;$('mediaTracksRead').disabled=false;$('subtitleEmbeddedRead').disabled=false;captionRequest?.abort();captionRequest=null;captionMessage();retryAt=0;if(nextMovie!==movie)selected=null;windowRange=null;data=null;identity=nextIdentity;movie=nextMovie;}
      state=next;if(changed)render();else $('mediaAudioTrack').value=next?.audioTrack==null?'':String(next.audioTrack);
      let decoded=next?.url||'';try{decoded=decodeURIComponent(decoded);}catch{}
      const isMkv=/matroska/i.test(next?.metadata?.mimeType||'')||/\.mkv(?:$|[?#&])/i.test(decoded);
      if(nextIdentity&&!next.metadata?.isLive&&(/drive\.quark\.cn/i.test(decoded)||(isMkv&&next.streamMode!=='transcode')||selected))read({automatic:true});
    }
  };
  render();
})();
