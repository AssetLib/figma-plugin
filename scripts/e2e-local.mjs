// Local end-to-end check against a running console (npm run e2e:local -- --connection <file>). Not part of npm test.
// It bundles src/code.ts and src/ui.ts as the tests do and runs them in node:vm with the fakes from tests/fakes.mjs,
// but every HTTP call is Node's real fetch to the console. It needs no real Figma, so WebP-only images are skipped.
// The connection file holds {"origin":"http://localhost:3100","orgId":…,"appId":…,"token":…} with a draft token;
// keep it outside both repositories with mode 600. The token is never printed.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { crc32, deflateSync } from 'node:zlib';
import { bundlePlugin, createHarness, descendants, pngSizeOf, textOf, waitFor } from '../tests/fakes.mjs';

const ORIGIN = 'http://localhost:3100';
const PLACEMENT = 'travel.coast';
const FILE_URL = 'https://www.figma.com/design/AssetlibPluginE2E/assetlib-plugin-local-e2e';
const MAX_INSERT_DOWNLOAD = 4 * 1024 * 1024;

const flag = process.argv.indexOf('--connection');
const file = flag >= 0 ? process.argv[flag + 1] : undefined;
if (!file) {
  console.error('Usage: npm run e2e:local -- --connection <file>');
  process.exit(2);
}
const connection = JSON.parse(await readFile(file, 'utf8'));
const { token } = connection;
const redact = value => String(value).split(token).join('<token>');
const log = line => console.log(redact(line));
if (connection.origin !== ORIGIN || !/^[A-Za-z0-9_-]{1,128}$/.test(connection.orgId ?? '') || !/^[A-Za-z0-9_-]{1,128}$/.test(connection.appId ?? '')
  || typeof token !== 'string' || token.length < 8 || /\s/.test(token)) {
  console.error(`The connection file must hold {"origin":"${ORIGIN}","orgId":…,"appId":…,"token":…}.`);
  process.exit(2);
}
if ((await stat(file)).mode & 0o077) log(`warning: ${file} is readable by other users; chmod 600 it.`);
const base = `${ORIGIN}/api/apps/${connection.orgId}/${connection.appId}/`;

let checks = 0;
function ok(line) { checks += 1; log(`ok ${checks} - ${line}`); }

// Every request the plugin makes goes through this wrapper around Node's fetch.
const violations = [];
async function consoleFetch(url, options = {}, request) {
  const problems = [
    !url.startsWith(base) && `called ${url}, outside ${base}`,
    url.includes(token) && 'put the token in a URL',
    options.credentials !== 'omit' && `sent credentials: ${options.credentials}`,
    options.redirect !== 'error' && `sent redirect: ${options.redirect}`,
    options.headers?.Authorization !== `Bearer ${token}` && 'did not send the bearer token',
  ].filter(Boolean);
  if (problems.length) {
    violations.push(...problems);
    throw new TypeError(`Blocked by the e2e harness: ${problems.join('; ')}`);
  }
  const response = await fetch(url, options);
  Object.assign(request, { status: response.status, contentType: response.headers.get('content-type'),
    cacheControl: response.headers.get('cache-control'), etag: response.headers.get('etag') });
  if (request.contentType?.startsWith('application/json')) request.json = await response.clone().json().catch(() => null);
  return response;
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
// A colour unique to this run, so each Sync uploads new bytes.
const stamp = Date.now();
const colour = [stamp & 255, (stamp >> 8) & 255, (stamp >> 16) & 255];
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
  ...(await bundlePlugin(root)), fetch: consoleFetch, fileKey: null, selection: [], exportBytes: exportPng,
  storage: [['assetlib.connection.v1', { origin: connection.origin, orgId: connection.orgId, appId: connection.appId, token }]],
  viewport: { center: { x: 0, y: 0 }, bounds: { x: -2000, y: -2000, width: 4000, height: 4000 } },
});
const el = id => app.element(id);
const idle = () => !el('tab-send').disabled;
// Fake elements start visible, so an error counts only once it has text.
const errorText = () => el('error').hidden ? '' : el('error').textContent;
async function settled(what, timeout = 60000) {
  await waitFor(idle, { message: what, timeout });
  if (errorText()) throw new Error(`${what}: the plugin showed "${errorText()}"`);
}
const routeOf = request => request.url.slice(base.length).replace(/\?.*$/, '').replace(/^assets\/[^/]+\/renditions\/[^/]+$/, 'rendition');
const lastJson = route => app.requests.filter(request => routeOf(request) === route && request.json).at(-1)?.json;
const rowFor = key => descendants(el('insert-list')).find(item => item.getAttribute?.('data-key') === key);
const lastSelection = () => app.mainMessages.filter(message => message.type === 'selection').at(-1)?.selection;

