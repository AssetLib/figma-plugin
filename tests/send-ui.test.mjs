import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { bundlePlugin, clone, createHarness, descendants, fakeConsole, flush, pngHeader, textOf } from './fakes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = await bundlePlugin(root);
const connection = { origin: 'https://console.assetlib.dev', orgId: 'org-one', appId: 'app-a', token: `alk_${'a'.repeat(43)}` };
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const nodes = ['Coast', 'Garden', 'Ridge'].map((name, index) => ({ id: `12:${index + 1}`, name, type: 'FRAME', width: 100, height: 100 }));
const placements = ['travel.coast', 'home.garden', 'travel.ridge'].map(key => ({ key, screen: 'Home', width: 100, height: 100,
  states: null, defaultState: null, variants: null, origin: 'declared' }));
const binding = index => ({ slotKey: placements[index].key, state: null, appearance: null, arm: null });
const targetKey = nodeId => `assetlib.target.v1:${JSON.stringify([connection.origin, connection.orgId, connection.appId, 'abc123', nodeId])}`;
const response = (status, payload) => ({ status, headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json' : null },
  async json() { return clone(payload); }, async arrayBuffer() { return new TextEncoder().encode(JSON.stringify(payload)).buffer; } });
const artwork = () => ({ environments: { staging: null, production: null }, assets: {}, placements: placements.map((placement, index) => ({
  ...clone(placement), slotId: uuid(index + 1), cells: [{ state: null, appearance: null, arm: null, draft: null, staging: null, production: null }],
})) });

// This wrapper exercises the conditional wire contract without changing other suites' shared fake console.
function conditionalConsole(state, draft = () => null) {
  const fallback = fakeConsole(state);
  let nextAsset = 100;
  const addAsset = (id, name = 'Remote artwork') => {
    state.artwork.assets[id] = { id, name, width: 100, height: 100, createdAt: '2026-10-21T12:00:00.000Z', processingIntent: 'artwork',
      renditions: [{ sha256: 'a'.repeat(64), mime: 'image/png', bytes: 33, width: 100, height: 100 }] };
    return id;
  };
  const setDraft = (key, id) => {
    if (id !== null) addAsset(id);
    state.artwork.placements.find(item => item.key === key).cells[0].draft = id === null ? null : { assetId: id, via: { arm: null, appearance: null } };
  };
  const result = (body, bound = body.bind, bindError = null) => {
    const id = addAsset(uuid(nextAsset++), body.name);
    if (bound) setDraft(bound.slotKey, id);
    return { asset: { id, name: body.name, width: 100, height: 100, sha256: 'a'.repeat(64), renditions: 1 }, previous: null, bound, bindError, rebound: [] };
  };
  return { setDraft, fetch: async (url, options, request) => {
    if (!url.endsWith('/drafts')) return fallback(url, options, request);
    request.route = 'drafts';
    const body = request.body;
    const scripted = await draft(body, { result, setDraft, response });
    if (scripted) return scripted;
    const current = state.artwork.placements.find(item => item.key === body.bind.slotKey).cells[0].draft?.assetId ?? null;
    if (body.expectedAssetId !== current) return response(409, { error: 'Draft changed. Nothing was uploaded.', code: 'draft_changed' });
    return response(201, result(body));
  } };
}
async function settle() { for (let index = 0; index < 8; index++) await flush(); }
async function harness({ count = 2, destinations = [0, 1, 2], draft, ...options } = {}) {
  const selected = nodes.slice(0, count);
  const state = { placements: clone(placements), artwork: artwork(), library: [] };
  const server = conditionalConsole(state, draft);
  const app = createHarness({ ...sources, fetch: server.fetch, selection: selected, exportBytes: () => pngHeader(100, 100),
    storage: [['assetlib.connection.v1', connection], ['assetlib.preferences.v1', { tab: 'send' }],
      ...selected.map((node, index) => [targetKey(node.id), { fileKey: 'abc123', nodeId: node.id, placementKey: placements[destinations[index]].key,
        state: null, appearance: null, arm: null }])], ...options });
  await settle();
  return { ...app, console: state, setDraft: server.setDraft };
}
const row = (app, index) => app.element('send-items').children.find(item => item.getAttribute('data-node-id') === nodes[index].id);
const rowState = (app, index) => row(app, index).getAttribute('data-state');
const off = app => app.element('send').getAttribute('aria-disabled') === 'true';
const button = (container, label) => descendants(container).find(item => item.tagName === 'BUTTON' && item.textContent === label);
const drafts = app => app.requests.filter(item => item.route === 'drafts');
async function send(app) { app.element('send').dispatch('click'); await settle(); }

