import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_BODY_BYTES, MAX_IMAGE_BYTES, MAX_INSERT_DOWNLOAD, MAX_PREVIEW_BYTES, MISSING_INSERT, PRODUCTION_ORIGIN, DEVELOPMENT_ORIGIN, LEGACY_PRODUCTION_ORIGIN,
  apiUrl, artworkAsset, aspectRatioDifference, assertDraftBodyLimit, assetsUrl, baseCoordinate, buildDraftBody, bytesToBase64,
  cellOptions, chooseExportSettings, decodedBase64Length, defaultPreferences, encodeBase64, environmentLabel, findCell,
  insertRendition, insertUnavailable, isUint8Array, layerName, linkMatches, loadSavedConnection, mapHttpError, mapNetworkError,
  normalizeConsoleOrigin, parseArtwork, parseAssetPage, parseDraftResponse, parseFileKey, parsePlacements, parsePngDimensions,
  parsePreferences, parseStoredLink, placementMarker, pngSize, renditionUrl, sanitizeName, thumbnailRendition, tokenPrefix,
  utf8Length, validArm, validateBinding, validateConnection, validateInsertLink,
} from '../.test-build/shared/index.js';

const readText = path => readFile(new URL(`../${path}`, import.meta.url), 'utf8');

const placement = { key: 'travel.coast', screen: 'Travel / Discover', width: 1200, height: 900,
  states: null, defaultState: null, variants: null, origin: 'declared' };
const node = { id: '12:34', name: 'Hero / Coast', width: 800, height: 600, type: 'FRAME' };
const bind = { slotKey: placement.key, state: null, appearance: null, arm: null };
const png = 'iVBORw0KGgo=';
const makeBody = (extra = {}) => buildDraftBody({ node, fileKey: 'abc123', placement, bind,
  bytesBase64: png, settings: chooseExportSettings(node, placement), rebind: false, ...extra });
const result = {
  asset: { id: 'asset-new', name: node.name, width: 1200, height: 900, sha256: 'a'.repeat(64), renditions: 3 },
  previous: null, bound: bind, bindError: null, rebound: [],
};

test('file URL fallback accepts both file and design links and excludes non-Figma URLs', () => {
  for (const route of ['file', 'design']) {
    assert.equal(parseFileKey(`https://www.figma.com/${route}/Abc_123-xyz/Coast?node-id=12-34`), 'Abc_123-xyz');
    assert.equal(parseFileKey(` https://figma.com/${route}/abc123 `), 'abc123');
  }
  for (const url of ['abc123', 'http://figma.com/design/abc/title', 'https://figma.com.evil.test/file/abc/',
    'https://user:secret@figma.com/file/abc/', 'https://figma.com:444/file/abc/',
    'https://figma.com/proto/abc/', 'https://figma.com/file/a%2Fb/', 'https://figma.com/design//',
    `https://figma.com/file/${'x'.repeat(129)}/`]) {
    assert.throws(() => parseFileKey(url));
  }
});

test('connection origin is limited to the production and development origins', () => {
  assert.equal(PRODUCTION_ORIGIN, 'https://console.assetlib.dev');
  assert.equal(normalizeConsoleOrigin(`${PRODUCTION_ORIGIN}/`), PRODUCTION_ORIGIN);
  assert.equal(normalizeConsoleOrigin(DEVELOPMENT_ORIGIN), DEVELOPMENT_ORIGIN);
  for (const origin of ['http://127.0.0.1:3100', 'https://console.assetlib.dev.evil.test', 'http://console.assetlib.dev',
    `${PRODUCTION_ORIGIN}/path`, `${PRODUCTION_ORIGIN}?token=secret`, `https://user:secret@console.assetlib.dev`,
    LEGACY_PRODUCTION_ORIGIN]) {
    assert.throws(() => normalizeConsoleOrigin(origin), /console\.assetlib\.dev/);
  }
  assert.throws(() => validateConnection({ origin: LEGACY_PRODUCTION_ORIGIN, orgId: 'org', appId: 'app', token: 'draft' }),
    'a new connection cannot choose the legacy host');
  const connection = validateConnection({ origin: PRODUCTION_ORIGIN, orgId: ' org-123 ', appId: 'app-456', token: ' draft_secret ' });
  assert.equal(connection.orgId, 'org-123');
  assert.equal(connection.token, 'draft_secret');
  assert.equal(apiUrl(connection, 'placements'), `${PRODUCTION_ORIGIN}/api/apps/org-123/app-456/placements`);
  assert.equal(apiUrl(connection, 'drafts'), `${PRODUCTION_ORIGIN}/api/apps/org-123/app-456/drafts`);
  assert.throws(() => validateConnection({ ...connection, orgId: '../other' }), /organization id/);
  assert.throws(() => validateConnection({ ...connection, appId: '' }), /app id/);
  assert.throws(() => validateConnection({ ...connection, token: 'with space' }), /draft token/);
  assert.equal(tokenPrefix(''), '');
  for (const secret of ['a', 'abcd', 'draft_secret_long']) {
    assert.ok(tokenPrefix(secret).endsWith('…'));
    assert.ok(!tokenPrefix(secret).includes(secret));
  }
});

