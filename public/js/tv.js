(() => {
  'use strict';

  const $ = (id) => document.getElementById(id);

  const els = {
    headerDeviceName: $('headerDeviceName'),
    receiverName: $('receiverName'),
    dotDlna: $('dotDlna'),
    lblDlna: $('lblDlna'),
    dotAirplay: $('dotAirplay'),
    lblAirplay: $('lblAirplay'),
    dotTvbox: $('dotTvbox'),
    lblTvbox: $('lblTvbox'),
    dotWs: $('dotWs'),
    lblWs: $('lblWs'),
    ipSelect: $('ipSelect'),
    deviceNameInput: $('deviceNameInput'),
    btnSaveName: $('btnSaveName'),
    qrImg: $('qrImg'),
    mobileUrlText: $('mobileUrlText'),
    clientCountChip: $('clientCountChip'),
    guideIpAndroid: $('guideIpAndroid'),
    guideNameAndroid: $('guideNameAndroid'),
    guideNameApple: $('guideNameApple'),
    quickUrlInput: $('quickUrlInput'),
    btnQuickCast: $('btnQuickCast'),
    btnTestDlna: $('btnTestDlna'),
    btnTestAirplay: $('btnTestAirplay'),
    btnMiracast: $('btnMiracast'),
    historyList: $('historyList'),
    historyCountChip: $('historyCountChip'),
    btnStandbyFullscreen: $('btnStandbyFullscreen'),

    playerStage: $('playerStage'),
    mediaViewport: $('mediaViewport'),
    tvVideo: $('tvVideo'),
    tvMirrorVideo: $('tvMirrorVideo'),
    tvImage: $('tvImage'),
    audioStage: $('audioStage'),
    audioTitle: $('audioTitle'),
    audioArtist: $('audioArtist'),
    bufferingPill: $('bufferingPill'),

    hudTitle: $('hudTitle'),
    hudSubtitle: $('hudSubtitle'),
    metricPerf: $('metricPerf'),
    metricBuffer: $('metricBuffer'),
    metricRemux: $('metricRemux'),
    metricProto: $('metricProto'),
    videoResolution: $('videoResolution'),
    btnStopCast: $('btnStopCast'),
    btnHudLogs: $('btnHudLogs'),
    seekRow: $('seekRow'),
    lblCurrentTime: $('lblCurrentTime'),
    lblDuration: $('lblDuration'),
    seekSlider: $('seekSlider'),
    seekTrack: $('seekTrack'),
    seekBuffered: $('seekBuffered'),
    seekPlayed: $('seekPlayed'),
    btnRewind15: $('btnRewind15'),
    btnPlayPause: $('btnPlayPause'),
    btnForward15: $('btnForward15'),
    btnMute: $('btnMute'),
    volumeSlider: $('volumeSlider'),
    selectRate: $('selectRate'),
    selectStreamMode: $('selectStreamMode'),
    btnRotate: $('btnRotate'),
    btnFitMode: $('btnFitMode'),
    btnSnapshot: $('btnSnapshot'),
    btnPip: $('btnPip'),
    btnFullscreen: $('btnFullscreen'),

    logDrawer: $('logDrawer'),
    logBody: $('logBody'),
    btnOpenLogs: $('btnOpenLogs'),
    btnCloseLogs: $('btnCloseLogs'),
  };

  let ws = null;
  let currentState = null;
  let activeSessionId = -1;
  let activeUrl = '';
  let activeStreamMode = 'auto';
  let requestedStreamMode = 'auto';
  let activeAudioTrack = null, activeBurnSubtitle = null;
  let remuxRequestId = '', remuxRequestSerial = 0, preparedRanges = [];
  let transcodeBase = 0;
  let streamDuration = 0;
  let hlsRecoveryTimer = null;
  let originalBufferTimer = null;
  let originalBufferReady = false;
  let hlsPlayer = null;
  let mpegtsPlayer = null;
  let peerConn = null;
  let pendingStartPos = 0;
  let pendingStartUnit = 'auto';
  let fallbackStage = 0; // 0: initial, 1: proxy fallback, 2: transcode fallback
  let isUserSeeking = false;
  let hudTimer = null;
  let lastTelemetrySentMs = 0;
  let lastFrameCount = 0;
  let lastDroppedCount = 0;
  let lastFrameTs = performance.now();
  let autoplayMutedFallback = false;
  window.MobileTVPlayerState = () => currentState;

  function playbackPosition() {
    return (Number(els.tvVideo.currentTime) || 0) + transcodeBase;
  }
  window.MobileTVPlaybackPosition=playbackPosition;
  window.MobileTVPlaybackDuration=playbackDuration;
  window.MobileTVPlaybackControl=postControl;
  window.MobileTVPlayerDisplay=payload=>postControl({action:'display',...payload});

  function playbackDuration() {
    const duration = Number(els.tvVideo.duration);
    // A growing fMP4 duration is the data received so far, not the movie length.
    if (activeStreamMode === 'transcode') return streamDuration;
    return Number.isFinite(duration) && duration > 0 ? duration : Number(currentState?.duration) || 0;
  }

  function seekPlayback(position) {
    const target = Math.max(0, Number(position) || 0);
    const video = els.tvVideo;
    if (activeStreamMode === 'transcode') {
      const relative = target - transcodeBase;
      let buffered = false;
      for (let i = 0; i < (video.buffered?.length || 0); i++) {
        if (relative >= video.buffered.start(i) && relative < video.buffered.end(i)) buffered = true;
      }
      if (!buffered) {
        pendingStartPos = 0;
        attachVideoOrAudioStream(activeUrl, 'transcode', target);
        return;
      }
      video.currentTime = relative;
    } else video.currentTime = target;
  }

  async function safePlay(video) {
    try {
      await video.play();
    } catch (err) {
      if (!video.muted && (err?.name === 'NotAllowedError' || String(err).includes('NotAllowedError'))) {
        autoplayMutedFallback = true;
        video.muted = true;
        els.bufferingPill.textContent = '已自动静音起播，点击画面任意位置恢复声音';
        els.bufferingPill.classList.add('show');
        const restoreAudio = () => {
          autoplayMutedFallback = false;
          video.muted = Boolean(currentState?.muted);
          els.bufferingPill.classList.remove('show');
        };
        document.addEventListener('pointerdown', restoreAudio, { once: true });
        document.addEventListener('keydown', restoreAudio, { once: true });
        await video.play().catch(() => {});
      }
    }
  }

  function startNativePlayback(video) {
    if (activeStreamMode === 'transcode' && currentState?.mediaType === 'video' && /matroska/i.test(currentState?.metadata?.mimeType || '') && video.readyState >= 1 && !video.videoWidth) {
      reportVideoDecoderFailure(video);
      return;
    }
    let original = false;
    try {
      const proxy = new URL(activeUrl, location.href);
      const source = proxy.origin === location.origin && proxy.pathname === '/api/proxy' && proxy.searchParams.has('headerContext') ? new URL(proxy.searchParams.get('url')) : null;
      original = source?.protocol === 'https:' && !source.port && /^dl-pc-[a-z0-9-]+\.drive\.quark\.cn$/i.test(source.hostname);
    } catch { /* Ordinary media starts immediately. */ }
    if (!original || originalBufferReady || hlsPlayer || mpegtsPlayer) { safePlay(video); return; }
    if (originalBufferTimer !== null) return;
    let bufferingSince = null;
    const check = () => {
      originalBufferTimer = null;
      if (currentState?.status !== 'PLAYING') return;
      let ahead = 0;
      for (let i = 0; i < video.buffered.length; i++) {
        if (video.buffered.start(i) <= video.currentTime + 0.25 && video.buffered.end(i) > video.currentTime) ahead = video.buffered.end(i) - video.currentTime;
      }
      if ((ahead > 0 || video.readyState >= 1) && bufferingSince === null) bufferingSince = performance.now();
      const duration = playbackDuration();
      // Fragmented MP4 preloading is often capped to one short fragment while
      // paused; use a smaller attainable reserve rather than waiting 12 seconds.
      const reserve = activeStreamMode === 'transcode' ? 2 : 10;
      const target = Math.min(reserve, duration > 0 ? Math.max(0, duration - playbackPosition()) : reserve);
      // Build a short reserve for a variable-rate original, but never wait
      // indefinitely when Chromium limits preloading while paused. Some MKV
      // streams expose a decoded frame without any buffered time ranges.
      const frameWithoutRanges = video.readyState >= 2 && video.videoWidth > 0 && video.buffered.length === 0;
      if (frameWithoutRanges || (ahead > 0 && ahead >= target - 0.15) || (bufferingSince !== null && performance.now() - bufferingSince >= 12000)) {
        originalBufferReady = true; safePlay(video); return;
      }
      const message = ahead > 0 ? `正在缓冲 · ${Math.floor(ahead)} / ${Math.ceil(target)} 秒` : '正在读取原文件…';
      if (els.bufferingPill.textContent !== message) els.bufferingPill.textContent = message;
      els.bufferingPill.classList.add('show');
      originalBufferTimer = setTimeout(check, 200);
    };
    check();
  }

  function reportVideoDecoderFailure(video) {
    video.pause();
    els.bufferingPill.textContent = '当前浏览器无法解码这路视频，请检查硬件加速或切换播放线路';
    els.bufferingPill.classList.add('show');
    if (currentState?.status === 'PLAYING') postControl({ action: 'pause' });
  }

  function formatSec(sec) {
    const s = Math.max(0, Math.floor(Number(sec) || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = s % 60;
    if (h > 0) {
      return `${h}:${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
    }
    return `${String(m).padStart(2, '0')}:${String(r).padStart(2, '0')}`;
  }

  function isSameOriginStreamUrl(url) {
    if (!url) return true;
    if (url.startsWith('blob:') || url.startsWith('data:')) return true;
    try {
      return new URL(url, location.href).origin === location.origin;
    } catch {
      return false;
    }
  }

  function resolvePlaybackUrl(rawUrl, mode) {
    if (!rawUrl || rawUrl.startsWith('webrtc://')) return rawUrl;
    if(isServerRemux(rawUrl))return rawUrl;
    let upstreamUrl = rawUrl;
    try {
      upstreamUrl = new URL(rawUrl, location.href).href;
    } catch {}
    if (mode === 'transcode') {
      return `/api/transcode?url=${encodeURIComponent(upstreamUrl)}`;
    }
    if (mode === 'proxy') {
      return `/api/proxy?url=${encodeURIComponent(upstreamUrl)}`;
    }
    if (mode === 'direct') {
      return rawUrl;
    }
    // Phones often serve LAN media without CORS headers. Proxy every other origin,
    // including private IPs, so HLS playlists, keys and segments can all be loaded.
    return isSameOriginStreamUrl(rawUrl) ? rawUrl : `/api/proxy?url=${encodeURIComponent(upstreamUrl)}`;
  }

  function isServerRemux(url){try{const value=new URL(url,location.href);return value.origin===location.origin&&value.pathname==='/api/transcode';}catch{return false;}}

  function destroyMediaEngines() {
    preparedRanges=[];remuxRequestId='';
    els.seekBuffered.style.background = 'none'; els.seekPlayed.style.width = '0%';
    if (els.metricBuffer) els.metricBuffer.hidden = true;
    if (els.metricRemux) els.metricRemux.hidden = true;
    if (originalBufferTimer !== null) clearTimeout(originalBufferTimer);
    originalBufferTimer = null;
    originalBufferReady = false;
    lastFrameCount = lastDroppedCount = 0;
    lastFrameTs = performance.now();
    if (hlsRecoveryTimer) clearTimeout(hlsRecoveryTimer);
    hlsRecoveryTimer = null;
    if (hlsPlayer) {
      try {
        hlsPlayer.destroy();
      } catch {}
      hlsPlayer = null;
    }
    if (mpegtsPlayer) {
      try {
        mpegtsPlayer.pause();
        mpegtsPlayer.unload();
        mpegtsPlayer.detachMediaElement();
        mpegtsPlayer.destroy();
      } catch {}
      mpegtsPlayer = null;
    }
    els.tvVideo.removeAttribute('src');
    els.tvVideo.load();
  }

  function closePeerConnection() {
    if (peerConn) {
      try {
        peerConn.close();
      } catch {}
      peerConn = null;
    }
    els.tvMirrorVideo.srcObject = null;
  }

  function applyMediaTransform() {
    const rot = currentState?.rotation || 0;
    const fit = currentState?.fitMode || 'contain';
    const target =
      currentState?.mediaType === 'image'
        ? els.tvImage
        : currentState?.mediaType === 'mirror'
        ? els.tvMirrorVideo
        : els.tvVideo;

    target.style.objectFit = fit;

    let scale = 1;
    if (rot === 90 || rot === 270) {
      const vw = els.mediaViewport.clientWidth || window.innerWidth;
      const vh = els.mediaViewport.clientHeight || window.innerHeight;
      if (vw > 0 && vh > 0) {
        scale = Math.min(vw / vh, vh / vw);
      }
    }
    target.style.transform = `translateZ(0) rotate(${rot}deg) scale(${scale})`;

    els.btnRotate.textContent = `旋转 ${rot}°`;
    const fitLabel = fit === 'cover' ? '填充' : fit === 'fill' ? '拉伸' : '适应';
    els.btnFitMode.textContent = `比例: ${fitLabel}`;
  }

  function showStageMediaType(type) {
    els.tvVideo.style.display = type === 'video' ? 'block' : 'none';
    els.tvMirrorVideo.style.display = type === 'mirror' ? 'block' : 'none';
    els.tvImage.style.display = type === 'image' ? 'block' : 'none';
    els.audioStage.style.display = type === 'audio' ? 'flex' : 'none';

    const showSeek = (type === 'video' || type === 'audio') && !currentState?.metadata?.isLive;
    els.seekRow.style.display = showSeek ? 'flex' : 'none';
  }

  function updateVideoResolution() {
    const type = currentState?.mediaType;
    const target = type === 'mirror' ? els.tvMirrorVideo : els.tvVideo;
    els.videoResolution.textContent = type === 'image' ? '图片内容' : type === 'audio' ? '音频内容'
      : target.videoWidth && target.videoHeight ? `${target.videoWidth} × ${target.videoHeight}` : '等待视频数据';
  }

  function attachVideoOrAudioStream(rawUrl, mode, resumePosition = 0) {
    destroyMediaEngines();
    if(isServerRemux(rawUrl)){mode='transcode';activeStreamMode='transcode';}
    transcodeBase = mode === 'transcode' ? Math.max(0, resumePosition) : 0;
    window.MobileTVSubtitles?.setTimeline(transcodeBase);
    let resolvedUrl = resolvePlaybackUrl(rawUrl, mode);
    if(mode==='transcode'){remuxRequestId=(window.crypto?.randomUUID?.()||'mt_'+Date.now().toString(36))+'_'+(++remuxRequestSerial);const value=new URL(resolvedUrl,location.href);value.searchParams.set('requestId',remuxRequestId);resolvedUrl=value.pathname+value.search;}
    if(mode==='transcode'&&(currentState?.audioTrack!=null||currentState?.burnSubtitle!=null)){const value=new URL(resolvedUrl,location.href);if(currentState.audioTrack!=null)value.searchParams.set('audioTrack',currentState.audioTrack);if(currentState.burnSubtitle!=null)value.searchParams.set('burnSubtitle',currentState.burnSubtitle);resolvedUrl=value.pathname+value.search;}
    if (transcodeBase > 0) {const value=new URL(resolvedUrl,location.href);value.searchParams.set('start',String(transcodeBase));resolvedUrl=value.pathname+value.search;}
    const cleanPath = rawUrl.split('?')[0].toLowerCase();
    const video = els.tvVideo;

    els.bufferingPill.textContent = '正在加载内容…';
    els.bufferingPill.classList.add('show');

    const mime = currentState?.metadata?.mimeType || '';
    const isHls = /mpegurl/i.test(mime) || cleanPath.endsWith('.m3u8') || cleanPath.endsWith('.m3u');
    const isFlv = /x-flv/i.test(mime) || cleanPath.endsWith('.flv');
    const isTs = /mp2t|mpegts/i.test(mime) || cleanPath.endsWith('.ts');

    if (mode !== 'transcode' && isHls && window.Hls && window.Hls.isSupported()) {
      hlsPlayer = new window.Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 30,
        maxBufferLength: 60,
        maxMaxBufferLength: 90,
        maxBufferSize: 64 * 1024 * 1024,
        fragLoadPolicy: { default: {
          maxTimeToFirstByteMs: 15000,
          maxLoadTimeMs: 60000,
          timeoutRetry: { maxNumRetry: 3, retryDelayMs: 500, maxRetryDelayMs: 4000, backoff: 'exponential' },
          errorRetry: { maxNumRetry: 4, retryDelayMs: 500, maxRetryDelayMs: 4000, backoff: 'exponential' },
        } },
        manifestLoadPolicy: { default: {
          maxTimeToFirstByteMs: 15000,
          maxLoadTimeMs: 20000,
          timeoutRetry: { maxNumRetry: 2, retryDelayMs: 500, maxRetryDelayMs: 2000 },
          errorRetry: { maxNumRetry: 2, retryDelayMs: 500, maxRetryDelayMs: 2000 },
        } },
      });
      const engine = hlsPlayer;
      let networkRecoveries = 0, mediaRecoveries = 0;
      hlsPlayer.loadSource(resolvedUrl);
      hlsPlayer.attachMedia(video);
      hlsPlayer.on(window.Hls.Events.MANIFEST_PARSED, () => {
        if (hlsPlayer !== engine) return;
        if (currentState?.status === 'PLAYING') {
          safePlay(video);
        }
      });
      hlsPlayer.on(window.Hls.Events.LEVEL_LOADED, (_, data) => {
        if (hlsPlayer !== engine) return;
        // A live playlist has a moving window; do not impose a VOD-sized delay.
        const live = Boolean(data?.details?.live);
        engine.config.maxBufferLength = live ? 20 : 60;
        engine.config.maxMaxBufferLength = live ? 30 : 90;
        engine.config.backBufferLength = live ? 15 : 30;
      });
      hlsPlayer.on(window.Hls.Events.ERROR, (_, data) => {
        if (hlsPlayer !== engine || !data?.fatal) return;
        if (data.type === window.Hls.ErrorTypes?.NETWORK_ERROR && networkRecoveries++ < 1) {
          els.bufferingPill.textContent = '网络波动，正在重试…';
          hlsRecoveryTimer = setTimeout(() => {
            hlsRecoveryTimer = null;
            if (hlsPlayer === engine) engine.startLoad(Number(video.currentTime) || -1);
          }, 1500);
          return;
        }
        if (data.type === window.Hls.ErrorTypes?.MEDIA_ERROR && video.error && mediaRecoveries++ < 1) {
          engine.recoverMediaError();
          return;
        }
        handlePlaybackFailure(rawUrl);
      });
      return;
    }

    if (mode !== 'transcode' && (isFlv || isTs) && window.mpegts && window.mpegts.isSupported()) {
      mpegtsPlayer = window.mpegts.createPlayer(
        {
          type: isFlv ? 'flv' : 'mpegts',
          url: resolvedUrl,
          isLive: Boolean(currentState?.metadata?.isLive),
        },
        {
          enableWorker: true,
          enableStashBuffer: true,
          stashInitialSize: 384 * 1024,
          lazyLoad: true,
          lazyLoadMaxDuration: 90,
          lazyLoadRecoverDuration: 30,
          autoCleanupSourceBuffer: true,
          autoCleanupMaxBackwardDuration: 60,
          autoCleanupMinBackwardDuration: 30,
        }
      );
      mpegtsPlayer.attachMediaElement(video);
      const engine = mpegtsPlayer;
      mpegtsPlayer.load();
      if (currentState?.status === 'PLAYING') {
        safePlay(video);
      }
      mpegtsPlayer.on(window.mpegts.Events.ERROR, () => {
        if (mpegtsPlayer === engine) handlePlaybackFailure(rawUrl);
      });
      return;
    }

    video.src = resolvedUrl;
    video.load();
    if (currentState?.status === 'PLAYING') {
      startNativePlayback(video);
    }
  }

  function handlePlaybackFailure(rawUrl, resumePosition = playbackPosition()) {
    if (!currentState || currentState.status === 'IDLE' || currentState.mediaType === 'mirror') return;

    const position = Math.max(0, Number(resumePosition) || 0);
    streamDuration = playbackDuration();
    pendingStartPos = position;
    pendingStartUnit = 'seconds';
    if (fallbackStage === 0 && !isSameOriginStreamUrl(rawUrl) && activeStreamMode === 'direct') {
      fallbackStage = 1;
      activeStreamMode = 'proxy';
      els.selectStreamMode.value = 'proxy';
      attachVideoOrAudioStream(rawUrl, 'proxy', position);
      return;
    }
    if (fallbackStage < 2 && activeStreamMode !== 'transcode') {
      fallbackStage = 2;
      activeStreamMode = 'transcode';
      els.selectStreamMode.value = 'transcode';
      attachVideoOrAudioStream(rawUrl, 'transcode', position);
      return;
    }
    els.bufferingPill.textContent = '流媒体加载失败，可尝试切换传输模式或重新投屏';
  }

  function applyState(snap) {
    const prev = currentState;
    currentState = snap;
    window.MobileTVSkips?.setState(snap);
    window.MobileTVDanmaku?.update(snap);
    updateProtocolBadges(snap.protocols);

    const isActive = snap.status && snap.status !== 'IDLE' && snap.status !== 'STOPPED';
    window.MobileTVSubtitles?.setState(snap);
    window.MobileTVTracks?.setState(snap);
    document.body.classList.toggle('casting-active', Boolean(isActive));
    window.MobileTVUI?.updateTitle?.({ media: isActive ? snap.metadata?.title || '正在播放' : '' });
    els.playerStage.classList.toggle('is-live', Boolean(isActive && snap.metadata?.isLive));

    if (!isActive) {
      destroyMediaEngines();
      closePeerConnection();
      activeSessionId = -1;
      activeUrl = '';
      els.bufferingPill.classList.remove('show');
      return;
    }

    els.hudTitle.textContent = snap.metadata?.title || '正在投屏';
    els.hudTitle.title = els.hudTitle.textContent;
    const protocolName=snap.protocol==='BilibiliCast'?'B站专用投屏':snap.protocol;
    els.hudSubtitle.textContent = `${protocolName || 'Cast'} · ${snap.clientName || snap.clientIp || '局域网设备'}`;
    els.metricProto.textContent = protocolName || 'CAST';
    if (els.btnStopCast.firstChild?.nodeType === 3) els.btnStopCast.firstChild.nodeValue = ['Library', 'Live'].includes(snap.protocol) ? '返回列表' : '结束投屏';
    els.btnPlayPause.textContent = snap.status === 'PLAYING' ? '暂停' : '播放';
    els.selectStreamMode.value = activeStreamMode;
    els.selectRate.value = String(snap.playbackRate || 1);
    window.MobileTVPlaybackControls?.setRate(snap.playbackRate||1);
    els.volumeSlider.value = String(snap.volume ?? 80);
    els.btnMute.textContent = snap.muted ? '取消静音' : '静音';

    els.tvVideo.volume = Math.max(0, Math.min(1, (snap.volume ?? 80) / 100));
    els.tvVideo.muted = autoplayMutedFallback ? true : Boolean(snap.muted);
    els.tvVideo.playbackRate = snap.playbackRate || 1;

    const mediaChanged = snap.sessionId !== activeSessionId || snap.url !== activeUrl;
    if(!mediaChanged&&Number(snap.metadata?.duration)>0){streamDuration=Number(snap.metadata.duration);els.seekSlider.max=streamDuration;els.lblDuration.textContent=formatSec(streamDuration);}
    const sessionChanged = mediaChanged || (snap.streamMode || 'auto') !== requestedStreamMode || (snap.audioTrack??null)!==activeAudioTrack || (snap.burnSubtitle??null)!==activeBurnSubtitle;
    if (sessionChanged) {
      const joiningPlayback = !prev && Number(snap.position) > 1 && Number(snap.duration) > 0 && !snap.metadata?.isLive;
      const queuedPosition = pendingStartPos > 0 ? pendingStartUnit !== 'seconds' && pendingStartPos <= 1 && playbackDuration() > 1 ? pendingStartPos * playbackDuration() : pendingStartPos : playbackPosition();
      const position = mediaChanged ? joiningPlayback ? Number(snap.position) : Number(snap.startPosition) || 0 : queuedPosition;
      streamDuration = mediaChanged ? Number(snap.metadata?.duration) || Number(snap.duration) || 0 : playbackDuration();
      activeSessionId = snap.sessionId;
      activeUrl = snap.url;
      activeStreamMode = snap.streamMode || 'auto';
      requestedStreamMode = activeStreamMode;
      activeAudioTrack=snap.audioTrack??null;activeBurnSubtitle=snap.burnSubtitle??null;
      els.selectStreamMode.value = activeStreamMode;
      pendingStartPos = position;
      pendingStartUnit = mediaChanged && !joiningPlayback ? snap.startPositionUnit || 'auto' : 'seconds';
      fallbackStage = 0;
      if (!document.querySelector?.('dialog[open]') && !els.logDrawer.classList.contains('open')) {
        els.playerStage.focus({ preventScroll: true });
      }

      showStageMediaType(snap.mediaType);
      updateVideoResolution();

      if (snap.mediaType === 'image') {
        destroyMediaEngines();
        els.bufferingPill.classList.remove('show');
        els.tvImage.src = resolvePlaybackUrl(snap.url, activeStreamMode);
      } else if (snap.mediaType === 'mirror') {
        destroyMediaEngines();
        els.bufferingPill.classList.remove('show');
      } else {
        els.audioTitle.textContent = snap.metadata?.title || '音频投屏';
        els.audioArtist.textContent = snap.metadata?.artist || snap.clientName || '';
        attachVideoOrAudioStream(snap.url, activeStreamMode, pendingStartUnit === 'seconds' ? position : 0);
      }
    } else if (prev && prev.status !== snap.status) {
      if (snap.mediaType === 'video' || snap.mediaType === 'audio') {
        if (snap.status === 'PLAYING') {
          startNativePlayback(els.tvVideo);
        } else if (snap.status === 'PAUSED') {
          els.tvVideo.pause();
        }
      }
    }

    applyMediaTransform();
    wakeHud();
  }

  function updateProtocolBadges(protos) {
    if (!protos) return;
    if (protos.dlna) {
      els.dotDlna.className = `dot ${protos.dlna.active ? (protos.dlna.ssdpBound ? 'online' : 'warn') : ''}`;
      els.lblDlna.textContent = protos.dlna.active
        ? `DLNA ${protos.dlna.ssdpBound ? '就绪' : '发现受限'}`
        : 'DLNA 离线';
    }
    if (protos.airplay) {
      els.dotAirplay.className = `dot ${protos.airplay.active ? 'online' : ''}`;
      els.lblAirplay.textContent = protos.airplay.active
        ? 'AirPlay 就绪'
        : 'AirPlay 离线';
    }
    if (protos.websocket) {
      const mobileCount = protos.websocket.mobileClients || 0;
      els.clientCountChip.textContent = mobileCount ? `${mobileCount} 台手机已连接` : '等待手机连接';
    }
    if (protos.tvbox) {
      els.dotTvbox.className = `dot ${protos.tvbox.active ? 'online' : protos.tvbox.lastError ? 'warn' : ''}`;
      els.lblTvbox.textContent = protos.tvbox.active ? '影视 就绪' : '影视 离线';
    }
  }

  function updateDeviceUi(info) {
    if (!info) return;
    const { identity, primaryIp, interfaces, mobileUrl, qrDataUrl, history } = info;
    if (identity) {
      els.headerDeviceName.textContent = identity.deviceName;
      els.receiverName.textContent = identity.deviceName;
      els.deviceNameInput.value = identity.deviceName;
      els.guideNameAndroid.textContent = identity.deviceName;
      els.guideNameApple.textContent = identity.deviceName;
    }
    if (primaryIp) {
      els.guideIpAndroid.textContent = primaryIp;
    }
    if (Array.isArray(interfaces)) {
      els.ipSelect.innerHTML = '';
      for (const iface of interfaces) {
        const opt = document.createElement('option');
        opt.value = iface.address;
        opt.textContent = `${iface.address} (${iface.name})`;
        if (iface.address === primaryIp) opt.selected = true;
        els.ipSelect.appendChild(opt);
      }
    }
    if (mobileUrl) els.mobileUrlText.textContent = mobileUrl;
    if (qrDataUrl) els.qrImg.src = qrDataUrl;
    if (Array.isArray(history)) renderHistory(history);
  }

  function renderHistory(items) {
    els.historyCountChip.textContent = `${items.length} 条记录`;
    if (!items.length) {
      els.historyList.innerHTML =
        '<div class="empty-state"><svg class="icon"><use href="/icons.svg#clock" /></svg><p>还没有播放记录</p><span>你的下一次大屏体验，从这里开始。</span></div>';
      return;
    }
    els.historyList.innerHTML = '';
    for (const item of items) {
      const div = document.createElement('button');
      div.type = 'button';
      div.className = 'history-item';
      div.title = `重新播放：${item.title || item.url}`;
      div.innerHTML = `
        <span class="history-symbol"><svg class="icon"><use href="/icons.svg#play" /></svg></span>
        <div style="min-width:0; flex:1;">
          <div class="history-title">${escapeHtml(item.title || item.url)}</div>
          <div class="history-meta">${escapeHtml(item.protocol || '投屏')} · ${new Date(item.timestamp).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</div>
        </div>
        <span class="chip">重新播放</span>
      `;
      div.addEventListener('click', () => {
        postControl({ action: 'cast', url: item.url, title: item.title, mediaType: item.mediaType });
      });
      els.historyList.appendChild(div);
    }
  }

  function prependLog(entry, append = false) {
    if (!entry) return;
    const div = document.createElement('div');
    div.className = 'log-entry';
    div.innerHTML = `
      <div class="log-meta">[${escapeHtml(entry.time)}] ${escapeHtml(entry.protocol)}</div>
      <div>${escapeHtml(entry.message)}</div>
    `;
    if (append) {
      els.logBody.appendChild(div);
    } else {
      els.logBody.prepend(div);
    }
    while (els.logBody.children.length > 100) {
      els.logBody.removeChild(els.logBody.lastElementChild);
    }
  }

  function escapeHtml(str) {
    return String(str ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  async function refreshStatus() {
    try {
      const res = await fetch('/api/status');
      const data = await res.json();
      updateDeviceUi(data);
      if (data.state) applyState(data.state);
      if (Array.isArray(data.logs)) {
        els.logBody.innerHTML = '';
        data.logs.forEach((l) => prependLog(l, true));
      }
    } catch {}
  }

  async function postControl(payload) {
    payload = { ...payload, sessionId: currentState?.sessionId };
    if (ws && ws.readyState === WebSocket.OPEN && payload.action !== 'cast') {
      ws.send(JSON.stringify({ type: 'control', data: payload }));
      return;
    }
    try {
      const response = await fetch('/api/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      if (!response.ok) window.MobileTVUI?.toast('操作未成功，请检查连接后重试');
    } catch { window.MobileTVUI?.toast('连接已断开，正在尝试重新连接'); }
  }

  function sendTelemetry(force = false) {
    if (!ws || ws.readyState !== WebSocket.OPEN || !currentState) return;
    const now = performance.now();
    if (!force && now - lastTelemetrySentMs < 500) return;
    lastTelemetrySentMs = now;

    const v = els.tvVideo;
    ws.send(
      JSON.stringify({
        type: 'player-telemetry',
        data: {
          sessionId: activeSessionId,
          position: playbackPosition(),
          duration: playbackDuration(),
          videoWidth: v.readyState >= 1 ? v.videoWidth || 0 : 0,
          videoHeight: v.readyState >= 1 ? v.videoHeight || 0 : 0,
          // Loading metadata can report paused before autoplay completes.
          status: v.ended ? 'PAUSED' : v.paused ? undefined : 'PLAYING',
          ended:Boolean(v.ended),
        },
      })
    );
  }

  function connectWs() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}/ws?role=tv`);

    ws.onopen = () => {
      els.dotWs.className = 'dot online';
      els.lblWs.textContent = '接收端在线';
    };

    ws.onclose = () => {
      els.dotWs.className = 'dot warn';
      els.lblWs.textContent = '正在重新连接';
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
        updateDeviceUi(msg.data);
        if (msg.data?.state) applyState(msg.data.state);
        if (Array.isArray(msg.data?.logs)) {
          els.logBody.innerHTML = '';
          msg.data.logs.forEach((l) => prependLog(l, true));
        }
      } else if (msg.type === 'state') {
        applyState(msg.data);
        if (msg.data?.status === 'IDLE') refreshStatus();
      } else if (msg.type === 'progress' && msg.data?.sessionId === activeSessionId && els.metricBuffer) {
        const buffer = msg.data.originalBuffer;
        els.metricBuffer.hidden = !buffer?.active;
        if (buffer?.active) {
          const text = `原文件缓存 · ${buffer.profile} · ${(buffer.bytes / 1048576).toFixed(0)} / ${(buffer.maxBytes / 1048576).toFixed(0)} MB`;
          if (els.metricBuffer.textContent !== text) els.metricBuffer.textContent = text;
          const continuous = Number(buffer.contiguousAheadBytes) || 0;
          els.metricBuffer.title = `当前读取位置起连续缓存 ${(continuous / 1048576).toFixed(1)} MB` + (buffer.estimatedAheadSeconds > 0 ? `，按平均码率约 ${Math.floor(buffer.estimatedAheadSeconds)} 秒` : '') + (buffer.targetSeconds ? `；目标约 ${buffer.targetSeconds} 秒，受容量上限约束` : '；正在识别视频分辨率');
        }
        const remux = msg.data.remuxBuffer;
        const stream=remux?.buffers?.find(item=>item.requestId===remuxRequestId);
        if(stream&&Math.abs(Number(stream.start)-transcodeBase)<.01)preparedRanges=(stream.ranges||[]).filter(r=>Array.isArray(r)&&r.length===2&&Number.isFinite(r[0])&&Number.isFinite(r[1])&&r[1]>r[0]).map(([a,b])=>[a+transcodeBase,b+transcodeBase]);
        else preparedRanges=[];
        updateSeekBuffer();
        if (els.metricRemux) {
          els.metricRemux.hidden = !remux?.active;
          if (remux?.active) {
            els.metricRemux.textContent = `封装后缓存 · ${(remux.bytes / 1048576).toFixed(1)} / ${(remux.maxBytes / 1048576).toFixed(0)} MB`;
            els.metricRemux.title = '已经完成兼容封装、等待播放器读取的数据；与原文件缓存及浏览器可播放秒数分别统计。';
          }
        }
      } else if (msg.type === 'command' && msg.data?.type === 'seek') {
        if (Number.isFinite(msg.data.position)) {
          seekPlayback(msg.data.position);
        }
      } else if(msg.type==='command'&&msg.data?.type==='danmaku'){
        if(msg.data.sessionId===activeSessionId)window.MobileTVDanmaku?.push(msg.data);
      } else if(msg.type==='command'&&msg.data?.type==='notice'){
        if(msg.data.sessionId===activeSessionId)window.MobileTVUI?.toast(msg.data.message);
      } else if (msg.type === 'protocols') {
        updateProtocolBadges(msg.data);
      } else if (msg.type === 'deviceInfo') {
        updateDeviceUi(msg.data);
      } else if (msg.type === 'log') {
        prependLog(msg.data, false);
      } else if (msg.type === 'webrtc-offer') {
        await handleWebRtcOffer(msg);
      } else if (msg.type === 'webrtc-ice' && peerConn && msg.candidate) {
        try {
          await peerConn.addIceCandidate(msg.candidate);
        } catch {}
      } else if (msg.type === 'webrtc-stop') {
        closePeerConnection();
      }
    };
  }

  async function handleWebRtcOffer(msg) {
    closePeerConnection();
    peerConn = new RTCPeerConnection({ iceServers: [] });
    peerConn.ontrack = (e) => {
      if (e.streams && e.streams[0]) {
        els.tvMirrorVideo.srcObject = e.streams[0];
        els.tvMirrorVideo.play().catch(() => {});
      }
    };
    peerConn.onicecandidate = (e) => {
      if (e.candidate && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'webrtc-ice', candidate: e.candidate }));
      }
    };
    await peerConn.setRemoteDescription(msg.offer);
    const answer = await peerConn.createAnswer();
    await peerConn.setLocalDescription(answer);
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ type: 'webrtc-answer', answer }));
    }
  }

  function wakeHud() {
    els.playerStage.classList.remove('hud-hidden');
    if (hudTimer) clearTimeout(hudTimer);
    if (currentState && currentState.status === 'PLAYING') {
      hudTimer = setTimeout(() => {
        els.playerStage.classList.add('hud-hidden');
      }, 3000);
    }
  }

  function toggleFullscreen() {
    if (!document.fullscreenElement) {
      document.documentElement.requestFullscreen?.().catch(() => {});
    } else {
      document.exitFullscreen?.().catch(() => {});
    }
  }

  // Video element events
  els.tvVideo.addEventListener('loadedmetadata', () => {
    updateSeekBuffer();
    // MKV may expose metadata and decoded frames while its audio clock remains
    // stalled. Keep its known duration, then remux to MP4 with video copy and
    // compatible audio rather than trusting native MKV playback readiness.
    if (currentState?.mediaType === 'video' && /matroska/i.test(currentState?.metadata?.mimeType || '') && activeStreamMode !== 'transcode') {
      const duration = playbackDuration();
      const position = pendingStartPos > 0
        ? pendingStartUnit !== 'seconds' && pendingStartPos <= 1 && duration > 1
          ? pendingStartPos * duration : pendingStartPos
        : playbackPosition();
      handlePlaybackFailure(activeUrl, position);
      return;
    }
    updateVideoResolution();
    if (!autoplayMutedFallback && originalBufferTimer === null) els.bufferingPill.classList.remove('show');
    const dur = playbackDuration();
    if (pendingStartPos > 0 && Number.isFinite(dur) && dur > 0) {
      const position = pendingStartUnit !== 'seconds' && pendingStartPos <= 1 && dur > 1
        ? pendingStartPos * dur : pendingStartPos;
      if (activeStreamMode !== 'transcode') seekPlayback(position);
      pendingStartPos = 0;
    }
    if (Number.isFinite(dur) && dur > 0) {
      els.seekSlider.max = dur;
      els.lblDuration.textContent = formatSec(dur);
    }
    if (currentState?.mediaType === 'video' && /matroska/i.test(currentState?.metadata?.mimeType || '') && !els.tvVideo.videoWidth && activeStreamMode === 'transcode') {
      reportVideoDecoderFailure(els.tvVideo);
      return;
    }
    sendTelemetry(true);
  });

  els.tvVideo.addEventListener('waiting', () => {
    if (!autoplayMutedFallback) {
      els.bufferingPill.textContent = '正在缓冲...';
      els.bufferingPill.classList.add('show');
    }
  });

  els.tvVideo.addEventListener('playing', () => {
    if (!autoplayMutedFallback) els.bufferingPill.classList.remove('show');
    sendTelemetry(true);
  });

  els.tvVideo.addEventListener('resize', updateVideoResolution);
  els.tvMirrorVideo.addEventListener('resize', updateVideoResolution);

  els.tvVideo.addEventListener('timeupdate', () => {
    if (!isUserSeeking && Number.isFinite(els.tvVideo.currentTime)) {
      els.seekSlider.value = playbackPosition();
      els.lblCurrentTime.textContent = formatSec(playbackPosition());
    }
    sendTelemetry(false);
    updateSeekBuffer();
  });

  function updateSeekBuffer() {
    const duration = playbackDuration(), video = els.tvVideo;
    if (!(Number.isFinite(duration) && duration > 0) || !activeUrl || currentState?.metadata?.isLive) { els.seekBuffered.style.background = 'none'; els.seekPlayed.style.width = '0%'; return; }
    const percent = value => Number(Math.min(100, Math.max(0, value / duration * 100)).toFixed(4));
    const gradients = []; let ahead = 0;
    // Each TimeRange is independent: seeking can leave several buffered islands.
    for (let i = 0; i < Math.min(video.buffered?.length || 0, 128); i++) {
      const start = video.buffered.start(i), end = video.buffered.end(i);
      if (start <= video.currentTime + .1 && end >= video.currentTime) ahead = Math.max(ahead, end - video.currentTime);
      const left = percent(start + transcodeBase), right = percent(end + transcodeBase);
      if (right > left) gradients.push(`linear-gradient(to right, transparent ${left}%, #a2b7bc ${left}%, #a2b7bc ${right}%, transparent ${right}%)`);
    }
    for(const [start,end]of preparedRanges){const left=percent(Math.max(start,playbackPosition())),right=percent(end);if(right>left)gradients.push(`linear-gradient(to right, transparent ${left}%, #557e78 ${left}%, #557e78 ${right}%, transparent ${right}%)`);}
    const background = gradients.join(',') || 'none'; if (els.seekBuffered.style.background !== background) els.seekBuffered.style.background = background;
    els.seekPlayed.style.width = percent(isUserSeeking ? Number(els.seekSlider.value) : playbackPosition()) + '%';
    const local=playableAhead();
    els.seekTrack.title = `本机可连续播放约 ${Math.floor(local)} 秒（播放器内 ${ahead.toFixed(1)} 秒）· 浅灰为播放器缓冲，灰绿色为已完成预读，绿色为已播放；跳转可能需要重新准备画面`;
  }
  function playableAhead() {
    const position=playbackPosition(),video=els.tvVideo,ranges=[...preparedRanges];
    for(let i=0;i<Math.min(video.buffered?.length||0,128);i++)ranges.push([video.buffered.start(i)+transcodeBase,video.buffered.end(i)+transcodeBase]);
    ranges.sort((a,b)=>a[0]-b[0]);let end=position;
    for(const [from,to]of ranges){if(to<=end)continue;if(from>end+.25)break;end=Math.max(end,to);}
    const duration=playbackDuration();if(duration>0)end=Math.min(end,duration);
    return Math.max(0,end-position);
  }
  for (const event of ['progress', 'durationchange', 'seeked', 'emptied']) els.tvVideo.addEventListener(event, updateSeekBuffer);

  els.tvVideo.addEventListener('ended', () => {
    if(activeStreamMode==='transcode'&&!streamDuration&&Number.isFinite(els.tvVideo.duration))streamDuration=els.tvVideo.duration+transcodeBase;
    sendTelemetry(true);
    if(currentState?.protocol!=='BilibiliCast')postControl({ action: 'pause' });
  });

  els.tvVideo.addEventListener('error', () => {
    if (activeUrl && !hlsPlayer && !mpegtsPlayer) handlePlaybackFailure(activeUrl);
  });

  // Periodic 1s FPS & buffer telemetry for smoothness verification
  setInterval(() => {
    if (!currentState || currentState.status !== 'PLAYING' || currentState.mediaType !== 'video') return;
    const v = els.tvVideo;
    const now = performance.now();
    const dt = Math.max(0.1, (now - lastFrameTs) / 1000);
    let fpsText = '--';
    let dropText = '';
    if (typeof v.getVideoPlaybackQuality === 'function') {
      const q = v.getVideoPlaybackQuality();
      const frames = Math.max(0, q.totalVideoFrames - lastFrameCount);
      const dropped = Math.max(0, q.droppedVideoFrames - lastDroppedCount);
      const fps = Math.round(Math.max(0, frames - dropped) / dt);
      lastFrameCount = q.totalVideoFrames;
      lastDroppedCount = q.droppedVideoFrames;
      fpsText = String(Math.max(0, fps));
      dropText = ` | 丢帧:${frames ? Math.round(dropped * 100 / frames) : 0}%`;
    }
    lastFrameTs = now;

    let bufAhead = 0;
    if (v.buffered && v.buffered.length > 0) {
      for (let i = 0; i < v.buffered.length; i++) {
        if (v.buffered.start(i) <= v.currentTime && v.buffered.end(i) >= v.currentTime) {
          bufAhead = v.buffered.end(i) - v.currentTime;
          break;
        }
      }
    }
    els.metricPerf.textContent = `FPS: ${fpsText}${dropText} | 本机可播: ${playableAhead().toFixed(1)}s`;
    els.metricPerf.title = `播放器内部 ${bufAhead.toFixed(1)} 秒；本机可播按完整媒体片段的音视频时间计算，不按缓存字节猜测秒数。`;
  }, 1000);

  // UI Event Listeners
  els.btnSaveName.addEventListener('click', async () => {
    const name = els.deviceNameInput.value.trim();
    if (!name) return;
    const res = await fetch('/api/device/name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name }),
    });
    if (res.ok) {
      updateDeviceUi(await res.json());
      window.MobileTVUI?.toast('大屏名称已保存');
    }
  });

  els.ipSelect.addEventListener('change', async () => {
    const res = await fetch('/api/device/ip', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ip: els.ipSelect.value }),
    });
    if (res.ok) updateDeviceUi(await res.json());
  });

  els.btnQuickCast.addEventListener('click', () => {
    const url = els.quickUrlInput.value.trim();
    if (!url) {
      els.quickUrlInput.focus();
      window.MobileTVUI?.toast('请先粘贴媒体链接');
      return;
    }
    if (!/^https?:\/\//i.test(url)) {
      window.MobileTVUI?.toast('请输入以 http:// 或 https:// 开头的媒体链接');
      return;
    }
    postControl({ action: 'cast', url });
  });

  els.btnTestDlna.addEventListener('click', () => {
    fetch('/api/cast/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'dlna-sim' }),
    });
  });

  els.btnTestAirplay.addEventListener('click', () => {
    fetch('/api/cast/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ mode: 'airplay-sim' }),
    });
  });

  els.btnMiracast.addEventListener('click', async () => {
    const res = await fetch('/api/system/miracast', { method: 'POST' });
    if (!res.ok) alert('当前系统不支持一键打开无线投影设置，请在系统设置中开启“投影到此电脑”。');
  });

  els.btnStopCast.addEventListener('click', () => postControl({ action: 'stop' }));
  els.btnPlayPause.addEventListener('click', () => {
    postControl({ action: currentState?.status === 'PLAYING' ? 'pause' : 'play' });
  });
  els.btnRewind15.addEventListener('click', () => {
    postControl({ action: 'seek', position: Math.max(0, playbackPosition() - 15) });
  });
  els.btnForward15.addEventListener('click', () => {
    postControl({ action: 'seek', position: playbackPosition() + 15 });
  });

  els.seekSlider.addEventListener('input', () => {
    isUserSeeking = true;
    els.lblCurrentTime.textContent = formatSec(els.seekSlider.value);
    updateSeekBuffer();
  });
  els.seekSlider.addEventListener('change', () => {
    isUserSeeking = false;
    postControl({ action: 'seek', position: Number(els.seekSlider.value) });
  });

  els.volumeSlider.addEventListener('input', () => {
    postControl({ action: 'volume', volume: Number(els.volumeSlider.value) });
  });
  els.btnMute.addEventListener('click', () => {
    postControl({ action: 'mute', muted: !currentState?.muted });
  });
  els.selectRate.addEventListener('change', () => {
    postControl({ action: 'display', playbackRate: Number(els.selectRate.value) });
  });
  els.selectStreamMode.addEventListener('change', () => {
    postControl({ action: 'display', streamMode: els.selectStreamMode.value });
  });
  document.addEventListener('mobiletv-adfilter-change', () => {
    if (!currentState?.url || !['video','audio'].includes(currentState.mediaType) || ['IDLE','STOPPED'].includes(currentState.status)) return;
    if (activeStreamMode === 'transcode') { window.MobileTVUI?.toast('过滤规则已保存，切换到自动连接后生效'); return; }
    if (activeStreamMode === 'direct') { postControl({ action: 'display', streamMode: 'proxy' }); return; }
    pendingStartPos = playbackPosition(); pendingStartUnit = 'seconds'; fallbackStage = 0;
    attachVideoOrAudioStream(currentState.url, activeStreamMode, pendingStartPos);
  });
  els.btnRotate.addEventListener('click', () => {
    const next = ((currentState?.rotation || 0) + 90) % 360;
    postControl({ action: 'display', rotation: next });
  });
  els.btnFitMode.addEventListener('click', () => {
    const order = ['contain', 'cover', 'fill'];
    const cur = order.indexOf(currentState?.fitMode || 'contain');
    postControl({ action: 'display', fitMode: order[(cur + 1) % order.length] });
  });

  els.btnSnapshot.addEventListener('click', () => {
    const target = currentState?.mediaType === 'mirror' ? els.tvMirrorVideo : els.tvVideo;
    if (!target.videoWidth) return;
    const canvas = document.createElement('canvas');
    canvas.width = target.videoWidth;
    canvas.height = target.videoHeight;
    const ctx = canvas.getContext('2d');
    ctx.drawImage(target, 0, 0);
    const link = document.createElement('a');
    link.download = `MobileTvScreen-${Date.now()}.png`;
    link.href = canvas.toDataURL('image/png');
    link.click();
  });

  els.btnPip.addEventListener('click', () => {
    if (document.pictureInPictureElement) {
      document.exitPictureInPicture?.();
    } else {
      els.tvVideo.requestPictureInPicture?.().catch(() => {});
    }
  });

  els.btnFullscreen.addEventListener('click', toggleFullscreen);
  els.btnStandbyFullscreen.addEventListener('click', toggleFullscreen);

  document.addEventListener('keydown', (event) => {
    if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey || event.isComposing) return;
    if (/^(INPUT|TEXTAREA|SELECT)$/.test(event.target?.tagName || '') || event.target?.isContentEditable) return;
    if (document.querySelector?.('dialog[open]') || els.logDrawer.classList.contains('open')) return;
    if (event.target?.closest?.('.live-channel-drawer')) return;
    const key = event.key.toLowerCase();
    if (key === 'f') {
      event.preventDefault();
      if (!event.repeat) toggleFullscreen();
      return;
    }
    if (!currentState || !['PLAYING', 'PAUSED', 'LOADING'].includes(currentState.status)) return;
    if (key === 's') {
      event.preventDefault(); if (!event.repeat && currentState.mediaType === 'video') window.MobileTVSubtitles?.open();
    } else if (key === ' ' || key === 'k') {
      // Space retains native activation for focused controls.
      if (key === ' ' && event.target?.closest?.('button, summary, a[href]')) return;
      event.preventDefault();
      if (!event.repeat && ['video', 'audio'].includes(currentState.mediaType)) {
        postControl({ action: currentState.status === 'PLAYING' ? 'pause' : 'play' });
      }
    } else if (key === 'arrowleft' || key === 'arrowright') {
      if (!['video', 'audio'].includes(currentState.mediaType)) return;
      event.preventDefault();
      const position = Math.max(0, playbackPosition() + (key === 'arrowright' ? 10 : -10));
      const duration = playbackDuration();
      postControl({ action: 'seek', position: duration > 0 ? Math.min(position, duration) : position });
    } else if (key === 'arrowup' || key === 'arrowdown') {
      event.preventDefault();
      const volume = Math.max(0, Math.min(100, (Number(currentState.volume) || 0) + (key === 'arrowup' ? 5 : -5)));
      postControl({ action: 'volume', volume });
      window.MobileTVUI?.toast(`音量 ${volume}%`);
    } else if (key === 'm') {
      event.preventDefault();
      if (!event.repeat) postControl({ action: 'mute', muted: !currentState.muted });
    } else return;
    wakeHud();
  });

  els.playerStage.addEventListener('mousemove', wakeHud);
  els.playerStage.addEventListener('touchstart', wakeHud, { passive: true });
  els.mediaViewport.addEventListener('click', (event) => {
    if (event.target !== els.bufferingPill) els.playerStage.focus({ preventScroll: true });
  });
  window.addEventListener('resize', applyMediaTransform);

  // Initialize
  refreshStatus();
  connectWs();
})();
