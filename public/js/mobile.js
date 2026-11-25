(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  let ws = null;
  let state = null;
  let seeking = false;
  let mirrorStream = null;
  let pc = null;

  function formatSec(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  function updateUi(snap) {
    if (!snap) return;
    state = snap;
    const isIdle = !snap.status || snap.status === 'IDLE' || snap.status === 'STOPPED';
    $('nowTitle').textContent = isIdle ? '等待投屏' : snap.metadata?.title || '投屏播放中';
    $('nowCaption').hidden = isIdle;
    $('nowCaption').textContent = snap.status === 'PLAYING' ? '正在播放' : snap.status === 'LOADING' ? '正在加载' : '已暂停';
    $('nowMeta').textContent = isIdle
      ? '从视频 App、链接或手机文件开始'
      : ({ Library: '影视片库', Live: '直播', BilibiliCast: 'B站投屏' })[snap.protocol] || snap.protocol || '投屏';
    $('btnPlayPause').textContent = snap.status === 'PLAYING' ? '暂停' : '播放';

    $('volBar').value = String(snap.volume ?? 80);
    $('volLabel').textContent = String(snap.volume ?? 80);
    $('btnMute').textContent = snap.muted ? '取消静音' : '静音';
    for (const id of ['btnPlayPause', 'btnRewind', 'btnForward', 'btnStop', 'seekBar']) $(id).disabled = isIdle;

    updateProgress(snap.position || 0, snap.duration || 0);
  }

  function updateProgress(pos, dur) {
    if (seeking) return;
    if (dur > 0) $('seekBar').max = dur;
    $('seekBar').value = pos;
    $('timeLabel').textContent = `${formatSec(pos)} / ${formatSec(dur)}`;
  }

  function sendControl(data) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'control', data }));
      return;
    }
    fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(data),
    });
  }

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws?role=mobile`);

    ws.onopen = () => {
      $('wsBadge').textContent = '已连接大屏';
      $('wsBadge').dataset.state = 'connected';
    };

    ws.onclose = () => {
      $('wsBadge').textContent = '重连中...';
      $('wsBadge').dataset.state = 'connecting';
      setTimeout(connectWs, 1500);
    };

    ws.onmessage = async (ev) => {
      let msg;
      try {
        msg = JSON.parse(ev.data);
      } catch {
        return;
      }

      if (msg.type === 'init') {
        if (msg.data?.identity?.deviceName) {
          $('tvName').textContent = msg.data.identity.deviceName;
        }
        if (msg.data?.state) updateUi(msg.data.state);
      } else if (msg.type === 'state') {
        updateUi(msg.data);
      } else if (msg.type === 'progress') {
        updateProgress(msg.data.position || 0, msg.data.duration || 0);
      } else if (msg.type === 'deviceInfo' && msg.data?.identity?.deviceName) {
        $('tvName').textContent = msg.data.identity.deviceName;
      } else if (msg.type === 'webrtc-answer' && pc && msg.answer) {
        await pc.setRemoteDescription(msg.answer);
      } else if (msg.type === 'webrtc-ice' && pc && msg.candidate) {
        try {
          await pc.addIceCandidate(msg.candidate);
        } catch {}
      }
    };
  }

  // Tab switching
  const tabs = [...document.querySelectorAll('.tab-btn')];
  function selectTab(button, focus = false) {
    tabs.forEach((tab) => {
      const selected = tab === button;
      tab.classList.toggle('active', selected);
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = $(`tab-${tab.dataset.tab}`);
      panel.hidden = !selected;
      panel.classList.toggle('active', selected);
    });
    if (focus) button.focus();
  }
  tabs.forEach((button, index) => {
    button.addEventListener('click', () => selectTab(button));
    button.addEventListener('keydown', (event) => {
      let next;
      if (event.key === 'ArrowRight') next = (index + 1) % tabs.length;
      else if (event.key === 'ArrowLeft') next = (index + tabs.length - 1) % tabs.length;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = tabs.length - 1;
      else return;
      event.preventDefault();
      selectTab(tabs[next], true);
    });
  });
  selectTab(tabs[0]);

  // Remote controls
  $('btnPlayPause').addEventListener('click', () => {
    sendControl({ action: state?.status === 'PLAYING' ? 'pause' : 'play' });
  });
  $('btnRewind').addEventListener('click', () => {
    sendControl({ action: 'seek', position: Math.max(0, (Number($('seekBar').value) || 0) - 15) });
  });
  $('btnForward').addEventListener('click', () => {
    sendControl({ action: 'seek', position: (Number($('seekBar').value) || 0) + 15 });
  });
  $('seekBar').addEventListener('input', () => {
    seeking = true;
    $('timeLabel').textContent = `${formatSec($('seekBar').value)} / ${formatSec($('seekBar').max)}`;
  });
  $('seekBar').addEventListener('change', () => {
    seeking = false;
    sendControl({ action: 'seek', position: Number($('seekBar').value) });
  });
  $('volBar').addEventListener('input', () => {
    $('volLabel').textContent = $('volBar').value;
    sendControl({ action: 'volume', volume: Number($('volBar').value) });
  });
  $('btnMute').addEventListener('click', () => {
    sendControl({ action: 'mute', muted: !state?.muted });
  });
  $('btnRotate').addEventListener('click', () => {
    const next = ((state?.rotation || 0) + 90) % 360;
    sendControl({ action: 'display', rotation: next });
  });
  $('btnStop').addEventListener('click', () => {
    stopMirror();
    sendControl({ action: 'stop' });
  });

  // URL cast
  $('btnCastUrl').addEventListener('click', async () => {
    const url = $('castUrlInput').value.trim();
    if (!/^https?:\/\//i.test(url)) return window.MobileTVUI?.toast('请输入完整的视频或图片链接');
    const title = $('castTitleInput').value.trim();
    const streamMode = $('castModeSelect').value;

    const res = await fetch('/api/control', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'cast', url, title, streamMode }),
    });
    if (res.ok) {
      document.querySelector('[data-tab="remote"]').click();
    } else window.MobileTVUI?.toast('投屏未成功，请检查链接后重试');
  });

  // Local file upload cast with XHR upload progress
  $('btnUploadCast').addEventListener('click', () => {
    const file = $('localFileInput').files?.[0];
    if (!file) return window.MobileTVUI?.toast('请先选择一个手机文件');

    const formData = new FormData();
    formData.append('file', file);

    const bar = $('uploadProgressBar');
    const fill = $('uploadProgressFill');
    const hint = $('uploadHint');
    bar.style.display = 'block';
    fill.style.width = '0%';
    hint.textContent = '正在高速传送至大屏...';

    const xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload');
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) {
        const pct = Math.round((e.loaded / e.total) * 100);
        fill.style.width = `${pct}%`;
        hint.textContent = `传输进度: ${pct}%`;
      }
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) {
        hint.textContent = '已成功推送到大屏播放！';
        document.querySelector('[data-tab="remote"]').click();
      } else {
        hint.textContent = '上传投屏失败，请重试。';
      }
    };
    xhr.onerror = () => {
      hint.textContent = '网络传输中断，请确认与电脑在同一 Wi-Fi。';
    };
    xhr.send(formData);
  });

  // WebRTC Mirroring
  async function startMirror(type) {
    if (!navigator.mediaDevices) {
      alert('当前浏览器环境不支持 WebRTC 采集（非 HTTPS 局域网可能受限），请使用相册文件或系统原生 AirPlay/DLNA 投屏。');
      return;
    }

    stopMirror();
    try {
      mirrorStream =
        type === 'screen'
          ? await navigator.mediaDevices.getDisplayMedia({
              video: { frameRate: { ideal: 60, max: 60 } },
              audio: true,
            })
          : await navigator.mediaDevices.getUserMedia({
              video: { facingMode: 'environment', frameRate: { ideal: 30 } },
              audio: true,
            });
    } catch (err) {
      $('mirrorHint').textContent = `无法启动${type === 'screen' ? '屏幕共享' : '摄像头'}: ${err.message}`;
      return;
    }

    pc = new RTCPeerConnection({ iceServers: [] });
    mirrorStream.getTracks().forEach((track) => {
      pc.addTrack(track, mirrorStream);
      track.onended = () => stopMirror();
    });

    pc.onicecandidate = (e) => {
      if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'webrtc-ice', candidate: e.candidate }));
      }
    };

    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);

    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(
        JSON.stringify({
          type: 'webrtc-offer',
          offer,
          title: type === 'screen' ? '手机屏幕实时共享' : '手机摄像头实时投屏',
        })
      );
    }

    $('btnStopMirror').style.display = 'block';
    $('mirrorHint').textContent = '正在实时无线镜像到大屏...';
  }

  function stopMirror() {
    if (mirrorStream) {
      mirrorStream.getTracks().forEach((t) => t.stop());
      mirrorStream = null;
    }
    if (pc) {
      pc.close();
      pc = null;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'webrtc-stop' }));
    }
    $('btnStopMirror').style.display = 'none';
  }

  $('btnMirrorScreen').addEventListener('click', () => startMirror('screen'));
  $('btnMirrorCamera').addEventListener('click', () => startMirror('camera'));
  $('btnStopMirror').addEventListener('click', stopMirror);

  const canShareScreen = Boolean(navigator.mediaDevices?.getDisplayMedia);
  const canShareCamera = Boolean(navigator.mediaDevices?.getUserMedia);
  $('btnMirrorScreen').disabled = !canShareScreen;
  $('btnMirrorCamera').disabled = !canShareCamera;
  if (!canShareScreen && !canShareCamera) {
    $('mirrorHint').textContent = '当前连接不支持屏幕和相机共享：需要 HTTPS 和浏览器支持。你可以使用“链接”或“文件”投屏。';
  }

  connectWs();
})();