test('Send selection sends each layer to its own displayed destination and retains individual receipts', async () => {
  const app = await harness({ count: 3 });
  assert.equal(off(app), false);
  assert.equal(app.element('send').textContent, 'Send 3 layers to draft');
  for (let index = 0; index < 3; index++) assert.match(textOf(row(app, index)), new RegExp(placements[index].key));
  await send(app);
  assert.deepEqual(drafts(app).map(item => item.body.source.nodeId), nodes.map(node => node.id));
  assert.deepEqual(drafts(app).map(item => item.body.bind), [binding(0), binding(1), binding(2)]);
  assert.ok(drafts(app).every(item => item.body.rebind === false && item.body.expectedAssetId === null));
  assert.deepEqual([0, 1, 2].map(index => rowState(app, index)), ['sent', 'sent', 'sent']);
  assert.match(textOf(app.element('result')), /3 of 3 layers sent to draft/);
  assert.equal(off(app), false, 'a completely successful selection remains ready for one-action repeat sending');
  const previousAssets = app.console.artwork.placements.map(item => item.cells[0].draft.assetId);
  for (let index = 0; index < 3; index++) {
    const link = JSON.parse(app.figma.currentPage.selection[index].getPluginData('assetlib.link.v1'));
    assert.equal(link.placementKey, placements[index].key);
    assert.equal(link.assetId, app.console.artwork.placements[index].cells[0].draft.assetId);
  }
  await settle();
  assert.equal(drafts(app).length, 3, 'completed rows are never sent again without another deliberate action');
  await send(app);
  assert.equal(drafts(app).length, 6);
  assert.deepEqual(drafts(app).slice(3).map(item => item.body.expectedAssetId), previousAssets);
});

test('duplicate selected destinations block sends until one layer is explicitly skipped', async () => {
  const app = await harness({ destinations: [0, 0] });
  assert.equal(off(app), true);
  assert.match(textOf(row(app, 0)), /Another layer uses this destination/);
  assert.match(textOf(row(app, 1)), /Another layer uses this destination/);
  await send(app);
  assert.equal(app.exportMessages().length, 0);
  assert.equal(drafts(app).length, 0);
  button(row(app, 1), 'Skip').dispatch('click');
  await settle();
  assert.equal(off(app), false);
  await send(app);
  assert.deepEqual(drafts(app).map(item => item.body.source.nodeId), [nodes[0].id]);
  assert.equal(rowState(app, 0), 'sent');assert.equal(rowState(app, 1), 'skipped');
});

test('successful, uploaded-unassigned and uncertain rows keep separate outcomes and never retry automatically', async () => {
  const app = await harness({ count: 3, draft: (body, api) => {
    if (body.source.nodeId === nodes[1].id) return api.response(409, api.result(body, null, 'The placement changed.'));
    if (body.source.nodeId === nodes[2].id) { api.result(body); throw new TypeError('The response was lost after acceptance.'); }
    return null;
  } });
  await send(app);
  assert.deepEqual([0, 1, 2].map(index => rowState(app, index)), ['sent', 'partial', 'unknown']);
  assert.match(textOf(row(app, 1)), /Uploaded but not assigned/);
  assert.match(textOf(row(app, 2)), /may have arrived|may have accepted/i);
  assert.equal(button(row(app, 1), 'Retry').hidden, true);
  assert.equal(button(row(app, 2), 'Retry').hidden, true);
  assert.equal(off(app), true);
  await send(app);app.tick();await settle();await send(app);
  assert.equal(drafts(app).length, 3);
  assert.equal(app.exportMessages().length, 3);
  assert.match(textOf(app.element('result')), /1 of 3 layers sent to draft/);
  assert.ok(app.console.artwork.placements[2].cells[0].draft, 'the uncertain write really may have reached its destination');
});