test('a saved connection on the legacy production host loads on the current host with the same token', () => {
  const saved = { origin: LEGACY_PRODUCTION_ORIGIN, orgId: 'org-123', appId: 'app-456', token: 'draft_secret' };
  for (const origin of [LEGACY_PRODUCTION_ORIGIN, `${LEGACY_PRODUCTION_ORIGIN}/`, ` ${LEGACY_PRODUCTION_ORIGIN} `]) {
    assert.deepEqual(loadSavedConnection({ ...saved, origin }), { ...saved, origin: PRODUCTION_ORIGIN });
  }
  assert.equal(apiUrl(loadSavedConnection(saved), 'drafts'), `${PRODUCTION_ORIGIN}/api/apps/org-123/app-456/drafts`);
  for (const origin of [PRODUCTION_ORIGIN, DEVELOPMENT_ORIGIN]) {
    assert.deepEqual(loadSavedConnection({ ...saved, origin }), { ...saved, origin });
  }
  for (const value of [null, 'text', { ...saved, origin: 'https://assetlib-console.vercel.app.evil.test' },
    { ...saved, origin: 'http://assetlib-console.vercel.app' }, { ...saved, origin: 42 }, { ...saved, token: '' }]) {
    assert.throws(() => loadSavedConnection(value));
  }
});

test('manifest, origin picker, and connection rules name the same origins, with the current host as default', async () => {
  const manifest = JSON.parse(await readText('manifest.json'));
  assert.deepEqual(manifest.networkAccess.allowedDomains, [PRODUCTION_ORIGIN, LEGACY_PRODUCTION_ORIGIN],
    'the legacy host stays allowed so a build made before the move keeps working');
  assert.deepEqual(manifest.networkAccess.devAllowedDomains, [DEVELOPMENT_ORIGIN]);
  const html = await readText('src/ui.html');
  const picker = /<select id="origin">([\s\S]*?)<\/select>/.exec(html);
  assert.ok(picker, 'the origin picker exists');
  const options = [...picker[1].matchAll(/<option value="([^"]+)"/g)].map(match => match[1]);
  assert.deepEqual(options, [PRODUCTION_ORIGIN, DEVELOPMENT_ORIGIN], 'new connections default to the current host and never offer the legacy one');
});

test('placements parse stateless and stateful picker data without importing bindings', () => {
  const family = { ...placement, key: 'tasks.garden', states: ['empty', 'growing'], defaultState: 'empty',
    variants: { appearance: ['light', 'dark'], arm: ['b', 'c'] } };
  const list = parsePlacements({ placements: [{ ...placement, assetId: 'do-not-import' }, family] });
  assert.deepEqual(list, [placement, family]);
  assert.deepEqual(cellOptions(family), { states: [null, 'empty', 'growing'], appearances: [null, 'light', 'dark'], arms: [null, 'b', 'c'] });
  assert.deepEqual(cellOptions(placement), { states: [null], appearances: [null], arms: [null] });
  assert.deepEqual(parsePlacements({ placements: [] }), []);
  assert.deepEqual(parsePlacements({ placements: [{ ...placement, states: undefined, defaultState: undefined, variants: undefined }] }), [placement]);
});

test('placements reject malformed response shapes, states, dimensions, and duplicate keys', () => {
  for (const value of [null, [], { slots: [] }, { placements: [null] }, { placements: [placement, placement] }]) {
    assert.throws(() => parsePlacements(value));
  }
  for (const extra of [{ width: 0 }, { height: Infinity }, { width: 1.5 }, { key: '' }, { origin: 'unknown' },
    { states: { empty: 'asset-id' }, defaultState: 'empty' },
    { states: ['empty'], defaultState: 'empty' },
    { states: ['empty', 'empty'], defaultState: 'empty' },
    { states: ['empty', 'growing'], defaultState: 'missing' },
    { states: ['empty', 'constructor'], defaultState: 'empty' }, { defaultState: 'empty' }]) {
    assert.throws(() => parsePlacements({ placements: [{ ...placement, ...extra }] }));
  }
});

test('arm validation enforces all contract restrictions and rejects unknown axes', () => {
  for (const arm of ['b', 'c2', 'trial_2', 'trial-arm', 'a'.repeat(20)]) assert.equal(validArm(arm), true);
  for (const arm of ['control', 'any', 'constructor', 'prototype', '__proto__', 'A', '2b', '',
    'a'.repeat(21), 'b.c', null]) assert.equal(validArm(arm), false);
  for (const variants of [{ arm: [] }, { arm: ['b', 'b'] }, { arm: ['b', 'c', 'd', 'e', 'f'] },
    { arm: ['control'] }, { arm: ['any'] }, { arm: ['constructor'] }, { arm: ['prototype'] }, { arm: ['__proto__'] },
    { arm: ['UPPER'] }, { appearance: [] }, { appearance: ['dark', 'dark'] }, { appearance: ['any'] },
    { platform: ['ios'] }, {}, JSON.parse('{"__proto__": ["b"]}')]) {
    assert.throws(() => parsePlacements({ placements: [{ ...placement, variants }] }));
  }
  assert.deepEqual(parsePlacements({ placements: [{ ...placement, variants: { arm: ['b'] } }] })[0].variants, { arm: ['b'] });
});

