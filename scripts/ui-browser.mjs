// Browser tests for the built dist/ui.html (npm run test:browser). Dependency-free: Chrome is driven over the DevTools
// protocol on a pipe (--remote-debugging-pipe), and the tests run on node:test. Each page is the built UI with
// `parent` and `fetch` replaced by a fake Figma main thread and a fake console (fixtures of 7 placements, and 30 or
// 2,000 images), so it needs neither Figma nor the network. It is not Figma: the page is a top-level file:// document,
// not Figma's cross-origin iframe. Figma's theme variables are absent unless a test asks for a theme, when the values in
// tests/fixtures/figma-theme.json are set on the page as Figma sets them.
// Chrome is found through CHROME_PATH, then the usual install paths. On CI under Linux it runs without its sandbox.
// ASSETLIB_SCREENSHOTS=<directory> also writes a screenshot of every state in both themes there, for review.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { inflateSync } from 'node:zlib';

const root = fileURLToPath(new URL('../', import.meta.url));
const uiUrl = pathToFileURL(join(root, 'dist/ui.html')).href;
if (!existsSync(join(root, 'dist/ui.html'))) throw new Error('Build first: npm run build.');

function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const paths = {
    darwin: ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/Applications/Chromium.app/Contents/MacOS/Chromium'],
    win32: [`${process.env.PROGRAMFILES}\\Google\\Chrome\\Application\\chrome.exe`, `${process.env['PROGRAMFILES(X86)']}\\Google\\Chrome\\Application\\chrome.exe`],
  }[process.platform] ?? [];
  for (const path of paths) if (existsSync(path)) return path;
  for (const name of ['google-chrome', 'google-chrome-stable', 'chromium', 'chromium-browser']) {
    const found = spawnSync('which', [name], { encoding: 'utf8' });
    if (found.status === 0 && found.stdout.trim()) return found.stdout.trim();
  }
  throw new Error('Chrome was not found. Set CHROME_PATH to a Chrome or Chromium binary.');
}

/** A DevTools protocol connection over Chrome's pipe: NUL-terminated JSON on fds 3 (in) and 4 (out). */
class Browser {
  static async launch() {
    const profile = await mkdtemp(join(tmpdir(), 'assetlib-ui-'));
    const args = ['--headless=new', '--remote-debugging-pipe', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
      '--disable-extensions', '--disable-background-networking', '--disable-component-update', '--disable-sync', '--mute-audio', 'about:blank'];
    // GitHub's Ubuntu runners restrict the user namespaces Chrome's sandbox needs; the page loads only local fixtures.
    if (process.platform === 'linux' && process.env.CI) args.push('--no-sandbox');
    const child = spawn(findChrome(), args, { stdio: ['ignore', 'ignore', 'pipe', 'pipe', 'pipe'] });
    let stderr = '';
    child.stdio[2].on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
    const browser = new Browser(child, profile, () => stderr);
    await browser.send('Target.setDiscoverTargets', { discover: false });
    return browser;
  }

  constructor(child, profile, stderr) {
    this.child = child;
    this.profile = profile;
    this.id = 0;
    this.waiting = new Map();
    this.listeners = new Set();
    let buffer = '';
    child.stdio[4].on('data', chunk => {
      buffer += chunk.toString('utf8');
      let end;
      while ((end = buffer.indexOf('\0')) >= 0) {
        const message = JSON.parse(buffer.slice(0, end));
        buffer = buffer.slice(end + 1);
        if (message.id && this.waiting.has(message.id)) {
          const { resolve, reject, method } = this.waiting.get(message.id);
          this.waiting.delete(message.id);
          if (message.error) reject(new Error(`${method}: ${message.error.message}`)); else resolve(message.result);
        } else if (message.method) for (const listener of this.listeners) listener(message);
      }
    });
    child.on('exit', code => {
      for (const { reject } of this.waiting.values()) reject(new Error(`Chrome exited (${code}). ${stderr()}`));
      this.waiting.clear();
    });
  }

  send(method, params = {}, sessionId) {
    this.id += 1;
    const id = this.id;
    return new Promise((resolve, reject) => {
      this.waiting.set(id, { resolve, reject, method });
      this.child.stdio[3].write(`${JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })}\0`);
    });
  }

  on(listener) { this.listeners.add(listener); return () => this.listeners.delete(listener); }

  async close() {
    const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
    const exited = new Promise(resolve => { if (this.child.exitCode !== null) resolve(); else this.child.once('exit', resolve); });
    try { await Promise.race([this.send('Browser.close'), pause(2000)]); } catch { /* already gone */ }
    // The profile can be removed only once Chrome has let go of it.
    await Promise.race([exited, pause(5000)]);
    if (this.child.exitCode === null) { this.child.kill(); await Promise.race([exited, pause(2000)]); }
    await rm(this.profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => {});
  }
}

// ---- The page's fakes. This function is serialized into the page and runs before the UI script. ----
function installFakes(config) {
  // Figma's theme: its variables on :root and figma-light or figma-dark on <html>.
  if (config.theme) {
    const apply = () => {
      document.documentElement.classList.add(config.theme.mode === 'dark' ? 'figma-dark' : 'figma-light');
      const style = document.createElement('style');
      style.textContent = `:root { ${Object.entries(config.theme.variables).map(([name, value]) => `${name}: ${value};`).join(' ')} }`;
      document.head.prepend(style);
    };
    if (document.head) apply(); else document.addEventListener('DOMContentLoaded', apply, { once: true });
  }
  const uuid = n => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
  const sha = n => n.toString(16).padStart(64, '0');
  // The UI checks only a PNG's signature and IHDR before an insert; main is fake, so nothing decodes it.
  const pngHeader = (width, height) => {
    const bytes = new Uint8Array(33);
    bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
    const view = new DataView(bytes.buffer);
    view.setUint32(16, width);
    view.setUint32(20, height);
    bytes[24] = 8;
    bytes[25] = 6;
    return bytes;
  };
  // Previews are real PNGs in the image's own proportions (a two-tone gradient, one of five colours), so screenshots show
  // how art sits in its thumbnail: contained, over the checkerboard. Stored (uncompressed) deflate keeps the encoder short.
  const crcTable = Array.from({ length: 256 }, (_, i) => { let c = i; for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
  const crc32 = bytes => { let c = 0xffffffff; for (const byte of bytes) c = crcTable[(c ^ byte) & 0xff] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
  const palette = [[46, 134, 171], [162, 59, 114], [106, 153, 78], [241, 167, 1], [69, 76, 140]];
  const previews = new Map();
  const previewPng = (width, height, n) => {
    const key = `${width}x${height}:${n % palette.length}`;
    if (previews.has(key)) return previews.get(key);
    const [r, g, b] = palette[n % palette.length];
    const raw = new Uint8Array((width * 3 + 1) * height);
    for (let y = 0; y < height; y += 1) {
      const t = height > 1 ? (y / (height - 1)) * 0.6 : 0;
      for (let x = 0; x < width; x += 1) raw.set([r + (255 - r) * t, g + (255 - g) * t, b + (255 - b) * t].map(Math.round), y * (width * 3 + 1) + 1 + x * 3);
    }
    let a = 1, d = 0;
    for (const byte of raw) { a = (a + byte) % 65521; d = (d + a) % 65521; }
    const zlib = [0x78, 0x01];
    for (let i = 0; i < raw.length; i += 65535) {
      const part = raw.subarray(i, i + 65535);
      zlib.push(i + 65535 >= raw.length ? 1 : 0, part.length & 255, part.length >> 8, ~part.length & 255, (~part.length >> 8) & 255);
      for (const byte of part) zlib.push(byte);
    }
    zlib.push(d >> 8, d & 255, a >> 8, a & 255);
    const chunk = (type, data) => {
      const body = [...type].map(c => c.charCodeAt(0)).concat([...data]);
      const crc = crc32(body);
      return [data.length >>> 24, (data.length >> 16) & 255, (data.length >> 8) & 255, data.length & 255, ...body, crc >>> 24, (crc >> 16) & 255, (crc >> 8) & 255, crc & 255];
    };
    const header = [width >>> 24, (width >> 16) & 255, (width >> 8) & 255, width & 255, height >>> 24, (height >> 16) & 255, (height >> 8) & 255, height & 255, 8, 2, 0, 0, 0];
    const bytes = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, ...chunk('IHDR', header), ...chunk('IDAT', zlib), ...chunk('IEND', [])]);
    previews.set(key, bytes);
    return bytes;
  };
  const bodies = new Map();
  const asset = (n, name, width, height) => {
    const insert = pngHeader(width, height);
    const previewHeight = Math.max(1, Math.round((64 * height) / width));
    const preview = previewPng(64, previewHeight, n);
    bodies.set(sha(2 * n), insert);
    bodies.set(sha(2 * n + 1), preview);
    return { id: uuid(n), name, width, height, createdAt: '2026-10-09T00:00:00.000Z', processingIntent: 'artwork', source: null,
      renditions: [{ sha256: sha(2 * n), mime: 'image/png', bytes: insert.byteLength, width, height },
        { sha256: sha(2 * n + 1), mime: 'image/png', bytes: preview.byteLength, width: 64, height: previewHeight }] };
  };
  // Seven placements on three screens, or a generated list when config.placements asks for more. With config.declared,
  // the first declares two states, both appearances, and an A/B arm, so the footer shows all three pickers.
  const named = [['onboarding.hero', 'Onboarding', 1170, 1560], ['onboarding.footer', 'Onboarding', 1170, 300], ['home.banner', 'Home', 1170, 480],
    ['home.promo', 'Home', 1170, 600], ['home.tile', 'Home', 540, 540], ['settings.header', 'Settings', 1170, 400], ['settings.empty', 'Settings', 800, 800]];
  const count = config.placements ?? 7;
  const specs = count <= 7 ? named.slice(0, count) : Array.from({ length: count }, (_, i) => [`screen${Math.floor(i / 8)}.slot${i}`, `Screen ${Math.floor(i / 8)}`, 1000, 1000]);
  const assets = {};
  const placements = specs.map(([key, screen, width, height], i) => {
    const art = asset(10000 + i, `${key} art`, width, height);
    assets[art.id] = art;
    const cellArt = { assetId: art.id, via: { arm: null, appearance: null } };
    // config.unset leaves these keys without art in any environment; config.legacy gives them an image with no versions;
    // config.huge, only versions over 4 MiB; config.missing, an image the console didn't return; config.changed, a draft
    // that differs from production.
    const unset = config.unset?.includes(key);
    if (config.legacy?.includes(key)) { art.renditions = []; }
    if (config.huge?.includes(key)) art.renditions = art.renditions.map(item => ({ ...item, bytes: 5 * 1024 * 1024 }));
    if (config.missing?.includes(key)) delete assets[art.id];
    const draft = unset ? null : cellArt;
    if (config.changed?.includes(key)) {
      const other = asset(20000 + i, `${key} production art`, width, height);
      assets[other.id] = other;
      return { key, screen, width, height, states: null, defaultState: null, variants: null, origin: 'declared',
        cells: [{ state: null, appearance: null, arm: null, draft, staging: null, production: { assetId: other.id, via: { arm: null, appearance: null } } }] };
    }
    if (config.declared && i === 0) {
      const cells = [];
      for (const state of ['welcome', 'return']) for (const appearance of [null, 'light', 'dark']) for (const arm of [null, 'b']) {
        cells.push({ state, appearance, arm, draft, staging: null, production: draft });
      }
      return { key, screen, width, height, states: ['welcome', 'return'], defaultState: 'welcome', variants: { appearance: ['light', 'dark'], arm: ['b'] },
        origin: 'declared', cells };
    }
    return { key, screen, width, height, states: null, defaultState: null, variants: null, origin: 'declared',
      cells: [{ state: null, appearance: null, arm: null, draft, staging: null, production: i % 2 && !unset ? cellArt : null }] };
  });
  const artwork = { environments: { staging: null, production: { sequence: 4, createdAt: '2026-10-01T00:00:00.000Z' } }, placements, assets };
  const library = Array.from({ length: config.images ?? 30 }, (_, i) => asset(i + 1, config.imageNames?.[i] ?? `Image ${i + 1}`, 400, 200));
  if (config.artwork === 'empty') artwork.placements = [];

  // config.fastTimeouts: a request timeout (20 s or more) fires after 300 ms, so a timeout can be shown without the wait.
  if (config.fastTimeouts) {
    const original = window.setTimeout.bind(window);
    window.setTimeout = (callback, delay, ...rest) => original(callback, delay >= 20000 ? 300 : delay, ...rest);
  }
  const log = [];
  const delays = { placements: 10, artwork: 10, assets: 10, rendition: 10, drafts: 10, token: 10, start: 10, claim: 10, cancel: 10, current: 10, ...config.delays };
  const json = (status, body) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  function respond(route, path) {
    // config.statuses[route] answers that route with an error status instead (config.codes[route] adds a refused Figma
    // connection's code).
    if (config.statuses?.[route]) {
      return json(config.statuses[route], { error: `HTTP ${config.statuses[route]} from the fake console.`, ...(config.codes?.[route] ? { code: config.codes[route] } : {}) });
    }
    // One-click Connect: a request, claimed as config.pairingStatus says (__harness.approve() approves it).
    if (route === 'start') {
      return json(201, { readKey: `alr_${'r'.repeat(43)}`, writeKey: `alw_${'w'.repeat(43)}`, userCode: 'BCDF-GHJK', expiresAt: new Date(Date.now() + 600000).toISOString(),
        expiresIn: 600, interval: 2 });
    }
    if (route === 'claim') {
      const status = config.pairingStatus ?? 'pending';
      if (status === 'pending') return json(200, { status: 'pending', interval: 2 });
      if (status !== 'approved') return json(410, { status });
      config.pairingStatus = 'claimed';
      return json(200, { status: 'connected', connection: { ...config.claimed, token: `alk_${'f'.repeat(43)}` } });
    }
    if (route === 'cancel' || route === 'current') return new Response(null, { status: 204 });
    // GET /api/token: the token's own organization and app, as the console answers it.
    if (route === 'token') return json(200, config.identity);
    if (route === 'placements') return json(200, { placements: placements.map(({ cells, ...placement }) => placement) });
    if (route === 'artwork') return json(200, artwork);
    if (route === 'assets') {
      const params = new URLSearchParams(path.split('?')[1] ?? '');
      const q = (params.get('q') ?? '').toLowerCase();
      const limit = Number(params.get('limit') ?? 24);
      const matches = library.filter(item => !q || item.name.toLowerCase().includes(q));
      const start = params.get('cursor') ? matches.findIndex(item => item.id === params.get('cursor')) + 1 : 0;
      const page = matches.slice(start, start + limit);
      return json(200, { assets: page, nextCursor: start + limit < matches.length ? page.at(-1).id : null });
    }
    if (route === 'rendition') {
      const body = bodies.get(path.split('/').at(-1));
      return body ? new Response(body.slice(), { status: 200, headers: { 'content-type': 'image/png', 'content-length': String(body.byteLength) } }) : json(404, { error: 'Not found.' });
    }
    // config.draft answers the draft with its own status and body (a rebind across cells, or a 409, say).
    if (route === 'drafts' && config.draft) return json(config.draft.status, config.draft.body);
    if (route === 'drafts') {
      return json(201, { asset: { id: uuid(9999), name: 'Sent', width: 1170, height: 480, sha256: 'a'.repeat(64), renditions: 1 }, previous: null,
        bound: { slotKey: 'home.banner', state: null, appearance: null, arm: null }, bindError: null, rebound: [] });
    }
    return json(404, { error: 'Not found.' });
  }
  window.fetch = (input, init = {}) => new Promise((resolve, reject) => {
    const url = String(input);
    const path = url.replace(/^https?:\/\/[^/]+\/api\/apps\/[^/]+\/[^/]+\//, '');
    const pairing = /^https?:\/\/[^/]+\/api\/plugin-connections(?:\/(claim|cancel|current))?$/.exec(url);
    const route = pairing ? pairing[1] ?? 'start' : /^https?:\/\/[^/]+\/api\/token$/.test(url) ? 'token' : path === 'placements/artwork' ? 'artwork'
      : path === 'placements' ? 'placements' : /^assets(\?|$)/.test(path) ? 'assets' : /^assets\/[^/]+\/renditions\/[^/]+$/.test(path) ? 'rendition'
        : path === 'drafts' ? 'drafts' : 'unknown';
    const entry = { route, url, started: performance.now(), done: false, aborted: false };
    log.push(entry);
    const { signal } = init;
    const abort = () => { entry.aborted = true; reject(new DOMException('The operation was aborted.', 'AbortError')); };
    if (signal?.aborted) { abort(); return; }
    // config.failures lists routes that fail as a network error (an older console's missing CORS headers, say).
    if (config.failures?.includes(route)) { setTimeout(() => { entry.done = true; reject(new TypeError('Failed to fetch')); }, delays[route] ?? 10); return; }
    const onAbort = () => { clearTimeout(timer); abort(); };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      entry.done = true;
      resolve(respond(route, path));
    }, delays[route] ?? 10);
    signal?.addEventListener('abort', onAbort, { once: true });
  });

  // The fake main thread: answers the UI's messages as code.ts does, without a canvas.
  let generation = 0;
  let frames = 0;
  const received = [];
  const notices = [];
  const reply = message => window.postMessage({ pluginMessage: message }, '*');
  // config.selection may leave out insertTarget: nothing selected for Insert, so a new frame.
  const selection = () => ({ type: 'selection', connectionGeneration: generation,
    selection: { insertTarget: { mode: 'new', label: 'Insert', count: 0, nodeIds: [] }, ...config.selection } });
  // Where each insert went (message.target), and the version it downloaded, for the tests to read.
  const targets = [];
  // What the grip asked for (a size, or 'reset'), and each preferences save; a test resizes the page itself, as Figma would.
  const resizes = [];
  const saved = [];
  // Each pluginDrop the UI posted (Figma's, not a plugin message), and the drop each insert names (null for none).
  const drops = [];
  const insertDrops = [];
  // The pages main opened (one-click Connect's connect page), and the request main keeps (config.pairing resumes one).
  const opened = [];
  const connection = () => ({ type: 'connection', connectionGeneration: generation, connection: config.connection, savedFileUrl: '', preferences: config.preferences,
    pairing: config.pairing ?? null, hints: [] });
  function handle(message) {
    received.push(message.type);
    switch (message.type) {
      case 'init':
        // config.command: opened from a relaunch button (sync), as code.ts says before the connection.
        if (config.command) reply({ type: 'launch', command: config.command });
        // delays.connection: main's client storage reads take that long before the connection message.
        setTimeout(() => {
          reply(connection());
          reply(selection());
        }, delays.connection ?? 0);
        break;
      case 'save-connection':
        // As code.ts does when client storage refuses the write: the error, then the selection again.
        if (config.refuseSave) {
          reply({ type: 'error', requestId: message.requestId, message: 'Figma couldn’t save this on your device. Try again.' });
          reply(selection());
          break;
        }
        generation += 1;
        config.connection = message.connection;
        reply(connection());
        if (message.connection.pairing && config.pairing?.userCode === message.connection.pairing) config.pairing = null;
        reply(selection());
        break;
      case 'save-file-url':
        // As code.ts does: config.fileName names this file, so a link to another (slug) is questioned until Use anyway;
        // config.viewOnly keeps the key for the session only. Then the selection again, with the file key.
        if (config.fileName && !message.force && !/\/design\/[^/]+\/Roam-onboarding/.test(message.url)) {
          reply({ type: 'file-mismatch', requestId: message.requestId, slug: message.url.split('/')[5]?.split('?')[0] ?? '', name: config.fileName });
          break;
        }
        config.selection = { ...config.selection, fileKey: 'abc123', file: { source: config.viewOnly ? 'session' : 'document', name: config.fileName ?? 'Untitled' } };
        reply({ type: 'file-saved', requestId: message.requestId, fileKey: 'abc123', session: Boolean(config.viewOnly) });
        reply(selection());
        break;
      case 'export': {
        const { width, height } = message.placement;
        reply({ type: 'exported', requestId: message.requestId, node: message.node, fileKey: message.fileKey,
          settings: { format: 'PNG', useAbsoluteBounds: true, constraint: { type: 'WIDTH', value: width } }, bytes: pngHeader(width, height) });
        break;
      }
      case 'remember': reply({ type: 'remembered', requestId: message.requestId }); reply(selection()); break;
      case 'notify': notices.push(message.text); break;
      case 'resize': resizes.push({ width: message.width, height: message.height }); break;
      case 'reset-size': resizes.push('reset'); break;
      case 'save-preferences': saved.push(message.preferences); break;
      case 'clear-connection':
        generation += 1;
        config.connection = null;
        reply(connection());
        reply(selection());
        break;
      // As code.ts does: the connect page opens in the browser, and the request's record is kept and forgotten.
      case 'open-connect-page': opened.push(`https://console.assetlib.dev/connect/figma#${message.writeKey}`); break;
      case 'save-pairing': config.pairing = message.pairing; break;
      case 'clear-pairing': if (config.pairing?.userCode === message.userCode) config.pairing = null; break;
      case 'adopt-connection': reply({ type: 'adopted', requestId: message.requestId, adopted: false }); break;
      case 'insert': {
        targets.push(message.target);
        insertDrops.push(message.drop ?? null);
        // A drop's placeholder is filled as a new layer.
        const kind = message.drop ? 'new' : message.target.kind;
        // As main/insert.ts words its toasts; a fill of one linked layer is a replace.
        const mode = kind === 'fill' && config.selection.insertTarget?.mode === 'replace' ? 'replace' : kind;
        const notice = mode === 'replace' ? `Replaced image in ${config.selection.insertTarget.name}`
          : mode === 'fill' ? `Filled ${message.target.nodeIds.length} layers with ${message.link?.placementKey ?? message.name}`
            : message.link ? `Inserted ${message.name} from Draft` : `Inserted ${message.name}`;
        if (kind !== 'fill') frames += 1;
        reply({ type: 'inserted', requestId: message.requestId, connectionGeneration: generation, linked: Boolean(message.link), mode, notice,
          node: { id: `200:${frames}`, name: message.name, type: 'FRAME', width: message.frame.width / message.scale, height: message.frame.height / message.scale } });
        break;
      }
      default: break;
    }
  }
  // A pluginDrop is Figma's: it becomes main's drop event, which answers with a placeholder (config.dropRefused: an error).
  function handleDrop(drop) {
    drops.push(drop);
    const { dropId, connectionGeneration } = drop.dropMetadata;
    reply(config.dropRefused ? { type: 'error', requestId: dropId, message: config.dropRefused }
      : { type: 'dropped', dropId, nodeId: `300:${drops.length}`, connectionGeneration });
  }
  const fakeParent = { postMessage(data) {
    if (data?.pluginDrop) setTimeout(() => handleDrop(data.pluginDrop), 0);
    else if (data?.pluginMessage) setTimeout(() => handle(data.pluginMessage), 0);
  } };
  Object.defineProperty(window, 'parent', { configurable: true, get: () => fakeParent });
  // Tests may change `delays` mid-test; each request reads its route's delay when it starts.
  window.__harness = { log, received, notices, uuid, delays, targets, drops, insertDrops, resizes, saved, opened, inserted: () => frames,
    approve: () => { config.pairingStatus = 'approved'; } };
}

