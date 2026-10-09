import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { bundlePlugin, clone, createHarness, deferred, descendants, fakeConsole, flush, pngHeader, textOf } from './fakes.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const sources = await bundlePlugin(root);

const connection = { origin: 'https://console.assetlib.dev', orgId: 'org-one', appId: 'app-a', token: 'draft_a' };
// Connections saved before the console moved to console.assetlib.dev name its earlier host.
const legacyConnection = { ...connection, origin: 'https://assetlib-console.vercel.app' };
const placement = { key: 'hero.artwork', screen: 'Home', width: 1000, height: 1000,
  states: ['old', 'new'], defaultState: 'old', variants: { appearance: ['light', 'dark'], arm: ['b', 'c'] }, origin: 'declared' };
const node = { id: '12:34', name: 'Hero artwork', type: 'FRAME', width: 1000, height: 1000 };
const rememberedA = { fileKey: 'abc123', nodeId: node.id, placementKey: placement.key, state: 'old', appearance: 'light', arm: 'b' };
const rememberedB = { ...rememberedA, state: 'new', appearance: 'dark', arm: 'c' };
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

function harness({ remembered = rememberedA, bytes = pngHeader(1000, 1000), saved = connection, storage = [], console: state = {}, ...options } = {}) {
  const consoleState = { placements: [clone(placement)], artwork: artwork(), library: [], renditions: renditionsServed(), ...state };
  const app = createHarness({
    ...sources, fetch: fakeConsole(consoleState), exportBytes: () => bytes, selection: [node],
    storage: [...(saved ? [['assetlib.connection.v1', saved], [storageKey(saved), remembered]] : []), ...storage],
    ...options,
  });
  return { ...app, console: consoleState };
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

// ---- Insert ----
const LINK_KEY = 'assetlib.link.v1';
const settle = async () => { for (let i = 0; i < 12; i++) await flush(); };
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

test('a placement cell inserts as a linked image frame, centered and selected, with Sync ready', async () => {
  const app = harness();
  const frame = await insertHeroCell(app);
  assert.deepEqual(app.requests.filter(request => request.route !== 'rendition').map(request => request.route), ['placements', 'artwork']);
  const downloads = app.requests.filter(request => request.url.endsWith(sha(11)));
  assert.equal(downloads.length, 1, 'the largest PNG within 4 MiB is fetched once');
  assert.deepEqual(downloads[0], { url: `${connection.origin}/api/apps/org-one/app-a/assets/${armArt}/renditions/${sha(11)}`, method: 'GET',
    authorization: 'Bearer draft_a', credentials: 'omit', redirect: 'error', body: null, route: 'rendition' });
  for (const skipped of [10, 12, 14]) assert.ok(!app.requests.some(request => request.url.endsWith(sha(skipped))), 'over the cap, a tied WebP, and SVG are not fetched');
  assert.ok(app.requests.every(request => !request.url.includes('draft_a')), 'the token is never in a URL');

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

  const insertedAt = app.mainMessages.findIndex(message => message.type === 'inserted');
  const selectionAt = app.mainMessages.findIndex((message, index) => index > insertedAt && message.type === 'selection');
  assert.ok(insertedAt >= 0 && selectionAt > insertedAt, 'inserted is posted, then the new selection');
  assert.equal(app.mainMessages[insertedAt].connectionGeneration, 0);
  assert.deepEqual(app.mainMessages[selectionAt].selection.remembered.insertedFrom, { environment: 'draft', assetId: armArt });
  assert.equal(app.element('sync').hidden, false);
  assert.equal(app.element('sync').disabled, false);
  assert.equal(app.element('sync').textContent, 'Sync to hero.artwork');
  assert.match(app.element('sync-note').textContent, /^hero\.artwork · b · light · old\. Inserted from Draft\. Sync sends this layer to that cell/);
  assert.equal(app.element('status').textContent, 'Inserted hero.artwork · b · light from Draft. Edit it, then use Sync on the Send tab.');
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
  assert.equal(app.element('status').textContent, 'Sync target saved. Review the draft in the console.');
});

test('Insert at @3x makes a third-size frame, and the viewport moves only when the frame is outside its bounds', async () => {
  const app = harness();
  await openInsert(app);
  pick(app, 'insert-scale', '3');
  assert.deepEqual(app.uiMessages.filter(message => message.type === 'save-preferences').at(-1).preferences,
    { tab: 'insert', browse: 'placements', environment: 'draft', scale: 3 });
  rowFor(app, placement.key).dispatch('click');
  assert.equal(app.element('insert-meta').textContent, 'Draft · Hero base · 1000 × 1000 → 333.33 × 333.33', 'the footer names the size in Figma');
  app.element('insert').dispatch('click');
  await settle();
  const small = app.frames[0];
  assert.deepEqual([small.width, small.height, small.x, small.y], [333.33, 333.33, 333, 133]);
  assert.equal(app.insertMessages()[0].scale, 3);
  assert.deepEqual(app.insertMessages()[0].frame, { width: 1000, height: 1000 }, 'the frame is always the placement size in pixels');
  assert.deepEqual(app.scrolls, [], 'a frame inside the viewport does not move it');
  pick(app, 'insert-scale', '1');
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
  const app = harness({ console: { artwork: { ...artwork(), environments: { staging: null, production: { sequence: 12, createdAt: '2026-10-09T08:00:00.000Z' } },
    placements: [{ ...placement, cells }, stateful, unset, differs, single('tasks.gone', cellArt(uuid(8), null, null), null),
      single('tasks.legacy', cellArt(legacyArt, null, null), null), single('tasks.added', cellArt(baseArt, null, null), null)],
    assets: { ...clone(assets), [legacyArt]: asset(legacyArt, 'Legacy', 1000, 1000, []) } } } });
  await openInsert(app);
  const tags = key => descendants(rowFor(app, key)).filter(item => item.className === 'tag').map(item => item.textContent);
  assert.deepEqual(tags(placement.key), []);
  assert.deepEqual(tags('travel.coast'), ['Not set']);
  assert.deepEqual(tags('travel.ridge'), ['Differs from production']);
  assert.deepEqual(tags('tasks.gone'), ['Unavailable'], 'the console did not return the image');
  assert.deepEqual(tags('tasks.legacy'), ['Re-upload needed'], 'an image without prepared versions');
  assert.deepEqual(tags('tasks.added'), ['Not in production'], 'production is published but has no art for it');
  const legacyThumb = descendants(rowFor(app, 'tasks.legacy')).find(item => item.tag === 'img');
  assert.equal(legacyThumb.getAttribute('data-sha'), '', 'marked as having no preview');
  assert.deepEqual(descendants(app.element('insert-list')).filter(item => item.className === 'group').map(item => item.textContent), ['Home', 'Tasks', 'Travel']);
  assert.equal(app.element('env-staging').disabled, true, 'nothing is published to staging');
  assert.equal(app.element('env-staging').title, 'Nothing is published to staging yet.');
  assert.equal(app.element('env-note').textContent.startsWith('Draft · '), true);

  rowFor(app, placement.key).dispatch('click');
  assert.equal(app.element('insert-state-label').hidden, false);
  assert.deepEqual(app.element('insert-state').children.map(option => option.textContent), ['old (default)', 'new']);
  assert.deepEqual(app.element('insert-arm').children.map(option => option.textContent), ['Control', 'b', 'c']);
  pick(app, 'insert-appearance', 'dark');
  pick(app, 'insert-arm', 'b');
  assert.equal(app.element('insert-meta').textContent, 'Draft · Hero base · 1000 × 1000 · Inherits Control · Any');
  assert.equal(app.element('insert-note').textContent, 'Linked. Sync on the Send tab gives this cell its own draft art; Control · Any stays unchanged.');
  assert.equal(app.element('insert').textContent, 'Insert hero.artwork · b · dark');

  rowFor(app, 'tasks.empty').dispatch('click');
  pick(app, 'insert-state', 'new');
  assert.equal(app.element('insert-note').textContent, 'Not set in Draft. Choose another cell or environment.');
  assert.equal(app.element('insert').disabled, true);
  rowFor(app, 'travel.coast').dispatch('click');
  assert.equal(app.element('insert-state-label').hidden, true, 'a single option hides its picker');
  app.element('env-production').dispatch('click');
  assert.match(app.element('env-note').textContent, /^Production · release 12 · Oct 9/);
  assert.deepEqual(tags('travel.coast'), [], 'production has art for it');
  assert.equal(app.element('insert-meta').textContent, 'Production · Hero arm b light · 1200 × 900');
  assert.equal(app.element('insert-note').textContent, 'Linked. Sync on the Send tab puts edits in this cell’s draft.', 'Sync writes draft, whatever the source');
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
  assert.equal(app.element('insert-empty-text').textContent, 'No placements match. Try another key or screen.');
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
  assert.deepEqual(calls, [{ type: 'image/webp', size: 30, options: { premultiplyAlpha: 'none', colorSpaceConversion: 'none' } }, 'closed']);
  assert.deepEqual(app.bitmaps, [{ width: 1000, height: 1000 }]);
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
  assert.equal(failing.element('error').textContent, 'Could not convert this WebP image to PNG for Figma. Try again, or download it from the console.');
  assert.equal(failing.insertMessages().length, 0);
  assert.equal(failing.element('insert').disabled, false, 'the insert can be retried');
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
  app.element('insert').dispatch('click');
  await settle();
  assert.equal(app.requests.length, before, 'no download is attempted');
  assert.equal(app.element('error').textContent, 'This image is larger than 4 MiB in every version, so it cannot be inserted here. Download it from the console.');

  tile('Legacy').dispatch('click');
  assert.equal(app.element('insert').disabled, true);
  assert.equal(app.element('insert-note').textContent, 'This image predates renditions. Upload it again in the console to use it in Figma.');

  for (const name of ['Wrong mime', 'Wrong length']) {
    tile(name).dispatch('click');
    app.element('insert').dispatch('click');
    await settle();
    assert.equal(app.element('error').textContent, 'The console returned an unexpected image. Refresh and try again.', name);
  }
  tile('Padded body').dispatch('click');
  app.element('insert').dispatch('click');
  await settle();
  assert.equal(app.element('error').textContent, 'The console returned an unexpected image. Refresh and try again.');
  assert.equal(padded.served[0].read, undefined, 'a body longer than the listed version is not read');
  tile('Gone').dispatch('click');
  app.element('insert').dispatch('click');
  await settle();
  assert.equal(app.element('error').textContent, 'This image is no longer available. Choose Refresh and pick it again.', 'not the older-console message');
  assert.equal(app.insertMessages().length, 0);
  assert.equal(app.frames.length, 0);
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
  app.postToMain({ type: 'save-connection', connection: { ...connection, appId: 'app-b', token: 'draft_b' } });
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
  assert.equal(app.element('insert-note').textContent, 'Not linked to a placement. Use Send to put edits in one.');
  app.element('insert').dispatch('click');
  await settle();
  const frame = app.frames[0];
  assert.deepEqual([frame.name, frame.width, frame.height], ['Coast 0', 400, 200]);
  assert.equal(frame.getPluginData(LINK_KEY), '', 'a library image carries no link');
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
  assert.equal(app.element('sync').disabled, false);
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
    'Inserted hero.artwork · b · light from Draft. Edit it, then use Sync on the Send tab. Confirm the file URL on the Send tab to enable Sync.');
  assert.equal(app.element('sync').hidden, false);
  assert.equal(app.element('sync').disabled, true);
  assert.equal(app.element('file-fallback').hidden, false);
  app.element('file-url').value = 'https://www.figma.com/design/abc123/Hero';
  app.element('file-form').dispatch('submit');
  await settle();
  assert.equal(app.element('sync').disabled, false);
  app.element('sync').dispatch('click');
  await settle();
  assert.deepEqual(app.drafts()[0].body.bind, { slotKey: placement.key, state: 'old', appearance: 'light', arm: 'b' });
  assert.equal(app.drafts()[0].body.source.fileKey, 'abc123');
});

