// Contrast of every text colour pair the plugin UI uses, in Figma's light and dark themes and with the brand fallbacks
// (a page without Figma's theme). Text must reach 4.5:1; the focus ring and the callout glyphs, 3:1 (non-text).
//   node scripts/contrast.mjs        prints the table; exits 1 when a pair falls short
// The tokens come from src/ui.html's :root block; the theme values from tests/fixtures/figma-theme.json (Figma's
// documented CSS variables). Disabled controls are exempt (WCAG 1.4.3), so they are not listed.
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = new URL('../', import.meta.url);

function parseColor(value) {
  const text = value.trim().toLowerCase();
  let match = /^#([0-9a-f]{3}|[0-9a-f]{6})$/.exec(text);
  if (match) {
    const hex = match[1].length === 3 ? [...match[1]].map(c => c + c).join('') : match[1];
    return { r: parseInt(hex.slice(0, 2), 16), g: parseInt(hex.slice(2, 4), 16), b: parseInt(hex.slice(4, 6), 16), a: 1 };
  }
  match = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(text);
  if (match) return { r: Number(match[1]), g: Number(match[2]), b: Number(match[3]), a: match[4] === undefined ? 1 : Number(match[4]) };
  throw new Error(`Unreadable colour: ${value}`);
}
/** `top` drawn over an opaque `bottom`. */
function over(top, bottom) {
  const mix = channel => top[channel] * top.a + bottom[channel] * (1 - top.a);
  return { r: mix('r'), g: mix('g'), b: mix('b'), a: 1 };
}
/** color-mix(in srgb, a p%, b): premultiplied, as CSS mixes colours with alpha. */
function colorMix(a, p, b) {
  const alpha = a.a * p + b.a * (1 - p);
  if (alpha === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const channel = name => (a[name] * a.a * p + b[name] * b.a * (1 - p)) / alpha;
  return { r: channel('r'), g: channel('g'), b: channel('b'), a: alpha };
}
const TRANSPARENT = { r: 0, g: 0, b: 0, a: 0 };
function luminance({ r, g, b }) {
  const linear = value => { const c = value / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
  return 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
}
function ratio(foreground, background) {
  const base = over(background, { r: 255, g: 255, b: 255, a: 1 });
  const top = over(foreground, base);
  const [light, dark] = [luminance(top), luminance(base)].sort((x, y) => y - x);
  return (light + 0.05) / (dark + 0.05);
}

/** The plugin's colour tokens from src/ui.html: `--bg: var(--figma-color-bg, #ffffff)` gives Figma's name and the fallback. */
export function readTokens(html) {
  const block = /:root\s*\{([\s\S]*?)\n\s*\}/.exec(html)?.[1] ?? '';
  const tokens = {};
  for (const [, name, figma, fallback] of block.matchAll(/--([a-z-]+):\s*var\(--(figma-color-[a-z0-9-]+),\s*([^)]+\)?)\)\s*;/g)) tokens[name] = { figma: `--${figma}`, fallback: fallback.trim() };
  return tokens;
}