test('binding permits only declared cells, with null for control/any/default', () => {
  const family = { ...placement, states: ['empty', 'growing'], defaultState: 'empty', variants: { arm: ['b'], appearance: ['dark'] } };
  assert.deepEqual(validateBinding(family, bind), bind);
  const cell = { ...bind, state: 'growing', arm: 'b', appearance: 'dark' };
  assert.deepEqual(validateBinding(family, cell), cell);
  assert.deepEqual(validateBinding(family, { ...cell, appearance: null }), { ...cell, appearance: null });
  for (const [extra, message] of [[{ slotKey: 'other' }, /placement/], [{ state: 'missing' }, /state/],
    [{ appearance: 'light' }, /appearance/], [{ arm: 'c' }, /arm/], [{ arm: 'control' }, /arm/]]) {
    assert.throws(() => validateBinding(family, { ...bind, ...extra }), message);
  }
  assert.throws(() => validateBinding(placement, { ...bind, state: 'empty' }), /state/);
  assert.throws(() => validateBinding(placement, { ...bind, appearance: 'dark' }), /appearance/);
  assert.throws(() => validateBinding(placement, { ...bind, arm: 'b' }), /arm/);
});

test('export uses absolute bounds with HEIGHT for taller nodes and WIDTH otherwise', () => {
  assert.deepEqual(chooseExportSettings(node, placement), { format: 'PNG', useAbsoluteBounds: true, constraint: { type: 'WIDTH', value: 1200 } });
  assert.deepEqual(chooseExportSettings({ ...node, width: 400, height: 800 }, placement),
    { format: 'PNG', useAbsoluteBounds: true, constraint: { type: 'HEIGHT', value: 900 } });
  assert.deepEqual(chooseExportSettings({ ...node, width: 1600, height: 400 }, placement),
    { format: 'PNG', useAbsoluteBounds: true, constraint: { type: 'WIDTH', value: 1200 } });
  for (const dimension of [0, -1, NaN, Infinity]) {
    assert.throws(() => chooseExportSettings({ ...node, width: dimension }, placement), /non-zero/);
    assert.throws(() => aspectRatioDifference(node, { ...placement, height: dimension }), /non-zero/);
  }
});

function pngHeader(width = 1200, height = 900) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10]);
  const view = new DataView(bytes.buffer);
  view.setUint32(8, 13);
  bytes.set([73, 72, 68, 82], 12);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes.set([8, 6, 0, 0, 0], 24);
  return bytes;
}

test('PNG dimensions come from big-endian IHDR values, including a byte-offset view', () => {
  assert.deepEqual(parsePngDimensions(pngHeader()), { width: 1200, height: 900 });
  assert.deepEqual(parsePngDimensions(pngHeader(1, 0x7fffffff)), { width: 1, height: 0x7fffffff });
  const backing = new Uint8Array(45).fill(255);
  backing.set(pngHeader(815, 600), 7);
  const dimensions = parsePngDimensions(backing.subarray(7, 40));
  assert.deepEqual(dimensions, { width: 815, height: 600 });
  assert.ok(aspectRatioDifference(dimensions, placement) < 0.02);
  assert.ok(aspectRatioDifference(parsePngDimensions(pngHeader(817, 600)), placement) > 0.02);
});

test('PNG dimensions reject malformed signatures, IHDR chunks, truncation and illegal sizes', () => {
  for (let length = 0; length < 33; length++) {
    assert.throws(() => parsePngDimensions(pngHeader().subarray(0, length)), /PNG.*IHDR/);
  }
  for (let index = 0; index < 8; index++) {
    const bytes = pngHeader();
    bytes[index] ^= 255;
    assert.throws(() => parsePngDimensions(bytes), /PNG.*IHDR/);
  }
  for (const length of [0, 12, 14, 0xffffffff]) {
    const bytes = pngHeader();
    new DataView(bytes.buffer).setUint32(8, length);
    assert.throws(() => parsePngDimensions(bytes), /PNG.*IHDR/);
  }
  const wrongType = pngHeader();
  wrongType.set([73, 68, 65, 84], 12);
  assert.throws(() => parsePngDimensions(wrongType), /PNG.*IHDR/);
  for (const value of [0, 0x80000000, 0xffffffff]) {
    assert.throws(() => parsePngDimensions(pngHeader(value, 900)), /PNG.*dimensions/);
    assert.throws(() => parsePngDimensions(pngHeader(1200, value)), /PNG.*dimensions/);
  }
});

test('aspect warning is relative to the placement aspect and uses a two percent threshold', () => {
  assert.equal(aspectRatioDifference(node, placement), 0);
  assert.ok(aspectRatioDifference({ ...node, width: 815 }, placement) < 0.02);
  assert.ok(aspectRatioDifference({ ...node, width: 817 }, placement) > 0.02);
  assert.ok(aspectRatioDifference({ ...node, width: 783 }, placement) > 0.02);
  assert.equal(aspectRatioDifference({ width: 1020, height: 1000 }, { width: 1000, height: 1000 }), 0.02);
  assert.equal(aspectRatioDifference({ width: 980, height: 1000 }, { width: 1000, height: 1000 }), 0.02);
});