// Tokens as the console mints them: alk_ and 43 base64url characters. Fake, for these pages only.
const fakeToken = name => `alk_${name.padEnd(43, '0')}`;
const DEFAULTS = {
  connection: { origin: 'https://console.assetlib.dev', orgId: 'org-one', appId: 'app-a', token: fakeToken('saved'), workspaceName: 'Sample workspace', appName: 'Sample app' },
  identity: { orgId: 'org-one', appId: 'app-a', workspaceName: 'Sample workspace', appName: 'Sample app', scopes: ['draft'] },
  preferences: { tab: 'insert', browse: 'placements', environment: 'draft', scale: 1 },
  selection: { node: null, reason: 'Select a frame or layer to send.', fileKey: 'abc123', remembered: null },
  delays: {},
  // What the console issues when one-click Connect is approved: the workspace, the app, and who approved it.
  claimed: { orgId: '00000000-0000-4000-8000-0000000000a1', appId: '00000000-0000-4000-8000-0000000000b2', workspaceName: 'Sample workspace', appName: 'Sample app',
    connectedAs: 'dana@example.com' },
};
// A connection one-click Connect saved.
const browserConnection = { origin: 'https://console.assetlib.dev', orgId: DEFAULTS.claimed.orgId, appId: DEFAULTS.claimed.appId, token: fakeToken('figma'),
  workspaceName: 'Sample workspace', appName: 'Sample app', method: 'browser', connectedAs: 'dana@example.com', pairing: 'BCDFGHJK' };
const theme = JSON.parse(await readFile(join(root, 'tests/fixtures/figma-theme.json'), 'utf8'));

let browser;
before(async () => { browser = await Browser.launch(); });
after(async () => { await browser?.close(); });

/**
 * A new tab showing the UI with these fakes. Uncaught page errors fail the test at close(). `theme` sets Figma's light or
 * dark variables and class on the page, as Figma does for a plugin with themeColors.
 */
async function openUi(options = {}, { width = 420, height = 720, theme: mode = null } = {}) {
  const config = { ...DEFAULTS, ...options, preferences: { ...DEFAULTS.preferences, ...options.preferences } };
  if (mode) config.theme = { mode, variables: theme[mode] };
  const { targetId } = await browser.send('Target.createTarget', { url: 'about:blank' });
  const { sessionId } = await browser.send('Target.attachToTarget', { targetId, flatten: true });
  const send = (method, params) => browser.send(method, params, sessionId);
  const errors = [];
  let loaded;
  const load = new Promise(resolve => { loaded = resolve; });
  const stop = browser.on(message => {
    if (message.sessionId !== sessionId) return;
    if (message.method === 'Runtime.exceptionThrown') errors.push(message.params.exceptionDetails.exception?.description ?? message.params.exceptionDetails.text);
    if (message.method === 'Page.loadEventFired') loaded();
  });
  await send('Page.enable');
  await send('Runtime.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await send('Page.addScriptToEvaluateOnNewDocument', { source: `(${installFakes})(${JSON.stringify(config)});` });
  await send('Page.navigate', { url: uiUrl });
  await load;

  async function evaluate(expression) {
    const result = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (result.exceptionDetails) throw new Error(`${expression}\n${result.exceptionDetails.exception?.description ?? result.exceptionDetails.text}`);
    return result.result.value;
  }
  async function waitFor(expression, { timeout = 10000, message = expression } = {}) {
    const started = Date.now();
    for (;;) {
      if (await evaluate(`Boolean(${expression})`)) return;
      if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}`);
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  /** A real mouse click at the element's center, as a person would (focus moves as Chrome moves it). */
  async function click(selector) {
    // A render already asked for runs first, so it cannot move the layout between measuring and clicking.
    await frames();
    // Scrolled to the middle of the view, clear of the sticky footer, and checked to be what the pointer would hit.
    const box = await evaluate(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return 'missing';
      el.scrollIntoView({ block: 'center' }); const r = el.getBoundingClientRect(); const x = r.left + r.width / 2, y = r.top + r.height / 2;
      const hit = document.elementFromPoint(x, y); return hit && (hit === el || el.contains(hit)) ? { x, y } : 'covered by ' + (hit ? hit.id || hit.className || hit.tagName : 'nothing'); })()`);
    if (typeof box === 'string') throw new Error(`Cannot click ${selector}: ${box}`);
    for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
      await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount: type === 'mouseMoved' ? 0 : 1 });
    }
    await frames();
  }
  /** Two animation frames: the UI renders once per frame, so the page then shows the last action. */
  const frames = () => evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const type = async text => { await send('Input.insertText', { text }); await frames(); };
  /**
   * A key press, as a person makes it (Enter in a field submits its form; a letter types itself). `modifiers` adds
   * Ctrl (2), Meta (4), or Shift (8); with Ctrl or Meta a key is a shortcut and types nothing.
   */
  async function press(key, modifiers = 0) {
    const named = { Enter: [13, 'Enter', '\r'], Escape: [27, 'Escape'], Tab: [9, 'Tab'], ' ': [32, 'Space', ' '], ArrowUp: [38, 'ArrowUp'],
      ArrowDown: [40, 'ArrowDown'], ArrowLeft: [37, 'ArrowLeft'], ArrowRight: [39, 'ArrowRight'], Home: [36, 'Home'], End: [35, 'End'],
      '/': [191, 'Slash', '/'], '.': [190, 'Period', '.'] };
    const [keyCode, code, character] = named[key] ?? (/^[a-z]$/i.test(key) ? [key.toUpperCase().charCodeAt(0), `Key${key.toUpperCase()}`, key]
      : /^[0-9]$/.test(key) ? [key.charCodeAt(0), `Digit${key}`, key] : assert.fail(`No key description for ${key}`));
    const text = modifiers & 6 ? undefined : character;
    const base = { key, code, windowsVirtualKeyCode: keyCode, modifiers };
    await send('Input.dispatchKeyEvent', { type: text ? 'keyDown' : 'rawKeyDown', ...base, ...(text ? { text } : {}) });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
    await frames();
  }
  /** A real double-click at the element's center: two clicks, then dblclick. */
  async function doubleClick(selector) {
    await frames();
    const box = await evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    for (const clickCount of [1, 2]) {
      for (const type of ['mousePressed', 'mouseReleased']) await send('Input.dispatchMouseEvent', { type, x: box.x, y: box.y, button: 'left', clickCount });
    }
    await frames();
  }
  /** What has focus: an id, a data-key or data-asset-id, or "body". */
  const focused = () => evaluate(`(() => { const el = document.activeElement; if (!el || el === document.body) return 'body';
    return el.id || el.getAttribute('data-key') || el.getAttribute('data-asset-id') || el.tagName; })()`);
  /**
   * The colour Chrome painted at one CSS pixel, as [r, g, b]. A 1×1 PNG needs no unfiltering: with no neighbours, every
   * PNG filter leaves the bytes as they are.
   */
  async function pixel(x, y) {
    await frames();
    const { data } = await send('Page.captureScreenshot', { format: 'png', clip: { x, y, width: 1, height: 1, scale: 1 } });
    const png = Buffer.from(data, 'base64');
    const chunks = [];
    for (let at = 8; at < png.length;) {
      const length = png.readUInt32BE(at);
      if (png.toString('latin1', at + 4, at + 8) === 'IDAT') chunks.push(png.subarray(at + 8, at + 8 + length));
      at += length + 12;
    }
    return [...inflateSync(Buffer.concat(chunks)).subarray(1, 4)];
  }
  /** A PNG of the page as it is now. */
  async function screenshot(path) {
    await frames();
    const { data } = await send('Page.captureScreenshot', { format: 'png' });
    await writeFile(path, Buffer.from(data, 'base64'));
  }
  async function close() {
    stop();
    await browser.send('Target.closeTarget', { targetId }).catch(() => {});
    assert.deepEqual(errors, [], 'the page threw no errors');
  }
  return { evaluate, waitFor, click, doubleClick, type, press, focused, frames, close, send, screenshot, pixel };
}

const listBusy = `document.getElementById('insert-list').getAttribute('aria-busy') === 'true'`;
const gridBusy = `document.getElementById('image-grid').getAttribute('aria-busy') === 'true'`;
const tiles = `document.querySelectorAll('#image-grid .tile[data-asset-id]').length`;
const rows = `document.querySelectorAll('#insert-list .placement[data-key]').length`;
const skeletonRows = `document.querySelectorAll('#insert-list .skeleton').length`;
const shown = id => `!document.getElementById('${id}').hidden`;
const textOf = id => `document.getElementById('${id}').textContent`;
/** True when the element has a box and all of it is inside the window. */
const inViewport = id => `(() => { const r = document.getElementById('${id}').getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.top >= 0 && r.left >= 0 && r.bottom <= innerHeight + 0.5 && r.right <= innerWidth + 0.5; })()`;
/** Chooses a <select> value as a person would, firing change. */
const choose = (id, value) => `(() => { const s = document.getElementById('${id}'); s.value = ${JSON.stringify(value)}; s.dispatchEvent(new Event('change')); })()`;
/** How many times `text` is on screen: rendered text outside the visually hidden live regions. */
const timesShown = text => `(() => { let count = 0; const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const parent = node.parentElement;
    if (!parent || parent.closest('.visually-hidden, script, style') || !parent.checkVisibility()) continue;
    count += node.textContent.split(${JSON.stringify(text)}).length - 1;
  }
  return count; })()`;
/** The ink primaries a person can see and use: visible, available, and filled with the text colour. */
const inkPrimaries = `[...document.querySelectorAll('.primary')].filter(button => button.checkVisibility() && button.getAttribute('aria-disabled') !== 'true'
  && getComputedStyle(button).backgroundColor === getComputedStyle(document.body).color).map(button => button.id)`;

test('tabs and search stay usable during a 5 s artwork load', async () => {
  const page = await openUi({ delays: { artwork: 5000 } });
  try {
    await page.waitFor(listBusy, { message: 'the artwork load to start' });
    assert.equal(await page.evaluate(skeletonRows), 6, 'six skeleton rows hold the list while it loads');
    const started = Date.now();
    const live = await page.evaluate(`['tab-send', 'tab-insert', 'insert-search', 'insert-refresh', 'browse-images', 'browse-placements', 'env-draft', 'env-production']
      .filter(id => document.getElementById(id).disabled)`);
    assert.deepEqual(live, [], 'no tab, search, list, or environment control is disabled');
    await page.click('#tab-send');
    assert.equal(await page.evaluate(`document.getElementById('panel-send').hidden`), false);
    assert.equal(await page.focused(), 'tab-send');
    await page.click('#tab-insert');
    assert.equal(await page.evaluate(`document.getElementById('panel-insert').hidden`), false);
    await page.click('#insert-search');
    await page.type('home');
    assert.equal(await page.evaluate(`document.getElementById('insert-search').value`), 'home');
    assert.equal(await page.focused(), 'insert-search');
    assert.equal(await page.evaluate(listBusy), true, 'all of that happened while the artwork was loading');
    assert.ok(Date.now() - started < 4500);
    await page.waitFor(`!(${listBusy})`, { timeout: 8000, message: 'the artwork load to finish' });
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#insert-list .placement[data-key]')].map(row => row.getAttribute('data-key'))`),
      ['home.banner', 'home.promo', 'home.tile'], 'the search typed during the load applies to the list');
    assert.equal(await page.evaluate(skeletonRows), 0);
    assert.equal(await page.focused(), 'insert-search', 'typing kept focus through the rebuild');
    assert.deepEqual(await page.evaluate(`__harness.log.filter(entry => entry.route === 'artwork').map(entry => entry.aborted)`), [false], 'one artwork read');
  } finally { await page.close(); }
});

test('focus survives Refresh and Load more', async () => {
  const page = await openUi();
  try {
    await page.waitFor(`${rows} === 7`, { message: 'seven placements' });
    await page.click('#insert-refresh');
    assert.equal(await page.focused(), 'insert-refresh');
    await page.waitFor(`!(${listBusy}) && ${rows} === 7`, { message: 'the refreshed list' });
    assert.equal(await page.focused(), 'insert-refresh', 'Refresh keeps focus after the list is rebuilt');

    // A focused row follows its rebuild: an input event rebuilds the list without moving focus.
    await page.click('#insert-list .placement[data-key="home.banner"]');
    assert.equal(await page.focused(), 'home.banner');
    await page.evaluate(`window.__row = document.activeElement; document.getElementById('insert-search').dispatchEvent(new Event('input'))`);
    await page.frames();
    assert.equal(await page.evaluate('window.__row.isConnected'), false, 'the row was rebuilt');
    assert.equal(await page.focused(), 'home.banner', 'focus moved to the rebuilt row');

    await page.click('#browse-images');
    await page.waitFor(`${tiles} === 24 && !(${gridBusy})`, { message: 'the first page of images' });
    await page.click('#images-more');
    await page.waitFor(`${tiles} === 30 && !(${gridBusy})`, { message: 'the second page' });
    assert.equal(await page.evaluate(`document.getElementById('images-more').hidden`), true, 'the last page');
    assert.equal(await page.focused(), await page.evaluate(`__harness.uuid(25)`), 'focus moves to the first new image, not the page');

    // Insert keeps focus on its button.
    await page.click('#image-grid .tile');
    await page.click('#insert');
    await page.waitFor(`__harness.inserted() === 1 && document.getElementById('insert').getAttribute('aria-disabled') !== 'true'`, { message: 'the insert' });
    assert.equal(await page.focused(), 'insert');
  } finally { await page.close(); }

  // 2,000 images: Load more keeps focus page after page.
  const large = await openUi({ images: 2000, preferences: { browse: 'images' } });
  try {
    await large.waitFor(`${tiles} === 24`, { message: 'the first page' });
    for (let page = 2; page <= 4; page += 1) {
      await large.click('#images-more');
      await large.waitFor(`${tiles} === ${page * 24} && !(${gridBusy})`, { message: `page ${page}` });
      assert.equal(await large.focused(), 'images-more', `page ${page}`);
    }
  } finally { await large.close(); }
});

