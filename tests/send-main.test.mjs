import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { clone, createHarness, deferred, flush, pngHeader } from './fakes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const result = await build({ absWorkingDir: root, entryPoints: ['src/code.ts'], bundle: true, write: false, format: 'iife' });
const mainSource = result.outputFiles[0].text;
const connection = { origin: 'https://console.assetlib.dev', orgId: 'org-one', appId: 'app-a', token: `alk_${'a'.repeat(43)}` };
const placement = { key: 'hero.artwork', screen: 'Home', width: 100, height: 100, states: null, defaultState: null,
  variants: null, origin: 'declared' };
const node = { id: '12:1', name: 'First image', type: 'FRAME', width: 100, height: 100 };
const other = { ...node, id: '12:2', name: 'Second image' };
const bind = { slotKey: placement.key, state: null, appearance: null, arm: null };
const assetId = '00000000-0000-4000-8000-000000000001';
const key = (prefix, nodeId = node.id) => `assetlib.${prefix}.v1:${JSON.stringify([connection.origin, connection.orgId, connection.appId, 'abc123', nodeId])}`;
async function harness(options = {}) {
  const app = createHarness({ mainSource, uiSource: 'window.onmessage = () => {};', fetch: async () => { throw new Error('No HTTP in main'); },
    selection: [node, other], storage: [['assetlib.connection.v1', connection]], exportBytes: () => pngHeader(100, 100), ...options });
  app.postToMain({ type: 'init' });
  await flush();
  return app;
}
const selection = app => app.mainMessages.filter(item => item.type === 'selection').at(-1).selection;
const error = (app, id) => app.mainMessages.find(item => item.type === 'error' && item.requestId === id);
const exported = (app, id) => app.mainMessages.find(item => item.type === 'exported' && item.requestId === id);
function exportMessage(app, requestId = 1, selected = other) {
  return { type: 'export', requestId, connectionGeneration: 0, selectionIds: selection(app).selectionIds,
    node: clone(selected), fileKey: 'abc123', placement: clone(placement), bind: clone(bind), rebind: false };
}
function choice(requestId = 50, nodeId = node.id, placementKey = placement.key) {
  return { type: 'save-send-choice', requestId, connectionGeneration: 0, fileKey: 'abc123', nodeId,
    placementKey, state: null, appearance: null, arm: null };
}

test('reports each selected layer, unsupported area, and a bounded overflow without changing Insert selection', async () => {
  const app = await harness({ selection: [other, { ...node, width: 0 }] });
  assert.deepEqual(selection(app).selectionIds, [node.id, other.id]);
  assert.equal(selection(app).node, null);
  assert.equal(selection(app).remembered, null);
  assert.deepEqual(selection(app).sendNodes.map(item => item.node.id), [other.id, node.id]);
  assert.equal(selection(app).sendNodes[0].reason, null);
  assert.match(selection(app).sendNodes[1].reason, /no visible area/);
  const many = await harness({ selection: Array.from({ length: 51 }, (_, index) => ({ ...node, id: `15:${index}` })) });
  assert.equal(selection(many).sendNodes.length, 50);
  assert.equal(selection(many).selectionIds.length, 50);
  assert.equal(selection(many).truncated, true);
  assert.match(selection(many).reason, /up to 50/);
  many.postToMain(exportMessage(many, 1, { ...node, id: '15:0' }));
  await flush();
  assert.ok(error(many, 1));
  assert.equal(many.exports.length, 0);
});

test('exports a member of the full selected set and remembers the exported node after the user selects another', async () => {
  const app = await harness();
  const before = [...app.figma.currentPage.selection];
  app.postToMain(exportMessage(app));
  await flush();
  assert.equal(exported(app, 1)?.node.id, other.id);
  assert.deepEqual([...app.figma.currentPage.selection], before, 'export never changes the canvas selection');
  app.select([before[0]]);
  await flush();
  app.postToMain({ type: 'remember', requestId: 1, assetId });
  await flush();
  assert.equal(error(app, 1), undefined);
  assert.equal(JSON.parse(before[1].getPluginData('assetlib.link.v1')).nodeId, other.id);
  assert.equal(before[0].getPluginData('assetlib.link.v1'), '');
  assert.equal(app.storage.get(key('target', other.id)).placementKey, placement.key);
});