test('base64 is browser-portable and matches Node for all remainder lengths', () => {
  for (const length of [1, 2, 3, 4, 255, 1024, 16385]) {
    const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
    assert.equal(decodedBase64Length(bytesToBase64(bytes)), length);
  }
  assert.throws(() => bytesToBase64(new Uint8Array()), /empty PNG/);
  assert.throws(() => bytesToBase64(new Uint8Array(MAX_IMAGE_BYTES + 1)), /4 MiB/);
  for (const bad of ['', 'abc', 'a===', '=abc', 'aa=a', 'ab==', 'aab=', 'AA==\n', 'data:image/png;base64,AA==', '____']) {
    assert.throws(() => decodedBase64Length(bad), /base64/);
  }
});

test('draft body contains only the source export and chosen binding contract', () => {
  assert.deepEqual(makeBody(), {
    schemaVersion: 1, name: 'Hero / Coast', mime: 'image/png', imageBase64: png,
    source: { provider: 'figma', fileKey: 'abc123', nodeId: '12:34', nodeName: 'Hero / Coast', versionId: null,
      export: { format: 'PNG', constraint: { type: 'WIDTH', value: 1200 } } },
    bind, rebind: false,
  });
  const family = { ...placement, states: ['empty', 'growing'], defaultState: 'empty', variants: { arm: ['b'], appearance: ['dark'] } };
  const cell = { ...bind, state: 'growing', arm: 'b', appearance: 'dark' };
  assert.deepEqual(makeBody({ placement: family, bind: cell, rebind: true }).bind, cell);
  assert.equal(makeBody({ rebind: true }).rebind, true);
  const named = makeBody({ node: { ...node, name: 'x'.repeat(250) } });
  assert.equal(named.name.length, 120);
  assert.equal(named.source.nodeName.length, 200);
  assert.equal(makeBody({ node: { ...node, name: ' ' } }).name, placement.key);
  for (const fileKey of ['', 'bad/key', 'x'.repeat(129)]) assert.throws(() => makeBody({ fileKey }), /file URL/);
  for (const id of ['', 'bad_id', 'x'.repeat(65)]) assert.throws(() => makeBody({ node: { ...node, id } }), /node id/);
  assert.throws(() => makeBody({ settings: { format: 'PNG', useAbsoluteBounds: true, constraint: { type: 'WIDTH', value: 600 } } }), /Export again/);
  for (const useAbsoluteBounds of [undefined, false]) {
    assert.throws(() => makeBody({ settings: { ...chooseExportSettings(node, placement), useAbsoluteBounds } }), /Export again/);
  }
  assert.throws(() => makeBody({ bind: { ...bind, arm: 'b' } }), /arm/);
});

test('decoded upload and UTF-8 JSON body limits are bounded independently', () => {
  const fitting = Buffer.alloc(3 * 1024 * 1024).toString('base64');
  assert.equal(makeBody({ bytesBase64: fitting }).imageBase64.length, fitting.length);
  const maximumImage = Buffer.alloc(MAX_IMAGE_BYTES).toString('base64');
  assert.equal(decodedBase64Length(maximumImage), MAX_IMAGE_BYTES);
  // Within the decoded bound, but its base64 JSON body is above Vercel's 4.5 MB request limit.
  assert.throws(() => makeBody({ bytesBase64: maximumImage }), /4\.5 MB/);
  assert.throws(() => makeBody({ bytesBase64: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }), /4 MiB/);
  assert.equal(utf8Length('abcéท🙂'), Buffer.byteLength('abcéท🙂'));
  assertDraftBodyLimit('a'.repeat(MAX_BODY_BYTES - 2));
  assert.throws(() => assertDraftBodyLimit('a'.repeat(MAX_BODY_BYTES - 1)), /4\.5 MB/);
  assert.throws(() => assertDraftBodyLimit('🙂'.repeat(MAX_BODY_BYTES / 4)), /4\.5 MB/);
});

test('successful draft results retain returned dimensions and remembered source details', () => {
  assert.deepEqual(parseDraftResponse(result), result);
  const synced = { ...result, previous: { assetId: 'asset-old', boundTo: [bind] },
    rebound: [bind, { ...bind, state: 'growing', appearance: 'dark', arm: 'b' }] };
  assert.deepEqual(parseDraftResponse(synced), synced);
  assert.throws(() => parseDraftResponse({ error: 'Missing asset' }), /created draft asset/);
  assert.throws(() => parseDraftResponse({ ...result, asset: { ...result.asset, width: 0 } }), /invalid draft asset/);
  assert.throws(() => parseDraftResponse({ ...result, rebound: [{ ...bind, arm: 'control' }] }), /invalid draft binding/);
});

test('409 binding failure remains a created draft with the console error and any rebindings', () => {
  const partial = { ...result, bound: null, bindError: 'Every state cell image must match the placement canvas dimensions exactly.',
    previous: { assetId: 'asset-old', boundTo: [bind] }, rebound: [bind] };
  const parsed = parseDraftResponse(partial);
  assert.equal(parsed.asset.id, 'asset-new');
  assert.equal(parsed.bound, null);
  assert.equal(parsed.bindError, partial.bindError);
  assert.deepEqual(parsed.rebound, [bind]);
  assert.equal(mapHttpError(409, partial), partial.bindError);
  assert.equal(mapHttpError(409, { error: 'This arm is not declared by the placement.' }), 'This arm is not declared by the placement.');
});

