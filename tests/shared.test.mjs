import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {
  MAX_BODY_BYTES, MAX_IMAGE_BYTES, MAX_INSERT_DOWNLOAD, MAX_PREVIEW_BYTES, MISSING_INSERT, PRODUCTION_ORIGIN, DEVELOPMENT_ORIGIN, LEGACY_PRODUCTION_ORIGIN,
  apiUrl, artworkAsset, aspectMismatch, aspectRatioDifference, assertDraftBodyLimit, assetsUrl, baseCoordinate, buildDraftBody, bytesToBase64,
  cellOptions, chooseExportSettings, connectionErrorField, decodedBase64Length, matchedHeight, ratioLabel, sizeLabel, defaultPreferences, encodeBase64, environmentLabel, findCell,
  insertRendition, insertUnavailable, isUint8Array, layerName, linkMatches, loadSavedConnection, mapHttpError, mapNetworkError,
  normalizeConsoleOrigin, parseArtwork, parseAssetPage, parseDraftResponse, parseFileKey, parsePlacements, parsePngDimensions,
  parsePreferences, parseStoredLink, placementMarker, pngSize, renditionUrl, sanitizeName, thumbnailRendition, tokenPrefix,
  utf8Length, validArm, validateBinding, validateConnection, validateInsertLink,
  appUrl, assetsPath, renditionPath, mapTimeoutError, parseRetryAfter, requestTimeoutMs, retryDelayMs,
  OLDER_CONSOLE, TOKEN_REFUSED, TOKEN_SCOPE, appearanceLabel, checkTokenFormat, connectionLabel, consoleLink, isConsoleLink, parseTokenIdentity,
  placementMeta, serverError, tokenUrl,
} from '../.test-build/shared/index.js';
import { UNREADABLE_MESSAGE, messageRequestId, parseUiMessage, toastText } from '../.test-build/shared/protocol.js';

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
    assert.throws(() => parseFileKey(url), /^Error: That isn’t a link to a Figma design file\. In Figma, press Cmd\+L to copy this file’s link, then paste it here\.$/);
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
  assert.throws(() => validateConnection({ ...connection, orgId: '../other' }), /organization ID from Settings › General/);
  assert.throws(() => validateConnection({ ...connection, appId: '' }), /app ID from Settings › General/);
  assert.throws(() => validateConnection({ ...connection, token: 'with space' }), /Draft token from Settings › Tokens/);
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

// What people read for any of them: one plain sentence and the next step, never which field the console got wrong.
const unreadablePlacements = /^Error: The console sent placements the plugin can’t read\. Try again\.$/;

