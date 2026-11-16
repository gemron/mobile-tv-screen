const fs = require('fs');
const path = require('path');
const { createHash, randomBytes } = require('crypto');
const { setTimeout: delay } = require('timers/promises');
const modes = new Set(['off', 'playback', 'space', 'both']);
const mediaFile = /\.(mp4|mkv|mov|m4v|flv|ts|avi|webm|mp3|m4a|aac|flac|wav)$/i;

// Only exact file IDs returned by this application's single-file saves qualify.
// Never delete folders, scan by a film-name match, or empty the recycle bin.
class QuarkCleanup {
  constructor(cloud) {
    this.cloud = cloud;
    this.file = cloud.shareFile ? path.join(path.dirname(cloud.shareFile), 'quark-cleanup.json') : null;
    this.mode = 'both'; this.folders = {}; this.holds = new Map(); this.deleting = new Map(); this.active = null;
    this.controller = new AbortController(); this.queue = Promise.resolve(); this.last = null;
    try { const saved = JSON.parse(fs.readFileSync(this.file, 'utf8')); if (modes.has(saved.mode)) this.mode = saved.mode; if (saved.folders && typeof saved.folders === 'object' && !Array.isArray(saved.folders)) this.folders = saved.folders; } catch {}
  }
  persist() {
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file + '.tmp', JSON.stringify({ mode: this.mode, folders: this.folders }), { mode: 0o600 });
    fs.renameSync(this.file + '.tmp', this.file);
  }
  configure(mode) { if (!modes.has(mode)) throw Object.assign(new Error('自动清理选项无效'), { status: 400 }); this.mode = mode; this.invalidate(); this.persist(); return this.summary(); }
  summary() { return { mode: this.mode, tracked: [...this.cloud.shareSaves.values()].filter(r => r.provider === 'quark' && r.fid && r.managed !== false).length, last: this.last }; }
  enabled(reason) { return this.mode === 'both' || this.mode === reason; }
  ownerOf(cookie) { const uid = /(?:^|;)\s*__uid=([^;]+)/.exec(cookie || '')?.[1]; return uid ? createHash('sha256').update('quark:' + uid).digest('hex') : ''; }
  async owner() { return this.ownerOf(await this.cloud.accounts.cookie('quark', this.cloud.endpoints.quark)); }
  async context(signal) {
    const cookie = await this.cloud.accounts.cookie('quark', this.cloud.endpoints.quark), owner = this.ownerOf(cookie);
    if (!owner) throw Object.assign(new Error('未取得夸克账号标识，自动清理已跳过；请重新保存登录状态'), { status: 428 });
    return { cookie, owner, signal: AbortSignal.any([this.controller.signal, ...(signal ? [signal] : []), AbortSignal.timeout(30000)]) };
  }
  async request(ctx, endpoint, body, guard) {
    ctx.signal.throwIfAborted();
    if (await this.owner() !== ctx.owner) throw Object.assign(new Error('夸克账号已切换，已取消清理'), { status: 409 });
    return this.cloud.request('quark', endpoint, body, { cookie: ctx.cookie }, ctx.signal, false, guard);
  }
  async list(ctx, parent) {
    const files = [];
    for (let page = 1; page <= 20; page++) {
      const query = new URLSearchParams({ pdir_fid: parent, _page: String(page), _size: '100', _fetch_total: '1', _sort: 'file_type:asc,file_name:asc' });
      const response = await this.request(ctx, 'file/sort?' + query), rows = response.data?.list;
      if (!Array.isArray(rows)) throw new Error('未能验证夸克文件列表，本次未删除文件');
      files.push(...rows);
      if (rows.length < 100) return { files, complete: true };
    }
    return { files, complete: false };
  }
  async destination(signal) {
    if (this.mode === 'off' || !await this.owner()) return { parent: '0', managed: false, ownerHash: await this.owner() };
    const ctx = await this.context(signal), root = await this.list(ctx, '0'), saved = this.folders[ctx.owner];
    if (saved && root.files.some(f => String(f.fid) === saved.fid && f.file_name === saved.name && (f.dir || f.file_type === 0))) return { parent: saved.fid, managed: true, ownerHash: ctx.owner };
    // An incomplete root listing cannot establish that an old directory vanished.
    if (saved && !root.complete) throw new Error('临时目录未能验证，请稍后重试');
    const name = 'MobileTV 临时播放-' + randomBytes(3).toString('hex');
    const result = await this.request(ctx, 'file', { pdir_fid: '0', file_name: name, dir_path: '', dir_init_lock: false });
    const fid = String(result.data?.fid || '');
    if (!fid || fid === '0') throw new Error('未取得夸克临时目录编号，未保存剧集');
    this.folders[ctx.owner] = { fid, name }; this.persist();
    return { parent: fid, managed: true, ownerHash: ctx.owner };
  }
  hold(key) { let released=false;if (key) this.holds.set(key, (this.holds.get(key) || 0) + 1); return () => { if (released||!key) return;released=true; const left = (this.holds.get(key) || 0) - 1; if (left > 0) this.holds.set(key, left); else this.holds.delete(key); }; }
  async waitForDeletion(key) { await this.deleting.get(key); }
  protected(key, record) { return this.holds.has(key) || this.cloud.shareSaving.has(key) || this.active?.key === key || Boolean(this.active?.fid && this.active.fid === record.fid); }
  activate(key, fid, sessionId) { this.finishedSessionId = null; this.active = { key, fid: fid || this.cloud.shareSaves.get(key)?.fid, sessionId }; }
  stateChanged(state) {
    if (this.active && (state.sessionId !== this.active.sessionId || ['IDLE', 'STOPPED'].includes(state.status))) { this.active = null; this.schedule(); }
  }
  ended(sessionId) { if (this.active?.sessionId === sessionId) { this.finishedSessionId = sessionId; this.active = null; this.schedule(); } }
  schedule() { if (!this.enabled('playback') || this.controller.signal.aborted) return; clearTimeout(this.timer); this.timer = setTimeout(() => this.clean('playback').catch(() => {}), 5000).unref(); }
  async inventory(ctx) {
    const byParent = new Map(), items = [];
    for(const [key,record]of [...this.cloud.shareSaves].filter(([,r])=>r.provider==='quark'&&r.taskId&&!r.fid&&r.managed!==false&&(!r.ownerHash||r.ownerHash===ctx.owner)).slice(0,20)){
      if(this.protected(key,record))continue;
      try{
        const response=await this.request(ctx,'task?'+new URLSearchParams({task_id:record.taskId,retry_index:'0'})),task=response.data||{},ids=task.save_as?.save_as_top_fids||task.save_as_top_fids;
        if(Number(task.status)===2&&Array.isArray(ids)&&ids.length===1){const {taskId,...saved}=record;this.cloud.rememberShare(key,{...saved,fid:String(ids[0])});}
        else if(Number(task.status)===3)this.cloud.rememberShare(key,null);
      }catch(error){ctx.signal.throwIfAborted();if(error.status===409)throw error;}
    }
    for (const [key, record] of [...this.cloud.shareSaves]) {
      if (record.provider !== 'quark' || !record.fid || record.managed === false || record.ownerHash && record.ownerHash !== ctx.owner || this.protected(key, record)) continue;
      const parent = String(record.parent || '0');
      if (parent !== '0' && this.folders[ctx.owner]?.fid !== parent) continue;
      if (parent !== '0') {
        if (!byParent.has('0')) byParent.set('0', await this.list(ctx, '0'));
        const folder = this.folders[ctx.owner];
        if (!byParent.get('0').files.some(f => String(f.fid) === parent && f.file_name === folder.name && (f.dir || f.file_type === 0))) continue;
      }
      if (!byParent.has(parent)) byParent.set(parent, await this.list(ctx, parent));
      const remote = byParent.get(parent).files.find(f => String(f.fid) === record.fid);
      if (!remote || remote.dir || remote.isdir || remote.file_type === 0 || !mediaFile.test(remote.file_name || '') || record.name && record.name !== remote.file_name) continue;
      // Legacy references have no account field. Bind only after the exact
      // previously saved ID is found in this account's root, never by its name.
      const adopted = { ...record, ownerHash: ctx.owner, parent, managed: true, name: remote.file_name, size: Number(remote.size) || record.size || 0 };
      this.cloud.rememberShare(key, adopted);
      items.push({ key, record: adopted });
    }
    return items.sort((a,b) => (a.record.lastUsedAt || a.record.createdAt || 0) - (b.record.lastUsedAt || b.record.createdAt || 0));
  }
  clean(reason = 'manual', { signal, targetBytes = Infinity } = {}) {
    const run = this.queue.then(() => this.run(reason, signal, targetBytes)); this.queue = run.catch(() => {}); return run;
  }
  async run(reason, signal, targetBytes) {
    if(this.closed)throw new DOMException('Cleanup closed','AbortError');
    if (reason !== 'manual' && !this.enabled(reason)) return { removed: 0, bytes: 0 };
    if (this.activeGuard && !this.activeGuard()) return { removed: 0, bytes: 0, message: '当前播放文件未能确认，暂不清理；停止播放后可重试' };
    const ctx = await this.context(signal), candidates = await this.inventory(ctx);
    let removed = 0, bytes = 0;
    for (const item of candidates.slice(0, 50)) {
      if (reason !== 'manual' && !this.enabled(reason)) break;
      if (bytes >= targetBytes) break;
      const record = this.cloud.shareSaves.get(item.key);
      if (!record || record.fid !== item.record.fid || this.protected(item.key, record)) continue;
      if (this.activeGuard && !this.activeGuard()) break;
      let unlock; this.deleting.set(item.key, new Promise(resolve => { unlock = resolve; }));
      try {
      const result = await this.request(ctx, 'file/delete', { action_type: 2, filelist: [record.fid], exclude_fids: [] }, () => (reason === 'manual' || this.enabled(reason)) && !this.protected(item.key, record) && (!this.activeGuard || this.activeGuard()));
      if (result.data?.task_id) {
        let complete = false;
        for (let attempt = 0; attempt < 12; attempt++) {
          const task = await this.request(ctx, 'task?' + new URLSearchParams({ task_id: String(result.data.task_id), retry_index: String(attempt) }));
          if (Number(task.data?.status) === 2) { complete = true; break; }
          if (Number(task.data?.status) === 3) throw new Error('夸克未完成删除，已保留本机记录');
          await delay(250, undefined, { signal: ctx.signal });
        }
        if (!complete) throw new Error('夸克仍在处理删除，已保留记录供稍后检查');
      }
      let checked = await this.list(ctx, record.parent);
      for(let retry=0;retry<3&&checked.files.some(f=>String(f.fid)===record.fid);retry++){await delay(250*(retry+1),undefined,{signal:ctx.signal});checked=await this.list(ctx,record.parent);}
      if (!checked.complete || checked.files.some(f => String(f.fid) === record.fid)) continue;
      // A record may have changed while the remote operation was in progress.
      if (this.cloud.shareSaves.get(item.key)?.fid === record.fid) this.cloud.rememberShare(item.key, null);
      removed++; bytes += record.size || 0;
      } finally { this.deleting.delete(item.key); unlock(); }
    }
    this.last = { removed, bytes, at: Date.now(), reason }; return this.last;
  }
  invalidate() { this.controller.abort();if(!this.closed)this.controller = new AbortController(); clearTimeout(this.timer); }
  close() { this.closed=true;clearTimeout(this.timer); this.controller.abort(); return this.queue; }
}
module.exports = { QuarkCleanup };