test('errors explain token scopes, payload size, console conflicts, and the called origin', () => {
  assert.match(mapHttpError(401, { error: 'server detail' }), /token.*Tokens panel/);
  assert.match(mapHttpError(403, null), /draft scope/);
  assert.match(mapHttpError(413, null), /too large.*smaller export constraint/);
  assert.match(mapHttpError(429, null), /Wait a moment/);
  assert.match(mapHttpError(409, null), /could not bind/);
  assert.equal(mapHttpError(409, { error: { message: 'Canvas does not match.' } }), 'Canvas does not match.');
  assert.match(mapHttpError(500, null), /HTTP 500/);
  assert.equal(mapHttpError(400, { message: 'Invalid file key.' }), 'Invalid file key.');
  assert.match(mapNetworkError(DEVELOPMENT_ORIGIN), /http:\/\/localhost:3100/);
});

// ---- Insert ----
const assetId = '7f2b3c4d-1111-4abc-8def-0123456789ab';
const otherId = '7f2b3c4d-2222-4abc-8def-0123456789ab';
const hash = n => n.toString(16).padStart(64, '0');
const item = (n, mime, width, height, bytes = 1000) => ({ sha256: hash(n), mime, bytes, width, height, url: `/api/apps/o/a/assets/${assetId}/renditions/${hash(n)}` });
const strip = ({ url, ...rest }) => rest;
const libraryAsset = (renditions, extra = {}) => ({ id: assetId, name: 'Coast', width: 1200, height: 900, createdAt: '2026-10-09T00:00:00.000Z',
  processingIntent: 'artwork', source: { provider: 'figma', fileKey: 'abc', nodeId: '1:2' }, renditions, ...extra });
const family = { key: 'onboarding.hero', screen: 'Onboarding', width: 1200, height: 900, states: ['empty', 'growing'], defaultState: 'empty',
  variants: { appearance: ['dark'], arm: ['b'] }, origin: 'declared' };
const art = (id, arm = null, appearance = null) => ({ assetId: id, via: { arm, appearance } });
function familyCells() {
  const cells = [];
  for (const arm of [null, 'b']) for (const appearance of [null, 'dark']) for (const state of ['empty', 'growing']) {
    cells.push({ state, appearance, arm, draft: arm === 'b' && appearance === 'dark' ? art(otherId, 'b', 'dark') : art(assetId), staging: art(assetId), production: null });
  }
  return cells;
}
const artworkPayload = (overrides = {}) => ({
  environments: { staging: { sequence: 7, createdAt: '2026-10-09T04:47:08.642Z' }, production: null },
  placements: [{ ...family, cells: familyCells() }],
  assets: { [assetId]: libraryAsset([item(1, 'image/png', 1200, 900)]), [otherId]: libraryAsset([item(2, 'image/webp', 1200, 900)], { id: otherId, name: 'Dark b' }) },
  ...overrides,
});

test('insert picks the largest PNG or WebP within 4 MiB and 4096 px, preferring PNG on a tie', () => {
  const png1200 = item(1, 'image/png', 1200, 900);
  const webp1200 = item(2, 'image/webp', 1200, 900);
  const webp512 = item(3, 'image/webp', 512, 384);
  const svg = item(4, 'image/svg+xml', 2048, 2048);
  const bigPng = item(5, 'image/png', 2048, 1536, MAX_INSERT_DOWNLOAD + 1);
  assert.deepEqual(insertRendition({ renditions: [webp512, webp1200, png1200, svg, bigPng] }), png1200, 'PNG wins the tie; SVG and over-cap are skipped');
  assert.deepEqual(insertRendition({ renditions: [png1200, webp1200] }), png1200);
  assert.deepEqual(insertRendition({ renditions: [webp512, item(6, 'image/webp', 2048, 1536, MAX_INSERT_DOWNLOAD)] }).sha256, hash(6), 'exactly 4 MiB is allowed');
  assert.deepEqual(insertRendition({ renditions: [webp512, bigPng] }), webp512, 'a smaller version is the fallback');
  assert.equal(insertRendition({ renditions: [bigPng, svg, item(7, 'image/png', 5000, 10, 100)] }), null);
  assert.equal(insertRendition({ renditions: [] }), null);
  assert.deepEqual(thumbnailRendition({ renditions: [png1200, webp1200, webp512, svg] }), webp512, 'the smallest WebP');
  assert.deepEqual(thumbnailRendition({ renditions: [png1200, item(8, 'image/png', 256, 192), svg] }).sha256, hash(8), 'else the smallest PNG');
  assert.equal(thumbnailRendition({ renditions: [svg] }), null);
  const heavyWebp = item(9, 'image/webp', 64, 64, MAX_PREVIEW_BYTES + 1);
  assert.deepEqual(thumbnailRendition({ renditions: [heavyWebp, item(10, 'image/png', 128, 128, MAX_PREVIEW_BYTES)] }).sha256, hash(10), 'a version over the preview cap is skipped');
  assert.equal(thumbnailRendition({ renditions: [heavyWebp, item(11, 'image/png', 2048, 2048, 3 * 1024 * 1024)] }), null, 'no preview rather than a multi-MiB one');
});