test('a refused connection save during an artwork load leaves the list, Refresh, and focus working', async () => {
  const page = await openUi({ refuseSave: true, delays: { artwork: 1500 } });
  try {
    await page.waitFor(listBusy, { message: 'the artwork load to start' });
    await page.click('#settings-summary');
    await page.click('#update-token');
    await page.click('#token');
    await page.type(fakeToken('rotated'));
    await page.click('#connect');
    await page.waitFor(shown('connection-error'), { message: 'the refusal' });
    assert.equal(await page.evaluate(textOf('connection-error')), 'Figma couldn’t save this on your device. Try again.');
    assert.equal(await page.focused(), 'connect', 'focus stays on Connect');
    await page.waitFor(`!(${listBusy}) && ${rows} === 7`, { timeout: 8000, message: 'the list to load' });
    assert.equal(await page.evaluate(`document.getElementById('connect').getAttribute('aria-disabled')`), null);
    assert.equal(await page.evaluate(`document.getElementById('token').value`), fakeToken('rotated'), 'the pasted token stays for another try');
    const reads = `__harness.log.filter(entry => entry.route === 'artwork').length`;
    const before = await page.evaluate(reads);
    await page.click('#insert-refresh');
    await page.waitFor(`${reads} === ${before + 1} && !(${listBusy}) && ${rows} === 7`, { timeout: 8000, message: 'Refresh to read again' });
    assert.equal(await page.focused(), 'insert-refresh');
    assert.equal(await page.evaluate(`document.getElementById('connection-error').hidden`), false, 'the error stays under the token field');
    assert.deepEqual(await page.evaluate(`__harness.received.filter(type => type === 'save-connection').length`), 1);
  } finally { await page.close(); }
});

test('a placements Refresh abandoned for Images loads again when Placements shows', async () => {
  const page = await openUi();
  try {
    await page.waitFor(`${rows} === 7`, { message: 'seven placements' });
    await page.evaluate(`__harness.delays.artwork = 1500`);
    await page.click('#insert-refresh');
    await page.waitFor(listBusy, { message: 'the Refresh to start' });
    await page.click('#browse-images');
    await page.waitFor(`${tiles} === 24 && !(${gridBusy})`, { message: 'the first page of images' });
    await page.click('#browse-placements');
    assert.equal(await page.evaluate(listBusy), true, 'the placements load again');
    assert.equal(await page.evaluate(skeletonRows), 6, 'skeletons hold the list while it loads');
    await page.waitFor(`!(${listBusy}) && ${rows} === 7`, { timeout: 8000, message: 'the rows to come back' });
    assert.deepEqual(await page.evaluate(`__harness.log.filter(entry => entry.route === 'artwork').map(entry => entry.aborted)`), [false, true, false],
      'the Images load replaced the Refresh, and Placements read again');
    assert.equal(await page.evaluate(`document.getElementById('error').hidden && document.getElementById('insert-empty').hidden`), true, 'an abandoned load is not an error');
    assert.equal(await page.focused(), 'browse-placements');
  } finally { await page.close(); }
});

test('Sync keeps focus, and its button is only unavailable while it runs', async () => {
  const node = { id: '40:1', name: 'Banner art', type: 'FRAME', width: 1170, height: 480 };
  const remembered = { fileKey: 'abc123', nodeId: node.id, placementKey: 'home.banner', state: null, appearance: null, arm: null, insertedFrom: null };
  const page = await openUi({ preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: 'abc123', remembered }, delays: { drafts: 400 } });
  try {
    await page.waitFor(`!document.getElementById('sync').hidden && document.getElementById('sync').getAttribute('aria-disabled') !== 'true'`, { message: 'Sync to be ready' });
    await page.click('#sync');
    await page.waitFor(`document.getElementById('sync').getAttribute('aria-disabled') === 'true'`, { message: 'Sync to run' });
    assert.equal(await page.evaluate(textOf('sync')), 'Syncing…');
    assert.equal(await page.focused(), 'sync', 'focus stays on Sync while it runs');
    assert.equal(await page.evaluate(`document.getElementById('tab-insert').disabled`), false);
    await page.waitFor(`document.getElementById('status').textContent === 'Synced home.banner to draft'`, { message: 'the sync' });
    assert.equal(await page.focused(), 'sync');
    assert.deepEqual(await page.evaluate('__harness.notices'), ['Synced home.banner to draft'], 'a Figma toast says so');
    assert.equal(await page.evaluate(`__harness.log.filter(entry => entry.route === 'drafts').length`), 1);
    assert.equal(await page.evaluate(`document.querySelector('#result p').textContent`), 'Draft updated. Publish it from the console when it’s ready.');
  } finally { await page.close(); }
});

test('the Sync bar shows a linked layer above the footer on both tabs, and Cmd+Enter syncs from it', async () => {
  const node = { id: '40:1', name: 'Banner art', type: 'FRAME', width: 1170, height: 480 };
  const page = await openUi({ selection: linkedSelection(node), delays: { drafts: 300 } });
  const box = id => `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return { top: Math.round(r.top), bottom: Math.round(r.bottom), height: Math.round(r.height) }; })()`;
  try {
    await page.waitFor(`${rows} === 7`);
    await page.waitFor(shown('selection-bar'));
    assert.equal(await page.evaluate(textOf('sync-title')), 'Linked to home.banner');
    assert.equal(await page.evaluate(textOf('sync-meta')), 'from Production');
    assert.equal(await page.evaluate(`document.getElementById('sync-console').href`), `https://console.assetlib.dev/w/org-one/app-a/images/${bannerArt}`);
    await page.waitFor(`document.getElementById('sync-thumb').src.startsWith('data:image/')`, { message: 'the linked image’s preview' });
    assert.equal(await page.evaluate(inViewport('selection-bar')), true);
    assert.equal(await page.evaluate(`document.getElementById('selection-bar').clientHeight`), 48, 'one 48 px row at 420 px, under its 1 px rule');
    assert.equal(await page.evaluate(shown('hint-bar')), false, 'the hint steps aside while the Sync bar shows');
    // Its ink fades in over 120 ms once the placements make it available.
    await page.waitFor(`JSON.stringify(${inkPrimaries}) === '["sync"]'`, { message: 'nothing chosen: Sync is the primary' });
    // A row chosen: the footer's Insert is the one primary, and the bar sits above the footer.
    await page.click('#insert-list .placement[data-key="home.banner"]');
    await page.waitFor(`JSON.stringify(${inkPrimaries}) === '["insert"]'`, { message: 'Insert, the one primary' });
    assert.ok((await page.evaluate(box('selection-bar'))).bottom <= (await page.evaluate(box('insert-bar'))).top, 'above the footer');
    // Tab goes from the list to the bar, then to the footer.
    await page.press('Tab');
    assert.equal(await page.focused(), 'sync-console');
    await page.press('Tab');
    assert.equal(await page.focused(), 'sync');
    await page.press('Tab');
    assert.equal(await page.evaluate(`document.getElementById('insert-bar').contains(document.activeElement)`), true, 'then the footer');
    // Cmd+Enter (Ctrl+Enter off Apple platforms) is Sync, from anywhere outside the connection settings.
    await page.click('#insert-search');
    const command = await page.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`) ? 4 : 2;
    await page.press('Enter', command);
    await page.waitFor(`document.getElementById('sync').textContent === 'Syncing…'`, { message: 'Sync to run' });
    assert.equal(await page.focused(), 'insert-search', 'focus stays where the person was');
    await page.waitFor(`document.getElementById('status').textContent === 'Synced home.banner to draft'`, { message: 'the sync' });
    assert.equal(await page.evaluate(`__harness.log.filter(entry => entry.route === 'drafts').length`), 1);
    // On Send the bar stays, and its Sync is the primary over Send.
    await page.click('#tab-send');
    assert.equal(await page.evaluate(shown('selection-bar')), true);
    await page.waitFor(`JSON.stringify(${inkPrimaries}) === '["sync"]'`, { message: 'Sync, the primary on Send' });
    assert.equal(await page.evaluate(`document.getElementById('send').className`), 'secondary');
  } finally { await page.close(); }

  // Opened from the layer's Sync to Assetlib button: the bar's Sync has focus, and nothing has synced.
  const launched = await openUi({ selection: linkedSelection(node), command: 'sync' });
  try {
    await launched.waitFor(shown('selection-bar'));
    await launched.waitFor(`document.activeElement?.id === 'sync'`, { message: 'Sync to take focus' });
    assert.equal(await launched.evaluate(`document.getElementById('sync').matches(':focus-visible')`), true, 'with its focus ring');
    assert.equal(await launched.evaluate(`__harness.log.filter(entry => entry.route === 'drafts').length`), 0);
  } finally { await launched.close(); }
});

test('an error that arrives while a token is typed keeps every keystroke and focus in the field', async () => {
  const page = await openUi({ delays: { artwork: 800 }, statuses: { artwork: 500 } });
  try {
    await page.waitFor(listBusy, { message: 'the artwork load to start' });
    await page.click('#settings-summary');
    await page.click('#update-token');
    await page.click('#token');
    await page.type('alk_typed_');
    await page.waitFor(shown('insert-empty'), { message: 'the load to fail' });
    assert.equal(await page.focused(), 'token', 'the error did not take focus from the field');
    await page.type('while_loading');
    assert.equal(await page.evaluate(`document.getElementById('token').value`), 'alk_typed_while_loading');
    assert.equal(await page.evaluate(textOf('insert-empty-text')), 'Assetlib had a problem (500). Try again in a minute.');
    assert.equal(await page.evaluate(textOf('alert')), 'Assetlib had a problem (500). Try again in a minute.', 'the alert region announces it');
  } finally { await page.close(); }
});

test('a 401 from the opening connection test while typing in search or the file link keeps every keystroke and focus there', async () => {
  const connectionError = shown('connection-error');
  const search = await openUi({ statuses: { placements: 401 }, delays: { placements: 1200 } });
  try {
    await search.click('#insert-search');
    await search.type('ho');
    assert.equal(await search.evaluate(connectionError), false, 'typed before the test failed');
    await search.waitFor(connectionError, { message: 'the refused token' });
    await search.type('me');
    assert.equal(await search.focused(), 'insert-search', 'the error did not take focus from the search');
    assert.equal(await search.evaluate(`document.getElementById('insert-search').value`), 'home');
    assert.equal(await search.evaluate(`document.getElementById('token').value`), '', 'nothing reached the token field');
    assert.equal(await search.evaluate(`document.getElementById('token').getAttribute('aria-invalid')`), 'true', 'the token is marked for when the settings open');
    assert.equal(await search.evaluate(`document.getElementById('settings').open`), false, 'nothing opens and pushes the search away');
    assert.equal(await search.evaluate(inViewport('insert-search')), true, 'the search is still in view');
  } finally { await search.close(); }

  // The file link is asked for at a Send or Sync, or with Change on a file the document already names.
  const node = { id: '40:1', name: 'Banner art', type: 'FRAME', width: 1170, height: 480 };
  const link = await openUi({ preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: 'abc123', remembered: null, file: { source: 'document', name: 'Untitled' } },
    statuses: { placements: 401 }, delays: { placements: 1200 } });
  try {
    await link.click('#file-change');
    assert.equal(await link.focused(), 'file-url', 'Change asks for this file’s link');
    await link.type('https://www.fig');
    assert.equal(await link.evaluate(connectionError), false, 'typed before the test failed');
    await link.waitFor(connectionError, { message: 'the refused token' });
    await link.type('ma.com/design/abc');
    assert.equal(await link.focused(), 'file-url', 'the error did not take focus from the file link');
    assert.equal(await link.evaluate(`document.getElementById('file-url').value`), 'https://www.figma.com/design/abc');
    assert.equal(await link.evaluate(`document.getElementById('token').value`), '', 'nothing reached the token field');
  } finally { await link.close(); }
});

test('a passing opening test leaves the settings open while a new token is typed', async () => {
  const page = await openUi({ delays: { placements: 1200 } });
  try {
    await page.click('#settings-summary');
    await page.click('#update-token');
    await page.click('#token');
    await page.type('alk_new');
    assert.equal(await page.evaluate(textOf('status')), 'Testing connection…', 'typed while the test ran');
    await page.waitFor(`/^Connected\\./.test(document.getElementById('status').textContent)`, { message: 'the opening test to pass' });
    await page.frames();
    await page.type('_more');
    assert.equal(await page.evaluate(`document.getElementById('settings').open`), true, 'the unsaved token stays in view');
    assert.equal(await page.focused(), 'token');
    assert.equal(await page.evaluate(`document.getElementById('token').value`), 'alk_new_more', 'every keystroke reached the field');
  } finally { await page.close(); }
});

test('Connect closes the settings and moves focus to their summary, never the page', async () => {
  const page = await openUi();
  try {
    await page.waitFor(`${rows} === 7 && !document.getElementById('settings').open`, { message: 'the opening test and list' });
    await page.click('#settings-summary');
    await page.click('#update-token');
    await page.click('#token');
    await page.type(fakeToken('rotated'));
    await page.press('Enter');
    await page.waitFor(`__harness.received.includes('save-connection') && /^Connected to /.test(document.getElementById('status').textContent)`, { message: 'the new connection to pass its test' });
    await page.frames();
    assert.equal(await page.evaluate(`document.getElementById('settings').open`), false);
    assert.equal(await page.focused(), 'settings-summary');
    assert.deepEqual(await page.evaluate('__harness.notices'), ['Connected to Sample workspace · Sample app']);
    // Esc closes the settings too, and focus returns to the chip.
    await page.click('#settings-summary');
    await page.click('#update-token');
    await page.click('#token');
    await page.press('Escape');
    assert.equal(await page.evaluate(`document.getElementById('settings').open`), false);
    assert.equal(await page.focused(), 'settings-summary');
  } finally { await page.close(); }

  // Connect pressed while the opening test runs does nothing, and focus leaves the closing settings the same way.
  const slow = await openUi({ delays: { placements: 1500 } });
  try {
    await slow.waitFor(`document.getElementById('status').textContent === 'Testing connection…'`, { message: 'the opening test' });
    await slow.click('#settings-summary');
    await slow.click('#update-token');
    await slow.click('#connect');
    assert.equal(await slow.focused(), 'connect');
    assert.equal(await slow.evaluate(`document.getElementById('connect').getAttribute('aria-disabled')`), 'true');
    assert.equal(await slow.evaluate(textOf('connect')), 'Connecting…');
    await slow.waitFor(`/^Connected\\./.test(document.getElementById('status').textContent)`, { message: 'the opening test to pass' });
    await slow.frames();
    assert.equal(await slow.focused(), 'settings-summary');
    assert.equal(await slow.evaluate(`__harness.received.filter(type => type === 'save-connection').length`), 0);
  } finally { await slow.close(); }
});

// ---- A.3: the app shell ----

test('the first run connects with only a token, and an older console asks for the IDs', async () => {
  const page = await openUi({ connection: null });
  try {
    await page.waitFor(`document.getElementById('app').dataset.view === 'first-run'`, { message: 'the first-run screen' });
    assert.deepEqual(await page.evaluate(`['.topbar', '#settings-summary', '#panel-insert', '#insert-bar'].map(s => getComputedStyle(document.querySelector(s)).display)`),
      ['none', 'none', 'none', 'none'], 'no tabs, chip, list, or footer');
    assert.equal(await page.evaluate(`document.querySelector('.first-run h1').textContent`), 'Your app’s images, in Figma');
    // Connect to Assetlib leads; the token form is the secondary path, shown once chosen.
    assert.equal(await page.evaluate(`document.getElementById('connection-form').checkVisibility()`), false);
    await page.click('#use-token');
    assert.equal(await page.focused(), 'token');
    assert.equal(await page.evaluate(shown('id-fields')), false, 'a token is all it asks for');
    await page.click('#token');
    await page.type('not-a-token');
    await page.press('Enter');
    assert.equal(await page.evaluate(textOf('connection-error')), 'That doesn’t look like an Assetlib token. Tokens start with alk_.');
    assert.equal(await page.focused(), 'token');
    await page.evaluate(`document.getElementById('token').value = ''`);
    await page.type(fakeToken('first'));
    await page.press('Enter');
    await page.waitFor(`/^Connected to Sample workspace · Sample app\\./.test(document.getElementById('status').textContent)`, { message: 'the connection' });
    await page.frames();
    assert.equal(await page.evaluate(`document.getElementById('app').dataset.view`), 'shell');
    assert.equal(await page.evaluate(`__harness.log.filter(entry => entry.route === 'token').length`), 1, 'GET /api/token named the organization and app');
    assert.equal(await page.evaluate(`document.getElementById('settings').open`), false);
    assert.equal(await page.focused(), 'settings-summary', 'focus moves to the account chip, never the page');
    assert.equal((await page.evaluate(textOf('account-name'))).replace(/\u00a0/g, ' '), 'Sample workspace · Sample app');
    await page.waitFor(`${rows} === 7`, { message: 'the list' });

    // Disconnect: back to the first run, and Connect to Assetlib has focus.
    await page.click('#settings-summary');
    await page.click('#disconnect');
    await page.waitFor(`document.getElementById('app').dataset.view === 'first-run'`, { message: 'the first run again' });
    await page.frames();
    assert.equal(await page.focused(), 'connect-browser');
    assert.equal(await page.evaluate(`document.getElementById('connection-form').checkVisibility()`), false, 'the token form waits to be chosen again');
    assert.equal(await page.evaluate(textOf('status')), 'Disconnected. The token still works elsewhere until an owner revokes it.');
  } finally { await page.close(); }

  for (const [description, options] of [['answers 404', { statuses: { token: 404 } }], ['sends no CORS headers', { failures: ['token'] }]]) {
    const older = await openUi({ connection: null, ...options });
    try {
      await older.click('#use-token');
      await older.click('#token');
      await older.type(fakeToken('older'));
      await older.press('Enter');
      await older.waitFor(shown('connection-error'), { message: description });
      assert.equal(await older.evaluate(textOf('connection-error')), 'This console also needs the organization and app IDs. Find them in Settings › General.', description);
      assert.equal(await older.evaluate(shown('id-fields')), true, description);
      assert.equal(await older.focused(), 'org-id', description);
      // The IDs are the next step, not a mistake: a neutral notice, said politely, and no field marked invalid.
      assert.deepEqual(await older.evaluate(`[document.getElementById('connection-error').className, document.querySelectorAll('[aria-invalid]').length,
        document.getElementById('alert').textContent, document.getElementById('status').textContent]`),
      ['info', 0, '', 'This console also needs the organization and app IDs. Find them in Settings › General.'], description);
      await older.type('org-one');
      await older.click('#app-id');
      await older.type('app-a');
      await older.press('Enter');
      await older.waitFor(`/^Connected to Assetlib\\./.test(document.getElementById('status').textContent)`, { message: `${description}: the connection` });
      assert.deepEqual(await older.evaluate('__harness.notices'), ['Connected to Assetlib'], `${description}: no raw IDs in the toast`);
      assert.equal(await older.evaluate(`__harness.log.filter(entry => entry.route === 'token').length`), 1, `${description}: the IDs are used without asking again`);
    } finally { await older.close(); }
  }
});

test('one-click Connect shows the code to compare, cancels, connects without a typed token, and Disconnect ends it', async () => {
  const page = await openUi({ connection: null });
  try {
    await page.waitFor(`document.getElementById('app').dataset.view === 'first-run'`, { message: 'the first-run screen' });
    await page.click('#connect-browser');
    await page.waitFor(shown('pairing'), { message: 'the request' });
    assert.equal(await page.evaluate(textOf('pairing-code')), 'BCDF-GHJK');
    assert.equal(await page.evaluate(`document.getElementById('pairing-code').getAttribute('aria-label')`), 'Connection code B C D F G H J K');
    assert.equal(await page.focused(), 'pairing-check');
    assert.deepEqual(await page.evaluate('__harness.opened'), [`https://console.assetlib.dev/connect/figma#alw_${'w'.repeat(43)}`]);
    assert.deepEqual(await page.evaluate(`['first-run-title', 'origin-field', 'browser-path', 'connection-form'].map(id => document.getElementById(id).checkVisibility())`),
      [false, false, false, false], 'the request takes the first run’s place');
    for (const id of ['pairing-code', 'pairing-open', 'pairing-check', 'pairing-cancel']) assert.equal(await page.evaluate(inViewport(id)), true, id);
    assert.equal(await page.evaluate(`getComputedStyle(document.getElementById('pairing-code')).fontSize`), '20px');
    // Cancel tells the console and goes back, with focus on Connect to Assetlib.
    await page.click('#pairing-cancel');
    assert.equal(await page.focused(), 'connect-browser');
    await page.waitFor(`__harness.log.filter(entry => entry.route === 'cancel').length === 1`, { message: 'the cancel' });
    // Approved in the browser: the next poll connects, with no token typed and no GET /api/token.
    await page.click('#connect-browser');
    await page.waitFor(shown('pairing'));
    await page.evaluate('__harness.approve()');
    await page.waitFor(`/^Connected to /.test(document.getElementById('status').textContent)`, { timeout: 8000, message: 'the claim' });
    await page.frames();
    assert.equal(await page.evaluate(`document.getElementById('app').dataset.view`), 'shell');
    assert.deepEqual(await page.evaluate('__harness.notices'), ['Connected to Sample workspace · Sample app as dana@example.com']);
    assert.equal(await page.focused(), 'settings-summary', 'focus moves to the account chip, never the page');
    assert.equal(await page.evaluate(`__harness.log.filter(entry => entry.route === 'token').length`), 0);
    // The account panel names who approved it, with Switch workspace and no token form.
    await page.click('#settings-summary');
    assert.equal(await page.evaluate(textOf('token-prefix')), 'Sample workspace · Connected as dana@example.com');
    assert.deepEqual(await page.evaluate(`['switch-workspace', 'update-token', 'connection-form', 'origin-field'].map(id => document.getElementById(id).checkVisibility())`),
      [true, false, false, false]);
    // Disconnect ends the token, then the first run.
    await page.click('#disconnect');
    await page.waitFor(`document.getElementById('app').dataset.view === 'first-run'`, { message: 'the first run again' });
    assert.equal(await page.evaluate(`__harness.log.filter(entry => entry.route === 'current').length`), 1);
    assert.equal(await page.evaluate(textOf('status')), 'Disconnected. This connection was ended.');
  } finally { await page.close(); }

  // An older console: the token form opens at its field, and its Connect is the one primary.
  const older = await openUi({ connection: null, statuses: { start: 404 } });
  try {
    await older.click('#connect-browser');
    await older.waitFor(shown('pairing-note'), { message: 'the older console' });
    assert.deepEqual(await older.evaluate(`[document.getElementById('pairing-note').className, document.getElementById('pairing-note').textContent]`),
      ['info', 'This console can’t connect from Figma yet. Use a token instead.']);
    assert.equal(await older.focused(), 'token');
    assert.deepEqual(await older.evaluate(inkPrimaries), ['connect']);
  } finally { await older.close(); }

  // A browser connection the console refuses says why where it happened, with Connect again, and never opens the token form.
  const refused = await openUi({ connection: browserConnection, statuses: { placements: 403 }, codes: { placements: 'member' } });
  try {
    await refused.waitFor(shown('insert-empty'), { message: 'the refusal' });
    assert.equal(await refused.evaluate(textOf('insert-empty-text')), 'Your role no longer allows sending drafts. Ask a workspace owner, then connect again.');
    assert.equal(await refused.evaluate(textOf('insert-token')), 'Connect again');
    assert.equal(await refused.evaluate(`document.getElementById('settings').open`), false);
    await refused.click('#insert-token');
    await refused.waitFor(shown('pairing'), { message: 'Connect again' });
    assert.equal(await refused.evaluate(`document.getElementById('connection-form').checkVisibility()`), false);
    assert.equal(await refused.evaluate(inViewport('pairing-check')), true);
  } finally { await refused.close(); }
});

