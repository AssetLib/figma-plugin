import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { checkContrast, readTokens } from '../scripts/contrast.mjs';

test('contrast ≥ 4.5:1 for every text token pair in both themes', async () => {
  const results = await checkContrast();
  for (const mode of ['light', 'dark', 'fallback']) {
    const text = results.filter(item => item.mode === mode && item.minimum === 4.5);
    assert.ok(text.length >= 11, `${mode}: every text pair is measured`);
  }
  const failing = results.filter(item => item.ratio < item.minimum).map(item => `${item.mode}: ${item.pair} ${item.ratio.toFixed(2)}:1`);
  assert.deepEqual(failing, [], 'text at 4.5:1 or more, the focus ring and glyphs at 3:1 or more');
  // The measurements match what the A.1 render measured for callout text (16.21:1 light, 11.73:1 dark).
  const callout = mode => results.find(item => item.mode === mode && item.pair.startsWith('text on bg-secondary')).ratio.toFixed(2);
  assert.deepEqual([callout('light'), callout('dark')], ['16.21', '11.73']);
});

test('the colour tokens are Figma theme variables with brand fallbacks, and nothing else colours text', async () => {
  const html = await readFile(new URL('../src/ui.html', import.meta.url), 'utf8');
  const tokens = readTokens(html);
  assert.deepEqual(tokens.text, { figma: '--figma-color-text', fallback: '#0b0f14' });
  assert.deepEqual(tokens.bg, { figma: '--figma-color-bg', fallback: '#ffffff' });
  // The raw UI3 text-secondary and text-tertiary measure under 4.5:1 on white and bg-secondary, so text never uses them.
  assert.doesNotMatch(html, /color:\s*var\(--figma-color-text-(secondary|tertiary)/);
  // checkContrast refuses a stylesheet with a text colour it does not measure.
  await assert.doesNotReject(checkContrast());
});