test('artwork parses contracts, cells, and environments, ignoring rendition urls and sources', () => {
  const parsed = parseArtwork(artworkPayload());
  assert.deepEqual(parsed.environments, { staging: { sequence: 7, createdAt: '2026-10-09T04:47:08.642Z' }, production: null });
  assert.deepEqual(parsePlacements({ placements: parsed.placements }), [family]);
  assert.equal(parsed.placements[0].cells.length, 8);
  assert.deepEqual(parsed.assets[assetId], { id: assetId, name: 'Coast', width: 1200, height: 900, processingIntent: 'artwork', renditions: [strip(item(1, 'image/png', 1200, 900))] });
  const cell = findCell(parsed.placements[0], { state: 'growing', appearance: 'dark', arm: 'b' });
  assert.deepEqual(cell.draft, art(otherId, 'b', 'dark'));
  assert.deepEqual(artworkAsset(parsed, cell.draft).name, 'Dark b');
  assert.equal(artworkAsset(parsed, { assetId: '7f2b3c4d-3333-4abc-8def-0123456789ab', via: { arm: null, appearance: null } }), null, 'a missing asset is unavailable');
  assert.equal(artworkAsset(parsed, null), null);
  assert.deepEqual(baseCoordinate(family), { state: 'empty', appearance: null, arm: null });
  assert.equal(findCell(parsed.placements[0], { state: null, appearance: null, arm: null }), null, 'a stateful placement has no null state');
  assert.deepEqual(parseArtwork(artworkPayload({ environments: { staging: null, production: null }, placements: [], assets: {} })).placements, []);
});

test('artwork rejects illegal coordinates and inheritance, and drops an invalid image instead of failing', () => {
  const withCell = change => artworkPayload({ placements: [{ ...family, cells: [{ ...familyCells()[0], ...change }] }] });
  for (const change of [{ state: null }, { state: 'missing' }, { state: '__proto__' }, { appearance: 'light' }, { appearance: 'any' },
    { arm: 'c' }, { arm: 'control' }, { draft: art('not-a-uuid') }, { draft: { assetId } }, { staging: art(assetId, 'b', null) },
    { production: art(assetId, null, 'dark') }, { draft: undefined }]) {
    assert.throws(() => parseArtwork(withCell(change)), /invalid placement artwork/, JSON.stringify(change));
  }
  const stateless = { ...family, states: null, defaultState: null };
  assert.throws(() => parseArtwork(artworkPayload({ placements: [{ ...stateless, cells: [{ ...familyCells()[0] }] }] })), /invalid placement artwork/, 'a stateless cell has a null state');
  assert.throws(() => parseArtwork(artworkPayload({ placements: [{ ...family, cells: [familyCells()[0], familyCells()[0]] }] })), /invalid placement artwork/, 'duplicate cells');
  assert.throws(() => parseArtwork(artworkPayload({ placements: [{ ...family, cells: Array.from({ length: 241 }, () => familyCells()[0]) }] })), /invalid placement artwork/);
  assert.throws(() => parseArtwork(artworkPayload({ placements: [{ ...family, cells: null }] })), /invalid placement artwork/);
  assert.throws(() => parseArtwork(artworkPayload({ placements: [{ ...family, width: 0, cells: [] }] })), /invalid placement/);
  assert.throws(() => parseArtwork(artworkPayload({ environments: { staging: { sequence: -1, createdAt: 'x' }, production: null } })), /invalid placement artwork/);
  for (const value of [null, [], { placements: [] }, { environments: {}, placements: {}, assets: {} }]) assert.throws(() => parseArtwork(value));

  const assets = { [assetId]: libraryAsset([item(1, 'image/png', 1200, 900)], { width: 0 }), [otherId]: libraryAsset([], { id: assetId }),
    '7f2b3c4d-4444-4abc-8def-0123456789ab': libraryAsset([item(9, 'image/avif', 10, 10), item(10, 'image/png', 0, 10), item(11, 'image/webp', 10, 10)], { id: '7f2b3c4d-4444-4abc-8def-0123456789ab' }) };
  const parsed = parseArtwork(artworkPayload({ assets }));
  assert.deepEqual(Object.keys(parsed.assets), ['7f2b3c4d-4444-4abc-8def-0123456789ab'], 'invalid dimensions and a mismatched key are dropped');
  assert.deepEqual(parsed.assets['7f2b3c4d-4444-4abc-8def-0123456789ab'].renditions, [strip(item(11, 'image/webp', 10, 10))], 'unknown formats and invalid versions are skipped');
  assert.equal(Object.getPrototypeOf(parseArtwork(artworkPayload({ assets: JSON.parse('{"__proto__": {"id": "x"}}') })).assets), Object.prototype);
});

test('image pages parse assets and a uuid cursor, dropping invalid assets', () => {
  const page = parseAssetPage({ assets: [libraryAsset([item(1, 'image/png', 1200, 900)], { processingIntent: null }), { id: 'bad' }, libraryAsset([], { name: 42 })], nextCursor: assetId });
  assert.deepEqual(page, { assets: [{ id: assetId, name: 'Coast', width: 1200, height: 900, processingIntent: null, renditions: [strip(item(1, 'image/png', 1200, 900))] }], nextCursor: assetId });
  assert.deepEqual(parseAssetPage({ assets: [], nextCursor: null }), { assets: [], nextCursor: null });
  for (const value of [null, { assets: {} }, { assets: [], nextCursor: 'x' }, { assets: [] }]) assert.throws(() => parseAssetPage(value), /invalid image list/);
});