test('≥7 placement rows visible at 420×720 with a selection and cell pickers', async () => {
  const page = await openUi({ placements: 30, declared: true });
  try {
    await page.waitFor(`${rows} === 30`, { message: 'thirty placements' });
    await page.click('#insert-list .placement[data-key="screen0.slot0"]');
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#insert-bar .picker')].filter(label => !label.hidden).length`), 3, 'State, Appearance, and A/B arm');
    const visible = await page.evaluate(`(() => { const region = document.getElementById('list-region').getBoundingClientRect();
      return [...document.querySelectorAll('#insert-list .placement[data-key]')].filter(row => { const r = row.getBoundingClientRect();
        return r.top >= region.top - 0.5 && r.bottom <= region.bottom + 0.5; }).length; })()`);
    assert.ok(visible >= 7, `${visible} rows are fully visible`);
    // The bars are fixed: only the list scrolls.
    const bars = `['.topbar', '.toolbar', '.scopebar', '#insert-bar'].map(s => Math.round(document.querySelector(s).getBoundingClientRect().top))`;
    const before = await page.evaluate(bars);
    await page.evaluate(`document.getElementById('list-region').scrollTop = 600`);
    await page.frames();
    assert.deepEqual(await page.evaluate(bars), before);
    assert.equal(await page.evaluate('document.scrollingElement.scrollTop'), 0, 'the page itself does not scroll');
  } finally { await page.close(); }
});

// Names as people give layers (Send names an image after its layer): many have no break opportunity at all.
const longImageNames = ['onboarding_hero_dark_final_v2', 'travel.coast.background.large', 'IMG_20261009_142233', 'home-banner-summer-campaign-light',
  'Coast house', 'a_layer_name_far_too_long_for_two_lines_of_any_tile_in_this_grid_v12'];
// A Sync whose draft also updated a cell with a 63-character key, which its Details list names.
const longKey = 'onboarding.welcome_carousel_slide_three_hero_illustration_large';
const longRebound = (() => {
  const node = { id: '40:1', name: 'Home banner', type: 'FRAME', width: 390, height: 160 };
  const cell = slotKey => ({ slotKey, state: null, appearance: null, arm: null });
  return { preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: 'abc123', remembered: { fileKey: 'abc123', nodeId: node.id, placementKey: 'home.banner', state: null, appearance: null, arm: null, insertedFrom: null } },
    draft: { status: 201, body: { asset: { id: '00000000-0000-4000-8000-000000009999', name: 'Sent', width: 1170, height: 480, sha256: 'a'.repeat(64), renditions: 1 },
      previous: null, bound: cell('home.banner'), bindError: null, rebound: [cell('home.banner'), cell(longKey)] } } };
})();

// What main reports for a selected frame with children, with a name the footer's primary must shorten (A.5), and for
// several shapes or one linked layer.
const longFrame = 'A frame with a long name that has to be shortened somewhere';
const intoLong = { mode: 'into', label: `Insert into ${longFrame}`, count: 1, nodeIds: ['40:1'], name: longFrame, containerWidth: 390 };
const fillThree = { mode: 'fill', label: 'Fill 3 layers', count: 3, nodeIds: ['41:1', '41:2', '41:3'], containerWidth: 120 };
const replaceOne = { mode: 'replace', label: 'Replace image', count: 1, nodeIds: ['42:1'], name: 'home.banner', containerWidth: 390 };
const intoComponent = { mode: 'into', label: 'Insert into Card', count: 1, nodeIds: ['43:1'], name: 'Card', containerWidth: 390, insideComponent: true };
const canvasSelection = insertTarget => ({ selection: { ...DEFAULTS.selection, insertTarget } });
// A layer linked to home.banner as main reports it (A.7): its link, written on it for this app, names Production art.
const bannerArt = '00000000-0000-4000-8000-000000010002';
const linkedSelection = layer => ({ node: layer, reason: null, fileKey: 'abc123', file: { source: 'figma', name: '' },
  remembered: { fileKey: 'abc123', nodeId: layer.id, placementKey: 'home.banner', state: null, appearance: null, arm: null, insertedFrom: { environment: 'production', assetId: bannerArt } },
  link: { kind: 'linked', placementKey: 'home.banner', state: null, appearance: null, arm: null, environment: 'production', assetId: bannerArt } });

test('no overflow at 320×480, 420×720, 640×900', async () => {
  // Nothing wider than the window, and the page itself never scrolls either way: only the list (or the Send form) does.
  const check = `(() => { const width = document.documentElement.clientWidth; const region = document.getElementById('list-region');
    const wide = [...document.querySelectorAll('body *')].filter(el => !el.closest('.visually-hidden')).filter(el => { const r = el.getBoundingClientRect();
      return r.width > 0 && r.right > width + 0.5; }).map(el => el.id || el.getAttribute('data-key') || el.className || el.tagName);
    return { page: document.documentElement.scrollWidth - width, pageY: document.documentElement.scrollHeight - document.documentElement.clientHeight,
      list: region.scrollWidth - region.clientWidth, wide: wide.slice(0, 5) }; })()`;
  const tall = { id: '40:1', name: 'A frame with a long name that has to be shortened somewhere', type: 'FRAME', width: 390, height: 844 };
  const remembered = { fileKey: 'abc123', nodeId: tall.id, placementKey: 'home.banner', state: null, appearance: null, arm: null, insertedFrom: null };
  const scenarios = [
    ['the first run', { connection: null }, null],
    ['the first run with the token form', { connection: null }, async page => { await page.click('#use-token'); }],
    ['Connect waiting for approval', { connection: null }, async page => { await page.click('#connect-browser'); await page.waitFor(shown('pairing')); }],
    ['a Connect that couldn’t reach the console', { connection: null, failures: ['start'] }, async page => { await page.click('#connect-browser'); await page.waitFor(shown('pairing-note')); }],
    ['Switch workspace waiting', { connection: browserConnection }, async page => {
      await page.waitFor(`${rows} === 7`); await page.click('#settings-summary'); await page.click('#switch-workspace'); await page.waitFor(shown('pairing'));
    }],
    ['the list with a selection and pickers', { placements: 30, declared: true }, async page => { await page.waitFor(`${rows} === 30`); await page.click('#insert-list .placement[data-key="screen0.slot0"]'); }],
    ['the image grid', { preferences: { browse: 'images' }, imageNames: longImageNames }, async page => { await page.waitFor(`${tiles} === 24`); await page.click('#image-grid .tile'); }],
    ['the open account panel', {}, async page => { await page.waitFor(`${rows} === 7`); await page.click('#settings-summary'); }],
    ['Send with the ratio gate', { preferences: { tab: 'send' }, selection: { node: tall, reason: null, fileKey: 'abc123', remembered } },
      async page => { await page.waitFor(shown('aspect-warning')); }],
    // A Sync's Details name other cells by key, and keys run up to 120 characters with no spaces.
    ['Sync’s Details with a long placement key', longRebound,
      async page => { await page.click('#sync'); await page.waitFor(shown('result')); await page.click('#result summary'); }],
    // The footer's primary names the frame it inserts into, with the hint and Insert as new frame under it.
    ['Insert into a frame with a long name', canvasSelection(intoLong),
      async page => { await page.waitFor(`${rows} === 7`); await page.click('#insert-list .placement[data-key="home.banner"]'); }],
    ['Fill several layers', canvasSelection(fillThree),
      async page => { await page.waitFor(`${rows} === 7`); await page.click('#insert-list .placement[data-key="home.banner"]'); }],
    ['Insert beside a component, with its note', canvasSelection(intoComponent),
      async page => { await page.waitFor(`${rows} === 7`); await page.click('#insert-list .placement[data-key="home.banner"]'); await page.waitFor(shown('insert-note')); }],
    ['the hint bar, wrapped', {}, async page => { await page.waitFor(`${rows} === 7`); await page.waitFor(shown('hint-bar')); }],
    // The Sync bar wraps its actions under its text rather than overflow: with the footer, with the ratio off, and for a copy.
    ['the Sync bar above the footer', { selection: linkedSelection({ id: '40:1', name: 'Banner art', type: 'FRAME', width: 1170, height: 480 }) },
      async page => { await page.waitFor(`${rows} === 7`); await page.click('#insert-list .placement[data-key="home.banner"]'); }],
    ['the Sync bar with the ratio off', { selection: linkedSelection(tall) }, async page => { await page.waitFor(`${rows} === 7`); await page.waitFor(shown('sync-match')); }],
    ['the Sync bar for a copy', { selection: { ...linkedSelection(tall), remembered: null, link: { ...linkedSelection(tall).link, kind: 'copy' } } },
      async page => { await page.waitFor(`${rows} === 7`); await page.waitFor(shown('sync-send')); }],
  ];
  for (const size of [{ width: 320, height: 480 }, { width: 420, height: 720 }, { width: 640, height: 900 }]) {
    for (const [name, options, steps] of scenarios) {
      const page = await openUi(options, size);
      try {
        await steps?.(page);
        await page.frames();
        assert.deepEqual(await page.evaluate(check), { page: 0, pageY: 0, list: 0, wide: [] }, `${name} at ${size.width}×${size.height}`);
      } finally { await page.close(); }
    }
  }
});

test('the selection names the footer’s primary, and Insert as new frame sits under it', async () => {
  const page = await openUi(canvasSelection(intoLong));
  try {
    await page.waitFor(`${rows} === 7`);
    await page.click('#insert-list .placement[data-key="home.banner"]');
    assert.deepEqual(await page.evaluate(`(() => { const b = document.getElementById('insert'); const style = getComputedStyle(b);
      return { text: b.textContent, title: b.title, cut: b.scrollWidth > b.clientWidth, overflow: style.textOverflow }; })()`),
    { text: intoLong.label, title: intoLong.label, cut: true, overflow: 'ellipsis' }, 'a long name is shortened with an ellipsis, and whole on hover');
    assert.deepEqual(await page.evaluate(`(() => { const a = document.getElementById('insert').getBoundingClientRect();
      const b = document.getElementById('insert-new').getBoundingClientRect(); return { below: b.top >= a.bottom - 0.5, right: Math.round(a.right - b.right) }; })()`),
    { below: true, right: 0 }, 'under the primary, right-aligned with it');
    // The frame's name, quoted and cut to 24 characters, so the note stays short.
    assert.equal(await page.evaluate(textOf('insert-note')), `Wider than “${longFrame.slice(0, 23)}…” (390\u00a0px). Try 3×.`);
    assert.equal(await page.evaluate(shown('scale-group')), true);
    assert.equal(await page.evaluate(inViewport('insert-new')), true);
    await page.click('#insert');
    await page.waitFor('window.__harness.targets.length === 1');
    await page.waitFor(`!document.getElementById('insert').hasAttribute('aria-disabled')`, { message: 'the insert to finish' });
    await page.click('#insert-new');
    await page.waitFor('window.__harness.targets.length === 2');
    assert.deepEqual(await page.evaluate('window.__harness.targets'), [{ kind: 'into', nodeId: '40:1' }, { kind: 'new' }]);
    assert.equal(await page.focused(), 'insert-new', 'focus stays on the action');
  } finally { await page.close(); }

  for (const [target, expected, status] of [[fillThree, { kind: 'fill', nodeIds: fillThree.nodeIds }, 'Filled 3 layers with home.banner.'],
    [replaceOne, { kind: 'fill', nodeIds: replaceOne.nodeIds }, 'Replaced image in home.banner.']]) {
    const fill = await openUi(canvasSelection(target));
    try {
      await fill.waitFor(`${rows} === 7`);
      await fill.click('#insert-list .placement[data-key="home.banner"]');
      assert.equal(await fill.evaluate(textOf('insert')), target.label);
      assert.equal(await fill.evaluate(shown('scale-group')), false, `${target.mode}: the layer keeps its size`);
      assert.equal(await fill.evaluate(shown('insert-new')), true);
      await fill.press('Enter');
      await fill.waitFor('window.__harness.targets.length === 1');
      assert.deepEqual(await fill.evaluate('window.__harness.targets'), [expected], `${target.mode}: Enter on the row runs the primary`);
      await fill.waitFor(`${textOf('status')} === ${JSON.stringify(status)}`, { message: `${target.mode}: the status repeats the toast` });
    } finally { await fill.close(); }
  }

  // Placement art is a component, which Figma puts in no component: Insert goes beside one, and the note says why.
  // A library image, a frame, still goes in.
  const component = await openUi(canvasSelection(intoComponent));
  try {
    await component.waitFor(`${rows} === 7`);
    await component.click('#insert-list .placement[data-key="home.banner"]');
    assert.deepEqual(await component.evaluate(`[${textOf('insert')}, ${shown('insert-new')}, ${textOf('insert-note')}, ${shown('insert-note')}]`),
      ['Insert', false, 'Figma doesn’t put components inside components, so this goes beside Card.', true]);
    await component.press('Enter');
    await component.waitFor('window.__harness.targets.length === 1');
    assert.deepEqual(await component.evaluate('window.__harness.targets'), [{ kind: 'new' }]);
  } finally { await component.close(); }
  const image = await openUi({ ...canvasSelection(intoComponent), preferences: { browse: 'images' } });
  try {
    await image.waitFor(`${tiles} > 0`);
    await image.click('#image-grid .tile');
    assert.equal(await image.evaluate(textOf('insert')), 'Insert into Card');
    assert.doesNotMatch(await image.evaluate(textOf('insert-note')), /components/);
    await image.click('#insert');
    await image.waitFor('window.__harness.targets.length === 1');
    assert.deepEqual(await image.evaluate('window.__harness.targets'), [{ kind: 'into', nodeId: '43:1' }]);
  } finally { await image.close(); }
});

test('the embedded font loads: document.fonts.check(\'12px "Instrument Sans"\')', async () => {
  const page = await openUi();
  try {
    await page.waitFor(`${rows} === 7`);
    await page.evaluate('document.fonts.ready.then(() => true)');
    assert.equal(await page.evaluate(`document.fonts.check('12px "Instrument Sans"')`), true);
    // check() is also true for a family nothing declares, so the face itself must be there and loaded.
    assert.deepEqual(await page.evaluate(`[...document.fonts].filter(face => face.family.replace(/["']/g, '') === 'Instrument Sans').map(face => face.status)`), ['loaded']);
    assert.match(await page.evaluate(`getComputedStyle(document.querySelector('.key')).fontFamily`), /^"?Instrument Sans"?,/);
  } finally { await page.close(); }
});

