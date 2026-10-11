import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bundlePlugin, clone, createHarness, deferred, descendants, fakeConsole, flush, pngHeader, textOf } from './fakes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = await bundlePlugin(root);

// Tokens as the console mints them (alk_ and 43 base64url characters); a token typed into the form must look like one.
const tok = name => `alk_${name.padEnd(43, '0')}`;
const connection = { origin: 'https://console.assetlib.dev', orgId: 'org-one', appId: 'app-a', token: tok('draft_a') };
// Connections saved before the console moved to console.assetlib.dev name its earlier host.
const legacyConnection = { ...connection, origin: 'https://assetlib-console.vercel.app' };
const placement = { key: 'hero.artwork', screen: 'Home', width: 1000, height: 1000,
  states: ['old', 'new'], defaultState: 'old', variants: { appearance: ['light', 'dark'], arm: ['b', 'c'] }, origin: 'declared' };
const node = { id: '12:34', name: 'Hero artwork', type: 'FRAME', width: 1000, height: 1000 };
const rememberedA = { fileKey: 'abc123', nodeId: node.id, placementKey: placement.key, state: 'old', appearance: 'light', arm: 'b' };
const rememberedB = { ...rememberedA, state: 'new', appearance: 'dark', arm: 'c' };
// An action that can't run now is aria-disabled, so it keeps focus; other controls use disabled.
const off = (app, id) => app.element(id).getAttribute('aria-disabled') === 'true';
const storageKey = (config, nodeId = node.id) => `assetlib.target.v1:${JSON.stringify([config.origin, config.orgId, config.appId, 'abc123', nodeId])}`;

// Library fixtures: ids are uuids and hashes are 64 hex characters, as the console sends them.
const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const sha = n => n.toString(16).padStart(64, '0');
const filler = (length, seed = 1) => Uint8Array.from({ length }, (_, index) => (index * seed) % 251);
function rendition(assetId, n, mime, width, height, body) {
  return { meta: { sha256: sha(n), mime, bytes: body.byteLength, width, height, url: `/api/apps/org-one/app-a/assets/${assetId}/renditions/${sha(n)}` },
    served: { assetId, sha256: sha(n), mime, body } };
}
function asset(id, name, width, height, items, extra = {}) {
  return { id, name, width, height, createdAt: '2026-10-09T00:00:00.000Z', processingIntent: 'artwork', source: null,
    renditions: items.map(item => item.meta), ...extra };
}
const baseArt = uuid(1);
const armArt = uuid(2);
const baseItems = [rendition(baseArt, 1, 'image/png', 1000, 1000, pngHeader(1000, 1000)), rendition(baseArt, 2, 'image/webp', 256, 256, filler(40))];
const armItems = [
  // Over the 4 MiB download cap; never fetched for insert.
  { meta: { sha256: sha(10), mime: 'image/png', bytes: 5 * 1024 * 1024, width: 2000, height: 2000 }, served: null },
  rendition(armArt, 11, 'image/png', 1000, 1000, pngHeader(1000, 1000)),
  // Same area as the PNG; PNG wins the tie.
  rendition(armArt, 12, 'image/webp', 1000, 1000, filler(24, 3)),
  rendition(armArt, 13, 'image/webp', 256, 256, filler(20, 5)),
  rendition(armArt, 14, 'image/svg+xml', 2048, 2048, filler(30, 7)),
];
const assets = { [baseArt]: asset(baseArt, 'Hero base', 1000, 1000, baseItems), [armArt]: asset(armArt, 'Hero arm b light', 1000, 1000, armItems) };
const cellArt = (assetId, arm, appearance) => ({ assetId, via: { arm, appearance } });
function heroCells() {
  const cells = [];
  for (const arm of [null, 'b', 'c']) for (const appearance of [null, 'light', 'dark']) for (const state of ['old', 'new']) {
    // Only (b, light) has its own art; every other cell inherits the base.
    const own = arm === 'b' && appearance === 'light';
    const draft = own ? cellArt(armArt, 'b', 'light') : cellArt(baseArt, null, null);
    cells.push({ state, appearance, arm, draft, staging: cellArt(baseArt, null, null), production: null });
  }
  return cells;
}
const artwork = () => ({ environments: { staging: { sequence: 3, createdAt: '2026-10-08T10:00:00.000Z' }, production: null },
  placements: [{ ...placement, cells: heroCells() }], assets: clone(assets) });
const renditionsServed = () => [...baseItems, ...armItems].flatMap(item => item.served ? [item.served] : []);

// The plugin opens on Insert by default ('default tab is insert'); most tests start from a saved Send tab, as a person
// who last used Send would. `prefs: null` leaves no saved preferences.
function harness({ remembered = rememberedA, bytes = pngHeader(1000, 1000), saved = connection, storage = [], console: state = {}, prefs = { tab: 'send' }, ...options } = {}) {
  const consoleState = { placements: [clone(placement)], artwork: artwork(), library: [], renditions: renditionsServed(), ...state };
  const app = createHarness({
    ...sources, fetch: fakeConsole(consoleState), exportBytes: () => bytes, selection: [node],
    storage: [...(prefs ? [['assetlib.preferences.v1', prefs]] : []), ...(saved ? [['assetlib.connection.v1', saved], [storageKey(saved), remembered]] : []), ...storage],
    ...options,
  });
  return { ...app, console: consoleState };
}

