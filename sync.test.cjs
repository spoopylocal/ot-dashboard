const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');

function setup() {
  let id = 0, writes = 0, renders = 0;
  const timers = new Map();
  const context = { DCLogic: class {}, console: { warn() {} }, location: { hostname: 'example.netlify.app', protocol: 'https:', origin: 'https://example.netlify.app' }, document: { hidden: false },
    localStorage: { setItem() { writes++; }, getItem() { return null; } },
    setTimeout(fn, ms) { timers.set(++id, { fn, ms }); return id; }, clearTimeout(i) { timers.delete(i); }, clearInterval(i) { timers.delete(i); }, setInterval() {},
  };
  vm.createContext(context);
  vm.runInContext(fs.readFileSync('src/app_logic.js', 'utf8') + '\nglobalThis.App = Component;', context);
  const app = new context.App();
  app.setState = patch => { renders++; Object.assign(app.state, typeof patch === 'function' ? patch(app.state) : patch); };
  app._seedRecords = [{ ot: 'A', zone: '0100', wo: '' }];
  app._applyConfig(null);
  app.state.data = { records: app._composeRecords() };
  app.state.sel = app.state.data.records[0];
  return { app, context, timers, counts: () => ({ writes, renders }) };
}
const deferred = () => { let resolve; const promise = new Promise(r => resolve = r); return { resolve, promise }; };
const tick = () => new Promise(r => setImmediate(r));
function reader(app, response) {
  const filters = [];
  app._sb = { from(name) { assert.equal(name, 'ot_edits'); return { select(columns) { assert.equal(columns, 'ot,edits'); return { or(filter) { filters.push(filter); return typeof response === 'function' ? response() : Promise.resolve(response); } }; } }; } };
  return filters;
}

