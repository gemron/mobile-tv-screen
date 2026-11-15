(() => {
  'use strict';
  const $ = (id) => document.getElementById(id);
  const bind = (id, handler) => $(id)?.addEventListener('click', handler);
  let toastTimer;
  let logTrigger;

  function toast(message) {
    const element = $('toast');
    if (!element) return;
    element.textContent = message;
    element.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => element.classList.remove('show'), 2600);
  }
  window.MobileTVUI = { toast };

  try {
    document.documentElement.dataset.theme = localStorage.getItem('mobiletv-theme') === 'dark' ? 'dark' : 'light';
  } catch {}
  bind('btnTheme', () => {
    const theme = document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark';
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('mobiletv-theme', theme); } catch {}
  });

  const openDialog = (id) => {
    const dialog = $(id);
    if (dialog && !dialog.open) dialog.showModal();
  };
  bind('btnSettings', () => openDialog('settingsDialog'));
  bind('btnCloseSettings', () => $('settingsDialog').close());
  bind('btnKeyboardHelp', () => openDialog('keyboardDialog'));
  bind('btnCloseKeyboard', () => $('keyboardDialog').close());
  for (const id of ['btnTestDlna', 'btnTestAirplay']) bind(id, () => $('settingsDialog')?.close());

  document.querySelectorAll('dialog').forEach((dialog) => {
    dialog.addEventListener('click', (event) => {
      if (event.target !== dialog) return;
      const bounds = dialog.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) dialog.close();
    });
  });

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
      const dialog = document.querySelector('dialog[open]');
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
