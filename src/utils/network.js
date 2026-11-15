const os = require('os');
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const { DATA_DIR } = require('./paths');
const CONFIG_FILE = path.join(DATA_DIR, 'device-config.json');

const VIRTUAL_IFACE_PATTERN = /(virtual|vmware|vbox|vethernet|wsl|hyper-v|docker|loopback|tailscale|zerotier|tun|tap|npcap)/i;

/**
 * Check whether an IPv4 address is in a private RFC1918 LAN range.
 * @param {string} ip
 * @returns {boolean}
 */
function isPrivateLanIPv4(ip) {
  if (!ip) return false;
  if (ip.startsWith('192.168.') || ip.startsWith('10.')) return true;
  if (ip.startsWith('172.')) {
    const secondOctet = Number(ip.split('.')[1]);
    return secondOctet >= 16 && secondOctet <= 31;
  }
  return false;
}

/**
 * Rank interface priority so real Wi-Fi / Ethernet LAN interfaces come first.
 * @param {{ name: string, address: string, mac: string }} iface
 * @returns {number}
 */
function scoreInterface(iface) {
  let score = 0;
  if (isPrivateLanIPv4(iface.address)) score += 100;
  if (iface.address.startsWith('192.168.')) score += 30;
  if (/^(wi-?fi|wlan|ethernet|en\d+|eth\d+|本地连接|以太网)/i.test(iface.name)) score += 40;
  if (VIRTUAL_IFACE_PATTERN.test(iface.name)) score -= 80;
  return score;
}

/**
 * Enumerate active non-loopback IPv4 interfaces sorted by LAN likelihood.
 * @returns {Array<{ name: string, address: string, netmask: string, mac: string, isVirtual: boolean }>}
 */
function getLanInterfaces() {
  const raw = os.networkInterfaces();
  const list = [];

  for (const [name, addrs] of Object.entries(raw)) {
    if (!Array.isArray(addrs)) continue;
    for (const entry of addrs) {
      if (entry.family !== 'IPv4' || entry.internal) continue;
      if (!entry.address || entry.address.startsWith('169.254.')) continue;
      list.push({
        name,
        address: entry.address,
        netmask: entry.netmask,
        mac: entry.mac && entry.mac !== '00:00:00:00:00:00' ? entry.mac.toUpperCase() : '',
        isVirtual: VIRTUAL_IFACE_PATTERN.test(name),
      });
    }
  }

  list.sort((a, b) => scoreInterface(b) - scoreInterface(a));
  return list;
}

/**
 * Return the primary LAN IPv4 address (fallback to 127.0.0.1 if offline).
 * @param {string} [preferredIp]
 * @returns {string}
 */
function getPrimaryLanIp(preferredIp) {
  const ifaces = getLanInterfaces();
  if (preferredIp && ifaces.some((i) => i.address === preferredIp)) {
    return preferredIp;
  }
  return ifaces.length > 0 ? ifaces[0].address : '127.0.0.1';
}

/**
 * Build a deterministic UUIDv4-formatted string from a seed.
 * @param {string} seed
 * @returns {string}
 */
function deterministicUuid(seed) {
  const hash = crypto.createHash('sha256').update(seed).digest('hex');
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '4' + hash.slice(13, 16),
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hash.slice(18, 20),
    hash.slice(20, 32),
  ].join('-');
}

/**
 * Build a deterministic AirPlay-compatible MAC address (XX:XX:XX:XX:XX:XX).
 * @param {string} seed
 * @returns {string}
 */
function deterministicMac(seed) {
  const ifaces = getLanInterfaces();
  const realMac = ifaces.find((i) => !i.isVirtual && i.mac)?.mac;
  if (realMac) return realMac;

  const bytes = crypto.createHash('md5').update(seed).digest();
  // Ensure locally administered unicast MAC
  bytes[0] = (bytes[0] & 0xfe) | 0x02;
  return Array.from(bytes.slice(0, 6))
    .map((b) => b.toString(16).padStart(2, '0').toUpperCase())
    .join(':');
}

/**
 * Load or initialize persistent device identity (UUID, MAC, friendly name).
 * @returns {{ uuid: string, mac: string, deviceName: string }}
 */
function loadDeviceIdentity() {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    if (fs.existsSync(CONFIG_FILE)) {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (saved && saved.uuid && saved.mac && saved.deviceName) {
        return saved;
      }
    }
  } catch {
    // Fall through to regenerate
  }

  const host = os.hostname() || 'MobileTvScreen';
  const identity = {
    uuid: deterministicUuid(`mobileTvScreen:${host}`),
    mac: deterministicMac(`mobileTvScreen:${host}`),
    deviceName: `MobileTV (${host})`,
  };

  try {
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(identity, null, 2), 'utf8');
  } catch {
    // Ignore write failure in read-only scenarios
  }
  return identity;
}

/**
 * Persist updated device name.
 * @param {string} newName
 * @returns {{ uuid: string, mac: string, deviceName: string }}
 */
function saveDeviceName(newName) {
  const current = loadDeviceIdentity();
  const sanitized = String(newName || '').trim().slice(0, 48) || current.deviceName;
  const updated = { ...current, deviceName: sanitized };
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    fs.writeFileSync(CONFIG_FILE, JSON.stringify(updated, null, 2), 'utf8');
  } catch {
    // Ignore write failure
  }
  return updated;
}

/**
 * Format seconds into DLNA HH:MM:SS string.
 * @param {number} seconds
 * @returns {string}
 */
function formatDlnaTime(seconds) {
  const total = Math.max(0, Math.floor(Number(seconds) || 0));
  const hrs = Math.floor(total / 3600);
  const mins = Math.floor((total % 3600) / 60);
  const secs = total % 60;
  return [
    String(hrs).padStart(2, '0'),
    String(mins).padStart(2, '0'),
    String(secs).padStart(2, '0'),
  ].join(':');
}

/**
 * Parse DLNA time string (HH:MM:SS or HH:MM:SS.fff) or numeric string into seconds.
 * @param {string|number} value
 * @returns {number}
 */
function parseDlnaTime(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.max(0, value) : 0;
  const str = String(value || '').trim();
  if (!str || str === 'NOT_IMPLEMENTED') return 0;
  if (/^\d+(\.\d+)?$/.test(str)) return Math.max(0, parseFloat(str));
  const parts = str.split(':').map(Number);
  if (parts.length === 3 && parts.every((n) => Number.isFinite(n))) {
    return Math.max(0, parts[0] * 3600 + parts[1] * 60 + parts[2]);
  }
  if (parts.length === 2 && parts.every((n) => Number.isFinite(n))) {
    return Math.max(0, parts[0] * 60 + parts[1]);
  }
  return 0;
}

module.exports = {
  getLanInterfaces,
  getPrimaryLanIp,
  loadDeviceIdentity,
  saveDeviceName,
  formatDlnaTime,
  parseDlnaTime,
  isPrivateLanIPv4,
};