test('Insert errors: a 403 explains the read scope, an older console explains itself, and Send still works', async () => {
  for (const [status, expected] of [
    [403, 'This token cannot read this app’s images. Use a token with the draft scope for this organization and app.'],
    [404, 'This console does not support Insert yet. Send still works if the connection test passed. Update the console, then choose Refresh.'],
    [401, 'The token was not accepted. Paste a current app-scoped draft token from the console Tokens panel.'],
    [429, 'The console is receiving too many requests. Wait a moment, then try again.'],
  ]) {
    const app = harness({ console: { statuses: { artwork: status } } });
    await openInsert(app);
    assert.equal(app.element('error').textContent, expected, `HTTP ${status}`);
    assert.equal(app.element('insert-empty-text').textContent, 'Could not load placements. Choose Refresh to try again.');
    assert.equal(app.element('connection-label').textContent, status === 401 ? '· needs attention' : '· connected');
  }

  const app = harness({ console: { failures: new Set(['artwork']) } });
  await openInsert(app);
  assert.equal(app.element('error').textContent,
    'This console does not support Insert yet, or https://console.assetlib.dev could not be reached. Send still works if the connection test passed. Update the console, then choose Refresh.');
  app.console.failures.clear();
  app.element('insert-refresh').dispatch('click');
  await settle();
  assert.equal(app.element('error').hidden, true, 'Refresh recovers once the console answers');
  assert.ok(rowFor(app, placement.key));
  app.element('tab-send').dispatch('click');
  app.element('send').dispatch('click');
  await settle();
  assert.equal(app.drafts().length, 1, 'Send is unaffected');

  const offline = harness({ console: { failures: new Set(['placements', 'artwork']) } });
  await openInsert(offline);
  assert.match(offline.element('error').textContent, /^Could not reach https:\/\/console\.assetlib\.dev\./, 'no placements read succeeded, so it is a plain network error');
});