test('retrying a definitive failed row sends only that row and preserves earlier successes', async () => {
  let failed = false;
  const app = await harness({ draft: (body, api) => {
    if (body.source.nodeId === nodes[1].id && !failed) { failed = true; return api.response(400, { error: 'The request was refused before upload.' }); }
    return null;
  } });
  await send(app);
  assert.equal(rowState(app, 0), 'sent');assert.equal(rowState(app, 1), 'failed');
  const firstAsset = app.console.artwork.placements[0].cells[0].draft.assetId;
  button(row(app, 1), 'Retry').dispatch('click');
  await send(app);
  assert.deepEqual(drafts(app).map(item => item.body.source.nodeId), [nodes[0].id, nodes[1].id, nodes[1].id]);
  assert.deepEqual([0, 1].map(index => rowState(app, index)), ['sent', 'sent']);
  assert.equal(app.console.artwork.placements[0].cells[0].draft.assetId, firstAsset);
});

test('a changed draft discovered before export blocks the row until an explicit replacement review', async () => {
  const app = await harness({ count: 1 });
  const replacement = uuid(81);
  app.setDraft(placements[0].key, replacement);
  await send(app);
  assert.equal(rowState(app, 0), 'conflict');
  assert.equal(app.exportMessages().length, 0);assert.equal(drafts(app).length, 0);
  assert.equal(off(app), true);
  await send(app);assert.equal(drafts(app).length, 0);
  button(app.element('send-review'), 'Use this layer instead').dispatch('click');
  assert.equal(drafts(app).length, 0, 'reviewing replacement does not itself send');
  await send(app);
  assert.equal(drafts(app).length, 1);assert.equal(drafts(app)[0].body.expectedAssetId, replacement);
  assert.equal(rowState(app, 0), 'sent');
});

test('a server conflict after preflight refreshes the draft and requires another explicit review', async () => {
  let changed = false;
  const replacement = uuid(82);
  const app = await harness({ count: 1, draft: (body, api) => {
    if (!changed) { changed = true; api.setDraft(body.bind.slotKey, replacement); }
    return null;
  } });
  await send(app);
  assert.equal(drafts(app).length, 1);assert.equal(drafts(app)[0].body.expectedAssetId, null);
  assert.equal(rowState(app, 0), 'conflict');assert.match(textOf(row(app, 0)), /Nothing was uploaded/);
  assert.equal(app.console.artwork.placements[0].cells[0].draft.assetId, replacement);
  await send(app);assert.equal(drafts(app).length, 1);
  button(app.element('send-review'), 'Use this layer instead').dispatch('click');
  await send(app);
  assert.equal(drafts(app).length, 2);assert.equal(drafts(app)[1].body.expectedAssetId, replacement);
  assert.equal(rowState(app, 0), 'sent');
});

test('batch issue navigation includes ratio problems and draft conflicts without sending them', async () => {
  const app = await harness();
  app.figma.currentPage.selection[1].width = 200; app.tick(); await settle();
  assert.equal(app.element('send-attention').textContent, 'Needs attention (1)');
  app.element('send-next-issue').click(); await settle();
  assert.equal(row(app, 1).getAttribute('aria-current'), 'true');
  app.figma.currentPage.selection[1].width = 100; app.tick(); await settle();
  app.setDraft(placements[0].key, uuid(85)); await send(app);
  assert.equal(rowState(app, 0), 'conflict');
  assert.equal(rowState(app, 1), 'sent');
  assert.equal(app.element('send-attention').textContent, 'Needs attention (1)');
  const count = drafts(app).length;
  app.element('send-next-issue').click(); await settle();
  assert.equal(row(app, 0).getAttribute('aria-current'), 'true');
  assert.equal(app.element('send-review').hidden, false);
  assert.equal(app.element('send-comparison').hidden, false);
  assert.equal(drafts(app).length, count);
});