try {
  // 1. The saved connection loads and the placements read succeeds.
  await waitFor(() => el('connection-label').textContent === '· connected' || errorText(), { message: 'the placements read', timeout: 60000 });
  await settled('the placements read');
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
    assert.match(el('insert-meta').textContent, new RegExp(`^${environment[0].toUpperCase()}${environment.slice(1)} · `));
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
    assert.equal(lastSelection().remembered?.insertedFrom?.environment, environment);
    assert.equal(el('sync').hidden, false);
    assert.equal(el('sync').disabled, true, 'Sync waits for the file URL');
    assert.match(el('status').textContent, /Confirm the file URL on the Send tab to enable Sync\.$/);
    inserted[environment] = frame;
    ok(`Insert ${PLACEMENT} from ${environment}: ${frame.width} × ${frame.height} frame, ${rendition.mime} ${rendition.width} × ${rendition.height} (${asset.name})`);
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
  el('insert').dispatch('click');
  await settled('the image insert');
  const imageFrame = app.frames.at(-1);
  assert.deepEqual([imageFrame.width, imageFrame.height], [pick.width, pick.height]);
  assert.equal(imageFrame.getPluginData('assetlib.link.v1'), '');
  assert.equal(lastSelection().remembered, null);
  assert.equal(el('sync').hidden, true);
  ok(`Insert image "${pick.name}": ${imageFrame.width} × ${imageFrame.height} frame, not linked`);

  // 4. Round trip: Sync the draft frame, then read the artwork again. This rebinds the app's draft travel.coast,
  // so the image it showed before is printed for restoring it in the console.
  log(`note - draft ${PLACEMENT} shows ${base0.draft ? `image ${base0.draft.assetId}` : 'no image'} before this run; rebind it in the console to restore it`);
  const selections = app.mainMessages.length;
  app.select([inserted.draft]);
  await waitFor(() => app.mainMessages.length > selections && lastSelection()?.node?.id === inserted.draft.id, { message: 'the selection report' });
  el('tab-send').dispatch('click');
  el('file-url').value = FILE_URL;
  el('file-form').dispatch('submit');
  await settled('the file URL');
  await waitFor(() => !el('sync').disabled, { message: 'Sync to be enabled' });
  assert.equal(el('sync').textContent, `Sync to ${PLACEMENT}`);
  assert.match(el('sync-note').textContent, /Inserted from Draft\. Sync sends this layer to that cell/);
  el('sync').dispatch('click');
  await settled('Sync', 120000);
  const draft = app.requests.filter(request => routeOf(request) === 'drafts').at(-1);
  assert.equal(draft.status, 201);
  assert.deepEqual(draft.body.bind, { slotKey: PLACEMENT, state: null, appearance: null, arm: null });
  assert.equal(draft.body.rebind, true);
  assert.deepEqual(draft.json.bound, { slotKey: PLACEMENT, state: null, appearance: null, arm: null });
  const created = draft.json.asset;
  assert.equal(el('status').textContent, 'Sync target saved. Review the draft in the console.');
  ok(`Sync POST drafts 201: asset ${created.id} ${created.width} × ${created.height}, bound to ${PLACEMENT}, ${draft.json.rebound.length} reference(s) rebound`);

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
    const tags = descendants(rowFor(PLACEMENT)).filter(item => item.className === 'tag').map(item => item.textContent);
    assert.deepEqual(tags, [base1.production ? 'Differs from production' : 'Not in production']);
  }
  ok(`GET placements/artwork after Sync: draft ${PLACEMENT} is ${created.id} via its own cell; staging and production unchanged`);

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
  const previews = [...descendants(el('insert-list')), ...descendants(el('image-grid'))].filter(item => item.tag === 'img' && item.src.startsWith('data:image/'));
  assert.ok(previews.length > 0, 'at least one preview loaded');
  ok(`${previews.length} previews loaded as data: URLs`);

  // 6. CORS, which Node's fetch does not enforce.
  for (const route of ['placements/artwork', 'assets', `assets/${created.id}/renditions/${png.sha256}`]) {
    const preflight = await fetch(`${base}${route}`, { method: 'OPTIONS', headers: { Origin: 'null', 'Access-Control-Request-Method': 'GET', 'Access-Control-Request-Headers': 'authorization' } });
    assert.equal(preflight.status, 204, route);
    assert.equal(preflight.headers.get('access-control-allow-origin'), '*');
    assert.equal(preflight.headers.get('access-control-allow-methods'), 'GET, OPTIONS');
    assert.equal(preflight.headers.get('access-control-allow-credentials'), null);
  }
  ok('OPTIONS preflights with Origin: null: 204, allow-origin *, GET, OPTIONS, no credentials');

  // 7. Requests, and where the token must never appear.
  assert.deepEqual(violations, []);
  const routes = [...new Set(app.requests.map(routeOf))].sort();
  assert.deepEqual(routes, ['assets', 'drafts', 'placements', 'placements/artwork', 'rendition']);
  const text = [...app.elements.values()].map(textOf).join('\n');
  const places = { notices: app.notices.join('\n'), pluginData: app.frames.map(frame => frame.getPluginData('assetlib.link.v1')).join('\n'), text,
    urls: app.requests.map(request => request.url).join('\n') };
  for (const [name, value] of Object.entries(places)) assert.ok(!value.includes(token), `the token appears in ${name}`);
  ok(`${app.requests.length} requests, all to ${base} with the bearer, credentials: omit and redirect: error; the token is in no URL, notice, layer data, or UI text`);
  log(`e2e:local passed: ${checks} checks; ${skipped} skipped for WebP-only artwork.`);
} catch (error) {
  log(`not ok - ${error instanceof Error ? error.message : error}`);
  if (error instanceof assert.AssertionError) log(`  expected ${JSON.stringify(error.expected)}, actual ${JSON.stringify(error.actual)}`);
  process.exit(1);
}
