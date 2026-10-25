import test from 'node:test';
import assert from 'node:assert/strict';
import { imageUsage, sameUsagePlacement } from '../.test-build/shared/image-usage.js';

const placement = { key: 'home.hero', screen: 'Home', width: 400, height: 200, slotId: 'slot-a', states: null, defaultState: null, variants: { appearance: ['dark'] } };
const art = id => ({ assetId: id, via: { arm: null, appearance: null } });
const fixture = () => ({ environments: { staging: { sequence: 1 }, production: { sequence: 2 } }, assets: { a: {}, b: {} }, placements: [{ ...placement, cells: [
  { state: null, arm: null, appearance: null, draft: art('a'), staging: art('b'), production: art('a') },
  { state: null, arm: null, appearance: 'dark', draft: art('a'), staging: art('b'), production: art('b') },
] }] });
test('image usage deduplicates placements and preserves actual environment labels', () => {
  const result = imageUsage(fixture(), [placement], 'a');
  assert.equal(result.complete, true); assert.equal(result.uses.length, 1);
  assert.deepEqual(result.uses[0].environments, ['draft', 'production']);
  assert.deepEqual(imageUsage(fixture(), [placement], 'b').uses[0].environments, ['staging', 'production']);
  assert.equal(imageUsage(fixture(), [placement], 'c').complete, true);
  assert.equal(imageUsage(fixture(), [placement], 'c').uses.length, 0);
});
test('image usage accepts the real contract-only catalog beside artwork with a placement id', () => {
  const { slotId, ...declared } = placement;
  const result = imageUsage(fixture(), [declared], 'a');
  assert.equal(result.complete, true); assert.equal(result.uses.length, 1);
  assert.deepEqual(result.uses[0].environments, ['draft', 'production']);
  assert.equal(imageUsage(fixture(), [{ ...declared, width: 500 }], 'a').complete, false);
});
test('usage contracts ignore axis order but retain defaults, dimensions and conflicting known ids', () => {
  const a = { ...placement, states: ['ready', 'empty'], defaultState: 'ready', variants: { appearance: ['light', 'dark'], arm: ['b', 'a'] } };
  const b = { ...a, states: ['empty', 'ready'], variants: { arm: ['a', 'b'], appearance: ['dark', 'light'] } };
  assert.equal(sameUsagePlacement(a, b), true);
  for (const change of [{ defaultState: 'empty' }, { height: 800 }, { screen: 'Settings' }, { slotId: 'other' }, { key: 'home.other' }, { states: ['ready', 'gone'] }]) {
    assert.equal(sameUsagePlacement(a, { ...b, ...change }), false);
  }
});
test('image usage never treats incomplete grids, missing asset resolutions or absent catalogs as complete', () => {
  for (const change of [item => item.placements[0].cells.pop(), item => delete item.assets.b,
    item => item.placements.push({ ...item.placements[0], key: 'removed.hero' }), item => item.environments.production = null]) {
    const item = fixture(); change(item); assert.equal(imageUsage(item, [placement], 'c').complete, false);
  }
  assert.equal(imageUsage(fixture(), null, 'a').complete, false);
  assert.deepEqual(imageUsage(fixture(), null, 'a').uses, []);
  for (const changed of [{ ...placement, slotId: 'replacement' }, { ...placement, width: 800 }]) {
    const result = imageUsage(fixture(), [changed], 'a'); assert.equal(result.complete, false); assert.deepEqual(result.uses, []);
  }
});