test('preferences restore the tab, environment, and scale, changes are saved, and a storage failure is silent', async () => {
  const saved = { tab: 'insert', browse: 'placements', environment: 'staging', scale: 2 };
  const app = harness({ storage: [['assetlib.preferences.v1', saved]] });
  await settle();
  assert.equal(app.element('tab-insert').getAttribute('aria-selected'), 'true');
  assert.equal(app.element('panel-insert').hidden, false);
  assert.equal(app.element('panel-send').hidden, true);
  assert.equal(app.element('insert-scale').value, '2');
  assert.equal(app.element('env-staging').getAttribute('aria-checked'), 'true');
  assert.match(app.element('env-note').textContent, /^Staging · release 3 · Oct 8/);
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
  assert.equal(unpublished.element('env-note').textContent, 'Nothing is published to production yet.');

  const failing = harness({ failingWrites: ['assetlib.preferences.v1'] });
  await openInsert(failing);
  pick(failing, 'insert-scale', '3');
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
  assert.ok(previews.every(request => request.authorization === 'Bearer draft_a' && request.credentials === 'omit' && request.redirect === 'error'));
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

  const broken = harness({ console: { ...library(entries), statuses: { rendition: 500 } } });
  await openInsert(broken);
  broken.element('browse-images').dispatch('click');
  await settle();
  const failed = broken.requests.filter(request => request.route === 'rendition').length;
  assert.equal(broken.requests.filter(request => entries.some(entry => request.url.endsWith(entry.asset.renditions[1].sha256))).length, 6);
  broken.element('browse-placements').dispatch('click');
  broken.element('browse-images').dispatch('click');
  await settle();
  assert.equal(broken.requests.filter(request => request.route === 'rendition').length, failed, 'a failed preview is not fetched again for rebuilt tiles');
  assert.ok(tilesOf(broken).every(tile => !descendants(tile).find(item => item.tag === 'img').src), 'failed previews stay blank placeholders');
});

