import test from 'node:test';
import assert from 'node:assert/strict';
import { fileURLToPath } from 'node:url';
import { bundlePlugin, clone, createHarness, deferred, fakeConsole, flush, pngHeader } from './fakes.mjs';

const sources = await bundlePlugin(fileURLToPath(new URL('../', import.meta.url)));
const token = character => `alk_${character.repeat(43)}`;
const connection = { origin: 'https://console.assetlib.dev', orgId: 'org-one', appId: 'app-a', token: token('a') };
const node = { id: '12:1', name: 'Hero', type: 'FRAME', width: 100, height: 100 };
const placement = { key: 'hero.artwork', screen: 'Home', width: 100, height: 100, states: null, defaultState: null, variants: null, origin: 'declared' };
const otherPlacement = { ...placement, key: 'other.artwork' };
const remembered = { fileKey: 'abc123', nodeId: node.id, placementKey: placement.key, state: null, appearance: null, arm: null };
const targetKey = `assetlib.target.v1:${JSON.stringify([connection.origin, connection.orgId, connection.appId, 'abc123', node.id])}`;
const assetId = '00000000-0000-4000-8000-000000000001';
function artwork() {
  return { environments: { staging: null, production: null }, assets: {}, placements: [placement, otherPlacement].map(item => ({ ...item,
    cells: [{ state: null, appearance: null, arm: null, draft: null, staging: null, production: null }] })) };
}
async function harness(options = {}) {
  const config = options.connection ?? connection;
  const console = { placements: [clone(placement), clone(otherPlacement)], artwork: artwork(),
    identity: { orgId: config.orgId, appId: config.appId, workspaceName: 'Workspace', appName: 'App', scopes: ['draft'] } };
  const app = createHarness({ ...sources, uiSource: 'const setTimeout = window.setTimeout; const clearTimeout = window.clearTimeout;\n' + sources.uiSource,
    fetch: fakeConsole(console), selection: [node], exportBytes: () => pngHeader(100, 100),
    storage: [['assetlib.connection.v1', config], [targetKey, remembered], ['assetlib.preferences.v1', { tab: 'send' }]], ...options });
  await flush();
  return { ...app, console };
}

test('file-link autosave does not mark a newer edit as saved when an older write completes', async () => {
  const app = await harness({ fileKeyUnavailable: true, rootName: 'Test design' });
  app.element('placement').value = placement.key;
  app.element('placement').dispatch('change');
  app.element('send').dispatch('click');
  await flush();
  const gate = deferred();
  const set = app.figma.clientStorage.setAsync;
  app.figma.clientStorage.setAsync = async (key, value) => {
    if (key === 'assetlib.file-url.v1' && value.includes('first123')) await gate.promise;
    return set(key, value);
  };
  app.element('file-url').value = 'https://www.figma.com/design/first123/Test-design';
  app.element('file-url').dispatch('input'); app.fireTimers(350);
  await flush();
  app.element('file-url').value = 'https://www.figma.com/design/second123/Test-design';
  app.element('file-url').dispatch('input');
  gate.resolve();
  await flush();
  app.fireTimers(350);
  await flush();
  assert.equal(app.mainMessages.filter(item => item.type === 'selection').at(-1).selection.fileKey, 'second123');
  assert.equal(app.storage.get('assetlib.file-url.v1'), 'https://www.figma.com/design/second123/Test-design');
});

test('a freshly relinked selected layer adopts its new destination instead of retaining the old target', async () => {
  const app = await harness();
  assert.equal(app.element('placement').value, placement.key);
  app.storage.set(targetKey, { ...remembered, placementKey: otherPlacement.key });
  app.figma.currentPage.selection[0].setPluginData('assetlib.link.v1', JSON.stringify({ v: 1, origin: connection.origin,
    orgId: connection.orgId, appId: connection.appId, nodeId: node.id, insertedAt: '2026-10-21T00:00:00.000Z',
    placementKey: otherPlacement.key, state: null, appearance: null, arm: null, environment: 'draft', assetId }));
  app.selectionChanged();
  await flush();
  assert.equal(app.element('placement').value, otherPlacement.key);
});

test('a refused preflight adopts the browser connection already saved by another window', async () => {
  const browser = { ...connection, method: 'browser', pairing: 'ABCD2345', connectedAs: 'designer@example.com' };
  const app = await harness({ connection: browser });
  const newer = { ...browser, token: token('b') };
  app.storage.set('assetlib.connection.v1', newer);
  app.console.revoked.add(browser.token);
  app.element('send').dispatch('click');
  await flush();
  assert.ok(app.uiMessages.some(item => item.type === 'reload-connection'));
  assert.equal(app.mainMessages.filter(item => item.type === 'connection').at(-1).connection.token, newer.token);
  assert.equal(app.drafts().length, 0);
});
