(() => {
  const viewport=document.getElementById('mediaViewport'),video=document.getElementById('tvVideo');
  if(!viewport||!video)return;
  const layer=document.createElement('div');layer.className='danmaku-layer';layer.id='danmakuLayer';layer.setAttribute('aria-hidden','true');viewport.appendChild(layer);
  let state=null,key='',items=[],index=0,last=-1,lane=0,controller=null;
  const position=()=>Number(window.MobileTVPlaybackPosition?.())||Number(video.currentTime)||0;
  function clear(){layer.replaceChildren();}
  function locate(time){let low=0,high=items.length;while(low<high){const middle=(low+high)>>1;if(items[middle].time<time)low=middle+1;else high=middle;}index=low;}
  function pause(){layer.dataset.paused=String(video.paused||video.readyState<3||state?.status!=='PLAYING');}
  function push(item){
    if(state?.protocol!=='BilibiliCast'||state.danmakuEnabled===false||!item?.text||layer.childElementCount>=40)return;
    const node=document.createElement('span'),mode=Number(item.mode)||1,rows=Math.max(1,Math.min(8,Math.floor(viewport.clientHeight/36)));
    node.className='danmaku-comment';node.textContent=String(item.text).slice(0,160);node.dataset.mode=mode===4?'bottom':mode===5?'top':mode===6?'reverse':'scroll';
    node.style.color='#'+((Number(item.color)>>>0)&0xffffff).toString(16).padStart(6,'0');node.style.fontSize=Math.max(16,Math.min(36,Number(item.size)||25))+'px';
    const row=lane++%rows;if(mode===4)node.style.bottom=(16+row*36)+'px';else node.style.top=(16+row*36)+'px';
    node.addEventListener('animationend',()=>node.remove(),{once:true});layer.appendChild(node);pause();
  }
  async function load(sessionId){
    controller?.abort();const current=controller=new AbortController();
    try{const response=await fetch('/api/bilibili-cast/danmaku?sessionId='+sessionId,{signal:current.signal});if(!response.ok)return;const result=await response.json();if(current!==controller||result.sessionId!==state?.sessionId)return;items=Array.isArray(result.items)?result.items.slice(0,5000):[];locate(Math.max(0,position()-.3));}
    catch{}
  }
  function update(snapshot){
    state=snapshot;const next=state?.protocol==='BilibiliCast'&&state.url&&state.metadata?.bilibili?.cid?state.sessionId+':'+state.metadata.bilibili.cid:'';
    layer.hidden=!next||state.danmakuEnabled===false;
    if(next!==key){key=next;controller?.abort();items=[];index=0;last=-1;clear();if(next)load(state.sessionId);}
    if(layer.hidden)clear();pause();
  }
  setInterval(()=>{
    if(layer.hidden||!key)return;const time=position();
    if(last<0||Math.abs(time-last)>2.5){clear();locate(Math.max(0,time-.3));}last=time;
    if(video.paused||video.readyState<3)return;
    let count=0;while(index<items.length&&items[index].time<=time+.15&&count<4){const item=items[index++];if(item.time>=time-1){push(item);count++;}}
    pause();
  },250);
  for(const event of ['playing','pause','waiting','seeking','seeked'])video.addEventListener(event,()=>{if(event==='seeking'){clear();last=-1;}pause();});
  window.MobileTVDanmaku={update,push};
})();