test('the Insert footer holds status and errors, hides with nothing to insert, and collapses until something is chosen', async () => {
  const parentOf = (app, id) => app.element(id).parentElement?.id;
  const app = harness();
  await settle();
  assert.equal(app.element('sync').className, 'primary', 'a remembered target makes Sync the primary action');
  assert.equal(app.element('send').className, '');
  await openInsert(app);
  assert.equal(app.element('insert-bar').hidden, false);
  assert.equal(app.element('insert-title').textContent, 'Choose a placement to insert.');
  for (const id of ['insert-preview', 'insert-meta', 'insert', 'insert-note']) assert.equal(app.element(id).hidden, true, `${id} waits for a choice`);
  assert.deepEqual([parentOf(app, 'status'), parentOf(app, 'error')], ['insert-messages', 'insert-messages'], 'messages sit in the sticky footer');

  app.element('insert-search').value = 'nothing';
  app.element('insert-search').dispatch('input');
  app.element('insert-clear').dispatch('click');
  rowFor(app, placement.key).dispatch('click');
  assert.deepEqual(clone(rowFor(app, placement.key).scrolledIntoView), { block: 'nearest' }, 'the chosen row is kept clear of the footer');
  for (const id of ['insert-preview', 'insert-meta', 'insert', 'insert-note']) assert.equal(app.element(id).hidden, false, id);
  // Main fails the insert after the download; its error lands in the footer.
  app.figma.createImage = () => { throw new Error('decode failed'); };
  app.element('insert').dispatch('click');
  await settle();
  assert.equal(app.element('error').hidden, false);
  assert.equal(app.element('error').textContent, 'Figma could not read this image. Refresh and try again.');
  assert.equal(parentOf(app, 'error'), 'insert-messages');
  rowFor(app, placement.key).dispatch('click');
  assert.equal(app.element('error').hidden, true, 'choosing again clears the old error');

  app.element('tab-send').dispatch('click');
  assert.deepEqual([parentOf(app, 'status'), parentOf(app, 'error')], ['messages', 'messages'], 'Send shows them after its panel');

  const failing = harness({ console: { statuses: { artwork: 403 } } });
  await openInsert(failing);
  assert.equal(failing.element('insert-bar').hidden, true, 'a failed list has nothing to insert');
  assert.notEqual(parentOf(failing, 'error'), 'insert-messages', 'the error stays after the short empty list (ui.html places it there)');
  const offline = harness({ saved: null });
  await settle();
  offline.element('tab-insert').dispatch('click');
  assert.equal(offline.element('insert-bar').hidden, true);
  assert.equal(offline.element('insert-empty-text').textContent, 'Connect to your app to browse its artwork.');

  const inserted = harness();
  await insertHeroCell(inserted);
  assert.match(inserted.element('status').textContent, /^Inserted hero\.artwork/);
  inserted.element('tab-send').dispatch('click');
  assert.equal(inserted.element('status').textContent, '', 'the Insert status does not follow to Send');
  assert.equal(inserted.element('sync').className, 'primary');
});

test('every element id the UI script reads exists in ui.html', async () => {
  const [html, script] = await Promise.all(['src/ui.html', 'src/ui.ts'].map(path => readFile(new URL(`../${path}`, import.meta.url), 'utf8')));
  const ids = new Set([...script.matchAll(/element(?:<[^>]+>)?\('([a-z-]+)'\)/g)].map(match => match[1]));
  for (const name of ['draft', 'staging', 'production']) ids.add(`env-${name}`);
  for (const id of ids) assert.match(html, new RegExp(`id="${id}"`), id);
  assert.equal(html.split('<!-- ASSETLIB_SCRIPT -->').length, 2);
});