test('reads filter metadata on server while retaining configuration', async () => {
  const { app } = setup();
  const filters = reader(app, { data: [{ ot: 'A', edits: { wo: '123' } }] });
  await app._fetchEdits();
  assert.equal(filters[0], 'ot.not.like.\\_\\_*,ot.eq.__config__v1');
  assert.equal(app._edits.A.wo, '123');
});
test('unchanged polls do not render or write local storage', async () => {
  const { app, counts } = setup();
  reader(app, { data: [{ ot: 'A', edits: { wo: '123' } }, { ot: app.CFG_KEY, edits: app.cfg }] });
  await app._resync('first');
  const before = counts();
  await app._resync('second');
  assert.deepEqual(counts(), before);
});
test('changed rows and remote deletion update selection and records', async () => {
  const { app } = setup();
  reader(app, { data: [{ ot: 'A', edits: { wo: 'remote' } }] });
  await app._resync('first');
  assert.equal(app.state.sel.wo, 'remote');
  reader(app, { data: [] });
  await app._resync('delete');
  assert.equal(app.state.sel.wo, '');
});
test('a second client receives acknowledged edits through polling', async () => {
  const { app: writer } = setup(), { app: viewer } = setup();
  let rows = [];
  writer._sb = { from() { return { upsert(row) { rows = [row]; return Promise.resolve({}); } }; } };
  reader(viewer, () => Promise.resolve({ data: rows }));
  writer.saveEdit('A', 'wo', 'shared');
  await tick();
  await viewer._resync('poll');
  assert.equal(viewer.state.sel.wo, 'shared');
  assert.equal(writer.state.saveStatus, 'Saved');
});
test('serializes writes and sends newest value after slow acknowledgment', async () => {
  const { app } = setup();
  const first = deferred(), second = deferred(), sent = [];
  app._sb = { from() { return { upsert(row) { sent.push(row); return sent.length === 1 ? first.promise : second.promise; } }; } };
  app.saveEdit('A', 'wo', 'first');
  app.saveEdit('A', 'wo', 'second');
  assert.equal(sent.length, 1);
  assert.equal(sent[0].edits.wo, 'first');
  first.resolve({}); await tick();
  assert.equal(sent.length, 2);
  assert.equal(sent[1].edits.wo, 'second');
  assert.equal(app._recentWrite('A'), true);
  second.resolve({}); await tick();
  assert.equal(app._recentWrite('A'), false);
  assert.equal(app.state.saveStatus, 'Saved');
});
test('failed saves remain protected and retry automatically', async () => {
  const { app, timers } = setup();
  let attempts = 0;
  app._sb = { from() { return { upsert() { return Promise.resolve(++attempts === 1 ? { error: new Error('offline') } : {}); } }; } };
  app.saveEdit('A', 'wo', 'keep'); await tick();
  assert.equal(app.state.saveStatus, 'Retrying save…');
  assert.equal(app._recentWrite('A'), true);
  const retry = timers.get(app._retryTimers.A);
  assert.equal(retry.ms, 1000);
  await retry.fn();
  assert.equal(attempts, 2);
  assert.equal(app.state.saveStatus, 'Saved');
});
test('poll cannot overwrite an unacknowledged local edit', async () => {
  const { app } = setup();
  app._edits.A = { wo: 'local' };
  app._dirty = { A: true };
  reader(app, { data: [{ ot: 'A', edits: { wo: 'stale' } }] });
  await app._resync('poll');
  assert.equal(app._edits.A.wo, 'local');
});
test('response begun before acknowledgment is discarded', async () => {
  const { app } = setup();
  const read = deferred();
  app._edits.A = { wo: 'new' };
  reader(app, () => read.promise);
  const pending = app._resync('poll');
  app._writeGeneration = 1;
  read.resolve({ data: [{ ot: 'A', edits: { wo: 'old' } }] });
  await pending;
  assert.equal(app._edits.A.wo, 'new');
});
test('proxy mode never starts websocket channels', () => {
  const { app } = setup();
  app._sb = { channel() { assert.fail('WebSocket attempted'); } };
  app._subscribeLive(); app._initPresence();
  assert.equal(app._pollMs(), 3000);
});
test('poll failures back off and recover on success', async () => {
  const { app, timers } = setup();
  reader(app, { error: new Error('offline') });
  await app._resync('poll'); app._schedulePoll();
  assert.equal(timers.get(app._resyncTimer).ms, 6000);
  reader(app, { data: [] });
  await app._resync('focus'); app._schedulePoll();
  assert.equal(timers.get(app._resyncTimer).ms, 3000);
  assert.equal(app.state.live, 'synced');
});
test('hidden page skips scheduled reads', async () => {
  const { app, context, timers } = setup();
  context.document.hidden = true;
  app._resync = () => assert.fail('Hidden page read');
  app._schedulePoll();
  await timers.get(app._resyncTimer).fn();
});
test('admin restores and wipes cannot race pending retries', async () => {
  const { app } = setup();
  app._dirty = { A: true };
  app.state.admin = { stage: 'list', view: {} };
  app._sb = { from() { assert.fail('Bulk write must wait'); } };
  await app._adminRestore('__backup__123');
  await app._adminWipe();
  await app._adminWipeUndo();
  assert.match(app.state.admin.notice, /pending edits/);
});
test('backup restore fetch remains unfiltered', async () => {
  const { app } = setup();
  let fetched;
  app._sb = { from() { return { select() { return { eq(column, key) {
    fetched = key;
    return { single() { return Promise.resolve({ error: new Error('test ends before write') }); } };
  } }; } }; } };
  app._adminRefresh = async () => {};
  await app._adminRestore('__backup__123');
  assert.equal(fetched, '__backup__123');
});
test('multi rows derive status from their most urgent order', () => {
  const { app } = setup();
  const v = (items, extra) => app._multiView({ ot: 'O', multi: true, items: JSON.stringify(items), ...extra });
  assert.equal(v([{ wo: '1', status: 'OT Completed' }, { wo: '2', status: 'Issue/Hold' }]).status, 'Issue/Hold');
  assert.equal(v([{ wo: '1', status: 'BTS Completed' }, { wo: '', status: '' }]).status, 'BTS Completed');
  assert.equal(app.eff(v([{ wo: '9', status: '' }, { wo: '1', status: 'OT Completed' }])), 'WO entered');
  assert.equal(v([{ wo: '1', status: 'OT Completed' }], { status: 'DO NOT USE' }).status, 'DO NOT USE');
  assert.equal(v([{ wo: 'a' }, { wo: 'b' }])._count, 2);
  assert.equal(v([{ wo: 'a' }, { wo: 'b' }]).wo, 'a\nb');
});
test('orders sync and back up as one text field', async () => {
  const { app } = setup();
  app._seedRecords = [{ ot: 'O', zone: 'Overflow', multi: true }];
  app.state.data = { records: app._composeRecords() };
  app._sb = { from() { return { upsert() { return Promise.resolve({}); } }; } };
  app._itemAdd('O'); app._itemEdit('O', 0, 'wo', '555'); app._itemAdd('O'); app._itemRemove('O', 1);
  assert.equal(typeof app._edits.O.items, 'string');
  assert.equal(app._items(app._edits.O).map(i => i.wo).join(), '555');
  assert.equal(app._canonSnapshot().O.items, app._edits.O.items);
  assert.equal(app._sameEdits({ items: '[{"wo":"1"}]' }, { items: '[{"wo":"2"}]' }), false);
});
test('search finds orders inside overflow rows and opens them', () => {
  const { app } = setup();
  app._seedRecords = [{ ot: 'A', bts: 'A', zone: '0100', wo: '' }, { ot: 'ZL4OVRFLW01', bts: 'ZL4OVRFLW01', zone: 'Overflow', multi: true }];
  app._edits = { ZL4OVRFLW01: { items: JSON.stringify([{ wo: 'WO-77', serial: 'SN-9', lpn: 'LP-5', status: 'Issue/Hold' }]) } };
  app.state.data = { records: app._composeRecords() };
  const rows = (q, extra) => { Object.assign(app.state, { query: q, ovCollapsed: false, openRows: {} }, extra); return app.renderVals().rows; };
  for (const q of ['wo-77', 'SN-9', 'lp-5', 'ovrflw01']) assert.equal(rows(q).map(r => r.ot).join(), 'ZL4OVRFLW01', q);
  assert.equal(rows('WO-77')[0].open, true);
  assert.equal(rows('WO-77', { ovCollapsed: true })[0].showRow, true);
  assert.equal(rows('', { ovCollapsed: true }).find(r => r.ot === 'ZL4OVRFLW01').showRow, false);
  assert.equal(rows('nothing').length, 0);
  const sq = app.renderVals().racks.find(r => r.zone === 'Overflow').slots[0];
  app.state.ovCollapsed = true; sq.onSelect();
  assert.equal(app.state.ovCollapsed, false);
});
test('search highlights matching values only while armed', () => {
  const { app } = setup();
  app._seedRecords = [{ ot: 'NA1L4OT0101', bts: 'ZL4BTS0101', zone: '0100', wo: 'WO-1' }, { ot: 'ZL4OVRFLW01', bts: 'ZL4OVRFLW01', zone: 'Overflow', multi: true }];
  app._edits = { ZL4OVRFLW01: { items: JSON.stringify([{ wo: 'WO-1B', serial: 'SN-1' }]) } };
  app.state.data = { records: app._composeRecords() };
  Object.assign(app.state, { query: 'wo-1', openRows: {}, hlOn: true });
  let rs = app.renderVals().rows;
  assert.match(rs[0].cells.find(c => c.key === 'wo').inputStyle, /ot-hl-blink/);
  assert.match(rs[1].orders[0].wo.style, /ot-hl-blink/);
  assert.doesNotMatch(rs[1].orders[0].serial.style, /ot-hl-blink/);
  app.state.hlOn = false;
  rs = app.renderVals().rows;
  assert.doesNotMatch(rs[0].cells.find(c => c.key === 'wo').inputStyle, /ot-hl-blink/);
});
test('Overflow jump button opens the section and clears filters hiding it', () => {
  const { app } = setup();
  app._seedRecords = [{ ot: 'A', bts: 'A', zone: '0100', wo: 'X1' }, { ot: 'ZL4OVRFLW01', bts: 'ZL4OVRFLW01', zone: 'Overflow', multi: true }];
  app.state.data = { records: app._composeRecords() };
  Object.assign(app.state, { query: 'X1', zoneFilter: '0100', ovCollapsed: true, openRows: {} });
  app.renderVals().onOverflowJump();
  assert.equal(app.state.query, ''); assert.equal(app.state.zoneFilter, 'all'); assert.equal(app.state.ovCollapsed, false);
  Object.assign(app.state, { query: 'OVRFLW', ovCollapsed: true });
  app.renderVals().onOverflowJump();
  assert.equal(app.state.query, 'OVRFLW'); assert.equal(app.state.ovCollapsed, false);
});
