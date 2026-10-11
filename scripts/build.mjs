// Builds dist/code.js and a self-contained dist/ui.html (the UI bundle inlined at the ASSETLIB_SCRIPT marker).
//   node scripts/build.mjs            minified, for Figma and the tests
//   node scripts/build.mjs --dev      unminified, with inline source maps
//   node scripts/build.mjs --watch    --dev, rebuilt on every change to src/ (npm run watch)
import { build, context } from 'esbuild';
import { watch } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const args = new Set(process.argv.slice(2));
const watching = args.has('--watch');
const dev = watching || args.has('--dev');
// The release budget for dist/ui.html, embedded font included: 160 KB, in decimal units.
const MAX_UI_BYTES = 160_000;
const root = fileURLToPath(new URL('../', import.meta.url));
const templateUrl = new URL('../src/ui.html', import.meta.url);
const marker = '<!-- ASSETLIB_SCRIPT -->';
// Instrument Sans, copied from the workspace's brand/ by brand/sync.sh, is embedded as a data: URL: Figma's plugin
// window loads nothing it is not given, and a font host would need a network domain.
const fontUrl = new URL('../src/assets/instrument-sans-variable.woff2', import.meta.url);
const fontMarker = '/* ASSETLIB_FONT */';
const options = {
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  legalComments: 'none',
  logLevel: 'warning',
  minify: !dev,
  sourcemap: dev ? 'inline' : false,
};
const main = { ...options, entryPoints: ['src/code.ts'], outfile: 'dist/code.js' };
const ui = { ...options, entryPoints: ['src/ui/main.ts'], outfile: 'dist/ui.js', write: false };

const uiUrl = new URL('../dist/ui.html', import.meta.url);

/** Writes dist/ui.html; a release build over budget writes nothing and removes the previous one, so none is left to load. */
async function writeUi(script) {
  const [template, font] = await Promise.all([readFile(templateUrl, 'utf8'), readFile(fontUrl)]);
  if (template.split(marker).length !== 2) throw new Error(`src/ui.html must contain exactly one ${marker} marker.`);
  if (template.split(fontMarker).length !== 2) throw new Error(`src/ui.html must contain exactly one ${fontMarker} marker.`);
  const face = `@font-face { font-family: 'Instrument Sans'; src: url(data:font/woff2;base64,${font.toString('base64')}) format('woff2'); font-weight: 400 700; font-style: normal; font-display: block; }`;
  const html = template.replace(fontMarker, () => face).replace(marker, () => `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`);
  const size = Buffer.byteLength(html);
  if (!dev && size > MAX_UI_BYTES) {
    await rm(uiUrl, { force: true });
    throw new Error(`dist/ui.html would be ${kb(size)}, over the ${kb(MAX_UI_BYTES)} budget; it was not written.`);
  }
  await writeFile(uiUrl, html);
  return size;
}
const kb = bytes => `${(bytes / 1000).toFixed(1)} KB`;

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
if (watching) {
  const uiContext = await context({ ...ui, plugins: [{ name: 'ui-html', setup(bundle) {
    bundle.onEnd(async result => {
      if (result.errors.length || !result.outputFiles?.[0]) return;
      try { console.log(`Rebuilt dist/ui.html (${kb(await writeUi(result.outputFiles[0].text))}).`); }
      catch (error) { console.error(error instanceof Error ? error.message : error); }
    });
  } }] });
  const mainContext = await context({ ...main, plugins: [{ name: 'code-js', setup(bundle) {
    bundle.onEnd(result => { if (!result.errors.length) console.log('Rebuilt dist/code.js.'); });
  } }] });
  await Promise.all([uiContext.watch(), mainContext.watch()]);
  // The template and the font are not part of the bundle graph, so a change to either rebuilds the UI by hand.
  for (const url of [templateUrl, fontUrl]) watch(fileURLToPath(url), () => { void uiContext.rebuild().catch(() => {}); });
  console.log('Watching src/ for changes. Stop with Ctrl+C.');
} else {
  const [, built] = await Promise.all([build(main), build(ui)]);
  const size = await writeUi(built.outputFiles[0].text);
  console.log(`Built dist/code.js and dist/ui.html (${kb(size)}${dev ? ', development' : ''}).`);
}
