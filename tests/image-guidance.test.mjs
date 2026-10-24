import test from 'node:test';
import assert from 'node:assert/strict';
import { imageGuidance } from '../.test-build/shared/image-guidance.js';
const asset = (width, height, rendition = { width, height }) => ({ width, height, renditions: [{ ...rendition, mime: 'image/png', bytes: 100 }] });
const target = (width, height, mode = 'FILL') => ({ width, height, mode });
test('image guidance reuses inclusive 2% shape tolerance independently of insertable resolution', () => {
  assert.equal(imageGuidance(asset(102, 100), target(100, 100)).matches, true);
  assert.equal(imageGuidance(asset(102.01, 100), target(100, 100)).matches, false);
  const small = imageGuidance(asset(1000, 500, { width: 100, height: 50 }), target(400, 200));
  assert.equal(small.matches, true); assert.deepEqual(small.labels, ['May need enlargement']);
  assert.match(small.detail, /100 × 50 insertable image.*layer size \(1×\), not display resolution/);
});
test('image guidance distinguishes FIT from FILL at current layer size and excludes unsupported targets', () => {
  const wide = asset(400, 100);
  assert.deepEqual(imageGuidance(wide, target(200, 200)).labels, ['May crop', 'May need enlargement']);
  assert.deepEqual(imageGuidance(wide, target(200, 200, 'FIT')).labels, ['Space around image']);
  assert.equal(imageGuidance(wide, { reason: 'Crop paint cannot be previewed.' }), null);
  assert.equal(imageGuidance(wide, null), null);
  assert.equal(imageGuidance(wide, target(0, 200)), null);
  assert.deepEqual(imageGuidance({ ...wide, renditions: [] }, target(400, 100)).labels, ['No insertable image']);
});