test('layer names list the key, arm, appearance, and a non-default state within 200 characters', () => {
  assert.equal(layerName(family, { state: 'growing', appearance: 'dark', arm: 'b' }), 'onboarding.hero · b · dark · growing');
  assert.equal(layerName(family, { state: 'empty', appearance: 'dark', arm: null }), 'onboarding.hero · dark', 'the default state is left out');
  assert.equal(layerName({ ...family, states: null, defaultState: null }, { state: null, appearance: null, arm: null }), 'onboarding.hero');
  assert.equal(Array.from(layerName({ ...family, key: '🙂'.repeat(300) }, { state: null, appearance: null, arm: null })).length, 200);
  assert.equal(sanitizeName(' Coast\u0000 house\u009f\n '), 'Coast house');
  assert.equal(sanitizeName('\u0007'), 'Assetlib image');
  assert.equal(sanitizeName(42), 'Assetlib image');
  assert.equal(sanitizeName('x'.repeat(250)).length, 200);
  assert.equal(environmentLabel('production'), 'Production');
});

test('stored links never throw, match only their own node in the same app, and accept the legacy host', () => {
  const link = { v: 1, origin: PRODUCTION_ORIGIN, orgId: 'org-1', appId: 'app-1', placementKey: 'onboarding.hero', state: 'growing',
    appearance: 'dark', arm: 'b', environment: 'staging', assetId, nodeId: '12:34', insertedAt: '2026-10-09T00:00:00.000Z' };
  const connection = { origin: PRODUCTION_ORIGIN, orgId: 'org-1', appId: 'app-1', token: 'draft_secret' };
  assert.deepEqual(parseStoredLink(JSON.stringify({ ...link, token: 'draft_secret', extra: true })), link, 'unknown fields are dropped');
  for (const raw of ['', '{', 'null', '[]', '"text"', JSON.stringify({ ...link, v: 2 }), JSON.stringify({ ...link, nodeId: 'a b' }),
    JSON.stringify({ ...link, assetId: 'x' }), JSON.stringify({ ...link, environment: 'preview' }), JSON.stringify({ ...link, orgId: '../x' }),
    JSON.stringify({ ...link, state: 'Bad' }), JSON.stringify({ ...link, insertedAt: undefined })]) {
    assert.equal(parseStoredLink(raw), null, raw);
  }
  assert.equal(parseStoredLink(undefined), null);
  assert.equal(linkMatches(link, connection, '12:34'), true);
  assert.equal(linkMatches(link, connection, '12:35'), false, 'a copy has another node id');
  assert.equal(linkMatches(link, { ...connection, appId: 'app-2' }, '12:34'), false);
  assert.equal(linkMatches(link, { ...connection, orgId: 'org-2' }, '12:34'), false);
  assert.equal(linkMatches(link, { ...connection, origin: DEVELOPMENT_ORIGIN }, '12:34'), false);
  assert.equal(linkMatches({ ...link, origin: LEGACY_PRODUCTION_ORIGIN }, connection, '12:34'), true);
  assert.deepEqual(validateInsertLink({ ...link, nodeId: undefined, extra: 1 }),
    { placementKey: 'onboarding.hero', state: 'growing', appearance: 'dark', arm: 'b', environment: 'staging', assetId });
  for (const change of [{ placementKey: '' }, { arm: 'control' }, { appearance: 'any' }, { environment: 'live' }, { assetId: 'x' }]) {
    assert.throws(() => validateInsertLink({ ...link, ...change }), /link is invalid/);
  }
});

test('library URLs are built from validated ids and encoded query values, never from response URLs', () => {
  const connection = { origin: PRODUCTION_ORIGIN, orgId: 'org-1', appId: 'app-1' };
  const base = `${PRODUCTION_ORIGIN}/api/apps/org-1/app-1`;
  assert.equal(apiUrl(connection, 'placements/artwork'), `${base}/placements/artwork`);
  assert.equal(assetsUrl(connection), `${base}/assets`);
  assert.equal(assetsUrl(connection, { limit: 24 }), `${base}/assets?limit=24`);
  assert.equal(assetsUrl(connection, { limit: 24, cursor: assetId, q: ' coast & ridge/#?= ' }), `${base}/assets?limit=24&cursor=${assetId}&q=coast%20%26%20ridge%2F%23%3F%3D`);
  assert.equal(assetsUrl(connection, { q: '   ' }), `${base}/assets`);
  assert.equal(assetsUrl(connection, { q: 'co\u0000a\tst\u007f' }), `${base}/assets?q=coast`, 'control characters never reach the console');
  assert.equal(assetsUrl(connection, { q: '\u0007' }), `${base}/assets`);
  assert.equal(assetsUrl(connection, { q: 'é'.repeat(130) }), `${base}/assets?q=${encodeURIComponent('é'.repeat(120))}`);
  for (const query of [{ limit: 0 }, { limit: 51 }, { limit: 1.5 }, { cursor: 'x' }, { cursor: `${assetId}&q=1` }]) assert.throws(() => assetsUrl(connection, query));
  assert.equal(renditionUrl(connection, assetId.toUpperCase(), hash(1)), `${base}/assets/${assetId}/renditions/${hash(1)}`);
  for (const [id, sha] of [['x', hash(1)], [`${assetId}/../x`, hash(1)], [assetId, 'A'.repeat(64)], [assetId, hash(1).slice(1)], [assetId, `${hash(1)}?x`]]) {
    assert.throws(() => renditionUrl(connection, id, sha), /invalid image reference/);
  }
  assert.throws(() => renditionUrl({ ...connection, origin: 'https://evil.test' }, assetId, hash(1)));
});

