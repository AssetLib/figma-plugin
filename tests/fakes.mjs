// Fake Figma, DOM, and console for tests/plugin.test.mjs and scripts/e2e-local.mjs. Not a test file itself.
import vm from 'node:vm';
import { build } from 'esbuild';

export const clone = value => structuredClone(value);

export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

export async function flush() {
  // Drain all promises used by the real UI/main handlers without real network or timers.
  await new Promise(resolve => setImmediate(resolve));
}

export async function waitFor(predicate, { timeout = 15000, message = 'condition' } = {}) {
  const started = Date.now();
  while (!predicate()) {
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${message}.`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

export async function bundlePlugin(root) {
  const [mainSource, uiSource] = await Promise.all(['src/code.ts', 'src/ui.ts'].map(async entry => {
    const result = await build({ absWorkingDir: root, entryPoints: [entry], bundle: true, write: false, format: 'iife' });
    return result.outputFiles[0].text;
  }));
  return { mainSource, uiSource };
}

// Only the PNG signature and complete IHDR chunk are needed by the header checks.
export function pngHeader(width, height) {
  const bytes = new Uint8Array(33);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  bytes[24] = 8;
  bytes[25] = 6;
  return bytes;
}

export function pngSizeOf(bytes) {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength < 33 || ![137, 80, 78, 71, 13, 10, 26, 10].every((value, index) => bytes[index] === value)) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

const selects = ['placement', 'state', 'appearance', 'arm', 'insert-state', 'insert-appearance', 'insert-arm'];
export const controls = ['origin', 'org-id', 'app-id', 'token', 'placement', 'state', 'appearance', 'arm', 'send', 'sync', 'file-url',
  'tab-send', 'tab-insert', 'browse-placements', 'browse-images', 'insert-search', 'insert-scale', 'env-draft', 'env-staging',
  'env-production', 'insert-refresh', 'images-more', 'insert-clear', 'insert-state', 'insert-appearance', 'insert-arm', 'insert'];

export class Element {
  constructor(id = '', tag = '') {
    this.id = id;
    this.tag = tag;
    this.value = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.src = '';
    this.children = [];
    this.listeners = new Map();
    this.attributes = new Map();
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  dispatch(type) { this.listeners.get(type)?.({ preventDefault() {} }); }
  replaceChildren(...children) {
    this.children = children;
    if (selects.includes(this.id)) this.value = children[0]?.value ?? '';
  }
  // Appending moves a child, as in the DOM, so tests can see where the UI placed it.
  append(...children) {
    for (const child of children) {
      if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
      child.parentElement = this;
    }
    this.children.push(...children);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  scrollIntoView(options) { this.scrolledIntoView = options; }
}

export class Option {
  constructor(text, value) { this.textContent = text; this.value = value; }
}

export function descendants(root) {
  const found = [];
  const walk = item => { for (const child of item.children ?? []) { found.push(child); walk(child); } };
  walk(root);
  return found;
}

export function textOf(item) {
  return [item.textContent ?? '', ...(item.children ?? []).map(textOf)].join('');
}

const jsonResponse = (status, payload) => ({
  status,
  headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json' : null },
  async json() { return clone(payload); },
  async arrayBuffer() { return new TextEncoder().encode(JSON.stringify(payload)).buffer; },
});

/**
 * A console that answers by URL. The state is read on every call, so tests can change it mid-run:
 * statuses[route] answers with that HTTP status, failures (a Set of routes) throw a network error,
 * and gates[route] (a deferred) holds the response until resolved.
 */
export function fakeConsole(state) {
  state.statuses ??= {};
  state.failures ??= new Set();
  state.gates ??= {};
  return async (url, options, request) => {
    const path = /^https?:\/\/[^/]+\/api\/apps\/[^/]+\/[^/]+\/(.*)$/.exec(url)?.[1] ?? '';
    // /placements/artwork is matched before /placements.
    const route = path === 'placements/artwork' ? 'artwork' : path === 'placements' ? 'placements'
      : /^assets(\?.*)?$/.test(path) ? 'assets' : /^assets\/[^/?]+\/renditions\/[^/?]+$/.test(path) ? 'rendition'
        : path === 'drafts' ? 'drafts' : 'unknown';
    request.route = route;
    if (state.gates[route]) await state.gates[route].promise;
    if (state.failures.has(route)) throw new TypeError('fetch failed');
    if (state.statuses[route]) return jsonResponse(state.statuses[route], { error: `HTTP ${state.statuses[route]} from the fake console.` });
    switch (route) {
      case 'placements': return jsonResponse(200, { placements: state.placements ?? [] });
      case 'artwork': return state.artwork ? jsonResponse(200, state.artwork) : jsonResponse(404, { error: 'Not found.' });
      case 'assets': {
        const params = new URLSearchParams(path.split('?')[1] ?? '');
        const q = (params.get('q') ?? '').toLowerCase();
        const limit = Number(params.get('limit') ?? 24);
        const matches = (state.library ?? []).filter(asset => !q || asset.name.toLowerCase().includes(q));
        const start = params.get('cursor') ? matches.findIndex(asset => asset.id === params.get('cursor')) + 1 : 0;
        const page = matches.slice(start, start + limit);
        return jsonResponse(200, { assets: page, nextCursor: start + limit < matches.length ? page.at(-1).id : null });
      }
      case 'rendition': {
        const [, assetId, sha] = /^assets\/([^/]+)\/renditions\/([^/]+)$/.exec(path);
        const item = (state.renditions ?? []).find(entry => entry.sha256 === sha && entry.assetId === assetId);
        if (!item) return jsonResponse(404, { error: 'Rendition not found.' });
        // item.contentLength overrides the length header, which is otherwise absent as in a chunked response; item.read records a body read.
        const header = name => name.toLowerCase() === 'content-type' ? item.contentType ?? item.mime
          : name.toLowerCase() === 'content-length' && item.contentLength !== undefined ? String(item.contentLength) : null;
        return { status: 200, headers: { get: header },
          async json() { throw new SyntaxError('not JSON'); },
          async arrayBuffer() { item.read = true; return item.body.slice().buffer; } };
      }
      case 'drafts': {
        const body = request.body;
        const result = state.draft?.(body) ?? { asset: { id: 'asset-new', name: body.name, width: 1000, height: 1000, sha256: 'a'.repeat(64), renditions: 1 },
          previous: null, bound: body.bind, bindError: null, rebound: body.rebind ? [body.bind] : [] };
        return jsonResponse(201, result);
      }
      default: return jsonResponse(404, { error: 'Not found.' });
    }
  };
}

/**
 * Runs the bundled main thread and UI in node:vm. `fetch(url, options, request)` answers the UI's requests;
 * every request is recorded first. Nodes in `selection` are plain specs; `pluginData` seeds their plugin data.
 */
export function createHarness({
  mainSource, uiSource, fetch, storage = [], fileKey = 'abc123', selection = [], exportBytes = () => new Uint8Array(0),
  createImageBitmap, failingWrites = [], viewport = { center: { x: 500, y: 300 }, bounds: { x: 0, y: 0, width: 1000, height: 600 } },
}) {
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) elements.set(id, new Element(id));
    return elements.get(id);
  };
  const mainMessages = [];
  const uiMessages = [];
  const requests = [];
  const exports = [];
  const pendingReads = [];
  const notices = [];
  const images = [];
  const frames = [];
  const scrolls = [];
  const bitmaps = [];
  const timers = new Map();
  const store = new Map(storage.map(([key, value]) => [key, clone(value)]));
  const events = new Map();
  let delayTargets = false;
  let connectionWrite = null;
  let exportGate = null;
  let timerId = 0;
  const window = {
    setTimeout(callback, delay) { timerId += 1; timers.set(timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
  };
  const parent = { postMessage({ pluginMessage }) {
    const message = clone(pluginMessage);
    uiMessages.push(message);
    figma.ui.onmessage(message);
  } };
  const deliver = message => window.onmessage({ source: parent, data: { pluginMessage: clone(message) } });
  const makeNode = ({ pluginData = {}, ...spec }) => {
    const data = new Map(Object.entries(pluginData));
    return {
      removed: false, ...spec,
      async exportAsync(settings) {
        exports.push(clone(settings));
        if (exportGate) await exportGate.promise;
        return exportBytes(this, settings);
      },
      getPluginData(key) { return data.get(key) ?? ''; },
      setPluginData(key, value) { data.set(key, String(value)); },
    };
  };
  const figma = {
    fileKey,
    currentPage: { selection: selection.map(makeNode) },
    viewport: { center: { ...viewport.center }, bounds: { ...viewport.bounds }, scrollAndZoomIntoView(nodes) { scrolls.push([...nodes].map(item => item.id)); } },
    clientStorage: {
      async getAsync(key) {
        if (delayTargets && key.startsWith('assetlib.target.v1:')) {
          const pending = { key, ...deferred() };
          pendingReads.push(pending);
          return pending.promise;
        }
        return clone(store.get(key));
      },
      async setAsync(key, value) {
        if (key === 'assetlib.connection.v1' && connectionWrite) await connectionWrite.promise;
        if (failingWrites.includes(key)) throw new Error('Client storage is unavailable.');
        store.set(key, clone(value));
      },
    },
    // Figma accepts PNG, JPEG, and GIF; the fake accepts PNG only and records each image.
    createImage(bytes) {
      const size = pngSizeOf(bytes);
      if (!size) throw new Error('Image type is unsupported');
      images.push(bytes);
      return { hash: `hash-${images.length}`, async getSizeAsync() { return size; } };
    },
    createFrame() {
      const frame = makeNode({ id: `${200 + frames.length}:7`, name: 'Frame', type: 'FRAME', width: 100, height: 100, x: 0, y: 0, fills: [], clipsContent: false });
      frame.resize = function resize(width, height) { this.width = width; this.height = height; };
      frames.push(frame);
      return frame;
    },
    notify(message) { notices.push(message); },
    showUI() {},
    on(type, callback) { events.set(type, callback); },
    ui: { postMessage(message) { mainMessages.push(clone(message)); deliver(message); } },
  };
  vm.runInNewContext(mainSource, { figma, __html__: '' }, { filename: 'code.bundle.js' });
  const canvas = () => ({
    width: 0, height: 0,
    getContext(type) { return type === '2d' ? { drawImage: bitmap => bitmaps.push({ width: bitmap.width, height: bitmap.height }) } : null; },
    toBlob(callback, type) { callback(new Blob([pngHeader(this.width, this.height)], { type })); },
  });
  vm.runInNewContext(uiSource, {
    parent, window, AbortController, Blob, Option,
    document: { getElementById: element, querySelectorAll: () => controls.map(element), createElement: tag => tag === 'canvas' ? canvas() : new Element('', tag) },
    ...(createImageBitmap ? { createImageBitmap } : {}),
    async fetch(url, options = {}) {
      const request = { url, method: options.method ?? 'GET', authorization: options.headers?.Authorization,
        credentials: options.credentials, redirect: options.redirect, body: options.body ? JSON.parse(options.body) : null };
      requests.push(request);
      return fetch(url, options, request);
    },
  }, { filename: 'ui.bundle.js' });
  return {
    figma, element, elements, mainMessages, uiMessages, requests, exports, pendingReads, deliver, storage: store, notices, images, frames, scrolls, bitmaps, timers,
    drafts: () => requests.filter(request => request.method === 'POST'),
    exportMessages: () => uiMessages.filter(message => message.type === 'export'),
    insertMessages: () => uiMessages.filter(message => message.type === 'insert'),
    delayTargetReads() { delayTargets = true; },
    resumeTargetReads() { delayTargets = false; },
    delayConnectionWrite() { connectionWrite = deferred(); return connectionWrite; },
    delayExport() { exportGate = deferred(); return exportGate; },
    selectionChanged() { events.get('selectionchange')(); },
    select(nodes) { figma.currentPage.selection = nodes; events.get('selectionchange')(); },
    // A message as if the UI had posted it, for messages the UI itself never sends.
    postToMain(message) { parent.postMessage({ pluginMessage: message }); },
    fireTimers(delay) {
      for (const [id, timer] of [...timers]) if (timer.delay === delay) { timers.delete(id); timer.callback(); }
    },
    saveConnection(next) {
      element('origin').value = next.origin;
      element('org-id').value = next.orgId;
      element('app-id').value = next.appId;
      element('token').value = next.token;
      element('connection-form').dispatch('submit');
    },
  };
}