/** Every pair, measured in every theme. */
export async function checkContrast() {
  const [html, theme] = await Promise.all([readFile(new URL('src/ui.html', root), 'utf8'), readFile(new URL('tests/fixtures/figma-theme.json', root), 'utf8').then(JSON.parse)]);
  const tokens = readTokens(html);
  for (const name of ['bg', 'bg-secondary', 'bg-tertiary', 'bg-hover', 'bg-pressed', 'text']) {
    if (!tokens[name]) throw new Error(`src/ui.html no longer defines --${name} as a Figma variable with a fallback.`);
  }
  if (!/--al-text-meta:\s*color-mix\(in srgb, var\(--text\) 70%, transparent\)/.test(html)) throw new Error('--al-text-meta is no longer the text colour at 70%.');
  if (!/\.placement\[aria-pressed="true"\]:focus-visible \{ box-shadow: inset 0 0 0 3px var\(--bg\); \}/.test(html)) throw new Error('A focused selected row no longer keeps a band of bg inside its ring.');
  // Every text colour in the stylesheet is one this script measures (disabled text is exempt from the minimum).
  const allowed = new Set(['var(--text)', 'var(--al-text-meta)', 'var(--bg)', 'var(--text-disabled)', 'inherit', 'var(--figma-color-text, #0b0f14)']);
  const css = /<style>([\s\S]*?)<\/style>/.exec(html)?.[1] ?? '';
  const unmeasured = [...css.matchAll(/(?:^|[;{\s])color:\s*([^;}]+)/g)].map(match => match[1].trim()).filter(value => !allowed.has(value));
  if (unmeasured.length) throw new Error(`Text colours this script does not measure: ${[...new Set(unmeasured)].join(', ')}`);

  const focus = { light: parseColor('#b63f1b'), dark: parseColor('#e4572e'), fallback: parseColor('#b63f1b') };
  const results = [];
  for (const mode of ['light', 'dark', 'fallback']) {
    const value = name => parseColor(mode === 'fallback' ? tokens[name].fallback : theme[mode][tokens[name].figma]);
    const figma = (name, fallback) => parseColor(mode === 'fallback' ? fallback : theme[mode][name]);
    const text = value('text');
    const bg = value('bg');
    const meta = colorMix(text, 0.7, TRANSPARENT);
    const primaryHover = over(colorMix(text, 0.88, bg), over(bg, { r: 255, g: 255, b: 255, a: 1 }));
    const pairs = [
      ['text on bg (and fields and buttons inside callouts)', text, bg],
      ['text on bg-secondary (fields, callouts, active tab, chip)', text, value('bg-secondary')],
      ['text on bg-tertiary (selected row, hovered secondary buttons)', text, value('bg-tertiary')],
      ['text on bg-hover', text, value('bg-hover')],
      ['text on bg-pressed', text, value('bg-pressed')],
      ['meta on bg (and placeholders inside callouts)', meta, bg],
      ['meta on bg-secondary (placeholders, segments)', meta, value('bg-secondary')],
      ['meta on bg-tertiary (selected row)', meta, value('bg-tertiary')],
      ['meta on bg-hover', meta, value('bg-hover')],
      ['primary button: bg on text', bg, text],
      ['primary button hover: bg on mixed ink', bg, primaryHover],
    ].map(([pair, fg, back]) => ({ mode, pair, ratio: ratio(fg, back), minimum: 4.5 }));
    pairs.push(
      // A focused selected row keeps a band of bg inside its ring (ui.html), so the ring never sits on bg-tertiary.
      { mode, pair: 'focus ring on bg (rows, tiles, and the band inside a selected row)', ratio: ratio(focus[mode], bg), minimum: 3 },
      { mode, pair: 'focus ring on bg-secondary (fields, segments, secondary buttons, controls inside callouts)', ratio: ratio(focus[mode], value('bg-secondary')), minimum: 3 },
      { mode, pair: 'warning glyph: ink on the triangle', ratio: ratio(figma('--figma-color-icon-onwarning', 'rgba(0, 0, 0, .9)'), figma('--figma-color-icon-warning', '#ffcd29')), minimum: 3 },
      { mode, pair: 'danger glyph: white on the circle', ratio: ratio(figma('--figma-color-icon-ondanger', '#fff'), figma('--figma-color-icon-danger', '#b3261e')), minimum: 3 },
    );
    results.push(...pairs);
  }
  return results;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const results = await checkContrast();
  for (const { mode, pair, ratio: value, minimum } of results) {
    console.log(`${value >= minimum ? 'ok  ' : 'FAIL'} ${mode.padEnd(8)} ${value.toFixed(2).padStart(5)}:1 (min ${minimum})  ${pair}`);
  }
  if (results.some(item => item.ratio < item.minimum)) process.exit(1);
}
