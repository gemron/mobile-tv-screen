const fs = require('fs');
const path = require('path');
const { createHash } = require('crypto');

// Store catalog selections, never expiring media URLs or account credentials.
class Collection {
  constructor(dataDir) {
    this.file = path.join(dataDir, 'library-collection.json');
    this.data = { version: 1, history: [], favorites: [] };
    try {
      const stored = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      if (stored.version === 1) for (const key of ['history', 'favorites']) {
        this.data[key] = (Array.isArray(stored[key]) ? stored[key] : []).filter(item => item && typeof item.id === 'string' && item.sourceId && ['vod', 'live'].includes(item.kind)).slice(0, key === 'history' ? 200 : 500);
      }
    } catch {}
  }
  static id(item) { return createHash('sha256').update(JSON.stringify([item.sourceId, item.kind, item.siteKey || item.sourceKey, item.kind === 'vod' ? item.vodId : item.channelId])).digest('hex').slice(0, 24); }
  summary() { return { history: this.data.history.map(item => ({ ...item })), favorites: this.data.favorites.map(item => ({ ...item })) }; }
  changed(immediate = false) {
    this.dirty = true;
    if (immediate) return this.flush();
    if (!this.timer) this.timer = setTimeout(() => { this.timer = null; this.flush(); }, 3000).unref();
  }
  flush() {
    clearTimeout(this.timer); this.timer = null;
    if (!this.dirty) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify(this.data), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file); this.dirty = false;
  }
  record(item) {
    const id = Collection.id(item), previous = this.data.history.find(value => value.id === id);
    const entry = { ...previous, ...item, id, updatedAt: Date.now() };
    this.data.history = [entry, ...this.data.history.filter(value => value.id !== id)].slice(0, 200);
    this.changed(); return entry;
  }
  progress(id, state) {
    const entry = this.data.history.find(value => value.id === id);
    if (!entry || entry.kind !== 'vod') return;
    if (Number.isFinite(state.position) && state.position >= 0) entry.position = Math.min(604800, state.position);
    if (Number.isFinite(state.duration) && state.duration > 0) entry.duration = Math.min(604800, state.duration);
    entry.updatedAt = Date.now(); this.changed();
  }
  favorite(item, saved) {
    const id = Collection.id(item), exists = this.data.favorites.some(value => value.id === id);
    if (saved == null) saved = !exists;
    if (saved && !exists && this.data.favorites.length >= 500) throw Object.assign(new Error('收藏已达 500 条，请先整理收藏'), { status: 400 });
    this.data.favorites = this.data.favorites.filter(value => value.id !== id);
    if (saved) this.data.favorites.unshift({ ...item, id, savedAt: Date.now() });
    this.changed(true); return this.summary();
  }
  remove(kind, id, clear = false) {
    if (!['history', 'favorites'].includes(kind)) throw Object.assign(new Error('记录类型无效'), { status: 400 });
    this.data[kind] = clear ? [] : this.data[kind].filter(item => item.id !== id);
    this.changed(true); return this.summary();
  }
}

module.exports = { Collection };