test('errors render inside the viewport', async () => {
  for (const size of [{ width: 420, height: 720 }, { width: 320, height: 480 }]) {
    const label = `${size.width}×${size.height}`;
    // An insert that fails: the error line sits above the footer, in view, with focus.
    const insert = await openUi({ statuses: { rendition: 404 }, placements: 30 }, size);
    try {
      await insert.waitFor(`${rows} === 30`);
      await insert.evaluate(`document.getElementById('list-region').scrollTop = 99999`);
      await insert.click('#insert-list .placement[data-key="screen3.slot29"]');
      await insert.click('#insert');
      await insert.waitFor(shown('error'), { message: `${label}: the insert error` });
      assert.equal(await insert.evaluate(textOf('error')), 'This image was removed. Refresh to update the list.');
      assert.equal(await insert.evaluate(inViewport('error-box')), true, `${label}: the error line`);
      assert.equal(await insert.evaluate(inViewport('error-action')), true, `${label}: its Refresh`);
      assert.equal(await insert.focused(), 'error');
      const reads = `__harness.log.filter(entry => entry.route === 'artwork').length`;
      const before = await insert.evaluate(reads);
      await insert.click('#error-action');
      await insert.waitFor(`${reads} === ${before + 1} && ${rows} === 30`, { message: `${label}: Refresh` });
      assert.equal(await insert.evaluate(shown('error-box')), false);
    } finally { await insert.close(); }
    // A list that can't load says why in place of the list.
    const list = await openUi({ statuses: { artwork: 500 } }, size);
    try {
      await list.waitFor(shown('insert-empty'), { message: `${label}: the list error` });
      assert.equal(await list.evaluate(inViewport('insert-empty-text')), true, `${label}: the list error`);
      assert.equal(await list.evaluate(inViewport('insert-retry')), true, `${label}: Try again`);
    } finally { await list.close(); }
    // A refused token on the opening test: the list says so in its place, with Update token, which opens the settings
    // at the token field with the reason under it.
    const refused = await openUi({ statuses: { placements: 401 } }, size);
    try {
      await refused.waitFor(shown('insert-empty'), { message: `${label}: the refused token` });
      assert.equal(await refused.evaluate(`document.getElementById('settings').open`), false, `${label}: nothing opens by itself`);
      assert.equal(await refused.evaluate(inViewport('insert-empty-text')), true, `${label}: the list's reason`);
      assert.equal(await refused.evaluate(inViewport('insert-token')), true, `${label}: Update token`);
      assert.equal(await refused.focused(), 'insert-empty');
      await refused.click('#insert-token');
      assert.equal(await refused.evaluate(inViewport('connection-error')), true, `${label}: the connection error`);
      assert.equal(await refused.evaluate(inViewport('token')), true, `${label}: the token field`);
      assert.equal(await refused.focused(), 'token');
      assert.equal(await refused.evaluate(shown('insert-empty')), false, `${label}: said once`);
    } finally { await refused.close(); }
    // On Send, the form says it, in view.
    const send = await openUi({ statuses: { placements: 401 }, preferences: { tab: 'send' } }, size);
    try {
      await send.waitFor(shown('send-problem'), { message: `${label}: Send's reason` });
      assert.equal(await send.evaluate(inViewport('send-problem')), true, `${label}: Send's reason`);
      assert.equal(await send.focused(), 'send-problem');
    } finally { await send.close(); }
  }
});

test('controls inside a callout stand apart from it, and hover shows in Figma’s themes', async () => {
  const tall = { id: '40:1', name: 'Home banner', type: 'FRAME', width: 390, height: 844 };
  // Each control inside a visible callout: its background differs from the callout's, and it has a visible border.
  const apart = `[...document.querySelectorAll('.notice, .error, .info')].filter(callout => callout.checkVisibility()).flatMap(callout => {
    const back = getComputedStyle(callout).backgroundColor;
    return [...callout.querySelectorAll('input, select, button')].filter(control => control.checkVisibility()).map(control => {
      const style = getComputedStyle(control);
      // A focused field's ring stands for its border (an invalid one's red border would double the ring).
      const ring = control.matches(':focus-visible') && style.outlineStyle === 'solid' && parseFloat(style.outlineWidth) >= 2;
      return { id: control.id || control.textContent, apart: style.backgroundColor !== back && (ring || (style.borderTopStyle === 'solid'
        && parseFloat(style.borderTopWidth) >= 1 && style.borderTopColor !== back && style.borderTopColor !== 'rgba(0, 0, 0, 0)')) };
    });
  })`;
  async function hover(page, selector) {
    const box = await page.evaluate(`(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await page.frames();
  }
  const style = (selector, property) => `getComputedStyle(document.querySelector(${JSON.stringify(selector)})).${property}`;
  for (const mode of ['light', 'dark', null]) {
    const label = mode ?? 'no theme';
    // The file link, Link file, Use anyway, and Match ratio, all in callouts on Send: the first Send asks for the link,
    // a link to another file is questioned, and a placement of another ratio is gated.
    const page = await openUi({ preferences: { tab: 'send' }, fileName: 'Roam onboarding',
      selection: { node: { ...tall, height: 160 }, reason: null, fileKey: null, remembered: null } }, { theme: mode });
    try {
      await page.waitFor(`document.getElementById('placement').options.length > 1`);
      await page.evaluate(choose('placement', 'home.banner'));
      await page.click('#send');
      assert.equal(await page.focused(), 'file-url');
      await page.type('https://www.figma.com/design/zzz/Coast-house');
      await page.press('Enter');
      await page.waitFor(shown('file-mismatch-box'));
      await page.evaluate(choose('placement', 'onboarding.hero'));
      await page.waitFor(shown('aspect-warning'));
      const controls = await page.evaluate(apart);
      assert.deepEqual(controls.map(item => item.id), ['file-url', 'Link file', 'file-anyway', 'match-ratio'], label);
      assert.deepEqual(controls.filter(item => !item.apart), [], `${label}: every control stands apart from its callout`);
      // Hovering Match ratio changes its fill.
      const rest = await page.evaluate(style('#match-ratio', 'backgroundColor'));
      await hover(page, '#match-ratio');
      assert.notEqual(await page.evaluate(style('#match-ratio', 'backgroundColor')), rest, `${label}: Match ratio shows hover`);
      // A hovered tab never looks like the selected one.
      await hover(page, '#tab-insert');
      const [hovered, active] = await page.evaluate(`[document.getElementById('tab-insert'), document.getElementById('tab-send')].map(tab => { const s = getComputedStyle(tab); return s.backgroundColor + ' ' + s.color; })`);
      assert.notEqual(hovered, active, `${label}: a hovered tab differs from the selected tab`);
    } finally { await page.close(); }
    // The error line's Refresh, and Send's Try again after a failed connection test.
    const insert = await openUi({ statuses: { rendition: 404 } }, { theme: mode });
    try {
      await insert.waitFor(`${rows} === 7`);
      await insert.click('#insert-list .placement[data-key="home.banner"]');
      // A secondary button outside a callout shows hover too (Figma's bg-hover equals bg-secondary).
      await insert.click('#insert');
      await insert.waitFor(shown('error-box'));
      assert.deepEqual((await insert.evaluate(apart)).filter(item => !item.apart), [], `${label}: Refresh stands apart`);
    } finally { await insert.close(); }
    const retry = await openUi({ failures: ['placements'], preferences: { tab: 'send' } }, { theme: mode });
    try {
      await retry.waitFor(shown('send-problem'), { timeout: 12000 });
      assert.deepEqual((await retry.evaluate(apart)).map(item => [item.id, item.apart]), [['send-retry', true]], `${label}: Try again stands apart`);
    } finally { await retry.close(); }
  }
});

test('a failed opening connection test is said once, with at most one primary on screen', async () => {
  const scenarios = [
    ['Insert, unreachable', { failures: ['placements'] }, 'insert-empty', 'Can’t reach Assetlib', 'insert-retry'],
    ['Insert, refused', { statuses: { placements: 401 } }, 'insert-empty', 'this token', 'insert-token'],
    ['Send, unreachable', { failures: ['placements'], preferences: { tab: 'send' } }, 'send-problem', 'Can’t reach Assetlib', 'send-retry'],
    ['Send, refused', { statuses: { placements: 401 }, preferences: { tab: 'send' } }, 'send-problem', 'this token', 'send-token'],
  ];
  for (const [name, options, place, words, action] of scenarios) {
    const page = await openUi(options);
    try {
      await page.waitFor(shown(place), { timeout: 12000, message: `${name}: the reason` });
      await page.frames();
      assert.equal(await page.evaluate(`document.getElementById('settings').open`), false, `${name}: nothing opens by itself`);
      assert.equal(await page.evaluate(timesShown(words)), 1, `${name}: said once`);
      assert.equal(await page.evaluate(`!document.getElementById('chip-warning').hidden`), true, `${name}: the chip warns`);
      assert.equal(await page.evaluate(`(() => { const app = document.querySelector('.chip-app'); return app.scrollWidth <= app.clientWidth; })()`), true,
        `${name}: beside the warning, the chip still shows the app's whole name`);
      assert.equal(await page.focused(), place, `${name}: focus moves to it`);
      assert.ok((await page.evaluate(inkPrimaries)).length <= 1, `${name}: one primary at most`);
      assert.equal(await page.evaluate(shown(action)), true, `${name}: its one action`);
      if (action.endsWith('token')) {
        // Update token: the settings open at the token field, which says it, and the view steps aside.
        await page.click(`#${action}`);
        assert.equal(await page.focused(), 'token');
        assert.equal(await page.evaluate(timesShown(words)), 1, `${name}: still said once`);
        assert.deepEqual(await page.evaluate(inkPrimaries), ['connect'], `${name}: Connect is the one primary`);
        await page.press('Escape');
        assert.equal(await page.evaluate(shown(place)), true, `${name}: closing the settings gives it back to the view`);
        assert.equal(await page.evaluate(timesShown(words)), 1);
      }
    } finally { await page.close(); }
  }
  // A working connection with something selected and the account panel open: Insert is the one primary.
  const page = await openUi();
  try {
    await page.waitFor(`${rows} === 7`);
    await page.click('#insert-list .placement[data-key="home.banner"]');
    await page.click('#settings-summary');
    assert.deepEqual(await page.evaluate(inkPrimaries), ['insert']);
    assert.equal(await page.evaluate(`document.getElementById('connect').className`), 'secondary wide');
  } finally { await page.close(); }
  // The first run's Connect to Assetlib is its primary, and stays so with the token form chosen.
  const first = await openUi({ connection: null });
  try {
    await first.waitFor(`document.getElementById('app').dataset.view === 'first-run'`);
    await first.frames();
    assert.deepEqual(await first.evaluate(inkPrimaries), ['connect-browser']);
    await first.click('#use-token');
    assert.deepEqual(await first.evaluate(inkPrimaries), ['connect-browser']);
  } finally { await first.close(); }
});

test('an app name too long to leave the workspace a character shows alone in the chip, with no stray separator', async () => {
  const names = { workspaceName: 'Roam', appName: `Roam for iPhone, iPad and Mac ${'with a very long name '.repeat(4)}`.trim() };
  const page = await openUi({ declared: true, placements: 3, connection: { ...DEFAULTS.connection, ...names }, identity: { ...DEFAULTS.identity, ...names } });
  try {
    await page.waitFor(`${rows} === 3`);
    await page.evaluate('document.fonts.ready.then(() => true)');
    await page.frames();
    assert.deepEqual(await page.evaluate(`['.chip-workspace', '.chip-sep'].map(s => document.querySelector(s).hidden)`), [true, true]);
    // The app's name takes the chip's room and ends in an ellipsis inside it.
    assert.deepEqual(await page.evaluate(`(() => { const chip = document.getElementById('settings-summary').getBoundingClientRect(); const app = document.querySelector('.chip-app');
      const box = app.getBoundingClientRect(); return [app.scrollWidth > app.clientWidth, box.width > 100, box.right <= chip.right]; })()`), [true, true, true]);
  } finally { await page.close(); }
});

test('footer, chip, grid, and tile details fit at 420 px', async () => {
  const names = { workspaceName: 'A workspace with quite a long name that goes on', appName: 'Roam iOS' };
  const page = await openUi({ declared: true, placements: 30, connection: { ...DEFAULTS.connection, ...names }, identity: { ...DEFAULTS.identity, ...names } });
  try {
    await page.waitFor(`${rows} === 30`);
    await page.evaluate('document.fonts.ready.then(() => true)');
    await page.frames();
    // The chip shortens the workspace first, so the app's name stays whole.
    assert.deepEqual(await page.evaluate(`['.chip-workspace', '.chip-app'].map(s => { const el = document.querySelector(s); return el.scrollWidth > el.clientWidth; })`), [true, false]);
    // The shortened name's box ends at its ellipsis, so the spaces either side of the "·" match: Chrome keeps the
    // longest start of the name that fits with the ellipsis, and nothing unused sits between it and the separator.
    const [before, after] = await page.evaluate(`(() => { const workspace = document.querySelector('.chip-workspace'); const text = workspace.firstChild;
      const range = document.createRange(); const box = workspace.getBoundingClientRect();
      const mark = workspace.appendChild(document.createTextNode('…')); range.selectNodeContents(mark); const ellipsis = range.getBoundingClientRect().width; mark.remove();
      let shown = 0;
      for (let end = 0; end <= text.length; end += 1) { range.setStart(text, 0); range.setEnd(text, end); const width = range.getBoundingClientRect().width; if (width + ellipsis <= box.width) shown = width; }
      const separator = document.querySelector('.chip-sep').firstChild; range.setStart(separator, 1); range.setEnd(separator, 2); const dot = range.getBoundingClientRect();
      return [dot.left - (box.left + shown + ellipsis), document.querySelector('.chip-app').getBoundingClientRect().left - dot.right]; })()`);
    assert.ok(Math.abs(before - after) <= 1, `the spaces either side of the separator differ: ${before.toFixed(1)} px before, ${after.toFixed(1)} px after`);
    await page.click('#insert-list .placement[data-key="screen0.slot0"]');
    await page.evaluate(choose('insert-appearance', 'dark'));
    await page.evaluate(choose('insert-arm', 'b'));
    await page.frames();
    // Inherited art: the pickers name the cell, and the line names what it inherits, whole.
    assert.equal(await page.evaluate(textOf('insert-meta')), 'Draft · Uses Control · Any art');
    assert.equal(await page.evaluate(`(() => { const el = document.getElementById('insert-meta'); return el.scrollWidth <= el.clientWidth; })()`), true, 'the meta line is not cut');
    // Each label sits 4 px from its select and 12 px from the next picker.
    const gaps = await page.evaluate(`[...document.querySelectorAll('#insert-bar .picker:not([hidden])')].map(label => {
      const words = document.createRange(); words.selectNodeContents(label.firstChild);
      const select = label.querySelector('select').getBoundingClientRect(); const next = label.nextElementSibling?.getBoundingClientRect();
      return [Math.round(select.left - words.getBoundingClientRect().right), next ? Math.round(next.left - label.getBoundingClientRect().right) : null]; })`);
    assert.deepEqual(gaps, [[4, 12], [4, 12], [4, null]]);
  } finally { await page.close(); }
  // The images empty state sits where the placements' does.
  const top = async options => {
    const view = await openUi(options);
    try { await view.waitFor(shown('insert-empty')); return await view.evaluate(`Math.round(document.getElementById('insert-empty').getBoundingClientRect().top)`); }
    finally { await view.close(); }
  };
  assert.equal(await top({ images: 0, preferences: { browse: 'images' } }), await top({ artwork: 'empty' }));
  // A selected tile is ringed as a whole, not just its thumbnail. Tile names wrap within two lines, then end in an
  // ellipsis, even with no break opportunity (onboarding_hero_dark_final_v2): never cut at the tile's edge.
  const grid = await openUi({ preferences: { browse: 'images' }, imageNames: longImageNames });
  try {
    await grid.waitFor(`${tiles} === 24`);
    await grid.evaluate('document.fonts.ready.then(() => true)');
    await grid.frames();
    const names = await grid.evaluate(`[...document.querySelectorAll('#image-grid .tile .name')].slice(0, 6).map(name => ({ text: name.textContent,
      cut: name.scrollWidth > name.clientWidth, lines: Math.round(name.getBoundingClientRect().height / parseFloat(getComputedStyle(name).lineHeight)),
      clamped: name.scrollHeight > name.clientHeight + 1 }))`);
    assert.deepEqual(names.map(name => name.text), longImageNames);
    for (const name of names) {
      assert.equal(name.cut, false, `${name.text} is cut at the tile's edge`);
      assert.ok(name.lines >= 1 && name.lines <= 2, `${name.text} takes ${name.lines} lines`);
    }
    assert.deepEqual(names.slice(0, 2).map(name => name.lines), [2, 2], 'names with no break opportunity wrap to a second line');
    assert.equal(names.at(-1).clamped, true, 'a name longer than two lines is clamped (with an ellipsis)');
    await grid.click('#image-grid .tile');
    assert.deepEqual(await grid.evaluate(`(() => { const tile = document.querySelector('#image-grid .tile[aria-selected="true"]');
      return [getComputedStyle(tile).boxShadow !== 'none', getComputedStyle(tile.querySelector('.thumb')).boxShadow]; })()`), [true, 'none']);
  } finally { await grid.close(); }
});

// ---- A.4: the keyboard ----

/** The chosen rows or tiles, and the rows or tiles that are a tab stop (tabindex 0), by key or asset id. */
const chosenKeys = `[...document.querySelectorAll('[role="option"][aria-selected="true"]')].map(el => el.getAttribute('data-key') || el.getAttribute('data-asset-id'))`;
const listStops = `[...document.querySelectorAll('[role="option"]')].filter(el => el.tabIndex === 0).map(el => el.getAttribute('data-key') || el.getAttribute('data-asset-id'))`;
const valueOf = id => `document.getElementById('${id}').value`;

test('≤15 tab stops with 500 placements', async () => {
  const page = await openUi({ placements: 500, declared: true });
  try {
    await page.waitFor(`${rows} === 500`, { message: '500 placements' });
    await page.click('#insert-list .placement[data-key="screen0.slot0"]');
    // Tab from the first stop until focus leaves the page or comes round again: every stop, in order.
    await page.evaluate(`document.getElementById('tab-insert').focus()`);
    const stops = ['tab-insert'];
    for (let i = 0; i < 40; i += 1) {
      await page.press('Tab');
      const id = await page.focused();
      if (id === 'body' || stops.includes(id)) break;
      stops.push(id);
    }
    assert.ok(stops.length <= 15, `${stops.length} tab stops: ${stops.join(', ')}`);
    // Tabs → account → search → scope → list → footer; each tab list, radio group, and the list is one stop.
    assert.deepEqual(stops, ['tab-insert', 'settings-summary', 'insert-search', 'insert-refresh', 'browse-placements', 'env-draft', 'screen0.slot0',
      'insert-state', 'insert-appearance', 'insert-arm', 'scale-1', 'insert']);
    assert.deepEqual(await page.evaluate(listStops), ['screen0.slot0'], 'one of the 500 rows is a tab stop');
    // Shift+Tab from the footer comes back to the chosen row.
    await page.evaluate(`document.getElementById('insert-state').focus()`);
    await page.press('Tab', 8);
    assert.equal(await page.focused(), 'screen0.slot0');
  } finally { await page.close(); }
});