for (const [description, next] of [
  ['switching apps', { ...connection, appId: 'app-b', token: tok('draft_b') }],
  ['rotating the token in the same app', { ...connection, token: tok('draft_rotated') }],
]) {
  test(`delayed client storage cannot queue a rebind with old coordinates when ${description}`, async () => {
    const app = harness();
    await flush();
    assert.equal(off(app, 'sync'), false);
    const initialSelection = app.mainMessages.find(message => message.type === 'selection');

    app.delayTargetReads();
    app.selectionChanged();
    await flush();
    assert.equal(app.pendingReads.length, 1, 'an old-generation storage lookup is still in flight');
    const write = app.delayConnectionWrite();
    app.saveConnection(next);
    // GET /api/token names the pasted token's app; the save starts when it answers.
    for (let i = 0; i < 4; i++) await flush();
    assert.equal(app.uiMessages.filter(message => message.type === 'save-connection').length, 1);
    app.deliver(initialSelection);
    assert.equal(app.element('sync').hidden, true, 'saving immediately clears the remembered target');
    app.element('sync').dispatch('click');
    assert.equal(app.exportMessages().length, 0, 'a late reply cannot restore Sync before the save acknowledgement');

    write.resolve();
    await flush();
    assert.equal(app.pendingReads.length, 2, 'the new-generation storage lookup remains delayed');
    assert.ok(app.requests.some(request => request.method === 'GET' && request.authorization === `Bearer ${next.token}`),
      'the new placements response has already completed');
    assert.equal(off(app, 'sync'), true);
    assert.equal(off(app, 'send'), true, 'send also waits for a matching selection state');
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
    assert.equal(off(app, 'sync'), false);
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
  // Nothing is chosen for the person: Send waits for a placement.
  assert.equal(app.element('placement').value, '');
  assert.equal(app.element('placement').children[0].textContent, 'Choose placement…');
  assert.equal(off(app, 'send'), true);
  pick(app, 'placement', placement.key);
  assert.equal(app.element('export-note').textContent, 'Exports 1000 × 1000 PNG');
  assert.equal(off(app, 'send'), false);
  // Another connection starts with nothing chosen, even when its app has a placement with the same key.
  const switched = harness({ remembered: null });
  await flush();
  pick(switched, 'placement', placement.key);
  switched.saveConnection({ ...connection, appId: 'app-b', token: tok('draft_b') });
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(switched.mainMessages.filter(message => message.type === 'connection').at(-1).connection.appId, 'app-b');
  assert.equal(switched.element('placement').value, '', 'a placement chosen for app-a is not chosen for app-b');
  assert.equal(off(switched, 'send'), true);
  assert.equal(app.element('sync').hidden, true);
  assert.equal(off(app, 'sync'), true);
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
  assert.equal(off(app, 'sync'), false, 'a rejected export can be corrected and retried');
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
  assert.equal(app.element('error').textContent, 'Figma couldn’t export this layer. Try again, or flatten it first.');
});

test('a connection saved on the legacy host loads on the current host with the same token and keeps its sync target', async () => {
  const app = harness({ saved: legacyConnection });
  await flush();
  const loaded = app.mainMessages.find(message => message.type === 'connection');
  assert.deepEqual(loaded.connection, connection, 'only the origin changes');
  assert.deepEqual(app.storage.get('assetlib.connection.v1'), connection, 'the moved origin is saved for the next run');
  assert.equal(app.element('origin').value, connection.origin);
  assert.deepEqual(app.requests.map(request => [request.method, request.url, request.authorization]),
    [['GET', `${connection.origin}/api/apps/org-one/app-a/placements`, `Bearer ${connection.token}`]]);
  assert.equal(off(app, 'sync'), false, 'the sync target remembered under the legacy host is still found');

  app.element('sync').dispatch('click');
  await flush();
  assert.equal(app.drafts().length, 1);
  assert.equal(app.drafts()[0].url, `${connection.origin}/api/apps/org-one/app-a/drafts`);
  assert.equal(app.drafts()[0].authorization, `Bearer ${connection.token}`);
  assert.equal(app.drafts()[0].body.rebind, true);
  assert.deepEqual(app.drafts()[0].body.bind, { slotKey: placement.key, state: 'old', appearance: 'light', arm: 'b' });
  assert.deepEqual(app.storage.get(storageKey(connection)), rememberedA, 'the sync target is now saved under the current host');
  const link = app.element('result').children.find(child => child.textContent === 'View in console');
  assert.equal(link.href, `${connection.origin}/w/org-one/app-a/releases`, 'people are sent to the current console host');
  assert.deepEqual(app.notifications.map(item => [item.message, item.options?.button?.text]), [['Synced hero.artwork to draft', 'Review']]);

  app.saveConnection({ ...connection, token: '' });
  await flush();
  assert.equal(app.element('error').hidden, true);
  assert.equal(app.requests.at(-1).url, `${connection.origin}/api/apps/org-one/app-a/placements`);
  assert.equal(app.requests.at(-1).authorization, `Bearer ${connection.token}`, 're-saving the same app keeps the saved token');
});

test('a first connection uses the current host and cannot choose the legacy host', async () => {
  const app = harness({ saved: null });
  await flush();
  assert.equal(app.element('app').getAttribute('data-view'), 'first-run', 'no connection: the first-run screen');
  assert.equal(app.element('settings').open, true, 'its form is the connection settings');
  assert.equal(app.element('panel-insert').hidden, true);
  assert.equal(app.element('panel-send').hidden, true);
  assert.equal(app.requests.length, 0);

  app.saveConnection(legacyConnection);
  await flush();
  assert.equal(app.uiMessages.filter(message => message.type === 'save-connection').length, 0);
  assert.equal(app.element('connection-error').hidden, false, 'the error sits under the token field');
  assert.match(app.element('connection-error').textContent, /https:\/\/console\.assetlib\.dev/);
  assert.equal(app.element('origin').getAttribute('aria-invalid'), 'true');
  assert.equal(app.activeElement(), app.element('origin'), 'focus moves to the field at fault');
  assert.equal(app.element('error').hidden, true);
  assert.equal(app.requests.length, 0);

  app.saveConnection(connection);
  for (let i = 0; i < 6; i++) await flush();
  assert.equal(app.element('connection-error').hidden, true);
  assert.equal(app.element('origin').getAttribute('aria-invalid'), null);
  assert.deepEqual(app.storage.get('assetlib.connection.v1'), connection);
  // The pasted token names its own organization and app; then the connection test reads placements.
  assert.deepEqual(app.requests.map(request => [request.method, request.url, request.authorization]),
    [['GET', `${connection.origin}/api/token`, `Bearer ${connection.token}`], ['GET', `${connection.origin}/api/apps/org-one/app-a/placements`, `Bearer ${connection.token}`]]);
  assert.equal(app.element('app').getAttribute('data-view'), 'shell');
  pick(app, 'placement', placement.key);
  assert.equal(off(app, 'send'), false);
});

// ---- Insert ----
const LINK_KEY = 'assetlib.link.v1';
const settle = async () => { for (let i = 0; i < 12; i++) await flush(); };
// A GET that fails with a network error or 5xx is tried again after 1 s and 4 s; this runs both waits.
async function exhaustRetries(app) { for (const delay of [1000, 4000]) { await settle(); app.fireTimers(delay); } await settle(); }
const rowFor = (app, key) => descendants(app.element('insert-list')).find(item => item.getAttribute?.('data-key') === key);
const tilesOf = app => descendants(app.element('image-grid')).filter(item => item.getAttribute?.('data-asset-id'));
const errorsFor = (app, requestId) => app.mainMessages.filter(message => message.type === 'error' && message.requestId === requestId).map(message => message.message);
function pick(app, id, value) { app.element(id).value = value; app.element(id).dispatch('change'); }
async function openInsert(app) {
  await settle();
  app.element('tab-insert').dispatch('click');
  await settle();
}
async function insertHeroCell(app, cell = { state: 'old', appearance: 'light', arm: 'b' }) {
  await openInsert(app);
  rowFor(app, placement.key).dispatch('click');
  pick(app, 'insert-state', cell.state ?? '');
  pick(app, 'insert-appearance', cell.appearance ?? '');
  pick(app, 'insert-arm', cell.arm ?? '');
  app.element('insert').dispatch('click');
  await settle();
  return app.frames.at(-1);
}
function libraryAsset(n, name, width, height, extra = {}) {
  const id = uuid(100 + n);
  const items = [rendition(id, 1000 + n * 2, 'image/png', width, height, pngHeader(width, height)), rendition(id, 1001 + n * 2, 'image/webp', 64, 32, filler(12, n))];
  return { asset: asset(id, name, width, height, items, extra), served: items.map(item => item.served) };
}
function library(entries) { return { library: entries.map(entry => entry.asset), renditions: [...renditionsServed(), ...entries.flatMap(entry => entry.served)] }; }

test('a placement cell inserts as a linked image component, centered and selected, with Sync ready', async () => {
  const app = harness();
  const frame = await insertHeroCell(app);
  assert.deepEqual(app.requests.filter(request => request.route !== 'rendition').map(request => request.route), ['placements', 'artwork']);
  const downloads = app.requests.filter(request => request.url.endsWith(sha(11)));
  assert.equal(downloads.length, 1, 'the largest PNG within 4 MiB is fetched once');
  assert.deepEqual(downloads[0], { url: `${connection.origin}/api/apps/org-one/app-a/assets/${armArt}/renditions/${sha(11)}`, method: 'GET',
    authorization: `Bearer ${connection.token}`, credentials: 'omit', redirect: 'error', body: null, route: 'rendition' });
  for (const skipped of [10, 12, 14]) assert.ok(!app.requests.some(request => request.url.endsWith(sha(skipped))), 'over the cap, a tied WebP, and SVG are not fetched');
  assert.ok(app.requests.every(request => !request.url.includes(connection.token)), 'the token is never in a URL');

  const [insert] = app.insertMessages();
  assert.ok(insert.bytes instanceof Uint8Array);
  assert.deepEqual(insert.frame, { width: 1000, height: 1000 });
  assert.equal(insert.scale, 1);
  assert.deepEqual(insert.link, { placementKey: placement.key, state: 'old', appearance: 'light', arm: 'b', environment: 'draft', assetId: armArt });
  assert.equal(app.frames.length, 1);
  assert.equal(frame.name, 'hero.artwork · b · light');
  assert.deepEqual([frame.width, frame.height, frame.x, frame.y], [1000, 1000, 0, -200], 'centered on the viewport center');
  assert.deepEqual(clone(frame.fills), [{ type: 'IMAGE', imageHash: 'hash-1', scaleMode: 'FILL' }]);
  assert.equal(frame.clipsContent, true);
  assert.deepEqual([...app.figma.currentPage.selection].map(item => item.id), [frame.id]);
  assert.deepEqual(app.scrolls, [[frame.id]], 'the frame extends past the viewport bounds');
  assert.deepEqual(app.notices, ['Inserted hero.artwork · b · light from Draft']);

  const raw = frame.getPluginData(LINK_KEY);
  const link = JSON.parse(raw);
  assert.deepEqual({ ...link, insertedAt: typeof link.insertedAt }, { v: 1, origin: connection.origin, orgId: 'org-one', appId: 'app-a',
    placementKey: placement.key, state: 'old', appearance: 'light', arm: 'b', environment: 'draft', assetId: armArt, nodeId: frame.id, insertedAt: 'string' });
  assert.ok(!raw.includes(connection.token), 'the link never holds the token');

  // The marker coding agents read through Figma's MCP server.
  assert.equal(frame.type, 'COMPONENT');
  assert.equal(frame.description, 'Assetlib placement hero.artwork (1000 × 1000). This image can change after the app is released, '
    + 'so don’t export it as a static file. In code, use the accessor generated for hero.artwork from assetlib.catalog.json, '
    + 'which carries the bundled fallback. If hero.artwork isn’t in the catalog, add it there with a fallback image in the same change.');
  assert.deepEqual(clone(frame.documentationLinks), [{ uri: 'https://console.assetlib.dev/w/org-one/app-a/placements' }]);
  assert.ok(!frame.description.includes(connection.token) && !JSON.stringify(frame.documentationLinks).includes(connection.token), 'the marker never holds the token');

  const insertedAt = app.mainMessages.findIndex(message => message.type === 'inserted');
  const selectionAt = app.mainMessages.findIndex((message, index) => index > insertedAt && message.type === 'selection');
  assert.ok(insertedAt >= 0 && selectionAt > insertedAt, 'inserted is posted, then the new selection');
  assert.equal(app.mainMessages[insertedAt].connectionGeneration, 0);
  assert.deepEqual(app.mainMessages[selectionAt].selection.remembered.insertedFrom, { environment: 'draft', assetId: armArt });
  assert.equal(app.element('sync').hidden, false);
  assert.equal(off(app, 'sync'), false);
  assert.equal(app.element('sync').textContent, 'Sync to hero.artwork');
  assert.match(app.element('sync-note').textContent, /^hero\.artwork · b · Light · old\. Inserted from Draft\. Sync sends this layer to that cell/);
  assert.equal(app.element('status').textContent, 'Inserted hero.artwork · b · light from Draft.', 'the status region repeats the toast');
  assert.equal(app.element('error').hidden, true);
});

test('Sync from an inserted frame binds exactly its cell without changing the draft wire shape, then the saved target wins', async () => {
  const app = harness();
  const frame = await insertHeroCell(app);
  app.element('sync').dispatch('click');
  await settle();
  assert.equal(app.drafts().length, 1);
  const { body } = app.drafts()[0];
  assert.deepEqual(Object.keys(body).sort(), ['bind', 'imageBase64', 'mime', 'name', 'rebind', 'schemaVersion', 'source']);
  assert.deepEqual(Object.keys(body.source).sort(), ['export', 'fileKey', 'nodeId', 'nodeName', 'provider', 'versionId']);
  assert.deepEqual(body.bind, { slotKey: placement.key, state: 'old', appearance: 'light', arm: 'b' }, 'the picked cell, not the family it inherits');
  assert.equal(body.rebind, true);
  assert.equal(body.source.nodeId, frame.id);
  assert.deepEqual(app.storage.get(storageKey(connection, frame.id)),
    { fileKey: 'abc123', nodeId: frame.id, placementKey: placement.key, state: 'old', appearance: 'light', arm: 'b' }, 'stored targets keep their shape');
  const last = app.mainMessages.filter(message => message.type === 'selection').at(-1);
  assert.equal(last.selection.remembered.insertedFrom, null, 'the client storage target is found before the link');
  assert.doesNotMatch(app.element('sync-note').textContent, /Inserted from/);
  assert.equal(app.element('status').textContent, 'Synced hero.artwork to draft');
  assert.deepEqual([app.notifications.at(-1).message, app.notifications.at(-1).options.button.text], ['Synced hero.artwork to draft', 'Review'], 'a toast with Review');
  app.notifications.at(-1).options.button.action();
  assert.deepEqual(app.externalUrls, [`${connection.origin}/w/org-one/app-a/releases`], 'Review opens the console’s releases');
});

test('Insert at @3x makes a third-size frame, and the viewport moves only when the frame is outside its bounds', async () => {
  const app = harness();
  await openInsert(app);
  app.element('scale-3').dispatch('click');
  assert.deepEqual(app.uiMessages.filter(message => message.type === 'save-preferences').at(-1).preferences,
    { tab: 'insert', browse: 'placements', environment: 'draft', scale: 3 });
  rowFor(app, placement.key).dispatch('click');
  assert.equal(app.element('scale-3').getAttribute('aria-checked'), 'true');
  // The pickers above name the cell, so the line names the environment and the size in Figma.
  assert.equal(app.element('insert-meta').textContent, 'Draft · → 333.33 × 333.33', 'the footer names the size in Figma');
  assert.equal(app.element('insert-meta').title, 'Draft · → 333.33 × 333.33', 'the whole line on hover');
  app.element('insert').dispatch('click');
  await settle();
  const small = app.frames[0];
  assert.deepEqual([small.width, small.height, small.x, small.y], [333.33, 333.33, 333, 133]);
  assert.equal(app.insertMessages()[0].scale, 3);
  assert.deepEqual(app.insertMessages()[0].frame, { width: 1000, height: 1000 }, 'the frame is always the placement size in pixels');
  assert.deepEqual(app.scrolls, [], 'a frame inside the viewport does not move it');
  app.element('scale-1').dispatch('click');
  app.element('insert').dispatch('click');
  await settle();
  assert.deepEqual([app.frames[1].width, app.frames[1].height], [1000, 1000]);
  assert.deepEqual(app.scrolls, [[app.frames[1].id]]);
});

test('rows show the base art and tags for unset, unavailable, legacy, and unpublished or differing art, and the footer names inherited art', async () => {
  const cells = heroCells().map(cell => ({ ...cell, production: cellArt(baseArt, null, null) }));
  const legacyArt = uuid(9);
  const single = (key, draft, production) => ({ ...placement, key, screen: 'Tasks', states: null, defaultState: null, variants: null,
    cells: [{ state: null, appearance: null, arm: null, draft, staging: null, production }] });
  const stateful = { ...placement, key: 'tasks.empty', screen: 'Tasks', cells: cells.map(cell => ({ ...cell, draft: cell.state === 'new' ? null : cell.draft })) };
  const unset = { ...placement, key: 'travel.coast', screen: 'Travel', width: 1200, height: 900, states: null, defaultState: null, variants: null,
    cells: [{ state: null, appearance: null, arm: null, draft: null, staging: null, production: cellArt(armArt, null, null) }] };
  const differs = { ...unset, key: 'travel.ridge', cells: [{ ...unset.cells[0], draft: cellArt(baseArt, null, null) }] };
  // An A/B arm declared, but only Control has a cell, so there is no picker: the footer names it.
  const solo = { ...single('tasks.solo', cellArt(baseArt, null, null), null), variants: { arm: ['b'] } };
  const app = harness({ console: { artwork: { ...artwork(), environments: { staging: null, production: { sequence: 12, createdAt: '2026-10-09T08:00:00.000Z' } },
    placements: [{ ...placement, cells }, stateful, unset, differs, single('tasks.gone', cellArt(uuid(8), null, null), null),
      single('tasks.legacy', cellArt(legacyArt, null, null), null), single('tasks.added', cellArt(baseArt, null, null), null), solo],
    assets: { ...clone(assets), [legacyArt]: asset(legacyArt, 'Legacy', 1000, 1000, []) } } } });
  await openInsert(app);
  // Each tag is a word (never colour alone) with a sentence in its tooltip; what blocks Insert is marked blocking.
  const tagsOf = key => descendants(rowFor(app, key)).filter(item => /^tag( |$)/.test(item.className ?? ''));
  const tags = key => tagsOf(key).map(item => item.textContent);
  assert.deepEqual(tags(placement.key), []);
  assert.deepEqual(tags('travel.coast'), ['Not set']);
  assert.equal(tagsOf('travel.coast')[0].title, 'No image in Draft for this cell.');
  assert.equal(descendants(rowFor(app, 'travel.coast')).find(item => /thumb/.test(item.className ?? '')).className, 'thumb slot', 'an empty slot, not a preview');
  assert.deepEqual(tags('travel.ridge'), ['Changed']);
  assert.equal(tagsOf('travel.ridge')[0].title, 'Draft differs from Production.');
  assert.deepEqual(tags('tasks.gone'), ['Unavailable'], 'the console did not return the image');
  assert.equal(tagsOf('tasks.gone')[0].className, 'tag blocking');
  assert.deepEqual(tags('tasks.legacy'), ['Needs re-upload'], 'an image without prepared versions');
  assert.equal(tagsOf('tasks.legacy')[0].title, 'Upload it again in the Assetlib console to use it in Figma.');
  assert.deepEqual(tags('tasks.added'), ['Draft only'], 'production is published but has no art for it');
  assert.equal(tagsOf('tasks.added')[0].title, 'Production has no image here yet.');
  const legacyThumb = descendants(rowFor(app, 'tasks.legacy')).find(item => item.tag === 'img');
  assert.equal(legacyThumb.getAttribute('data-sha'), '', 'marked as having no preview');
  assert.equal(descendants(rowFor(app, placement.key)).find(item => item.className === 'size').textContent, '1000 × 1000 · 2 states · light, dark · arms b, c');
  assert.deepEqual(descendants(app.element('insert-list')).filter(item => item.className === 'group').map(item => item.textContent), ['Home', 'Tasks', 'Travel']);
  assert.equal(app.element('env-staging').disabled, true, 'nothing is published to staging');
  assert.equal(app.element('env-staging').title, 'Nothing published to Staging yet.');
  assert.equal(app.element('env-draft').title, 'Unpublished changes. Send and Sync update Draft.');
  assert.equal(app.element('env-note').hidden, true);

  rowFor(app, placement.key).dispatch('click');
  assert.equal(app.element('insert-state-label').hidden, false);
  assert.deepEqual(app.element('insert-state').children.map(option => option.textContent), ['old', 'new'], 'the default state first');
  assert.deepEqual(app.element('insert-appearance').children.map(option => option.textContent), ['Any', 'Light', 'Dark']);
  assert.deepEqual(app.element('insert-arm').children.map(option => option.textContent), ['Control', 'b', 'c']);
  pick(app, 'insert-appearance', 'dark');
  pick(app, 'insert-arm', 'b');
  // The pickers say the cell; the line says what it inherits, so a 420 px footer keeps it whole.
  assert.equal(app.element('insert-meta').textContent, 'Draft · Uses Control · Any art');
  assert.equal(app.element('insert-note').hidden, true, 'nothing blocks it');
  assert.equal(app.element('insert-preview').className, 'thumb');
  assert.equal(app.element('insert').textContent, 'Insert');

  rowFor(app, 'tasks.empty').dispatch('click');
  pick(app, 'insert-state', 'new');
  assert.equal(app.element('insert-note').textContent, 'No image in Draft for this cell. Choose another cell or environment.');
  assert.equal(app.element('insert-preview').className, 'thumb slot', 'the footer shows the same empty slot as a Not set row');
  assert.equal(off(app, 'insert'), true);
  rowFor(app, 'tasks.solo').dispatch('click');
  assert.equal(app.element('insert-arm-label').hidden, true);
  assert.equal(app.element('insert-meta').textContent, 'Draft · Control', 'an axis without a picker is named in the line');
  rowFor(app, 'travel.coast').dispatch('click');
  assert.equal(app.element('insert-state-label').hidden, true, 'a single option hides its picker');
  app.element('env-production').dispatch('click');
  assert.equal(app.element('env-production').title, 'The latest release published to production. Release 12, Oct 9.');
  assert.deepEqual(tags('travel.coast'), [], 'production has art for it');
  assert.equal(app.element('insert-meta').textContent, 'Production', 'a placement without states or variants names only the environment');
  assert.equal(app.element('insert-note').hidden, true);
  app.element('insert').dispatch('click');
  await settle();
  assert.deepEqual(app.insertMessages()[0].link, { placementKey: 'travel.coast', state: null, appearance: null, arm: null, environment: 'production', assetId: armArt });
  assert.equal(app.insertMessages()[0].name, 'travel.coast');
  assert.deepEqual(app.notices, ['Inserted travel.coast from Production']);

  app.element('insert-search').value = 'TRAVEL';
  app.element('insert-search').dispatch('input');
  assert.deepEqual(descendants(app.element('insert-list')).filter(item => item.getAttribute?.('data-key')).map(item => item.getAttribute('data-key')), ['travel.coast', 'travel.ridge']);
  app.element('insert-search').value = 'nothing';
  app.element('insert-search').dispatch('input');
  assert.equal(app.element('insert-empty-text').textContent, 'No placements match “nothing”.');
  assert.equal(app.element('insert-clear').hidden, false);
  app.element('insert-clear').dispatch('click');
  assert.equal(app.element('insert-empty').hidden, true);
});

test('a WebP-only image is converted to PNG before insert, and a failed conversion inserts nothing', async () => {
  const id = uuid(300);
  const items = [rendition(id, 301, 'image/webp', 1000, 1000, filler(30, 9)), rendition(id, 302, 'image/webp', 128, 128, filler(10, 11))];
  const photo = { asset: asset(id, 'Coast photo', 1000, 1000, items, { processingIntent: 'photo' }), served: items.map(item => item.served) };
  const calls = [];
  const app = harness({ console: library([photo]), createImageBitmap: async (blob, options) => {
    calls.push({ type: blob.type, size: blob.size, options: { ...options } });
    return { width: 1000, height: 1000, close() { calls.push('closed'); } };
  } });
  await openInsert(app);
  app.element('browse-images').dispatch('click');
  await settle();
  tilesOf(app)[0].dispatch('click');
  app.element('insert').dispatch('click');
  await settle();
  assert.ok(app.requests.some(request => request.url.endsWith(sha(301))), 'the largest WebP is fetched');
  // 'default' converts a Display P3 WebP to the canvas's sRGB instead of reading its values as sRGB.
  assert.deepEqual(calls, [{ type: 'image/webp', size: 30, options: { premultiplyAlpha: 'none', colorSpaceConversion: 'default' } }, 'closed']);
  assert.deepEqual(app.bitmaps, [{ width: 1000, height: 1000 }]);
  assert.deepEqual(app.canvases.map(item => [item.width, item.height]), [[0, 0]], 'the canvas backing store is released');
  const [insert] = app.insertMessages();
  assert.deepEqual([...insert.bytes.slice(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10], 'main receives PNG bytes');
  assert.equal(insert.link, null);
  assert.equal(app.frames.length, 1);

  const failing = harness({ console: library([photo]), createImageBitmap: async () => { throw new Error('decode failed'); } });
  await openInsert(failing);
  failing.element('browse-images').dispatch('click');
  await settle();
  tilesOf(failing)[0].dispatch('click');
  failing.element('insert').dispatch('click');
  await settle();
  assert.equal(failing.element('error').textContent, 'Figma couldn’t use this WebP image. Try again, or download it from the console.');
  assert.deepEqual(failing.canvases, [], 'a failed decode creates no canvas');
  assert.equal(failing.insertMessages().length, 0);
  assert.equal(off(failing, 'insert'), false, 'the insert can be retried');

  const oversized = harness({ console: library([photo]), createImageBitmap: async () => ({ width: 5000, height: 10, close() {} }) });
  await openInsert(oversized);
  oversized.element('browse-images').dispatch('click');
  await settle();
  tilesOf(oversized)[0].dispatch('click');
  oversized.element('insert').dispatch('click');
  await settle();
  assert.equal(oversized.element('error').textContent, 'Figma couldn’t use this WebP image. Try again, or download it from the console.');
  assert.deepEqual(oversized.canvases.map(item => [item.width, item.height]), [[0, 0]], 'a failed conversion releases the canvas too');
  assert.equal(oversized.insertMessages().length, 0);
});

test('rendition choice: nothing within 4 MiB fetches nothing, a mismatch or oversized body inserts nothing, and a vanished image says so', async () => {
  const big = uuid(400);
  const oversized = { asset: asset(big, 'Huge', 2048, 2048, [
    { meta: { sha256: sha(401), mime: 'image/png', bytes: 6 * 1024 * 1024, width: 2048, height: 2048 } },
    { meta: { sha256: sha(402), mime: 'image/webp', bytes: 4 * 1024 * 1024 + 1, width: 1024, height: 1024 } },
  ]), served: [] };
  const legacy = { asset: asset(uuid(410), 'Legacy', 300, 300, []), served: [] };
  const wrongMime = libraryAsset(20, 'Wrong mime', 400, 200);
  wrongMime.served[0] = { ...wrongMime.served[0], contentType: 'image/webp' };
  const wrongLength = libraryAsset(21, 'Wrong length', 400, 200);
  wrongLength.asset.renditions[0] = { ...wrongLength.asset.renditions[0], bytes: 34 };
  const padded = libraryAsset(22, 'Padded body', 400, 200);
  padded.served[0] = { ...padded.served[0], contentLength: 10 * 1024 * 1024 };
  const gone = libraryAsset(23, 'Gone', 400, 200);
  gone.served = [gone.served[1]];
  const app = harness({ console: library([oversized, legacy, wrongMime, wrongLength, padded, gone]) });
  await openInsert(app);
  app.element('browse-images').dispatch('click');
  await settle();
  const tile = name => tilesOf(app).find(item => textOf(item).startsWith(name));

  tile('Huge').dispatch('click');
  const before = app.requests.length;
  assert.equal(off(app, 'insert'), true, 'known before Insert is chosen');
  app.element('insert').dispatch('click');
  await settle();
  assert.equal(app.requests.length, before, 'no download is attempted');
  assert.equal(app.element('insert-note').textContent, 'Too large for Figma. Every version is over 4 MiB.');
  assert.equal(app.element('insert-note-link').hidden, false);
  assert.equal(app.element('insert-note-link').href, `${connection.origin}/w/org-one/app-a/images/${big}`, 'Open in console names the image');

  tile('Legacy').dispatch('click');
  assert.equal(off(app, 'insert'), true);
  assert.equal(app.element('insert-note').textContent, 'This image has no version Figma can use. Upload it again in the Assetlib console.');

  for (const name of ['Wrong mime', 'Wrong length']) {
    tile(name).dispatch('click');
    app.element('insert').dispatch('click');
    await settle();
    assert.equal(app.element('error').textContent, 'The console sent an unexpected image. Refresh and try again.', name);
  }
  tile('Padded body').dispatch('click');
  app.element('insert').dispatch('click');
  await settle();
  assert.equal(app.element('error').textContent, 'The console sent an unexpected image. Refresh and try again.');
  assert.equal(padded.served[0].read, undefined, 'a body longer than the listed version is not read');
  tile('Gone').dispatch('click');
  app.element('insert').dispatch('click');
  await settle();
  assert.equal(app.element('error').textContent, 'This image was removed. Refresh to update the list.', 'not the older-console message');
  assert.equal(app.insertMessages().length, 0);
  assert.equal(app.frames.length, 0);
  // Its one action, Refresh, reads the list again and clears the line; the other errors offer none.
  assert.deepEqual([app.element('error-action').hidden, app.element('error-action').textContent], [false, 'Refresh']);
  const assetReads = () => app.requests.filter(request => request.route === 'assets').length;
  const readsBefore = assetReads();
  app.element('error-action').dispatch('click');
  await settle();
  assert.equal(assetReads(), readsBefore + 1, 'Refresh read the image list again');
  assert.deepEqual([app.element('error').hidden, app.element('error-box').hidden, app.element('error-action').hidden], [true, true, true]);
  tile('Wrong mime').dispatch('click');
  app.element('insert').dispatch('click');
  await settle();
  assert.equal(app.element('error').hidden, false);
  assert.equal(app.element('error-action').hidden, true, 'no action where none helps');
});

test('a connection change during a download drops the insert, and main rejects an insert from an older generation', async () => {
  const app = harness();
  await openInsert(app);
  rowFor(app, placement.key).dispatch('click');
  app.console.gates.rendition = deferred();
  app.element('insert').dispatch('click');
  await settle();
  assert.equal(app.element('status').textContent, 'Downloading hero.artwork…');
  // The connection form is disabled while busy, so the change arrives from main, as a save from another run would.
  app.postToMain({ type: 'save-connection', requestId: 98, connection: { ...connection, appId: 'app-b', token: tok('draft_b') } });
  await settle();
  assert.equal(app.mainMessages.filter(message => message.type === 'connection').at(-1).connectionGeneration, 1);
  app.console.gates.rendition.resolve();
  await settle();
  assert.equal(app.insertMessages().length, 0, 'the stale download is not posted');
  assert.equal(app.frames.length, 0);
  assert.equal(app.element('error').hidden, true);

  app.postToMain({ type: 'insert', requestId: 99, connectionGeneration: 0, bytes: pngHeader(10, 10), name: 'Forged', frame: { width: 10, height: 10 }, scale: 1, link: null });
  await settle();
  assert.deepEqual(errorsFor(app, 99), ['The connection changed. Choose the image again.']);
  assert.equal(app.frames.length, 0);
});

test('Images mode pages with limit, cursor, and q, and a library insert is not linked', async () => {
  const entries = Array.from({ length: 30 }, (_, index) => libraryAsset(index, index % 3 === 0 ? `Coast ${index}` : `Ridge ${index}`, 400, 200));
  const app = harness({ console: library(entries) });
  await openInsert(app);
  app.element('browse-images').dispatch('click');
  await settle();
  const pages = () => app.requests.filter(request => request.route === 'assets').map(request => request.url.slice(`${connection.origin}/api/apps/org-one/app-a/`.length));
  assert.deepEqual(pages(), ['assets?limit=24']);
  assert.equal(tilesOf(app).length, 24);
  assert.equal(app.element('images-more').hidden, false);
  app.element('images-more').dispatch('click');
  await settle();
  assert.equal(pages()[1], `assets?limit=24&cursor=${entries[23].asset.id}`);
  assert.equal(tilesOf(app).length, 30);
  assert.equal(app.element('images-more').hidden, true);

  app.element('insert-search').value = ' Coast ';
  app.element('insert-search').dispatch('input');
  assert.equal(pages().length, 2, 'the search waits for the debounce');
  app.fireTimers(300);
  await settle();
  assert.equal(pages()[2], 'assets?limit=24&q=Coast');
  assert.equal(tilesOf(app).length, 10);

  tilesOf(app)[0].dispatch('click');
  assert.equal(app.element('insert-title').textContent, 'Coast 0');
  assert.equal(app.element('insert-meta').textContent, '400 × 200');
  assert.equal(app.element('insert-note').hidden, true);
  assert.equal(tilesOf(app)[0].title, 'Coast 0 · 400 × 200 · Artwork', 'the tile names the image, its size, and its kind');
  app.element('insert').dispatch('click');
  await settle();
  const frame = app.frames[0];
  assert.deepEqual([frame.name, frame.width, frame.height], ['Coast 0', 400, 200]);
  assert.equal(frame.getPluginData(LINK_KEY), '', 'a library image carries no link');
  assert.equal(frame.type, 'FRAME', 'a library image is a frame, not a placement component');
  assert.equal(frame.description, undefined);
  assert.equal(app.insertMessages()[0].link, null);
  assert.equal(app.mainMessages.filter(message => message.type === 'selection').at(-1).selection.remembered, null);
  assert.equal(app.element('sync').hidden, true);
  assert.equal(app.element('status').textContent, 'Inserted Coast 0.');
  assert.deepEqual(app.notices, ['Inserted Coast 0']);
  assert.deepEqual(app.uiMessages.filter(message => message.type === 'save-preferences').at(-1).preferences,
    { tab: 'insert', browse: 'images', environment: 'draft', scale: 1 });
});

test('a link applies only to its own node in the same app; copies, other apps, and malformed links are ignored', async () => {
  const link = { v: 1, origin: connection.origin, orgId: 'org-one', appId: 'app-a', placementKey: placement.key, state: 'new', appearance: 'dark',
    arm: 'c', environment: 'staging', assetId: baseArt, nodeId: '30:1', insertedAt: '2026-10-09T00:00:00.000Z' };
  const frameNode = (id, pluginData) => ({ id, name: 'Inserted', type: 'FRAME', width: 1000, height: 1000, pluginData: { [LINK_KEY]: pluginData } });
  const app = harness({ selection: [
    frameNode('30:1', JSON.stringify(link)),
    frameNode('30:2', JSON.stringify(link)),
    frameNode('30:3', JSON.stringify({ ...link, nodeId: '30:3', appId: 'app-z' })),
    frameNode('30:4', '{"v":1,'),
    frameNode('30:5', JSON.stringify({ ...link, nodeId: '30:5', origin: legacyConnection.origin })),
    frameNode('30:6', JSON.stringify({ ...link, nodeId: '30:6', token: 'draft_a', assetId: 'not-a-uuid' })),
  ] });
  await settle();
  const nodes = [...app.figma.currentPage.selection];
  const rememberedFor = async index => {
    app.select([nodes[index]]);
    await settle();
    return app.mainMessages.filter(message => message.type === 'selection').at(-1).selection.remembered;
  };
  assert.deepEqual(await rememberedFor(0), { fileKey: 'abc123', nodeId: '30:1', placementKey: placement.key, state: 'new', appearance: 'dark', arm: 'c',
    insertedFrom: { environment: 'staging', assetId: baseArt } });
  assert.equal(off(app, 'sync'), false);
  assert.match(app.element('sync-note').textContent, /Inserted from Staging\./);
  assert.equal(await rememberedFor(1), null, 'a Cmd+D copy keeps the data but not the node id');
  assert.equal(app.element('sync').hidden, true);
  assert.equal(await rememberedFor(2), null, 'another app');
  assert.equal(await rememberedFor(3), null, 'malformed JSON');
  assert.equal((await rememberedFor(4))?.insertedFrom?.environment, 'staging', 'a link written on the legacy host still applies');
  assert.equal(await rememberedFor(5), null, 'an invalid asset id');
});

test('without a file key an inserted frame shows Sync disabled until the file URL is confirmed', async () => {
  const app = harness({ fileKey: null });
  await insertHeroCell(app);
  assert.equal(app.element('status').textContent,
    'Inserted hero.artwork · b · light from Draft. Paste this file’s link on the Send tab to enable Sync.');
  assert.equal(app.element('sync').hidden, false);
  assert.equal(off(app, 'sync'), true);
  assert.equal(app.element('file-fallback').hidden, false);
  app.element('file-url').value = 'https://www.figma.com/design/abc123/Hero';
  app.element('file-form').dispatch('submit');
  await settle();
  assert.equal(off(app, 'sync'), false);
  app.element('sync').dispatch('click');
  await settle();
  assert.deepEqual(app.drafts()[0].body.bind, { slotKey: placement.key, state: 'old', appearance: 'light', arm: 'b' });
  assert.equal(app.drafts()[0].body.source.fileKey, 'abc123');
});

test('Insert errors: each failed list says why in its place, with the one action that helps, and Send still works', async () => {
  for (const [status, expected, action] of [
    [403, 'This token can’t read this app’s images. Create a token with Draft permission.', 'insert-token'],
    [404, 'This console doesn’t support Insert yet. Send still works.', 'insert-go-send'],
    [401, 'Assetlib no longer accepts this token. Paste a new one.', 'insert-token'],
    [429, 'Assetlib is busy. Try again in a minute.', 'insert-retry'],
    [500, 'Assetlib had a problem (500). Try again in a minute.', 'insert-retry'],
  ]) {
    const app = harness({ console: { statuses: { artwork: status } } });
    await openInsert(app);
    assert.equal(app.element('insert-empty').hidden, false, `HTTP ${status}`);
    assert.equal(app.element('insert-empty-text').textContent, expected, `HTTP ${status}`);
    assert.equal(app.element('alert').textContent, expected, `HTTP ${status}: announced`);
    assert.deepEqual(['insert-retry', 'insert-token', 'insert-go-send'].filter(id => !app.element(id).hidden), [action], `HTTP ${status}`);
    assert.equal(app.element('error').hidden, true, 'the error line is for actions, not lists');
    assert.equal(app.activeElement(), app.element('insert-empty'), 'focus moves to it');
    assert.equal(app.element('connection-label').textContent, status === 401 ? 'Needs attention' : 'Connected');
    if (action === 'insert-go-send') {
      app.element('insert-go-send').dispatch('click');
      assert.equal(app.element('panel-send').hidden, false, 'Go to Send');
    }
    if (action === 'insert-token' && status === 401) {
      app.element('settings').open = false;
      app.element('insert-token').dispatch('click');
      assert.equal(app.element('settings').open, true, 'Update token opens the settings');
      assert.equal(app.activeElement(), app.element('token'));
    }
  }

  const app = harness({ console: { failures: new Set(['artwork']) } });
  await openInsert(app);
  assert.equal(app.element('insert-empty').hidden, true, 'a network error is tried again first');
  await exhaustRetries(app);
  assert.equal(app.element('insert-empty-text').textContent, 'This console doesn’t support Insert yet, or Assetlib couldn’t be reached. Send still works.');
  app.console.failures.clear();
  app.element('insert-retry').dispatch('click');
  await settle();
  assert.equal(app.element('insert-empty').hidden, true, 'Try again recovers once the console answers');
  assert.ok(rowFor(app, placement.key));
  app.element('tab-send').dispatch('click');
  app.element('send').dispatch('click');
  await settle();
  assert.equal(app.drafts().length, 1, 'Send is unaffected');

  const offline = harness({ console: { failures: new Set(['placements', 'artwork']) } });
  await exhaustRetries(offline);
  await openInsert(offline);
  await exhaustRetries(offline);
  assert.equal(offline.element('insert-empty-text').textContent, 'Can’t reach Assetlib. Check your internet connection.', 'no placements read succeeded, so it is a plain network error');
});

test('preferences restore the tab, environment, and scale, changes are saved, and a storage failure is silent', async () => {
  const saved = { tab: 'insert', browse: 'placements', environment: 'staging', scale: 2 };
  const app = harness({ storage: [['assetlib.preferences.v1', saved]] });
  await settle();
  assert.equal(app.element('tab-insert').getAttribute('aria-selected'), 'true');
  assert.equal(app.element('panel-insert').hidden, false);
  assert.equal(app.element('panel-send').hidden, true);
  assert.equal(app.element('scale-2').getAttribute('aria-checked'), 'true');
  assert.equal(app.element('env-staging').getAttribute('aria-checked'), 'true');
  assert.equal(app.element('env-staging').title, 'The latest release published to staging. Release 3, Oct 8.');
  assert.deepEqual(app.requests.filter(request => request.route !== 'rendition').map(request => request.route), ['placements', 'artwork'], 'Insert loads on open');
  assert.equal(app.uiMessages.filter(message => message.type === 'save-preferences').length, 0, 'restoring does not save');
  app.element('env-draft').dispatch('click');
  await settle();
  assert.deepEqual(app.storage.get('assetlib.preferences.v1'), { ...saved, environment: 'draft' });
  app.element('tab-send').dispatch('click');
  await settle();
  assert.deepEqual(app.storage.get('assetlib.preferences.v1'), { ...saved, environment: 'draft', tab: 'send' });

  const unpublished = harness({ storage: [['assetlib.preferences.v1', { ...saved, environment: 'production' }]] });
  await settle();
  assert.equal(unpublished.element('env-draft').getAttribute('aria-checked'), 'true', 'nothing is published to production, so draft shows');
  assert.equal(unpublished.element('env-production').disabled, true);
  assert.equal(unpublished.element('env-note').textContent, 'Nothing is published to Production yet, so Draft is shown.');
  assert.equal(unpublished.element('env-note').hidden, false);

  const failing = harness({ failingWrites: ['assetlib.preferences.v1'], prefs: null });
  await openInsert(failing);
  failing.element('scale-3').dispatch('click');
  await settle();
  assert.equal(failing.element('error').hidden, true);
  assert.equal(failing.mainMessages.filter(message => message.type === 'error').length, 0);
  assert.equal(failing.storage.has('assetlib.preferences.v1'), false);
});

test('main rejects bytes Figma cannot use, invalid sizes and links, and an insert during an export', async () => {
  const app = harness();
  await settle();
  const valid = { type: 'insert', connectionGeneration: 0, bytes: pngHeader(100, 100), name: 'Image', frame: { width: 100, height: 100 }, scale: 1, link: null };
  const cases = [
    [{ bytes: filler(40) }, 'The console returned an image Figma cannot use. Refresh and try again.'],
    [{ bytes: new Uint8Array(0) }, 'The console returned an image Figma cannot use. Refresh and try again.'],
    [{ bytes: pngHeader(5000, 10) }, 'The console returned an image Figma cannot use. Refresh and try again.'],
    [{ bytes: [137, 80, 78, 71] }, 'The console returned an image Figma cannot use. Refresh and try again.'],
    [{ frame: { width: 0, height: 100 } }, 'Choose a valid size.'],
    [{ frame: { width: 10.5, height: 100 } }, 'Choose a valid size.'],
    [{ frame: { width: 5000, height: 100 } }, 'Choose a valid size.'],
    [{ frame: null }, 'Choose a valid size.'],
    [{ scale: 4 }, 'Choose a valid size.'],
    [{ link: { placementKey: placement.key, state: null, appearance: null, arm: null, environment: 'draft', assetId: 'nope' } }, 'The inserted image’s placement link is invalid. Choose the image again.'],
    [{ link: { placementKey: placement.key, state: null, appearance: null, arm: null, environment: 'preview', assetId: baseArt } }, 'The inserted image’s placement link is invalid. Choose the image again.'],
  ];
  for (const [index, [change, message]] of cases.entries()) {
    app.postToMain({ ...valid, requestId: 500 + index, ...change });
    await settle();
    assert.deepEqual(errorsFor(app, 500 + index), [message], JSON.stringify(change));
  }
  assert.equal(app.frames.length, 0);
  assert.equal(app.images.length, 0);

  const exporting = app.delayExport();
  app.element('send').dispatch('click');
  await settle();
  app.postToMain({ ...valid, requestId: 600 });
  await settle();
  assert.deepEqual(errorsFor(app, 600), ['An image is already being inserted or exported.']);
  exporting.resolve();
  await settle();
  assert.equal(app.drafts().length, 1, 'the export finishes normally');
  app.postToMain({ ...valid, requestId: 601, name: 'Line\u0000one\nTwo' });
  await settle();
  assert.equal(app.frames.length, 1, 'a valid insert is accepted once the export is done');
  assert.equal(app.frames[0].name, 'LineoneTwo');
});

test('thumbnails load with the bearer as data: URLs, at most three at a time, and pause after HTTP 429', async () => {
  const entries = Array.from({ length: 6 }, (_, index) => libraryAsset(50 + index, `Tile ${index}`, 400, 200));
  const app = harness({ console: library(entries) });
  await openInsert(app);
  app.console.gates.rendition = deferred();
  app.element('browse-images').dispatch('click');
  await settle();
  const previewRequests = () => app.requests.filter(request => entries.some(entry => request.url.endsWith(entry.asset.renditions[1].sha256)));
  assert.equal(previewRequests().length, 3, 'six previews are queued; three run while the console holds them');
  app.console.gates.rendition.resolve();
  await settle();
  const previews = previewRequests();
  assert.equal(previews.length, 6, 'each preview is fetched once');
  assert.ok(previews.every(request => request.authorization === `Bearer ${connection.token}` && request.credentials === 'omit' && request.redirect === 'error'));
  const images = tilesOf(app).map(tile => descendants(tile).find(item => item.tag === 'img'));
  assert.ok(images.every(img => img.src.startsWith('data:image/webp;base64,')), 'each tile shows its preview');
  assert.equal(images[0].src, `data:image/webp;base64,${Buffer.from(entries[0].served[1].body).toString('base64')}`);

  const limited = harness({ console: { ...library(entries), statuses: { rendition: 429 } } });
  await openInsert(limited);
  limited.element('browse-images').dispatch('click');
  await settle();
  assert.equal(limited.element('env-note').textContent, 'Previews paused: too many requests. They resume shortly.');
  assert.equal(limited.element('error').hidden, true, 'previews never use the error line');
  const paused = limited.requests.filter(request => request.route === 'rendition').length;
  assert.ok(paused <= 3, 'no more than three previews were in flight');
  await settle();
  assert.equal(limited.requests.filter(request => request.route === 'rendition').length, paused, 'nothing more is fetched while paused');
  delete limited.console.statuses.rendition;
  limited.fireTimers(15000);
  await settle();
  assert.equal(limited.element('env-note').textContent, '');
  assert.ok(tilesOf(limited).every(tile => descendants(tile).find(item => item.tag === 'img').src.startsWith('data:image/webp')));

  // A 404 is not retried (network errors and 5xx are; see the retry tests below).
  const broken = harness({ console: { ...library(entries), statuses: { rendition: 404 } } });
  await openInsert(broken);
  broken.element('browse-images').dispatch('click');
  await settle();
  const failed = broken.requests.filter(request => request.route === 'rendition').length;
  assert.equal(broken.requests.filter(request => entries.some(entry => request.url.endsWith(entry.asset.renditions[1].sha256))).length, 6);
  assert.ok(![...broken.timers.values()].some(timer => timer.delay === 1000), 'no retry is scheduled');
  broken.element('browse-placements').dispatch('click');
  broken.element('browse-images').dispatch('click');
  await settle();
  assert.equal(broken.requests.filter(request => request.route === 'rendition').length, failed, 'a failed preview is not fetched again for rebuilt tiles');
  assert.ok(tilesOf(broken).every(tile => !descendants(tile).find(item => item.tag === 'img').src), 'failed previews stay blank placeholders');
});

test('the Insert footer shows only with a choice, errors sit in the fixed line above it, and Send has its own footer', async () => {
  const app = harness();
  await settle();
  assert.equal(app.element('sync').className, 'primary', 'a remembered target makes Sync the primary action');
  assert.equal(app.element('send').className, 'secondary');
  assert.equal(app.element('send-bar').hidden, false);
  assert.equal(app.element('insert-bar').hidden, true);
  await openInsert(app);
  assert.equal(app.element('send-bar').hidden, true);
  assert.equal(app.element('insert-bar').hidden, true, 'no footer until something is chosen');

  app.element('insert-search').value = 'nothing';
  app.element('insert-search').dispatch('input');
  assert.equal(app.element('search-clear').hidden, false, 'the search has its own clear button');
  app.element('search-clear').dispatch('click');
  assert.equal(app.element('insert-search').value, '');
  assert.equal(app.element('search-clear').hidden, true);
  rowFor(app, placement.key).dispatch('click');
  assert.deepEqual(clone(rowFor(app, placement.key).scrolledIntoView), { block: 'nearest' }, 'the chosen row stays in view as the footer appears');
  assert.equal(app.element('insert-bar').hidden, false);
  assert.deepEqual([app.element('insert-title').textContent, app.element('insert-meta').textContent], ['hero.artwork', 'Draft']);
  // Main fails the insert after the download; its error lands in the fixed line above the footer.
  app.figma.createImage = () => { throw new Error('decode failed'); };
  app.element('insert').dispatch('click');
  await settle();
  assert.equal(app.element('error').hidden, false);
  assert.equal(app.element('error').textContent, 'Figma could not read this image. Refresh and try again.');
  assert.equal(app.element('alert').textContent, 'Figma could not read this image. Refresh and try again.', 'the alert region announces it');
  rowFor(app, placement.key).dispatch('click');
  assert.equal(app.element('error').hidden, true, 'choosing again clears the old error');

  app.element('tab-send').dispatch('click');
  assert.equal(app.element('insert-bar').hidden, true, 'the Insert footer belongs to Insert');

  const failing = harness({ console: { statuses: { artwork: 403 } } });
  await openInsert(failing);
  assert.equal(failing.element('insert-bar').hidden, true, 'a failed list has nothing to insert');
  const offline = harness({ saved: null });
  await settle();
  assert.equal(offline.element('insert-bar').hidden, true);
  assert.equal(offline.element('panel-insert').hidden, true, 'the first run has no list');

  const inserted = harness();
  await insertHeroCell(inserted);
  assert.match(inserted.element('status').textContent, /^Inserted hero\.artwork/);
  inserted.element('tab-send').dispatch('click');
  assert.equal(inserted.element('status').textContent, '', 'the Insert status does not follow to Send');
  assert.equal(inserted.element('sync').className, 'primary');
});

// ---- A.1: ratio gate, live sizes, recovered connections, previews, visible errors ----
const banner = { key: 'home.banner', screen: 'Home', width: 1170, height: 480, states: null, defaultState: null, variants: null, origin: 'declared' };
const phone = { key: 'onboarding.phone', screen: 'Onboarding', width: 390, height: 844, states: null, defaultState: null, variants: null, origin: 'declared' };
const tallNode = { id: '40:1', name: 'Banner art', type: 'FRAME', width: 390, height: 844 };
const bannerTarget = { fileKey: 'abc123', nodeId: tallNode.id, placementKey: banner.key, state: null, appearance: null, arm: null };
function ratioHarness(nodeSpec = tallNode, options = {}) {
  return harness({ selection: [nodeSpec], remembered: null, storage: [[storageKey(connection, tallNode.id), bannerTarget]],
    console: { placements: [clone(placement), banner, phone] }, ...options });
}
const lastSelection = app => app.mainMessages.filter(message => message.type === 'selection').at(-1).selection;

test('send and sync are disabled whenever the ratio warning is shown', async () => {
  const app = ratioHarness();
  await settle();
  assert.equal(app.element('placement').value, banner.key, 'the remembered placement is chosen');
  assert.equal(app.element('aspect-warning').hidden, false);
  assert.equal(app.element('aspect-text').textContent,
    'This frame is 390 × 844. home.banner needs 2.44\u00a0:\u00a01 (1170 × 480). Resize the frame or match the ratio.');
  assert.equal(off(app, 'send'), true);
  assert.equal(app.element('sync').hidden, false);
  assert.equal(off(app, 'sync'), true);
  app.element('send').dispatch('click');
  app.element('sync').dispatch('click');
  await settle();
  assert.equal(app.exportMessages().length, 0, 'a direct dispatch cannot export either');
  assert.equal(app.element('error').hidden, true, 'the callout already says why');

  // A matching placement can be sent; Sync still goes to the banner, so it stays disabled and the callout names it.
  pick(app, 'placement', phone.key);
  assert.equal(off(app, 'send'), false);
  assert.equal(off(app, 'sync'), true);
  assert.equal(app.element('aspect-text').textContent, 'This frame is 390 × 844. home.banner needs 2.44\u00a0:\u00a01.');
  // Both off: the callout names the chosen placement and the note names Sync's.
  pick(app, 'placement', placement.key);
  assert.equal(app.element('aspect-text').textContent,
    'This frame is 390 × 844. hero.artwork needs 1\u00a0:\u00a01 (1000 × 1000). Resize the frame or match the ratio.');
  assert.match(app.element('sync-note').textContent, /This frame is 390 × 844\. home\.banner needs 2\.44\u00a0:\u00a01\.$/);
  assert.equal(off(app, 'send'), true);
  assert.equal(off(app, 'sync'), true);

  // Within 2%, nothing is shown and both work.
  const close = ratioHarness({ ...tallNode, width: 1170, height: 475 });
  await settle();
  assert.equal(close.element('aspect-warning').hidden, true);
  assert.equal(off(close, 'send'), false);
  assert.equal(off(close, 'sync'), false);
});

test('match-ratio resizes height and reports the new selection', async () => {
  const app = ratioHarness({ ...tallNode, layoutSizingVertical: 'HUG' }, { bytes: pngHeader(1170, 480) });
  await settle();
  app.element('match-ratio').dispatch('click');
  await settle();
  const [match] = app.uiMessages.filter(message => message.type === 'match-ratio');
  assert.deepEqual(match, { type: 'match-ratio', requestId: match.requestId, nodeId: tallNode.id, width: 1170, height: 480 });
  assert.deepEqual(app.resizes, [{ id: tallNode.id, width: 390, height: 160, layoutSizingVertical: 'FIXED' }],
    'the width stays, and a hug height is fixed before the resize');
  assert.deepEqual(app.undoCommits, [0, 1], 'earlier plugin edits are committed first, so the resize is one undo step of its own');
  assert.deepEqual([lastSelection(app).node.width, lastSelection(app).node.height], [390, 160]);
  assert.equal(app.element('aspect-warning').hidden, true);
  assert.equal(off(app, 'send'), false);
  assert.equal(off(app, 'sync'), false);
  app.element('sync').dispatch('click');
  await settle();
  assert.deepEqual(app.drafts()[0].body.bind, { slotKey: banner.key, state: null, appearance: null, arm: null });

  // A stale or busy request changes nothing and says why.
  app.postToMain({ type: 'match-ratio', requestId: 700, nodeId: '99:9', width: 1170, height: 480 });
  await settle();
  assert.deepEqual(errorsFor(app, 700), ['The selection changed. Check it and try again.']);
  const exporting = app.delayExport();
  app.element('sync').dispatch('click');
  await settle();
  app.postToMain({ type: 'match-ratio', requestId: 701, nodeId: tallNode.id, width: 1000, height: 1000 });
  await settle();
  assert.deepEqual(errorsFor(app, 701), ['Wait for the current export or insert to finish, then match the ratio.']);
  exporting.resolve();
  await settle();
  assert.equal(app.resizes.length, 1);
  assert.equal(app.undoCommits.length, 2);

  // Its own failure shows in the error line without touching other work, and leaves the layer as it was.
  const stuck = ratioHarness({ ...tallNode, layoutSizingVertical: 'HUG', resize() { throw new Error('Cannot resize'); } });
  await settle();
  stuck.element('match-ratio').dispatch('click');
  await settle();
  assert.equal(stuck.element('error').textContent, 'Figma couldn’t resize this layer. Resize it on the canvas, then send.');
  assert.equal(stuck.figma.currentPage.selection[0].layoutSizingVertical, 'HUG', 'the hug height fixed for the resize is put back');
  assert.deepEqual(stuck.undoCommits, [0], 'nothing is committed after the failed resize');
});

test('nodechange on the selected node refreshes its size', async () => {
  const app = harness();
  await settle();
  assert.equal(off(app, 'sync'), false);
  const reports = () => app.mainMessages.filter(message => message.type === 'selection').length;
  const before = reports();
  const live = app.figma.currentPage.selection[0];
  live.height = 400;
  for (let i = 0; i < 3; i++) app.nodeChange([{ type: 'PROPERTY_CHANGE', id: node.id, properties: ['height'] }]);
  await settle();
  assert.equal(reports(), before, 'a burst of changes waits for the throttle');
  assert.equal([...app.timers.values()].filter(timer => timer.delay === 150).length, 1, 'one report per 150 ms');
  app.fireTimers(150);
  await settle();
  assert.equal(reports(), before + 1);
  assert.deepEqual([lastSelection(app).node.width, lastSelection(app).node.height], [1000, 400]);
  assert.equal(app.element('aspect-warning').hidden, false, 'the gate follows the canvas without a new selection');
  assert.equal(off(app, 'sync'), true);

  // The listener follows the current page.
  const first = app.figma.currentPage;
  const second = app.changePage([{ ...node, width: 1000, height: 1000 }]);
  await settle();
  assert.equal(first.listeners.size, 0);
  assert.equal(second.listeners.size, 1);
  second.selection[0].height = 500;
  app.nodeChange([{ type: 'PROPERTY_CHANGE', id: node.id, properties: ['height'] }]);
  app.fireTimers(150);
  await settle();
  assert.equal(lastSelection(app).node.height, 500);

  // A page whose off() throws (one just deleted, say) does not stop the next page being watched.
  second.off = () => { throw new Error('The node does not exist'); };
  const third = app.changePage([{ ...node, width: 1000, height: 1000 }]);
  await settle();
  assert.equal(third.listeners.size, 1);
  third.selection[0].height = 600;
  app.nodeChange([{ type: 'PROPERTY_CHANGE', id: node.id, properties: ['height'] }]);
  app.fireTimers(150);
  await settle();
  assert.equal(lastSelection(app).node.height, 600);
});

test('nodechange on another node is ignored', async () => {
  const app = harness();
  await settle();
  const before = app.mainMessages.filter(message => message.type === 'selection').length;
  app.nodeChange([{ type: 'PROPERTY_CHANGE', id: '77:1', properties: ['width'] }, { type: 'CREATE', id: node.id }]);
  await settle();
  assert.equal([...app.timers.values()].filter(timer => timer.delay === 150).length, 0, 'nothing is scheduled');
  assert.equal(app.mainMessages.filter(message => message.type === 'selection').length, before);
  app.select([]);
  await settle();
  app.nodeChange([{ type: 'PROPERTY_CHANGE', id: node.id, properties: ['width'] }]);
  assert.equal([...app.timers.values()].filter(timer => timer.delay === 150).length, 0, 'a deselected node is not watched');
});

test('401 then 200 clears needs-attention, and nothing opens by itself', async () => {
  const app = harness({ console: { statuses: { artwork: 401 } } });
  await openInsert(app);
  assert.equal(app.element('connection-label').textContent, 'Needs attention');
  assert.equal(app.element('chip-warning').hidden, false, 'the account chip shows it');
  assert.equal(app.element('settings').open, false, 'a failed read never opens the settings; the list says why');
  assert.equal(app.element('insert-empty-text').textContent, 'Assetlib no longer accepts this token. Paste a new one.');
  delete app.console.statuses.artwork;
  app.element('insert-refresh').dispatch('click');
  await settle();
  assert.equal(app.element('connection-label').textContent, 'Connected');
  assert.equal(app.element('chip-warning').hidden, true);
  assert.equal(app.element('settings').open, false);
  assert.ok(rowFor(app, placement.key));
  // One primary per view: with the connection working, the footer's Insert is the primary and Connect is secondary.
  assert.equal(app.element('connect').className, 'secondary wide');

  // A failed connection test recovers through any later read, and the reason kept for the token field goes too.
  const tested = harness({ console: { statuses: { placements: 401, artwork: 401 } } });
  await openInsert(tested);
  assert.equal(tested.element('settings').open, false);
  assert.equal(tested.element('connection-error').textContent, 'Assetlib didn’t accept this token. It may have been revoked. Create a new one in Settings › Tokens.',
    'kept under the token field for when the settings open');
  assert.equal(tested.element('chip-warning').hidden, false, 'the account chip shows it');
  assert.equal(tested.element('token').getAttribute('aria-invalid'), 'true');
  assert.equal(tested.element('connection-label').textContent, 'Needs attention');
  tested.console.statuses = {};
  tested.element('insert-refresh').dispatch('click');
  await settle();
  assert.equal(tested.element('connection-label').textContent, 'Connected');
  assert.equal(tested.element('settings').open, false);
  assert.equal(tested.element('connection-error').hidden, true);
  assert.equal(tested.element('token').getAttribute('aria-invalid'), null);
  assert.equal(tested.element('placement').value, placement.key, 'Send gets the placements the failed test missed');

  // Settings the person opened stay open.
  const opened = harness({ console: { statuses: { artwork: 401 } } });
  await settle();
  opened.element('settings').open = true;
  opened.element('tab-insert').dispatch('click');
  await settle();
  delete opened.console.statuses.artwork;
  opened.element('insert-refresh').dispatch('click');
  await settle();
  assert.equal(opened.element('connection-label').textContent, 'Connected');
  assert.equal(opened.element('settings').open, true);
});

test('a failed connection test is said once: by the view in front, or under the token field while the settings are open', async () => {
  const visible = (app, id) => !app.element(id).hidden;
  // Refused on Insert: the list says so with Update token; the settings stay closed and the chip warns.
  const insert = harness({ prefs: { tab: 'insert' }, console: { statuses: { placements: 401 } } });
  await settle();
  assert.equal(insert.element('settings').open, false);
  assert.equal(insert.element('chip-warning').hidden, false);
  assert.equal(insert.element('insert-empty-text').textContent, 'Assetlib no longer accepts this token. Paste a new one.');
  assert.deepEqual(['insert-retry', 'insert-token'].filter(id => visible(insert, id)), ['insert-token']);
  assert.equal(insert.element('alert').textContent, 'Assetlib no longer accepts this token. Paste a new one.', 'announced once');
  assert.equal(insert.activeElement(), insert.element('insert-empty'), 'focus moves to it');
  assert.equal(insert.element('connect').className, 'primary wide', 'fixing the connection is the panel’s primary');
  // Update token: the settings open at the token field with the reason under it, and the list steps aside.
  insert.element('insert-token').dispatch('click');
  await settle();
  assert.equal(insert.element('settings').open, true);
  assert.equal(insert.activeElement(), insert.element('token'));
  assert.equal(insert.element('connection-error').textContent, 'Assetlib didn’t accept this token. It may have been revoked. Create a new one in Settings › Tokens.');
  assert.equal(insert.element('insert-empty').hidden, true, 'not said twice');
  // Closing the settings gives it back to the list.
  insert.element('settings').open = false;
  insert.element('settings').dispatch('toggle');
  await settle();
  assert.equal(insert.element('insert-empty').hidden, false);

  // Unreachable on Insert: Try again in the list, nothing opens, and no field is marked.
  const offline = harness({ prefs: { tab: 'insert' }, console: { failures: new Set(['placements']) } });
  await exhaustRetries(offline);
  assert.equal(offline.element('settings').open, false);
  assert.equal(offline.element('insert-empty-text').textContent, 'Can’t reach Assetlib. Check your internet connection.');
  assert.deepEqual(['insert-retry', 'insert-token'].filter(id => visible(offline, id)), ['insert-retry']);
  assert.equal(offline.element('token').getAttribute('aria-invalid'), null);
  offline.console.failures.clear();
  offline.element('insert-retry').dispatch('click');
  await settle();
  assert.ok(rowFor(offline, placement.key));
  assert.equal(offline.element('connection-label').textContent, 'Connected');
  assert.equal(offline.element('placement').value, placement.key, 'Send gets its placements too');

  // On Send: the form says it in place of its placements, with Try again, which runs the test again.
  const send = harness({ console: { failures: new Set(['placements']) } });
  await exhaustRetries(send);
  assert.equal(send.element('settings').open, false);
  assert.equal(send.element('send-problem').hidden, false);
  assert.equal(send.element('send-problem-text').textContent, 'Can’t reach Assetlib. Check your internet connection.');
  assert.deepEqual(['send-retry', 'send-token'].filter(id => visible(send, id)), ['send-retry']);
  assert.equal(send.activeElement(), send.element('send-problem'), 'focus moves to it');
  assert.equal(send.element('alert').textContent, 'Can’t reach Assetlib. Check your internet connection.');
  send.console.failures.clear();
  send.element('send-retry').dispatch('click');
  await settle();
  assert.equal(send.element('send-problem').hidden, true);
  assert.equal(send.element('placement').value, placement.key);
  assert.equal(off(send, 'send'), false);
  assert.equal(send.element('connection-label').textContent, 'Connected');

  // Refused on Send: Update token. With the settings open, the token field says it and the form does not.
  const refused = harness({ console: { statuses: { placements: 401 } } });
  await settle();
  assert.equal(refused.element('send-problem-text').textContent, 'Assetlib no longer accepts this token. Paste a new one.');
  assert.deepEqual(['send-retry', 'send-token'].filter(id => visible(refused, id)), ['send-token']);
  refused.element('send-token').dispatch('click');
  await settle();
  assert.equal(refused.element('settings').open, true);
  assert.equal(refused.activeElement(), refused.element('token'));
  assert.equal(refused.element('send-problem').hidden, true, 'not said twice');

  // A test that fails while the person has the settings open (they saved a token there) is said under the token field only.
  const saving = harness({ prefs: { tab: 'insert' } });
  await openInsert(saving);
  saving.element('settings').open = true;
  saving.element('token').focus();
  saving.console.statuses.placements = 401;
  saving.saveConnection({ ...connection, token: tok('draft_revoked') });
  await settle();
  assert.equal(saving.element('connection-error').textContent, 'Assetlib didn’t accept this token. It may have been revoked. Create a new one in Settings › Tokens.');
  assert.equal(saving.element('alert').textContent, 'Assetlib didn’t accept this token. It may have been revoked. Create a new one in Settings › Tokens.');
  assert.equal(saving.element('insert-empty').hidden, true, 'the list says nothing of its own');
  assert.equal(saving.activeElement(), saving.element('token'));
});

test('a failed connection test recovered by another read loads placements for Send', async () => {
  // The network was down for the test, then came back.
  const app = harness({ console: { failures: new Set(['placements']) } });
  await exhaustRetries(app);
  assert.equal(app.element('connection-label').textContent, 'Needs attention');
  assert.equal(app.element('settings').open, false);
  assert.equal(app.element('send-problem').hidden, false);
  assert.equal(off(app, 'send'), true);
  app.console.failures.delete('placements');
  app.element('tab-insert').dispatch('click');
  await settle();
  assert.equal(app.element('connection-label').textContent, 'Connected');
  assert.equal(app.element('connection-error').hidden, true);
  assert.ok(rowFor(app, placement.key));
  app.element('tab-send').dispatch('click');
  await settle();
  assert.equal(app.element('send-problem').hidden, true);
  assert.equal(app.element('placement').value, placement.key, 'the remembered placement is chosen without another test');
  assert.equal(off(app, 'send'), false);
  assert.equal(off(app, 'sync'), false);

  // While placements still fail, the label and the test's reason stay, and another quiet try waits 15 s.
  const down = harness({ console: { failures: new Set(['placements']) } });
  await exhaustRetries(down);
  const placementReads = () => down.requests.filter(request => request.route === 'placements').length;
  down.element('tab-insert').dispatch('click');
  await settle();
  assert.equal(placementReads(), 4, 'the test, tried three times, then one quiet read after the artwork loaded');
  assert.equal(down.element('connection-label').textContent, 'Needs attention');
  assert.equal(down.element('settings').open, false);
  assert.equal(down.element('connection-error').hidden, false);
  down.element('insert-refresh').dispatch('click');
  await settle();
  assert.equal(placementReads(), 4);
});

const previewSha = entry => entry.asset.renditions[1].sha256;
const imgOf = tile => descendants(tile).find(item => item.tag === 'img');
function previewLog(app, entries) {
  return () => app.requests.flatMap(request => {
    const index = entries.findIndex(entry => request.url.endsWith(previewSha(entry)));
    return index >= 0 ? [index] : [];
  });
}

test('bottom tiles load before skipped tiles after a jump', async () => {
  const entries = Array.from({ length: 24 }, (_, index) => libraryAsset(60 + index, `Tile ${index}`, 400, 200));
  const app = harness({ console: library(entries) });
  await openInsert(app);
  const tileId = target => target.parentElement?.parentElement?.getAttribute?.('data-asset-id');
  const showing = indexes => { const ids = new Set(indexes.map(index => entries[index].asset.id)); return target => ids.has(tileId(target)); };
  app.setVisible(showing([0, 1, 2, 3, 4, 5, 6, 7, 8]));
  app.console.gates.rendition = deferred();
  app.element('browse-images').dispatch('click');
  await settle();
  const previews = previewLog(app, entries);
  assert.deepEqual(previews(), [0, 1, 2], 'three run; the rest of the first view waits');
  // The document as root: inside Figma's cross-origin iframe the implicit root ignores the margin.
  // The list scrolls in #list-region, so that is the root; an explicit root also keeps the margin in Figma's cross-origin iframe.
  assert.ok([...app.observers].some(observer => observer.options.root === app.element('list-region') && observer.options.rootMargin === '300px 0px'));

  // A jump to the bottom before those finish: the skipped tiles give up their places.
  app.setVisible(showing([21, 22, 23]));
  await settle();
  app.console.gates.rendition.resolve();
  await settle();
  assert.deepEqual(previews(), [0, 1, 2, 21, 22, 23]);
  const tiles = tilesOf(app);
  assert.ok([21, 22, 23].every(index => imgOf(tiles[index]).src.startsWith('data:image/webp')));
  assert.ok([3, 4, 5, 6, 7, 8].every(index => !imgOf(tiles[index]).src), 'skipped tiles are not fetched');

  // Back at the top, the skipped tiles load, top to bottom.
  app.setVisible(showing([0, 1, 2, 3, 4, 5, 6, 7, 8]));
  await settle();
  assert.deepEqual(previews(), [0, 1, 2, 21, 22, 23, 3, 4, 5, 6, 7, 8]);
  assert.ok(tilesOf(app).slice(0, 9).every(tile => imgOf(tile).src.startsWith('data:image/webp')));
});

test('one network error does not blank a preview for the session', async () => {
  const entries = [libraryAsset(80, 'Solo', 400, 200)];
  const app = harness({ console: library(entries) });
  await openInsert(app);
  app.console.failures.add('rendition');
  app.element('browse-images').dispatch('click');
  await settle();
  const previews = previewLog(app, entries);
  assert.deepEqual(previews(), [0]);
  assert.equal(imgOf(tilesOf(app)[0]).src, '');
  app.console.failures.delete('rendition');
  app.fireTimers(1000);
  await settle();
  assert.deepEqual(previews(), [0, 0], 'retried after one second');
  assert.ok(imgOf(tilesOf(app)[0]).src.startsWith('data:image/webp'));
  assert.equal(app.element('error').hidden, true, 'previews never use the error line');
});

test('refresh retries failed previews', async () => {
  const entries = [libraryAsset(81, 'Solo', 400, 200)];
  const app = harness({ console: { ...library(entries), statuses: { rendition: 503 } } });
  await openInsert(app);
  app.element('browse-images').dispatch('click');
  await settle();
  const previews = previewLog(app, entries);
  app.fireTimers(1000);
  await settle();
  app.fireTimers(4000);
  await settle();
  assert.deepEqual(previews(), [0, 0, 0], 'a 5xx is tried three times, after 1 s and 4 s');
  assert.ok(![...app.timers.values()].some(timer => timer.delay === 1000 || timer.delay === 4000), 'then it stops');
  app.element('browse-placements').dispatch('click');
  app.element('browse-images').dispatch('click');
  await settle();
  assert.deepEqual(previews(), [0, 0, 0], 'rebuilt tiles do not refetch a failed preview');
  assert.equal(imgOf(tilesOf(app)[0]).src, '');

  delete app.console.statuses.rendition;
  app.element('insert-refresh').dispatch('click');
  await settle();
  assert.deepEqual(previews(), [0, 0, 0, 0]);
  assert.ok(imgOf(tilesOf(app)[0]).src.startsWith('data:image/webp'));
});

test('a preview that started before a failed read does not mark the connection good', async () => {
  const entries = Array.from({ length: 3 }, (_, index) => libraryAsset(90 + index, `Late ${index}`, 400, 200));
  const app = harness({ console: library(entries) });
  await openInsert(app);
  app.console.gates.rendition = deferred();
  app.element('browse-images').dispatch('click');
  await settle();
  assert.deepEqual(previewLog(app, entries)(), [0, 1, 2], 'three previews are in flight');
  app.console.statuses.assets = 401;
  app.element('insert-refresh').dispatch('click');
  await settle();
  assert.equal(app.element('connection-label').textContent, 'Needs attention');
  assert.equal(app.element('chip-warning').hidden, false);
  app.console.gates.rendition.resolve();
  await settle();
  assert.equal(app.element('connection-label').textContent, 'Needs attention', 'they were sent before the token was refused');
  assert.equal(app.element('chip-warning').hidden, false);

  // A read that starts after the failure still recovers it.
  delete app.console.statuses.assets;
  delete app.console.gates.rendition;
  app.element('insert-refresh').dispatch('click');
  await settle();
  assert.equal(app.element('connection-label').textContent, 'Connected');
  assert.equal(app.element('chip-warning').hidden, true);
});

test('errors are scrolled into view and focused; connection errors sit under the token field', async () => {
  const app = harness({ bytes: new Uint8Array([137, 80, 78, 71]) });
  await settle();
  app.element('send').dispatch('click');
  await settle();
  assert.equal(app.element('error').hidden, false);
  assert.deepEqual(clone(app.element('error').scrolledIntoView), { block: 'nearest' });
  assert.equal(app.activeElement(), app.element('error'));

  // Typing a search keeps focus; the error still scrolls into view.
  const typing = harness({ console: { ...library([libraryAsset(82, 'Solo', 400, 200)]) } });
  await openInsert(typing);
  typing.element('browse-images').dispatch('click');
  await settle();
  typing.console.statuses.assets = 500;
  typing.element('insert-search').focus();
  typing.element('insert-search').value = 'so';
  typing.element('insert-search').dispatch('input');
  typing.fireTimers(300);
  await settle();
  assert.equal(typing.element('insert-empty').hidden, false, 'a failed list says so in its place');
  assert.equal(typing.element('insert-empty-text').textContent, 'Assetlib had a problem (500). Try again in a minute.');
  assert.equal(typing.activeElement(), typing.element('insert-search'));

  // A refused token: the Send form says so, with focus; the reason waits under the token field, which is marked, for
  // when the settings open.
  const refused = harness({ console: { statuses: { placements: 401 } } });
  await settle();
  assert.equal(refused.element('settings').open, false, 'nothing opens by itself');
  assert.equal(refused.element('send-problem').hidden, false);
  assert.equal(refused.activeElement(), refused.element('send-problem'));
  assert.deepEqual(clone(refused.element('send-problem').scrolledIntoView), { block: 'nearest' });
  assert.equal(refused.element('connection-error').hidden, false);
  assert.equal(refused.element('token').getAttribute('aria-invalid'), 'true');
  assert.equal(refused.element('error').hidden, true);
  assert.equal(refused.element('connection-label').textContent, 'Needs attention');

  // A network failure waits there too, but marks no field: the entries may be right.
  const offline = harness({ console: { failures: new Set(['placements']) } });
  await exhaustRetries(offline);
  assert.equal(offline.element('connection-error').textContent, 'Can’t reach Assetlib. Check your internet connection.');
  assert.equal(offline.element('token').getAttribute('aria-invalid'), null);
  assert.equal(offline.activeElement(), offline.element('send-problem'));
  refused.element('send-token').dispatch('click');
  await settle();

  // A console that can't name a token's app (GET /api/token answers 404) asks for the IDs: the fields show, and the
  // organization ID has focus.
  assert.equal(refused.element('id-fields').hidden, true, 'a token is all the form asks for');
  refused.element('token').value = tok('older');
  refused.element('connection-form').dispatch('submit');
  await settle();
  assert.equal(refused.element('connection-error').textContent, 'This console also needs the organization and app IDs. Find them in Settings › General.');
  assert.equal(refused.element('id-fields').hidden, false);
  assert.equal(refused.activeElement(), refused.element('org-id'));
  assert.equal(refused.element('connection-error').className, 'info', 'a step, not an error');
  assert.equal(refused.element('org-id').getAttribute('aria-invalid'), null);
  // A malformed entry names its own field, and a later successful read leaves that error for the person to fix.
  refused.element('org-id').value = 'bad id';
  refused.element('connection-form').dispatch('submit');
  await settle();
  assert.equal(refused.element('connection-error').textContent, 'Enter the organization ID from Settings › General in the Assetlib console.');
  assert.equal(refused.element('connection-error').className, 'error');
  assert.equal(refused.element('org-id').getAttribute('aria-invalid'), 'true');
  assert.equal(refused.element('token').getAttribute('aria-invalid'), null);
  assert.equal(refused.activeElement(), refused.element('org-id'));
  assert.equal(refused.requests.filter(request => request.route === 'token').length, 1, 'with the IDs shown, the form does not ask GET /api/token again');

  // Main's storage failure on save is a connection error as well.
  const unsaved = harness({ saved: null, failingWrites: ['assetlib.connection.v1'] });
  await settle();
  unsaved.saveConnection(connection);
  await settle();
  assert.equal(unsaved.element('connection-error').textContent, 'Figma couldn’t save this on your device. Try again.');
  assert.equal(unsaved.element('error').hidden, true);
  assert.equal(off(unsaved, 'connect'), false, 'the form can be submitted again');
});

test('callouts set body text on bg-secondary with a tone icon, never the tinted washes', async () => {
  const html = await readFile(new URL('../src/ui.html', import.meta.url), 'utf8');
  const rule = selector => new RegExp(`\\n\\s*${selector.replace(/[.*]/g, '\\$&')}\\s*\\{([^}]*)\\}`).exec(html)?.[1] ?? '';
  assert.match(rule('.notice, .error, .info'), /background: var\(--figma-color-bg-secondary/);
  assert.match(rule('.notice, .error, .info'), /color: var\(--figma-color-text,/);
  assert.match(rule('.notice::before'), /--figma-color-icon-warning/);
  assert.match(rule('.error::before'), /--figma-color-icon-danger/);
  // A neutral step (an older console's IDs) carries an ink icon, no warning or danger colour.
  assert.match(rule('.info::before'), /background: var\(--text\); \}?$/);
  assert.doesNotMatch(html, /var\(--figma-color-(bg-warning-tertiary|bg-danger-tertiary|text-warning|text-danger)/);
});

test('every element id the UI script reads exists in ui.html', async () => {
  const modules = (await readdir(new URL('../src/ui/', import.meta.url))).filter(name => name.endsWith('.ts')).map(name => `src/ui/${name}`);
  const [html, ...scripts] = await Promise.all(['src/ui.html', ...modules].map(path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')));
  const script = scripts.join('\n');
  const ids = new Set([...script.matchAll(/element(?:<[^>]+>)?\('([a-z-]+)'\)/g)].map(match => match[1]));
  for (const name of ['draft', 'staging', 'production']) ids.add(`env-${name}`);
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.equal(html.split('<!-- ASSETLIB_SCRIPT -->').length, 2);
});

// ---- A.2: requests, the busy model, and main's message guard ----
const UNREADABLE = 'The plugin hit an unexpected problem. Close and reopen it, then try again.';
const timerDelays = app => [...app.timers.values()].map(timer => timer.delay);

test('GET retries twice on 503', async () => {
  const app = harness({ console: { statuses: { placements: 503 } } });
  await settle();
  const reads = () => app.requests.filter(request => request.route === 'placements').length;
  assert.equal(reads(), 1);
  assert.equal(app.element('connection-error').hidden, true, 'nothing is shown while it tries again');
  assert.equal(app.element('status').textContent, 'Testing connection…');
  app.fireTimers(1000);
  await settle();
  assert.equal(reads(), 2, 'tried again after 1 s');
  app.fireTimers(4000);
  await settle();
  assert.equal(reads(), 3, 'and after 4 s more');
  assert.equal(app.element('connection-error').textContent, 'Assetlib had a problem (503). Try again in a minute.');
  assert.ok(!timerDelays(app).some(delay => delay === 1000 || delay === 4000), 'then it stops');

  // A 503 that clears on the next try is a normal success.
  const recovering = harness({ console: { statuses: { artwork: 503 } } });
  await openInsert(recovering);
  delete recovering.console.statuses.artwork;
  recovering.fireTimers(1000);
  await settle();
  assert.ok(rowFor(recovering, placement.key));
  assert.equal(recovering.element('error').hidden, true);

  // A 429 waits as long as Retry-After asks, up to 30 s; a longer wait, or none named, is not retried.
  const limited = harness({ console: { statuses: { artwork: 429 }, headers: { artwork: { 'retry-after': '7' } } } });
  await openInsert(limited);
  assert.ok(timerDelays(limited).includes(7000));
  limited.fireTimers(7000);
  await settle();
  limited.fireTimers(7000);
  await settle();
  assert.equal(limited.requests.filter(request => request.route === 'artwork').length, 3);
  assert.equal(limited.element('insert-empty-text').textContent, 'Assetlib is busy. Try again in a minute.');
  for (const headers of [{ 'retry-after': '120' }, {}]) {
    const long = harness({ console: { statuses: { artwork: 429 }, headers: { artwork: headers } } });
    await openInsert(long);
    assert.equal(long.requests.filter(request => request.route === 'artwork').length, 1, JSON.stringify(headers));
    assert.equal(long.element('insert-empty').hidden, false);
  }
});

test('draft POST is never retried', async () => {
  for (const [name, fail, expected] of [
    ['a 503', state => { state.statuses.drafts = 503; }, 'Assetlib had a problem (503). Try again in a minute.'],
    ['a network error', state => state.failures.add('drafts'),
      'Can’t reach Assetlib. Check your internet connection. It may have arrived anyway, so check the console before sending again.'],
  ]) {
    const app = harness({ remembered: null });
    await settle();
    pick(app, 'placement', placement.key);
    fail(app.console);
    app.element('send').dispatch('click');
    await exhaustRetries(app);
    assert.equal(app.drafts().length, 1, name);
    assert.equal(app.element('error').textContent, expected, name);
    assert.equal(app.element('status').textContent, '');
    assert.equal(off(app, 'send'), false, 'Send can be chosen again');
    assert.equal(app.uiMessages.filter(message => message.type === 'remember').length, 0);
  }
});

test('timeout says how many seconds', async () => {
  const app = harness({ console: { gates: { placements: deferred() } } });
  await settle();
  assert.equal(timerDelays(app).filter(delay => delay === 20000).length, 1, 'a read waits 20 s');
  app.fireTimers(20000);
  await settle();
  assert.equal(app.element('connection-error').textContent, 'Assetlib didn’t answer within 20 seconds. Try again.');
  assert.equal(app.requests.filter(request => request.route === 'placements').length, 1, 'a timeout is not tried again');
  assert.equal(app.requests[0].signal.aborted, true, 'the request is abandoned');
  assert.equal(app.element('connection-label').textContent, 'Needs attention');

  // A draft that timed out may still have arrived, and says so.
  const sending = harness({ remembered: null, console: { gates: { drafts: deferred() } } });
  await settle();
  pick(sending, 'placement', placement.key);
  sending.element('send').dispatch('click');
  await settle();
  assert.ok(timerDelays(sending).includes(30000), 'a small draft waits 30 s');
  sending.fireTimers(30000);
  await settle();
  assert.equal(sending.element('error').textContent,
    'Assetlib didn’t answer within 30 seconds. It may have arrived anyway, so check the console before sending again.');
  assert.equal(sending.drafts().length, 1);
  assert.equal(off(sending, 'send'), false);
});

test('upload timeout grows with body size', async () => {
  // A 2 MiB export, so the base64 JSON body is about 2.7 MiB.
  const big = new Uint8Array(2 * 1024 * 1024);
  big.set(pngHeader(1000, 1000));
  const app = harness({ remembered: null, bytes: big, console: { gates: { drafts: deferred() } } });
  await settle();
  pick(app, 'placement', placement.key);
  app.element('send').dispatch('click');
  await settle();
  const [draft] = app.drafts();
  const bodyBytes = JSON.stringify(draft.body).length;
  // 30 s plus 15 s per MiB, in whole seconds.
  const expected = 30000 + Math.round((15 * bodyBytes) / (1024 * 1024)) * 1000;
  assert.equal(expected, 70000);
  assert.ok(timerDelays(app).includes(expected));
  app.fireTimers(expected);
  await settle();
  assert.equal(app.element('error').textContent,
    'Assetlib didn’t answer within 70 seconds. It may have arrived anyway, so check the console before sending again.');
  assert.equal(app.drafts().length, 1);

  // An insert download is timed by the size the console listed: 20 s plus 15 s per MiB.
  const large = libraryAsset(400, 'Large', 400, 200);
  large.asset.renditions[0] = { ...large.asset.renditions[0], bytes: 3 * 1024 * 1024 };
  const inserting = harness({ console: { ...library([large]), gates: { rendition: deferred() } } });
  await openInsert(inserting);
  inserting.element('browse-images').dispatch('click');
  await settle();
  tilesOf(inserting)[0].dispatch('click');
  inserting.element('insert').dispatch('click');
  await settle();
  assert.ok(timerDelays(inserting).includes(65000));
});

test('a new search aborts the previous request', async () => {
  const entries = Array.from({ length: 30 }, (_, index) => libraryAsset(index, index % 3 === 0 ? `Coast ${index}` : `Ridge ${index}`, 400, 200));
  const app = harness({ console: library(entries) });
  await openInsert(app);
  app.element('browse-images').dispatch('click');
  await settle();
  const searches = () => app.requests.filter(request => request.route === 'assets');
  app.console.gates.assets = deferred();
  const type = async value => {
    app.element('insert-search').value = value;
    app.element('insert-search').dispatch('input');
    app.fireTimers(300);
    await settle();
  };
  await type('Ridge');
  assert.equal(searches().length, 2);
  assert.equal(app.element('image-grid').getAttribute('aria-busy'), 'true');
  await type('Coast');
  assert.equal(searches().length, 3);
  assert.equal(searches()[1].signal.aborted, true, 'the earlier search is abandoned');
  assert.equal(searches()[2].signal.aborted, false);
  await type('Coast');
  assert.equal(searches().length, 3, 'the same search is not sent twice');
  app.console.gates.assets.resolve();
  await settle();
  assert.equal(tilesOf(app).length, 10);
  assert.ok(tilesOf(app).every(tile => textOf(tile).startsWith('Coast')));
  assert.equal(app.element('error').hidden, true, 'an abandoned search is not an error');
  assert.equal(app.element('image-grid').getAttribute('aria-busy'), null);

  // Refresh replaces a list load the same way, and a connection change ends every request.
  app.element('browse-placements').dispatch('click');
  app.console.gates.artwork = deferred();
  app.element('insert-refresh').dispatch('click');
  await settle();
  app.element('insert-refresh').dispatch('click');
  await settle();
  const loads = app.requests.filter(request => request.route === 'artwork');
  assert.equal(loads.at(-2).signal.aborted, true);
  app.saveConnection({ ...connection, token: tok('draft_next') });
  await settle();
  assert.equal(loads.at(-1).signal.aborted, true);
  app.console.gates.artwork.resolve();
  await settle();
  assert.equal(app.element('error').hidden, true);
});

test('a placements Refresh abandoned for Images loads again when Placements shows', async () => {
  const app = harness({ console: library([libraryAsset(0, 'Coast', 400, 200)]) });
  await openInsert(app);
  assert.ok(rowFor(app, placement.key));
  const loads = () => app.requests.filter(request => request.route === 'artwork');
  app.console.gates.artwork = deferred();
  app.element('insert-refresh').dispatch('click');
  await settle();
  const skeletons = () => app.element('insert-list').children.filter(item => item.className === 'placement skeleton').length;
  assert.equal(loads().length, 2);
  assert.equal(skeletons(), 6, 'skeleton rows hold the list while it loads');
  app.element('browse-images').dispatch('click');
  await settle();
  assert.equal(loads()[1].signal.aborted, true, 'the Images load replaces the Refresh');
  assert.equal(tilesOf(app).length, 1);
  app.element('browse-placements').dispatch('click');
  await settle();
  assert.equal(loads().length, 3, 'the placements that never arrived load again');
  assert.equal(loads()[2].signal.aborted, false);
  assert.equal(skeletons(), 6);
  assert.equal(app.element('insert-list').getAttribute('aria-busy'), 'true');
  app.console.gates.artwork.resolve();
  await settle();
  assert.ok(rowFor(app, placement.key), 'the rows come back');
  assert.equal(app.element('insert-empty').hidden, true);
  assert.equal(app.element('insert-list').getAttribute('aria-busy'), null);
  assert.equal(app.element('error').hidden, true, 'an abandoned load is not an error');
  // Back and forth with the rows loaded reads nothing again.
  app.element('browse-images').dispatch('click');
  await settle();
  app.element('browse-placements').dispatch('click');
  await settle();
  assert.equal(loads().length, 3);
  assert.ok(rowFor(app, placement.key));
});

test('malformed save-connection gets a plain error', async () => {
  const app = harness();
  await settle();
  const saved = clone(app.storage.get('assetlib.connection.v1'));
  app.postToMain({ type: 'save-connection', requestId: 41, connection: null });
  app.postToMain({ type: 'save-connection', requestId: 42, connection: { origin: 5 } });
  app.postToMain({ type: 'save-file-url', requestId: 43 });
  app.postToMain({ type: 'export', requestId: 44 });
  app.postToMain({ type: 'unknown', requestId: 45 });
  app.postToMain({ type: 'save-connection', connection });
  await settle();
  for (const id of [41, 42, 43, 44, 45]) assert.deepEqual(errorsFor(app, id), [UNREADABLE], `request ${id}`);
  assert.deepEqual(app.mainMessages.filter(message => message.type === 'error' && message.requestId === undefined).map(message => message.message), [UNREADABLE],
    'a message without a request id gets an error without one');
  assert.deepEqual(app.storage.get('assetlib.connection.v1'), saved, 'nothing is saved');
  assert.equal(app.mainMessages.filter(message => message.type === 'connection').length, 1);
  // A well-formed request with a bad value keeps its own message.
  app.postToMain({ type: 'save-connection', requestId: 46, connection: { ...connection, orgId: 'bad id' } });
  await settle();
  assert.deepEqual(errorsFor(app, 46), ['Enter the organization ID from Settings › General in the Assetlib console.']);
  // The UI shows the error that names no request, and leaves Send as it was.
  assert.equal(app.element('error').textContent, UNREADABLE);
  assert.equal(off(app, 'send'), false);
});

test('an error clears only its own pending operation', async () => {
  const app = harness({ remembered: null });
  await settle();
  pick(app, 'placement', placement.key);
  const exporting = app.delayExport();
  app.element('send').dispatch('click');
  await settle();
  assert.equal(app.element('status').textContent, 'Exporting selected artwork…');
  for (const id of ['send', 'connect', 'insert', 'match-ratio']) assert.equal(off(app, id), true, `${id} waits for the send`);

  // A file URL that main refuses, a stale request's error, and an error naming no request: the send carries on.
  app.element('file-url').value = 'https://example.com/not-figma';
  app.element('file-form').dispatch('submit');
  await settle();
  assert.equal(app.element('error').textContent, 'That isn’t a link to a Figma design file. In Figma, press Cmd+L to copy this file’s link, then paste it here.');
  app.postToMain({ type: 'match-ratio', requestId: 777, nodeId: '99:9', width: 10, height: 10 });
  app.deliver({ type: 'error', message: 'Something else went wrong.' });
  await settle();
  assert.deepEqual(errorsFor(app, 777), ['Wait for the current export or insert to finish, then match the ratio.']);
  assert.equal(app.element('error').textContent, 'Something else went wrong.');
  assert.equal(app.element('status').textContent, 'Exporting selected artwork…');
  assert.equal(off(app, 'send'), true, 'the send is still running');
  exporting.resolve();
  await settle();
  assert.equal(app.drafts().length, 1);
  assert.equal(app.element('status').textContent, 'Sent to hero.artwork draft');
  assert.equal(off(app, 'send'), false);

  // Its own error ends it.
  app.figma.currentPage.selection = [];
  app.element('send').dispatch('click');
  await settle();
  assert.equal(app.element('error').textContent, 'The selection changed while sending. Check it and send again.');
  assert.equal(app.element('status').textContent, '');
  assert.equal(off(app, 'connect'), false);

  // A save-file-url reply names its request, and a stale one is ignored.
  app.deliver({ type: 'file-saved', requestId: 9999, fileKey: 'abc123' });
  assert.notEqual(app.element('status').textContent, 'File linked for this session.');
});

const SAVE_REFUSED = 'Figma couldn’t save this on your device. Try again.';
const artworkReads = app => app.requests.filter(request => request.route === 'artwork');
/** After main refused a save: the error under the token field, the typed token kept, and the old connection working. */
async function assertConnectionKept(app, typed) {
  assert.equal(app.element('connection-error').textContent, SAVE_REFUSED);
  assert.equal(app.element('connection-error').hidden, false);
  assert.equal(app.element('error').hidden, true);
  assert.equal(app.element('token').value, typed, 'the pasted token stays for another try');
  assert.equal(off(app, 'connect'), false);
  assert.deepEqual(app.storage.get('assetlib.connection.v1'), connection, 'nothing was saved');
  const refusal = app.mainMessages.findLastIndex(message => message.type === 'error');
  assert.ok(app.mainMessages.slice(refusal + 1).some(message => message.type === 'selection' && message.connectionGeneration === 0),
    'main reports the selection again after refusing the save');
  // The list is loaded, and Refresh reads again with the connection that stands.
  assert.equal(app.element('insert-list').getAttribute('aria-busy'), null);
  assert.ok(rowFor(app, placement.key));
  const reads = artworkReads(app).length;
  app.element('insert-refresh').dispatch('click');
  await settle();
  assert.equal(artworkReads(app).length, reads + 1, 'Refresh sends a read');
  assert.ok(artworkReads(app).every(request => request.url.includes('/org-one/app-a/') && request.authorization === `Bearer ${connection.token}`));
  assert.equal(app.element('insert-list').getAttribute('aria-busy'), null);
  assert.ok(rowFor(app, placement.key));
  // Send and Sync work with the old connection, and the error stays until the person acts on it.
  assert.equal(off(app, 'send'), false);
  assert.equal(off(app, 'sync'), false);
  app.element('sync').dispatch('click');
  await settle();
  assert.equal(app.drafts().length, 1);
  assert.equal(app.drafts()[0].authorization, `Bearer ${connection.token}`);
  assert.deepEqual(app.drafts()[0].body.bind, { slotKey: placement.key, state: 'old', appearance: 'light', arm: 'b' });
  assert.equal(app.element('connection-error').textContent, SAVE_REFUSED);
}

for (const [description, finishFirst] of [['ended while the save waited', true], ['was still running when main refused the save', false]]) {
  test(`a refused connection save keeps the old connection when a list load ${description}`, async () => {
    const app = harness({ failingWrites: ['assetlib.connection.v1'], console: { gates: { artwork: deferred() } } });
    await openInsert(app);
    assert.equal(app.element('insert-list').getAttribute('aria-busy'), 'true');
    assert.equal(off(app, 'connect'), false, 'Connect is live while a list loads');
    const write = app.delayConnectionWrite();
    app.saveConnection({ ...connection, token: tok('draft_rotated') });
    await settle();
    if (finishFirst) {
      app.console.gates.artwork.resolve();
      await settle();
      assert.equal(artworkReads(app).length, 1);
      assert.equal(app.element('insert-list').getAttribute('aria-busy'), 'true', 'its answer was dropped while the save waited');
    }
    write.resolve();
    await settle();
    if (!finishFirst) {
      app.console.gates.artwork.resolve();
      await settle();
    }
    assert.equal(artworkReads(app).length, 2, 'the list loads again once, with the old connection');
    await assertConnectionKept(app, tok('draft_rotated'));
  });
}

test('a refused connection save with no list loading keeps the rows and the choice, and runs what was asked for meanwhile', async () => {
  const app = harness({ failingWrites: ['assetlib.connection.v1'], console: library([libraryAsset(1, 'Coast', 400, 200)]) });
  await openInsert(app);
  rowFor(app, placement.key).dispatch('click');
  const refuse = async next => {
    const write = app.delayConnectionWrite();
    app.saveConnection(next);
    await settle();
    return async () => { write.resolve(); await settle(); };
  };

  // Nothing ran during the wait: no read, and the rows and the choice stay.
  await (await refuse({ ...connection, token: tok('draft_rotated') }))();
  assert.equal(artworkReads(app).length, 1);
  assert.equal(rowFor(app, placement.key).getAttribute('aria-pressed'), 'true');
  assert.equal(off(app, 'insert'), false);
  await assertConnectionKept(app, tok('draft_rotated'));

  // A Refresh during the wait has no connection to read with yet; it runs once the old one stands.
  const reads = artworkReads(app).length;
  const refreshed = await refuse({ ...connection, appId: 'app-b', token: tok('draft_b') });
  app.element('insert-refresh').dispatch('click');
  await settle();
  assert.equal(artworkReads(app).length, reads);
  await refreshed();
  assert.equal(artworkReads(app).length, reads + 1);
  assert.equal(artworkReads(app).at(-1).authorization, `Bearer ${connection.token}`);
  assert.equal(app.element('token').value, tok('draft_b'));
  assert.ok(rowFor(app, placement.key));

  // A view opened during the wait loads once the old connection stands.
  const opened = await refuse({ ...connection, token: tok('draft_rotated') });
  app.element('browse-images').dispatch('click');
  await settle();
  assert.equal(tilesOf(app).length, 0);
  await opened();
  assert.equal(tilesOf(app).length, 1);
  assert.equal(app.requests.filter(request => request.route === 'assets').at(-1).authorization, `Bearer ${connection.token}`);
  assert.equal(app.element('image-grid').getAttribute('aria-busy'), null);
});

test('Insert uses the size shown when it was chosen, even if Insert at changes during the download', async () => {
  const app = harness();
  await openInsert(app);
  rowFor(app, placement.key).dispatch('click');
  assert.equal(app.element('insert-meta').textContent, 'Draft');
  app.console.gates.rendition = deferred();
  app.element('insert').dispatch('click');
  await settle();
  assert.equal(app.element('insert').textContent, 'Inserting…');
  app.element('scale-2').dispatch('click');
  app.console.gates.rendition.resolve();
  await settle();
  assert.equal(app.insertMessages()[0].scale, 1);
  assert.deepEqual([app.frames[0].width, app.frames[0].height], [1000, 1000]);
});

test('only conflicting actions wait during an operation; tabs, lists, search, and the environment stay live', async () => {
  const app = harness();
  await openInsert(app);
  rowFor(app, placement.key).dispatch('click');
  app.console.gates.rendition = deferred();
  app.element('insert').dispatch('click');
  await settle();
  assert.equal(app.element('status').textContent, 'Downloading hero.artwork…');
  for (const id of ['insert', 'send', 'sync', 'connect', 'match-ratio']) assert.equal(off(app, id), true, `${id} waits`);
  for (const id of ['tab-send', 'tab-insert', 'browse-placements', 'browse-images', 'insert-search', 'scale-2', 'env-draft', 'env-staging', 'insert-refresh', 'placement'])
    assert.equal(app.element(id).disabled, false, `${id} stays live`);
  app.element('tab-send').dispatch('click');
  assert.equal(app.element('panel-send').hidden, false);
  assert.equal(app.element('status').textContent, 'Downloading hero.artwork…', 'switching tabs keeps the running status');
  app.element('tab-insert').dispatch('click');
  app.element('env-staging').dispatch('click');
  assert.equal(app.element('env-staging').getAttribute('aria-checked'), 'true');
  app.element('env-draft').dispatch('click');
  app.console.gates.rendition.resolve();
  await settle();
  assert.equal(app.frames.length, 1, 'the insert finishes with what it downloaded');
  for (const id of ['insert', 'connect']) assert.equal(off(app, id), false, id);

  // While a list loads, nothing is unavailable for it.
  app.console.gates.artwork = deferred();
  app.element('insert-refresh').dispatch('click');
  await settle();
  assert.equal(app.element('insert-list').getAttribute('aria-busy'), 'true');
  assert.equal(off(app, 'send'), false);
  assert.equal(off(app, 'connect'), false);
  app.console.gates.artwork.resolve();
  await settle();
  assert.equal(app.element('insert-list').getAttribute('aria-busy'), null);
});

test('focus survives rebuilt rows, Refresh, Load more, and a hidden control', async () => {
  const entries = Array.from({ length: 30 }, (_, index) => libraryAsset(index, `Tile ${index}`, 400, 200));
  const app = harness({ console: library(entries) });
  await openInsert(app);
  const row = rowFor(app, placement.key);
  row.focus();
  app.element('env-staging').dispatch('click');
  assert.notEqual(rowFor(app, placement.key), row, 'the rows were rebuilt');
  assert.equal(app.activeElement(), rowFor(app, placement.key), 'focus moves to the rebuilt row');

  app.element('insert-refresh').focus();
  app.element('insert-refresh').dispatch('click');
  await settle();
  assert.equal(app.activeElement(), app.element('insert-refresh'));

  app.element('browse-images').dispatch('click');
  await settle();
  app.element('images-more').focus();
  app.element('images-more').dispatch('click');
  await settle();
  assert.equal(app.element('images-more').hidden, true, 'the last page');
  assert.equal(app.activeElement(), tilesOf(app)[24], 'focus moves to the first new image');

  app.element('insert-search').value = 'nothing';
  app.element('insert-search').dispatch('input');
  app.fireTimers(300);
  await settle();
  app.element('insert-clear').focus();
  app.element('insert-clear').dispatch('click');
  await settle();
  assert.equal(app.activeElement(), app.element('insert-search'), 'a control that hides hands focus to the search field');
});

test('an error never takes focus from a field the person is typing in, nor scrolls it out of view', async () => {
  // A token pasted while the Insert list loads: the load fails, and the field keeps focus and every character.
  const app = harness({ console: { statuses: { artwork: 500 } } });
  await settle();
  app.element('token').focus();
  app.element('token').value = 'draft_typed_while_loading';
  app.element('tab-insert').dispatch('click');
  await settle();
  assert.equal(app.element('insert-empty').hidden, false, 'the failure is shown in place of the list');
  assert.equal(app.element('alert').textContent, 'Assetlib had a problem (500). Try again in a minute.', 'and announced by the alert region');
  assert.equal(app.activeElement(), app.element('token'));
  assert.equal(app.element('token').value, 'draft_typed_while_loading');

  // A file link refused by main: the error shows, and the person can correct the link where they typed it.
  const linking = harness({ fileKey: null });
  await settle();
  linking.element('file-url').focus();
  linking.element('file-url').value = 'https://example.com/not-figma';
  linking.element('file-form').dispatch('submit');
  await settle();
  assert.equal(linking.element('error').hidden, false);
  assert.equal(linking.activeElement(), linking.element('file-url'));

  // An error that hides while it has focus hands focus to a control, not the page.
  const inserting = harness({ console: { statuses: { rendition: 404 } } });
  await openInsert(inserting);
  rowFor(inserting, placement.key).dispatch('click');
  inserting.element('insert').focus();
  inserting.element('insert').dispatch('click');
  await settle();
  assert.equal(inserting.activeElement(), inserting.element('error'), 'a pressed button gives focus to its error');
  rowFor(inserting, placement.key).dispatch('click');
  await settle();
  assert.equal(inserting.element('error').hidden, true);
  assert.equal(inserting.activeElement(), inserting.element('insert-search'));
});

test('closing the connection settings moves focus to their summary, and a token typed meanwhile keeps them open', async () => {
  // Connect from the token field: the test passes, the settings close, and focus moves to their summary.
  const app = harness();
  await settle();
  assert.equal(app.element('settings').open, false, 'the opening test passed');
  app.element('settings').open = true;
  app.element('token').focus();
  app.saveConnection({ ...connection, token: tok('draft_b') });
  await settle();
  // Without names from the console, the toast never shows two raw IDs.
  assert.equal(app.element('status').textContent, 'Connected to Assetlib. 1 placement available.');
  assert.deepEqual(app.notices, ['Connected to Assetlib'], 'a toast says so');
  assert.equal(app.element('settings').open, false);
  assert.equal(app.activeElement(), app.element('settings-summary'), 'not the page');

  // Connect pressed while the opening test runs does nothing; when the test passes, focus moves out the same way.
  const pressed = harness({ console: { gates: { placements: deferred() } } });
  await settle();
  pressed.element('settings').open = true;
  pressed.element('connect').focus();
  pressed.element('connection-form').dispatch('submit');
  pressed.console.gates.placements.resolve();
  await settle();
  assert.equal(pressed.uiMessages.filter(message => message.type === 'save-connection').length, 0);
  assert.equal(pressed.element('settings').open, false);
  assert.equal(pressed.activeElement(), pressed.element('settings-summary'));

  // A token typed while the opening test runs (the fields stay live) keeps the settings open and focus in the field.
  const typing = harness({ console: { gates: { placements: deferred() } } });
  await settle();
  typing.element('settings').open = true;
  typing.element('token').focus();
  typing.element('token').value = 'draft_new';
  typing.console.gates.placements.resolve();
  await settle();
  assert.equal(typing.element('connection-label').textContent, 'Connected');
  assert.equal(typing.element('settings').open, true);
  assert.equal(typing.activeElement(), typing.element('token'));
  assert.equal(typing.element('token').value, 'draft_new');

  // Spaces alone in the token field are not a typed token, so the settings close.
  const spaces = harness({ console: { gates: { placements: deferred() } } });
  await settle();
  spaces.element('settings').open = true;
  spaces.element('token').value = '   ';
  spaces.element('connect').focus();
  spaces.console.gates.placements.resolve();
  await settle();
  assert.equal(spaces.element('settings').open, false);
  assert.equal(spaces.activeElement(), spaces.element('settings-summary'));

  // A read that recovers from a failure leaves settings the person opened (Update token) open.
  const recovered = harness({ console: { statuses: { artwork: 401 } } });
  await openInsert(recovered);
  assert.equal(recovered.element('settings').open, false);
  recovered.element('insert-token').dispatch('click');
  assert.equal(recovered.element('settings').open, true);
  recovered.element('connect').focus();
  delete recovered.console.statuses.artwork;
  recovered.element('insert-refresh').dispatch('click');
  await settle();
  assert.equal(recovered.element('settings').open, true);
  assert.equal(recovered.element('connection-error').hidden, true, 'the reason under the token field goes');
  assert.equal(recovered.activeElement(), recovered.element('connect'));
});

test('a failed connection test never takes focus from a field the person is in', async () => {
  // The opening test is refused while a search is typed: the search keeps focus and every character and stays in
  // view, the token field is marked, and the error's alert role announces it.
  const searching = harness({ console: { statuses: { placements: 401 }, gates: { placements: deferred() } } });
  await settle();
  searching.element('tab-insert').dispatch('click');
  searching.element('insert-search').focus();
  searching.element('insert-search').value = 'ho';
  searching.console.gates.placements.resolve();
  await settle();
  assert.equal(searching.element('connection-error').hidden, false);
  assert.equal(searching.element('connection-label').textContent, 'Needs attention');
  assert.equal(searching.element('token').getAttribute('aria-invalid'), 'true');
  assert.equal(searching.element('settings').open, false, 'nothing opens and pushes the field away');
  assert.equal(searching.element('insert-empty').hidden, false, 'the list says why');
  assert.equal(searching.element('alert').textContent, 'Assetlib no longer accepts this token. Paste a new one.');
  assert.equal(searching.activeElement(), searching.element('insert-search'));
  assert.equal(searching.element('insert-search').value, 'ho');
  assert.equal(searching.element('token').value, '', 'nothing typed reaches the token field');

  // A file link typed on Send while the opening test is refused for its scope.
  const linking = harness({ fileKey: null, console: { statuses: { placements: 403 }, gates: { placements: deferred() } } });
  await settle();
  linking.element('file-url').focus();
  linking.element('file-url').value = 'https://www.fig';
  linking.console.gates.placements.resolve();
  await settle();
  assert.equal(linking.element('connection-error').hidden, false);
  assert.equal(linking.element('token').getAttribute('aria-invalid'), 'true');
  assert.equal(linking.activeElement(), linking.element('file-url'));
  assert.equal(linking.element('file-url').value, 'https://www.fig');

  // A field in the settings themselves keeps focus too: the token is marked, not focused.
  const editing = harness({ console: { statuses: { placements: 401 }, gates: { placements: deferred() } } });
  await settle();
  editing.element('settings').open = true;
  editing.element('org-id').focus();
  editing.console.gates.placements.resolve();
  await settle();
  assert.equal(editing.element('token').getAttribute('aria-invalid'), 'true');
  assert.equal(editing.activeElement(), editing.element('org-id'));

  // Focus on a button rather than a field moves to where the failure is said: the Send form, or, with the settings
  // open, the refused token field.
  const pressing = harness({ console: { statuses: { placements: 401 }, gates: { placements: deferred() } } });
  await settle();
  pressing.element('tab-insert').focus();
  pressing.console.gates.placements.resolve();
  await settle();
  assert.equal(pressing.activeElement(), pressing.element('send-problem'));
  const open = harness({ console: { statuses: { placements: 401 }, gates: { placements: deferred() } } });
  await settle();
  open.element('settings').open = true;
  open.element('connect').focus();
  open.console.gates.placements.resolve();
  await settle();
  assert.equal(open.activeElement(), open.element('token'));
  assert.equal(open.element('send-problem').hidden, true, 'the settings say it, so the form does not');
});

test('a passing connection test leaves the settings open while the person works in them', async () => {
  // An organization ID field focused while the opening test runs: the settings stay open and keep focus there.
  const editing = harness({ console: { gates: { placements: deferred() } } });
  await settle();
  editing.element('settings').open = true;
  editing.element('org-id').focus();
  editing.console.gates.placements.resolve();
  await settle();
  assert.equal(editing.element('status').textContent, 'Connected. 1 placement available.');
  assert.equal(editing.element('connection-label').textContent, 'Connected');
  assert.equal(editing.element('settings').open, true);
  assert.equal(editing.activeElement(), editing.element('org-id'));

  // An entry that differs from the saved connection keeps them open after focus has left them.
  const changed = harness({ console: { gates: { placements: deferred() } } });
  await settle();
  changed.element('settings').open = true;
  changed.element('app-id').value = 'app-b';
  changed.element('insert-search').focus();
  changed.console.gates.placements.resolve();
  await settle();
  assert.equal(changed.element('settings').open, true);
  assert.equal(changed.element('app-id').value, 'app-b');
  assert.equal(changed.activeElement(), changed.element('insert-search'));

  // The field a new connection was submitted from is not work in progress: the settings close once its test passes.
  const submitted = harness();
  await settle();
  submitted.element('settings').open = true;
  submitted.element('org-id').focus();
  submitted.saveConnection({ ...connection, token: tok('draft_b') });
  await settle();
  assert.equal(submitted.element('settings').open, false);
  assert.equal(submitted.activeElement(), submitted.element('settings-summary'));

  // A read that recovers from a failure leaves the settings open while focus is in one of their fields.
  const recovered = harness({ console: { statuses: { artwork: 401 } } });
  await openInsert(recovered);
  recovered.element('insert-token').dispatch('click');
  assert.equal(recovered.element('settings').open, true);
  recovered.element('org-id').focus();
  delete recovered.console.statuses.artwork;
  recovered.element('insert-refresh').dispatch('click');
  await settle();
  assert.equal(recovered.element('connection-label').textContent, 'Connected');
  assert.equal(recovered.element('settings').open, true);
  assert.equal(recovered.activeElement(), recovered.element('org-id'));
});

test('a click on an unavailable Send or Sync does nothing, as on a disabled button', async () => {
  // No placements, so Send is unavailable.
  const app = harness({ remembered: null, console: { placements: [] } });
  await settle();
  assert.equal(off(app, 'send'), true);
  app.element('send').dispatch('click');
  await settle();
  assert.deepEqual([app.exportMessages().length, app.element('error').hidden, app.element('status').textContent],
    [0, true, 'Connected. No placements yet. Placements come from your app’s code.']);

  // The remembered placement is gone from the app, so Sync shows but is unavailable.
  const gone = harness({ remembered: { ...rememberedA, placementKey: 'gone.key' } });
  await settle();
  assert.equal(gone.element('sync').hidden, false);
  assert.equal(off(gone, 'sync'), true);
  gone.element('sync').dispatch('click');
  await settle();
  assert.deepEqual([gone.exportMessages().length, gone.element('error').hidden], [0, true]);
  assert.match(gone.element('sync-note').textContent, /^The remembered placement or cell is unavailable\./, 'the note says why');
});

test('renders are coalesced into one animation frame', async () => {
  const app = harness({ manualFrames: true });
  await settle();
  app.runFrames();
  assert.equal(app.element('panel-send').hidden, false);
  app.element('tab-insert').dispatch('click');
  app.element('tab-send').dispatch('click');
  app.element('tab-insert').dispatch('click');
  assert.equal(app.pendingFrames(), 1, 'three changes ask for one frame');
  assert.equal(app.element('panel-insert').hidden, true, 'the page changes when the frame runs');
  app.runFrames();
  assert.equal(app.element('panel-insert').hidden, false);
  await settle();
  assert.equal(app.runFrames(), 1, 'the artwork that loaded meanwhile renders in one more');
  assert.ok(rowFor(app, placement.key));
});

test('actions that wait use aria-disabled, never the disabled attribute, so they keep focus', async () => {
  const html = await readFile(new URL('../src/ui.html', import.meta.url), 'utf8');
  for (const id of ['send', 'sync', 'insert', 'connect', 'match-ratio']) {
    const tag = new RegExp(`<button id="${id}"[^>]*>`).exec(html)?.[0];
    assert.ok(tag, id);
    assert.doesNotMatch(tag, /\sdisabled[\s>=]/, `${id} would ignore clicks even when ready`);
  }
  assert.match(html, /\.primary\[aria-disabled="true"\], \.primary:disabled \{ background: var\(--bg-disabled\); color: var\(--text-disabled\);/, 'an unavailable primary looks disabled');
  assert.match(html, /button\[aria-disabled="true"\]:not\(\.primary\), button:disabled:not\(\.primary\)/, 'and so does any other unavailable action');
});

test('the fake Figma API records what later steps will check', async () => {
  const app = harness({ command: 'sync' });
  await settle();
  const { figma } = app;
  assert.equal(figma.command, 'sync');
  figma.notify('Filled 3 layers', { button: { text: 'Undo', action() {} } });
  assert.equal(app.notices.at(-1), 'Filled 3 layers');
  assert.equal(app.notifications.at(-1).options.button.text, 'Undo');
  figma.triggerUndo();
  figma.openExternal('https://console.assetlib.dev/w/org/app');
  figma.ui.resize(400, 600);
  assert.deepEqual([app.undoTriggers.length, app.externalUrls, app.uiResizes], [1, ['https://console.assetlib.dev/w/org/app'], [{ width: 400, height: 600 }]]);
  figma.root.setPluginData('assetlib.file.v1', '{"v":1}');
  assert.equal(figma.root.getPluginData('assetlib.file.v1'), '{"v":1}');
  const [selected] = figma.currentPage.selection;
  selected.setPluginData(LINK_KEY, '{"v":1}');
  selected.setRelaunchData({ sync: 'hero.artwork' });
  figma.root.setRelaunchData({ open: 'Insert and sync' });
  assert.deepEqual(app.relaunches, [{ id: node.id, data: { sync: 'hero.artwork' } }, { id: '0:0', data: { open: 'Insert and sync' } }]);
  const frame = figma.createFrame();
  assert.deepEqual(figma.currentPage.findAllWithCriteria({ types: ['FRAME'], pluginData: { keys: [LINK_KEY] } }).map(item => item.id), [node.id]);
  assert.equal(figma.currentPage.findAllWithCriteria({ types: ['FRAME'] }).length, 2, `${frame.id} is on the page too`);
  figma.on('drop', event => (event.dropMetadata?.assetlib ? false : undefined));
  assert.equal(app.drop({ dropMetadata: { assetlib: 1 } }), false);
  assert.equal(app.drop({ files: [] }), undefined);
});

// ---- A.3: first run, token-only connect, Disconnect, toasts, and the Send result ----
test('a pasted token is all the form needs: GET /api/token names its app, and the names label the connection', async () => {
  const app = harness({ saved: null, console: { identity: { orgId: 'org-one', appId: 'app-a', workspaceName: 'Sample workspace', appName: 'Sample app', scopes: ['draft'] } } });
  await settle();
  assert.equal(app.element('app').getAttribute('data-view'), 'first-run');
  assert.equal(app.element('id-fields').hidden, true);
  app.element('token').value = connection.token;
  app.element('connection-form').dispatch('submit');
  assert.equal(app.element('connect').textContent, 'Connecting…');
  assert.equal(off(app, 'connect'), true, 'Connect waits while the token is identified');
  await settle();
  const [identify] = app.requests;
  assert.deepEqual(identify, { url: `${connection.origin}/api/token`, method: 'GET', authorization: `Bearer ${connection.token}`, credentials: 'omit',
    redirect: 'error', body: null, route: 'token' }, 'the token only as a bearer header, never in the URL');
  const saved = { ...connection, workspaceName: 'Sample workspace', appName: 'Sample app' };
  assert.deepEqual(app.storage.get('assetlib.connection.v1'), saved, 'the names are saved with the connection');
  assert.equal(app.element('app').getAttribute('data-view'), 'shell');
  assert.equal(app.element('account-title').textContent, 'Sample workspace · Sample app');
  assert.equal(app.element('token-prefix').textContent, `Connected with token ${connection.token.slice(0, 8)}…`);
  assert.equal(app.element('open-console').href, `${connection.origin}/w/org-one/app-a/overview`);
  assert.equal(app.element('settings').open, false, 'the test passed, so the settings close');
  assert.deepEqual(app.notices, ['Connected to Sample workspace · Sample app']);
  assert.equal(app.element('status').textContent, 'Connected to Sample workspace · Sample app. 1 placement available.');

  // A blank token tests the saved connection again; on another console it asks for one.
  app.saveConnection({ ...saved, token: '' });
  await settle();
  assert.equal(app.requests.filter(request => request.route === 'token').length, 1, 'no second identity request');
  assert.equal(app.element('connection-error').hidden, true);
  app.element('origin').value = 'http://localhost:3100';
  app.element('connection-form').dispatch('submit');
  await settle();
  assert.equal(app.element('connection-error').textContent, 'Paste a Draft token from Settings › Tokens in the Assetlib console.');
  assert.equal(app.activeElement(), app.element('token'));
});

test('GET /api/token: a refused, revoked, or declare-only token is the token field’s error; an older console asks for the IDs', async () => {
  for (const [description, consoleState, expected, field] of [
    ['401', { statuses: { token: 401 } }, 'Assetlib didn’t accept this token. It may have been revoked. Create a new one in Settings › Tokens.', 'token'],
    ['a revoked token (403)', { statuses: { token: 403 } }, 'Assetlib didn’t accept this token. It may have been revoked. Create a new one in Settings › Tokens.', 'token'],
    ['a declare token', { identity: { orgId: 'org-one', appId: 'app-a', workspaceName: null, appName: null, scopes: ['declare'] } }, 'This token can’t send drafts. Create a token with Draft permission.', 'token'],
    ['404', { statuses: { token: 404 } }, 'This console also needs the organization and app IDs. Find them in Settings › General.', 'org-id'],
    ['no CORS headers', { failures: new Set(['token']) }, 'This console also needs the organization and app IDs. Find them in Settings › General.', 'org-id'],
    ['a server error', { statuses: { token: 500 } }, 'Assetlib had a problem (500). Try again in a minute.', null],
  ]) {
    const app = harness({ saved: null, console: consoleState });
    await settle();
    app.element('token').value = connection.token;
    app.element('connection-form').dispatch('submit');
    await settle();
    assert.equal(app.element('connection-error').textContent, expected, description);
    if (field === 'org-id') {
      // An older console's IDs are the next step, not a mistake: a neutral notice, said politely, and no field marked.
      assert.equal(app.element('connection-error').className, 'info', `${description}: a neutral notice`);
      assert.equal(app.element('status').textContent, expected, `${description}: announced`);
      assert.equal(app.element('alert').textContent, '', `${description}: not as an error`);
      for (const id of ['org-id', 'app-id', 'token']) assert.equal(app.element(id).getAttribute('aria-invalid'), null, `${description}: ${id} is not marked`);
    } else {
      assert.equal(app.element('connection-error').className, 'error', description);
      assert.equal(app.element('alert').textContent, expected, `${description}: announced`);
    }
    assert.equal(app.uiMessages.filter(message => message.type === 'save-connection').length, 0, description);
    assert.equal(app.element('token').value, connection.token, `${description}: the pasted token stays for another try`);
    assert.equal(off(app, 'connect'), false, description);
    assert.equal(app.activeElement(), field ? app.element(field) : null, description);
    assert.equal(app.element('id-fields').hidden, field !== 'org-id', description);
    if (field === 'org-id') {
      app.element('org-id').value = 'org-one';
      app.element('app-id').value = 'app-a';
      app.element('connection-form').dispatch('submit');
      await settle();
      assert.deepEqual(app.storage.get('assetlib.connection.v1'), connection, `${description}: saved with the IDs from the form`);
      assert.equal(app.requests.filter(request => request.route === 'token').length, 1, `${description}: GET /api/token is not asked again`);
      assert.equal(app.element('status').textContent, 'Connected to Assetlib. 1 placement available.');
      assert.equal(textOf(app.element('account-name')), 'App app-a', 'without names, the chip names the app by its ID');
      assert.equal(app.element('account-title').textContent, 'App app-a', 'and so does the panel, never two raw IDs');
      assert.equal(app.element('account-title').title, 'Organization org-one · App app-a', 'both IDs in full on hover');
    }
  }
});

test('an older console’s ID fields belong to that console, and Disconnect forgets them', async () => {
  const tokenReads = app => app.requests.filter(request => request.route === 'token').map(request => request.url);
  // Production answers GET /api/token with 404: the IDs show, and the connection is made with them.
  const app = harness({ saved: null, console: { statuses: { token: 404 } } });
  await settle();
  app.element('token').value = connection.token;
  app.element('connection-form').dispatch('submit');
  await settle();
  assert.equal(app.element('id-fields').hidden, false);
  app.element('org-id').value = connection.orgId;
  app.element('app-id').value = connection.appId;
  app.element('connection-form').dispatch('submit');
  await settle();
  assert.equal(app.element('app').getAttribute('data-view'), 'shell');
  // Disconnect: the first run asks for a token alone again, and a pasted token is identified with GET /api/token.
  app.element('settings').open = true;
  app.element('disconnect').dispatch('click');
  await settle();
  assert.equal(app.element('app').getAttribute('data-view'), 'first-run');
  assert.equal(app.element('id-fields').hidden, true, 'no unexplained ID fields on the first run');
  delete app.console.statuses.token;
  app.saveConnection({ ...connection, token: tok('after_disconnect') });
  await settle();
  assert.deepEqual(tokenReads(app), [`${connection.origin}/api/token`, `${connection.origin}/api/token`], 'identified again');
  assert.equal(app.element('app').getAttribute('data-view'), 'shell');
  assert.equal(app.element('id-fields').hidden, true);

  // Another console: the IDs and the answer about the first one go, and a pasted token is identified on the new one.
  const switching = harness({ saved: null, console: { statuses: { token: 404 } } });
  await settle();
  switching.element('token').value = connection.token;
  switching.element('connection-form').dispatch('submit');
  await settle();
  assert.equal(switching.element('id-fields').hidden, false);
  switching.element('origin').value = 'http://localhost:3100';
  switching.element('origin').dispatch('change');
  assert.equal(switching.element('id-fields').hidden, true);
  assert.equal(switching.element('connection-error').hidden, true, 'the answer about the other console goes');
  // Back on the console that answered 404, its ID fields return.
  switching.element('origin').value = connection.origin;
  switching.element('origin').dispatch('change');
  assert.equal(switching.element('id-fields').hidden, false);
  switching.element('origin').value = 'http://localhost:3100';
  switching.element('origin').dispatch('change');
  delete switching.console.statuses.token;
  switching.element('token').value = tok('local');
  switching.saveConnection({ ...connection, origin: 'http://localhost:3100', token: tok('local') });
  await settle();
  assert.deepEqual(tokenReads(switching), [`${connection.origin}/api/token`, 'http://localhost:3100/api/token']);
  assert.equal(switching.element('connection-error').textContent, '', 'no request for IDs');
  assert.deepEqual(switching.storage.get('assetlib.connection.v1'), { ...connection, origin: 'http://localhost:3100', token: tok('local') });
});

test('Disconnect forgets the connection on this device and shows the first run; the token keeps working elsewhere', async () => {
  const app = harness();
  await settle();
  app.element('settings').open = true;
  app.element('disconnect').focus();
  app.element('disconnect').dispatch('click');
  await settle();
  assert.deepEqual(app.uiMessages.filter(message => message.type === 'clear-connection').map(message => typeof message.requestId), ['number']);
  assert.equal(app.storage.has('assetlib.connection.v1'), false);
  assert.equal(app.element('app').getAttribute('data-view'), 'first-run');
  assert.equal(app.element('settings').open, true, 'the first-run screen is the form');
  assert.deepEqual(app.notices, ['Disconnected. The token still works elsewhere until an owner revokes it.']);
  assert.equal(app.element('status').textContent, 'Disconnected. The token still works elsewhere until an owner revokes it.');
  assert.equal(app.activeElement(), app.element('token'), 'focus moves to the token field, never the page');
  assert.equal(app.mainMessages.filter(message => message.type === 'connection').at(-1).connectionGeneration, 1);
  assert.deepEqual([app.element('org-id').value, app.element('app-id').value], ['', '']);

  // Disconnect waits for a running operation, and a storage failure keeps the connection and says why.
  const busy = harness({ console: { gates: { drafts: deferred() } } });
  await settle();
  busy.element('send').dispatch('click');
  await settle();
  assert.equal(off(busy, 'disconnect'), true);
  busy.element('disconnect').dispatch('click');
  assert.equal(busy.uiMessages.filter(message => message.type === 'clear-connection').length, 0);
  const failing = harness({ failingWrites: ['assetlib.connection.v1'] });
  await settle();
  failing.element('disconnect').dispatch('click');
  await settle();
  assert.equal(failing.element('connection-error').textContent, 'Figma couldn’t save this on your device. Try again.');
  assert.equal(failing.element('app').getAttribute('data-view'), 'shell');
  assert.deepEqual(failing.storage.get('assetlib.connection.v1'), connection);
  assert.equal(off(failing, 'disconnect'), false, 'it can be tried again');
});

test('main shows a toast of at most 100 characters and opens only a console link for the connected app', async () => {
  const app = harness();
  await settle();
  app.postToMain({ type: 'notify', text: `Inserted ${'x'.repeat(150)}` });
  app.postToMain({ type: 'notify', text: 'Sent to hero.artwork draft', button: { text: 'Review', url: `${connection.origin}/w/org-one/app-a/releases` } });
  app.postToMain({ type: 'notify', text: 'Phishing', button: { text: 'Review', url: 'https://evil.test/w/org-one/app-a/releases' } });
  app.postToMain({ type: 'notify', text: 'Other app', button: { text: 'Review', url: `${connection.origin}/w/org-one/app-z/releases` } });
  await settle();
  assert.equal(Array.from(app.notifications[0].message).length, 100);
  assert.ok(app.notifications[0].message.endsWith('…'));
  assert.equal(app.notifications[1].options.button.text, 'Review');
  app.notifications[1].options.button.action();
  assert.deepEqual(app.externalUrls, [`${connection.origin}/w/org-one/app-a/releases`]);
  assert.deepEqual(app.notifications.slice(2).map(item => [item.message, item.options]), [['Phishing', undefined], ['Other app', undefined]],
    'a link elsewhere is dropped; the words still show');
  assert.equal(app.mainMessages.filter(message => message.type === 'error').length, 0, 'a toast is never refused');
});

test('Send: the result says what happened inline, a toast says where it went, and a 409 keeps the console’s words', async () => {
  const app = harness({ remembered: null });
  await settle();
  pick(app, 'placement', placement.key);
  app.element('send').dispatch('click');
  assert.equal(app.element('send').textContent, 'Sending…');
  await settle();
  assert.equal(app.element('send').textContent, 'Send to draft');
  const result = app.element('result');
  assert.equal(result.hidden, false);
  assert.deepEqual(result.children.map(child => child.textContent), ['Draft updated. Publish it from the console when it’s ready.', 'View in console']);
  assert.equal(result.children[1].href, `${connection.origin}/w/org-one/app-a/releases`);
  assert.deepEqual(app.notices, ['Sent to hero.artwork draft']);
  assert.equal(app.element('status').textContent, 'Sent to hero.artwork draft');

  // A Sync that also rebound other cells says how many, with the cells under Details.
  const synced = harness({ console: { draft: body => ({ asset: { id: uuid(77), name: body.name, width: 1000, height: 1000, sha256: 'a'.repeat(64), renditions: 1 },
    previous: null, bound: body.bind, bindError: null, rebound: [body.bind, { ...body.bind, state: 'new' }, { ...body.bind, arm: 'c' }] }) } });
  await settle();
  synced.element('sync').dispatch('click');
  await settle();
  const parts = synced.element('result').children;
  assert.equal(parts[2].textContent, 'Also updated 2 other draft cells that used this layer’s earlier art.');
  assert.deepEqual(descendants(parts[3]).filter(item => item.tag === 'li').map(item => item.textContent),
    ['hero.artwork · b · Light · new', 'hero.artwork · c · Light · old']);
  assert.deepEqual(synced.notices, ['Synced hero.artwork to draft']);

  // HTTP 409: the image exists but is not in the cell; no success toast, and a link to the image.
  const partial = harness({ console: { draft: body => ({ asset: { id: uuid(78), name: body.name, width: 1000, height: 1000, sha256: 'a'.repeat(64), renditions: 1 },
    previous: null, bound: null, bindError: 'This arm is not declared by the placement', rebound: [] }) } });
  await settle();
  partial.element('sync').dispatch('click');
  await settle();
  const notice = partial.element('result').children;
  assert.equal(notice[0].className, 'notice');
  assert.equal(notice[0].textContent, 'The image was uploaded, but Assetlib couldn’t put it in hero.artwork: This arm is not declared by the placement. Check the console before sending again.');
  assert.deepEqual([notice[1].textContent, notice[1].href], ['Open image in console', `${connection.origin}/w/org-one/app-a/images/${uuid(78)}`]);
  assert.deepEqual(partial.notices, [], 'no success toast');
  assert.equal(partial.element('status').textContent, notice[0].textContent, 'the status region repeats the result');
});

test('the Send tab shows the layer as a designer reads it, and the export as a PNG size', async () => {
  const app = harness({ selection: [{ ...node, width: 390.4, height: 389.6 }], remembered: null });
  await settle();
  assert.equal(app.element('selection-name').textContent, 'Hero artwork');
  assert.equal(app.element('selection-meta').textContent, '390 × 390', 'whole pixels, no node ID or type');
  pick(app, 'placement', placement.key);
  assert.equal(app.element('export-note').textContent, 'Exports 1000 × 998 PNG');
  assert.deepEqual(app.element('appearance').children.map(option => option.textContent), ['Any', 'Light', 'Dark']);
  app.select([]);
  await settle();
  assert.equal(app.element('selection-name').textContent, 'Select a frame or layer to send.');
  assert.equal(app.element('selection-meta').textContent, '');
  const nodes = [...app.figma.currentPage.children];
  app.select([nodes[0], { ...nodes[0], id: '9:9' }]);
  await settle();
  assert.equal(app.element('selection-name').textContent, 'Select one layer. Sending several at once isn’t supported yet.');
});

test('previews of list rows load as they near the list’s view; the footer’s loads whenever it shows', async () => {
  const entries = Array.from({ length: 3 }, (_, index) => libraryAsset(120 + index, `Far ${index}`, 400, 200));
  const app = harness({ console: library(entries) });
  await openInsert(app);
  app.setVisible(() => false);
  app.element('browse-images').dispatch('click');
  await settle();
  const previews = previewLog(app, entries);
  assert.deepEqual(previews(), [], 'nothing near the view, nothing loads');
  tilesOf(app)[2].dispatch('click');
  await settle();
  assert.deepEqual(previews(), [2], 'the chosen image shows in the footer, outside the list, so its preview loads');
  assert.ok(app.element('insert-thumb').src.startsWith('data:image/webp'));
});
