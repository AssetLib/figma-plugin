// Local end-to-end check against a running console. Not part of npm test.
//   npm run e2e:local -- --connection <file>     the token path
//   npm run e2e:local -- --pair --account <file>  one-click Connect
// It bundles src/code.ts and src/ui/main.ts as the tests do and runs them in node:vm with the fakes from tests/fakes.mjs,
// but every HTTP call is Node's real fetch to the console. It needs no real Figma, so WebP-only images are skipped.
// The connection file holds {"origin":"http://localhost:3100","orgId":…,"appId":…,"token":…} with a draft token; the
// account file holds {"email":…,"password":…} for a local owner or editor. Keep both outside the repositories with mode
// 600. No token or key is ever printed. The token run starts on the first-run screen and connects with the token alone
// (GET /api/token); the IDs in the file check what the console answered. The --pair run connects with Connect to
// Assetlib, approving in the console's session routes as the browser page would.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { bundlePlugin, createHarness, dataTransfer, descendants, pngSizeOf, textOf, waitFor } from '../tests/fakes.mjs';

const ORIGIN = 'http://localhost:3100';
// The development console's sign-in, connect page, and session routes are on 127.0.0.1 only.
const PAGE_ORIGIN = 'http://127.0.0.1:3100';
const PLACEMENT = 'travel.coast';
const FILE_URL = 'https://www.figma.com/design/AssetlibPluginE2E/assetlib-plugin-local-e2e';
const MAX_INSERT_DOWNLOAD = 4 * 1024 * 1024;

const pairMode = process.argv.includes('--pair');
const flag = process.argv.indexOf(pairMode ? '--account' : '--connection');
const file = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!file) {
  console.error('Usage: npm run e2e:local -- --connection <file>\n       npm run e2e:local -- --pair --account <file>');
  process.exit(2);
}
const input = JSON.parse(await readFile(file, 'utf8'));
// What the plugin may send, and what never appears in a URL, log line, notice, layer, or UI text: the token, and with
// --pair the request's read and write keys.
const keys = { token: pairMode ? null : input.token, readKey: null, writeKey: null };
const secrets = () => [keys.token, keys.readKey, keys.writeKey, pairMode ? input.password : null].filter(Boolean);
const redact = value => secrets().reduce((text, secret) => text.split(secret).join('<secret>'), String(value));
const log = line => console.log(redact(line));
if (pairMode) {
  if (typeof input.email !== 'string' || !input.email.includes('@') || typeof input.password !== 'string' || !input.password) {
    console.error('The account file must hold {"email":…,"password":…} for a local owner or editor.');
    process.exit(2);
  }
} else if (input.origin !== ORIGIN || !/^[A-Za-z0-9_-]{1,128}$/.test(input.orgId ?? '') || !/^[A-Za-z0-9_-]{1,128}$/.test(input.appId ?? '')
  || typeof keys.token !== 'string' || keys.token.length < 8 || /\s/.test(keys.token)) {
  console.error(`The connection file must hold {"origin":"${ORIGIN}","orgId":…,"appId":…,"token":…}.`);
  process.exit(2);
}
if ((await stat(file)).mode & 0o077) log(`warning: ${file} is readable by other users; chmod 600 it.`);
const connection = pairMode ? null : input;
// The app's routes: known from the file, or once a --pair claim names the app.
let base = connection ? `${ORIGIN}/api/apps/${connection.orgId}/${connection.appId}/` : null;

let checks = 0;
function ok(line) { checks += 1; log(`ok ${checks} - ${line}`); }

// Every request the plugin makes goes through this wrapper around Node's fetch. Starting a request sends no
// Authorization; a claim or cancel sends the read key the start answered with; every other route sends the token.
const violations = [];
const identityUrl = `${ORIGIN}/api/token`;
const pairing = { start: `${ORIGIN}/api/plugin-connections`, claim: `${ORIGIN}/api/plugin-connections/claim`, cancel: `${ORIGIN}/api/plugin-connections/cancel`,
  current: `${ORIGIN}/api/plugin-connections/current` };