test('arrows move selection', async () => {
  const page = await openUi();
  try {
    await page.waitFor(`${rows} === 7`);
    // A listbox, with a group of options for each screen named by its header.
    assert.deepEqual(await page.evaluate(`(() => { const list = document.getElementById('insert-list');
      return [list.getAttribute('role'), list.getAttribute('aria-label'), list.querySelectorAll('[role="option"]').length,
        [...list.querySelectorAll('[role="group"]')].map(group => document.getElementById(group.getAttribute('aria-labelledby')).textContent)]; })()`),
    ['listbox', 'Placements', 7, ['Onboarding', 'Home', 'Settings']]);
    await page.click('#insert-list .placement[data-key="onboarding.hero"]');
    const at = async (key, message) => {
      assert.equal(await page.focused(), key, message);
      assert.deepEqual(await page.evaluate(chosenKeys), [key], `${message}: chosen`);
      assert.deepEqual(await page.evaluate(listStops), [key], `${message}: the one tab stop`);
      assert.equal(await page.evaluate(textOf('insert-title')), key, `${message}: the footer`);
    };
    await page.press('ArrowDown'); await at('onboarding.footer', '↓');
    await page.press('ArrowDown'); await at('home.banner', '↓ into the next screen');
    await page.press('ArrowUp'); await at('onboarding.footer', '↑');
    await page.press('End'); await at('settings.empty', 'End');
    await page.press('ArrowDown'); await at('settings.empty', '↓ on the last row');
    await page.press('Home'); await at('onboarding.hero', 'Home');
    await page.press('ArrowUp'); await at('onboarding.hero', '↑ on the first row');
    // Type-ahead: a letter jumps to the next key it starts, the same letter to the one after, and letters typed together narrow.
    // Letters more than half a second apart start a new search.
    const pause = () => new Promise(resolve => setTimeout(resolve, 600));
    await page.press('s'); await at('settings.header', 's');
    await page.press('s'); await at('settings.empty', 's again');
    await pause();
    for (const key of 'home.p') await page.press(key);
    await at('home.promo', 'home.p');
    await pause();
    await page.press('o'); await at('onboarding.hero', 'o, from the end round to the start');
    // Space chooses the focused row (here after Esc cleared the choice); within a type-ahead it is a letter.
    await page.press('Escape');
    assert.deepEqual(await page.evaluate(chosenKeys), []);
    await pause();
    await page.press(' '); await at('onboarding.hero', 'Space');
  } finally { await page.close(); }

  // The list scrolls to keep the focused row in view, below its screen's header.
  const long = await openUi({ placements: 30 });
  try {
    await long.waitFor(`${rows} === 30`);
    await long.click('#insert-list .placement[data-key="screen0.slot0"]');
    const visible = key => `(() => { const region = document.getElementById('list-region').getBoundingClientRect();
      const row = document.querySelector('[data-key="${key}"]').getBoundingClientRect(); return row.top >= region.top + 27.5 && row.bottom <= region.bottom + 0.5; })()`;
    await long.press('End');
    assert.equal(await long.focused(), 'screen3.slot29');
    assert.equal(await long.evaluate(visible('screen3.slot29')), true, 'End scrolls to the last row');
    await long.press('Home');
    assert.equal(await long.evaluate(visible('screen0.slot0')), true, 'Home scrolls back');
    for (let i = 0; i < 9; i += 1) await long.press('ArrowDown');
    assert.equal(await long.focused(), 'screen1.slot9');
    assert.equal(await long.evaluate(visible('screen1.slot9')), true, 'the row ↓ reaches is in view, clear of the sticky header');
  } finally { await long.close(); }

  // The grid: ← and → move by a tile, ↑ and ↓ by a row of tiles; type-ahead takes spaces inside a name.
  const grid = await openUi({ preferences: { browse: 'images' } });
  try {
    await grid.waitFor(`${tiles} === 24`);
    assert.equal(await grid.evaluate(`getComputedStyle(document.getElementById('image-grid')).gridTemplateColumns.split(' ').length`), 3, 'three columns at 420 px');
    assert.equal(await grid.evaluate(`document.getElementById('image-grid').getAttribute('role')`), 'listbox');
    const ids = Object.fromEntries(await grid.evaluate(`[1, 2, 4, 5, 20, 22, 24].map(n => [n, __harness.uuid(n)])`));
    await grid.click('#image-grid .tile');
    const at = async (n, message) => {
      assert.equal(await grid.focused(), ids[n], message);
      assert.deepEqual(await grid.evaluate(chosenKeys), [ids[n]], `${message}: chosen`);
      assert.deepEqual(await grid.evaluate(listStops), [ids[n]], `${message}: the one tab stop`);
    };
    await grid.press('ArrowRight'); await at(2, '→');
    await grid.press('ArrowDown'); await at(5, '↓ a row');
    await grid.press('ArrowLeft'); await at(4, '←');
    await grid.press('ArrowUp'); await at(1, '↑ a row');
    await grid.press('ArrowUp'); await at(1, '↑ on the first row');
    await grid.press('End'); await at(24, 'End');
    await grid.press('ArrowDown'); await at(24, '↓ on the last row');
    await grid.press('ArrowUp'); await grid.press('ArrowLeft'); await at(20, '↑ then ←');
    await grid.press('Home'); await at(1, 'Home');
    for (const key of 'image 22') await grid.press(key);
    await at(22, 'type-ahead with a space');
  } finally { await grid.close(); }
});

test('Enter inserts', async () => {
  const page = await openUi({ declared: true, unset: ['home.tile'] });
  try {
    await page.waitFor(`${rows} === 7`);
    // Only the keyboard: / to the search, a few letters, Tab to the list (one stop), Enter.
    await page.press('/');
    assert.equal(await page.focused(), 'insert-search');
    await page.type('home');
    for (let i = 0; i < 5; i += 1) await page.press('Tab');
    assert.equal(await page.focused(), 'home.banner', 'past Clear search, Refresh, Browse, and Environment, the first row');
    assert.deepEqual(await page.evaluate(chosenKeys), [], 'reaching the list chooses nothing');
    await page.press('Enter');
    await page.waitFor(`__harness.inserted() === 1 && document.getElementById('status').textContent === 'Inserted home.banner from Draft.'`, { message: 'the insert' });
    assert.equal(await page.focused(), 'home.banner', 'focus stays on the row');
    assert.deepEqual(await page.evaluate(chosenKeys), ['home.banner']);

    // Enter inserts the cell the footer shows: choosing the chosen row again keeps it.
    await page.press('Escape');
    await page.click('#insert-list .placement[data-key="onboarding.hero"]');
    await page.evaluate(choose('insert-appearance', 'dark'));
    await page.evaluate(choose('insert-arm', 'b'));
    await page.click('#insert-list .placement[data-key="onboarding.hero"]');
    assert.deepEqual(await page.evaluate(`[${valueOf('insert-appearance')}, ${valueOf('insert-arm')}]`), ['dark', 'b']);
    await page.press('Enter');
    await page.waitFor(`__harness.inserted() === 2 && document.getElementById('status').textContent === 'Inserted onboarding.hero · b · dark from Draft.'`, { message: 'the picked cell' });

    // A double-click inserts too.
    await page.doubleClick('#insert-list .placement[data-key="home.promo"]');
    await page.waitFor(`__harness.inserted() === 3 && document.getElementById('status').textContent === 'Inserted home.promo from Draft.'`, { message: 'the double-click' });
    assert.equal(await page.focused(), 'home.promo');

    // Enter on a row Insert can't use inserts nothing and says why, as the footer does.
    await page.click('#insert-list .placement[data-key="home.tile"]');
    await page.press('Enter');
    assert.equal(await page.evaluate(textOf('status')), 'No image in Draft for this cell. Choose another cell or environment.');
    assert.equal(await page.evaluate('__harness.inserted()'), 3);
  } finally { await page.close(); }

  // An insert that fails: focus moves to the error.
  const failing = await openUi({ statuses: { rendition: 404 } });
  try {
    await failing.waitFor(`${rows} === 7`);
    await failing.click('#insert-list .placement[data-key="home.banner"]');
    await failing.press('Enter');
    await failing.waitFor(shown('error'), { message: 'the error' });
    assert.equal(await failing.focused(), 'error');
  } finally { await failing.close(); }

  // In the grid, Enter inserts the focused image.
  const grid = await openUi({ preferences: { browse: 'images' } });
  try {
    await grid.waitFor(`${tiles} === 24`);
    await grid.click('#image-grid .tile');
    await grid.press('ArrowRight');
    await grid.press('Enter');
    await grid.waitFor(`__harness.inserted() === 1 && document.getElementById('status').textContent === 'Inserted Image 2.'`, { message: 'the image insert' });
  } finally { await grid.close(); }
});

test('/ focuses search', async () => {
  const page = await openUi();
  try {
    await page.waitFor(`${rows} === 7`);
    await page.click('#insert-list .placement[data-key="home.banner"]');
    await page.press('/');
    assert.equal(await page.focused(), 'insert-search');
    assert.equal(await page.evaluate(valueOf('insert-search')), '', 'the shortcut types nothing');
    // In the search itself, / is a character.
    await page.press('/');
    assert.equal(await page.evaluate(valueOf('insert-search')), '/');
    // From the Send tab: Insert shows, and the search's text is selected so typing replaces it.
    await page.click('#tab-send');
    await page.press('/');
    assert.equal(await page.evaluate(shown('panel-insert')), true);
    assert.equal(await page.focused(), 'insert-search');
    assert.deepEqual(await page.evaluate(`(() => { const input = document.getElementById('insert-search'); return [input.selectionStart, input.selectionEnd]; })()`), [0, 1]);
    // In the token field / is a character, and Cmd+F (Ctrl+F off Apple platforms) still reaches the search.
    await page.click('#settings-summary');
    await page.click('#update-token');
    await page.click('#token');
    await page.press('/');
    assert.equal(await page.evaluate(valueOf('token')), '/');
    assert.equal(await page.focused(), 'token');
    const find = await page.evaluate(`/Mac|iPhone|iPad/.test(navigator.platform)`) ? 4 : 2;
    await page.press('f', find);
    assert.equal(await page.focused(), 'insert-search');
    assert.equal(await page.evaluate(valueOf('token')), '/', 'the shortcut types nothing');
  } finally { await page.close(); }

  // The first run has no search, so / does nothing there.
  const first = await openUi({ connection: null });
  try {
    await first.waitFor(`document.getElementById('app').dataset.view === 'first-run'`);
    await first.press('/');
    assert.equal(await first.focused(), 'body');
  } finally { await first.close(); }
});

test('Esc clears search then selection', async () => {
  const page = await openUi();
  try {
    await page.waitFor(`${rows} === 7`);
    await page.click('#insert-list .placement[data-key="home.banner"]');
    await page.click('#insert-search');
    await page.type('home');
    assert.equal(await page.evaluate(rows), 3);
    await page.press('Escape');
    assert.equal(await page.evaluate(valueOf('insert-search')), '', 'the first Esc clears the search');
    assert.equal(await page.evaluate(rows), 7);
    assert.deepEqual(await page.evaluate(chosenKeys), ['home.banner'], 'and keeps the choice');
    assert.equal(await page.evaluate(shown('insert-bar')), true);
    assert.equal(await page.focused(), 'insert-search');
    await page.press('Escape');
    assert.deepEqual(await page.evaluate(chosenKeys), [], 'the second clears the choice');
    assert.equal(await page.evaluate(shown('insert-bar')), false);
    assert.equal(await page.focused(), 'insert-search');
    await page.press('Escape');
    assert.equal(await page.focused(), 'insert-search', 'a third does nothing');

    // In the list: a search first, then the choice; focus stays on the row, which keeps the tab stop.
    await page.click('#insert-search');
    await page.type('promo');
    await page.click('#insert-list .placement[data-key="home.promo"]');
    await page.press('Escape');
    assert.deepEqual([await page.evaluate(valueOf('insert-search')), await page.evaluate(rows), await page.focused()], ['', 7, 'home.promo']);
    assert.deepEqual(await page.evaluate(chosenKeys), ['home.promo']);
    await page.press('Escape');
    assert.deepEqual(await page.evaluate(chosenKeys), []);
    assert.equal(await page.focused(), 'home.promo');
    assert.deepEqual(await page.evaluate(listStops), ['home.promo']);
    assert.equal(await page.evaluate(shown('insert-bar')), false);
  } finally { await page.close(); }
});

test('arrow keys switch tabs', async () => {
  const page = await openUi();
  try {
    await page.waitFor(`${rows} === 7`);
    const tabState = `[...document.querySelectorAll('[role="tab"]')].map(tab => [tab.id, tab.getAttribute('aria-selected'), tab.tabIndex])`;
    await page.click('#tab-insert');
    assert.deepEqual(await page.evaluate(tabState), [['tab-insert', 'true', 0], ['tab-send', 'false', -1]], 'one tab stop');
    await page.press('ArrowRight');
    assert.equal(await page.focused(), 'tab-send');
    assert.equal(await page.evaluate(shown('panel-send')), true);
    assert.deepEqual(await page.evaluate(tabState), [['tab-insert', 'false', -1], ['tab-send', 'true', 0]]);
    await page.press('ArrowRight');
    assert.equal(await page.focused(), 'tab-insert', '→ wraps round');
    assert.equal(await page.evaluate(shown('panel-insert')), true);
    await page.press('ArrowLeft');
    assert.equal(await page.focused(), 'tab-send');
    await page.press('Home');
    assert.equal(await page.focused(), 'tab-insert');
    await page.press('End');
    assert.equal(await page.focused(), 'tab-send');
    await page.press('ArrowLeft');

    // Each segmented control is a radio group, one tab stop, whose arrows choose.
    const checked = ids => `${JSON.stringify(ids)}.map(id => [id, document.getElementById(id).getAttribute('aria-checked'), document.getElementById(id).tabIndex])`;
    await page.click('#browse-placements');
    await page.press('ArrowRight');
    assert.equal(await page.focused(), 'browse-images');
    assert.deepEqual(await page.evaluate(checked(['browse-placements', 'browse-images'])), [['browse-placements', 'false', -1], ['browse-images', 'true', 0]]);
    await page.waitFor(`${tiles} === 24`, { message: 'the images' });
    await page.press('ArrowLeft');
    assert.equal(await page.focused(), 'browse-placements');
    await page.waitFor(`${rows} === 7`, { message: 'the placements' });
    // Nothing is published to Staging, so the arrows pass over it.
    await page.click('#env-draft');
    await page.press('ArrowRight');
    assert.equal(await page.focused(), 'env-production');
    assert.deepEqual(await page.evaluate(checked(['env-draft', 'env-staging', 'env-production'])),
      [['env-draft', 'false', -1], ['env-staging', 'false', -1], ['env-production', 'true', 0]]);
    await page.press('ArrowDown');
    assert.equal(await page.focused(), 'env-draft', '↓ wraps round, past Staging');
    // Insert at, in the footer.
    await page.click('#insert-list .placement[data-key="home.banner"]');
    await page.click('#scale-1');
    await page.press('ArrowRight');
    assert.equal(await page.focused(), 'scale-2');
    assert.deepEqual(await page.evaluate(checked(['scale-1', 'scale-2', 'scale-3'])), [['scale-1', 'false', -1], ['scale-2', 'true', 0], ['scale-3', 'false', -1]]);
    assert.equal(await page.evaluate(textOf('insert-meta')), '→ 585 × 240 · Draft', 'the size in Figma first, so a narrow window keeps it');
  } finally { await page.close(); }
});

test('the focus ring is whole on a row and a tile reached with the arrow keys', async () => {
  // Vermilion, by theme (ui.html); a thumbnail painted over a tile's ring once hid its top edge.
  const focus = { light: [182, 63, 27], dark: [228, 87, 46] };
  const near = (actual, expected) => actual.every((value, i) => Math.abs(value - expected[i]) <= 2);
  const topCenter = selector => `(() => { const r = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return [Math.round(r.left + r.width / 2), Math.floor(r.top)]; })()`;
  for (const mode of ['light', 'dark']) {
    const page = await openUi({}, { theme: mode });
    try {
      await page.waitFor(`${rows} === 7`);
      await page.click('#insert-list .placement[data-key="home.banner"]');
      await page.press('ArrowDown');
      const [x, y] = await page.evaluate(topCenter('[data-key="home.promo"]'));
      assert.ok(near(await page.pixel(x, y + 1), focus[mode]), `${mode}: the row's ring`);
      // Inside the ring of a chosen row, a band of the panel background.
      const bg = await page.evaluate(`getComputedStyle(document.body).backgroundColor.match(/\\d+/g).slice(0, 3).map(Number)`);
      assert.ok(near(await page.pixel(x, y + 2), bg), `${mode}: the band inside the row's ring`);
    } finally { await page.close(); }
    const grid = await openUi({ preferences: { browse: 'images' } }, { theme: mode });
    try {
      await grid.waitFor(`${tiles} === 24`);
      await grid.click('#image-grid .tile');
      await grid.press('ArrowRight');
      // A tile's ring sits 2 px outside it, clear of its name; on the chosen tile it takes the selection ring's place,
      // with a band of the panel background inside it.
      const [x, y] = await grid.evaluate(`(${topCenter('#image-grid .tile:focus')})`);
      assert.ok(near(await grid.pixel(x, y - 3), focus[mode]), `${mode}: the tile's ring above it`);
      const bg = await grid.evaluate(`getComputedStyle(document.body).backgroundColor.match(/\\d+/g).slice(0, 3).map(Number)`);
      assert.ok(near(await grid.pixel(x, y - 1), bg), `${mode}: the band inside the tile's ring`);
      assert.equal(await grid.evaluate(`(() => { const tile = document.activeElement; const name = tile.querySelector('.name').getBoundingClientRect();
        return getComputedStyle(tile).outlineStyle === 'none' || name.left >= tile.getBoundingClientRect().left; })()`), true, `${mode}: no ring over the name`);
      assert.equal(await grid.evaluate(`getComputedStyle(document.activeElement.querySelector('.thumb')).position`), 'static', `${mode}: nothing inside a tile is positioned`);
    } finally { await grid.close(); }
  }
});