test('placements reject malformed response shapes, states, dimensions, and duplicate keys', () => {
  for (const value of [null, [], { slots: [] }, { placements: [null] }, { placements: [placement, placement] }]) {
    assert.throws(() => parsePlacements(value), unreadablePlacements);
  }
  for (const extra of [{ width: 0 }, { height: Infinity }, { width: 1.5 }, { key: '' }, { origin: 'unknown' },
    { states: { empty: 'asset-id' }, defaultState: 'empty' },
    { states: ['empty'], defaultState: 'empty' },
    { states: ['empty', 'empty'], defaultState: 'empty' },
    { states: ['empty', 'growing'], defaultState: 'missing' },
    { states: ['empty', 'constructor'], defaultState: 'empty' }, { defaultState: 'empty' }]) {
    assert.throws(() => parsePlacements({ placements: [{ ...placement, ...extra }] }), unreadablePlacements);
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
    assert.throws(() => parsePlacements({ placements: [{ ...placement, variants }] }), unreadablePlacements);
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
    assert.throws(() => chooseExportSettings({ ...node, width: dimension }, placement), /^Error: This layer has no visible area to export\.$/);
    assert.throws(() => aspectRatioDifference(node, { ...placement, height: dimension }), /no visible area/);
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
    assert.throws(() => parsePngDimensions(pngHeader().subarray(0, length)), /couldn’t export this layer/);
  }
  for (let index = 0; index < 8; index++) {
    const bytes = pngHeader();
    bytes[index] ^= 255;
    assert.throws(() => parsePngDimensions(bytes), /couldn’t export this layer/);
  }
  for (const length of [0, 12, 14, 0xffffffff]) {
    const bytes = pngHeader();
    new DataView(bytes.buffer).setUint32(8, length);
    assert.throws(() => parsePngDimensions(bytes), /couldn’t export this layer/);
  }
  const wrongType = pngHeader();
  wrongType.set([73, 68, 65, 84], 12);
  assert.throws(() => parsePngDimensions(wrongType), /couldn’t export this layer/);
  for (const value of [0, 0x80000000, 0xffffffff]) {
    assert.throws(() => parsePngDimensions(pngHeader(value, 900)), /couldn’t export this layer/);
    assert.throws(() => parsePngDimensions(pngHeader(1200, value)), /couldn’t export this layer/);
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

test('the ratio gate blocks above two percent, and a matched height keeps the width in whole pixels when it can', () => {
  const banner = { width: 1170, height: 480 };
  assert.equal(aspectMismatch({ width: 390, height: 844 }, banner), true);
  assert.equal(aspectMismatch({ width: 1170, height: 475 }, banner), false);
  assert.equal(aspectMismatch({ width: 1000, height: 1020 }, { width: 1000, height: 1000 }), false, 'exactly 2% is allowed');
  assert.equal(aspectMismatch({ width: 1000, height: 1021 }, { width: 1000, height: 1000 }), true);
  assert.equal(matchedHeight(390, banner), 160);
  assert.equal(matchedHeight(333.33, { width: 1000, height: 1000 }), 333);
  assert.equal(matchedHeight(10, { width: 3, height: 1 }), 3.33, 'rounding to 3 would miss the ratio by 11%');
  assert.equal(aspectMismatch({ width: 10, height: matchedHeight(10, { width: 3, height: 1 }) }, { width: 3, height: 1 }), false);
  assert.equal(matchedHeight(0.001, banner), 0.01, 'never below Figma’s 0.01 minimum');
  assert.throws(() => matchedHeight(0, banner), /no visible area/);
  assert.equal(ratioLabel(banner), '2.44\u00a0:\u00a01', 'no-break spaces: it never wraps at the colon');
  assert.equal(ratioLabel({ width: 1000, height: 1000 }), '1\u00a0:\u00a01');
  assert.equal(ratioLabel({ width: 390, height: 844 }), '0.46\u00a0:\u00a01');
  assert.equal(sizeLabel({ width: 390, height: 844 }), '390 × 844');
  assert.equal(sizeLabel({ width: 333.3333, height: 120.5 }), '333.33 × 120.5');
});

test('connection validation errors name their field', () => {
  const valid = { origin: PRODUCTION_ORIGIN, orgId: 'org', appId: 'app', token: 'alt_token' };
  const field = value => { try { validateConnection(value); return 'valid'; } catch (error) { return connectionErrorField(error); } };
  assert.equal(field(valid), 'valid');
  assert.equal(field({ ...valid, origin: LEGACY_PRODUCTION_ORIGIN }), 'origin');
  assert.equal(field({ ...valid, orgId: 'bad id' }), 'orgId');
  assert.equal(field({ ...valid, appId: '' }), 'appId');
  assert.equal(field({ ...valid, token: ' ' }), 'token');
  assert.equal(connectionErrorField(new Error('Could not save the connection in Figma. Please try again.')), null);
  assert.equal(connectionErrorField('token'), null);
});

test('base64 is browser-portable and matches Node for all remainder lengths', () => {
  for (const length of [1, 2, 3, 4, 255, 1024, 16385]) {
    const bytes = Uint8Array.from({ length }, (_, index) => index % 256);
    assert.equal(bytesToBase64(bytes), Buffer.from(bytes).toString('base64'));
    assert.equal(decodedBase64Length(bytesToBase64(bytes)), length);
  }
  assert.throws(() => bytesToBase64(new Uint8Array()), /couldn’t export this layer/);
  assert.throws(() => bytesToBase64(new Uint8Array(MAX_IMAGE_BYTES + 1)), /4 MiB/);
  for (const bad of ['', 'abc', 'a===', '=abc', 'aa=a', 'ab==', 'aab=', 'AA==\n', 'data:image/png;base64,AA==', '____']) {
    // The plugin encodes the export itself, so a bad encoding is a failed export to the person.
    assert.throws(() => decodedBase64Length(bad), /^Error: Figma couldn’t export this layer\. Try again, or flatten it first\.$/);
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
  for (const fileKey of ['', 'bad/key', 'x'.repeat(129)]) assert.throws(() => makeBody({ fileKey }), /file’s link/);
  for (const id of ['', 'bad_id', 'x'.repeat(65)]) assert.throws(() => makeBody({ node: { ...node, id } }), /can’t be sent/);
  assert.throws(() => makeBody({ settings: { format: 'PNG', useAbsoluteBounds: true, constraint: { type: 'WIDTH', value: 600 } } }),
    /^Error: The selection changed while sending\. Check it and send again\.$/);
  for (const useAbsoluteBounds of [undefined, false]) {
    assert.throws(() => makeBody({ settings: { ...chooseExportSettings(node, placement), useAbsoluteBounds } }), /selection changed while sending/);
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
  assert.equal(mapHttpError(401, { error: 'server detail' }), TOKEN_REFUSED);
  assert.equal(TOKEN_REFUSED, 'Assetlib didn’t accept this token. It may have been revoked. Create a new one in Settings › Tokens.');
  assert.equal(mapHttpError(403, null), TOKEN_SCOPE);
  assert.equal(TOKEN_SCOPE, 'This token can’t send drafts. Create a token with Draft permission.');
  assert.equal(mapHttpError(413, null), 'This export is too large for Assetlib (over 4 MiB). Reduce its detail or size and try again.');
  assert.equal(mapHttpError(429, null), 'Assetlib is busy. Try again in a minute.');
  assert.match(mapHttpError(409, null), /couldn’t put this image in the chosen cell/);
  assert.equal(mapHttpError(409, { error: { message: 'Canvas does not match.' } }), 'Canvas does not match.');
  // A server error never shows the console's own text or a bare HTTP code.
  assert.equal(mapHttpError(500, { error: 'Internal stack trace' }), 'Assetlib had a problem (500). Try again in a minute.');
  assert.equal(serverError(503), 'Assetlib had a problem (503). Try again in a minute.');
  assert.equal(mapHttpError(400, { message: 'Invalid file key.' }), 'Invalid file key.');
  assert.equal(mapHttpError(400, null), 'Assetlib had a problem (400). Try again in a minute.');
  assert.equal(mapNetworkError(PRODUCTION_ORIGIN), 'Can’t reach Assetlib. Check your internet connection.');
  assert.equal(mapNetworkError(DEVELOPMENT_ORIGIN), 'Can’t reach the console at localhost:3100. Check that it’s running.');
  // Developer-facing wording from before A.3 is gone from every message.
  for (const text of [mapHttpError(401, null), mapHttpError(403, null), mapHttpError(500, null), mapNetworkError(PRODUCTION_ORIGIN), insertUnavailable(PRODUCTION_ORIGIN)]) {
    assert.doesNotMatch(text, /manifest|HTTP \d|Update the console|IHDR/, text);
  }
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
    assert.throws(() => parseArtwork(withCell(change)), /placement artwork the plugin can’t read/, JSON.stringify(change));
  }
  const stateless = { ...family, states: null, defaultState: null };
  assert.throws(() => parseArtwork(artworkPayload({ placements: [{ ...stateless, cells: [{ ...familyCells()[0] }] }] })), /placement artwork the plugin can’t read/, 'a stateless cell has a null state');
  assert.throws(() => parseArtwork(artworkPayload({ placements: [{ ...family, cells: [familyCells()[0], familyCells()[0]] }] })), /placement artwork the plugin can’t read/, 'duplicate cells');
  assert.throws(() => parseArtwork(artworkPayload({ placements: [{ ...family, cells: Array.from({ length: 241 }, () => familyCells()[0]) }] })), /placement artwork the plugin can’t read/);
  assert.throws(() => parseArtwork(artworkPayload({ placements: [{ ...family, cells: null }] })), /placement artwork the plugin can’t read/);
  assert.throws(() => parseArtwork(artworkPayload({ placements: [{ ...family, width: 0, cells: [] }] })), unreadablePlacements);
  assert.throws(() => parseArtwork(artworkPayload({ environments: { staging: { sequence: -1, createdAt: 'x' }, production: null } })), /placement artwork the plugin can’t read/);
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
  for (const value of [null, { assets: {} }, { assets: [], nextCursor: 'x' }, { assets: [] }]) assert.throws(() => parseAssetPage(value), /image list the plugin can’t read/);
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
  assert.equal(mapHttpError(403, null, 'insert'), 'This token can’t read this app’s images. Create a token with Draft permission.');
  assert.equal(mapHttpError(403, null), TOKEN_SCOPE);
  assert.equal(MISSING_INSERT, 'This console doesn’t support Insert yet. Send still works.');
  assert.equal(mapHttpError(404, { error: 'Rendition not found.' }, 'insert'), MISSING_INSERT);
  assert.equal(mapHttpError(404, { error: 'Placement not found.' }), 'Placement not found.');
  assert.equal(mapHttpError(401, null, 'insert'), mapHttpError(401, null));
  assert.equal(mapHttpError(429, null, 'insert'), mapHttpError(429, null));
  assert.equal(mapHttpError(400, { error: 'Invalid cursor.' }, 'insert'), 'Invalid cursor.');
  assert.equal(insertUnavailable(DEVELOPMENT_ORIGIN), 'This console doesn’t support Insert yet, or localhost:3100 couldn’t be reached. Send still works.');
  assert.equal(insertUnavailable(PRODUCTION_ORIGIN), 'This console doesn’t support Insert yet, or Assetlib couldn’t be reached. Send still works.');
});

test('default tab is insert', () => {
  assert.equal(defaultPreferences().tab, 'insert');
  assert.equal(parsePreferences(undefined).tab, 'insert', 'a first run opens on Insert');
  assert.equal(parsePreferences({ tab: 'send' }).tab, 'send', 'a saved Send tab is kept');
});

test('preferences fall back field by field to Insert, Placements, Draft, and 1×, with optional window and hint fields', () => {
  assert.deepEqual(defaultPreferences(), { tab: 'insert', browse: 'placements', environment: 'draft', scale: 1 });
  assert.deepEqual(parsePreferences({ tab: 'send', browse: 'images', environment: 'production', scale: 3, extra: true }),
    { tab: 'send', browse: 'images', environment: 'production', scale: 3 });
  assert.deepEqual(parsePreferences({ tab: 'publish', browse: 'images', environment: 'live', scale: '2' }),
    { tab: 'insert', browse: 'images', environment: 'draft', scale: 1 });
  for (const value of [undefined, null, 'text', []]) assert.deepEqual(parsePreferences(value), defaultPreferences());
  // The new fields are kept only when valid, and are absent otherwise, so saved preferences keep their shape.
  assert.deepEqual(parsePreferences({ window: { width: 420, height: 640 }, hintSeen: true }),
    { ...defaultPreferences(), window: { width: 420, height: 640 }, hintSeen: true });
  for (const window of [{ width: 319, height: 640 }, { width: 420, height: 1001 }, { width: 420.5, height: 640 }, { width: '420', height: 640 }, [420, 640], null]) {
    assert.deepEqual(parsePreferences({ window, hintSeen: 'yes' }), defaultPreferences(), JSON.stringify(window));
  }
});

test('every request goes to one of the five app routes', () => {
  const config = { origin: PRODUCTION_ORIGIN, orgId: 'org-1', appId: 'app-1' };
  const base = `${PRODUCTION_ORIGIN}/api/apps/org-1/app-1/`;
  const id = '00000000-0000-4000-8000-000000000001';
  const hash = 'ab'.repeat(32);
  for (const path of ['placements', 'placements/artwork', 'drafts', 'assets', assetsPath({ limit: 24, cursor: id, q: 'Coast ridge & co' }), renditionPath(id.toUpperCase(), hash)]) {
    assert.equal(appUrl(config, path), `${base}${path}`, path);
  }
  assert.equal(renditionPath(id.toUpperCase(), hash), `assets/${id}/renditions/${hash}`, 'asset ids are lowercased');
  assert.equal(assetsPath({ q: ' a/b?c#d ' }), 'assets?q=a%2Fb%3Fc%23d');
  for (const path of ['releases', 'placements/publish', 'drafts/1', 'assets/../releases', `assets/${id}/renditions/${hash}/original`, 'assets#x',
    'assets?q=a b', '/placements', 'https://evil.test/placements', `assets/${id}/renditions/${hash.toUpperCase()}`, '']) {
    assert.throws(() => appUrl(config, path), /route it does not use/, path);
  }
  assert.throws(() => appUrl({ ...config, origin: LEGACY_PRODUCTION_ORIGIN }, 'placements'), /console\.assetlib\.dev/);
});

test('request timeouts: 20 s reads, 30 s drafts, plus 15 s per MiB, in whole seconds', () => {
  const mib = 1024 * 1024;
  assert.equal(requestTimeoutMs('GET'), 20000);
  assert.equal(requestTimeoutMs('POST'), 30000);
  assert.equal(requestTimeoutMs('POST', 400), 30000, 'a small body adds nothing');
  assert.equal(requestTimeoutMs('POST', 2 * mib), 60000);
  assert.equal(requestTimeoutMs('POST', 6 * mib), 120000, 'the largest draft body');
  assert.equal(requestTimeoutMs('GET', 4 * mib), 80000, 'the largest insert download');
  assert.equal(requestTimeoutMs('GET', -5), 20000);
  assert.equal(mapTimeoutError(20), 'Assetlib didn’t answer within 20 seconds. Try again.');
  assert.equal(mapTimeoutError(70, 'send'), 'Assetlib didn’t answer within 70 seconds. It may have arrived anyway, so check the console before sending again.');
});

test('Retry-After parses seconds and dates, and decides which GETs are tried again', () => {
  const now = Date.parse('2026-10-09T12:00:00Z');
  assert.equal(parseRetryAfter(null, now), null);
  assert.equal(parseRetryAfter(' 7 ', now), 7);
  assert.equal(parseRetryAfter('Fri, 09 Oct 2026 12:00:12 GMT', now), 12);
  assert.equal(parseRetryAfter('Fri, 09 Oct 2026 11:00:00 GMT', now), 0, 'a date in the past means now');
  assert.equal(parseRetryAfter('soon', now), null);
  assert.equal(parseRetryAfter('-3', now), null);
  const outcome = (kind, status = 0, retryAfter = null) => ({ kind, status, retryAfter });
  for (const failure of [outcome('network'), outcome('http', 502), outcome('http', 503), outcome('http', 504)]) {
    assert.deepEqual([0, 1, 2].map(attempt => retryDelayMs(failure, attempt)), [1000, 4000, null], JSON.stringify(failure));
  }
  assert.equal(retryDelayMs(outcome('http', 503, 10), 0), 10000, 'a longer Retry-After is honoured');
  assert.equal(retryDelayMs(outcome('http', 503, 31), 0), null, 'more than 30 s is not waited for');
  assert.deepEqual([0, 1, 2].map(attempt => retryDelayMs(outcome('http', 429, 30), attempt)), [30000, 30000, null]);
  assert.equal(retryDelayMs(outcome('http', 429, 0), 0), 1000, 'at least a second');
  assert.equal(retryDelayMs(outcome('http', 429), 0), null, 'a 429 without Retry-After is not retried');
  assert.equal(retryDelayMs(outcome('http', 429, 31), 0), null);
  for (const other of [outcome('ok', 200), outcome('http', 500), outcome('http', 404), outcome('http', 401), outcome('timeout'), outcome('aborted')]) {
    assert.equal(retryDelayMs(other, 0), null, JSON.stringify(other));
  }
});

test('main reads only well-formed messages from the UI', () => {
  const connection = { origin: PRODUCTION_ORIGIN, orgId: 'org', appId: 'app', token: 'draft_x' };
  const node = { id: '1:2', name: 'Hero', type: 'FRAME', width: 10, height: 10 };
  const good = [
    { type: 'init' },
    { type: 'save-connection', requestId: 1, connection },
    { type: 'save-file-url', requestId: 2, url: 'https://www.figma.com/design/abc/x' },
    { type: 'export', requestId: 3, node, fileKey: 'abc', placement: {}, bind: {}, rebind: false },
    { type: 'remember', requestId: 4 },
    // Main checks the bytes, frame, and scale itself, with messages of their own.
    { type: 'insert', requestId: 5, connectionGeneration: 0, bytes: [1], name: 'x', frame: null, scale: 4, link: null },
    { type: 'save-preferences', preferences: null },
    { type: 'match-ratio', requestId: 6, nodeId: '1:2', width: 1, height: 1 },
    { type: 'clear-connection', requestId: 7 },
    { type: 'notify', text: 'Synced hero.artwork to draft' },
    { type: 'notify', text: 'Sent', button: { text: 'Review', url: 'https://console.assetlib.dev/w/o/a/releases' } },
  ];
  for (const message of good) assert.equal(parseUiMessage(message), message, message.type);
  const bad = [
    null, 'init', [], { type: 3 }, { type: 'publish', requestId: 7 },
    { type: 'save-connection', connection }, { type: 'save-connection', requestId: 0, connection },
    { type: 'save-connection', requestId: 1.5, connection }, { type: 'save-connection', requestId: 8, connection: null },
    { type: 'save-connection', requestId: 8, connection: { ...connection, token: 5 } },
    { type: 'save-file-url', requestId: 9 }, { type: 'export', requestId: 10, node, fileKey: 'abc', placement: {}, bind: {} },
    { type: 'export', requestId: 10, node: { ...node, width: '10' }, fileKey: 'abc', placement: {}, bind: {}, rebind: true },
    { type: 'remember' }, { type: 'insert', requestId: 11, connectionGeneration: '0', name: 'x', link: null },
    { type: 'insert', requestId: 11, connectionGeneration: 0, name: 'x', link: 'cell' }, { type: 'save-preferences' },
    { type: 'match-ratio', requestId: 12, nodeId: 5, width: 1, height: 1 },
    { type: 'clear-connection' }, { type: 'notify' }, { type: 'notify', text: 'x', button: { text: 'Review' } }, { type: 'notify', text: 'x', button: 'Review' },
  ];
  for (const message of bad) assert.throws(() => parseUiMessage(message), { message: UNREADABLE_MESSAGE }, JSON.stringify(message));
  assert.equal(messageRequestId({ type: 'x', requestId: 7 }), 7);
  for (const value of [null, {}, { requestId: '7' }, { requestId: -1 }, { requestId: 2 ** 60 }]) assert.equal(messageRequestId(value), undefined);
});

// ---- A.3: the token form, labels, links, and toasts ----
test('a typed token must look like an Assetlib token; saved connections keep loading and keep their names', () => {
  const token = `alk_${'a'.repeat(43)}`;
  assert.equal(checkTokenFormat(` ${token} `), token);
  for (const bad of ['', 'draft_secret', `alk_${'a'.repeat(42)}`, `alk_${'a'.repeat(44)}`, `alk_${'a'.repeat(42)}!`, `figd_${'a'.repeat(43)}`]) {
    assert.throws(() => checkTokenFormat(bad), error => error.message === 'That doesn’t look like an Assetlib token. Tokens start with alk_.' && connectionErrorField(error) === 'token', bad);
  }
  // Saved connections are not checked against the format, so one saved by an earlier build still loads.
  assert.equal(loadSavedConnection({ origin: PRODUCTION_ORIGIN, orgId: 'org', appId: 'app', token: 'draft_secret' }).token, 'draft_secret');
  const named = validateConnection({ origin: PRODUCTION_ORIGIN, orgId: 'org', appId: 'app', token, workspaceName: ' Acme\u0007 ', appName: 'x'.repeat(250) });
  assert.deepEqual(named, { origin: PRODUCTION_ORIGIN, orgId: 'org', appId: 'app', token, workspaceName: 'Acme', appName: 'x'.repeat(200) });
  assert.deepEqual(validateConnection({ origin: PRODUCTION_ORIGIN, orgId: 'org', appId: 'app', token, workspaceName: 5, appName: '  ' }),
    { origin: PRODUCTION_ORIGIN, orgId: 'org', appId: 'app', token }, 'an unusable name is dropped, never an error');
  assert.equal(connectionLabel(named), 'Acme · ' + 'x'.repeat(200));
  assert.equal(connectionLabel({ orgId: 'org', appId: 'app' }), 'org · app', 'without names, the IDs');
  assert.equal(connectionLabel({ orgId: 'org', appId: 'app', appName: 'iOS' }), 'iOS');
  assert.equal(OLDER_CONSOLE, 'This console also needs the organization and app IDs. Find them in Settings › General.');
});

test('GET /api/token is built for the two console origins only, and its answer is checked', () => {
  assert.equal(tokenUrl(PRODUCTION_ORIGIN), 'https://console.assetlib.dev/api/token');
  assert.equal(tokenUrl(DEVELOPMENT_ORIGIN), 'http://localhost:3100/api/token');
  for (const origin of [LEGACY_PRODUCTION_ORIGIN, 'http://127.0.0.1:3100', 'https://evil.test']) assert.throws(() => tokenUrl(origin), /console\.assetlib\.dev/);
  assert.deepEqual(parseTokenIdentity({ orgId: 'org-1', appId: 'app-1', workspaceName: 'Acme', appName: null, scopes: ['draft', 'publish', 'declare'] }),
    { orgId: 'org-1', appId: 'app-1', workspaceName: 'Acme', appName: null, scopes: ['draft', 'declare'] });
  for (const bad of [null, {}, { orgId: '../x', appId: 'a', scopes: [] }, { orgId: 'o', appId: 'a' }, { orgId: 'o', appId: 'a b', scopes: [] }]) {
    assert.throws(() => parseTokenIdentity(bad), /can’t read/, JSON.stringify(bad));
  }
});

test('console links are built from validated ids on the connected origin, and main opens nothing else', () => {
  const config = { origin: PRODUCTION_ORIGIN, orgId: 'org-1', appId: 'app-1' };
  const image = '00000000-0000-4000-8000-00000000000A';
  assert.equal(consoleLink(config, 'releases'), 'https://console.assetlib.dev/w/org-1/app-1/releases');
  assert.equal(consoleLink(config, 'images', image), 'https://console.assetlib.dev/w/org-1/app-1/images/00000000-0000-4000-8000-00000000000a');
  for (const [section, id] of [['settings'], ['images', 'not-a-uuid'], ['releases', '00000000-0000-4000-8000-000000000001']]) {
    assert.throws(() => consoleLink(config, section, id), /not valid/, section);
  }
  assert.throws(() => consoleLink({ ...config, orgId: '../x' }, 'releases'), /not valid/);
  assert.equal(isConsoleLink('https://console.assetlib.dev/w/org-1/app-1/releases', config), true);
  assert.equal(isConsoleLink(consoleLink(config, 'images', image), config), true);
  for (const url of ['https://console.assetlib.dev/w/org-1/app-2/releases', 'https://console.assetlib.dev/w/org-1/app-1/settings/tokens',
    'https://console.assetlib.dev/w/org-1/app-1/releases/x', 'https://evil.test/w/org-1/app-1/releases', 'javascript:alert(1)', 5]) {
    assert.equal(isConsoleLink(url, config), false, String(url));
  }
  assert.equal(isConsoleLink('https://console.assetlib.dev/w/org-1/app-1/releases', null), false, 'no connection, no link');
});

test('toasts are at most 100 characters, and rows and pickers name only what a placement declares', () => {
  assert.equal(toastText('Synced  hero.artwork\nto draft'), 'Synced hero.artwork to draft');
  const long = toastText(`Inserted ${'x'.repeat(200)}`);
  assert.equal(Array.from(long).length, 100);
  assert.ok(long.endsWith('…'));
  assert.equal(placementMeta({ width: 1170, height: 1560, states: ['a', 'b'], variants: { appearance: ['light', 'dark'], arm: ['b'] } }),
    '1170 × 1560 · 2 states · light, dark · arm b');
  assert.equal(placementMeta({ width: 1170, height: 480, states: null, variants: null }), '1170 × 480');
  assert.deepEqual([null, 'light', 'dark'].map(appearanceLabel), ['Any', 'Light', 'Dark']);
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
