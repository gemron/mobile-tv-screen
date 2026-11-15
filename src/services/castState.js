const EventEmitter = require('events');
const { performance } = require('perf_hooks');

const MAX_LOGS = 100;
const MAX_HISTORY = 20;
const PROGRESS_BROADCAST_INTERVAL_MS = 500;

/**
 * Centralized, zero-blocking state store for all casting protocols (DLNA, AirPlay, WebCast, WebRTC).
 * Uses monotonic clock (performance.now) interpolation so high-frequency phone polling
 * (GetPositionInfo / /scrub) resolves in O(1) without blocking on frontend round-trips.
 */
class CastStateService extends EventEmitter {
  constructor() {
    super();
    this.setMaxListeners(64);

    this.state = {
      status: 'IDLE', // IDLE | LOADING | PLAYING | PAUSED | STOPPED
      protocol: null, // 'DLNA' | 'AirPlay' | 'WebCast' | 'WebRTC'
      mediaType: 'video', // 'video' | 'audio' | 'image' | 'mirror'
      url: '',
      metadata: {
        title: '',
        artist: '',
        album: '',
        artwork: '',
        mimeType: '',
      },
      clientIp: '',
      clientName: '',
      position: 0, // anchor position in seconds
      duration: 0, // total duration in seconds (0 if live/unknown)
      playbackRate: 1,
      volume: 80, // 0 - 100
      muted: false,
      rotation: 0, // 0 | 90 | 180 | 270
      fitMode: 'contain', // 'contain' | 'cover' | 'fill'
      streamMode: 'auto', // 'auto' | 'direct' | 'proxy' | 'transcode'
      startPosition: 0, // raw AirPlay Start-Position hint (0..1 ratio or seconds)
      startPositionUnit: 'auto',
      updatedAt: Date.now(),
      sessionId: 0,
    };

    // Monotonic anchor for O(1) position interpolation
    this._anchorTimeMs = performance.now();
    this._lastProgressBroadcastMs = 0;

    // Fixed-size ring buffers to keep memory flat over long sessions
    this._logs = [];
    this._history = [];

    // Protocol runtime metadata
    this.protocols = {
      dlna: { active: false, port: 0, ssdpBound: false, lastError: null },
      airplay: { active: false, port: 0, mdnsActive: false, lastError: null },
      tvbox: { active: false, port: 0, lastError: null },
      websocket: { clients: 0, tvClients: 0, mobileClients: 0 },
    };
  }

  /**
   * Compute live playback position in O(1) using monotonic clock interpolation.
   * @returns {number}
   */
  getLivePosition() {
    let pos = this.state.position;
    if (this.state.status === 'PLAYING' && this.state.mediaType !== 'image' && this.state.mediaType !== 'mirror') {
      const elapsedSec = Math.max(0, (performance.now() - this._anchorTimeMs) / 1000) * (this.state.playbackRate || 1);
      pos += elapsedSec;
      if (this.state.duration > 0 && pos > this.state.duration) {
        pos = this.state.duration;
      }
    }
    return Math.max(0, pos);
  }

  /**
   * Return an immutable snapshot with interpolated live position.
   */
  getSnapshot() {
    return {
      ...this.state,
      metadata: { ...this.state.metadata },
      position: Number(this.getLivePosition().toFixed(2)),
      protocols: {
        dlna: { ...this.protocols.dlna },
        airplay: { ...this.protocols.airplay },
        tvbox: { ...this.protocols.tvbox },
        websocket: { ...this.protocols.websocket },
      },
    };
  }

  /**
   * Commit current interpolated position before changing playback status or rate.
   */
  _commitPositionAnchor() {
    this.state.position = this.getLivePosition();
    this._anchorTimeMs = performance.now();
  }

  /**
   * Detect media type from URL and optional MIME/metadata hints.
   * @param {string} url
   * @param {string} [mimeType]
   * @param {string} [hintType]
   * @returns {'video'|'audio'|'image'|'mirror'}
   */
  inferMediaType(url, mimeType = '', hintType = '') {
    if (hintType === 'mirror' || hintType === 'image' || hintType === 'audio' || hintType === 'video') {
      return hintType;
    }
    const mime = String(mimeType).toLowerCase();
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';

    const cleanUrl = String(url || '').split('?')[0].toLowerCase();
    if (/\.(jpg|jpeg|png|webp|gif|bmp|heic|avif)$/.test(cleanUrl)) return 'image';
    if (/\.(mp3|aac|flac|wav|ogg|m4a|opus)$/.test(cleanUrl)) return 'audio';
    return 'video';
  }

