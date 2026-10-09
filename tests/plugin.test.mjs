import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = fileURLToPath(new URL('../', import.meta.url));
const [mainSource, uiSource] = await Promise.all(['src/code.ts', 'src/ui.ts'].map(async entry => {
  const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, format: 'iife' });
  return result.outputFiles[0].text;
}));

const connection = { origin: 'https://console.assetlib.dev', orgId: 'org-one', appId: 'app-a', token: 'draft_a' };
// Connections saved before the console moved to console.assetlib.dev name its earlier host.
const legacyConnection = { ...connection, origin: 'https://assetlib-console.vercel.app' };
const placement = { key: 'hero.artwork', screen: 'Home', width: 1000, height: 1000,
  states: ['old', 'new'], defaultState: 'old', variants: { appearance: ['light', 'dark'], arm: ['b', 'c'] }, origin: 'declared' };
const node = { id: '12:34', name: 'Hero artwork', type: 'FRAME', width: 1000, height: 1000 };
const rememberedA = { fileKey: 'abc123', nodeId: node.id, placementKey: placement.key, state: 'old', appearance: 'light', arm: 'b' };
const rememberedB = { ...rememberedA, state: 'new', appearance: 'dark', arm: 'c' };
const storageKey = config => `assetlib.target.v1:${JSON.stringify([config.origin, config.orgId, config.appId, 'abc123', node.id])}`;
const clone = value => structuredClone(value);