// ---- A.6: drag to canvas ----
test('rows drag to the canvas, and the hint bar shows how until the first insert', async () => {
  const page = await openUi({ unset: ['home.tile'], legacy: ['settings.empty'], missing: ['home.promo'], huge: ['onboarding.footer'] });
  try {
    await page.waitFor(`${rows} === 7`);
    // Nothing chosen: the hint bar, in the window, in place of the footer.
    assert.equal(await page.evaluate(shown('hint-bar')), true);
    assert.equal(await page.evaluate(`document.querySelector('#hint-bar .hint-wide').innerText`), 'Drag onto the canvas, or select an item and press Enter.');
    assert.equal(await page.evaluate(`document.querySelector('#hint-bar .hint-narrow').checkVisibility()`), false, 'its narrow wording shows only below 400 px');
    assert.equal(await page.evaluate(inViewport('hint-bar')), true);
    assert.equal(Math.round(await page.evaluate(`document.getElementById('hint-bar').getBoundingClientRect().height`)), 28);
    // Only what Insert could insert drags; a thumbnail never drags its own image.
    assert.deepEqual(await page.evaluate(`Object.fromEntries([...document.querySelectorAll('#insert-list .placement[data-key]')].map(row => [row.dataset.key, row.draggable]))`),
      { 'onboarding.hero': true, 'onboarding.footer': false, 'home.banner': true, 'home.promo': false, 'home.tile': false, 'settings.header': true, 'settings.empty': false });
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#insert-list img')].filter(img => img.draggable).length`), 0);

    // A real drag in Chrome: pressing a row and moving starts it, with the row's key as its data (no field here takes it).
    await page.send('Input.setInterceptDrags', { enabled: true });
    await page.evaluate(`window.__ends = []; document.addEventListener('dragend', event => __ends.push(event.view === window ? window.length : 'another view'))`);
    const intercepted = new Promise(resolve => { const stop = browser.on(message => { if (message.method === 'Input.dragIntercepted') { stop(); resolve(message.params.data); } }); });
    const box = await page.evaluate(`(() => { const r = document.querySelector('.placement[data-key="home.banner"]').getBoundingClientRect(); return { x: r.left + 40, y: r.top + 24 }; })()`);
    await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x, y: box.y });
    await page.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    for (let step = 1; step <= 5; step += 1) await page.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: box.x - step * 12, y: box.y, button: 'left', buttons: 1 });
    const data = await Promise.race([intercepted, new Promise((_, reject) => setTimeout(() => reject(new Error('Chrome started no drag')), 5000))]);
    assert.deepEqual(data.items.map(item => [item.mimeType, item.data]), [['application/x-assetlib-item', 'home.banner']]);
    assert.equal(data.dragOperationsMask & 1, 1, 'a copy');
    // Cancelled, the drag ends in the plugin window: nothing goes to Figma.
    await page.send('Input.dispatchDragEvent', { type: 'dragCancel', x: box.x, y: box.y, data });
    await page.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: box.x, y: box.y, button: 'left', clickCount: 1 });
    await page.send('Input.setInterceptDrags', { enabled: false });
    await page.frames();
    assert.deepEqual(await page.evaluate('__ends'), [0], 'Chrome ended it here: the event’s view is this window, which holds no frame');
    assert.deepEqual(await page.evaluate('__harness.drops.length'), 0);

    // Dropped outside the window (Figma's check: the event's view holds a frame), the row goes to Figma as a pluginDrop.
    await page.evaluate(`(() => { const row = document.querySelector('.placement[data-key="home.banner"]');
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
      const end = new DragEvent('dragend', { bubbles: true, clientX: -150, clientY: 300 }); Object.defineProperty(end, 'view', { value: { length: 1 } });
      row.dispatchEvent(end); })()`);
    await page.waitFor(`__harness.inserted() === 1`, { message: 'the drop’s insert' });
    const [drop] = await page.evaluate('__harness.drops');
    assert.deepEqual({ ...drop, dropMetadata: { ...drop.dropMetadata, dropId: 'id' } }, { clientX: -150, clientY: 300, files: [], dropMetadata: { assetlib: 1, dropId: 'id',
      connectionGeneration: 0, name: 'home.banner', frame: { width: 1170, height: 480 }, scale: 1,
      link: { placementKey: 'home.banner', state: null, appearance: null, arm: null, environment: 'draft', assetId: await page.evaluate('__harness.uuid(10002)') } } });
    assert.deepEqual(await page.evaluate('[__harness.targets.at(-1), __harness.insertDrops.at(-1)]'), [{ kind: 'fill', nodeIds: ['300:1'] }, drop.dropMetadata.dropId],
      'the insert fills the placeholder main made');
    // The first insert retires the hint; the panel is free again.
    await page.waitFor(`!(${shown('hint-bar')})`, { message: 'the hint to go' });
    assert.equal(await page.evaluate(textOf('status')), 'Inserted home.banner from Draft.');
    assert.deepEqual(await page.evaluate(`__harness.received.filter(type => type === 'save-preferences').length`), 1);
    assert.equal(await page.evaluate(`document.getElementById('insert-list').getAttribute('aria-busy')`), null);
  } finally { await page.close(); }

  // A drop main refuses says why in the error line; Close retires the hint on its own.
  const refused = await openUi({ dropRefused: 'The connection changed. Drag the image again.', placements: 3 });
  try {
    await refused.waitFor(`${rows} === 3`);
    await refused.evaluate(`(() => { const row = document.querySelector('.placement[data-key="onboarding.hero"]');
      row.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true, dataTransfer: new DataTransfer() }));
      const end = new DragEvent('dragend', { bubbles: true, clientX: 500, clientY: 100 }); Object.defineProperty(end, 'view', { value: { length: 1 } });
      row.dispatchEvent(end); })()`);
    await refused.waitFor(shown('error-box'));
    assert.equal(await refused.evaluate(textOf('error')), 'The connection changed. Drag the image again.');
    assert.equal(await refused.evaluate(inViewport('error-box')), true);
    assert.equal(await refused.evaluate('__harness.inserted()'), 0);
    await refused.click('#hint-close');
    assert.equal(await refused.evaluate(shown('hint-bar')), false);
    assert.notEqual(await refused.focused(), 'body', 'closing the hint never drops focus to the page');
  } finally { await refused.close(); }
});

// ---- A.8: the window size ----

/** Resizes the page as Figma resizes the plugin window when main calls figma.ui.resize. */
const resizeTo = async (page, width, height) => {
  await page.send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
  await page.frames();
};
const gripBox = `(() => { const grip = document.getElementById('resize-grip'); const r = grip.getBoundingClientRect(); const hit = document.elementFromPoint(r.left + 6, r.top + 6);
  return { x: r.left + r.width / 2, y: r.top + r.height / 2, right: r.right, bottom: r.bottom, width: r.width, height: r.height, cursor: getComputedStyle(grip).cursor,
    hit: Boolean(hit && grip.contains(hit)) }; })()`;

test('the grip resizes the window, keeps focus, saves the size on pointer-up, and a double-click restores the default', async () => {
  const page = await openUi({ declared: true, placements: 30 });
  try {
    await page.waitFor(`${rows} === 30`);
    await page.click('#insert-list .placement[data-key="screen0.slot0"]');
    await page.click('#insert-search');
    const bars = `['.topbar', '.toolbar', '.scopebar'].map(s => Math.round(document.querySelector(s).getBoundingClientRect().height))`;
    const barsBefore = await page.evaluate(bars);
    const listBefore = await page.evaluate(`Math.round(document.getElementById('list-region').getBoundingClientRect().height)`);
    const grip = await page.evaluate(gripBox);
    assert.deepEqual({ ...grip, x: undefined, y: undefined }, { x: undefined, y: undefined, right: 420, bottom: 720, width: 12, height: 12, cursor: 'nwse-resize', hit: true },
      'a 12 px grip in the bottom-right corner, over the footer');
    // Clear of the footer's controls: the primary ends in the 12 px side padding the grip sits in.
    assert.ok(await page.evaluate(`document.getElementById('insert').getBoundingClientRect().right <= 408.5`));

    // A drag: each frame asks for the size under the pointer, which Figma applies; letting go saves it.
    const mouse = (type, x, y, extra = {}) => page.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', ...extra });
    await mouse('mouseMoved', grip.x, grip.y, { button: 'none' });
    await mouse('mousePressed', grip.x, grip.y, { clickCount: 1 });
    assert.equal(await page.focused(), 'insert-search', 'pressing the grip leaves focus where it was');
    for (const [x, y] of [[grip.x + 40, grip.y + 30], [grip.x + 100, grip.y + 60]]) {
      await mouse('mouseMoved', x, y, { buttons: 1 });
      await page.frames();
      const asked = await page.evaluate('__harness.resizes.at(-1)');
      await resizeTo(page, asked.width, asked.height);
    }
    assert.deepEqual(await page.evaluate('__harness.resizes'), [{ width: 460, height: 750 }, { width: 520, height: 780 }], 'one size a frame, the grip kept under the pointer');
    assert.equal(await page.evaluate('__harness.saved.filter(prefs => prefs.window).length'), 0, 'nothing saved during the drag');
    await mouse('mouseReleased', grip.x + 100, grip.y + 60, { clickCount: 1 });
    await page.frames();
    assert.deepEqual(await page.evaluate('__harness.saved.at(-1).window'), { width: 520, height: 780 });
    assert.deepEqual(await page.evaluate(`(() => { const r = document.getElementById('resize-grip').getBoundingClientRect(); return [r.right, r.bottom]; })()`), [520, 780],
      'the grip follows the corner');
    assert.equal(await page.focused(), 'insert-search', 'resizing never takes focus');
    // Only the list grows; the bars keep their heights.
    assert.deepEqual(await page.evaluate(bars), barsBefore);
    assert.equal(await page.evaluate(`Math.round(document.getElementById('list-region').getBoundingClientRect().height)`), listBefore + 60);

    // Smaller than the minimum: the UI asks for 320 × 480 at the least.
    const corner = await page.evaluate(gripBox);
    await mouse('mouseMoved', corner.x, corner.y, { button: 'none' });
    await mouse('mousePressed', corner.x, corner.y, { clickCount: 1 });
    await mouse('mouseMoved', 60, 60, { buttons: 1 });
    await page.frames();
    await mouse('mouseReleased', 60, 60, { clickCount: 1 });
    await page.frames();
    assert.deepEqual(await page.evaluate('__harness.resizes.at(-1)'), { width: 320, height: 480 });
    assert.deepEqual(await page.evaluate('__harness.saved.at(-1).window'), { width: 320, height: 480 });
    await resizeTo(page, 320, 480);

    // A double-click: the default size, and the saved size forgotten.
    const resizes = await page.evaluate('__harness.resizes.length');
    await page.doubleClick('#resize-grip');
    await page.waitFor(`__harness.resizes.at(-1) === 'reset'`, { message: 'the reset' });
    assert.equal(await page.evaluate('__harness.resizes.length'), resizes + 1, 'nothing else is asked for');
    assert.equal(await page.evaluate(`'window' in __harness.saved.at(-1)`), false);
    assert.equal(await page.focused(), 'insert-search', 'a double-click leaves focus where it was');
  } finally { await page.close(); }
});

test('the layout follows the window: an Environment dropdown and value-only pickers below 400 px, a meta column from 560 px', async () => {
  const page = await openUi({ declared: true, placements: 30 }, { width: 380, height: 640 });
  try {
    await page.waitFor(`${rows} === 30`);
    // The radios give way to a 24 px dropdown with the same choices; staging has nothing published.
    const visible = id => `document.getElementById('${id}').checkVisibility()`;
    assert.deepEqual(await page.evaluate(`[${visible('env-group')}, ${visible('env-select')}, Math.round(document.getElementById('env-select').getBoundingClientRect().height)]`), [false, true, 24]);
    assert.deepEqual(await page.evaluate(`[${valueOf('env-select')}, document.getElementById('env-option-staging').disabled, document.getElementById('env-select').getAttribute('aria-label')]`),
      ['draft', true, 'Environment']);
    await page.evaluate(choose('env-select', 'production'));
    await page.frames();
    assert.equal(await page.evaluate(`document.getElementById('env-production').getAttribute('aria-checked')`), 'true');
    // The footer's pickers show their values; each select keeps its name.
    await page.click('#insert-list .placement[data-key="screen0.slot0"]');
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#insert-bar .picker-word')].map(word => word.checkVisibility())`), [false, false, false]);
    assert.deepEqual(await page.evaluate(`[...document.querySelectorAll('#insert-bar .picker select')].map(select => select.getAttribute('aria-label'))`), ['State', 'Appearance', 'A/B arm']);
    assert.equal(await page.evaluate(`new Set([...document.querySelectorAll('#insert-bar .picker')].map(label => Math.round(label.getBoundingClientRect().top))).size`), 1,
      'all three on one row');

    // Crossing 400 px moves focus between the dropdown and the radios, never to the page.
    await page.evaluate(`document.getElementById('env-select').focus()`);
    await resizeTo(page, 420, 640);
    assert.equal(await page.focused(), 'env-production');
    assert.deepEqual(await page.evaluate(`[${visible('env-group')}, ${visible('env-select')}]`), [true, false]);
    assert.equal(await page.evaluate(`[...document.querySelectorAll('#insert-bar .picker-word')].every(word => word.checkVisibility())`), true);
    await resizeTo(page, 360, 640);
    assert.equal(await page.focused(), 'env-select');

    // From 560 px a row's meta sits in a right-aligned column before the tag column, on the key's line.
    await resizeTo(page, 640, 900);
    const columns = await page.evaluate(`[...document.querySelectorAll('#insert-list .placement[data-key]')].slice(0, 8).map(row => {
      const key = row.querySelector('.key').getBoundingClientRect(); const size = row.querySelector('.size').getBoundingClientRect();
      return { right: Math.round(size.right), after: size.left >= key.right, line: Math.abs((key.top + key.bottom) / 2 - (size.top + size.bottom) / 2) < 1, height: Math.round(row.getBoundingClientRect().height) }; })`);
    assert.equal(new Set(columns.map(column => column.right)).size, 1, `the meta column is right-aligned: ${JSON.stringify(columns.map(column => column.right))}`);
    assert.ok(columns.every(column => column.after && column.line && column.height === 48), JSON.stringify(columns));
  } finally { await page.close(); }
  // Every tag, the widest ("Needs re-upload") included, fits the tag column, so the meta column stays aligned.
  const tagged = await openUi({ changed: ['home.banner'], unset: ['home.tile'], legacy: ['settings.empty'], missing: ['home.promo'] }, { width: 640, height: 900 });
  try {
    await tagged.waitFor(`${rows} === 7`);
    await tagged.evaluate('document.fonts.ready.then(() => true)');
    await tagged.frames();
    const edges = await tagged.evaluate(`[...document.querySelectorAll('#insert-list .placement[data-key]')].map(row => [row.querySelector('.tag')?.textContent ?? '',
      Math.round(row.querySelector('.size').getBoundingClientRect().right), row.querySelector('.tag') ? Math.round(row.querySelector('.tag').getBoundingClientRect().right) : null])`);
    assert.deepEqual(edges.map(([tag]) => tag), ['Draft only', '', 'Changed', 'Unavailable', 'Not set', '', 'Needs re-upload']);
    assert.equal(new Set(edges.map(([, size]) => size)).size, 1, JSON.stringify(edges));
    assert.equal(new Set(edges.filter(([tag]) => tag).map(([, , right]) => right)).size, 1, 'tags end at the row’s padding');
  } finally { await tagged.close(); }

  // The image grid takes four columns at 560 px and more beyond.
  for (const [width, count] of [[420, 3], [560, 4], [900, 7]]) {
    const grid = await openUi({ preferences: { browse: 'images' } }, { width, height: 720 });
    try {
      await grid.waitFor(`${tiles} === 24`);
      assert.equal(await grid.evaluate(`(() => { const top = tile => Math.round(tile.getBoundingClientRect().top); const all = [...document.querySelectorAll('#image-grid .tile')];
        return all.filter(tile => top(tile) === top(all[0])).length; })()`), count, `${width} px`);
    } finally { await grid.close(); }
  }
});

test('the window opens on the shell while the saved connection loads, never the first-run screen', async () => {
  // Main's connection message comes 600 ms after the UI loads; the font loads and the window is resized meanwhile. Before
  // A.8 the font's render showed the first-run screen, and a refused opening test then left the settings open over the shell.
  const view = `[document.getElementById('app').dataset.view, document.getElementById('settings').open]`;
  for (const [name, options, loaded] of [['a passing opening test', {}, `${rows} === 7`],
    ['a refused opening test', { statuses: { placements: 401 } }, shown('insert-empty')]]) {
    const page = await openUi({ ...options, delays: { connection: 600 } });
    try {
      await page.evaluate('document.fonts.ready.then(() => true)');
      await page.frames();
      assert.deepEqual(await page.evaluate(view), ['shell', false], `${name}: before the connection message`);
      await resizeTo(page, 440, 700);
      assert.deepEqual(await page.evaluate(view), ['shell', false], `${name}: resized before the connection message`);
      await page.waitFor(loaded);
      await page.frames();
      assert.deepEqual(await page.evaluate(view), ['shell', false], `${name}: the connection settings stay closed`);
    } finally { await page.close(); }
  }
});

// Every state in §4.6 that exists after A.4, in both themes, for the founder's review (not committed).
const shots = process.env.ASSETLIB_SCREENSHOTS;
test('a running action keeps its ink and a spinner, and the shell gives names and the list their room', async () => {
  // Insert running: ink at 80% with a spinner, never the disabled look, and the controls beside it stay put.
  const page = await openUi({ delays: { rendition: 1500 } });
  try {
    await page.waitFor(`${rows} === 7`);
    await page.click('#insert-list .placement[data-key="home.banner"]');
    const scaleLeft = `Math.round(document.getElementById('scale-group').getBoundingClientRect().left)`;
    const idle = await page.evaluate(scaleLeft);
    await page.click('#insert');
    await page.waitFor(`document.getElementById('insert').getAttribute('aria-busy') === 'true'`, { message: 'the insert to run' });
    assert.deepEqual(await page.evaluate(`(() => { const b = document.getElementById('insert'); const s = getComputedStyle(b);
      return [b.textContent, s.backgroundColor === getComputedStyle(document.body).backgroundColor, getComputedStyle(b, '::before').animationName, s.cursor]; })()`),
    ['Inserting…', false, 'spin', 'progress']);
    assert.equal(await page.evaluate(scaleLeft), idle, 'the label change moves nothing beside it');
    assert.notEqual(await page.evaluate(`getComputedStyle(document.getElementById('insert')).backgroundColor`),
      await page.evaluate(`getComputedStyle(document.documentElement).getPropertyValue('--bg-disabled')`), 'not the disabled fill');
    // The chip has room for both names at 420 px; the open panel is a menu, not the token form.
    assert.equal(await page.evaluate(`(() => { const el = document.querySelector('.chip-workspace'); return el.scrollWidth <= el.clientWidth; })()`), true);
    await page.click('#settings-summary');
    assert.deepEqual(await page.evaluate(`[document.getElementById('connection-form').checkVisibility(), document.getElementById('update-token').checkVisibility()]`), [false, true]);
  } finally { await page.close(); }

  // At 320×480 with the account menu open, the list keeps rows in view; the footer keeps the item's name readable.
  const narrow = await openUi(canvasSelection(intoLong), { width: 320, height: 480 });
  try {
    await narrow.waitFor(`${rows} === 7`);
    await narrow.click('#insert-list .placement[data-key="home.banner"]');
    assert.ok(await narrow.evaluate(`document.getElementById('insert-title').getBoundingClientRect().width`) >= 88, 'the name keeps 88 px');
    assert.equal(await narrow.evaluate(`document.getElementById('insert-preview').checkVisibility()`), false, 'the chosen row shows the image already');
    await narrow.click('#settings-summary');
    assert.ok(await narrow.evaluate(`document.getElementById('list-region').getBoundingClientRect().height`) >= 96, 'two rows or more stay in view');
  } finally { await narrow.close(); }

  // Tile names break after their separators.
  const grid = await openUi({ preferences: { browse: 'images' }, imageNames: longImageNames });
  try {
    await grid.waitFor(`${tiles} === 24`);
    assert.equal(await grid.evaluate(`document.querySelectorAll('#image-grid .tile .name wbr').length > 0`), true);
  } finally { await grid.close(); }

  // The first run sits in the middle of a tall window; an invalid field that has focus shows the ring, not a red border too.
  const first = await openUi({ connection: null }, { width: 420, height: 900 });
  try {
    await first.waitFor(`document.getElementById('app').dataset.view === 'first-run'`);
    await first.frames();
    assert.ok(await first.evaluate(`document.querySelector('.first-run h1').getBoundingClientRect().top`) > 150, 'not stuck to the top');
    await first.click('#use-token');
    await first.click('#token');
    await first.type('not-a-token');
    await first.press('Enter');
    assert.equal(await first.focused(), 'token');
    assert.deepEqual(await first.evaluate(`(() => { const s = getComputedStyle(document.getElementById('token')); return [s.borderTopColor, s.outlineStyle]; })()`),
      ['rgba(0, 0, 0, 0)', 'solid']);
  } finally { await first.close(); }
});

