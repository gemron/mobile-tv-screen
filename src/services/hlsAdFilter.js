const fs = require('fs');
const path = require('path');
const { Worker } = require('worker_threads');
const { DATA_DIR } = require('../utils/paths');
function domains(values) {
  return [...new Set((Array.isArray(values) ? values : String(values || '').split(/[\s,;]+/)).flatMap(value => {
    try { const raw = String(value).trim().toLowerCase().replace(/^\*\./, ''); if (!raw) return []; const u = new URL(raw.includes('://') ? raw : 'https://' + raw); return !u.username && !u.password && /^(?:[a-z0-9-]+\.)+[a-z0-9-]+$/.test(u.hostname) ? [u.hostname] : []; } catch { return []; }
  }))].slice(0, 500);
}
function rules(input) {
  return (Array.isArray(input) ? input : []).slice(0, 80).flatMap(row => {
    if (!row || !Array.isArray(row.hosts) || !Array.isArray(row.regex)) return [];
    const hosts = row.hosts.map(String).map(s => s.trim().toLowerCase()).filter(s => /^[a-z0-9.-]{3,200}$/.test(s)).slice(0, 20);
    const regex = row.regex.filter(s => typeof s === 'string' && s.length <= 2048 && s.includes('#EXTINF')).slice(0, 10);
    return hosts.length && regex.length ? [{ hosts, regex }] : [];
  });
}
class HlsAdFilter {
  constructor({ dataDir = DATA_DIR, timeout = 250 } = {}) {
    this.file = path.resolve(dataDir, 'ad-filter.json'); this.timeout = timeout; this.active = new Set(); this.subscription = { domains: [], rules: [] }; this.settings = { enabled: true, domains: [] };
    this.counts = { playlists: 0, segments: 0, seconds: 0, skipped: 0 };
    try { const data = JSON.parse(fs.readFileSync(this.file, 'utf8')); this.settings = { enabled: data.enabled !== false, domains: domains(data.domains) }; } catch {}
  }
  setSubscription(document) { this.subscription = { domains: domains(document.ads), rules: rules(document.rules) }; }
  summary() { return { ...this.settings, subscriptionDomains: this.subscription.domains.length, subscriptionRules: this.subscription.rules.length, stats: { ...this.counts, seconds: Math.round(this.counts.seconds * 10) / 10 } }; }
  save(patch) {
    if (patch.enabled != null && typeof patch.enabled !== 'boolean') throw Object.assign(new Error('广告过滤开关格式无效'), { status: 400 });
    if (patch.domains != null && (!Array.isArray(patch.domains) && typeof patch.domains !== 'string' || JSON.stringify(patch.domains).length > 40000)) throw Object.assign(new Error('广告域名列表过长或格式无效'), { status: 400 });
    const next = { enabled: patch.enabled ?? this.settings.enabled, domains: patch.domains == null ? this.settings.domains : domains(patch.domains) };
    fs.mkdirSync(path.dirname(this.file), { recursive: true }); fs.writeFileSync(this.file + '.tmp', JSON.stringify(next), { encoding: 'utf8', mode: 0o600 }); fs.renameSync(this.file + '.tmp', this.file); this.settings = next; return this.summary();
  }
  async filter(content, address) {
    const original = reason => ({ content, removed: 0, seconds: 0, reason });
    if (!this.settings.enabled) return original('disabled');
    if (this.closed || content.length > 4 * 1024 * 1024 || this.active.size >= 2) { this.counts.skipped++; return original('busy'); }
    // Most requests are master/live playlists and need no worker at all.
    if (!content.includes('#EXT-X-ENDLIST') || !content.includes('#EXTINF:')) return original('live-or-master');
    const options = { domains: [...new Set([...this.settings.domains, ...this.subscription.domains])], rules: this.subscription.rules };
    const worker = new Worker(path.join(__dirname, 'hlsAdFilterWorker.js'), { workerData: { content, address, options }, resourceLimits: { maxOldGenerationSizeMb: 48 } });
    this.active.add(worker);
    const result = await new Promise(resolve => {
      let done = false;
      const finish = value => { if (done) return; done = true; clearTimeout(timer); this.active.delete(worker); worker.terminate().catch(() => {}); resolve(value); };
      const timer = setTimeout(() => { this.counts.skipped++; finish(original('timeout')); }, this.timeout);
      worker.once('message', value => finish(value)); worker.once('error', () => finish(original('error'))); worker.once('exit', () => finish(original('stopped')));
    });
    this.counts.playlists++; this.counts.segments += result.removed; this.counts.seconds += result.seconds; return result;
  }
  async close() { this.closed = true; await Promise.allSettled([...this.active].map(w => w.terminate())); this.active.clear(); }
}
module.exports = { HlsAdFilter, domains, rules };
