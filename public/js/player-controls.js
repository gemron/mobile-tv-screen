(() => {
  'use strict';
  const panel=document.querySelector('.player-options-panel'),layout=document.createElement('div'),main=document.createElement('div'),secondary=document.createElement('div');
  layout.className='player-options-layout';main.className='player-settings-main';secondary.className='player-settings-secondary';
  const fields=['label[for="selectStreamMode"]','#selectStreamMode','.media-track-settings','.options-buttons'].map(selector=>panel.querySelector(selector));
  const information=['#skipSettings','.resolution-readout',':scope > .quality-note','.player-diagnostics','#btnHudLogs'].map(selector=>panel.querySelector(selector));
  main.append(...fields.filter(Boolean));secondary.append(...information.filter(Boolean));layout.append(main,secondary);panel.append(layout);
  const select=document.getElementById('selectRate'),details=document.getElementById('playerRate'),menu=document.getElementById('playerRateMenu'),label=document.getElementById('playerRateLabel');
  const trigger=details.querySelector('summary'),buttons=[];
  function setRate(rate) {
    rate=Number(rate)||1;
    label.textContent=rate===1?'倍速':`${rate}×`;
    trigger.setAttribute('aria-label',`播放速度，当前 ${rate} 倍`);
    buttons.forEach(button=>{const active=Number(button.dataset.rate)===rate;button.setAttribute('aria-checked',String(active));button.tabIndex=active?0:-1;});
  }
  function close(focus=false) { details.open=false;if(focus)trigger.focus({preventScroll:true}); }
  for(const option of select.options) {
    const button=document.createElement('button');button.type='button';button.dataset.rate=option.value;button.setAttribute('role','menuitemradio');button.textContent=Number(option.value)===1?'1× 标准':option.textContent;
    button.addEventListener('click',()=>{select.value=button.dataset.rate;select.dispatchEvent(new Event('change',{bubbles:true}));setRate(select.value);close(true);});
    menu.append(button);buttons.push(button);
  }
  trigger.addEventListener('keydown',event=>{
    if(!['ArrowDown','ArrowUp'].includes(event.key))return;
    event.preventDefault();event.stopPropagation();details.open=true;(buttons.find(b=>b.getAttribute('aria-checked')==='true')||buttons[0]).focus();
  });
  menu.addEventListener('keydown',event=>{
    const index=buttons.indexOf(document.activeElement);let next;
    if(['Enter',' '].includes(event.key)&&index>=0){event.preventDefault();event.stopPropagation();buttons[index].click();return;}
    if(event.key==='Home')next=0;else if(event.key==='End')next=buttons.length-1;
    else if(['ArrowDown','ArrowRight'].includes(event.key))next=(index+1)%buttons.length;
    else if(['ArrowUp','ArrowLeft'].includes(event.key))next=(index-1+buttons.length)%buttons.length;
    if(next!==undefined){event.preventDefault();event.stopPropagation();buttons[next].focus();}
  });
  details.addEventListener('keydown',event=>{if(event.key==='Escape'){event.preventDefault();event.stopPropagation();close(true);}});
  // During a native mouse focus transition activeElement can briefly be body.
  // Use the destination so the menu survives long enough to receive the click.
  details.addEventListener('focusout',event=>{if(event.relatedTarget&&!details.contains(event.relatedTarget))close();});
  details.addEventListener('toggle',()=>{trigger.setAttribute('aria-expanded',String(details.open));if(details.open)document.getElementById('playerOptions').open=false;});
  document.addEventListener('pointerdown',event=>{if(details.open&&!details.contains(event.target))close();});
  select.addEventListener('change',()=>setRate(select.value));
  select.hidden=true;details.hidden=false;window.MobileTVPlaybackControls={setRate};setRate(window.MobileTVPlayerState?.()?.playbackRate||select.value);
})();
