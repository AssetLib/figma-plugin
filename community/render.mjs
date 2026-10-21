import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const macChrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const executablePath = process.env.CHROME_PATH || (existsSync(macChrome) ? macChrome : undefined);
const browser = await chromium.launch({ executablePath, headless: true });
const root = new URL('./', import.meta.url);
const results = [];

try {
  for (const [name, width, height] of [['icon', 128, 128], ['cover', 1920, 1080]]) {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
    if (name === 'icon') {
      const svg = await readFile(new URL('icon.svg', root), 'utf8');
      await page.setContent(`<style>html,body{margin:0;width:128px;height:128px}svg{display:block}</style>${svg}`);
    } else {
      await page.goto(new URL('cover.html', root).href);
      await page.evaluate(() => document.fonts.ready);
      const layout = await page.evaluate(() => ({
        fontLoaded: [...document.fonts].some(font => font.family === 'Instrument Sans' && font.status === 'loaded'),
        text: document.body.innerText.replace(/\s+/g, ' ').trim(),
        bounds: [...document.querySelectorAll('.brand, h1, .boundary, .workflow, .domain')].map(element => {
          const { x, y, width, height } = element.getBoundingClientRect();
          return { element: element.className || element.tagName, x, y, width, height };
        }),
      }));
      assert.equal(layout.fontLoaded, true, 'Instrument Sans must load before rendering.');
      assert.equal(layout.text, 'assetlib Update your app’s images without an app release. in connected placements, after one SDK integration and app release Insert. Edit. Send to draft. Review and publish in Assetlib. assetlib.dev');
      for (const box of layout.bounds) {
        assert.ok(box.x >= 0 && box.y >= 0 && box.x + box.width <= width && box.y + box.height <= height, `Clipped text: ${box.element}`);
      }
      results.push({ name: 'cover-layout', ...layout });
    }
    const path = fileURLToPath(new URL(`${name}.png`, root));
    await page.screenshot({ path, type: 'png', animations: 'disabled' });
    const png = await readFile(path);
    assert.equal(png.subarray(1, 4).toString(), 'PNG');
    assert.equal(png.readUInt32BE(16), width);
    assert.equal(png.readUInt32BE(20), height);
    results.push({ name: `${name}.png`, width, height, bytes: png.length, sha256: createHash('sha256').update(png).digest('hex') });
    await page.close();
  }
  await writeFile(new URL('verification.json', root), `${JSON.stringify(results, null, 2)}\n`);
  console.log(JSON.stringify(results.filter(result => result.sha256), null, 2));
} finally {
  await browser.close();
}