test('pngSize reads IHDR dimensions without throwing, and plain base64 matches Node', () => {
  assert.deepEqual(pngSize(pngHeader(4096, 1)), { width: 4096, height: 1 });
  for (const bytes of [new Uint8Array(), pngHeader().subarray(0, 32), pngHeader(0, 10), pngHeader(10, 0x80000000), new Uint8Array(40), [137, 80, 78, 71], null, 'png']) {
    assert.equal(pngSize(bytes), null);
  }
  const backing = new Uint8Array(50);
  backing.set(pngHeader(64, 32), 9);
  assert.deepEqual(pngSize(backing.subarray(9, 42)), { width: 64, height: 32 });
  assert.equal(isUint8Array(Buffer.from('x')), true);
  assert.equal(isUint8Array(new Uint16Array(1)), false);
  for (const length of [0, 1, 2, 3, 16385, MAX_IMAGE_BYTES + 1]) {
    const bytes = Uint8Array.from({ length }, (_, index) => (index * 7) % 256);
    assert.equal(encodeBase64(bytes), Buffer.from(bytes).toString('base64'));
  }
});

test('insert errors explain the read scope and an older console, and send errors are unchanged', () => {
  assert.equal(mapHttpError(403, null, 'insert'), 'This token cannot read this app’s images. Use a token with the draft scope for this organization and app.');
  assert.match(mapHttpError(403, null), /does not allow drafts/);
  assert.equal(mapHttpError(404, { error: 'Rendition not found.' }, 'insert'), MISSING_INSERT);
  assert.equal(mapHttpError(404, { error: 'Placement not found.' }), 'Placement not found.');
  assert.equal(mapHttpError(401, null, 'insert'), mapHttpError(401, null));
  assert.equal(mapHttpError(429, null, 'insert'), mapHttpError(429, null));
  assert.equal(mapHttpError(400, { error: 'Invalid cursor.' }, 'insert'), 'Invalid cursor.');
  assert.match(insertUnavailable(DEVELOPMENT_ORIGIN), /^This console does not support Insert yet, or http:\/\/localhost:3100 could not be reached\. Send still works/);
});

test('preferences fall back field by field to Send, Placements, Draft, and 1×', () => {
  assert.deepEqual(defaultPreferences(), { tab: 'send', browse: 'placements', environment: 'draft', scale: 1 });
  assert.deepEqual(parsePreferences({ tab: 'insert', browse: 'images', environment: 'production', scale: 3, extra: true }),
    { tab: 'insert', browse: 'images', environment: 'production', scale: 3 });
  assert.deepEqual(parsePreferences({ tab: 'publish', browse: 'images', environment: 'live', scale: '2' }),
    { tab: 'send', browse: 'images', environment: 'draft', scale: 1 });
  for (const value of [undefined, null, 'text', []]) assert.deepEqual(parsePreferences(value), defaultPreferences());
});

test('placementMarker names the placement for coding agents and links the console, never with the token', () => {
  const connection = { origin: PRODUCTION_ORIGIN, orgId: 'org_1', appId: 'app-2', token: 'alk_secret' };
  const marker = placementMarker(connection, placement.key, placement);
  assert.match(marker.description, /^Assetlib placement travel\.coast \(1200 × 900\)\. /);
  assert.match(marker.description, /use the accessor generated for travel\.coast from assetlib\.catalog\.json/);
  assert.equal(marker.documentationUrl, `${PRODUCTION_ORIGIN}/w/org_1/app-2/placements`);
  assert.ok(!JSON.stringify(marker).includes('alk_secret'));
  assert.equal(placementMarker({ ...connection, origin: LEGACY_PRODUCTION_ORIGIN }, 'a', placement).documentationUrl,
    `${PRODUCTION_ORIGIN}/w/org_1/app-2/placements`, 'the legacy host links to production');
  assert.equal(placementMarker({ ...connection, origin: DEVELOPMENT_ORIGIN }, 'a', placement).documentationUrl, `${DEVELOPMENT_ORIGIN}/w/org_1/app-2/placements`);
  assert.equal(placementMarker({ ...connection, origin: 'https://example.com' }, 'a', placement).documentationUrl, null);
  assert.equal(placementMarker({ ...connection, orgId: '../x' }, 'a', placement).documentationUrl, null);
  assert.match(placementMarker(connection, ' hero\u0007.art\n ', placement).description, /^Assetlib placement hero\.art \(/, 'control characters are stripped');
});