let inFlight = 0;
async function consoleFetch(url, options = {}, request) {
  if (base && url.startsWith(base)) request.route = routeOf(request);
  const auth = options.headers?.Authorization;
  const keyed = url === pairing.claim || url === pairing.cancel;
  const expected = url === pairing.start ? undefined : keyed ? keys.readKey && `Bearer ${keys.readKey}` : keys.token && `Bearer ${keys.token}`;
  const allowed = (base && url.startsWith(base)) || url === identityUrl || (pairMode && Object.values(pairing).includes(url));
  const problems = [
    !allowed && `called ${url}, outside ${base ?? 'the app'}, ${identityUrl}${pairMode ? ', and the connection request routes' : ''}`,
    secrets().some(secret => url.includes(secret)) && 'put a token or key in a URL',
    options.credentials !== 'omit' && `sent credentials: ${options.credentials}`,
    options.redirect !== 'error' && `sent redirect: ${options.redirect}`,
    (expected === undefined ? auth !== undefined : auth !== expected) && `did not send the expected Authorization to ${url}`,
  ].filter(Boolean);
  if (problems.length) {
    violations.push(...problems);
    throw new TypeError(`Blocked by the e2e harness: ${problems.join('; ')}`);
  }
  inFlight += 1;
  try {
    const response = await fetch(url, options);
    Object.assign(request, { status: response.status, contentType: response.headers.get('content-type'),
      cacheControl: response.headers.get('cache-control'), etag: response.headers.get('etag') });
    if (request.contentType?.startsWith('application/json')) request.json = await response.clone().json().catch(() => null);
    // The start's keys and the claim's token, so later requests can be checked and nothing prints them.
    if (url === pairing.start && response.status === 201) Object.assign(keys, { readKey: request.json?.readKey ?? null, writeKey: request.json?.writeKey ?? null });
    if (url === pairing.claim && request.json?.status === 'connected') {
      const issued = request.json.connection;
      keys.token = issued.token;
      base = `${ORIGIN}/api/apps/${issued.orgId}/${issued.appId}/`;
    }
    return response;
  } finally { inFlight -= 1; }
}

