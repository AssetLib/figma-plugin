import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = {
  absWorkingDir: root,
  bundle: true,
  platform: 'browser',
  format: 'iife',
  target: 'es2020',
  legalComments: 'none',
  logLevel: 'warning',
};

const template = await readFile(new URL('../src/ui.html', import.meta.url), 'utf8');
const marker = '<!-- ASSETLIB_SCRIPT -->';
if (template.split(marker).length !== 2) {
  throw new Error(`src/ui.html must contain exactly one ${marker} marker.`);
}

await mkdir(new URL('../dist/', import.meta.url), { recursive: true });
const [, ui] = await Promise.all([
  build({ ...options, entryPoints: ['src/code.ts'], outfile: 'dist/code.js' }),
  build({ ...options, entryPoints: ['src/ui.ts'], write: false }),
]);
const script = ui.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
await writeFile(new URL('../dist/ui.html', import.meta.url), template.replace(marker, () => `<script>${script}</script>`));
console.log('Built dist/code.js and dist/ui.html.');
