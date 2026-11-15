const dgram = require('dgram');
const http = require('http');
const crypto = require('crypto');
const { XMLParser } = require('fast-xml-parser');
const express = require('express');
const castState = require('../services/castState');
const { getLanInterfaces, getPrimaryLanIp, formatDlnaTime, parseDlnaTime } = require('../utils/network');

const SSDP_ADDR = '239.255.255.250';
const SSDP_PORT = 1900;

const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  removeNSPrefix: true,
  trimValues: true,
});

function escapeXml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function unescapeXml(str) {
  return String(str ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

/**
 * Safely extract plain text from a fast-xml-parser node (handles strings, numbers, CDATA, and attribute-bearing objects).
 * @param {any} val
 * @returns {string}
 */
function extractText(val) {
  if (val === undefined || val === null) return '';
  if (typeof val === 'string' || typeof val === 'number' || typeof val === 'boolean') {
    return String(val);
  }
  if (typeof val === 'object') {
    if (val['#text'] !== undefined) return String(val['#text']);
    if (val['#cdata'] !== undefined) return String(val['#cdata']);
  }
  return '';
}

function findKeyIgnoreCase(obj, target) {
  if (!obj || typeof obj !== 'object') return undefined;
  const lower = target.toLowerCase();
  const key = Object.keys(obj).find((k) => k.toLowerCase() === lower);
  return key ? obj[key] : undefined;
}

/**
 * Parse DIDL-Lite metadata string (often HTML-entity encoded inside SOAP XML).
 * @param {string} rawMeta
 */
function parseDidlMetadata(rawMeta) {
  const result = { title: '', artist: '', album: '', artwork: '', mimeType: '', duration: 0 };
  if (!rawMeta || typeof rawMeta !== 'string') return result;

  try {
    const decoded = rawMeta.includes('&lt;') ? unescapeXml(rawMeta) : rawMeta;
    const parsed = xmlParser.parse(decoded);
    const didl = parsed['DIDL-Lite'] || parsed;
    const item = Array.isArray(didl?.item) ? didl.item[0] : didl?.item || didl?.container;
    if (!item) return result;

    const textOf = (val) => {
      if (!val) return '';
      if (typeof val === 'string') return val;
      if (typeof val === 'object') return val['#text'] || '';
      return String(val);
    };

    result.title = textOf(item.title);
    result.artist = textOf(item.artist) || textOf(item.creator) || textOf(item.author);
    result.album = textOf(item.album);
    result.artwork = textOf(item.albumArtURI);

    const resNode = Array.isArray(item.res) ? item.res[0] : item.res;
    if (resNode && typeof resNode === 'object') {
      const protoInfo = resNode['@_protocolInfo'] || '';
      const parts = protoInfo.split(':');
      if (parts.length >= 3 && parts[2] && parts[2] !== '*') {
        result.mimeType = parts[2];
      }
      if (resNode['@_duration']) {
        result.duration = parseDlnaTime(resNode['@_duration']);
      }
    }
  } catch {
    // Fallback regex extraction for malformed DIDL-Lite from some apps
    const decoded = unescapeXml(rawMeta);
    const titleMatch = decoded.match(/<dc:title[^>]*>([^<]+)<\/dc:title>/i);
    if (titleMatch) result.title = titleMatch[1].trim();
    const artMatch = decoded.match(/<upnp:albumArtURI[^>]*>([^<]+)<\/upnp:albumArtURI>/i);
    if (artMatch) result.artwork = artMatch[1].trim();
  }
  return result;
}

function buildSoapEnvelope(serviceType, actionName, bodyFieldsXml) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <u:${actionName}Response xmlns:u="${serviceType}">
      ${bodyFieldsXml}
    </u:${actionName}Response>
  </s:Body>
</s:Envelope>`;
}

function buildSoapFault(code, description) {
  return `<?xml version="1.0" encoding="utf-8"?>
<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">
  <s:Body>
    <s:Fault>
      <faultcode>s:Client</faultcode>
      <faultstring>UPnPError</faultstring>
      <detail>
        <UPnPError xmlns="urn:schemas-upnp-org:control-1-0">
          <errorCode>${code}</errorCode>
          <errorDescription>${escapeXml(description)}</errorDescription>
        </UPnPError>
      </detail>
    </s:Fault>
  </s:Body>
</s:Envelope>`;
}

function mapTransportState(status) {
  switch (status) {
    case 'PLAYING':
      return 'PLAYING';
    case 'PAUSED':
      return 'PAUSED_PLAYBACK';
    case 'LOADING':
      return 'TRANSITIONING';
    default:
      return 'STOPPED';
  }
}

class DlnaService {
  constructor({ port, getIdentity, getPreferredIp, extraTargets = () => [] }) {
    this.port = port;
    this.getIdentity = getIdentity;
    this.getPreferredIp = getPreferredIp;
    this.extraTargets = extraTargets;
    this.ssdpSocket = null;
    this.ssdpSockets = [];
    this.notifyTimer = null;
    this.subscriptions = new Map(); // sid -> { service, callbackUrl, expiresAt, seq }
    this._recentSearches = new Map();
    this._recentDiscoveryLogs = new Map();
    this._recentDeviceXmlLog = new Map();
    this._eventListenersBound = false;
  }

  /**
   * Choose the best local IPv4 address for a remote client IP.
   * @param {string} remoteIp
   */
  _resolveLocalIpForRemote(remoteIp) {
    const ifaces = getLanInterfaces();
    if (remoteIp) {
      const prefix3 = remoteIp.split('.').slice(0, 3).join('.');
      const sameSubnet = ifaces.find((i) => i.address.startsWith(prefix3 + '.'));
      if (sameSubnet) return sameSubnet.address;
    }
    return getPrimaryLanIp(this.getPreferredIp ? this.getPreferredIp() : undefined);
  }

  /**
   * Build SSDP notification/response targets.
   */
  _getSearchTargets(uuid) {
    return [
      { st: 'upnp:rootdevice', usn: `uuid:${uuid}::upnp:rootdevice` },
      { st: `uuid:${uuid}`, usn: `uuid:${uuid}` },
      { st: 'urn:schemas-upnp-org:device:MediaRenderer:1', usn: `uuid:${uuid}::urn:schemas-upnp-org:device:MediaRenderer:1` },
      { st: 'urn:schemas-upnp-org:service:AVTransport:1', usn: `uuid:${uuid}::urn:schemas-upnp-org:service:AVTransport:1` },
      { st: 'urn:schemas-upnp-org:service:RenderingControl:1', usn: `uuid:${uuid}::urn:schemas-upnp-org:service:RenderingControl:1` },
      { st: 'urn:schemas-upnp-org:service:ConnectionManager:1', usn: `uuid:${uuid}::urn:schemas-upnp-org:service:ConnectionManager:1` },
    ].concat(this.extraTargets());
  }

  async start() {
    this._bindCastEvents();
    await this._startSsdp();
    castState.setProtocolStatus('dlna', { active: true, port: this.port, lastError: null });
    castState.addLog('DLNA', `MediaRenderer 已启动 (HTTP :${this.port}, SSDP :${SSDP_PORT})`);
  }

  async stop() {
    if (this.notifyTimer) {
      clearInterval(this.notifyTimer);
      this.notifyTimer = null;
    }
    try {
      this._sendSsdpAliveOrBye('ssdp:byebye');
    } catch {
      // Ignore shutdown send errors
    }
    for (const sock of this.ssdpSockets) {
      try {
        sock.close();
      } catch {
        // Ignore close error
      }
    }
    this.ssdpSockets = [];
    this.ssdpSocket = null;
    castState.setProtocolStatus('dlna', { active: false, ssdpBound: false });
  }

  _bindCastEvents() {
    if (this._eventListenersBound) return;
    this._eventListenersBound = true;

    castState.on('stateChange', () => {
      this._notifySubscribers('AVTransport');
    });
    castState.on('volumeChange', () => {
      this._notifySubscribers('RenderingControl');
    });
  }

  _bindSingleSsdpSocket(bindAddr, lanIfaces, isPrimary) {
    return new Promise((resolve) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      socket.on('error', (err) => {
        if (isPrimary) {
          castState.setProtocolStatus('dlna', { ssdpBound: false, lastError: err.message });
          castState.addLog('DLNA', `SSDP Socket (${bindAddr}) 异常: ${err.message}`);
        }
        try {
          socket.close();
        } catch {}
        resolve(null);
      });

      socket.on('message', (msg, rinfo) => {
        this._handleSsdpMessage(msg.toString('utf8'), rinfo, socket);
      });

      socket.bind(SSDP_PORT, bindAddr, () => {
        if (bindAddr === '0.0.0.0') {
          let joinedAny = false;
          for (const iface of lanIfaces) {
            try {
              socket.addMembership(SSDP_ADDR, iface.address);
              joinedAny = true;
            } catch {
              // Skip restricted virtual interfaces
            }
          }
          if (!joinedAny) {
            try {
              socket.addMembership(SSDP_ADDR);
            } catch {}
          }
        } else {
          try {
            socket.addMembership(SSDP_ADDR, bindAddr);
            socket.setMulticastInterface(bindAddr);
          } catch {}
        }

        try {
          socket.setMulticastTTL(4);
          socket.setMulticastLoopback(true);
        } catch {}

        this.ssdpSockets.push(socket);
        if (isPrimary) {
          this.ssdpSocket = socket;
        }
        resolve(socket);
      });
    });
  }

  async _startSsdp() {
    const lanIfaces = getLanInterfaces();
    await this._bindSingleSsdpSocket('0.0.0.0', lanIfaces, true);

    // Bind explicit sockets per physical LAN IPv4 so Windows SSDPSRV cannot shadow multicast M-SEARCH
    for (const iface of lanIfaces) {
      if (!iface.isVirtual) {
        await this._bindSingleSsdpSocket(iface.address, lanIfaces, false);
      }
    }

    if (this.ssdpSockets.length > 0) {
      if (!this.ssdpSocket) this.ssdpSocket = this.ssdpSockets[0];
      castState.setProtocolStatus('dlna', { ssdpBound: true, lastError: null });
      this._sendSsdpAliveOrBye('ssdp:alive');

      this.notifyTimer = setInterval(() => {
        this._sendSsdpAliveOrBye('ssdp:alive');
      }, 15000);
      if (this.notifyTimer.unref) this.notifyTimer.unref();
    }
  }

  _handleSsdpMessage(raw, rinfo, replySocket = null) {
    if (!raw.startsWith('M-SEARCH')) return;

    const stMatch = raw.match(/^ST:\s*(.+)$/im);
    if (!stMatch) return;
    const st = stMatch[1].trim();

    // Deduplicate identical M-SEARCH bursts received across 0.0.0.0 and interface-bound sockets
    const dedupKey = `${rinfo.address}:${rinfo.port}:${st.toLowerCase()}`;
    const now = Date.now();
    const lastSeen = this._recentSearches.get(dedupKey);
    if (lastSeen && now - lastSeen < 80) return;
    this._recentSearches.set(dedupKey, now);
    if (this._recentSearches.size > 200) {
      for (const [k, ts] of this._recentSearches.entries()) {
        if (now - ts > 2000) this._recentSearches.delete(k);
      }
    }

    const { uuid } = this.getIdentity();
    const targets = this._getSearchTargets(uuid);

    let matched = [];
    if (st === 'ssdp:all') {
      matched = targets;
    } else {
      matched = targets.filter((t) => t.st.toLowerCase() === st.toLowerCase());
    }
    const logKey = `${rinfo.address}:${st.toLowerCase()}`;
    if (now - (this._recentDiscoveryLogs.get(logKey) || 0) > 10000) {
      if (this._recentDiscoveryLogs.size >= 200) this._recentDiscoveryLogs.clear();
      this._recentDiscoveryLogs.set(logKey, now);
      castState.addLog('DLNA', matched.length ? '收到设备搜索，发送发现响应' : '收到未匹配的设备搜索', {
        clientIp: rinfo.address, searchTarget: st, responses: matched.length,
      });
    }
    if (matched.length === 0) return;

    const localIp = this._resolveLocalIpForRemote(rinfo.address);
    const location = `http://${localIp}:${this.port}/upnp/device.xml`;
    const dateStr = new Date().toUTCString();
    const sock = replySocket || this.ssdpSocket;

    for (const target of matched) {
      const response = [
        'HTTP/1.1 200 OK',
        'CACHE-CONTROL: max-age=1800',
        `DATE: ${dateStr}`,
        'EXT:',
        `LOCATION: ${target.location ? target.location(localIp) : location}`,
        'SERVER: Windows/10.0 UPnP/1.1 MobileTvScreen/1.0',
        `ST: ${target.st}`,
        `USN: ${target.usn}`,
        'BOOTID.UPNP.ORG: 1',
        'CONFIGID.UPNP.ORG: 1',
        '',
        '',
      ].join('\r\n');

      const buf = Buffer.from(response, 'utf8');
      sock?.send(buf, 0, buf.length, rinfo.port, rinfo.address, () => {});
    }
  }

  _sendSsdpAliveOrBye(nts, onlyTargets = null) {
    if (!this.ssdpSockets.length) return;
    const { uuid } = this.getIdentity();
    const targets = onlyTargets || this._getSearchTargets(uuid);
    const ifaces = getLanInterfaces();
    const physicalIps = ifaces.filter((i) => !i.isVirtual).map((i) => i.address);
    const targetIps = physicalIps.length > 0 ? physicalIps : [getPrimaryLanIp()];

    for (const localIp of targetIps) {
      const location = `http://${localIp}:${this.port}/upnp/device.xml`;
      const ifaceSock =
        this.ssdpSockets.find((s) => {
          try {
            return s.address().address === localIp;
          } catch {
            return false;
          }
        }) || this.ssdpSocket;

      if (!ifaceSock) continue;
      try {
        ifaceSock.setMulticastInterface(localIp);
      } catch {}

      for (const target of targets) {
        const lines = [
          'NOTIFY * HTTP/1.1',
          `HOST: ${SSDP_ADDR}:${SSDP_PORT}`,
          'CACHE-CONTROL: max-age=1800',
          `LOCATION: ${target.location ? target.location(localIp) : location}`,
          `NT: ${target.st}`,
          `NTS: ${nts}`,
          'SERVER: Windows/10.0 UPnP/1.1 MobileTvScreen/1.0',
          `USN: ${target.usn}`,
          'BOOTID.UPNP.ORG: 1',
          'CONFIGID.UPNP.ORG: 1',
          '',
          '',
        ];
        const buf = Buffer.from(lines.join('\r\n'), 'utf8');
        try {
          ifaceSock.send(buf, 0, buf.length, SSDP_PORT, SSDP_ADDR, () => {});
        } catch {
          // Ignore transient network send errors
        }
      }
    }
  }

  /**
   * Create Express Router handling UPnP descriptions, SOAP control, and GENA events.
   */
  createRouter() {
    const router = express.Router();

    // Parse raw text/xml body for SOAP actions without failing on custom content types
    router.use(
      '/control',
      express.text({ type: '*/*', limit: '2mb' })
    );

    router.get('/device.xml', (req, res) => {
      const { uuid, deviceName } = this.getIdentity();
      const clientIp = (req.ip || '').replace('::ffff:', '');
      const now = Date.now();
      const lastLogged = this._recentDeviceXmlLog.get(clientIp) || 0;
      if (now - lastLogged > 10000) {
        this._recentDeviceXmlLog.set(clientIp, now);
        castState.addLog('DLNA', `手机请求设备描述 (device.xml)`, { clientIp });
      }
      const xml = `<?xml version="1.0" encoding="utf-8"?>
<root xmlns="urn:schemas-upnp-org:device-1-0" xmlns:dlna="urn:schemas-dlna-org:device-1-0">
  <specVersion>
    <major>1</major>
    <minor>0</minor>
  </specVersion>
  <device>
    <deviceType>urn:schemas-upnp-org:device:MediaRenderer:1</deviceType>
    <friendlyName>${escapeXml(deviceName)}</friendlyName>
    <manufacturer>MobileTvScreen</manufacturer>
    <manufacturerURL>https://github.com/mobileTvScreen</manufacturerURL>
    <modelDescription>Android &amp; Apple Wireless Cast Receiver</modelDescription>
    <modelName>MobileTvScreen MediaRenderer</modelName>
    <modelNumber>1.0</modelNumber>
    <serialNumber>${escapeXml(uuid)}</serialNumber>
    <UDN>uuid:${escapeXml(uuid)}</UDN>
    <dlna:X_DLNADOC xmlns:dlna="urn:schemas-dlna-org:device-1-0">DMR-1.50</dlna:X_DLNADOC>
    <serviceList>
      <service>
        <serviceType>urn:schemas-upnp-org:service:AVTransport:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:AVTransport</serviceId>
        <SCPDURL>/upnp/scpd/AVTransport.xml</SCPDURL>
        <controlURL>/upnp/control/AVTransport1</controlURL>
        <eventSubURL>/upnp/event/AVTransport1</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:RenderingControl:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:RenderingControl</serviceId>
        <SCPDURL>/upnp/scpd/RenderingControl.xml</SCPDURL>
        <controlURL>/upnp/control/RenderingControl1</controlURL>
        <eventSubURL>/upnp/event/RenderingControl1</eventSubURL>
      </service>
      <service>
        <serviceType>urn:schemas-upnp-org:service:ConnectionManager:1</serviceType>
        <serviceId>urn:upnp-org:serviceId:ConnectionManager</serviceId>
        <SCPDURL>/upnp/scpd/ConnectionManager.xml</SCPDURL>
        <controlURL>/upnp/control/ConnectionManager1</controlURL>
        <eventSubURL>/upnp/event/ConnectionManager1</eventSubURL>
      </service>
    </serviceList>
  </device>
</root>`;
      res.set('Content-Type', 'text/xml; charset="utf-8"');
      res.send(xml);
    });

    router.use('/scpd', (req, res, next) => {
      castState.addLog('DLNA', '读取服务描述', {
        clientIp: (req.ip || '').replace('::ffff:', ''), path: req.path,
      });
      next();
    });

    router.get('/scpd/AVTransport.xml', (req, res) => {
      res.set('Content-Type', 'text/xml; charset="utf-8"');
      res.send(AVTRANSPORT_SCPD);
    });

    router.get('/scpd/RenderingControl.xml', (req, res) => {
      res.set('Content-Type', 'text/xml; charset="utf-8"');
      res.send(RENDERING_CONTROL_SCPD);
    });

    router.get('/scpd/ConnectionManager.xml', (req, res) => {
      res.set('Content-Type', 'text/xml; charset="utf-8"');
      res.send(CONNECTION_MANAGER_SCPD);
    });

    router.post('/control/AVTransport1', (req, res) => {
      this._handleAVTransport(req, res);
    });

    router.post('/control/RenderingControl1', (req, res) => {
      this._handleRenderingControl(req, res);
    });

    router.post('/control/ConnectionManager1', (req, res) => {
      this._handleConnectionManager(req, res);
    });

    // GENA SUBSCRIBE / UNSUBSCRIBE
    router.all('/event/:service', (req, res) => {
      this._handleEventSubscription(req, res);
    });

    return router;
  }

  _extractSoapAction(req, parsedBody) {
    const header = req.headers.soapaction || '';
    const match = header.match(/#([^"]+)"?$/);
    if (match) return { action: match[1], params: this._extractBodyParams(parsedBody, match[1]) };

    const env = findKeyIgnoreCase(parsedBody, 'Envelope') || parsedBody;
    const body = findKeyIgnoreCase(env, 'Body') || {};
    const actionKey = Object.keys(body).find((k) => !k.startsWith('@_')) || '';
    return { action: actionKey, params: body[actionKey] || {} };
  }

  _extractBodyParams(parsedBody, actionName) {
    const env = findKeyIgnoreCase(parsedBody, 'Envelope') || parsedBody;
    const body = findKeyIgnoreCase(env, 'Body') || {};
    const exact = findKeyIgnoreCase(body, actionName);
    if (exact && typeof exact === 'object') return exact;
    const fallbackKey = Object.keys(body).find((k) => !k.startsWith('@_'));
    return (fallbackKey && body[fallbackKey]) || {};
  }

  _handleAVTransport(req, res) {
    const serviceType = 'urn:schemas-upnp-org:service:AVTransport:1';
    let parsed;
    try {
      parsed = xmlParser.parse(req.body || '');
    } catch {
      res.status(400).set('Content-Type', 'text/xml; charset="utf-8"').send(buildSoapFault(402, 'Invalid XML'));
      return;
    }

    const { action, params } = this._extractSoapAction(req, parsed);
    const clientIp = (req.ip || '').replace('::ffff:', '');
    let responseBody = '';

    switch (action) {
      case 'SetAVTransportURI': {
        const uri = extractText(findKeyIgnoreCase(params, 'CurrentURI')).trim();
        const metaRaw = extractText(findKeyIgnoreCase(params, 'CurrentURIMetaData'));
        const metadata = parseDidlMetadata(metaRaw);
        castState.addLog('DLNA', `收到 SetAVTransportURI`, { clientIp, uri: uri.slice(0, 120) });
        if (uri) {
          castState.setMedia({
            url: uri,
            protocol: 'DLNA',
            metadata,
            clientIp,
            clientName: `DLNA (${clientIp})`,
            autoPlay: true,
          });
        } else {
          castState.stop('DLNA');
        }
        responseBody = '';
        break;
      }

      case 'SetNextAVTransportURI': {
        const nextUri = extractText(findKeyIgnoreCase(params, 'NextURI')).trim();
        castState.addLog('DLNA', `收到 SetNextAVTransportURI`, { clientIp, uri: nextUri.slice(0, 100) });
        responseBody = '';
        break;
      }

      case 'Play': {
        castState.play('DLNA');
        responseBody = '';
        break;
      }

      case 'Pause': {
        castState.pause('DLNA');
        responseBody = '';
        break;
      }

      case 'Stop': {
        castState.stop('DLNA');
        responseBody = '';
        break;
      }

      case 'Seek': {
        const target = extractText(findKeyIgnoreCase(params, 'Target')) || '00:00:00';
        const seconds = parseDlnaTime(target);
        castState.seek(seconds, 'DLNA');
        responseBody = '';
        break;
      }

      case 'GetPositionInfo': {
        // O(1) non-blocking memory read with monotonic clock interpolation
        const snap = castState.getSnapshot();
        const durationStr = formatDlnaTime(snap.duration);
        const relTimeStr = formatDlnaTime(snap.position);
        const uri = escapeXml(snap.url || '');
        const meta = snap.metadata?.title
          ? escapeXml(
              `<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/"><item id="0" parentID="-1" restricted="1"><dc:title>${escapeXml(
                snap.metadata.title
              )}</dc:title><upnp:class>object.item.videoItem</upnp:class><res>${uri}</res></item></DIDL-Lite>`
            )
          : '';
        responseBody = `
      <Track>${snap.url ? 1 : 0}</Track>
      <TrackDuration>${durationStr}</TrackDuration>
      <TrackMetaData>${meta}</TrackMetaData>
      <TrackURI>${uri}</TrackURI>
      <RelTime>${relTimeStr}</RelTime>
      <AbsTime>${relTimeStr}</AbsTime>
      <RelCount>2147483647</RelCount>
      <AbsCount>2147483647</AbsCount>`;
        break;
      }

      case 'GetTransportInfo': {
        const snap = castState.getSnapshot();
        responseBody = `
      <CurrentTransportState>${mapTransportState(snap.status)}</CurrentTransportState>
      <CurrentTransportStatus>OK</CurrentTransportStatus>
      <CurrentSpeed>${snap.playbackRate || 1}</CurrentSpeed>`;
        break;
      }

      case 'GetMediaInfo': {
        const snap = castState.getSnapshot();
        responseBody = `
      <NrTracks>${snap.url ? 1 : 0}</NrTracks>
      <MediaDuration>${formatDlnaTime(snap.duration)}</MediaDuration>
      <CurrentURI>${escapeXml(snap.url || '')}</CurrentURI>
      <CurrentURIMetaData></CurrentURIMetaData>
      <NextURI></NextURI>
      <NextURIMetaData></NextURIMetaData>
      <PlayMedium>NETWORK</PlayMedium>
      <RecordMedium>NOT_IMPLEMENTED</RecordMedium>
      <WriteStatus>NOT_IMPLEMENTED</WriteStatus>`;
        break;
      }

      case 'GetDeviceCapabilities': {
        responseBody = `
      <PlayMedia>NETWORK</PlayMedia>
      <RecMedia>NOT_IMPLEMENTED</RecMedia>
      <RecQualityModes>NOT_IMPLEMENTED</RecQualityModes>`;
        break;
      }

      case 'GetTransportSettings': {
        responseBody = `
      <PlayMode>NORMAL</PlayMode>
      <RecQualityMode>NOT_IMPLEMENTED</RecQualityMode>`;
        break;
      }

      case 'GetCurrentTransportActions': {
        responseBody = `<Actions>Play,Pause,Stop,Seek,Next,Previous</Actions>`;
        break;
      }

      case 'Next':
      case 'Previous': {
        responseBody = '';
        break;
      }

      default: {
        castState.addLog('DLNA', `未实现的 AVTransport Action: ${action}`, { clientIp });
        res.status(500).set('Content-Type', 'text/xml; charset="utf-8"').send(buildSoapFault(401, `Invalid Action: ${action}`));
        return;
      }
    }

    res.set('Content-Type', 'text/xml; charset="utf-8"');
    res.send(buildSoapEnvelope(serviceType, action, responseBody));
  }

  _handleRenderingControl(req, res) {
    const serviceType = 'urn:schemas-upnp-org:service:RenderingControl:1';
    let parsed;
    try {
      parsed = xmlParser.parse(req.body || '');
    } catch {
      res.status(400).set('Content-Type', 'text/xml; charset="utf-8"').send(buildSoapFault(402, 'Invalid XML'));
      return;
    }

    const { action, params } = this._extractSoapAction(req, parsed);
    let responseBody = '';

    switch (action) {
      case 'GetVolume': {
        responseBody = `<CurrentVolume>${castState.state.volume}</CurrentVolume>`;
        break;
      }
      case 'SetVolume': {
        castState.setVolume(extractText(findKeyIgnoreCase(params, 'DesiredVolume')), 'DLNA');
        responseBody = '';
        break;
      }
      case 'GetMute': {
        responseBody = `<CurrentMute>${castState.state.muted ? 1 : 0}</CurrentMute>`;
        break;
      }
      case 'SetMute': {
        const val = extractText(findKeyIgnoreCase(params, 'DesiredMute') || '0').toLowerCase();
        castState.setMute(val === '1' || val === 'true', 'DLNA');
        responseBody = '';
        break;
      }
      case 'ListPresets': {
        responseBody = `<CurrentPresetNameList>FactoryDefaults</CurrentPresetNameList>`;
        break;
      }
      case 'SelectPreset': {
        responseBody = '';
        break;
      }
      default: {
        res.status(500).set('Content-Type', 'text/xml; charset="utf-8"').send(buildSoapFault(401, `Invalid Action: ${action}`));
        return;
      }
    }

    res.set('Content-Type', 'text/xml; charset="utf-8"');
    res.send(buildSoapEnvelope(serviceType, action, responseBody));
  }

  _handleConnectionManager(req, res) {
    const serviceType = 'urn:schemas-upnp-org:service:ConnectionManager:1';
    let parsed;
    try {
      parsed = xmlParser.parse(req.body || '');
    } catch {
      res.status(400).set('Content-Type', 'text/xml; charset="utf-8"').send(buildSoapFault(402, 'Invalid XML'));
      return;
    }

    const { action } = this._extractSoapAction(req, parsed);
    let responseBody = '';

    switch (action) {
      case 'GetProtocolInfo': {
        const sink = [
          'http-get:*:video/mp4:*',
          'http-get:*:video/x-flv:*',
          'http-get:*:video/webm:*',
          'http-get:*:video/x-matroska:*',
          'http-get:*:video/MP2T:*',
          'http-get:*:application/x-mpegURL:*',
          'http-get:*:application/vnd.apple.mpegurl:*',
          'http-get:*:audio/mpeg:*',
          'http-get:*:audio/mp4:*',
          'http-get:*:audio/flac:*',
          'http-get:*:image/jpeg:*',
          'http-get:*:image/png:*',
          'http-get:*:image/webp:*',
          'http-get:*:*:*',
        ].join(',');
        responseBody = `<Source></Source><Sink>${sink}</Sink>`;
        break;
      }
      case 'GetCurrentConnectionIDs': {
        responseBody = `<ConnectionIDs>0</ConnectionIDs>`;
        break;
      }
      case 'GetCurrentConnectionInfo': {
        responseBody = `
      <RcsID>0</RcsID>
      <AVTransportID>0</AVTransportID>
      <ProtocolInfo></ProtocolInfo>
      <PeerConnectionManager></PeerConnectionManager>
      <PeerConnectionID>-1</PeerConnectionID>
      <Direction>Input</Direction>
      <Status>OK</Status>`;
        break;
      }
      default: {
        res.status(500).set('Content-Type', 'text/xml; charset="utf-8"').send(buildSoapFault(401, `Invalid Action: ${action}`));
        return;
      }
    }

    res.set('Content-Type', 'text/xml; charset="utf-8"');
    res.send(buildSoapEnvelope(serviceType, action, responseBody));
  }

  _handleEventSubscription(req, res) {
    const serviceParam = req.params.service || '';
    const service = serviceParam.startsWith('AVTransport')
      ? 'AVTransport'
      : serviceParam.startsWith('RenderingControl')
      ? 'RenderingControl'
      : 'ConnectionManager';

    const method = req.method.toUpperCase();
    const sidHeader = req.headers.sid;

    if (method === 'UNSUBSCRIBE') {
      if (sidHeader) this.subscriptions.delete(sidHeader);
      res.status(200).end();
      return;
    }

    if (method === 'SUBSCRIBE') {
      if (sidHeader && this.subscriptions.has(sidHeader)) {
        const sub = this.subscriptions.get(sidHeader);
        sub.expiresAt = Date.now() + 1800 * 1000;
        res.set({ SID: sidHeader, TIMEOUT: 'Second-1800' }).status(200).end();
        return;
      }

      const callbackRaw = String(req.headers.callback || '');
      const urlMatch = callbackRaw.match(/<([^>]+)>/);
      const callbackUrl = urlMatch ? urlMatch[1] : '';
      const sid = `uuid:${crypto.randomUUID()}`;

      if (callbackUrl) {
        this.subscriptions.set(sid, {
          service,
          callbackUrl,
          expiresAt: Date.now() + 1800 * 1000,
          seq: 0,
        });
        castState.addLog('DLNA', `GENA 事件订阅: ${service}`, { callbackUrl });
        // Send initial GENA notification asynchronously
        setImmediate(() => this._sendGenaNotify(sid));
      }

      res.set({ SID: sid, TIMEOUT: 'Second-1800' }).status(200).end();
      return;
    }

    res.status(405).end();
  }

  _notifySubscribers(service) {
    const now = Date.now();
    for (const [sid, sub] of this.subscriptions.entries()) {
      if (sub.expiresAt < now) {
        this.subscriptions.delete(sid);
        continue;
      }
      if (sub.service === service) {
        this._sendGenaNotify(sid);
      }
    }
  }

  _sendGenaNotify(sid) {
    const sub = this.subscriptions.get(sid);
    if (!sub) return;

    const snap = castState.getSnapshot();
    let lastChangeInner = '';

    if (sub.service === 'AVTransport') {
      const tState = mapTransportState(snap.status);
      lastChangeInner = `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/AVT/"><InstanceID val="0"><TransportState val="${tState}"/><TransportStatus val="OK"/><CurrentTrackDuration val="${formatDlnaTime(
        snap.duration
      )}"/><AVTransportURI val="${escapeXml(snap.url || '')}"/></InstanceID></Event>`;
    } else if (sub.service === 'RenderingControl') {
      lastChangeInner = `<Event xmlns="urn:schemas-upnp-org:metadata-1-0/RCS/"><InstanceID val="0"><Volume channel="Master" val="${snap.volume}"/><Mute channel="Master" val="${
        snap.muted ? 1 : 0
      }"/></InstanceID></Event>`;
    } else {
      return;
    }

    const body = `<?xml version="1.0" encoding="utf-8"?>
<e:propertyset xmlns:e="urn:schemas-upnp-org:event-1-0">
  <e:property>
    <LastChange>${escapeXml(lastChangeInner)}</LastChange>
  </e:property>
</e:propertyset>`;

    try {
      const target = new URL(sub.callbackUrl);
      const seq = sub.seq++;
      const req = http.request(
        {
          hostname: target.hostname,
          port: target.port || 80,
          path: target.pathname + target.search,
          method: 'NOTIFY',
          timeout: 1500,
          headers: {
            'Content-Type': 'text/xml; charset="utf-8"',
            NT: 'upnp:event',
            NTS: 'upnp:propchange',
            SID: sid,
            SEQ: String(seq),
            'Content-Length': Buffer.byteLength(body),
          },
        },
        (res) => {
          res.resume();
        }
      );
      req.on('error', () => {});
      req.on('timeout', () => req.destroy());
      req.end(body);
    } catch {
      // Ignore invalid callback URLs
    }
  }
}

const AVTRANSPORT_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>SetAVTransportURI</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>CurrentURI</name><direction>in</direction><relatedStateVariable>AVTransportURI</relatedStateVariable></argument>
      <argument><name>CurrentURIMetaData</name><direction>in</direction><relatedStateVariable>AVTransportURIMetaData</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>SetNextAVTransportURI</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>NextURI</name><direction>in</direction><relatedStateVariable>NextAVTransportURI</relatedStateVariable></argument>
      <argument><name>NextURIMetaData</name><direction>in</direction><relatedStateVariable>NextAVTransportURIMetaData</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>Play</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Speed</name><direction>in</direction><relatedStateVariable>TransportPlaySpeed</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>Pause</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>Stop</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>Next</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>Previous</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>Seek</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Unit</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SeekMode</relatedStateVariable></argument>
      <argument><name>Target</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_SeekTarget</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetPositionInfo</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Track</name><direction>out</direction><relatedStateVariable>CurrentTrack</relatedStateVariable></argument>
      <argument><name>TrackDuration</name><direction>out</direction><relatedStateVariable>CurrentTrackDuration</relatedStateVariable></argument>
      <argument><name>TrackMetaData</name><direction>out</direction><relatedStateVariable>CurrentTrackMetaData</relatedStateVariable></argument>
      <argument><name>TrackURI</name><direction>out</direction><relatedStateVariable>CurrentTrackURI</relatedStateVariable></argument>
      <argument><name>RelTime</name><direction>out</direction><relatedStateVariable>RelativeTimePosition</relatedStateVariable></argument>
      <argument><name>AbsTime</name><direction>out</direction><relatedStateVariable>AbsoluteTimePosition</relatedStateVariable></argument>
      <argument><name>RelCount</name><direction>out</direction><relatedStateVariable>RelativeCounterPosition</relatedStateVariable></argument>
      <argument><name>AbsCount</name><direction>out</direction><relatedStateVariable>AbsoluteCounterPosition</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetTransportInfo</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>CurrentTransportState</name><direction>out</direction><relatedStateVariable>TransportState</relatedStateVariable></argument>
      <argument><name>CurrentTransportStatus</name><direction>out</direction><relatedStateVariable>TransportStatus</relatedStateVariable></argument>
      <argument><name>CurrentSpeed</name><direction>out</direction><relatedStateVariable>TransportPlaySpeed</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetMediaInfo</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>NrTracks</name><direction>out</direction><relatedStateVariable>NumberOfTracks</relatedStateVariable></argument>
      <argument><name>MediaDuration</name><direction>out</direction><relatedStateVariable>CurrentMediaDuration</relatedStateVariable></argument>
      <argument><name>CurrentURI</name><direction>out</direction><relatedStateVariable>AVTransportURI</relatedStateVariable></argument>
      <argument><name>CurrentURIMetaData</name><direction>out</direction><relatedStateVariable>AVTransportURIMetaData</relatedStateVariable></argument>
      <argument><name>NextURI</name><direction>out</direction><relatedStateVariable>NextAVTransportURI</relatedStateVariable></argument>
      <argument><name>NextURIMetaData</name><direction>out</direction><relatedStateVariable>NextAVTransportURIMetaData</relatedStateVariable></argument>
      <argument><name>PlayMedium</name><direction>out</direction><relatedStateVariable>PlaybackStorageMedium</relatedStateVariable></argument>
      <argument><name>RecordMedium</name><direction>out</direction><relatedStateVariable>RecordStorageMedium</relatedStateVariable></argument>
      <argument><name>WriteStatus</name><direction>out</direction><relatedStateVariable>RecordMediumWriteStatus</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetDeviceCapabilities</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>PlayMedia</name><direction>out</direction><relatedStateVariable>PossiblePlaybackStorageMedia</relatedStateVariable></argument>
      <argument><name>RecMedia</name><direction>out</direction><relatedStateVariable>PossibleRecordStorageMedia</relatedStateVariable></argument>
      <argument><name>RecQualityModes</name><direction>out</direction><relatedStateVariable>PossibleRecordQualityModes</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetTransportSettings</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>PlayMode</name><direction>out</direction><relatedStateVariable>CurrentPlayMode</relatedStateVariable></argument>
      <argument><name>RecQualityMode</name><direction>out</direction><relatedStateVariable>CurrentRecordQualityMode</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetCurrentTransportActions</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Actions</name><direction>out</direction><relatedStateVariable>CurrentTransportActions</relatedStateVariable></argument>
    </argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>LastChange</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>TransportState</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>TransportStatus</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>TransportPlaySpeed</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AVTransportURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AVTransportURIMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>NextAVTransportURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>NextAVTransportURIMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrack</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackDuration</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackMetaData</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTrackURI</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentMediaDuration</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>NumberOfTracks</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>PlaybackStorageMedium</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RecordStorageMedium</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RecordMediumWriteStatus</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>PossiblePlaybackStorageMedia</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>PossibleRecordStorageMedia</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>PossibleRecordQualityModes</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentPlayMode</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentRecordQualityMode</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>CurrentTransportActions</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RelativeTimePosition</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AbsoluteTimePosition</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>RelativeCounterPosition</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>AbsoluteCounterPosition</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_InstanceID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_SeekMode</name>
      <dataType>string</dataType>
      <allowedValueList>
        <allowedValue>REL_TIME</allowedValue>
        <allowedValue>ABS_TIME</allowedValue>
        <allowedValue>TRACK_NR</allowedValue>
      </allowedValueList>
    </stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_SeekTarget</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

const RENDERING_CONTROL_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>GetVolume</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>CurrentVolume</name><direction>out</direction><relatedStateVariable>Volume</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>SetVolume</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>DesiredVolume</name><direction>in</direction><relatedStateVariable>Volume</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetMute</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>CurrentMute</name><direction>out</direction><relatedStateVariable>Mute</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>SetMute</name><argumentList>
      <argument><name>InstanceID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_InstanceID</relatedStateVariable></argument>
      <argument><name>Channel</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_Channel</relatedStateVariable></argument>
      <argument><name>DesiredMute</name><direction>in</direction><relatedStateVariable>Mute</relatedStateVariable></argument>
    </argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>LastChange</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no">
      <name>Volume</name>
      <dataType>ui2</dataType>
      <allowedValueRange><minimum>0</minimum><maximum>100</maximum><step>1</step></allowedValueRange>
    </stateVariable>
    <stateVariable sendEvents="no"><name>Mute</name><dataType>boolean</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_InstanceID</name><dataType>ui4</dataType></stateVariable>
    <stateVariable sendEvents="no">
      <name>A_ARG_TYPE_Channel</name>
      <dataType>string</dataType>
      <allowedValueList><allowedValue>Master</allowedValue></allowedValueList>
    </stateVariable>
  </serviceStateTable>
</scpd>`;

const CONNECTION_MANAGER_SCPD = `<?xml version="1.0" encoding="utf-8"?>
<scpd xmlns="urn:schemas-upnp-org:service-1-0">
  <specVersion><major>1</major><minor>0</minor></specVersion>
  <actionList>
    <action><name>GetProtocolInfo</name><argumentList>
      <argument><name>Source</name><direction>out</direction><relatedStateVariable>SourceProtocolInfo</relatedStateVariable></argument>
      <argument><name>Sink</name><direction>out</direction><relatedStateVariable>SinkProtocolInfo</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetCurrentConnectionIDs</name><argumentList>
      <argument><name>ConnectionIDs</name><direction>out</direction><relatedStateVariable>CurrentConnectionIDs</relatedStateVariable></argument>
    </argumentList></action>
    <action><name>GetCurrentConnectionInfo</name><argumentList>
      <argument><name>ConnectionID</name><direction>in</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
      <argument><name>RcsID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_RcsID</relatedStateVariable></argument>
      <argument><name>AVTransportID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_AVTransportID</relatedStateVariable></argument>
      <argument><name>ProtocolInfo</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ProtocolInfo</relatedStateVariable></argument>
      <argument><name>PeerConnectionManager</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionManager</relatedStateVariable></argument>
      <argument><name>PeerConnectionID</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionID</relatedStateVariable></argument>
      <argument><name>Direction</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_Direction</relatedStateVariable></argument>
      <argument><name>Status</name><direction>out</direction><relatedStateVariable>A_ARG_TYPE_ConnectionStatus</relatedStateVariable></argument>
    </argumentList></action>
  </actionList>
  <serviceStateTable>
    <stateVariable sendEvents="yes"><name>SourceProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>SinkProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="yes"><name>CurrentConnectionIDs</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_RcsID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_AVTransportID</name><dataType>i4</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ProtocolInfo</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionManager</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_Direction</name><dataType>string</dataType></stateVariable>
    <stateVariable sendEvents="no"><name>A_ARG_TYPE_ConnectionStatus</name><dataType>string</dataType></stateVariable>
  </serviceStateTable>
</scpd>`;

module.exports = DlnaService;