test('batch exports reject stale generation, membership and malformed selection snapshots before exporting', async () => {
  for (const changes of [{ connectionGeneration: 8 }, { selectionIds: [node.id] }, { selectionIds: [other.id, other.id] },
    { selectionIds: ['bad/identity'] }]) {
    const app = await harness();
    app.postToMain({ ...exportMessage(app), ...changes });
    await flush();
    assert.ok(error(app, 1));
    assert.equal(app.exports.length, 0);
  }
});

test('export completion refuses a switched selection, connection, file, resized node or changed link', async () => {
  for (const change of [
    app => app.select([app.figma.currentPage.selection[0]]),
    app => app.postToMain({ type: 'save-connection', requestId: 8, connection: { ...connection, token: `alk_${'b'.repeat(43)}` } }),
    app => Object.defineProperty(app.figma, 'fileKey', { get: () => 'different' }),
    app => { app.figma.currentPage.selection[1].width = 110; },
    app => app.figma.currentPage.selection[1].setPluginData('assetlib.link.v1', JSON.stringify({ v: 1, origin: connection.origin,
      orgId: connection.orgId, appId: connection.appId, nodeId: other.id, insertedAt: '2026-10-21T00:00:00.000Z',
      placementKey: placement.key, state: null, appearance: null, arm: null, environment: 'draft', assetId })),
  ]) {
    const app = await harness();
    const gate = app.delayExport();
    app.postToMain(exportMessage(app));
    await flush();
    assert.equal(app.exports.length, 1);
    change(app);
    await flush();
    gate.resolve();
    await flush();
    assert.equal(exported(app, 1), undefined);
    assert.match(error(app, 1)?.message ?? '', /selection changed/i);
    assert.equal(app.storage.has(key('target', other.id)), false);
  }
});

test('a late draft success cannot relink or remember after the connection or link changes', async () => {
  for (const change of [
    app => app.postToMain({ type: 'clear-connection', requestId: 8 }),
    app => { app.figma.currentPage.selection[1].name = 'Edited after export'; },
    app => app.figma.currentPage.selection[1].setPluginData('assetlib.link.v1', 'a changed link'),
    app => Object.defineProperty(app.figma, 'fileKey', { get: () => 'different' }),
  ]) {
    const app = await harness();
    const sent = app.figma.currentPage.selection[1];
    app.postToMain(exportMessage(app));
    await flush();
    assert.ok(exported(app, 1));
    change(app);
    await flush();
    const unchangedLink = sent.getPluginData('assetlib.link.v1');
    app.postToMain({ type: 'remember', requestId: 1, assetId });
    await flush();
    assert.ok(error(app, 1));
    assert.equal(app.storage.has(key('target', other.id)), false);
    assert.equal(sent.getPluginData('assetlib.link.v1'), unchangedLink);
  }
});

test('a harmless connection-name refresh during export keeps the same connection usable', async () => {
  const app = await harness();
  const gate = app.delayExport();
  app.postToMain(exportMessage(app));
  await flush();
  app.postToMain({ type: 'save-names', connectionGeneration: 0, orgId: connection.orgId, appId: connection.appId,
    workspaceName: 'Renamed workspace', appName: 'Renamed app' });
  await flush();
  gate.resolve();
  await flush();
  assert.ok(exported(app, 1));
  app.postToMain({ type: 'remember', requestId: 1, assetId });
  await flush();
  assert.equal(error(app, 1), undefined);
  assert.equal(JSON.parse(app.figma.currentPage.selection[1].getPluginData('assetlib.link.v1')).assetId, assetId);
});

test('changing a connection while remembering a sent target never relinks the layer', async () => {
  const app = await harness();
  app.postToMain(exportMessage(app));
  await flush();
  const gate = deferred();
  const set = app.figma.clientStorage.setAsync;
  app.figma.clientStorage.setAsync = async (name, value) => {
    if (name.startsWith('assetlib.target.v1:')) await gate.promise;
    return set(name, value);
  };
  app.postToMain({ type: 'remember', requestId: 1, assetId });
  await flush();
  app.postToMain({ type: 'clear-connection', requestId: 8 });
  await flush();
  gate.resolve();
  await flush();
  assert.ok(error(app, 1));
  assert.equal(app.figma.currentPage.selection[1].getPluginData('assetlib.link.v1'), '');
});