  /**
   * Load a new media item (from DLNA SetAVTransportURI, AirPlay /play or /photo, or WebCast).
   */
  setMedia({
    url = '',
    protocol = 'WebCast',
    mediaType = '',
    metadata = {},
    clientIp = '',
    clientName = '',
    startPosition = 0,
    startPositionUnit = 'auto',
    autoPlay = true,
    streamMode = 'auto',
  }) {
    const resolvedType = this.inferMediaType(url, metadata.mimeType, mediaType);
    const initialPos = startPositionUnit === 'seconds' || startPosition > 1 ? Number(startPosition) || 0 : 0;

    this.state.sessionId += 1;
    this.state.protocol = protocol;
    this.state.mediaType = resolvedType;
    this.state.url = url;
    this.state.metadata = {
      title: metadata.title || this._extractTitleFromUrl(url) || `${protocol} 投屏内容`,
      artist: metadata.artist || '',
      album: metadata.album || '',
      artwork: metadata.artwork || '',
      mimeType: metadata.mimeType || '',
      isLive: Boolean(metadata.isLive),
    };
    this.state.clientIp = clientIp;
    this.state.clientName = clientName || protocol;
    this.state.position = initialPos;
    this.state.duration = Number(metadata.duration) || 0;
    this.state.startPosition = Number(startPosition) || 0;
    this.state.startPositionUnit = startPositionUnit;
    this.state.playbackRate = 1;
    this.state.streamMode = streamMode;
    this.state.status = autoPlay ? 'PLAYING' : 'PAUSED';
    this.state.updatedAt = Date.now();
    this._anchorTimeMs = performance.now();

    if (url && resolvedType !== 'mirror') {
      this._pushHistory({
        url,
        title: this.state.metadata.title,
        protocol,
        mediaType: resolvedType,
        artwork: this.state.metadata.artwork,
        timestamp: Date.now(),
      });
    }

    this.addLog(protocol, `接收媒体 [${resolvedType}] ${this.state.metadata.title}`, {
      url: url.slice(0, 140),
      clientIp,
      autoPlay,
    });

    const snap = this.getSnapshot();
    this.emit('stateChange', snap);
    return snap;
  }

  play(source = 'Local') {
    if (!this.state.url && this.state.mediaType !== 'mirror') return this.getSnapshot();
    this._commitPositionAnchor();
    const prev = this.state.status;
    this.state.status = 'PLAYING';
    this.state.playbackRate = 1;
    this.state.updatedAt = Date.now();
    this._anchorTimeMs = performance.now();

    if (prev !== 'PLAYING') {
      this.addLog(source, '恢复/开始播放');
      const snap = this.getSnapshot();
      this.emit('stateChange', snap);
      return snap;
    }
    return this.getSnapshot();
  }

  pause(source = 'Local') {
    if (this.state.status === 'IDLE' || this.state.status === 'STOPPED') return this.getSnapshot();
    this._commitPositionAnchor();
    const prev = this.state.status;
    this.state.status = 'PAUSED';
    this.state.updatedAt = Date.now();

    if (prev !== 'PAUSED') {
      this.addLog(source, `暂停播放 @ ${this.state.position.toFixed(1)}s`);
      const snap = this.getSnapshot();
      this.emit('stateChange', snap);
      return snap;
    }
    return this.getSnapshot();
  }

  stop(source = 'Local') {
    const prev = this.state.status;
    this.state.status = 'IDLE';
    this.state.url = '';
    this.state.position = 0;
    this.state.duration = 0;
    this.state.startPosition = 0;
    this.state.startPositionUnit = 'auto';
    this.state.rotation = 0;
    this.state.updatedAt = Date.now();
    this._anchorTimeMs = performance.now();

    if (prev !== 'IDLE') {
      this.addLog(source, '停止投屏并回到待机大屏');
    }
    const snap = this.getSnapshot();
    this.emit('stateChange', snap);
    return snap;
  }

  seek(targetSeconds, source = 'Local') {
    const clamped = Math.max(0, Number(targetSeconds) || 0);
    this.state.position = this.state.duration > 0 ? Math.min(clamped, this.state.duration) : clamped;
    this.state.updatedAt = Date.now();
    this._anchorTimeMs = performance.now();

    this.addLog(source, `进度跳转至 ${this.state.position.toFixed(1)}s`);
    const snap = this.getSnapshot();
    this.emit('command', { type: 'seek', position: this.state.position, source });
    this.emit('stateChange', snap);
    return snap;
  }