// Only the PNG signature and complete IHDR chunk are needed by the header check.
function pngHeader(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

function deferred() {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
}

class Element {
  constructor(id = '') {
    this.id = id;
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.children = [];
    this.listeners = new Map();
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  dispatch(type) { this.listeners.get(type)?.({ preventDefault() {} }); }
  replaceChildren(...children) {
    this.children = children;
    if (['placement', 'state', 'appearance', 'arm'].includes(this.id)) this.value = children[0]?.value ?? '';
  }
  append(...children) { this.children.push(...children); }
}

function harness({ remembered = rememberedA, bytes = pngHeader(1000, 1000), saved = connection } = {}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const controls = ['origin', 'org-id', 'app-id', 'token', 'placement', 'state', 'appearance', 'arm', 'send', 'sync', 'file-url'];
  const mainMessages = [];
  const uiMessages = [];
  const requests = [];
  const exports = [];
  const pendingReads = [];
  const storage = new Map(saved ? [['assetlib.connection.v1', clone(saved)], [storageKey(saved), clone(remembered)]] : []);
  const events = new Map();
  let delayTargets = false;
  let connectionWrite = null;
  const window = { setTimeout: () => 1, clearTimeout() {} };
  const parent = { postMessage({ pluginMessage }) {
    const message = clone(pluginMessage);
    uiMessages.push(message);
    figma.ui.onmessage(message);
  } };
  const deliver = message => window.onmessage({ source: parent, data: { pluginMessage: clone(message) } });
  const figma = {
    fileKey: 'abc123',
    currentPage: { selection: [{ ...node, removed: false, async exportAsync(settings) {
      exports.push(clone(settings));
      return bytes;
    } }] },
    clientStorage: {
      async getAsync(key) {
        if (delayTargets && key.startsWith('assetlib.target.v1:')) {
          const pending = { key, ...deferred() };
          pendingReads.push(pending);
          return pending.promise;
        }
        return clone(storage.get(key));
      },
      async setAsync(key, value) {
        if (key === 'assetlib.connection.v1' && connectionWrite) await connectionWrite.promise;
        storage.set(key, clone(value));
      },
    },
    showUI() {},
    on(type, callback) { events.set(type, callback); },
    ui: { postMessage(message) { mainMessages.push(clone(message)); deliver(message); } },
  };
  vm.runInNewContext(mainSource, { figma, __html__: '' }, { filename: 'code.bundle.js' });
  vm.runInNewContext(uiSource, {
    parent, window, AbortController,
    document: { getElementById: element, querySelectorAll: () => controls.map(element), createElement: () => new Element() },
    Option: class { constructor(text, value) { this.textContent = text; this.value = value; } },
    async fetch(url, options) {
      const request = { url, method: options.method, authorization: options.headers.Authorization,
        body: options.body ? JSON.parse(options.body) : null };
      requests.push(request);
      if (request.method === 'GET') return { status: 200, async json() { return { placements: [clone(placement)] }; } };
      return { status: 201, async json() {
        return { asset: { id: 'asset-new', name: node.name, width: 1000, height: 1000, sha256: 'a'.repeat(64), renditions: 1 },
          previous: null, bound: request.body.bind, bindError: null, rebound: request.body.rebind ? [request.body.bind] : [] };
      } };
    },
  }, { filename: 'ui.bundle.js' });
  return {
    element, mainMessages, uiMessages, requests, exports, pendingReads, deliver, storage,
    drafts: () => requests.filter(request => request.method === 'POST'),
    exportMessages: () => uiMessages.filter(message => message.type === 'export'),
    delayTargetReads() { delayTargets = true; },
    resumeTargetReads() { delayTargets = false; },
    delayConnectionWrite() { connectionWrite = deferred(); return connectionWrite; },
    selectionChanged() { events.get('selectionchange')(); },
    saveConnection(next) {
      element('origin').value = next.origin;
      element('org-id').value = next.orgId;
      element('app-id').value = next.appId;
      element('token').value = next.token;
      element('connection-form').dispatch('submit');
    },
  };
}

async function flush() {
  // Drain all promises used by the real UI/main handlers without real network or timers.
  await new Promise(resolve => setImmediate(resolve));
}

for (const [description, next] of [
  ['switching apps', { ...connection, appId: 'app-b', token: 'draft_b' }],
  ['rotating the token in the same app', { ...connection, token: 'draft_rotated' }],
]) {
  test(`delayed client storage cannot queue a rebind with old coordinates when ${description}`, async () => {
    const app = harness();
    await flush();
    assert.equal(app.element('sync').disabled, false);
    const initialSelection = app.mainMessages.find(message => message.type === 'selection');

    app.delayTargetReads();
    app.selectionChanged();
    await flush();
    assert.equal(app.pendingReads.length, 1, 'an old-generation storage lookup is still in flight');
    const write = app.delayConnectionWrite();
    app.saveConnection(next);
    app.deliver(initialSelection);
    assert.equal(app.element('sync').hidden, true, 'saving immediately clears the remembered target');
    app.element('sync').dispatch('click');
    assert.equal(app.exportMessages().length, 0, 'a late reply cannot restore Sync before the save acknowledgement');

    write.resolve();
    await flush();
    assert.equal(app.pendingReads.length, 2, 'the new-generation storage lookup remains delayed');
    assert.ok(app.requests.some(request => request.method === 'GET' && request.authorization === `Bearer ${next.token}`),
      'the new placements response has already completed');
    assert.equal(app.element('sync').disabled, true);
    assert.equal(app.element('send').disabled, true, 'send also waits for a matching selection state');
    app.element('sync').dispatch('click');
    app.element('send').dispatch('click');
    assert.equal(app.exportMessages().length, 0, 'direct handler dispatch cannot bypass selection readiness');
    assert.equal(app.drafts().length, 0);

    app.deliver(initialSelection);
    assert.equal(app.element('sync').hidden, true, 'the UI ignores replies carrying the old connection generation');
    const selectionsBeforeOldRead = app.mainMessages.filter(message => message.type === 'selection').length;
    app.pendingReads[0].resolve(clone(rememberedA));
    await flush();
    assert.equal(app.mainMessages.filter(message => message.type === 'selection').length, selectionsBeforeOldRead,
      'main suppresses its old-generation storage result');
    app.element('sync').dispatch('click');
    assert.equal(app.exportMessages().length, 0);

    app.pendingReads[1].resolve(clone(rememberedB));
    app.resumeTargetReads();
    await flush();
    assert.equal(app.element('sync').disabled, false);
    app.element('sync').dispatch('click');
    await flush();
    assert.equal(app.exportMessages().length, 1);
    assert.deepEqual(app.exportMessages()[0].bind, { slotKey: placement.key, state: 'new', appearance: 'dark', arm: 'c' });
    assert.equal(app.drafts().length, 1);
    assert.equal(app.drafts()[0].authorization, `Bearer ${next.token}`);
    assert.equal(app.drafts()[0].body.rebind, true);
    assert.deepEqual(app.drafts()[0].body.bind, app.exportMessages()[0].bind);
    assert.equal(app.exports[0].useAbsoluteBounds, true);
  });
}

test('a current-generation selection without a remembered target enables Send while leaving Sync unavailable', async () => {
  const app = harness({ remembered: null });
  await flush();
  assert.equal(app.element('send').disabled, false);
  assert.equal(app.element('sync').hidden, true);
  assert.equal(app.element('sync').disabled, true);
  app.element('send').dispatch('click');
  await flush();
  assert.equal(app.drafts().length, 1);
  assert.equal(app.drafts()[0].body.rebind, false);
});

test('actual PNG dimensions block upload when node metadata matches but the exported aspect differs', async () => {
  const app = harness({ bytes: pngHeader(1500, 1000) });
  await flush();
  assert.equal(app.element('aspect-warning').hidden, true, 'the measured node aspect matches the placement');
  app.element('sync').dispatch('click');
  await flush();
  assert.equal(app.exports.length, 1);
  assert.equal(app.exports[0].useAbsoluteBounds, true);
  assert.equal(app.drafts().length, 0, 'reject the PNG before creating a console draft');
  assert.equal(app.uiMessages.filter(message => message.type === 'remember').length, 0);
  assert.equal(app.element('error').hidden, false);
  assert.match(app.element('error').textContent, /PNG.*1500.*1000/i);
  assert.match(app.element('error').textContent, /aspect|ratio/i);
  assert.equal(app.element('sync').disabled, false, 'a rejected export can be corrected and retried');
});

for (const width of [1000, 1019, 981, 1020, 980]) {
  test(`a ${width} by 1000 PNG is uploaded within the inclusive two percent aspect tolerance`, async () => {
    const app = harness({ bytes: pngHeader(width, 1000) });
    await flush();
    app.element('send').dispatch('click');
    await flush();
    assert.equal(app.drafts().length, 1);
    assert.equal(app.element('error').hidden, true);
    assert.equal(app.drafts()[0].body.imageBase64, Buffer.from(pngHeader(width, 1000)).toString('base64'));
  });
}

for (const width of [1021, 979]) {
  test(`a ${width} by 1000 PNG is rejected above two percent aspect difference`, async () => {
    const app = harness({ bytes: pngHeader(width, 1000) });
    await flush();
    app.element('send').dispatch('click');
    await flush();
    assert.equal(app.drafts().length, 0);
    assert.equal(app.element('error').hidden, false);
    assert.match(app.element('error').textContent, /2\.1%/);
  });
}

test('malformed PNG bytes show an actionable error before any draft upload', async () => {
  const app = harness({ bytes: new Uint8Array([137, 80, 78, 71]) });
  await flush();
  app.element('send').dispatch('click');
  await flush();
  assert.equal(app.drafts().length, 0);
  assert.equal(app.element('error').hidden, false);
  assert.match(app.element('error').textContent, /PNG/i);
});

test('a connection saved on the legacy host loads on the current host with the same token and keeps its sync target', async () => {
  const app = harness({ saved: legacyConnection });
  await flush();
  const loaded = app.mainMessages.find(message => message.type === 'connection');
  assert.deepEqual(loaded.connection, connection, 'only the origin changes');
  assert.deepEqual(app.storage.get('assetlib.connection.v1'), connection, 'the moved origin is saved for the next run');
  assert.equal(app.element('origin').value, connection.origin);
  assert.deepEqual(app.requests.map(request => [request.method, request.url, request.authorization]),
    [['GET', `${connection.origin}/api/apps/org-one/app-a/placements`, 'Bearer draft_a']]);
  assert.equal(app.element('sync').disabled, false, 'the sync target remembered under the legacy host is still found');

  app.element('sync').dispatch('click');
  await flush();
  assert.equal(app.drafts().length, 1);
  assert.equal(app.drafts()[0].url, `${connection.origin}/api/apps/org-one/app-a/drafts`);
  assert.equal(app.drafts()[0].authorization, 'Bearer draft_a');
  assert.equal(app.drafts()[0].body.rebind, true);
  assert.deepEqual(app.drafts()[0].body.bind, { slotKey: placement.key, state: 'old', appearance: 'light', arm: 'b' });
  assert.deepEqual(app.storage.get(storageKey(connection)), rememberedA, 'the sync target is now saved under the current host');
  const link = app.element('result').children.find(child => child.textContent === 'Open Assetlib console');
  assert.equal(link.href, connection.origin, 'people are sent to the current console host');

  app.saveConnection({ ...connection, token: '' });
  await flush();
  assert.equal(app.element('error').hidden, true);
  assert.equal(app.requests.at(-1).url, `${connection.origin}/api/apps/org-one/app-a/placements`);
  assert.equal(app.requests.at(-1).authorization, 'Bearer draft_a', 're-saving the same app keeps the saved token');
});

test('a first connection uses the current host and cannot choose the legacy host', async () => {
  const app = harness({ saved: null });
  await flush();
  assert.equal(app.element('status').textContent, 'Connect to your app to get started.');
  assert.equal(app.requests.length, 0);

  app.saveConnection(legacyConnection);
  await flush();
  assert.equal(app.uiMessages.filter(message => message.type === 'save-connection').length, 0);
  assert.equal(app.element('error').hidden, false);
  assert.match(app.element('error').textContent, /https:\/\/console\.assetlib\.dev/);
  assert.equal(app.requests.length, 0);

  app.saveConnection(connection);
  await flush();
  assert.deepEqual(app.storage.get('assetlib.connection.v1'), connection);
  assert.deepEqual(app.requests.map(request => [request.method, request.url, request.authorization]),
    [['GET', `${connection.origin}/api/apps/org-one/app-a/placements`, 'Bearer draft_a']]);
  assert.equal(app.element('send').disabled, false);
});