test('screenshots of every state in both themes', { skip: shots ? false : 'set ASSETLIB_SCREENSHOTS=<directory> to write them' }, async () => {
  await mkdir(shots, { recursive: true });
  const node = { id: '40:1', name: 'Home banner', type: 'FRAME', width: 390, height: 160 };
  const tall = { ...node, height: 844 };
  const banner = { fileKey: 'abc123', nodeId: node.id, placementKey: 'home.banner', state: null, appearance: null, arm: null, insertedFrom: null };
  const ready = page => page.waitFor(`${rows} > 0`, { message: 'rows' });
  const pickBanner = async page => {
    await page.waitFor(`document.getElementById('placement').options.length > 1`, { message: 'the placements' });
    await page.evaluate(choose('placement', 'home.banner'));
  };
  const submit = text => async page => {
    await page.click('#use-token'); await page.click('#token'); await page.type(text); await page.press('Enter'); await page.waitFor(shown('connection-error'));
  };
  const waiting = async page => { await page.click('#connect-browser'); await page.waitFor(shown('pairing')); };
  const askForLink = async page => { await pickBanner(page); await page.click('#send'); await page.waitFor(shown('file-fallback')); };
  const states = [
    ['first-run', { connection: null }],
    ['first-run-token', { connection: null }, page => page.click('#use-token')],
    // One-click Connect: waiting for approval, resumed after a reopen, and how a request that couldn't run ends.
    ['connect-waiting', { connection: null }, waiting],
    ['connect-resumed', { connection: null, pairing: { v: 1, origin: 'https://console.assetlib.dev', readKey: `alr_${'r'.repeat(43)}`, userCode: 'BCDFGHJK',
      deadline: Date.now() + 420000, interval: 2 } }, page => page.waitFor(shown('pairing'))],
    ['connect-older-console', { connection: null, statuses: { start: 404 } }, async page => { await page.click('#connect-browser'); await page.waitFor(shown('pairing-note')); }],
    ['connect-unreachable', { connection: null, failures: ['start'] }, async page => { await page.click('#connect-browser'); await page.waitFor(shown('pairing-note')); }],
    ['connect-declined', { connection: null, pairingStatus: 'denied' }, async page => { await page.click('#connect-browser'); await page.waitFor(shown('pairing-note'), { timeout: 5000 }); }],
    ['account-panel-browser', { connection: browserConnection }, async page => { await page.waitFor(`${rows} > 0`); await page.click('#settings-summary'); }],
    ['switch-waiting', { connection: browserConnection }, async page => { await page.waitFor(`${rows} > 0`); await page.click('#settings-summary'); await page.click('#switch-workspace'); await page.waitFor(shown('pairing')); }],
    ['reconnect-list', { connection: browserConnection, statuses: { placements: 403 }, codes: { placements: 'member' } }, page => page.waitFor(shown('insert-empty'))],
    ['reconnect-send', { connection: browserConnection, statuses: { placements: 403 }, codes: { placements: 'revoked' }, preferences: { tab: 'send' } }, page => page.waitFor(shown('send-problem'))],
    ['first-run-bad-format', { connection: null }, submit('not-a-token')],
    ['first-run-refused', { connection: null, statuses: { token: 401 } }, submit(fakeToken('revoked'))],
    ['first-run-scope', { connection: null, identity: { ...DEFAULTS.identity, scopes: ['declare'] } }, submit(fakeToken('declare'))],
    ['first-run-older-console', { connection: null, statuses: { token: 404 } }, submit(fakeToken('older'))],
    ['insert-loading', { delays: { artwork: 8000 } }, page => page.waitFor(skeletonRows)],
    // Nothing chosen: the hint bar sits where the footer goes, until the first insert.
    ['insert-list', { unset: ['home.tile'], legacy: ['settings.empty'] }, ready],
    ['insert-hint-seen', { preferences: { hintSeen: true } }, ready],
    ['insert-selected-pickers', { declared: true, placements: 30 }, async page => { await ready(page); await page.click('#insert-list .placement[data-key="screen0.slot0"]'); }],
    ['insert-scale-3x', {}, async page => { await ready(page); await page.click('#insert-list .placement[data-key="onboarding.hero"]'); await page.click('#scale-3'); }],
    ['insert-not-set', { unset: ['home.tile'] }, async page => { await ready(page); await page.click('#insert-list .placement[data-key="home.tile"]'); }],
    ['insert-needs-reupload', { legacy: ['settings.empty'] }, async page => { await ready(page); await page.click('#insert-list .placement[data-key="settings.empty"]'); }],
    ['insert-error', { statuses: { rendition: 404 } }, async page => { await ready(page); await page.click('#insert-list .placement[data-key="home.banner"]'); await page.click('#insert'); await page.waitFor(shown('error')); }],
    ['insert-production', { preferences: { environment: 'production' } }, ready],
    // The selection names the primary (A.5): into a frame (with the width hint), fill several layers, replace a linked image.
    ['insert-into', canvasSelection(intoLong), async page => { await ready(page); await page.click('#insert-list .placement[data-key="home.banner"]'); }],
    ['insert-fill', canvasSelection(fillThree), async page => { await ready(page); await page.click('#insert-list .placement[data-key="home.banner"]'); }],
    ['insert-replace', canvasSelection(replaceOne), async page => { await ready(page); await page.click('#insert-list .placement[data-key="home.banner"]'); }],
    ['images-grid', { preferences: { browse: 'images' }, imageNames: longImageNames }, page => page.waitFor(`${tiles} === 24`)],
    ['images-selected', { preferences: { browse: 'images' }, imageNames: longImageNames }, async page => { await page.waitFor(`${tiles} === 24`); await page.click('#image-grid .tile'); }],
    // The focus ring on a chosen row and tile, reached with the arrow keys.
    ['insert-keyboard-focus', {}, async page => { await ready(page); await page.click('#insert-list .placement[data-key="home.banner"]'); await page.press('ArrowDown'); }],
    ['images-keyboard-focus', { preferences: { browse: 'images' }, imageNames: longImageNames },
      async page => { await page.waitFor(`${tiles} === 24`); await page.click('#image-grid .tile'); await page.press('ArrowRight'); }],
    ['no-placements', { artwork: 'empty' }, page => page.waitFor(shown('insert-empty'))],
    ['no-results', {}, async page => { await ready(page); await page.click('#insert-search'); await page.type('zzz'); }],
    ['images-empty-library', { images: 0, preferences: { browse: 'images' } }, page => page.waitFor(shown('insert-empty'))],
    ['images-no-results', { preferences: { browse: 'images' } }, async page => { await page.waitFor(`${tiles} === 24`); await page.click('#insert-search'); await page.type('zzz'); await page.waitFor(shown('insert-empty')); }],
    ['list-network', { failures: ['artwork'] }, page => page.waitFor(shown('insert-empty'), { timeout: 12000 })],
    ['list-busy', { statuses: { artwork: 429 } }, page => page.waitFor(shown('insert-empty'))],
    ['list-server', { statuses: { artwork: 500 } }, page => page.waitFor(shown('insert-empty'))],
    ['list-unsupported', { statuses: { artwork: 404 } }, page => page.waitFor(shown('insert-empty'))],
    ['list-token-refused', { statuses: { artwork: 401 } }, page => page.waitFor(shown('insert-empty'))],
    ['opening-test-refused', { statuses: { placements: 401 } }, page => page.waitFor(shown('insert-empty'))],
    ['opening-test-update-token', { statuses: { placements: 401 } }, async page => { await page.waitFor(shown('insert-empty')); await page.click('#insert-token'); }],
    ['opening-test-network', { failures: ['placements'] }, page => page.waitFor(shown('insert-empty'), { timeout: 12000 })],
    ['send-test-refused', { statuses: { placements: 401 }, preferences: { tab: 'send' } }, page => page.waitFor(shown('send-problem'))],
    ['send-test-network', { failures: ['placements'], preferences: { tab: 'send' } }, page => page.waitFor(shown('send-problem'), { timeout: 12000 })],
    ['insert-tags', { changed: ['home.banner'], missing: ['home.promo'], unset: ['home.tile'], legacy: ['settings.empty'] }, ready],
    ['insert-unavailable', { missing: ['home.promo'] }, async page => { await ready(page); await page.click('#insert-list .placement[data-key="home.promo"]'); }],
    ['insert-too-large', { huge: ['home.banner'] }, async page => { await ready(page); await page.click('#insert-list .placement[data-key="home.banner"]'); }],
    ['insert-inherited', { declared: true, placements: 30 }, async page => {
      await ready(page); await page.click('#insert-list .placement[data-key="screen0.slot0"]');
      await page.evaluate(choose('insert-appearance', 'dark')); await page.evaluate(choose('insert-arm', 'b'));
    }],
    ['long-names', { connection: { ...DEFAULTS.connection, workspaceName: 'A workspace with quite a long name that goes on', appName: 'Roam iOS' }, identity: { ...DEFAULTS.identity, workspaceName: 'A workspace with quite a long name that goes on', appName: 'Roam iOS' } }, ready],
    ['no-names-panel', { connection: { ...DEFAULTS.connection, workspaceName: undefined, appName: undefined }, identity: { ...DEFAULTS.identity, workspaceName: null, appName: null } }, async page => { await ready(page); await page.click('#settings-summary'); }],
    ['account-panel', {}, async page => { await ready(page); await page.click('#settings-summary'); }],
    ['send-no-selection', { preferences: { tab: 'send' } }],
    ['send-several', { preferences: { tab: 'send' }, selection: { node: null, reason: 'Select one layer. Sending several at once isn’t supported yet.', fileKey: 'abc123', remembered: null } }],
    ['send-selection', { preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: 'abc123', remembered: null } }, pickBanner],
    ['send-ratio-gate', { preferences: { tab: 'send' }, selection: { node: tall, reason: null, fileKey: 'abc123', remembered: null } }, pickBanner],
    ['send-file-link', { preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: null, remembered: null } }, askForLink],
    ['send-file-mismatch', { preferences: { tab: 'send' }, fileName: 'Roam onboarding', selection: { node, reason: null, fileKey: null, remembered: null } },
      async page => { await askForLink(page); await page.type('https://www.figma.com/design/zzz/Coast-house'); await page.press('Enter'); await page.waitFor(shown('file-mismatch-box')); }],
    ['send-file-line', { preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: 'abc123', remembered: null, file: { source: 'document', name: 'Roam onboarding' } } }, pickBanner],
    ['send-view-only', { preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: 'abc123', remembered: null, file: { source: 'session', name: 'Roam onboarding' } } }, pickBanner],
    // The Sync bar (A.7): on Insert and Send, with the ratio off, a copy, another app's link, and a placement that's gone.
    ['sync-bar-insert', { selection: linkedSelection(node) }, async page => { await ready(page); await page.waitFor(shown('selection-bar')); }],
    ['sync-bar-insert-chosen', { selection: linkedSelection(node) }, async page => { await ready(page); await page.click('#insert-list .placement[data-key="home.banner"]'); }],
    ['sync-bar-send', { preferences: { tab: 'send' }, selection: linkedSelection(node) }, page => page.waitFor(shown('selection-bar'))],
    ['sync-bar-ratio', { selection: linkedSelection(tall) }, async page => { await ready(page); await page.waitFor(shown('sync-match')); }],
    ['sync-bar-copy', { selection: { ...linkedSelection(node), remembered: null, link: { ...linkedSelection(node).link, kind: 'copy' } } }, ready],
    ['sync-bar-other', { selection: { ...linkedSelection(node), remembered: null, link: { ...linkedSelection(node).link, kind: 'other' } } }, ready],
    ['sync-bar-removed', { selection: { ...linkedSelection(node), remembered: { ...linkedSelection(node).remembered, placementKey: 'home.gone' } } }, ready],
    ['send-sending', { preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: 'abc123', remembered: null }, delays: { drafts: 8000 } },
      async page => { await pickBanner(page); await page.click('#send'); await page.waitFor(`document.getElementById('send').textContent === 'Sending…'`); }],
    ['send-sent', { preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: 'abc123', remembered: null } },
      async page => { await pickBanner(page); await page.click('#send'); await page.waitFor(shown('result')); }],
    ['sync-rebound', { preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: 'abc123', remembered: banner },
      draft: { status: 201, body: { asset: { id: '00000000-0000-4000-8000-000000009999', name: 'Sent', width: 1170, height: 480, sha256: 'a'.repeat(64), renditions: 1 }, previous: null,
        bound: { slotKey: 'home.banner', state: null, appearance: null, arm: null }, bindError: null,
        rebound: [{ slotKey: 'home.banner', state: null, appearance: null, arm: null }, { slotKey: 'home.promo', state: null, appearance: null, arm: null }] } } },
      async page => { await page.click('#sync'); await page.waitFor(shown('result')); await page.click('#result summary'); }],
    ['send-413', { preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: 'abc123', remembered: null }, draft: { status: 413, body: { error: 'Too large.' } } },
      async page => { await pickBanner(page); await page.click('#send'); await page.waitFor(shown('error-box')); }],
    ['send-network', { preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: 'abc123', remembered: null }, failures: ['drafts'] },
      async page => { await pickBanner(page); await page.click('#send'); await page.waitFor(shown('error-box')); }],
    ['send-timeout', { preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: 'abc123', remembered: null }, fastTimeouts: true, delays: { drafts: 5000 } },
      async page => { await pickBanner(page); await page.click('#send'); await page.waitFor(shown('error-box')); }],
    ['send-partial-409', { preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: 'abc123', remembered: null },
      draft: { status: 409, body: { asset: { id: '00000000-0000-4000-8000-000000009999', name: 'Sent', width: 1170, height: 480, sha256: 'a'.repeat(64), renditions: 1 }, previous: null,
        bound: null, bindError: 'This placement changed since the plugin loaded it.', rebound: [] } } },
      async page => { await pickBanner(page); await page.click('#send'); await page.waitFor(shown('result')); }],
  ];
  const narrow = [['narrow-first-run', { connection: null }], ['narrow-hint', {}, ready], ['narrow-list', { declared: true, placements: 30 },
    async page => { await ready(page); await page.click('#insert-list .placement[data-key="screen0.slot0"]'); }],
  ['narrow-file-link', { preferences: { tab: 'send' }, selection: { node, reason: null, fileKey: null, remembered: null } }, askForLink],
  ['narrow-sync-bar', { selection: linkedSelection(node) }, async page => { await ready(page); await page.click('#insert-list .placement[data-key="home.banner"]'); }],
  ['narrow-sync-bar-ratio', { selection: linkedSelection(tall) }, async page => { await ready(page); await page.waitFor(shown('sync-match')); }],
  ['narrow-insert-into', canvasSelection(intoLong), async page => { await ready(page); await page.click('#insert-list .placement[data-key="home.banner"]'); }],
  ['narrow-send-problem', { statuses: { placements: 401 }, preferences: { tab: 'send' } }, page => page.waitFor(shown('send-problem'))],
  ['narrow-sync-long-key', longRebound, async page => { await page.click('#sync'); await page.waitFor(shown('result')); await page.click('#result summary'); }],
  ['narrow-older-console', { connection: null, statuses: { token: 404 } }, submit(fakeToken('older'))],
  ['narrow-connect-waiting', { connection: null }, waiting],
  ['narrow-switch-waiting', { connection: browserConnection }, async page => { await page.waitFor(`${rows} > 0`); await page.click('#settings-summary'); await page.click('#switch-workspace'); await page.waitFor(shown('pairing')); }],
  ['narrow-account', { connection: { ...DEFAULTS.connection, workspaceName: 'A workspace with quite a long name that goes on', appName: 'Roam iOS' }, identity: { ...DEFAULTS.identity, workspaceName: 'A workspace with quite a long name that goes on', appName: 'Roam iOS' } },
    async page => { await ready(page); await page.click('#settings-summary'); }],
  ['narrow-images', { preferences: { browse: 'images' }, imageNames: longImageNames }, page => page.waitFor(`${tiles} === 24`)]];
  // A window dragged wider and taller (A.8): the meta column, more tiles a row, and only the list grown.
  const wide = [['wide-list', { changed: ['home.banner'], unset: ['home.tile'], legacy: ['settings.empty'] }, ready],
    ['wide-selected-pickers', { declared: true, placements: 30 }, async page => { await ready(page); await page.click('#insert-list .placement[data-key="screen0.slot0"]'); }],
    ['wide-images', { preferences: { browse: 'images' }, imageNames: longImageNames }, page => page.waitFor(`${tiles} === 24`)],
    ['wide-send', { preferences: { tab: 'send' }, selection: { node: tall, reason: null, fileKey: 'abc123', remembered: null } }, pickBanner]];
  for (const mode of ['light', 'dark']) {
    for (const [name, options, steps, size] of [...states, ...narrow.map(([name, options, steps]) => [name, options, steps, { width: 320, height: 480 }]),
      ...wide.map(([name, options, steps]) => [name, options, steps, { width: 640, height: 900 }])]) {
      const page = await openUi(options, { theme: mode, ...(size ?? {}) });
      try {
        await steps?.(page);
        await page.screenshot(join(shots, `${name}-${mode}.png`));
      } finally { await page.close(); }
    }
  }
});
