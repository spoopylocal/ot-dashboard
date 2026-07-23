
class Component extends DCLogic {
  state = { data: null, tab: 'tracker', query: '', zoneFilter: 'all', statusFilter: 'all', sortKey: null, sortDir: 1, sel: null, dark: false, barHover: null, cleared: {}, clearedAt: {}, now: 0, confirmClear: null, scrolled: false, noteEdit: null, noteText: '', noDice: null, noteHover: null, datePicker: null, copied: null, admin: null, viewers: 1, live: 'connecting' };

  componentDidMount() {
    const src = window.__OT_DATA ? Promise.resolve(window.__OT_DATA) : fetch('ot_data.json').then(r => r.json());
    Promise.resolve(this._initSupabase())
      .then(() => Promise.all([src, this._fetchEdits(), this._fetchConfig()]))
      .then(([d, edits, cfg]) => {
      this._seedRecords = (d.records || []).filter(r => r.zone && r.zone.trim());
      this._applyConfig(cfg);
      const records = this._composeRecords();
      this.setState({ data: { records }, sel: records.find(r => r.status) || records[0] || null });
      if (this._sb) { this._subscribeLive(); this._initPresence(); }
      else { this._setLive('offline'); }  // Supabase couldn't load — showing last-known local data.
    }).catch((e) => { console.warn(e); this._applyConfig(null); this.setState({ data: { records: [] } }); });
    // Realtime can silently die (proxy drops the WebSocket, laptop sleeps, etc.).
    // Reconcile from REST on focus/visibility/reconnect and on a slow poll so a
    // stalled client always catches back up to the datastore.
    this._onVisible = () => { if (!document.hidden) this._resync('visible'); };
    document.addEventListener('visibilitychange', this._onVisible);
    this._onFocus = () => this._resync('focus');
    window.addEventListener('focus', this._onFocus);
    this._onOnline = () => this._resync('online');
    window.addEventListener('online', this._onOnline);
    this._resyncTimer = setInterval(() => { if (!document.hidden) this._resync('poll'); }, 45000);
    this._onScroll = () => {
      const y = window.scrollY || document.documentElement.scrollTop || 0;
      const show = y > 400;
      if (show !== this.state.scrolled) this.setState({ scrolled: show });
    };
    window.addEventListener('scroll', this._onScroll, { passive: true });
    try { const dm = localStorage.getItem('ot-tracker-darkmode'); if (dm !== null) this.setState({ dark: dm === '1' }); } catch (e) {}
    // Hidden admin panel: Shift+B anywhere outside a form field.
    this._onKeyDown = (e) => {
      if (!(e.shiftKey && (e.key === 'B' || e.key === 'b'))) return;
      const t = document.activeElement;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable)) return;
      e.preventDefault();
      this.setState(s => s.admin ? { admin: null } : { admin: { stage: 'pw', section: 'versions', pw: '', err: '', busy: false, label: '', versions: [], confirm: null, view: null, secNotice: '', secConfirm: null, newStatus: '', newStatusColor: '#3aa76d', newOt: '', newBts: '', newZone: '', locQuery: '', newFieldLabel: '', newFieldType: 'text', newFieldOptions: '', wipeStage: null, wipePin: '', wipeErr: '' } });
    };
    window.addEventListener('keydown', this._onKeyDown);
    // Automated versioning: check shortly after load, then every 30 minutes.
    // Only writes a new version when the data actually changed (hash compare).
    this._backupSoonTimer = setTimeout(() => this._autoBackupCheck(), 10000);
    this._backupTimer = setInterval(() => this._autoBackupCheck(), 30 * 60 * 1000);
  }
  componentWillUnmount() {
    if (this._onScroll) window.removeEventListener('scroll', this._onScroll);
    if (this._onKeyDown) window.removeEventListener('keydown', this._onKeyDown);
    if (this._onVisible) document.removeEventListener('visibilitychange', this._onVisible);
    if (this._onFocus) window.removeEventListener('focus', this._onFocus);
    if (this._onOnline) window.removeEventListener('online', this._onOnline);
    clearInterval(this._resyncTimer);
    clearTimeout(this._backupSoonTimer);
    clearInterval(this._backupTimer);
    clearTimeout(this._wipeTimer);
    clearInterval(this._wipeTick);
  }

  // === Structure config (statuses / fields / locations) =================
  // Stored as one ot_edits meta row (__config__v1), like version backups, so
  // admins can reshape the tracker at runtime and it syncs to everyone. The
  // defaults below reproduce the original hard-coded look exactly.
  CFG_KEY = '__config__v1';
  DEFAULT_STATUSES = [
    { key: 'OT Completed',  label: 'OT Completed', color: 'var(--accent-green)',     kpi: true, sub: 'final state' },
    { key: 'BTS Completed', label: 'BTS Completed', color: 'var(--wwt-light-blue)',  kpi: true, sub: 'ready to move' },
    { key: 'In Progress',   label: 'In Progress',  color: 'var(--accent-amber)',     kpi: true, sub: 'active now' },
    { key: 'Issue/Hold',    label: 'Issue / Hold', color: 'var(--wwt-bright-red)',   kpi: true, sub: 'needs attention' },
    { key: 'WO entered',    label: 'WO entered',   color: 'var(--wwt-dark-blue-50)', derived: true },
    { key: 'DO NOT USE',    label: 'Do not use',   color: 'var(--gray-700)',         hazard: true },
    { key: 'Pending',       label: 'Empty',        color: 'var(--gray-200)',         reserved: true },
  ];
  DEFAULT_FIELDS = [
    { key: 'bts',    label: 'BTS Location', type: 'location', builtin: true },
    { key: 'ot',     label: 'OT Location',  type: 'location', builtin: true },
    { key: 'zone',   label: 'Zone',         type: 'zone',     builtin: true },
    { key: 'wo',     label: 'Work Order',   type: 'text',     builtin: true, dup: true },
    { key: 'serial', label: 'Serial',       type: 'text',     builtin: true, dup: true },
    { key: 'lpn',    label: 'LPN',          type: 'text',     builtin: true, dup: true },
    { key: 'status', label: 'Status',       type: 'status',   builtin: true },
    { key: 'date',   label: 'Date',         type: 'date',     builtin: true },
  ];
  // Fields whose values are stored per-location in the edits object and captured
  // by version backups: the editable columns (minus location/zone) plus the
  // always-present "note" (which is edited via its own modal, not a column).
  _bkFields() { return this._dataFields().map(f => f.key).concat('note'); }
  cfg = null;
  _defaultConfig() {
    return { statuses: this.DEFAULT_STATUSES.map(s => ({ ...s })),
             fields: this.DEFAULT_FIELDS.map(f => ({ ...f })),
             locations: { added: [], hidden: [], order: [] } };
  }
  // Merge a (possibly partial) stored config over the defaults and rebuild the
  // status lookup. Reserved/derived statuses (Empty, WO entered) are always
  // kept so norm()/eff() never lose their sentinels.
  _applyConfig(raw) {
    raw = raw || {};
    const cfg = this._defaultConfig();
    if (Array.isArray(raw.statuses) && raw.statuses.length) {
      const seen = {}; const list = raw.statuses.map(s => { seen[s.key] = 1; return { ...s }; });
      this.DEFAULT_STATUSES.forEach(d => { if ((d.reserved || d.derived) && !seen[d.key]) list.push({ ...d }); });
      cfg.statuses = list;
    }
    if (Array.isArray(raw.fields) && raw.fields.length) cfg.fields = raw.fields.map(f => ({ ...f }));
    if (raw.locations) cfg.locations = { added: raw.locations.added || [], hidden: raw.locations.hidden || [], order: raw.locations.order || [] };
    this.cfg = cfg;
    this._smap = {};
    cfg.statuses.forEach(s => { this._smap[s.key] = s; });
    return cfg;
  }
  _statusList() { return (this.cfg && this.cfg.statuses) || this.DEFAULT_STATUSES; }
  _fields() { return (this.cfg && this.cfg.fields) || this.DEFAULT_FIELDS; }
  _dataFields() { return this._fields().filter(f => f.type !== 'location' && f.type !== 'zone'); }
  get META() {
    if (this._smap) return this._smap;
    const m = {}; this._statusList().forEach(s => { m[s.key] = s; }); return m;
  }
  norm(s) { s = (s || '').trim(); return this.META[s] ? s : 'Pending'; }
  metaFor(s) { return this.META[this.norm(s)]; }
  // Effective state for the map/legend: a location with a work order but no
  // status yet counts (and now shows) as "WO entered" rather than empty.
  eff(r) { const s = this.norm(r.status); return (s === 'Pending' && (r.wo || '').trim()) ? 'WO entered' : s; }

  // Compose the visible location records from seed + config (added / hidden)
  // merged with the live edits. Used on load and whenever config changes.
  _composeRecords() {
    const cfg = this.cfg || this._defaultConfig();
    const hidden = new Set(cfg.locations.hidden || []);
    const added = (cfg.locations.added || []).map(a => ({ zone: a.zone, bts: a.bts, ot: a.ot, added: true }));
    const base = [...(this._seedRecords || []), ...added];
    return base.filter(r => !hidden.has(r.ot)).map(r => this._edits[r.ot] ? { ...r, ...this._edits[r.ot] } : r);
  }
  async _fetchConfig() {
    if (!this._sb) return null;
    try {
      const { data, error } = await this._sb.from('ot_edits').select('edits').eq('ot', this.CFG_KEY).maybeSingle();
      if (error) throw error;
      return data ? data.edits : null;
    } catch (e) { console.warn('Config read failed; using defaults.', e); return null; }
  }
  // Merge a patch into the config, persist the __config__v1 row, and re-render.
  async _saveConfig(patch) {
    this._applyConfig({ ...this.cfg, ...patch });
    this.setState(s => ({ data: { records: this._composeRecords() }, sel: s.sel && this._composeRecords().find(r => r.ot === s.sel.ot) || s.sel }));
    if (this._sb) {
      const { error } = await this._sb.from('ot_edits')
        .upsert({ ot: this.CFG_KEY, edits: this.cfg, updated_at: new Date().toISOString() }, { onConflict: 'ot' });
      if (error) console.warn('Config save failed.', error);
    }
  }

  // Resolve a status color to a hex a <input type=color> can show. Defaults are
  // CSS-var tokens; edited colors are stored as literal hex.
  COLOR_HEX = { 'var(--accent-green)': '#2E8B45', 'var(--wwt-light-blue)': '#0086EA', 'var(--accent-amber)': '#F2A900', 'var(--wwt-bright-red)': '#EE282A', 'var(--wwt-dark-blue-50)': '#7766B7', 'var(--gray-700)': '#2A2F36', 'var(--gray-200)': '#D6DAE0' };
  _hex(c) { if (!c) return '#888888'; if (c[0] === '#') return c; return this.COLOR_HEX[c] || '#888888'; }

  // --- Admin config mutations (statuses / locations) --------------------
  _cfgStatusColor(key, hex) { this._saveConfig({ statuses: this.cfg.statuses.map(s => s.key === key ? { ...s, color: hex } : s) }); }
  _cfgStatusLabel(key, label) { this._saveConfig({ statuses: this.cfg.statuses.map(s => s.key === key ? { ...s, label: label } : s) }); }
  _cfgStatusMove(key, dir) {
    const l = this.cfg.statuses.map(s => ({ ...s }));
    const i = l.findIndex(s => s.key === key), j = i + dir;
    if (i < 0 || j < 0 || j >= l.length) return;
    const t = l[i]; l[i] = l[j]; l[j] = t;
    this._saveConfig({ statuses: l });
  }
  _cfgStatusRemove(key) {
    const s = this._smap[key];
    if (!s || s.reserved || s.derived) { this._adminSet({ secNotice: 'That status can’t be removed.' }); return; }
    this._saveConfig({ statuses: this.cfg.statuses.filter(x => x.key !== key) });
    this._adminSet({ secConfirm: null });
  }
  _cfgStatusAdd() {
    const a = this.state.admin || {}; const name = (a.newStatus || '').trim();
    if (!name) return;
    if (this._smap[name]) { this._adminSet({ secNotice: 'A status with that name already exists.' }); return; }
    this._saveConfig({ statuses: this.cfg.statuses.concat([{ key: name, label: name, color: a.newStatusColor || '#3aa76d' }]) });
    this._adminSet({ newStatus: '', secNotice: '' });
  }
  _cfgLocationAdd() {
    const a = this.state.admin || {}; const ot = (a.newOt || '').trim();
    if (!ot) return;
    const exists = (this._seedRecords || []).some(r => r.ot === ot) || (this.cfg.locations.added || []).some(x => x.ot === ot);
    if (exists) { this._adminSet({ secNotice: 'That OT location already exists.' }); return; }
    const added = (this.cfg.locations.added || []).concat([{ ot, bts: (a.newBts || '').trim(), zone: (a.newZone || '').trim() || '0000' }]);
    this._saveConfig({ locations: { ...this.cfg.locations, added } });
    this._adminSet({ newOt: '', newBts: '', newZone: '', secNotice: '' });
  }
  _cfgLocationHide(ot, hide) {
    let hidden = (this.cfg.locations.hidden || []).slice();
    if (hide) { if (hidden.indexOf(ot) === -1) hidden.push(ot); } else { hidden = hidden.filter(x => x !== ot); }
    this._saveConfig({ locations: { ...this.cfg.locations, hidden } });
  }
  // Full location order (seed + added), applying any saved custom order and
  // appending anything not yet ranked. This is the map's within-zone slot order.
  _orderedLocationKeys() {
    const all = [...(this._seedRecords || []).map(r => r.ot), ...((this.cfg.locations.added || []).map(a => a.ot))];
    const saved = (this.cfg.locations.order || []).filter(k => all.indexOf(k) !== -1);
    const seen = new Set(saved);
    return saved.concat(all.filter(k => !seen.has(k)));
  }
  _cfgLocationReorder(dragOt, dropOt) {
    if (!dragOt || dragOt === dropOt) return;
    const order = this._orderedLocationKeys();
    const from = order.indexOf(dragOt), to = order.indexOf(dropOt);
    if (from < 0 || to < 0) return;
    order.splice(to, 0, order.splice(from, 1)[0]);
    this._saveConfig({ locations: { ...this.cfg.locations, order } });
  }
  _cfgFieldMove(key, dir) {
    const l = this.cfg.fields.map(f => ({ ...f }));
    const i = l.findIndex(f => f.key === key), j = i + dir;
    if (i < 0 || j < 0 || j >= l.length) return;
    const t = l[i]; l[i] = l[j]; l[j] = t;
    this._saveConfig({ fields: l });
  }
  _cfgFieldDup(key) { this._saveConfig({ fields: this.cfg.fields.map(f => f.key === key ? { ...f, dup: !f.dup } : f) }); }
  _cfgFieldRemove(key) {
    const f = this.cfg.fields.find(x => x.key === key);
    if (!f || f.builtin) { this._adminSet({ secNotice: 'Built-in columns can’t be removed.' }); return; }
    this._saveConfig({ fields: this.cfg.fields.filter(x => x.key !== key) });
    this._adminSet({ secConfirm: null });
  }
  _cfgStatusKpi(key) { this._saveConfig({ statuses: this.cfg.statuses.map(s => s.key === key ? { ...s, kpi: !s.kpi } : s) }); }
  // Drag-and-drop reorder for a config list ('statuses' or 'fields').
  _cfgReorder(list, dragKey, dropKey) {
    if (!dragKey || dragKey === dropKey) return;
    const arr = (this.cfg[list] || []).map(x => ({ ...x }));
    const from = arr.findIndex(x => x.key === dragKey), to = arr.findIndex(x => x.key === dropKey);
    if (from < 0 || to < 0) return;
    const moved = arr.splice(from, 1)[0];
    arr.splice(to, 0, moved);
    this._saveConfig({ [list]: arr });
  }
  _cfgFieldAdd() {
    const a = this.state.admin || {}; const label = (a.newFieldLabel || '').trim();
    if (!label) return;
    const type = a.newFieldType || 'text';
    const base = 'f_' + label.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '');
    let key = base, n = 2; while (this.cfg.fields.some(f => f.key === key)) key = base + '_' + (n++);
    const field = { key, label, type };
    if (type === 'select') field.options = (a.newFieldOptions || '').split(',').map(s => s.trim()).filter(Boolean);
    this._saveConfig({ fields: this.cfg.fields.concat([field]) });
    this._adminSet({ newFieldLabel: '', newFieldOptions: '', secNotice: '' });
  }

  LS_KEY = 'ot-tracker-edits-v1';
  _edits = {};

  // === Shared live backend (Supabase) ===================================
  // The anon key is meant to be public in client code; access is limited by
  // Row Level Security policies on the ot_edits table.
  SB_URL = 'https://ufsszfghfbgclrtlzknf.supabase.co';
  SB_KEY = 'sb_publishable_RdP1sAi9b6N1VbFHsJZLbw_yhcJmjRZ';
  // ======================================================================

  _sbConfigured() { return this.SB_URL.indexOf('YOUR-PROJECT') === -1; }

  async _initSupabase() {
    if (!this._sbConfigured()) return;
    try {
      if (!window.supabase) {
        await new Promise((res, rej) => {
          const s = document.createElement('script');
          s.src = 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2';
          s.onload = res; s.onerror = rej;
          document.head.appendChild(s);
        });
      }
      this._sb = window.supabase.createClient(this.SB_URL, this.SB_KEY);
    } catch (e) { console.warn('Supabase init failed; using local storage only.', e); this._sb = null; }
  }

  async _fetchEdits() {
    if (this._sb) {
      try {
        const { data, error } = await this._sb.from('ot_edits').select('ot,edits');
        if (error) throw error;
        const map = {};
        // Rows keyed "__..." are meta rows (version backups, connection tests),
        // not locations — keep them out of the edits map.
        (data || []).forEach(row => { if ((row.ot || '').indexOf('__') !== 0) map[row.ot] = row.edits || {}; });
        this._edits = map;
        return map;
      } catch (e) { console.warn('Supabase read failed; falling back to local storage.', e); }
    }
    try { this._edits = JSON.parse(localStorage.getItem(this.LS_KEY)) || {}; } catch (e) { this._edits = {}; }
    return this._edits;
  }

  _subscribeLive() {
    if (!this._sb || this._sbChannel) return;
    this._sbChannel = this._sb
      .channel('ot_edits_live')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'ot_edits' }, payload => {
        const row = (payload.new && payload.new.ot) ? payload.new : payload.old;
        if (!row || !row.ot) return;
        const ot = row.ot;
        if (ot === this.CFG_KEY) { // structure config changed elsewhere — apply + re-render
          this._applyConfig((payload.new && payload.new.edits) || {});
          this.setState(s => ({ data: { records: this._composeRecords() } }));
          return;
        }
        if (ot.indexOf('__') === 0) return; // other meta rows (backups etc.) are not locations
        // Never judge staleness by comparing updated_at against our own writes:
        // that timestamp comes from the writer's machine clock, and clock skew
        // between machines made clients ignore each other's changes until a full
        // page reload. Instead: skip rows the user is editing right now (their
        // debounced save lands shortly), skip echoes/no-ops (identical content),
        // and skip rows we wrote moments ago (a delayed echo of our own earlier
        // value must not revert a newer local change). Anything a skip leaves
        // stale is reconciled by the next _resync — the datastore wins there.
        const edits = (payload.new && payload.new.edits) || {};
        if ((this._saveTimers || {})[ot]) return;
        if (this._sameEdits(this._edits[ot], edits)) return;
        if (this._recentWrite(ot)) return;
        this._edits[ot] = edits;
        this.setState(s => {
          if (!s.data) return {};
          const records = s.data.records.map(r => r.ot === ot ? { ...r, ...edits } : r);
          const sel = s.sel && s.sel.ot === ot ? { ...s.sel, ...edits } : s.sel;
          return { data: { ...s.data, records }, sel };
        });
      })
      .subscribe((status) => {
        // Realtime runs over a WebSocket, which corporate proxies often drop or
        // idle-timeout. Don't trust push alone: whenever the channel (re)connects
        // pull a fresh snapshot over REST so we catch anything missed while down.
        if (status === 'SUBSCRIBED') { this._setLive('live'); this._resync('subscribed'); }
        else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') { this._setLive('reconnecting'); }
      });
  }

  _setLive(s) { if (s !== this.state.live) this.setState({ live: s }); }

  // Reconcile local state with the datastore over REST (which stays reachable
  // even when the realtime WebSocket is blocked). Safe to call often: it never
  // clobbers an edit we applied more recently or one the user is still typing.
  async _resync(reason) {
    if (!this._sb || this._resyncing) return;
    this._resyncing = true;
    try {
      const { data, error } = await this._sb.from('ot_edits').select('ot,edits');
      if (error) throw error;
      const pending = this._saveTimers || {};
      const next = {};
      let cfgRow = null;
      (data || []).forEach(row => {
        const ot = row.ot || '';
        if (ot === this.CFG_KEY) { cfgRow = row.edits || {}; return; }
        if (ot.indexOf('__') === 0) return;
        // Keep our local value only while the user is mid-edit here or we wrote
        // this row seconds ago (the save may still be in flight). Otherwise the
        // datastore is the source of truth — no timestamp comparison: row
        // timestamps come from other machines' clocks, and trusting them made a
        // client with a fast clock ignore every slower writer until a reload.
        if (pending[ot] || this._recentWrite(ot)) {
          next[ot] = this._edits[ot] || row.edits || {};
          return;
        }
        next[ot] = row.edits || {};
      });
      // Rows we're editing that the server doesn't have yet (first save still
      // in flight) must survive the rebuild too.
      Object.keys(this._edits).forEach(ot => {
        if (ot.indexOf('__') === 0) return;
        if (next[ot] === undefined && (pending[ot] || this._recentWrite(ot))) next[ot] = this._edits[ot];
      });
      this._edits = next;
      if (cfgRow) this._applyConfig(cfgRow);
      this.setState(s => {
        if (!s.data) return {};
        const records = this._composeRecords();
        const sel = s.sel ? (records.find(x => x.ot === s.sel.ot) || s.sel) : s.sel;
        return { data: { records }, sel };
      });
      try { localStorage.setItem(this.LS_KEY, JSON.stringify(this._edits)); } catch (e) {}
    } catch (e) { console.warn('Resync failed (' + reason + ').', e); }
    finally { this._resyncing = false; }
  }

  loadEdits() { return this._edits; }

  // How long a local write protects its row from being overwritten by realtime
  // events or a resync. Long enough to cover an in-flight upsert and its echo;
  // short enough that another client's genuine change lands by the next resync.
  RECENT_WRITE_MS = 5000;
  _recentWrite(ot) { return !!(this._localWriteAt && this._localWriteAt[ot] && Date.now() - this._localWriteAt[ot] < this.RECENT_WRITE_MS); }
  // Order-insensitive equality for two edits objects (Postgres jsonb reorders
  // keys, so a stringify compare would call our own echoes "different").
  // A missing field and an empty one are the same thing everywhere in the app.
  _sameEdits(a, b) {
    a = a || {}; b = b || {};
    const keys = Object.keys(a).concat(Object.keys(b));
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const av = a[k] == null ? '' : String(a[k]);
      const bv = b[k] == null ? '' : String(b[k]);
      if (av !== bv) return false;
    }
    return true;
  }

  // Write the current edits for one OT to local storage + Supabase.
  _persist(ot) {
    try { localStorage.setItem(this.LS_KEY, JSON.stringify(this._edits)); } catch (err) {}
    if (this._sb) {
      // Local-clock stamp, only ever compared against this machine's clock.
      this._localWriteAt = this._localWriteAt || {};
      this._localWriteAt[ot] = Date.now();
      this._sb.from('ot_edits')
        .upsert({ ot: ot, edits: this._edits[ot], updated_at: new Date().toISOString() }, { onConflict: 'ot' })
        .then(({ error }) => { if (error) console.warn('Supabase save failed.', error); });
    }
  }

  // Immediate save — used for discrete actions (e.g. clearing a row).
  saveEdit(ot, field, value) {
    this._edits[ot] = this._edits[ot] || {};
    this._edits[ot][field] = value;
    this._persist(ot);
  }

  // Debounced save — used while typing so we write once the user pauses,
  // not on every keystroke (avoids per-keystroke network/storage lag).
  _queueSave(ot) {
    this._saveTimers = this._saveTimers || {};
    clearTimeout(this._saveTimers[ot]);
    this._saveTimers[ot] = setTimeout(() => { delete this._saveTimers[ot]; this._persist(ot); }, 500);
  }

  // --- Live presence: "someone is editing" + live viewer count ----------
  _initPresence() {
    if (!this._sb || this._presence) return;
    // Unique per-tab key so each open viewer is counted once.
    this._presenceKey = 'v_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    this._presence = this._sb.channel('ot_presence', {
      config: { broadcast: { self: false }, presence: { key: this._presenceKey } }
    });
    this._presence.on('broadcast', { event: 'editing' }, ({ payload }) => {
      if (!payload || !payload.ot) return;
      const editing = { ...(this.state.editing || {}) };
      editing[payload.ot] = { exp: Date.now() + 3000, field: payload.field || '' };
      this.setState({ editing });
      if (!this._expireTimer) this._expireTimer = setInterval(() => this._sweepEditing(), 1000);
    });
    // Presence sync fires whenever anyone joins or leaves — recount viewers.
    this._presence.on('presence', { event: 'sync' }, () => {
      try {
        const state = this._presence.presenceState();
        const n = Object.keys(state).length;
        if (n && n !== this.state.viewers) this.setState({ viewers: n });
      } catch (e) {}
    });
    this._presence.subscribe(status => {
      if (status === 'SUBSCRIBED') {
        this._presence.track({ online_at: Date.now() }).catch(() => {});
      }
    });
  }
  _sweepEditing() {
    const cur = this.state.editing || {};
    const now = Date.now();
    const next = {};
    let changed = false;
    Object.keys(cur).forEach(k => { if (cur[k] && cur[k].exp > now) { next[k] = cur[k]; } else { changed = true; } });
    if (changed) this.setState({ editing: next });
    if (Object.keys(next).length === 0 && this._expireTimer) { clearInterval(this._expireTimer); this._expireTimer = null; }
  }
  _broadcastEditing(ot, field) {
    if (!this._presence) return;
    this._bcastAt = this._bcastAt || {};
    const now = Date.now();
    // throttle per ot+field so switching fields updates the label promptly
    const k = ot + '|' + (field || '');
    if (now - (this._bcastAt[k] || 0) < 250) return;
    this._bcastAt[k] = now;
    try { this._presence.send({ type: 'broadcast', event: 'editing', payload: { ot: ot, field: field || '' } }); } catch (e) {}
  }
  _fieldLabel(f) {
    return ({ wo: 'WO', serial: 'Serial', lpn: 'LPN', status: 'Status', date: 'Date', note: 'Note' })[f] || 'this row';
  }

  // === Versioned backups ================================================
  // Snapshots live in the same ot_edits table as rows keyed
  // "__backup__<timestamp>", so no extra Supabase setup is needed. The app
  // ignores "__"-prefixed rows everywhere it deals with locations.
  BK_PREFIX = '__backup__';
  // Minimum time between AUTOMATIC backups, enforced against the shared table's
  // most-recent backup — so no matter how many devices are open or how often
  // the page is reloaded, auto-backups happen at most once per this window.
  // Manual "Create save" is never throttled. (30 minutes.)
  BK_MIN_GAP_MS = 30 * 60 * 1000;
  // Hash of the admin password (default: "wwtadmin"). To change it, run:
  //   node -e "const pw='NEWPASSWORD';const f=(s,se,m)=>{let h=se>>>0;for(let i=0;i<s.length;i++)h=Math.imul(h^s.charCodeAt(i),m)>>>0;return('0000000'+h.toString(16)).slice(-8)};console.log(f(pw,0x811c9dc5,16777619)+f(pw,0x01000193,2166136261))"
  // and paste the output here. (Client-side gate — deters casual users, not attackers.)
  ADMIN_PW_HASH = '84919d347e05bb94';
  // Passphrase required to confirm a full sheet wipe (hash-stored, same
  // client-side _pwHash gate as the admin password — deters casual misclicks
  // and is long enough that the hash can't be brute-forced like a short PIN).
  WIPE_PIN_HASH = 'b5cfdaa566cf686b';

  _pwHash(s) {
    const fnv = (seed, mul) => { let h = seed >>> 0; for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), mul) >>> 0; return ('0000000' + h.toString(16)).slice(-8); };
    return fnv(0x811c9dc5, 16777619) + fnv(0x01000193, 2166136261);
  }

  // Canonical snapshot of all non-empty location edits, with sorted keys so
  // identical states always hash identically.
  _canonSnapshot() {
    const snap = {};
    Object.keys(this._edits).sort().forEach(ot => {
      if (ot.indexOf('__') === 0) return;
      const e = this._edits[ot] || {};
      const row = {};
      let any = false;
      this._bkFields().forEach(f => { const v = (e[f] == null ? '' : String(e[f])); row[f] = v; if (v.trim()) any = true; });
      if (any) snap[ot] = row;
    });
    return snap;
  }

  _snapHash(snap) {
    const s = JSON.stringify(snap);
    let h1 = 0x811c9dc5 >>> 0, h2 = 0x01000193 >>> 0;
    for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619) >>> 0; h2 = Math.imul(h2 ^ c, 2166136261) >>> 0; }
    return ('0000000' + h1.toString(16)).slice(-8) + ('0000000' + h2.toString(16)).slice(-8);
  }

  async _saveBackup(kind, label) {
    const snap = this._canonSnapshot();
    const hash = this._snapHash(snap);
    const key = this.BK_PREFIX + Date.now();
    const edits = { kind, label: label || '', hash, rows: Object.keys(snap).length, snapshot: snap };
    const { error } = await this._sb.from('ot_edits').upsert({ ot: key, edits, updated_at: new Date().toISOString() }, { onConflict: 'ot' });
    if (error) throw error;
  }

  async _autoBackupCheck() {
    if (!this._sb || !this.state.data || this._backupBusy) return;
    this._backupBusy = true;
    try {
      const hash = this._snapHash(this._canonSnapshot());
      const { data, error } = await this._sb.from('ot_edits')
        .select('ot,updated_at,hash:edits->>hash')
        .like('ot', this.BK_PREFIX + '%')
        .order('updated_at', { ascending: false })
        .limit(1);
      if (error) throw error;
      const latest = (data && data[0]) || null;
      if (latest) {
        if (latest.hash === hash) return; // no changes since last version
        // Data changed, but throttle: skip if the last backup is too recent.
        // This gap is checked against the shared table, so many open tabs /
        // frequent reloads can't each spawn their own backup.
        const age = Date.now() - new Date(latest.updated_at).getTime();
        if (age < this.BK_MIN_GAP_MS) return;
      }
      await this._saveBackup('auto', latest ? '' : 'Initial baseline');
    } catch (e) { console.warn('Auto backup failed.', e); }
    finally { this._backupBusy = false; }
  }

  // --- Admin panel actions ----------------------------------------------
  _adminSet(patch) { this.setState(s => s.admin ? { admin: { ...s.admin, ...patch } } : {}); }

  async _adminUnlock() {
    const a = this.state.admin;
    if (!a || a.busy) return;
    if (this._pwHash(a.pw || '') !== this.ADMIN_PW_HASH) { this._adminSet({ err: 'Wrong password.', pw: '' }); return; }
    this._adminSet({ stage: 'list', err: '', pw: '' });
    await this._adminRefresh();
  }

  async _adminRefresh() {
    this._adminSet({ busy: true });
    let versions = [];
    if (this._sb) {
      const { data, error } = await this._sb.from('ot_edits')
        .select('ot,updated_at,kind:edits->>kind,label:edits->>label,hash:edits->>hash,rows:edits->>rows')
        .like('ot', this.BK_PREFIX + '%')
        .order('updated_at', { ascending: false });
      if (error) console.warn('Version list failed.', error); else versions = data || [];
    }
    this._adminSet({ busy: false, versions, confirm: null });
  }

  async _adminSave() {
    const a = this.state.admin;
    if (!a || a.busy || !this._sb) return;
    this._adminSet({ busy: true });
    try { await this._saveBackup('manual', (a.label || '').trim()); } catch (e) { console.warn('Save failed.', e); }
    this._adminSet({ label: '' });
    await this._adminRefresh();
  }

  async _adminDelete(key) {
    if (!this._sb) return;
    this._adminSet({ busy: true });
    // .select() returns the deleted rows — zero rows back means RLS silently
    // blocked the delete (the table needs a DELETE policy).
    const { data, error } = await this._sb.from('ot_edits').delete().eq('ot', key).select('ot');
    if (error || !data || data.length === 0) {
      console.warn('Delete failed.', error || 'RLS blocked the delete (0 rows).');
      this._adminSet({ notice: 'Delete was blocked by Supabase — the ot_edits table needs a DELETE policy for backup rows (see README).' });
    }
    await this._adminRefresh();
  }

  async _adminView(key) {
    if (!this._sb) return;
    this._adminSet({ busy: true });
    const { data, error } = await this._sb.from('ot_edits').select('ot,updated_at,edits').eq('ot', key).single();
    if (error || !data) { console.warn('Load version failed.', error); this._adminSet({ busy: false }); return; }
    const meta = data.edits || {};
    const snap = meta.snapshot || {};
    const cur = this._canonSnapshot();
    // Restoring makes current data match the version, so for each field:
    //   from = the current (live) value   →   to = the version value.
    const diffs = [];
    let nFill = 0, nClear = 0, nChange = 0;
    [...new Set([...Object.keys(snap), ...Object.keys(cur)])].sort().forEach(ot => {
      const v = snap[ot] || {}, c = cur[ot] || {};
      const fields = [];
      this._bkFields().forEach(f => {
        const to = (v[f] || '').toString().trim();      // version value (after restore)
        const from = (c[f] || '').toString().trim();    // current value (now)
        if (from === to) return;
        const change = !from ? 'add' : (!to ? 'remove' : 'change');
        fields.push({ label: this._fieldLabel(f), from, to, change,
          fromShow: from || '—', toShow: to || '—' });
      });
      if (!fields.length) return;
      const inVer = Object.keys(v).some(f => (v[f] || '').toString().trim());
      const inCur = Object.keys(c).some(f => (c[f] || '').toString().trim());
      let lockind, lockLabel;
      if (!inCur && inVer) { lockind = 'fill'; lockLabel = 'Will restore'; nFill++; }
      else if (inCur && !inVer) { lockind = 'clear'; lockLabel = 'Will clear'; nClear++; }
      else { lockind = 'change'; lockLabel = 'Will change'; nChange++; }
      diffs.push({ ot, loc: this.shortLoc(ot), bts: c.bts || v.bts || '', lockind, lockLabel, fields });
    });
    this._adminSet({ busy: false, view: {
      key, when: data.updated_at, kind: meta.kind || 'auto', label: meta.label || '',
      rows: Object.keys(snap).length, diffs, nFill, nClear, nChange } });
  }

  // Overwrite the live table with a version's snapshot. Locations absent from
  // the snapshot are cleared. A safety copy of the current state is versioned
  // first, so a restore is always undoable.
  async _adminRestore(key) {
    if (!this._sb) return;
    this._adminSet({ busy: true });
    try {
      const { data, error } = await this._sb.from('ot_edits').select('ot,edits').eq('ot', key).single();
      if (error || !data) throw error || new Error('version not found');
      const snap = (data.edits && data.edits.snapshot) || {};
      await this._saveBackup('auto', 'Pre-restore safety copy');
      const ts = Date.now();
      const iso = new Date(ts).toISOString();
      const rows = [];
      this._localWriteAt = this._localWriteAt || {};
      [...new Set([...Object.keys(snap), ...Object.keys(this._canonSnapshot())])].forEach(ot => {
        const target = {};
        this._bkFields().forEach(f => { target[f] = (snap[ot] && snap[ot][f]) || ''; });
        rows.push({ ot, edits: target, updated_at: iso });
        this._localWriteAt[ot] = ts;
        this._edits[ot] = target;
      });
      if (rows.length) {
        const { error: e2 } = await this._sb.from('ot_edits').upsert(rows, { onConflict: 'ot' });
        if (e2) throw e2;
      }
      try { localStorage.setItem(this.LS_KEY, JSON.stringify(this._edits)); } catch (e) {}
      this.setState(s => {
        if (!s.data) return {};
        const records = s.data.records.map(r => this._edits[r.ot] ? { ...r, ...this._edits[r.ot] } : r);
        const sel = s.sel ? (records.find(x => x.ot === s.sel.ot) || s.sel) : s.sel;
        return { data: { ...s.data, records }, sel };
      });
      this._adminSet({ view: null });
    } catch (e) { console.warn('Restore failed.', e); }
    await this._adminRefresh();
  }

  // --- Full sheet wipe (admin danger zone) -------------------------------
  // Clears every location's entries in one bulk write. Two safety nets: a
  // "Pre-wipe safety copy" version is saved first, and the pre-wipe edits are
  // kept in memory for a 60-second one-click undo.
  async _adminWipe() {
    const a = this.state.admin;
    if (!a || a.busy) return;
    if (this._pwHash((a.wipePin || '').trim()) !== this.WIPE_PIN_HASH) {
      this._adminSet({ wipeErr: 'Wrong passphrase — the sheet was not wiped.', wipePin: '' });
      return;
    }
    this._adminSet({ busy: true, wipeErr: '' });
    try {
      const undo = JSON.parse(JSON.stringify(this._edits));
      if (this._sb) await this._saveBackup('manual', 'Pre-wipe safety copy');
      const ts = Date.now();
      const iso = new Date(ts).toISOString();
      const blank = {}; this._bkFields().forEach(f => { blank[f] = ''; });
      const rows = [];
      this._localWriteAt = this._localWriteAt || {};
      ((this.state.data && this.state.data.records) || []).forEach(r => {
        rows.push({ ot: r.ot, edits: { ...blank }, updated_at: iso });
        this._localWriteAt[r.ot] = ts;
      });
      if (this._sb && rows.length) {
        const { error } = await this._sb.from('ot_edits').upsert(rows, { onConflict: 'ot' });
        if (error) throw error;
      }
      rows.forEach(r => { this._edits[r.ot] = r.edits; });
      try { localStorage.setItem(this.LS_KEY, JSON.stringify(this._edits)); } catch (e) {}
      this._wipeUndo = undo;
      this.setState(s => {
        const records = this._composeRecords();
        const sel = s.sel ? (records.find(x => x.ot === s.sel.ot) || s.sel) : s.sel;
        return { data: { records }, sel, wipedAt: ts, now: ts };
      });
      this._adminSet({ busy: false, wipeStage: null, wipePin: '' });
      clearTimeout(this._wipeTimer);
      this._wipeTimer = setTimeout(() => { this._wipeUndo = null; this.setState({ wipedAt: null }); }, 60000);
      if (!this._wipeTick) this._wipeTick = setInterval(() => {
        if (!this.state.wipedAt) { clearInterval(this._wipeTick); this._wipeTick = null; return; }
        this.setState({ now: Date.now() });
      }, 1000);
    } catch (e) {
      console.warn('Wipe failed.', e);
      this._adminSet({ busy: false, wipeErr: 'Wipe failed — nothing was changed. Check the connection and try again.' });
    }
  }
  async _adminWipeUndo() {
    if (!this._wipeUndo) return;
    const a = this.state.admin;
    if (a && a.busy) return;
    this._adminSet({ busy: true, wipeErr: '' });
    try {
      const snap = this._wipeUndo;
      const ts = Date.now();
      const iso = new Date(ts).toISOString();
      const rows = [];
      this._localWriteAt = this._localWriteAt || {};
      // Every wiped row gets its pre-wipe edits back; rows that had no edits
      // before the wipe go back to {} (i.e. the seed values show again).
      Object.keys(this._edits).forEach(ot => {
        rows.push({ ot, edits: snap[ot] || {}, updated_at: iso });
        this._localWriteAt[ot] = ts;
      });
      if (this._sb && rows.length) {
        const { error } = await this._sb.from('ot_edits').upsert(rows, { onConflict: 'ot' });
        if (error) throw error;
      }
      rows.forEach(r => { this._edits[r.ot] = r.edits; });
      try { localStorage.setItem(this.LS_KEY, JSON.stringify(this._edits)); } catch (e) {}
      this._wipeUndo = null;
      clearTimeout(this._wipeTimer);
      this.setState(s => {
        const records = this._composeRecords();
        const sel = s.sel ? (records.find(x => x.ot === s.sel.ot) || s.sel) : s.sel;
        return { data: { records }, sel, wipedAt: null };
      });
      this._adminSet({ busy: false });
    } catch (e) {
      console.warn('Wipe undo failed.', e);
      this._adminSet({ busy: false, wipeErr: 'Restore failed — try again (the undo window is still open).' });
    }
  }

  _fmtWhen(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    const MN = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    let h = d.getHours(); const am = h < 12 ? 'AM' : 'PM'; h = h % 12 || 12;
    return MN[d.getMonth()] + ' ' + d.getDate() + ', ' + d.getFullYear() + ' · ' + h + ':' + String(d.getMinutes()).padStart(2, '0') + ' ' + am;
  }

  // Flat template bindings for the admin panel.
  _adminUI() {
    const a = this.state.admin;
    const btnBase = 'font-family:var(--font-sans);font-size:12px;font-weight:700;padding:6px 12px;border-radius:4px;cursor:pointer;white-space:nowrap;';
    if (!a) return { showAdmin: false, adminPwStage: false, adminUnlocked: false, adminViewStage: false, adminSecVersions: false, adminSecStatuses: false, adminSecLocations: false, adminSecFields: false, adminNav: [], adminVersions: [], adminDiffs: [], adminStatuses: [], adminLocations: [], adminFields: [], adminWipeIdle: false, adminWipeConfirming: false, adminWiped: false, adminWipeSecs: 0, adminWipePin: '', adminWipeErr: '' };
    const view = a.view;
    return {
      showAdmin: true,
      onAdminClose: () => this.setState({ admin: null }),
      adminPwStage: a.stage === 'pw',
      adminUnlocked: a.stage === 'list',
      adminViewStage: a.stage === 'list' && !!view,
      adminSecVersions: a.stage === 'list' && !view && a.section === 'versions',
      adminSecStatuses: a.stage === 'list' && !view && a.section === 'statuses',
      adminSecLocations: a.stage === 'list' && !view && a.section === 'locations',
      adminSecFields: a.stage === 'list' && !view && a.section === 'fields',
      adminSecNotice: a.secNotice || '',
      adminNav: ['versions', 'statuses', 'locations', 'fields'].map(k => ({ key: k, label: ({ versions: 'Version history', statuses: 'Statuses', locations: 'Locations', fields: 'Fields' })[k], active: a.section === k,
        onClick: () => this._adminSet({ section: k, secNotice: '', secConfirm: null, view: null }),
        style: `background:none;border:none;border-bottom:2px solid ${a.section === k ? 'var(--wwt-bright-red)' : 'transparent'};color:${a.section === k ? 'var(--text)' : 'var(--faint)'};font-family:var(--font-sans);font-size:12.5px;font-weight:700;padding:8px 12px;cursor:pointer;white-space:nowrap;` })),
      adminErr: a.err || '',
      adminBusy: !!a.busy,
      adminPwVal: a.pw || '',
      onAdminPwInput: (e) => this._adminSet({ pw: e.target.value, err: '' }),
      onAdminPwKey: (e) => { if (e.key === 'Enter') this._adminUnlock(); },
      onAdminUnlock: () => this._adminUnlock(),
      // Danger zone: full sheet wipe (PIN-confirmed) + 60s undo countdown.
      adminWiped: !!this.state.wipedAt,
      adminWipeSecs: this.state.wipedAt ? Math.max(0, Math.ceil((60000 - (this.state.now - this.state.wipedAt)) / 1000)) : 0,
      adminWipeConfirming: !this.state.wipedAt && a.wipeStage === 'confirm',
      adminWipeIdle: !this.state.wipedAt && a.wipeStage !== 'confirm',
      adminWipePin: a.wipePin || '',
      adminWipeErr: a.wipeErr || '',
      onAdminWipeStart: () => this._adminSet({ wipeStage: 'confirm', wipePin: '', wipeErr: '' }),
      onAdminWipeCancel: () => this._adminSet({ wipeStage: null, wipePin: '', wipeErr: '' }),
      onAdminWipeConfirm: () => this._adminWipe(),
      onAdminWipeUndo: () => this._adminWipeUndo(),
      onAdminWipePinInput: (e) => this._adminSet({ wipePin: e.target.value.slice(0, 64), wipeErr: '' }),
      onAdminWipePinKey: (e) => { if (e.key === 'Enter') this._adminWipe(); },
      adminLabel: a.label || '',
      onAdminLabelInput: (e) => this._adminSet({ label: e.target.value.slice(0, 60) }),
      onAdminLabelKey: (e) => { if (e.key === 'Enter') this._adminSave(); },
      onAdminSave: () => { this._adminSet({ notice: '' }); this._adminSave(); },
      onAdminRefresh: () => { this._adminSet({ notice: '' }); this._adminRefresh(); },
      adminNotice: a.notice || '',
      adminCount: (a.versions || []).length,
      adminEmpty: !a.busy && (a.versions || []).length === 0,
      adminVersions: (a.versions || []).map(v => {
        const confirmR = a.confirm === 'restore:' + v.ot;
        const confirmD = a.confirm === 'delete:' + v.ot;
        const manual = v.kind === 'manual';
        return {
          key: v.ot,
          when: this._fmtWhen(v.updated_at),
          kind: manual ? 'MANUAL' : 'AUTO',
          kindStyle: 'font-family:var(--font-mono);font-size:9px;font-weight:800;letter-spacing:0.06em;padding:2px 7px;border-radius:999px;' + (manual ? 'background:var(--wwt-blue-tint);color:var(--wwt-dark-blue);' : 'background:var(--surface-2);color:var(--faint);border:1px solid var(--line);'),
          label: v.label || (manual ? 'Manual save' : 'Auto backup'),
          rows: (v.rows || 0) + ' filled',
          confirming: confirmR || confirmD,
          onView: () => this._adminView(v.ot),
          onRestore: () => confirmR ? this._adminRestore(v.ot) : this._adminSet({ confirm: 'restore:' + v.ot }),
          onDelete: () => confirmD ? this._adminDelete(v.ot) : this._adminSet({ confirm: 'delete:' + v.ot }),
          onCancelConfirm: () => this._adminSet({ confirm: null }),
          restoreLabel: confirmR ? 'Confirm restore?' : 'Restore',
          deleteLabel: confirmD ? 'Confirm delete?' : 'Delete',
          restoreStyle: btnBase + (confirmR ? 'border:none;background:var(--wwt-dark-blue);color:#fff;' : 'border:1px solid var(--line-strong);background:var(--surface);color:var(--wwt-blue);'),
          deleteStyle: btnBase + (confirmD ? 'border:none;background:var(--wwt-bright-red);color:#fff;' : 'border:1px solid var(--line-strong);background:var(--surface);color:var(--wwt-red-deep);'),
        };
      }),
      adminViewWhen: view ? this._fmtWhen(view.when) : '',
      adminViewLabel: view ? (view.label || (view.kind === 'manual' ? 'Manual save' : 'Auto backup')) : '',
      adminViewRows: view ? view.rows + ' filled locations in this version' : '',
      adminViewSame: view ? view.diffs.length === 0 : false,
      adminHasDiffs: view ? view.diffs.length > 0 : false,
      adminDiffCount: view ? (view.diffs.length + ' location' + (view.diffs.length === 1 ? '' : 's') + ' would change if you restore this version') : '',
      // Headline summary chips (only shown when non-zero).
      adminSumFill: view && view.nFill ? view.nFill + ' restored' : '',
      adminSumChange: view && view.nChange ? view.nChange + ' changed' : '',
      adminSumClear: view && view.nClear ? view.nClear + ' cleared' : '',
      // Brighter, more saturated diff palette (fill = green, change = amber,
      // clear/removed = red). Defined once so badges and value chips match.
      adminDiffs: view ? (() => {
        const GREEN = 'background:rgba(34,197,94,0.24);color:#0f9d47;';
        const AMBER = 'background:rgba(245,158,11,0.28);color:#c2740a;';
        const RED   = 'background:rgba(240,68,70,0.22);color:#e01b1d;';
        const MUTED = 'background:var(--surface-2);color:var(--faint);font-style:italic;';
        return view.diffs.slice(0, 60).map(d => {
          const lockStyle = 'font-family:var(--font-mono);font-size:9px;font-weight:800;letter-spacing:0.05em;padding:2px 7px;border-radius:999px;white-space:nowrap;' + (
            d.lockind === 'fill'  ? GREEN :
            d.lockind === 'clear' ? RED : AMBER);
          return { loc: d.loc, lockLabel: d.lockLabel, lockStyle,
            fields: d.fields.map(f => {
              // Colour the arrow endpoints: what it is now (from) → what restore sets (to).
              const chip = 'font-family:var(--font-mono);font-size:12px;font-weight:700;padding:2px 8px;border-radius:4px;white-space:nowrap;max-width:200px;overflow:hidden;text-overflow:ellipsis;';
              const fromStyle = chip + (f.change === 'add' ? MUTED : RED + 'text-decoration:line-through;');
              const toStyle = chip + (f.change === 'remove' ? MUTED : GREEN);
              return { label: f.label, fromShow: f.fromShow, toShow: f.toShow, fromStyle, toStyle };
            }) };
        });
      })() : [],
      adminDiffsCapped: view ? view.diffs.length > 60 : false,
      onAdminBack: () => this._adminSet({ view: null }),
      onAdminRestoreViewed: () => view ? this._adminRestore(view.key) : null,

      // --- Statuses editor ---
      adminStatuses: this._statusList().map(s => {
        const locked = !!(s.reserved || s.derived);
        const conf = a.secConfirm === 'st:' + s.key;
        const tag = s.reserved ? 'EMPTY' : s.derived ? 'AUTO' : s.hazard ? 'HAZARD' : '';
        return { key: s.key, label: s.label, colorHex: this._hex(s.color), locked, tag,
          swatchStyle: `display:inline-block;width:18px;height:18px;border-radius:4px;flex:0 0 auto;background:${s.color};box-shadow:inset 0 0 0 1px rgba(0,0,0,0.15);`,
          onColor: (e) => this._cfgStatusColor(s.key, e.target.value),
          onLabel: (e) => this._cfgStatusLabel(s.key, e.target.value.slice(0, 40)),
          onUp: () => this._cfgStatusMove(s.key, -1),
          onDown: () => this._cfgStatusMove(s.key, 1),
          kpiToggleable: !locked, kpi: !!s.kpi,
          kpiLabel: s.kpi ? 'KPI ✓' : 'KPI',
          kpiStyle: `font-family:var(--font-sans);font-size:11px;font-weight:700;padding:5px 10px;border-radius:4px;cursor:pointer;white-space:nowrap;border:1px solid ${s.kpi ? 'var(--wwt-blue)' : 'var(--line-strong)'};background:${s.kpi ? 'var(--sel-bg)' : 'var(--surface)'};color:${s.kpi ? 'var(--wwt-blue)' : 'var(--muted)'};`,
          onToggleKpi: () => this._cfgStatusKpi(s.key),
          removable: !locked,
          removeConfirming: conf,
          removeLabel: conf ? 'Confirm?' : 'Remove',
          onRemove: () => conf ? this._cfgStatusRemove(s.key) : this._adminSet({ secConfirm: 'st:' + s.key }),
          onDragStart: (e) => { this._drag = { list: 'statuses', key: s.key }; if (e && e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; },
          onDragOver: (e) => { if (e) e.preventDefault(); },
          onDrop: (e) => { if (e) e.preventDefault(); if (this._drag && this._drag.list === 'statuses') this._cfgReorder('statuses', this._drag.key, s.key); this._drag = null; } };
      }),
      adminNewStatus: a.newStatus || '',
      adminNewStatusColor: a.newStatusColor || '#3aa76d',
      onAdminNewStatus: (e) => this._adminSet({ newStatus: e.target.value.slice(0, 40) }),
      onAdminNewStatusColor: (e) => this._adminSet({ newStatusColor: e.target.value }),
      onAdminNewStatusKey: (e) => { if (e.key === 'Enter') this._cfgStatusAdd(); },
      onAdminAddStatus: () => this._cfgStatusAdd(),

      // --- Locations editor ---
      ...(() => {
        const lq = (a.locQuery || '').trim().toLowerCase();
        const hidden = new Set(this.cfg.locations.hidden || []);
        const addedSet = new Set((this.cfg.locations.added || []).map(x => x.ot));
        const byKey = {};
        [...(this._seedRecords || []).map(r => ({ ot: r.ot, bts: r.bts, zone: r.zone })), ...(this.cfg.locations.added || [])].forEach(l => { byKey[l.ot] = l; });
        const ordered = this._orderedLocationKeys().map(k => byKey[k]).filter(Boolean);
        const filtered = ordered.filter(l => !lq || ((l.ot || '') + ' ' + (l.bts || '') + ' ' + (l.zone || '')).toLowerCase().indexOf(lq) !== -1);
        return {
          adminLocTotal: ordered.length,
          adminLocFiltered: filtered.length,
          adminLocCapped: filtered.length > 100,
          adminLocations: filtered.slice(0, 100).map(l => ({
            ot: l.ot, bts: l.bts || '—', zone: l.zone || '—',
            added: addedSet.has(l.ot), hidden: hidden.has(l.ot),
            rowStyle: `display:grid;grid-template-columns:18px 1.3fr 1.3fr 0.6fr auto;align-items:center;gap:10px;padding:7px 4px;border-bottom:1px solid var(--line-soft);${hidden.has(l.ot) ? 'opacity:0.5;' : ''}`,
            toggleLabel: hidden.has(l.ot) ? 'Restore' : 'Hide',
            toggleStyle: `font-family:var(--font-sans);font-size:11px;font-weight:700;padding:4px 10px;border-radius:4px;cursor:pointer;border:1px solid var(--line-strong);background:var(--surface);color:${hidden.has(l.ot) ? 'var(--wwt-blue)' : 'var(--wwt-red-deep)'};`,
            onToggle: () => this._cfgLocationHide(l.ot, !hidden.has(l.ot)),
            onDragStart: (e) => { this._drag = { list: 'locations', key: l.ot }; if (e && e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; },
            onDragOver: (e) => { if (e) e.preventDefault(); },
            onDrop: (e) => { if (e) e.preventDefault(); if (this._drag && this._drag.list === 'locations') this._cfgLocationReorder(this._drag.key, l.ot); this._drag = null; },
          })),
        };
      })(),
      adminLocQuery: a.locQuery || '',
      onAdminLocQuery: (e) => this._adminSet({ locQuery: e.target.value }),
      adminNewOt: a.newOt || '', adminNewBts: a.newBts || '', adminNewZone: a.newZone || '',
      onAdminNewOt: (e) => this._adminSet({ newOt: e.target.value }),
      onAdminNewBts: (e) => this._adminSet({ newBts: e.target.value }),
      onAdminNewZone: (e) => this._adminSet({ newZone: e.target.value }),
      onAdminAddLocation: () => this._cfgLocationAdd(),

      // --- Fields editor ---
      adminFields: this._fields().map(f => {
        const conf = a.secConfirm === 'fl:' + f.key;
        const dupable = f.type === 'text' || f.type === 'number';
        return { key: f.key, label: f.label, typeLabel: f.type, builtin: !!f.builtin,
          dupable, dup: !!f.dup, dupLabel: f.dup ? 'Dup ✓' : 'Dup',
          dupStyle: `font-family:var(--font-sans);font-size:11px;font-weight:700;padding:4px 9px;border-radius:4px;cursor:pointer;border:1px solid ${f.dup ? 'var(--wwt-blue)' : 'var(--line-strong)'};background:${f.dup ? 'var(--sel-bg)' : 'var(--surface)'};color:${f.dup ? 'var(--wwt-blue)' : 'var(--muted)'};`,
          onToggleDup: () => this._cfgFieldDup(f.key),
          onUp: () => this._cfgFieldMove(f.key, -1),
          onDown: () => this._cfgFieldMove(f.key, 1),
          removable: !f.builtin, removeConfirming: conf, removeLabel: conf ? 'Confirm?' : 'Remove',
          onRemove: () => conf ? this._cfgFieldRemove(f.key) : this._adminSet({ secConfirm: 'fl:' + f.key }),
          onDragStart: (e) => { this._drag = { list: 'fields', key: f.key }; if (e && e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; },
          onDragOver: (e) => { if (e) e.preventDefault(); },
          onDrop: (e) => { if (e) e.preventDefault(); if (this._drag && this._drag.list === 'fields') this._cfgReorder('fields', this._drag.key, f.key); this._drag = null; } };
      }),
      adminNewFieldLabel: a.newFieldLabel || '',
      adminNewFieldType: a.newFieldType || 'text',
      adminNewFieldOptions: a.newFieldOptions || '',
      adminNewFieldIsSelect: (a.newFieldType || 'text') === 'select',
      adminFieldTypeOptions: ['text', 'number', 'date', 'select'].map(t => ({ value: t, label: ({ text: 'Text', number: 'Number', date: 'Date', select: 'Dropdown' })[t] })),
      onAdminNewFieldLabel: (e) => this._adminSet({ newFieldLabel: e.target.value.slice(0, 30) }),
      onAdminNewFieldType: (e) => this._adminSet({ newFieldType: e.target.value }),
      onAdminNewFieldOptions: (e) => this._adminSet({ newFieldOptions: e.target.value }),
      onAdminAddField: () => this._cfgFieldAdd(),
    };
  }

  // --- Status filter (supports shift-click multi-select) ----------------
  // statusFilter is either 'all' or an array of selected status keys.
  _statusInFilter(s) {
    const f = this.state.statusFilter;
    if (f === 'all') return false;
    return Array.isArray(f) ? (f.indexOf(s) !== -1) : (f === s);
  }
  _toggleStatus(s, additive) {
    this.setState(st => {
      const cur = st.statusFilter;
      const arr = (cur === 'all') ? [] : (Array.isArray(cur) ? cur.slice() : [cur]);
      const i = arr.indexOf(s);
      if (additive) {
        if (i === -1) arr.push(s); else arr.splice(i, 1);
      } else {
        const only = arr.length === 1 && arr[0] === s;
        arr.length = 0;
        if (!only) arr.push(s);
      }
      return { statusFilter: arr.length === 0 ? 'all' : arr };
    });
  }
  updateField(ot, field, value) {
    // Update the on-screen value immediately so typing stays responsive...
    this._edits[ot] = this._edits[ot] || {};
    this._edits[ot][field] = value;
    this.setState(s => {
      const records = s.data.records.map(r => r.ot === ot ? { ...r, [field]: value } : r);
      const sel = s.sel && s.sel.ot === ot ? { ...s.sel, [field]: value } : s.sel;
      return { data: { ...s.data, records }, sel };
    });
    // ...but only persist to storage/Supabase once typing pauses.
    this._queueSave(ot);
    // let other viewers know this row (and which field) is being edited now
    this._broadcastEditing(ot, field);
  }
  clearRow(ot) {
    const snapshot = {};
    const cur = this.state.data.records.find(r => r.ot === ot) || {};
    ['wo','serial','lpn','status','date'].forEach(f => { snapshot[f] = cur[f] || ''; });
    const fields = { wo: '', serial: '', lpn: '', status: '', date: '' };
    snapshot.note = cur.note || '';
    fields.note = '';
    // One write for the whole clear (was one upsert per field — six racing
    // requests and six realtime events on other clients for a single click).
    this._edits[ot] = this._edits[ot] || {};
    Object.keys(fields).forEach(f => { this._edits[ot][f] = fields[f]; });
    this._persist(ot);
    this.setState(s => {
      const records = s.data.records.map(r => r.ot === ot ? { ...r, ...fields } : r);
      const sel = s.sel && s.sel.ot === ot ? { ...s.sel, ...fields } : s.sel;
      const cleared = { ...s.cleared, [ot]: snapshot };
      const clearedAt = { ...s.clearedAt, [ot]: Date.now() };
      return { data: { ...s.data, records }, sel, cleared, clearedAt, confirmClear: null, now: Date.now() };
    });
    clearTimeout(this._restoreTimers && this._restoreTimers[ot]);
    this._restoreTimers = this._restoreTimers || {};
    this._restoreTimers[ot] = setTimeout(() => {
      this.setState(s => { const cleared = { ...s.cleared }; delete cleared[ot]; const clearedAt = { ...s.clearedAt }; delete clearedAt[ot]; return { cleared, clearedAt }; });
    }, 60000);
    if (!this._tick) this._tick = setInterval(() => {
      if (Object.keys(this.state.cleared).length === 0) { clearInterval(this._tick); this._tick = null; return; }
      this.setState({ now: Date.now() });
    }, 1000);
  }
  shortLoc(ot) { return (ot || '').replace(/^NA1L4OT/i, '').replace(/^ZL4BTS/i, '') || ot; }
  restoreRow(ot) {
    const snapshot = this.state.cleared[ot];
    if (!snapshot) return;
    this._edits[ot] = this._edits[ot] || {};
    Object.keys(snapshot).forEach(f => { this._edits[ot][f] = snapshot[f]; });
    this._persist(ot);
    clearTimeout(this._restoreTimers && this._restoreTimers[ot]);
    this.setState(s => {
      const records = s.data.records.map(r => r.ot === ot ? { ...r, ...snapshot } : r);
      const sel = s.sel && s.sel.ot === ot ? { ...s.sel, ...snapshot } : s.sel;
      const cleared = { ...s.cleared }; delete cleared[ot];
      return { data: { ...s.data, records }, sel, cleared };
    });
  }
  toISO(d) {
    if (!d) return '';
    const p = String(d).split('/');
    if (p.length !== 3) return '';
    const m = +p[0], dd = +p[1], y = +p[2];
    if (!y || !m || !dd) return '';
    return y + '-' + String(m).padStart(2, '0') + '-' + String(dd).padStart(2, '0');
  }
  fromISO(iso) {
    if (!iso) return '';
    const p = iso.split('-');
    return (+p[1]) + '/' + (+p[2]) + '/' + (+p[0]);
  }
  todayStr() {
    const d = new Date();
    return (d.getMonth() + 1) + '/' + d.getDate() + '/' + d.getFullYear();
  }
  // Copy `text` to the clipboard and flash a toast at the cursor. `label`
  // overrides the toast wording (e.g. "Copied 5 work orders") when showing the
  // raw text would be too long.
  _copy(text, e, label) {
    const t = (text == null ? '' : String(text));
    const legacy = () => { try { const ta = document.createElement('textarea'); ta.value = t; ta.style.position = 'fixed'; ta.style.opacity = '0'; document.body.appendChild(ta); ta.select(); document.execCommand('copy'); document.body.removeChild(ta); } catch (e) {} };
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).catch(legacy); }
      else { legacy(); }
    } catch (e) { legacy(); }
    this._toast(label != null ? label : t, e);
  }
  // Show the transient toast without touching the clipboard.
  _toast(msg, e) {
    const x = e && e.clientX != null ? e.clientX : (window.innerWidth / 2);
    const y = e && e.clientY != null ? e.clientY : (window.innerHeight - 80);
    clearTimeout(this._copyTimer);
    this.setState({ copied: { text: msg, x, y } });
    this._copyTimer = setTimeout(() => this.setState({ copied: null }), 1300);
  }
  buildCalendar(y, m) {
    const startDow = new Date(y, m, 1).getDay();
    const daysInMonth = new Date(y, m + 1, 0).getDate();
    const cells = [];
    for (let i = 0; i < startDow; i++) cells.push(null);
    for (let day = 1; day <= daysInMonth; day++) cells.push(day);
    while (cells.length % 7 !== 0) cells.push(null);
    const weeks = [];
    for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
    return weeks;
  }

  renderVals() {
    const d = this.state.data;
    const darkVars = '--surface:#1a1e24;--surface-2:#15181d;--page:#0e1115;--line:#2a2f36;--line-soft:#23272d;--line-strong:#3a4048;--text:#e9ebee;--muted:#9aa2ad;--faint:#6b7480;--sel-bg:rgba(0,134,234,0.20);';
    const rootStyle = 'color-scheme:' + (this.state.dark ? 'dark' : 'light') + ';background:var(--page);min-height:100vh;font-family:var(--font-sans);color:var(--text);transition:background 220ms,color 220ms;' + (this.state.dark ? darkVars : '');
    const cellInput = 'width:160px;background:transparent;border:1px solid transparent;border-radius:4px;padding:5px 7px;font-family:var(--font-mono);font-size:13px;color:var(--text);outline:none;';
    this.cellInputBase = 'width:160px;background:transparent;border:1px solid transparent;border-radius:4px;padding:5px 7px;font-family:var(--font-mono);font-size:13px;color:var(--text);outline:none;';
    const cellDate = 'background:transparent;border:1px solid transparent;border-radius:4px;padding:4px 6px;font-family:var(--font-mono);font-size:12px;color:var(--text);outline:none;cursor:pointer;';
    // Status dropdown: Empty + every selectable status from config (derived
    // "WO entered" and reserved "Pending" are not user-selectable). Keeps the
    // "Outbounded" wording for OT Completed; custom statuses appear here too.
    const optLabel = { 'OT Completed': 'Outbounded' };
    const statusOptions = [{ value: '', label: 'Empty' }].concat(
      this._statusList().filter(s => !s.derived && !s.reserved)
        .map(s => ({ value: s.key, label: optLabel[s.key] || s.label })));
    const base = { rootStyle, cellInput, cellDate, statusOptions, batchId: 'LY022426-23', zoneCount: 8,
      infoOpen: this.state.infoOpen,
      infoBtn: { onClick: () => this.setState(s => ({ infoOpen: !s.infoOpen })) },
      showCopied: !!this.state.copied,
      copiedText: this.state.copied ? this.state.copied.text : '',
      copiedStyle: this.state.copied ? `position:fixed;left:${this.state.copied.x}px;top:${this.state.copied.y - 14}px;transform:translate(-50%,-100%);z-index:60;display:inline-flex;align-items:center;gap:7px;background:var(--wwt-ink);color:#fff;border-radius:999px;padding:8px 14px;font-family:var(--font-sans);font-size:12.5px;font-weight:700;white-space:nowrap;box-shadow:var(--shadow-xl);animation:ot-copied-pop 140ms ease-out;pointer-events:none;` : '',
      scrolled: this.state.scrolled,
      onBackToTop: () => window.scrollTo({ top: 0, behavior: 'smooth' }),
      onSearchJump: () => { const el = document.getElementById('ot-search'); if (!el) return; const top = el.getBoundingClientRect().top + (window.scrollY || 0) - 90; window.scrollTo({ top, behavior: 'smooth' }); setTimeout(() => { try { el.focus(); } catch (e) {} }, 420); },
      modeBtn: { onClick: () => this.setState(s => { const dark = !s.dark; try { localStorage.setItem('ot-tracker-darkmode', dark ? '1' : '0'); } catch (e) {} return { dark }; }), label: this.state.dark ? '☀ Light' : '☾ Dark' },
      viewerCount: this.state.viewers,
      viewerEyeColor: this.state.live === 'live' ? '#4ade80' : (this.state.live === 'reconnecting' ? '#F2A900' : '#8A919B'),
      viewerTitle: (this.state.viewers === 1 ? 'You are the only person viewing this tracker' : this.state.viewers + ' people are viewing this tracker right now')
        + (this.state.live === 'live' ? '' : this.state.live === 'reconnecting'
            ? ' · Reconnecting to live updates (still syncing every 45s)'
            : ' · Live sync offline — showing last synced data'),
      ...this._adminUI() };
    if (!d) {
      return { ...base, total: '—', otPct: '—', otDone: '—', btsDone: '—', activeTotal: '—',
        ringSegs: [], ringMain: '—', ringSub: 'Loading', ringMainColor: 'var(--text)',
        kpis: [], tabs: [], legend: [], racks: [], zoneOptions: [], columns: [], rows: [],
        showTracker: true, empty: false, resultCount: 0, query: '',
        sel: { headStyle: 'background-color:var(--gray-100);color:var(--gray-500);padding:20px 22px;', kicker: 'Loading', otLoc: '…', fields: [] } };
    }
    const allRecs = d.records;
    const recs = allRecs.filter(r => !r.obstructed);
    const total = recs.length;
    const count = (s) => recs.filter(r => this.norm(r.status) === s).length;
    const otDone = count('OT Completed');
    const btsDone = count('BTS Completed');
    const prog = count('In Progress');
    const issue = count('Issue/Hold');
    const dnu = count('DO NOT USE');
    const pending = count('Pending');
    const activeTotal = total;
    // A location counts as filled if it has an active status, or if a work
    // order has been entered even before a status is set.
    const isFilled = (r) => {
      const s = this.norm(r.status);
      if (s === 'OT Completed' || s === 'BTS Completed' || s === 'In Progress' || s === 'Issue/Hold') return true;
      return s === 'Pending' && (r.wo || '').trim() !== '';
    };
    const capacity = recs.filter(isFilled).length;
    const otPct = Math.round(capacity / activeTotal * 100);

    // Progress wheel: one SVG arc per status (largest first), drawn with
    // stroke-dasharray/-offset around a 78px-radius ring. Hovering an arc
    // thickens it and swaps the center readout to that status; clicking
    // filters (shift-click additive) — same interactions the old bar had.
    const segDefs = [
      { s: 'OT Completed', n: otDone },
      { s: 'BTS Completed', n: btsDone },
      { s: 'In Progress', n: prog },
      { s: 'Issue/Hold', n: issue },
    ];
    const RING_CIRC = 2 * Math.PI * 78;
    let ringAcc = 0;
    const ringSegs = segDefs.filter(x => x.n > 0).sort((a, b) => b.n - a.n).map(x => {
      const len = RING_CIRC * (x.n / activeTotal);
      const seg = { color: this.META[x.s].color, dash: len.toFixed(2) + ' ' + (RING_CIRC - len).toFixed(2), offset: (-RING_CIRC * ringAcc).toFixed(2),
        onEnter: () => this.setState({ barHover: x.s }),
        onClick: (e) => this._toggleStatus(x.s, !!(e && e.shiftKey)) };
      ringAcc += x.n / activeTotal;
      return seg;
    });
    let ringMain, ringSub, ringMainColor;
    if (this.state.barHover) {
      const x = segDefs.find(y => y.s === this.state.barHover) || segDefs[0];
      ringMain = String(x.n); ringSub = this.META[x.s].label; ringMainColor = this.META[x.s].color;
    } else {
      ringMain = otPct + '%'; ringSub = 'Full'; ringMainColor = 'var(--text)';
    }

    // KPI cards = statuses flagged kpi:true in config (toggle in the admin
    // Statuses editor). Concise labels are kept for the core statuses; colors
    // and subtitles come from config so recoloring/relabeling flows through.
    const KPI_LABEL = { 'OT Completed': 'Outbounded', 'BTS Completed': 'Back To Stock', 'In Progress': 'In progress', 'Issue/Hold': 'Issue / Hold' };
    const kpiVal = { 'OT Completed': otDone, 'BTS Completed': btsDone, 'In Progress': prog, 'Issue/Hold': issue };
    const kpiDefs = this._statusList().filter(s => s.kpi && !s.reserved && !s.derived).map(s => {
      const lbl = KPI_LABEL[s.key] || s.label;
      return { label: lbl, value: (s.key in kpiVal) ? kpiVal[s.key] : count(s.key), status: s.key,
        empty: 'No orders are ' + lbl + '.', color: s.color, num: s.color, sub: s.sub || '' };
    });
    const kpis = kpiDefs.map(k => {
      const active = this._statusInFilter(k.status);
      const zero = k.value === 0;
      return { ...k,
        value: k.value,
        valueSize: '40px',
        num: k.num,
        sup: '',
        onClick: (e) => {
          // Ignore clicks that came from the hover copy button inside the card.
          if (e && e.target && e.target.closest && e.target.closest('.kpi-copy')) return;
          if (zero) this.setState({ noDice: k.empty });
          else this._toggleStatus(k.status, !!(e && e.shiftKey));
        },
        // Hover-revealed button: copy every work order in this status, one per line.
        copyTitle: 'Copy all work orders — ' + k.label,
        onCopyWos: (e) => {
          if (e) { e.preventDefault(); e.stopPropagation(); }
          const wos = recs.filter(r => this.norm(r.status) === k.status).map(r => (r.wo || '').trim()).filter(Boolean);
          if (!wos.length) { this._toast('No work orders in ' + k.label, e); return; }
          this._copy(wos.join('\n'), e, 'Copied ' + wos.length + ' work order' + (wos.length > 1 ? 's' : ''));
        },
        cardStyle: `background:var(--surface);border:1px solid var(--line);border-top:3px solid ${k.color};border-radius:6px;padding:22px 22px;box-shadow:${active?'var(--shadow-md)':'var(--shadow-sm)'};display:flex;flex-direction:column;gap:10px;cursor:pointer;transition:transform 140ms,box-shadow 140ms;`,
      };
    });

    const mkTab = (id, label, wip) => {
      const on = this.state.tab === id;
      return { label, wip: !!wip, onClick: () => this.setState({ tab: id }),
        style: `background:none;border:none;cursor:pointer;font-family:var(--font-sans);font-size:14px;font-weight:700;padding:12px 18px;color:${on?'var(--text)':'var(--faint)'};border-bottom:3px solid ${on?'var(--wwt-bright-red)':'transparent'};margin-bottom:-1px;` };
    };
    const tabs = [ mkTab('tracker', 'OT Tracker') ];

    const countEff = (s) => recs.filter(r => this.eff(r) === s).length;
    // Legend order follows config, with the empty "Pending" bucket last.
    const order = this._statusList().map(s => s.key).filter(k => k !== 'Pending').concat('Pending');
    const legend = order.filter(s => countEff(s) > 0).map(s => {
      const active = this._statusInFilter(s);
      const dim = this.state.statusFilter !== 'all' && !active;
      // The swatch mirrors the hazard striping (lighter stripes on the darker
      // base, scaled down to 12px): light-red on dark-red for Issue/Hold,
      // grey on black for "Do not use"; every other status stays solid.
      const swatchFill = s === 'Issue/Hold'
        ? `background-color:${this.META[s].color};background-image:repeating-linear-gradient(45deg,rgba(255,255,255,0.45) 0 2.5px,transparent 2.5px 5px),linear-gradient(rgba(0,0,0,0.35),rgba(0,0,0,0.35));`
        : (this.META[s].hazard
          ? 'background-color:#16191d;background-image:repeating-linear-gradient(45deg,rgba(138,145,155,0.85) 0 2.5px,transparent 2.5px 5px);'
          : `background:${this.META[s].color};`);
      return { label: this.META[s].label, count: countEff(s),
        swatchStyle: `width:12px;height:12px;border-radius:3px;${swatchFill}box-shadow:inset 0 0 0 1px rgba(0,0,0,0.12);`,
        onClick: (e) => this._toggleStatus(s, !!(e && e.shiftKey)),
        style: `display:inline-flex;align-items:center;gap:7px;cursor:pointer;font-family:var(--font-sans);font-size:12px;font-weight:700;padding:6px 11px;border-radius:999px;border:1.5px solid ${active?'var(--text)':'var(--line)'};background:${active?'var(--surface-2)':'var(--surface)'};color:var(--text);opacity:${dim?0.4:1};transition:all 140ms;` };
    });

    const zones = [...new Set(allRecs.map(r => r.zone))].sort();
    const selKey = this.state.sel ? this.state.sel.ot : null;
    // Map slot order within a zone follows the admin's custom location order
    // (drag in the Locations editor); anything unranked falls back to BTS order.
    const locRank = {}; this._orderedLocationKeys().forEach((k, i) => { locRank[k] = i; });
    const racks = zones.map(z => {
      const slots = allRecs.filter(r => r.zone === z).sort((a, b) => {
        const ra = locRank[a.ot], rb = locRank[b.ot];
        if (ra != null && rb != null) return ra - rb;
        if (ra != null) return -1;
        if (rb != null) return 1;
        return a.bts.localeCompare(b.bts);
      });
      const zdone = slots.filter(r => !r.obstructed && isFilled(r)).length;
      const zcount = slots.filter(r => !r.obstructed).length;
      return { zone: z, label: zdone + '/' + zcount,
        slots: slots.map(rec => {
          if (rec.obstructed) {
            return { title: rec.bts + ' · Obstructed by a pole',
              onSelect: () => this.setState({ noDice: 'This location is obstructed by a pole.' }),
              onCopy: (e) => { if (e) e.preventDefault(); },
              style: `width:100%;aspect-ratio:1;border-radius:4px;cursor:pointer;position:relative;background-color:var(--surface-2);background-image:url("data:image/svg+xml,${encodeURIComponent("<svg xmlns='http://www.w3.org/2000/svg' preserveAspectRatio='none' viewBox='0 0 24 24'><line x1='0' y1='24' x2='24' y2='0' stroke='#9aa2ad' stroke-width='1.6' stroke-linecap='round'/></svg>")}");background-size:100% 100%;background-repeat:no-repeat;box-shadow:inset 0 0 0 1px var(--line-strong);opacity:1;transition:box-shadow 140ms,transform 140ms,filter 140ms;` };
          }
          const st = this.eff(rec);
          const m = this.META[st];
          const isSel = rec.ot === selKey;
          const fade = this.state.statusFilter !== 'all' && !this._statusInFilter(st);
          const border = st === 'Pending' ? 'inset 0 0 0 1px var(--line-strong)' : 'inset 0 0 0 1px rgba(0,0,0,0.10)';
          const primaryLoc = st === 'OT Completed' ? rec.ot : rec.bts;
          return { title: primaryLoc + ' · ' + m.label + ' · double-click to jump to row · right-click to copy WO/Serial/LPN',
            onSelect: () => this.setState({ sel: rec }),
            onCopy: (e) => {
              if (e) e.preventDefault();
              const names = [], parts = [];
              [['WO', rec.wo], ['Serial', rec.serial], ['LPN', rec.lpn]].forEach(([n, v]) => { v = (v || '').trim(); if (v) { parts.push(v); names.push(n); } });
              if (!parts.length) { this._toast('Nothing to copy here', e); return; }
              this._copy(parts.join('\n'), e, 'Copied ' + names.join(' · '));
            },
            // Striped squares share one uniform design (45°, equal 4px bands,
            // lighter stripes on the darker base) and differ only in color:
            // Issue/Hold is light-red on dark-red (a darkening wash under
            // white stripes, so themed reds keep working), "Do not use" is
            // grey on black.
            style: `width:100%;aspect-ratio:1;border-radius:4px;cursor:pointer;position:relative;background-color:${m.hazard ? '#16191d' : m.color};${st === 'Issue/Hold' ? 'background-image:repeating-linear-gradient(45deg,rgba(255,255,255,0.45) 0 4px,transparent 4px 8px),linear-gradient(rgba(0,0,0,0.35),rgba(0,0,0,0.35));' : (m.hazard ? 'background-image:repeating-linear-gradient(45deg,rgba(138,145,155,0.85) 0 4px,transparent 4px 8px);' : '')}box-shadow:${isSel?'0 0 0 2px var(--text)':border};opacity:${fade?0.25:1};transition:opacity 140ms,box-shadow 140ms,transform 140ms,filter 140ms;` };
        }) };
    });

    // Date picker calendar view
    let datePickerView = null;
    const dp = this.state.datePicker;
    if (dp) {
      const MN = ['January','February','March','April','May','June','July','August','September','October','November','December'];
      const now = new Date();
      const weeks = this.buildCalendar(dp.y, dp.m).map((wk, wi) => ({
        key: 'w' + wi,
        days: wk.map((day, di) => {
          if (day == null) return { key: 'b' + wi + di, label: '', style: 'aspect-ratio:1;pointer-events:none;', onPick: () => {} };
          const dateStr = (dp.m + 1) + '/' + day + '/' + dp.y;
          const isToday = now.getFullYear() === dp.y && now.getMonth() === dp.m && now.getDate() === day;
          const isSel = dp.current === dateStr;
          const base = isSel ? 'background:var(--wwt-blue);color:#fff;' : (isToday ? 'background:var(--wwt-blue-tint);color:var(--wwt-blue-deep);font-weight:800;' : 'background:transparent;color:var(--text);');
          return { key: 'd' + day, label: String(day),
            style: 'display:flex;align-items:center;justify-content:center;aspect-ratio:1;border-radius:6px;font-family:var(--font-mono);font-size:13px;cursor:pointer;border:1px solid transparent;transition:background 120ms;' + base,
            onPick: () => { this.updateField(dp.ot, 'date', dateStr); this.setState({ datePicker: null }); } };
        })
      }));
      datePickerView = {
        title: dp.bts,
        monthLabel: MN[dp.m] + ' ' + dp.y,
        weeks,
        onPrev: () => this.setState(s => { let m = s.datePicker.m - 1, y = s.datePicker.y; if (m < 0) { m = 11; y--; } return { datePicker: { ...s.datePicker, m, y } }; }),
        onNext: () => this.setState(s => { let m = s.datePicker.m + 1, y = s.datePicker.y; if (m > 11) { m = 0; y++; } return { datePicker: { ...s.datePicker, m, y } }; }),
        onToday: () => { const t = new Date(); this.updateField(dp.ot, 'date', (t.getMonth()+1)+'/'+t.getDate()+'/'+t.getFullYear()); this.setState({ datePicker: null }); },
        onClose: () => this.setState({ datePicker: null })
      };
    }

    let sel;
    const sr = this.state.sel;
    // The detail-card header carries the same hazard striping as the rows and
    // map squares (lighter stripes on the darker base): light-red on dark-red
    // for Issue/Hold, grey on black for "Do not use". Softer stripe alphas
    // than the squares keep the white header text readable.
    const selHead = (bg, img, fg) => `background-color:${bg};${img}color:${fg};padding:20px 22px;`;
    if (sr) {
      const m = this.metaFor(sr.status);
      const st = this.norm(sr.status);
      const hazardSel = !!(this.META[st] && this.META[st].hazard);
      const headImg = st === 'Issue/Hold'
        ? 'background-image:repeating-linear-gradient(45deg,rgba(255,255,255,0.28) 0 7px,transparent 7px 14px),linear-gradient(rgba(0,0,0,0.30),rgba(0,0,0,0.30));'
        : hazardSel ? 'background-image:repeating-linear-gradient(45deg,rgba(138,145,155,0.45) 0 7px,transparent 7px 14px);' : '';
      sel = { headStyle: selHead(hazardSel ? '#16191d' : m.color, headImg, st === 'Pending' ? 'var(--wwt-ink)' : '#fff'),
        kicker: m.label, otLoc: this.norm(sr.status) === 'OT Completed' ? sr.ot : sr.bts,
        fields: [
          { k: 'OT location', v: sr.ot || '—', mono: 'var(--font-mono)' },
          { k: 'BTS location', v: sr.bts || '—', mono: 'var(--font-mono)' },
          { k: 'Zone', v: sr.zone, mono: 'var(--font-mono)' },
          { k: 'Work order', v: sr.wo || '—', mono: 'var(--font-mono)' },
          { k: 'Serial', v: sr.serial || '—', mono: 'var(--font-mono)' },
          { k: 'LPN', v: sr.lpn || '—', mono: 'var(--font-mono)' },
          { k: 'Completed', v: sr.date || '—', mono: 'var(--font-mono)' },
        ] };
    } else {
      sel = { headStyle: selHead('var(--surface-2)', '', 'var(--muted)'), kicker: 'No selection', otLoc: 'Pick a location', fields: [] };
    }

    const q = this.state.query.trim().toLowerCase();
    let rows = recs.filter(r => {
      if (this.state.zoneFilter !== 'all' && r.zone !== this.state.zoneFilter) return false;
      if (this.state.statusFilter !== 'all' && !this._statusInFilter(this.eff(r))) return false;
      if (q && !([r.ot,r.bts,r.wo,r.serial,r.lpn].join(' ').toLowerCase().includes(q))) return false;
      return true;
    });
    const sk = this.state.sortKey, dir = this.state.sortDir;
    if (sk) {
      rows.sort((a,b) => {
        let av = (a[sk]||''), bv = (b[sk]||'');
        if (sk === 'status') { av = this.norm(a.status); bv = this.norm(b.status); }
        return String(av).localeCompare(String(bv), undefined, {numeric:true}) * dir;
      });
    } else {
      // No column sort → follow the admin's custom location order (same order
      // the map uses); unranked locations fall back to BTS order.
      rows.sort((a,b) => {
        const ra = locRank[a.ot], rb = locRank[b.ot];
        if (ra != null && rb != null) return ra - rb;
        if (ra != null) return -1;
        if (rb != null) return 1;
        return (a.bts||'').localeCompare(b.bts||'');
      });
    }
    const resultCount = rows.length;

    // duplicate detection — count each non-empty value per column across ALL records
    // Duplicate detection over any field flagged dup:true in config.
    const dupCount = (field) => { const c = {}; recs.forEach(r => { const v = (r[field] || '').toString().trim(); if (v) c[v] = (c[v] || 0) + 1; }); return c; };
    const dupFields = this._fields().filter(f => f.dup);
    const dupCounts = {}; dupFields.forEach(f => { dupCounts[f.key] = dupCount(f.key); });
    const isDupVal = (counts, v) => { v = (v || '').toString().trim(); return !!(v && counts[v] > 1); };
    const dupInput = (isDup) => this.cellInputBase + (isDup
      ? 'border-color:var(--wwt-bright-red);background:var(--wwt-bright-red-25);color:var(--wwt-red-deep);font-weight:700;'
      : 'border-color:transparent;');
    const dupParts = [];
    dupFields.forEach(f => { const n = Object.values(dupCounts[f.key]).filter(x => x > 1).length; if (n) dupParts.push(n + ' ' + f.label); });
    const hasDup = dupParts.length > 0;
    const dupMsg = hasDup ? 'Duplicate detected · ' + dupParts.join(' · ') + ' repeated' : '';

    // The hazard-flagged status (default "DO NOT USE") drives the striped,
    // locked row and is what the caution button toggles to.
    const hazKey = (this._statusList().find(s => s.hazard) || {}).key || 'DO NOT USE';
    const fieldsList = this._fields();
    const rowsOut = rows.map((r, ri) => {
      const m = this.metaFor(r.status);
      const isSel = r.ot === selKey;
      const st0 = this.norm(r.status);
      const dark = st0 !== 'Pending';
      const dnu = !!(this.META[st0] && this.META[st0].hazard);
      const dnuDim = dnu ? 'opacity:0.5;' : '';
      // "Do not use" rows wear black-and-white barricade stripes (theme-aware:
      // the black/white bands are laid translucently over the surface) with a
      // text-colored edge bar; they stay locked as before.
      const dnuBarStr = dnu ? 'box-shadow: inset 4px 0 0 var(--text);' : '';
      // Issue/Hold rows get the red stripe band + red edge bar (the treatment
      // "Do not use" used to have) but stay editable.
      const issueRow = !dnu && st0 === 'Issue/Hold';
      const issueBarStr = issueRow ? 'box-shadow: inset 4px 0 0 var(--wwt-bright-red);' : '';
      const _ed = (this.state.editing || {})[r.ot];
      const selStyle = `appearance:auto;border:1px solid ${dark ? 'transparent' : 'var(--line-strong)'};border-radius:999px;padding:4px 8px;font-family:var(--font-sans);font-size:11px;font-weight:700;cursor:pointer;background:${m.color};color:${dark ? '#fff' : 'var(--gray-600)'};`;
      const onSelect = () => this.setState({ sel: r });
      // One cell per configured field, rendered by type in the template.
      const cells = fieldsList.map((f, ci) => {
        const primary = ci === 0;
        const val = (r[f.key] == null ? '' : r[f.key]).toString();
        const onCopy = (e) => { if (e) e.preventDefault(); const v = val.trim(); if (v) this._copy(v, e); };
        const bdr = 'border-bottom:1px solid var(--line-soft);';
        if (f.type === 'location' || f.type === 'zone') {
          return { key: f.key, isRead: true, text: val || '—', onSelect, onCopy, title: 'Right-click to copy',
            showTyping: primary && !!_ed, editingField: _ed ? this._fieldLabel(_ed.field) : '', editingLabel: _ed ? ('Someone is editing ' + this._fieldLabel(_ed.field)) : '',
            tdStyle: `padding:11px 16px;font-family:var(--font-mono);font-weight:${primary ? '500' : '400'};color:${primary ? 'var(--text)' : 'var(--muted)'};${bdr}white-space:nowrap;cursor:pointer;${primary ? (dnu ? dnuBarStr : issueBarStr) : ''}` };
        }
        if (f.type === 'status') {
          return { key: f.key, isStatus: true, statusVal: (r.status || '').trim(), onChange: (e) => this.updateField(r.ot, 'status', e.target.value), selStyle, onCopy, title: 'Right-click to copy', tdStyle: `padding:6px 10px;${bdr}` };
        }
        if (f.type === 'date') {
          return { key: f.key, isDate: true, hasDate: !!(r.date && r.date.trim()), noDate: !(r.date && r.date.trim()), dateText: r.date || '', dnuLock: dnu, onCopy, title: 'Right-click to copy',
            onDateSet: () => { if (dnu) return; this.updateField(r.ot, 'date', this.todayStr()); },
            onDateClear: () => { if (dnu) return; this.updateField(r.ot, 'date', ''); },
            onDateMenu: (e) => { e.preventDefault(); if (dnu) return; const n = new Date(); const cur = (r.date || '').trim(); let y = n.getFullYear(), mm = n.getMonth(); const p = cur.split('/'); if (p.length === 3) { mm = (+p[0]) - 1; y = +p[2]; } this.setState({ datePicker: { ot: r.ot, bts: r.bts, y, m: mm, current: cur } }); },
            tdStyle: `padding:6px 10px;${bdr}white-space:nowrap;` };
        }
        if (f.type === 'select') {
          return { key: f.key, isSelect: true, val, options: [{ value: '', label: '—' }].concat((f.options || []).map(o => ({ value: o, label: o }))), onChange: (e) => this.updateField(r.ot, f.key, e.target.value),
            selStyle: `appearance:auto;border:1px solid var(--line-strong);border-radius:4px;padding:4px 8px;font-family:var(--font-sans);font-size:12px;color:var(--text);background:var(--surface);cursor:pointer;${dnuDim}`, onCopy, title: 'Right-click to copy', tdStyle: `padding:6px 10px;${bdr}white-space:nowrap;` };
        }
        // text / number
        const dup = !!(f.dup && isDupVal(dupCounts[f.key], val));
        return { key: f.key, isInput: true, val, dnuLock: dnu,
          onChange: (e) => this.updateField(r.ot, f.key, e.target.value),
          inputStyle: dupInput(dup) + dnuDim,
          dupTitle: dup ? ('Duplicate detected — this value appears ' + dupCounts[f.key][val.trim()] + ' times') : '',
          onCopy, title: 'Right-click to copy', tdStyle: `padding:6px 10px;${bdr}white-space:nowrap;` };
      });
      return { ot: r.ot, cells,
        // "Do not use" — caution-button toggle, hazard-striped row, locked fields.
        dnuLock: dnu,
        dnuTitle: dnu ? 'Unmark “Do not use”' : 'Mark location “Do not use”',
        dnuBtnStyle: `display:inline-flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;color:${dnu ? 'var(--wwt-red-deep)' : 'var(--faint)'};padding:4px;`,
        onDnuToggle: () => this.updateField(r.ot, 'status', dnu ? '' : hazKey),
        onClearRow: () => this.setState({ confirmClear: r.ot }),
        onNote: () => this.setState({ noteEdit: r.ot, noteText: r.note || '', noteHover: null }),
        onNoteEnter: (e) => { if (!(r.note && r.note.trim())) return; const b = e.currentTarget.getBoundingClientRect(); this.setState({ noteHover: { ot: r.ot, text: r.note, x: b.left + b.width / 2, y: b.top } }); },
        noteTitle: (r.note && r.note.trim()) ? r.note : 'Add a Note',
        noteFill: (r.note && r.note.trim()) ? 'var(--wwt-blue)' : 'none',
        noteBtnStyle: `display:inline-flex;align-items:center;justify-content:center;background:none;border:none;cursor:pointer;color:${(r.note && r.note.trim()) ? 'var(--wwt-blue)' : 'var(--faint)'};padding:4px;`,
        canRestore: !!this.state.cleared[r.ot],
        restoreSecs: this.state.clearedAt[r.ot] ? Math.max(0, Math.ceil((60000 - (this.state.now - this.state.clearedAt[r.ot])) / 1000)) : 0,
        onRestoreRow: () => this.restoreRow(r.ot),
        rowStyle: dnu
          ? `background-color:var(--surface-2);background-image:repeating-linear-gradient(45deg,rgba(0,0,0,0.30) 0 7px,rgba(255,255,255,0.30) 7px 14px);transition:background 120ms;`
          : issueRow
          ? `background-color:rgba(238,40,42,0.09);background-image:repeating-linear-gradient(45deg,rgba(238,40,42,0.16) 0 7px,transparent 7px 14px);transition:background 120ms;`
          : `background:${isSel ? 'var(--sel-bg)' : (ri % 2 ? 'var(--surface-2)' : 'var(--surface)')};transition:background 120ms;` };
    });

    const columns = fieldsList.map(f => ({
      label: f.label, arrow: this.state.sortKey === f.key ? (this.state.sortDir === 1 ? ' ↑' : ' ↓') : '',
      title: 'Click to sort · Right-click to copy this column',
      onSort: () => this.setState(st => {
        if (st.sortKey !== f.key) return { sortKey: f.key, sortDir: 1 };   // sort ascending
        if (st.sortDir === 1) return { sortDir: -1 };                       // then descending
        return { sortKey: null, sortDir: 1 };                              // then back to custom order
      }),
      // Right-click the header → copy the whole column: every visible row's
      // value (current filters + sort order), one per line, empties skipped.
      onCopy: (e) => {
        if (e) e.preventDefault();
        const vals = rows.map(r => (r[f.key] == null ? '' : String(r[f.key])).trim()).filter(Boolean);
        if (!vals.length) { this._toast('Nothing to copy in ' + f.label, e); return; }
        this._copy(vals.join('\n'), e, 'Copied ' + vals.length + ' ' + f.label + (vals.length > 1 ? 's' : ''));
      },
      style: `text-align:left;padding:11px 16px;font-size:11px;font-weight:700;letter-spacing:0.06em;text-transform:uppercase;color:${this.state.sortKey === f.key ? '#fff' : 'var(--wwt-light-blue-50)'};border-bottom:1px solid var(--line);cursor:pointer;white-space:nowrap;user-select:none;`,
    }));
    columns.push({ label: '', arrow: '', title: '', onSort: () => {}, onCopy: (e) => { if (e) e.preventDefault(); }, style: 'width:44px;padding:11px 10px;border-bottom:1px solid var(--line);' });

    const zoneOptions = [{ value: 'all', label: 'All zones' }, ...zones.map(z => ({ value: z, label: 'Zone ' + z }))];

    return {
      ...base, total, otPct, otDone, btsDone, activeTotal, capacity,
      ringSegs, ringMain, ringSub, ringMainColor,
      showNote: !!this.state.noteEdit,
      noteLoc: this.shortLoc(this.state.noteEdit),
      noteText: this.state.noteText,
      onNoteInput: (e) => this.setState({ noteText: e.target.value.slice(0, 250) }),
      noteMax: 250,
      noteCount: (this.state.noteText || '').length,
      onNoteSave: () => { const ot = this.state.noteEdit; this.updateField(ot, 'note', this.state.noteText); this.setState({ noteEdit: null, noteText: '' }); },
      onNoteDelete: () => { const ot = this.state.noteEdit; this.updateField(ot, 'note', ''); this.setState({ noteEdit: null, noteText: '' }); },
      onNoteCancel: () => this.setState({ noteEdit: null, noteText: '' }),
      noteHover: this.state.noteHover,
      noteHoverText: this.state.noteHover ? this.state.noteHover.text : '',
      noteHoverStyle: this.state.noteHover ? `position:fixed;left:${this.state.noteHover.x}px;top:${this.state.noteHover.y - 10}px;transform:translate(-50%,-100%);z-index:45;` : 'display:none;',
      onNoteLeave: () => this.setState({ noteHover: null }),
      onNoteHoverKeep: () => {},
      onNoteHoverOpen: () => { const ot = this.state.noteHover && this.state.noteHover.ot; if (!ot) return; const rec = this.state.data.records.find(x => x.ot === ot); this.setState({ noteEdit: ot, noteText: (rec && rec.note) || '', noteHover: null }); },
      showNoDice: !!this.state.noDice,
      noDiceMsg: this.state.noDice || '',
      noDiceTitle: (this.state.noDice || '').indexOf('obstructed') > -1 ? 'Obstructed' : 'No Dice',
      noDiceEmoji: (this.state.noDice || '').indexOf('obstructed') > -1 ? '🚧' : '🎲',
      onNoDiceClose: () => this.setState({ noDice: null }),
      hasQuery: (this.state.query || '').length > 0,
      onClearSearch: () => this.setState({ query: '' }),
      showDatePicker: !!datePickerView,
      datePicker: datePickerView,
      kpis, tabs, legend, racks, sel,
      showTracker: this.state.tab === 'tracker',
      query: this.state.query, zoneFilter: this.state.zoneFilter,
      onSearch: (e) => this.setState({ query: e.target.value }),
      onZone: (e) => this.setState({ zoneFilter: e.target.value }),
      onBarLeave: () => this.setState({ barHover: null }),
      zoneOptions, zoneCount: zones.length, columns, rows: rowsOut, resultCount, empty: resultCount === 0,
      hasDup, dupMsg,
      showConfirm: !!this.state.confirmClear,
      confirmLoc: this.shortLoc(this.state.confirmClear),
      onConfirmClear: () => this.clearRow(this.state.confirmClear),
      onCancelClear: () => this.setState({ confirmClear: null }),
      stopProp: (e) => e.stopPropagation(),
    };
  }
}
