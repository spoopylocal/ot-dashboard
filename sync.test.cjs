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