function encodePng(width, height, [red, green, blue]) {
  const chunk = (type, data) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header.set([8, 2, 0, 0, 0], 8);
  const row = Buffer.alloc(1 + width * 3);
  for (let x = 0; x < width; x += 1) row.set([red, green, blue], 1 + x * 3);
  const pixels = deflateSync(Buffer.concat(Array.from({ length: height }, () => row)));
  return new Uint8Array(Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', header), chunk('IDAT', pixels), chunk('IEND', Buffer.alloc(0))]));
}
// A colour unique to this run, so each Send uploads new bytes.
const stamp = Date.now();
const colour = [stamp & 255, (stamp >> 8) & 255, (stamp >> 16) & 255];
// Main may lower this constraint for native density, the 2048 edge cap, or the PNG byte budget.
function exportPng(node, settings) {
  const { type, value } = settings.constraint;
  const width = type === 'WIDTH' ? value : Math.round((value * node.width) / node.height);
  const height = type === 'HEIGHT' ? value : Math.round((value * node.height) / node.width);
  return encodePng(width, height, colour);
}

// Mirrors insertRendition in src/shared/library.ts, to know what the plugin should fetch.
function expectedRendition(asset) {
  let best = null;
  for (const item of asset.renditions) {
    if ((item.mime !== 'image/png' && item.mime !== 'image/webp') || item.bytes > MAX_INSERT_DOWNLOAD || item.width > 4096 || item.height > 4096) continue;
    const area = item.width * item.height;
    const bestArea = best ? best.width * best.height : -1;
    if (area > bestArea || (area === bestArea && item.mime === 'image/png' && best.mime !== 'image/png')) best = item;
  }
  return best;
}

const root = fileURLToPath(new URL('../', import.meta.url));
const app = createHarness({
  // No file key, as a Community plugin runs: the first Send asks for this file's link, whose name matches the document's.
  ...(await bundlePlugin(root)), fetch: consoleFetch, fileKey: null, rootName: 'Assetlib plugin local e2e', selection: [], exportBytes: exportPng,
  storage: [],
  viewport: { center: { x: 0, y: 0 }, bounds: { x: -2000, y: -2000, width: 4000, height: 4000 } },
});
const el = id => app.element(id);
// Connect waits (aria-disabled) while a connection test, send, or insert runs; a list marks itself aria-busy while it loads.
const unavailable = id => el(id).getAttribute('aria-disabled') === 'true';
const idle = () => !unavailable('connect') && ['insert-list', 'image-grid'].every(id => el(id).getAttribute('aria-busy') !== 'true');
// Fake elements start visible, so an error counts only once it has text. A failed connection test shows under the token
// field, and a list that can't load says why in its place, with an action.
const listFailed = () => !el('insert-empty').hidden && ['insert-retry', 'insert-token', 'insert-go-send'].some(id => !el(id).hidden);
const errorText = () => [...['error', 'connection-error'].map(el).filter(item => !item.hidden && item.textContent).map(item => item.textContent),
  ...(listFailed() ? [el('insert-empty-text').textContent] : [])].join(' ');
async function settled(what, timeout = 60000) {
  await waitFor(idle, { message: what, timeout });
  if (errorText()) throw new Error(`${what}: the plugin showed "${errorText()}"`);
}
const routeOf = request => request.url === identityUrl ? 'token' : request.url.slice(base.length).replace(/\?.*$/, '').replace(/^assets\/[^/]+\/renditions\/[^/]+$/, 'rendition');
const lastJson = route => app.requests.filter(request => routeOf(request) === route && request.json).at(-1)?.json;
const rowFor = key => descendants(el('insert-list')).find(item => item.getAttribute?.('data-key') === key);
const lastSelection = () => app.mainMessages.filter(message => message.type === 'selection').at(-1)?.selection;
// Insert makes a new frame only with nothing selected; with the last inserted frame selected it would replace its image.
async function selectNothing() {
  const count = app.mainMessages.length;
  app.select([]);
  await waitFor(() => app.mainMessages.length > count && lastSelection()?.insertTarget?.mode === 'new', { message: 'an empty selection' });
}

async function runToken() {
  const { token } = keys;
  // 1. The first-run screen connects with the token alone: GET /api/token names its organization and app, the connection
  // is saved, and the placements read succeeds.
  await waitFor(() => el('app').getAttribute('data-view') === 'first-run', { message: 'the first-run screen' });
  el('origin').value = ORIGIN;
  el('token').value = token;
  el('connection-form').dispatch('submit');
  await waitFor(() => el('connection-label').textContent === 'Connected' || errorText(), { message: 'the placements read', timeout: 60000 });
  await settled('the placements read');
  const identity = app.requests.find(request => routeOf(request) === 'token');
  assert.equal(identity?.status, 200);
  assert.deepEqual([identity.json.orgId, identity.json.appId, identity.json.scopes.includes('draft')], [connection.orgId, connection.appId, true]);
  const saved = app.storage.get('assetlib.connection.v1');
  assert.deepEqual([saved.origin, saved.orgId, saved.appId, saved.token === token], [ORIGIN, connection.orgId, connection.appId, true]);
  assert.equal(el('app').getAttribute('data-view'), 'shell');
  ok(`GET /api/token 200: the token names its own organization and app (${identity.json.workspaceName ?? 'no name'} · ${identity.json.appName ?? 'no name'}); the connection is saved without typed IDs`);
  const placements = app.requests.find(request => routeOf(request) === 'placements');
  assert.equal(placements?.status, 200);
  ok(`GET placements 200: ${el('status').textContent}`);

  // 2. Insert the placement from each published environment.
  el('tab-insert').dispatch('click');
  await settled('the artwork read');
  const before = lastJson('placements/artwork');
  assert.ok(before, 'GET placements/artwork returned JSON');
  const contract = before.placements.find(item => item.key === PLACEMENT);
  assert.ok(contract, `${PLACEMENT} is a placement in this app`);
  const base0 = contract.cells.find(cell => cell.state === null && cell.appearance === null && cell.arm === null);
  ok(`GET placements/artwork 200: ${before.placements.length} placements, staging ${before.environments.staging ? `release ${before.environments.staging.sequence}` : 'unpublished'}, production ${before.environments.production ? `release ${before.environments.production.sequence}` : 'unpublished'}`);
  const inserted = {};
  let skipped = 0;
  for (const environment of ['draft', 'staging', 'production']) {
    const art = base0[environment];
    if (environment !== 'draft' && !before.environments[environment]) { log(`skip - nothing is published to ${environment}`); continue; }
    const asset = art && before.assets[art.assetId];
    const rendition = asset && expectedRendition(asset);
    if (!rendition || rendition.mime !== 'image/png') { skipped += 1; log(`skip - ${PLACEMENT} in ${environment} has no PNG to insert without a browser`); continue; }
    el(`env-${environment}`).dispatch('click');
    rowFor(PLACEMENT).dispatch('click');
    // The footer names the environment, after the size a new layer inserts at (at 1× too); a replace has no size.
    assert.match(el('insert-meta').textContent, new RegExp(`^(→ \\d+ × \\d+ · )?${environment[0].toUpperCase()}${environment.slice(1)}( · |$)`));
    await selectNothing();
    assert.equal(el('insert').textContent, 'Insert');
    const frames = app.frames.length;
    el('insert').dispatch('click');
    await settled(`the ${environment} insert`);
    assert.equal(app.frames.length, frames + 1, 'one frame was created');
    const frame = app.frames.at(-1);
    assert.deepEqual([frame.width, frame.height], [contract.width, contract.height]);
    const message = app.insertMessages().at(-1);
    assert.deepEqual(pngSizeOf(message.bytes), { width: rendition.width, height: rendition.height }, 'the PNG IHDR matches the chosen rendition');
    const download = app.requests.filter(request => request.url.endsWith(`/assets/${asset.id}/renditions/${rendition.sha256}`)).at(-1);
    assert.equal(download.status, 200);
    assert.equal(download.cacheControl, 'private, no-store');
    assert.equal(download.etag, null);
    const link = JSON.parse(frame.getPluginData('assetlib.link.v1'));
    assert.deepEqual([link.placementKey, link.environment, link.assetId, link.nodeId], [PLACEMENT, environment, art.assetId, frame.id]);
    assert.equal(frame.type, 'COMPONENT', 'placement art is a component');
    assert.ok(frame.description.startsWith(`Assetlib placement ${PLACEMENT} (${contract.width} × ${contract.height}). `), 'its description names the placement');
    assert.deepEqual(JSON.parse(JSON.stringify(frame.documentationLinks)), [{ uri: `${PAGE_ORIGIN}/w/${connection.orgId}/${connection.appId}/placements` }]);
    assert.ok(!frame.description.includes(token), 'the marker never holds the token');
    assert.equal(lastSelection().remembered?.insertedFrom?.environment, environment);
    assert.equal(el('selection-bar').hidden, false);
    assert.equal(el('sync-title').textContent, `Linked to ${PLACEMENT}`);
    assert.equal(unavailable('sync'), false, 'Send review is available from Insert');
    assert.deepEqual(frame.getRelaunchData(), { sync: `${PLACEMENT}, from ${environment[0].toUpperCase()}${environment.slice(1)}. Review this layer and send edits to its draft.` });
    inserted[environment] = frame;
    ok(`Insert ${PLACEMENT} from ${environment}: ${frame.width} × ${frame.height} component with the placement description, ${rendition.mime} ${rendition.width} × ${rendition.height} (${asset.name})`);
  }
  assert.ok(inserted.draft, 'the draft insert ran');

  // 3. Insert a library image.
  el('browse-images').dispatch('click');
  await settled('the image list');
  const page = lastJson('assets');
  assert.ok(page && Array.isArray(page.assets), 'GET assets returned a page');
  const pick = page.assets.find(asset => expectedRendition(asset)?.mime === 'image/png');
  const photos = page.assets.filter(asset => expectedRendition(asset)?.mime === 'image/webp').length;
  skipped += photos;
  ok(`GET assets 200: ${page.assets.length} images on the first page; ${photos} WebP-only skipped (transcoding needs a browser)`);
  assert.ok(pick, 'an image with a PNG rendition exists');
  descendants(el('image-grid')).find(item => item.getAttribute?.('data-asset-id') === pick.id).dispatch('click');
  await selectNothing();
  el('insert').dispatch('click');
  await settled('the image insert');
  const imageFrame = app.frames.at(-1);
  assert.deepEqual([imageFrame.width, imageFrame.height], [pick.width, pick.height]);
  assert.equal(imageFrame.getPluginData('assetlib.link.v1'), '');
  assert.equal(imageFrame.type, 'FRAME', 'a library image stays a frame');
  assert.equal(lastSelection().remembered, null);
  assert.equal(el('selection-bar').hidden, true, 'an unlinked image hides the linked-artwork controls');
  ok(`Insert image "${pick.name}": ${imageFrame.width} × ${imageFrame.height} frame, not linked`);

  // 3b. Drag the placement from Draft onto the canvas: main makes a placeholder where it lands, which the download fills
  // and links, in one undo step. A download Insert made in the last minute is reused.
  el('browse-placements').dispatch('click');
  await settled('the placements');
  el('env-draft').dispatch('click');
  await selectNothing();
  const dragged = rowFor(PLACEMENT);
  assert.equal(dragged.draggable, true);
  const draftRendition = expectedRendition(before.assets[base0.draft.assetId]);
  const fetchesBefore = app.requests.filter(request => request.url.endsWith(`/renditions/${draftRendition.sha256}`)).length;
  const [framesBefore, commitsBefore] = [app.frames.length, app.undoCommits.length];
  assert.equal(dragged.dispatch('dragstart', { dataTransfer: dataTransfer() }).defaultPrevented, false);
  dragged.dispatch('dragend', { view: { length: 1 }, clientX: -120, clientY: 200 });
  assert.equal(app.dropOnCanvas({ absoluteX: 3000, absoluteY: 3000 }), false);
  const placeholder = app.frames.at(-1);
  assert.equal(app.frames.length, framesBefore + 1);
  assert.equal(placeholder.name, `${PLACEMENT} · loading`);
  await settled('the drop');
  assert.equal(placeholder.name, PLACEMENT);
  assert.deepEqual([placeholder.width, placeholder.height, placeholder.fills.length, placeholder.fills[0].type], [contract.width, contract.height, 1, 'IMAGE']);
  assert.deepEqual([placeholder.absoluteBoundingBox.x + contract.width / 2, placeholder.absoluteBoundingBox.y + contract.height / 2].map(Math.round), [3000, 3000]);
  const dropLink = JSON.parse(placeholder.getPluginData('assetlib.link.v1'));
  assert.deepEqual([dropLink.placementKey, dropLink.environment, dropLink.assetId, dropLink.nodeId], [PLACEMENT, 'draft', base0.draft.assetId, placeholder.id]);
  assert.equal(app.undoCommits.length, commitsBefore + 1, 'one undo step for the placeholder and its image');
  const fetched = app.requests.filter(request => request.url.endsWith(`/renditions/${draftRendition.sha256}`)).length - fetchesBefore;
  ok(`Drag ${PLACEMENT} onto the canvas: a placeholder at the drop point, filled and linked in one undo step (${fetched ? 'downloaded' : 'the insert download reused'})`);

  // 4. Round trip: review and send the draft frame, then read the artwork again. Only this cell is assigned;
  // the prior image is printed for restoring it. Saving the missing file link must not start an upload.
  log(`note - draft ${PLACEMENT} shows ${base0.draft ? `image ${base0.draft.assetId}` : 'no image'} before this run; assign it in the console to restore it`);
  const selections = app.mainMessages.length;
  app.select([inserted.draft]);
  await waitFor(() => app.mainMessages.length > selections && lastSelection()?.node?.id === inserted.draft.id, { message: 'the selection report' });
  await waitFor(() => !unavailable('sync'), { message: 'Send review to be ready' });
  // Once the artwork read after this selection arrives, the bar says where the layer's art is published.
  await waitFor(() => /^in (Production \(release \d+\)|Staging, not in Production|Draft, not published)$/.test(el('sync-meta').textContent), { message: 'the linked artwork status' });
  el('sync').dispatch('click');
  assert.equal(el('panel-send').hidden, false, 'Insert opens the destination review');
  assert.equal(app.exportMessages().length, 0, 'opening the review never exports');
  assert.equal(app.drafts().length, 0);
  el('send').dispatch('click');
  assert.equal(el('file-fallback').hidden, false, 'the first Send asks for the file link');
  el('file-url').value = FILE_URL;
  el('file-url').dispatch('input'); app.fireTimers(350);
  await waitFor(() => el('file-fallback').hidden && lastSelection()?.fileKey === 'AssetlibPluginE2E' && !unavailable('send'), { message: 'the pasted file link to save automatically' });
  assert.equal(app.exportMessages().length, 0, 'linking the file does not resume an export');
  assert.equal(app.drafts().length, 0, 'linking the file saves setup only');
  el('send').dispatch('click');
  await waitFor(() => app.drafts().length > 0, { message: 'the reviewed Send' });
  await settled('Send', 120000);
  assert.deepEqual([JSON.parse(app.figma.root.getPluginData('assetlib.file.v1')).fileKey, JSON.parse(app.figma.root.getPluginData('assetlib.file.v1')).source],
    ['AssetlibPluginE2E', 'link'], 'the document keeps the file key');
  const draft = app.requests.filter(request => routeOf(request) === 'drafts').at(-1);
  assert.equal(draft.status, 201);
  assert.deepEqual(draft.body.bind, { slotKey: PLACEMENT, state: null, appearance: null, arm: null });
  assert.equal(draft.body.rebind, false);
  assert.equal(draft.body.expectedAssetId, base0.draft.assetId);
  assert.deepEqual(draft.json.rebound, []);
  assert.deepEqual(draft.json.bound, { slotKey: PLACEMENT, state: null, appearance: null, arm: null });
  const created = draft.json.asset;
  assert.equal(draft.body.source.fileKey, 'AssetlibPluginE2E');
  assert.equal(el('status').textContent, '1 of 1 layer sent to draft.');
  assert.equal(app.notifications.at(-1).message, '1 of 1 layer sent to draft.');
  // The sent layer's link now names the draft's new image, for every device and teammate.
  const relinked = JSON.parse(inserted.draft.getPluginData('assetlib.link.v1'));
  assert.deepEqual([relinked.environment, relinked.assetId, relinked.nodeId], ['draft', created.id, inserted.draft.id]);
  ok(`Reviewed Send POST drafts 201 after automatic file linking: asset ${created.id} ${created.width} × ${created.height}, conditionally bound to ${PLACEMENT}, no references rebound; the layer's link names it`);

  el('tab-insert').dispatch('click');
  el('browse-placements').dispatch('click');
  await settled('the artwork reload');
  el('env-draft').dispatch('click');
  el('insert-refresh').dispatch('click');
  await settled('the artwork refresh');
  const after = lastJson('placements/artwork');
  const base1 = after.placements.find(item => item.key === PLACEMENT).cells.find(cell => cell.state === null && cell.appearance === null && cell.arm === null);
  assert.deepEqual(base1.draft, { assetId: created.id, via: { arm: null, appearance: null } });
  assert.deepEqual(base1.staging, base0.staging, 'staging is unchanged');
  assert.deepEqual(base1.production, base0.production, 'production is unchanged');
  assert.deepEqual(after.environments, before.environments);
  if (after.environments.production) {
    const row = rowFor(PLACEMENT);
    assert.match(row.title, base1.production ? /Draft differs from Production in 1 cell/ : /Draft has art that isn’t in Production yet/);
    const tags = descendants(row).filter(item => /^tag( |$)/.test(item.className ?? '')).map(item => item.textContent);
    assert.deepEqual(tags, ['1 behind'], 'the dropped copy still shows the preceding Draft image');
  }
  ok(`GET placements/artwork after Send: draft ${PLACEMENT} is ${created.id} via its own cell; staging and production unchanged`);

  const png = after.assets[created.id].renditions.filter(item => item.mime === 'image/png').sort((a, b) => b.width * b.height - a.width * a.height)[0];
  const response = await fetch(`${base}assets/${created.id}/renditions/${png.sha256}`, { headers: { Authorization: `Bearer ${token}` }, redirect: 'error' });
  const bytes = new Uint8Array(await response.arrayBuffer());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'private, no-store');
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.equal(response.headers.get('etag'), null);
  assert.deepEqual(pngSizeOf(bytes), { width: png.width, height: png.height });
  assert.equal(createHash('sha256').update(bytes).digest('hex'), png.sha256);
  ok(`GET the new asset's PNG rendition: 200, private, no-store, ${png.width} × ${png.height}, sha256 matches`);

  // 5. Previews arrived as data: URLs through the byte route.
  const previews = () => [...descendants(el('insert-list')), ...descendants(el('image-grid'))].filter(item => item.tag === 'img' && item.src.startsWith('data:image/'));
  await waitFor(() => previews().length > 0, { message: 'at least one preview loaded', timeout: 30000 });
  ok(`${previews().length} previews loaded as data: URLs`);

  // 6. CORS, which Node's fetch does not enforce.
  for (const route of ['placements/artwork', 'assets', `assets/${created.id}/renditions/${png.sha256}`]) {
    const preflight = await fetch(`${base}${route}`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(preflight.status, 204, route);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  }
  const identityPreflight = await fetch(identityUrl, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
  assert.equal(identityPreflight.status, 204, '/api/token');
  assert.equal(identityPreflight.headers.get('access-control-allow-origin'), '*', '/api/token');
  assert.equal(identityPreflight.headers.get('access-control-allow-credentials'), null, '/api/token');
  ok('OPTIONS preflights with Origin: null, including /api/token: 204, allow-origin *, GET, OPTIONS, no credentials');

  // 7. Requests, and where the token must never appear.
  assert.deepEqual(violations, []);
  const routes = [...new Set(app.requests.map(routeOf))].sort();
  assert.deepEqual(routes, ['assets', 'drafts', 'figma/inventory', 'placements', 'placements/artwork', 'rendition', 'token']);
  const text = [...app.elements.values()].map(textOf).join('\n');
  const places = { notices: app.notices.join('\n'), pluginData: app.frames.map(frame => frame.getPluginData('assetlib.link.v1')).join('\n'), text,
    urls: app.requests.map(request => request.url).join('\n') };
  for (const [name, value] of Object.entries(places)) assert.ok(!value.includes(token), `the token appears in ${name}`);
  ok(`${app.requests.length} requests, all to ${base} or ${identityUrl} with the bearer, credentials: omit and redirect: error; the token is in no URL, notice, layer data, or UI text`);
  log(`e2e:local passed: ${checks} checks; ${skipped} skipped for WebP-only artwork.`);
}

/** The console's session routes, as the connect page calls them: on 127.0.0.1, with its Origin and the session cookie. */
async function session(path, body, cookie = '') {
  const response = await fetch(`${PAGE_ORIGIN}${path}`, { method: 'POST', redirect: 'manual',
    headers: { 'Content-Type': 'application/json', Origin: PAGE_ORIGIN, ...(cookie ? { Cookie: cookie } : {}) }, body: JSON.stringify(body) });
  const json = await response.json().catch(() => null);
  return { status: response.status, json, cookie: response.headers.getSetCookie().map(item => item.split(';')[0]).join('; ') };
}

/** The next poll, as its timer would fire it: once no request is in flight, and at least 2 s after the last (slow_down). */
async function firePoll() {
  await waitFor(() => inFlight === 0, { message: 'the poll in flight' });
  await new Promise(resolve => setTimeout(resolve, 2100));
  // Connected meanwhile: the timers left are the connection test's, not a poll.
  if (el('app').getAttribute('data-view') === 'shell') return;
  const delays = [...app.timers.values()].map(timer => timer.delay).filter(delay => delay !== 15000);
  if (delays.length) app.fireTimers(Math.min(...delays));
  await waitFor(() => inFlight === 0, { message: 'the poll' });
}

async function runPair() {
  // 1. Connect to Assetlib, then Cancel: the console is told, and a claim with that read key answers cancelled.
  await waitFor(() => el('app').getAttribute('data-view') === 'first-run', { message: 'the first-run screen' });
  el('origin').value = ORIGIN;
  el('connect-browser').dispatch('click');
  await waitFor(() => !el('pairing').hidden || !el('pairing-note').hidden, { message: 'the first request', timeout: 30000 });
  assert.equal(el('pairing').hidden, false, `the request started: ${el('pairing-note').textContent}`);
  const cancelled = keys.readKey;
  el('pairing-cancel').dispatch('click');
  await waitFor(() => app.requests.some(request => request.url === pairing.cancel && request.status), { message: 'the cancel' });
  assert.equal(app.requests.find(request => request.url === pairing.cancel).status, 204);
  const after = await fetch(pairing.claim, { method: 'POST', headers: { Authorization: `Bearer ${cancelled}` }, redirect: 'error' });
  assert.deepEqual([after.status, (await after.json()).status], [410, 'cancelled']);
  assert.equal(el('app').getAttribute('data-view'), 'first-run');
  ok('POST /api/plugin-connections 201, Cancel 204, then a claim with its read key 410 cancelled');

  // 2. Connect again: main opens the console's connect page on 127.0.0.1 with the write key in the fragment only.
  const opened = app.externalUrls.length;
  el('connect-browser').dispatch('click');
  await waitFor(() => app.externalUrls.length > opened, { message: 'the connect page', timeout: 30000 });
  const page = app.externalUrls.at(-1);
  assert.equal(page, `${PAGE_ORIGIN}/connect/figma#${keys.writeKey}`);
  const start = app.requests.filter(request => request.url === pairing.start).at(-1);
  assert.deepEqual([start.status, start.authorization, start.body], [201, undefined, { client: 'figma' }]);
  const code = el('pairing-code').textContent;
  assert.match(code, /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/);
  assert.deepEqual(app.storage.get('assetlib.pairing.v1').readKey, keys.readKey);
  ok(`the plugin shows ${code} and opened ${PAGE_ORIGIN}/connect/figma#<write key>; only the read key is stored`);

  // 3. The browser's part: sign in, read the request, and approve it for the first workspace that may.
  const signIn = await session('/api/auth/sign-in/email', { email: input.email, password: input.password });
  assert.equal(signIn.status, 200, `sign-in answered ${signIn.status}`);
  assert.ok(signIn.cookie, 'sign-in set a session cookie');
  const preview = await session('/api/plugin-connections/preview', { writeKey: keys.writeKey }, signIn.cookie);
  assert.equal(preview.status, 200, `preview answered ${preview.status}`);
  const request = preview.json.connection;
  assert.deepEqual([request.status, request.userCode, request.signedInAs], ['pending', code, input.email]);
  const workspace = request.workspaces.find(item => item.eligible);
  assert.ok(workspace, `${input.email} owns or edits a workspace`);
  const approve = await session('/api/plugin-connections/approve',
    { writeKey: keys.writeKey, orgId: workspace.orgId, appId: workspace.appId, ...(request.sameNetwork ? {} : { startedHere: true }) }, signIn.cookie);
  assert.deepEqual([approve.status, approve.json?.connection?.status], [200, 'approved'], `approve answered ${approve.status}`);
  ok(`preview 200 (same network: ${request.sameNetwork}), approve 200 for ${workspace.name} · ${workspace.appName}`);

  // 4. The plugin's next poll claims the token, saves a browser connection, and reads placements with it.
  for (let poll = 0; poll < 15 && el('app').getAttribute('data-view') !== 'shell'; poll += 1) await firePoll();
  await waitFor(() => el('connection-label').textContent === 'Connected' || errorText(), { message: 'the placements read', timeout: 60000 });
  await settled('the placements read');
  const saved = app.storage.get('assetlib.connection.v1');
  assert.deepEqual([saved.origin, saved.orgId, saved.appId, saved.method, saved.connectedAs, saved.pairing, saved.token === keys.token],
    [ORIGIN, workspace.orgId, workspace.appId, 'browser', input.email, code.replace('-', ''), true]);
  assert.equal(app.storage.has('assetlib.pairing.v1'), false);
  assert.equal(app.requests.filter(item => item.url === identityUrl).length, 0, 'the names came with the claim');
  assert.equal(app.requests.filter(item => item.url === `${base}placements`).at(-1)?.status, 200);
  const toast = app.notifications.at(-1).message;
  assert.ok(toast.startsWith('Connected to ') && toast.endsWith(` as ${input.email}`), toast);
  ok(`claim 200 connected: ${toast}; GET placements 200 with the issued token`);
  el('tab-insert').dispatch('click');
  await settled('the artwork read');
  assert.equal(app.requests.filter(item => item.url === `${base}placements/artwork`).at(-1)?.status, 200);
  ok('GET placements/artwork 200 with the issued token');

  // 5. Disconnect ends the token: DELETE current 204, and GET /api/token then answers 403 revoked.
  el('settings').open = true;
  el('disconnect').dispatch('click');
  await waitFor(() => el('app').getAttribute('data-view') === 'first-run', { message: 'Disconnect', timeout: 30000 });
  assert.equal(app.requests.find(item => item.url === pairing.current)?.status, 204);
  assert.deepEqual(app.uiMessages.filter(message => message.type === 'clear-connection').map(message => message.revoked), [true]);
  assert.equal(app.notifications.at(-1).message, 'Disconnected. This connection was ended.');
  const identity = await fetch(identityUrl, { headers: { Authorization: `Bearer ${keys.token}` }, redirect: 'error' });
  const refused = await identity.json();
  assert.deepEqual([identity.status, refused.code], [403, 'revoked']);
  ok('Disconnect: DELETE current 204; GET /api/token with the ended token 403 revoked');

  // 6. CORS on the four routes, which Node's fetch does not enforce.
  for (const [url, method] of [[pairing.start, 'POST'], [pairing.claim, 'POST'], [pairing.cancel, 'POST'], [pairing.current, 'DELETE']]) {
    const preflight = await fetch(url, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': method, 'Access-Control-Request-Headers': 'authorization, content-type' } });
    assert.equal(preflight.status, 204, url);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*', url);
    assert.equal(preflight.headers.get('access-control-allow-methods'), `${method}, OPTIONS`, url);
    assert.equal(preflight.headers.get('access-control-max-age'), '7200', url);
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null, url);
  }
  ok('OPTIONS preflights with Origin: null on the four connection request routes: 204, allow-origin *, the route’s method, max-age 7200, no credentials');

  // 7. Requests, and where no token or key may appear.
  assert.deepEqual(violations, []);
  const text = [...app.elements.values()].map(textOf).join('\n');
  const places = { notices: app.notices.join('\n'), text, urls: app.requests.map(item => item.url).join('\n'), storage: JSON.stringify(app.storage.get('assetlib.pairing.v1') ?? null) };
  for (const [name, value] of Object.entries(places)) for (const secret of [keys.token, keys.writeKey]) assert.ok(!value.includes(secret), `a secret appears in ${name}`);
  ok(`${app.requests.length} requests, none with cookies or redirects; the token and write key are in no URL, notice, stored record, or UI text`);
  log(`e2e:local --pair passed: ${checks} checks.`);
}

try {
  if (pairMode) await runPair(); else await runToken();
} catch (error) {
  log(`not ok - ${error instanceof Error ? error.message : error}`);
  if (error instanceof assert.AssertionError) log(`  expected ${JSON.stringify(error.expected)}, actual ${JSON.stringify(error.actual)}`);
  process.exit(1);
}
