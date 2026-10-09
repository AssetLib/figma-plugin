import test from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_BODY_BYTES, MAX_IMAGE_BYTES, PRODUCTION_ORIGIN, DEVELOPMENT_ORIGIN,
  apiUrl, aspectRatioDifference, assertDraftBodyLimit, buildDraftBody, bytesToBase64,
  cellOptions, chooseExportSettings, decodedBase64Length, mapHttpError, mapNetworkError,
  normalizeConsoleOrigin, parseDraftResponse, parseFileKey, parsePlacements, parsePngDimensions, tokenPrefix,
  utf8Length, validArm, validateBinding, validateConnection,
} from '../.test-build/shared/index.js';

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

test('connection origin is limited to the two manifest origins', () => {
  assert.equal(normalizeConsoleOrigin(`${PRODUCTION_ORIGIN}/`), PRODUCTION_ORIGIN);
  assert.equal(normalizeConsoleOrigin(DEVELOPMENT_ORIGIN), DEVELOPMENT_ORIGIN);
  for (const origin of ['http://localhost:3100', 'https://assetlib-console.vercel.app.evil.test',
    `${PRODUCTION_ORIGIN}/path`, `${PRODUCTION_ORIGIN}?token=secret`, `https://user:secret@assetlib-console.vercel.app`]) {
    assert.throws(() => normalizeConsoleOrigin(origin));
  }
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
  const maximumImage = Buffer.alloc(MAX_IMAGE_BYTES).toString('base64');
  assert.equal(decodedBase64Length(maximumImage), MAX_IMAGE_BYTES);
  assert.equal(makeBody({ bytesBase64: maximumImage }).imageBase64.length, maximumImage.length);
  assert.throws(() => makeBody({ bytesBase64: Buffer.alloc(MAX_IMAGE_BYTES + 1).toString('base64') }), /4 MiB/);
  assert.equal(utf8Length('abcéท🙂'), Buffer.byteLength('abcéท🙂'));
  assertDraftBodyLimit('a'.repeat(MAX_BODY_BYTES - 2));
  assert.throws(() => assertDraftBodyLimit('a'.repeat(MAX_BODY_BYTES - 1)), /6 MiB/);
  assert.throws(() => assertDraftBodyLimit('🙂'.repeat(MAX_BODY_BYTES / 4)), /6 MiB/);
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
  assert.match(mapNetworkError(DEVELOPMENT_ORIGIN), /http:\/\/127\.0\.0\.1:3100/);
});