  setVolume(volume, source = 'Local') {
    const clamped = Math.max(0, Math.min(100, Math.round(Number(volume) || 0)));
    const changed = this.state.volume !== clamped;
    this.state.volume = clamped;
    this.state.updatedAt = Date.now();

    if (changed) {
      this.addLog(source, `音量调整为 ${clamped}%`);
      const snap = this.getSnapshot();
      this.emit('volumeChange', snap);
      this.emit('stateChange', snap);
    }
    return this.getSnapshot();
  }

  setMute(muted, source = 'Local') {
    const boolVal = Boolean(muted);
    const changed = this.state.muted !== boolVal;
    this.state.muted = boolVal;
    this.state.updatedAt = Date.now();

    if (changed) {
      this.addLog(source, boolVal ? '静音已开启' : '静音已取消');
      const snap = this.getSnapshot();
      this.emit('volumeChange', snap);
      this.emit('stateChange', snap);
    }
    return this.getSnapshot();
  }

  setDisplayOptions({ rotation, fitMode, streamMode, playbackRate }) {
    let changed = false;
    if (rotation !== undefined && [0, 90, 180, 270].includes(Number(rotation))) {
      this.state.rotation = Number(rotation);
      changed = true;
    }
    if (fitMode && ['contain', 'cover', 'fill'].includes(fitMode)) {
      this.state.fitMode = fitMode;
      changed = true;
    }
    if (streamMode && ['auto', 'direct', 'proxy', 'transcode'].includes(streamMode)) {
      this.state.streamMode = streamMode;
      changed = true;
    }
    if (playbackRate !== undefined && Number(playbackRate) > 0) {
      this._commitPositionAnchor();
      this.state.playbackRate = Number(playbackRate);
      changed = true;
    }
    if (changed) {
      this.state.updatedAt = Date.now();
      this.emit('stateChange', this.getSnapshot());
    }
    return this.getSnapshot();
  }

  /**
   * Synchronize player telemetry from the TV browser/window back to backend memory.
   * Throttled so frequent timeupdate events do not flood WebSocket clients.
   */
  syncFromPlayer({ position, duration, status, sessionId }) {
    if (sessionId !== undefined && sessionId !== this.state.sessionId) {
      return; // Ignore stale telemetry from an older media session
    }
    if (Number.isFinite(duration) && duration > 0) {
      this.state.duration = duration;
    }
    if (Number.isFinite(position) && position >= 0) {
      this.state.position = position;
      this._anchorTimeMs = performance.now();
    }
    if (status && ['PLAYING', 'PAUSED', 'LOADING', 'STOPPED', 'IDLE'].includes(status)) {
      const prev = this.state.status;
      this.state.status = status;
      if (prev !== status) {
        this.state.updatedAt = Date.now();
        this.emit('stateChange', this.getSnapshot());
        return;
      }
    }

    const now = performance.now();
    if (now - this._lastProgressBroadcastMs >= PROGRESS_BROADCAST_INTERVAL_MS) {
      this._lastProgressBroadcastMs = now;
      this.emit('progress', {
        sessionId: this.state.sessionId,
        position: Number(this.state.position.toFixed(2)),
        duration: Number(this.state.duration.toFixed(2)),
        status: this.state.status,
      });
    }
  }

  setProtocolStatus(name, patch) {
    if (!this.protocols[name]) return;
    Object.assign(this.protocols[name], patch);
    this.emit('protocolStatus', { ...this.protocols });
  }

  addLog(protocol, message, detail = null) {
    const entry = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
      time: new Date().toLocaleTimeString('zh-CN', { hour12: false }),
      protocol,
      message,
      detail,
    };
    this._logs.unshift(entry);
    if (this._logs.length > MAX_LOGS) {
      this._logs.length = MAX_LOGS;
    }
    this.emit('log', entry);
    return entry;
  }

  getLogs() {
    return this._logs.slice();
  }

  getHistory() {
    return this._history.slice();
  }

  _pushHistory(item) {
    const idx = this._history.findIndex((h) => h.url === item.url);
    if (idx !== -1) {
      this._history.splice(idx, 1);
    }
    this._history.unshift(item);
    if (this._history.length > MAX_HISTORY) {
      this._history.length = MAX_HISTORY;
    }
  }

  _extractTitleFromUrl(url) {
    try {
      const parsed = new URL(url);
      const seg = decodeURIComponent(parsed.pathname.split('/').filter(Boolean).pop() || '');
      return seg.slice(0, 64) || parsed.hostname;
    } catch {
      return '';
    }
  }
}

module.exports = new CastStateService();