test('an unsent destination survives reopening separately from links and remembered successful sends', async () => {
  const app = await harness();
  app.postToMain(choice());
  await flush();
  assert.ok(app.mainMessages.some(item => item.type === 'send-choice-saved' && item.requestId === 50));
  assert.equal(selection(app).sendNodes[0].choice.placementKey, placement.key);
  assert.equal(selection(app).sendNodes[0].remembered, null);
  assert.equal(app.storage.has(key('target')), false);
  assert.equal(app.figma.currentPage.selection[0].getPluginData('assetlib.link.v1'), '');
  assert.equal(app.relaunches.length, 0);
  assert.equal(app.exports.length, 0);
  const reopened = await harness({ store: app.storage, selection: [node] });
  assert.equal(selection(reopened).choice.placementKey, placement.key);
  assert.equal(selection(reopened).remembered, null);
});

test('destination saves reject another selection, file, generation and invalid coordinates', async () => {
  for (const change of [{ nodeId: '9:9' }, { fileKey: 'otherfile' }, { connectionGeneration: 2 },
    { placementKey: '../invalid' }, { state: '__proto__' }, { arm: 'control' }, { appearance: 'unknown' }]) {
    const app = await harness();
    app.postToMain({ ...choice(), ...change });
    await flush();
    assert.ok(error(app, 50));
    assert.equal([...app.storage.keys()].some(item => item.startsWith('assetlib.send-choice.v1:')), false);
  }
});

test('successive destination autosaves preserve the latest choice even when the first write waits', async () => {
  const app = await harness();
  const gate = deferred();
  const set = app.figma.clientStorage.setAsync;
  let count = 0;
  app.figma.clientStorage.setAsync = async (name, value) => {
    if (name.startsWith('assetlib.send-choice.v1:') && ++count === 1) await gate.promise;
    return set(name, value);
  };
  app.postToMain(choice(50));
  await flush();
  app.postToMain(choice(51, node.id, 'onboarding.artwork'));
  await flush();
  gate.resolve();
  await flush();
  assert.equal(app.storage.get(key('send-choice')).placementKey, 'onboarding.artwork');
  assert.equal(selection(app).sendNodes[0].choice.placementKey, 'onboarding.artwork');
});

test('the canvas poll notices metadata and image changes on any selected batch member', async () => {
  const app = await harness();
  app.figma.currentPage.selection[1].name = 'Renamed second image';
  app.tick();
  await flush();
  assert.equal(selection(app).sendNodes[1].node.name, 'Renamed second image');
  app.figma.currentPage.selection[1].width = 200;
  app.tick();
  await flush();
  assert.equal(selection(app).sendNodes[1].node.width, 200);
});

test('a fill waits for an older destination autosave before clearing it and reporting its new link', async () => {
  const app = await harness({ selection: [{ ...node, type: 'RECTANGLE', fills: [] }] });
  const gate = deferred();
  const set = app.figma.clientStorage.setAsync;
  app.figma.clientStorage.setAsync = async (name, value) => {
    if (name.startsWith('assetlib.send-choice.v1:')) await gate.promise;
    return set(name, value);
  };
  app.postToMain(choice());
  await flush();
  app.postToMain({ type: 'insert', requestId: 80, connectionGeneration: 0, bytes: pngHeader(100, 100), name: 'New destination',
    frame: { width: 100, height: 100 }, scale: 1, target: { kind: 'fill', nodeIds: [node.id] },
    link: { placementKey: 'other.artwork', state: null, appearance: null, arm: null, environment: 'draft', assetId } });
  await flush();
  gate.resolve();
  await flush();
  assert.equal(error(app, 80), undefined);
  assert.equal(app.storage.has(key('send-choice')), false);
  assert.equal(selection(app).choice, null);
  assert.equal(selection(app).remembered.placementKey, 'other.artwork');
});

test('a failed choice deletion after a fill cannot report the obsolete destination ahead of the new link', async () => {
  const app = await harness({ selection: [{ ...node, type: 'RECTANGLE', fills: [] }],
    storage: [['assetlib.connection.v1', connection], [key('send-choice'), { fileKey: 'abc123', nodeId: node.id, placementKey: placement.key,
      state: null, appearance: null, arm: null }]], failingWrites: [key('send-choice')] });
  app.postToMain({ type: 'insert', requestId: 80, connectionGeneration: 0, bytes: pngHeader(100, 100), name: 'New destination',
    frame: { width: 100, height: 100 }, scale: 1, target: { kind: 'fill', nodeIds: [node.id] },
    link: { placementKey: 'other.artwork', state: null, appearance: null, arm: null, environment: 'draft', assetId } });
  await flush();
  assert.equal(error(app, 80), undefined);
  assert.equal(selection(app).choice, null);
  assert.equal(selection(app).remembered.placementKey, 'other.artwork');
});
