// Builds dist/code.js and a self-contained dist/ui.html (the UI bundle inlined at the ASSETLIB_SCRIPT marker).
//   node scripts/build.mjs            minified, for Figma and the tests
//   node scripts/build.mjs --dev      unminified, with inline source maps
//   node scripts/build.mjs --watch    --dev, rebuilt on every change to src/ (npm run watch)
import { build, context, transform } from 'esbuild';
import { watch } from 'node:fs';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const args = new Set(process.argv.slice(2));
const watching = args.has('--watch');
const dev = watching || args.has('--dev');
// Release budget, embedded font included; raised from 176 KB on October 13, 2026 for the usability release:
// Connect recovery, explanations, Update from Assetlib, the Send picker.
const MAX_UI_BYTES = 192_000;
const MAX_MAIN_BYTES = 48_000;
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
// The HTML is UTF-8 already; keep UI copy in UTF-8 rather than expanding punctuation into JavaScript escapes.
const ui = { ...options, charset: 'utf8', entryPoints: ['src/ui/main.ts'], outfile: 'dist/ui.js', write: false };

const uiUrl = new URL('../dist/ui.html', import.meta.url);

/**
 * A release build's template without its comments and indentation (about 8 KB of the budget); the two markers stay. The
 * template has no <pre> or <textarea>, so a line's leading spaces never show.
 */
function compact(template) {
  return template
    .replace(/<style>[\s\S]*?<\/style>/, style => style.replace(/\/\*[\s\S]*?\*\//g, comment => comment === fontMarker ? comment : ''))
    .replace(/<!--[\s\S]*?-->/g, comment => comment === marker ? comment : '')
    // HTML permits unquoted attribute values without spaces or delimiters. Keep a self-closing tag's final quotes
    // so its slash cannot become part of the value; CSS and the script are handled separately.
    .replace(/<[A-Za-z][^>]*>/g, tag => tag.replace(/(\s[\w:-]+=)"([^\s"'`=<>]+)"(?=\s|>)/g, '$1$2'))
    .replace(/\n[ \t]*/g, '\n').replace(/\n{2,}/g, '\n');
}

/** Writes dist/ui.html; a release build over budget writes nothing and removes the previous one, so none is left to load. */
async function writeUi(script) {
  const [source, font] = await Promise.all([readFile(templateUrl, 'utf8'), readFile(fontUrl)]);
  const template = dev ? source : compact(source);
  if (template.split(marker).length !== 2) throw new Error(`src/ui.html must contain exactly one ${marker} marker.`);
  if (template.split(fontMarker).length !== 2) throw new Error(`src/ui.html must contain exactly one ${fontMarker} marker.`);
  const face = `@font-face { font-family: 'Instrument Sans'; src: url(data:font/woff2;base64,${font.toString('base64')}) format('woff2'); font-weight: 400 700; font-style: normal; font-display: block; }`;
  let html = template.replace(fontMarker, () => face);
  if (!dev) {
    const style = html.match(/<style>([\s\S]*?)<\/style>/);
    if (!style || html.split('<style>').length !== 2) throw new Error('src/ui.html must contain exactly one style element.');
    const css = (await transform(style[1], { loader: 'css', minify: true })).code;
    html = html.replace(style[0], () => `<style>${css}</style>`);
  }
  html = html.replace(marker, () => `<script>${script.replace(/<\/script/gi, '<\\/script')}</script>`);
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
  const mainUrl = new URL('../dist/code.js', import.meta.url);
  const mainSize = (await stat(mainUrl)).size;
  if (!dev && mainSize > MAX_MAIN_BYTES) {
    await rm(mainUrl, { force: true });
    throw new Error(`dist/code.js would be ${kb(mainSize)}, over the ${kb(MAX_MAIN_BYTES)} budget; it was not written.`);
  }
  const size = await writeUi(built.outputFiles[0].text);
  console.log(`Built dist/code.js (${mainSize.toLocaleString('en-US')} bytes) and dist/ui.html (${size.toLocaleString('en-US')} bytes${dev ? ', development' : ''}).`);
}
