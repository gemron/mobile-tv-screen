(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const bind = (id, handler) => $(id)?.addEventListener('click', handler);
  let toastTimer;
  let logTrigger;
  document.documentElement.dataset.inputMode='pointer';
  document.addEventListener('pointerdown',()=>{document.documentElement.dataset.inputMode='pointer';},{capture:true,passive:true});
  document.addEventListener('keydown',event=>{if(event.key==='Tab'&&!event.ctrlKey&&!event.metaKey&&!event.altKey)document.documentElement.dataset.inputMode='keyboard';},true);

  function placeToast(element) {
    const focused=document.activeElement?.closest('dialog[open]');
    const dialog=focused||[...document.querySelectorAll('dialog[open]')].at(-1);
    const parent=dialog||document.body;
    if(element.parentElement!==parent)parent.append(element);
    if(typeof element.showPopover==='function'){
      element.popover='manual';
      if(element.matches(':popover-open'))element.hidePopover();
      element.showPopover();
    }
  }

  function toast(message) {
    const element = $('toast');
    if (!element) return;
    element.textContent = message;
    placeToast(element);
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {element.classList.remove('show');if(typeof element.hidePopover==='function'&&element.matches(':popover-open'))element.hidePopover();}, 2600);
  }
  document.addEventListener('close',event=>{const element=$('toast');if(event.target.tagName==='DIALOG'&&element?.classList.contains('show'))placeToast(element);},true);
  let titleSection = '投屏', titleMedia = '';
  function updateTitle({ section, media } = {}) {
    if (section !== undefined) titleSection = section;
    if (media !== undefined) titleMedia = String(media || '').trim();
    document.title = [...(titleMedia || titleSection)].slice(0, 90).join('') + ' · MobileTV';
    syncFrameColor();
  }
  function syncFrameColor() {
    const dark = document.documentElement.dataset.theme === 'dark' || document.body.classList.contains('casting-active');
    document.querySelector('meta[name="theme-color"]')?.setAttribute('content', dark ? '#14221f' : '#eef5f2');
  }
  window.MobileTVUI = { toast, updateTitle };

  try {
    document.documentElement.dataset.theme = localStorage.getItem('mobiletv-theme') === 'dark' ? 'dark' : 'light';
  } catch {}
  syncFrameColor();
  bind('btnTheme', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    syncFrameColor();
    try { localStorage.setItem('mobiletv-theme', theme); } catch {}
  });

  const openDialog = (id) => {
    const dialog = $(id);
    if (dialog && !dialog.open) dialog.showModal();
  };
  let biliToggle,biliHint,biliEnabled=false;
  const tests=$('settingsDialog')?.querySelector('.settings-tests');
  if(tests){
    const section=document.createElement('div'),label=document.createElement('label');section.className='settings-protocol';label.className='protocol-toggle';
    biliToggle=document.createElement('input');biliToggle.type='checkbox';biliToggle.id='bilibiliCastEnabled';biliToggle.disabled=true;label.append(biliToggle,document.createTextNode('B站专用投屏（实验）'));
    biliHint=document.createElement('p');biliHint.className='field-hint';biliHint.id='bilibiliCastHint';biliHint.textContent='支持画质切换、弹幕和分集连播；可用画质取决于视频和账号权限。';const login=document.createElement('button');login.type='button';login.className='btn';login.id='bilibiliAccount';login.textContent='B站账号';login.addEventListener('click',()=>{$('settingsDialog').close();document.dispatchEvent(new CustomEvent('mobiletv-accounts',{detail:{provider:'bili'}}));});section.append(label,biliHint,login);tests.before(section);
    biliToggle.addEventListener('change',async()=>{biliToggle.disabled=true;try{const response=await fetch('/api/bilibili-cast',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({enabled:biliToggle.checked})}),value=await response.json();if(!response.ok)throw new Error(value.error||'未能修改接收设置');biliEnabled=value.enabled;biliHint.textContent=value.active?'接收已开启，在B站投屏列表查找“我的小电视”。支持画质切换、弹幕和分集连播。':'实验接收已关闭。';}catch(error){biliToggle.checked=biliEnabled;biliHint.textContent=error.message;}finally{biliToggle.disabled=false;}});
  }
  bind('btnSettings', async() => {openDialog('settingsDialog');if(biliToggle)try{const response=await fetch('/api/bilibili-cast');if(!response.ok)throw new Error('重启 MobileTV 后可使用该功能');const value=await response.json();biliEnabled=value.enabled;biliToggle.checked=biliEnabled;biliToggle.disabled=false;biliHint.textContent=value.lastError?'实验接收未就绪：'+value.lastError:value.active?'接收已开启，在B站查找“我的小电视”。画质取决于视频和账号权限。':'支持画质切换、弹幕和分集连播；按需开启。';}catch(error){biliHint.textContent=error.message;}});
  bind('btnCloseSettings', () => $('settingsDialog').close());
  bind('btnKeyboardHelp', () => openDialog('keyboardDialog'));
  bind('btnCloseKeyboard', () => $('keyboardDialog').close());
  for (const id of ['btnTestDlna', 'btnTestAirplay']) bind(id, () => $('settingsDialog')?.close());

  document.querySelectorAll('dialog').forEach((dialog) => {
    let startedOutside = false;
    const outside = event => { const bounds = dialog.getBoundingClientRect(); return event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom; };
    dialog.addEventListener('pointerdown', event => { startedOutside = event.target === dialog && outside(event); });
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      if (startedOutside && outside(event)) dialog.close(); startedOutside = false;
    });
  });
  document.addEventListener('pointerdown', event => { const settings = $('playerOptions'); if (settings?.open && !settings.contains(event.target)) settings.open = false; });

  function setLogsOpen(open, trigger) {
    const drawer = $('logDrawer');
    if (!drawer) return;
    drawer.classList.toggle('open', open);
    drawer.setAttribute('aria-hidden', String(!open));
    $('logBackdrop').hidden = !open;
    for (const element of [$('standbyView'), $('libraryView'), $('playerStage'), document.querySelector('.topbar')]) {
      if (element) element.inert = open;
    }
    if (open) {
      logTrigger = trigger || document.activeElement;
      requestAnimationFrame(() => {
        if (drawer.classList.contains('open')) $('btnCloseLogs').focus();
      });
    } else logTrigger?.focus();
  }
  bind('btnOpenLogs', (event) => setLogsOpen(true, event.currentTarget));
  bind('btnHudLogs', (event) => setLogsOpen(true, event.currentTarget));
  bind('btnCloseLogs', () => setLogsOpen(false));
  bind('logBackdrop', () => setLogsOpen(false));

  bind('btnCopyUrl', async () => {
    const text = $('mobileUrlText').textContent;
    if (!text.startsWith('http')) return toast('连接地址还未就绪');
    try {
      if (navigator.clipboard && window.isSecureContext) await navigator.clipboard.writeText(text);
      else {
        const input = document.createElement('textarea');
        input.value = text;
        input.style.cssText = 'position:fixed;left:-9999px;top:0';
        document.body.appendChild(input);
        input.select();
        let copied;
        try { copied = document.execCommand('copy'); } finally { input.remove(); $('btnCopyUrl').focus(); }
        if (!copied) throw new Error('Copy unavailable');
      }
      toast('连接地址已复制');
    } catch { toast('复制未成功，可选中连接地址手动复制'); }
  });

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    const editable = /^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '') || event.target?.isContentEditable;
    if (event.key === 'Escape') {
      const dialog = [...document.querySelectorAll('dialog[open]')].at(-1);
      if (dialog) { dialog.close(); event.preventDefault(); }
      else if ($('logDrawer')?.classList.contains('open')) { setLogsOpen(false); event.preventDefault(); }
      else if ($('playerOptions')?.open) { $('playerOptions').open = false; event.preventDefault(); }
      return;
    }
    if (event.key === 'Tab' && $('logDrawer')?.classList.contains('open')) {
      const controls = [...$('logDrawer').querySelectorAll('button:not(:disabled), a[href], input, select')];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (!$('logDrawer').contains(document.activeElement) || (event.shiftKey && document.activeElement === first) || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first)?.focus();
      }
    }
    if (!editable && event.key === '?' && !event.repeat && $('keyboardDialog')) {
      if ($('settingsDialog')?.open || $('logDrawer')?.classList.contains('open')) return;
      openDialog('keyboardDialog');
      event.preventDefault();
    }
    if (event.key === 'Enter' && event.target === $('quickUrlInput')) { event.preventDefault(); $('btnQuickCast').click(); }
    if (event.key === 'Enter' && event.target === $('deviceNameInput')) { event.preventDefault(); $('btnSaveName').click(); }
  });
})();
