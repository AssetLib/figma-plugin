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
  const [mainSource, uiSource] = await Promise.all(['src/code.ts', 'src/ui/main.ts'].map(async entry => {
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
// Tags of ui.html elements the UI tells apart: text fields and selects (focus there is never taken), and the settings.
const staticTags = {
  input: ['org-id', 'app-id', 'token', 'file-url', 'insert-search'], select: [...selects, 'origin'],
  details: ['settings'], summary: ['settings-summary'], form: ['connection-form', 'file-form'],
  a: ['open-console', 'insert-empty-link', 'insert-note-link', 'sync-console'],
};
// Where ui.html nests the connection settings (the account panel), so settings.contains() sees its controls.
const staticParents = {
  'settings-summary': 'settings', 'connection-label': 'settings-summary', 'account-name': 'settings-summary', 'connection-form': 'settings',
  'origin-field': 'settings', origin: 'origin-field', 'id-fields': 'connection-form', 'org-id': 'id-fields', 'app-id': 'id-fields', token: 'connection-form',
  'connection-error': 'connection-form', connect: 'connection-form', account: 'settings', 'account-title': 'account', 'token-prefix': 'account',
  'account-actions': 'account', 'open-console': 'account-actions', 'switch-workspace': 'account-actions', 'update-token': 'account-actions',
  disconnect: 'account-actions', 'first-run': 'settings', 'first-run-title': 'first-run', 'first-run-text': 'first-run',
  // One-click Connect's block, its note, and the browser path, inside the settings.
  pairing: 'settings', 'pairing-open': 'pairing', 'pairing-check': 'pairing', 'pairing-cancel': 'pairing', 'pairing-note': 'settings',
  'browser-path': 'settings', 'connect-browser': 'browser-path', 'use-token': 'browser-path',
  // The file link form, so a check for focus inside it sees its field and buttons.
  'file-form': 'file-fallback', 'file-url': 'file-form', 'file-mismatch-box': 'file-fallback', 'file-anyway': 'file-mismatch-box',
};
export const controls = ['origin', 'org-id', 'app-id', 'token', 'connect', 'update-token', 'disconnect', 'placement', 'state', 'appearance', 'arm', 'send', 'sync', 'match-ratio',
  'file-url', 'tab-send', 'tab-insert', 'browse-placements', 'browse-images', 'insert-search', 'search-clear', 'scale-1', 'scale-2', 'scale-3', 'env-draft',
  'env-staging', 'env-production', 'insert-refresh', 'images-more', 'insert-clear', 'insert-retry', 'insert-token', 'insert-go-send', 'insert-state',
  'insert-appearance', 'insert-arm', 'insert', 'insert-new', 'hint-close', 'sync-match', 'sync-send', 'file-anyway', 'file-change', 'connect-browser', 'use-token',
  'switch-workspace', 'pairing-open', 'pairing-check', 'pairing-cancel', 'sync-switch'];

export class Element {
  constructor(id = '', tag = '') {
    // Elements from getElementById are in the page; created ones are while an ancestor is.
    this.static = false;
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
    this.style = {};
  }
  get isConnected() { return this.static || Boolean(this.parentElement?.isConnected); }
  get tagName() { return this.tag.toUpperCase(); }
  // A static element's parent comes from staticParents; a created or moved one's from parentElement.
  contains(other) {
    for (let item = other; item; item = item.parentElement ?? item.staticParent?.() ?? null) if (item === this) return true;
    return false;
  }
  addEventListener(type, callback) { this.listeners.set(type, callback); }
  /** Calls this element's listener for `type` with an event targeting it (or `init.target`); returns the event. */
  dispatch(type, init = {}) {
    const event = { type, target: this, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; }, ...init };
    this.listeners.get(type)?.(event);
    return event;
  }
  click() { this.dispatch('click'); }
  select() { this.selectedText = this.value; }
  replaceChildren(...children) {
    for (const child of this.children) if (child.parentElement === this) child.parentElement = null;
    for (const child of children) child.parentElement = this;
    this.children = children;
    if (selects.includes(this.id)) this.value = children[0]?.value ?? '';
  }
  // Appending moves a child, as in the DOM, so tests can see where the UI placed it. A string is text, added to textContent.
  append(...children) {
    for (const child of children) {
      if (typeof child !== 'object') { this.textContent += child; continue; }
      if (child.parentElement) child.parentElement.children = child.parentElement.children.filter(item => item !== child);
      child.parentElement = this;
    }
    this.children.push(...children);
  }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  removeAttribute(name) { this.attributes.delete(name); if (name === 'src') this.src = ''; }
  scrollIntoView(options) { this.scrolledIntoView = options; }
  // There is no layout: every box is empty, so the UI measures nothing (connection.ts fits the chip only in a box).
  getBoundingClientRect() { return { x: 0, y: 0, width: 0, height: 0, top: 0, left: 0, right: 0, bottom: 0 }; }
  // The harness sets focusState, so document.activeElement follows focus() as in the DOM.
  focus() { if (this.focusState) this.focusState.active = this; }
  // Pointer capture, as the resize grip uses it.
  setPointerCapture(pointerId) { this.capture = pointerId; }
  hasPointerCapture(pointerId) { return this.capture === pointerId; }
  releasePointerCapture(pointerId) { if (this.capture === pointerId) this.capture = undefined; }
}

export class Option {
  constructor(text, value) { this.textContent = text; this.value = value; }
}

/** A DataTransfer for a dragstart: records the data, the allowed effect, and the drag image. */
export function dataTransfer() {
  return { effectAllowed: 'uninitialized', data: {}, image: null,
    setData(type, value) { this.data[type] = value; }, setDragImage(image, x, y) { this.image = { image, x, y }; } };
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

const jsonResponse = (status, payload, headers = {}) => ({
  status,
  headers: { get: name => name.toLowerCase() === 'content-type' ? 'application/json' : headers[name.toLowerCase()] ?? null },
  async json() { return clone(payload); },
  async arrayBuffer() { return new TextEncoder().encode(JSON.stringify(payload)).buffer; },
});

// The codes a fake connection request shows, in turn (the console's alphabet, 8 letters).
const USER_CODES = ['BCDFGHJK', 'LMNPQRST', 'VWXZBCDF'];
const REVOKED = 'This Figma connection was ended. Connect again from the Assetlib plugin.';

/**
 * A console that answers by URL. The state is read on every call, so tests can change it mid-run:
 * statuses[route] answers with that HTTP status (and headers[route], such as retry-after, on it) and errors[route] as its
 * error text (a 403 says what the console says for a token without the scope, unless errors[route] says otherwise, as
 * the console's revoked token does), codes[route] adds a refused Figma connection's `code`, failures (a Set of routes)
 * throw a network error, and gates[route] (a deferred) holds the response until resolved. GET /api/token (route `token`)
 * answers with state.identity, else the identity the harness registered for the bearer token, else an issued token's,
 * else 404 as a console from before that route does; without a token, 401.
 *
 * One-click Connect's routes are `start`, `claim`, `cancel`, and `current`. Each start adds a request to
 * state.pairings ({readKey, writeKey, userCode, status, interval, hint, connection, answers}; state.pairingStart merges
 * into its 201 answer). A claim answers its request's next scripted `answers` entry ([status, body, headers]) if any,
 * else by its status: pending; approved, which issues a token (state.issued) for its `connection` once and is then
 * claimed; or how it ended (410). Unknown read keys answer 410 expired. A cancel ends a pending or approved request and
 * ends the token of a claimed one (state.revoked). DELETE current ends an issued token (204), refuses a pasted one (400),
 * and an ended token gets 403 `revoked` from every other route. A console from before one-click Connect is
 * failures: ['start'] (its routes send no CORS headers), with GET /api/token still answering.
 */
export function fakeConsole(state) {
  state.statuses ??= {};
  state.failures ??= new Set();
  state.gates ??= {};
  state.headers ??= {};
  state.errors ??= {};
  state.codes ??= {};
  state.pairings ??= [];
  state.issued ??= new Map();
  state.revoked ??= new Set();
  return async (url, options, request) => {
    const path = /^https?:\/\/[^/]+\/api\/apps\/[^/]+\/[^/]+\/(.*)$/.exec(url)?.[1] ?? '';
    const pairingRoute = /^https?:\/\/[^/]+\/api\/plugin-connections(?:\/(claim|cancel|current))?$/.exec(url);
    // /placements/artwork is matched before /placements.
    const route = pairingRoute ? pairingRoute[1] ?? 'start' : /^https?:\/\/[^/]+\/api\/token$/.test(url) ? 'token' : path === 'placements/artwork' ? 'artwork'
      : path === 'placements' ? 'placements' : /^assets(\?.*)?$/.test(path) ? 'assets' : /^assets\/[^/?]+\/renditions\/[^/?]+$/.test(path) ? 'rendition'
        : path === 'drafts' ? 'drafts' : 'unknown';
    request.route = route;
    const bearer = String(options?.headers?.Authorization ?? '').replace(/^Bearer /, '');
    if (state.gates[route]) await state.gates[route].promise;
    if (state.failures.has(route)) throw new TypeError('fetch failed');
    const status = state.statuses[route];
    if (status) {
      const error = state.errors[route] ?? (status === 403 ? 'This API token lacks the required scope.' : `HTTP ${status} from the fake console.`);
      return jsonResponse(status, { error, ...(state.codes[route] ? { code: state.codes[route] } : {}) }, state.headers[route]);
    }
    if (!pairingRoute && state.revoked.has(bearer)) return jsonResponse(403, { error: REVOKED, code: 'revoked' });
    const pairing = state.pairings.find(item => item.readKey === bearer);
    switch (route) {
      case 'start': {
        const n = state.pairings.length + 1;
        const started = { readKey: `alr_${String(n).padStart(43, '0')}`, writeKey: `alw_${String(n).padStart(43, 'w')}`, userCode: USER_CODES[(n - 1) % USER_CODES.length],
          status: 'pending', interval: 2, hint: request.body?.hint ?? null, connection: null, answers: [] };
        state.pairings.push(started);
        const code = started.userCode;
        return jsonResponse(201, { readKey: started.readKey, writeKey: started.writeKey, userCode: `${code.slice(0, 4)}-${code.slice(4)}`,
          expiresAt: new Date(Date.now() + 600000).toISOString(), expiresIn: 600, interval: 2, ...state.pairingStart });
      }
      case 'claim': {
        if (!/^alr_[A-Za-z0-9_-]{43}$/.test(bearer)) return jsonResponse(401, { error: 'Missing or invalid pairing key.' });
        if (!pairing) return jsonResponse(410, { status: 'expired' });
        if (pairing.answers.length) { const [answer, body, headers] = pairing.answers.shift(); return jsonResponse(answer, body, headers); }
        if (pairing.status === 'pending') return jsonResponse(200, { status: 'pending', interval: pairing.interval });
        if (pairing.status !== 'approved') return jsonResponse(410, { status: pairing.status });
        const token = `alk_figma${String(state.issued.size + 1).padStart(38, '0')}`;
        const { orgId, appId, workspaceName = null, appName = null } = pairing.connection;
        state.issued.set(token, { orgId, appId, workspaceName, appName, scopes: ['draft'] });
        Object.assign(pairing, { status: 'claimed', token });
        return jsonResponse(200, { status: 'connected', connection: { ...pairing.connection, token } });
      }
      case 'cancel': {
        if (!/^alr_[A-Za-z0-9_-]{43}$/.test(bearer)) return jsonResponse(401, { error: 'Missing or invalid pairing key.' });
        if (pairing?.status === 'pending' || pairing?.status === 'approved') pairing.status = 'cancelled';
        else if (pairing?.status === 'claimed' && !pairing.reused) { pairing.reused = true; state.revoked.add(pairing.token); }
        return jsonResponse(204, null);
      }
      case 'current':
        if (state.issued.has(bearer)) { state.revoked.add(bearer); return jsonResponse(204, null); }
        return /^alk_/.test(bearer) ? jsonResponse(400, { error: 'This token was created in Settings › Tokens. An owner revokes it there.' })
          : jsonResponse(401, { error: 'Missing or invalid API token.' });
      case 'token': {
        if (!bearer) return jsonResponse(401, { error: 'Missing or invalid API token.' });
        const identity = state.identity ?? request.identity ?? state.issued.get(bearer);
        return identity ? jsonResponse(200, identity) : jsonResponse(404, { error: 'Not found.' });
      }
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
 * IntersectionObserver for the UI, driven by the test: `isVisible(target)` decides what intersects. As in the DOM,
 * observe() delivers each target's state asynchronously, and later only changes are delivered.
 */
function intersectionObservers() {
  const observers = new Set();
  let isVisible = () => true;
  class IntersectionObserver {
    constructor(callback, options = {}) { this.callback = callback; this.options = { ...options }; this.targets = new Map(); this.pending = new Set(); observers.add(this); }
    observe(target) { if (this.targets.has(target)) return; this.targets.set(target, null); this.schedule([target]); }
    unobserve(target) { this.targets.delete(target); this.pending.delete(target); }
    disconnect() { this.targets.clear(); this.pending.clear(); observers.delete(this); }
    schedule(targets) {
      const idle = this.pending.size === 0;
      for (const target of targets) this.pending.add(target);
      if (idle && this.pending.size) Promise.resolve().then(() => this.deliver());
    }
    deliver() {
      const entries = [];
      for (const target of this.pending) {
        if (!this.targets.has(target)) continue;
        const state = Boolean(isVisible(target));
        if (this.targets.get(target) === state) continue;
        this.targets.set(target, state);
        entries.push({ target, isIntersecting: state });
      }
      this.pending.clear();
      if (entries.length) this.callback(entries, this);
    }
  }
  return {
    IntersectionObserver, observers,
    /** As if the list scrolled: every observed target is checked again against `predicate`. */
    setVisible(predicate) { isVisible = predicate; for (const observer of observers) observer.schedule([...observer.targets.keys()]); },
  };
}

function abortError() { return Object.assign(new Error('The operation was aborted.'), { name: 'AbortError' }); }

/**
 * Runs the bundled main thread and UI in node:vm. `fetch(url, options, request)` answers the UI's requests;
 * every request is recorded first, and one whose AbortSignal fires rejects as fetch does. Nodes in `selection` are
 * plain specs; `pluginData` seeds their plugin data. Animation frames run at once unless `manualFrames` is set, when
 * they wait for runFrames(). `now` replaces both sides' clock, and `store` is client storage shared with another harness.
 */
export function createHarness({
  mainSource, uiSource, fetch, storage = [], fileKey = 'abc123', selection = [], exportBytes = () => new Uint8Array(0),
  createImageBitmap, failingWrites = [], viewport = { center: { x: 500, y: 300 }, bounds: { x: 0, y: 0, width: 1000, height: 600 }, zoom: 1 },
  command = '', manualFrames = false, rootName = 'Untitled', rootPluginData = {}, readOnlyRoot = false, now, store: sharedStore,
}) {
  // `now`: a clock for Date.now() (and new Date()) on both sides, so a test can move time; the real clock otherwise.
  const clock = now ? { Date: class extends Date { constructor(...args) { super(...(args.length ? args : [now()])); } static now() { return now(); } } } : {};
  const elements = new Map();
  const element = id => {
    if (!elements.has(id)) {
      const tag = Object.keys(staticTags).find(name => staticTags[name].includes(id)) ?? '';
      const item = new Element(id, tag);
      item.static = true;
      // ui.html's first console option is selected until the UI chooses another, and a <details> starts closed.
      if (id === 'origin') item.value = 'https://console.assetlib.dev';
      if (tag === 'details') item.open = false;
      item.focusState = focusState;
      if (staticParents[id]) item.staticParent = () => element(staticParents[id]);
      elements.set(id, item);
    }
    return elements.get(id);
  };
  const createElement = tag => {
    if (tag === 'canvas') return canvas();
    const item = new Element('', tag);
    item.focusState = focusState;
    return item;
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
  const canvases = [];
  const resizes = [];
  const undoCommits = [];
  const notifications = [];
  const undoTriggers = [];
  const externalUrls = [];
  const uiResizes = [];
  // showUI's options, and when the window showed: each entry counts the ui.resize calls made before it.
  const uiShown = { options: null, shows: [] };
  const relaunches = [];
  // What the UI posted as pluginDrop, which Figma turns into a drop event (dropOnCanvas), not a plugin message.
  const pluginDrops = [];
  const focusState = { active: null };
  // Identities GET /api/token answers for tokens saveConnection typed, as the console knows its own tokens.
  const identities = new Map();
  const intersections = intersectionObservers();
  const timers = new Map();
  // `store`: client storage shared with another harness, as every window of a plugin shares it.
  const store = sharedStore ?? new Map(storage.map(([key, value]) => [key, clone(value)]));
  const events = new Map();
  let delayTargets = false;
  let connectionWrite = null;
  let exportGate = null;
  let timerId = 0;
  // The UI's window: its size follows figma.ui.resize, and its resize listener runs when it changes.
  const windowListeners = new Map();
  const window = {
    innerWidth: 420, innerHeight: 720,
    setTimeout(callback, delay) { timerId += 1; timers.set(timerId, { callback, delay }); return timerId; },
    clearTimeout(id) { timers.delete(id); },
    addEventListener(type, callback) { windowListeners.set(type, callback); },
  };
  const parent = { postMessage({ pluginMessage, pluginDrop }) {
    if (pluginDrop) { pluginDrops.push(clone(pluginDrop)); return; }
    const message = clone(pluginMessage);
    uiMessages.push(message);
    figma.ui.onmessage(message);
  } };
  const deliver = message => window.onmessage({ source: parent, data: { pluginMessage: clone(message) } });
  // A node from a plain spec. `children` (specs) become child nodes; x and y are relative to a parent frame, as in Figma,
  // and absoluteBoundingBox adds the parents'. Like Figma, a layer inside an instance (an id with ";") refuses plugin
  // data, an instance or a layer inside one refuses children, and a component refuses to go inside a component, a
  // component set, or an instance, or any layer inside one; `refusePluginData` and `refuseChildren` make any other node
  // refuse them too.
  const makeNode = ({ pluginData = {}, children, ...spec }, parent = null) => {
    const data = new Map(Object.entries(pluginData));
    const item = {
      removed: false,
      parent,
      resize(width, height) { resizes.push({ id: this.id, width, height, layoutSizingVertical: this.layoutSizingVertical }); this.width = width; this.height = height; },
      ...spec,
      get absoluteBoundingBox() {
        const base = this.parent && this.parent.type !== 'PAGE' ? this.parent.absoluteBoundingBox : { x: 0, y: 0 };
        return { x: base.x + (this.x ?? 0), y: base.y + (this.y ?? 0), width: this.width, height: this.height };
      },
      async exportAsync(settings) {
        exports.push(clone(settings));
        if (exportGate) await exportGate.promise;
        return exportBytes(this, settings);
      },
      getPluginData(key) { return data.get(key) ?? ''; },
      setPluginData(key, value) {
        if (this.refusePluginData || String(this.id).includes(';')) throw new Error('Cannot set plugin data on a node inside an instance');
        data.set(key, String(value));
      },
      setRelaunchData(value) { relaunches.push({ id: this.id, data: clone(value) }); this.relaunchData = clone(value); },
      getRelaunchData() { return clone(this.relaunchData ?? {}); },
      appendChild(child) {
        if (this.refuseChildren || this.type === 'INSTANCE' || String(this.id).includes(';')) throw new Error('Cannot move node. New parent is an instance or is inside of an instance');
        for (let item = child.type === 'COMPONENT' ? this : null; item && item.type !== 'PAGE'; item = item.parent) {
          if (['COMPONENT', 'COMPONENT_SET', 'INSTANCE'].includes(item.type)) throw new Error('Cannot move node. A component can’t be inside a component, a component set, or an instance');
        }
        if (child.parent?.children) child.parent.children = child.parent.children.filter(other => other !== child);
        child.parent = this;
        (this.children ??= []).push(child);
      },
      remove() {
        this.removed = true;
        if (this.parent?.children) this.parent.children = this.parent.children.filter(other => other !== this);
        this.parent = null;
      },
    };
    if (children) item.children = children.map(child => makeNode(child, item));
    return item;
  };
  // A page with nodechange listeners, as PageNode.on and off. Its children are the given nodes plus created frames.
  const makePage = nodes => {
    const listeners = new Set();
    const page = { type: 'PAGE', selection: nodes, children: [...nodes], listeners, on(type, callback) { if (type === 'nodechange') listeners.add(callback); },
      off(type, callback) { if (type === 'nodechange') listeners.delete(callback); },
      // As PageNode.findAllWithCriteria: by types, and by plugin data keys that are set.
      findAllWithCriteria({ types, pluginData } = {}) {
        const found = [];
        const walk = items => { for (const item of items) { found.push(item); walk(item.children ?? []); } };
        walk(this.children);
        return found.filter(item => (!types || types.includes(item.type))
          && (!pluginData?.keys || pluginData.keys.some(key => item.getPluginData?.(key))));
      } };
    for (const item of nodes) if (!item.parent) item.parent = page;
    return page;
  };
  // The document root's plugin data; `readOnlyRoot` refuses writes to it, as a file the person can only view would.
  const rootData = new Map(Object.entries(rootPluginData));
  // Frames and components the plugin creates, in order, in `frames` and on the current page.
  const insertable = (type, extra) => {
    const node = makeNode({ id: `${200 + frames.length}:7`, name: type === 'FRAME' ? 'Frame' : 'Component', type, width: 100, height: 100, x: 0, y: 0, fills: [], clipsContent: false, ...extra },
      figma.currentPage);
    node.resize = function resize(width, height) { this.width = width; this.height = height; };
    frames.push(node);
    figma.currentPage.children.push(node);
    return node;
  };
  const figma = {
    fileKey,
    command,
    currentPage: makePage(selection.map(spec => makeNode(spec))),
    root: {
      type: 'DOCUMENT', name: rootName,
      getPluginData(key) { return rootData.get(key) ?? ''; },
      setPluginData(key, value) { if (readOnlyRoot) throw new Error('Cannot write to a read-only document'); rootData.set(key, String(value)); },
      setRelaunchData(value) {
        if (readOnlyRoot) throw new Error('Cannot write to a read-only document');
        relaunches.push({ id: '0:0', data: clone(value) }); this.relaunchData = clone(value);
      },
      getRelaunchData() { return clone(this.relaunchData ?? {}); },
    },
    viewport: { center: { ...viewport.center }, bounds: { ...viewport.bounds }, zoom: viewport.zoom ?? 1, scrollAndZoomIntoView(nodes) { scrolls.push([...nodes].map(item => item.id)); } },
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
      async deleteAsync(key) {
        if (failingWrites.includes(key)) throw new Error('Client storage is unavailable.');
        store.delete(key);
      },
    },
    // Figma accepts PNG, JPEG, and GIF; the fake accepts PNG only and records each image.
    createImage(bytes) {
      const size = pngSizeOf(bytes);
      if (!size) throw new Error('Image type is unsupported');
      images.push(bytes);
      return { hash: `hash-${images.length}`, async getSizeAsync() { return size; } };
    },
    createFrame() { return insertable('FRAME', {}); },
    createComponent() { return insertable('COMPONENT', { description: '', documentationLinks: [] }); },
    // notices keeps the text of each toast; notifications keeps its options (a button, a timeout) too.
    // A toast's handler records when the plugin cancels it.
    notify(message, options) {
      const entry = { message, options, cancelled: false };
      notices.push(message);
      notifications.push(entry);
      return { cancel() { entry.cancelled = true; } };
    },
    commitUndo() { undoCommits.push(resizes.length); },
    triggerUndo() { undoTriggers.push(undoCommits.length); },
    openExternal(url) { externalUrls.push(url); },
    showUI(html, options) {
      uiShown.options = clone(options);
      if (options?.visible !== false) uiShown.shows.push(uiResizes.length);
      window.innerWidth = options?.width ?? 100;
      window.innerHeight = options?.height ?? 100;
    },
    on(type, callback) { events.set(type, callback); },
    ui: {
      postMessage(message) { mainMessages.push(clone(message)); deliver(message); },
      resize(width, height) {
        uiResizes.push({ width, height });
        window.innerWidth = width;
        window.innerHeight = height;
        windowListeners.get('resize')?.({ type: 'resize' });
      },
      show() { uiShown.shows.push(uiResizes.length); },
    },
  };
  // Main and the UI share the fake timers; fireTimers(delay) runs either side's.
  vm.runInNewContext(mainSource, { figma, __html__: '', setTimeout: window.setTimeout, clearTimeout: window.clearTimeout, ...clock }, { filename: 'code.bundle.js' });
  function canvas() {
    const item = {
      width: 0, height: 0,
      getContext(type) { return type === '2d' ? { drawImage: bitmap => bitmaps.push({ width: bitmap.width, height: bitmap.height }) } : null; },
      toBlob(callback, type) { callback(new Blob([pngHeader(this.width, this.height)], { type })); },
    };
    canvases.push(item);
    return item;
  }
  // Document listeners (the search shortcut's keydown); keydown() calls them as a key press that reached the document.
  const documentListeners = new Map();
  const document = { getElementById: element, querySelectorAll: () => controls.map(element), createElement, get activeElement() { return focusState.active; },
    visibilityState: 'visible', addEventListener(type, callback) { documentListeners.set(type, callback); } };
  // Animation frames: queued callbacks run together, as one browser frame; a frame asked for during one runs after it.
  const animationFrames = [];
  let frameDepth = 0;
  let frameId = 0;
  function runFrames() {
    frameDepth += 1;
    try { while (animationFrames.length) animationFrames.shift().callback(); } finally { frameDepth -= 1; }
  }
  const requestAnimationFrame = callback => {
    frameId += 1;
    animationFrames.push({ id: frameId, callback });
    if (!manualFrames && frameDepth === 0) runFrames();
    return frameId;
  };
  const cancelAnimationFrame = id => {
    const index = animationFrames.findIndex(item => item.id === id);
    if (index >= 0) animationFrames.splice(index, 1);
  };
  vm.runInNewContext(uiSource, {
    parent, window, AbortController, Blob, Option, IntersectionObserver: intersections.IntersectionObserver, document, navigator: { platform: 'MacIntel' },
    requestAnimationFrame, cancelAnimationFrame, ...clock,
    ...(createImageBitmap ? { createImageBitmap } : {}),
    async fetch(url, options = {}) {
      const request = { url, method: options.method ?? 'GET', authorization: options.headers?.Authorization,
        credentials: options.credentials, redirect: options.redirect, body: options.body ? JSON.parse(options.body) : null };
      // Kept off the enumerable fields, so tests can compare requests as plain data.
      Object.defineProperty(request, 'signal', { value: options.signal ?? null, enumerable: false });
      Object.defineProperty(request, 'identity', { value: identities.get(String(options.headers?.Authorization ?? '').replace(/^Bearer /, '')) ?? null, enumerable: false });
      requests.push(request);
      const { signal } = options;
      if (signal?.aborted) throw abortError();
      if (!signal) return fetch(url, options, request);
      return new Promise((resolve, reject) => {
        const onAbort = () => reject(abortError());
        signal.addEventListener('abort', onAbort, { once: true });
        Promise.resolve(fetch(url, options, request)).then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
      });
    },
  }, { filename: 'ui.bundle.js' });
  return {
    figma, document, element, elements, mainMessages, uiMessages, requests, exports, pendingReads, deliver, storage: store, notices, images, frames, scrolls, bitmaps, timers,
    canvases, resizes, undoCommits, notifications, undoTriggers, externalUrls, uiResizes, uiShown, relaunches, pluginDrops, window,
    observers: intersections.observers, setVisible: intersections.setVisible,
    activeElement: () => focusState.active,
    /** Runs the animation frames the UI asked for (with `manualFrames`); returns how many ran. */
    runFrames() { const count = animationFrames.length; runFrames(); return count; },
    pendingFrames: () => animationFrames.length,
    /**
     * A key press on the focused element, as the DOM delivers it: to `listener` (the element whose keydown listener
     * handles it, such as the list for a row), then, unless that prevented it, to the document. Returns the event.
     */
    keydown(init, listener = focusState.active) {
      const event = listener ? listener.dispatch('keydown', { target: focusState.active, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, ...init })
        : { target: null, altKey: false, ctrlKey: false, metaKey: false, shiftKey: false, defaultPrevented: false, preventDefault() { event.defaultPrevented = true; }, ...init };
      if (!event.defaultPrevented) documentListeners.get('keydown')?.(event);
      return event;
    },
    /** Calls the plugin's drop handler, as Figma does for a drop on the canvas, and returns its result. */
    drop(event) { return events.get('drop')?.(event); },
    /**
     * Figma's drop event for the UI's last pluginDrop, landing on `node` (the page unless given; Figma names the frame,
     * group, or section under the pointer) at the page point (absoluteX, absoluteY). Returns the handler's result.
     */
    dropOnCanvas({ node = figma.currentPage, absoluteX = 0, absoluteY = 0 } = {}) {
      const { files, dropMetadata } = pluginDrops.at(-1);
      const origin = node.type === 'PAGE' ? { x: 0, y: 0 } : node.absoluteBoundingBox;
      return events.get('drop')?.({ node, x: absoluteX - origin.x, y: absoluteY - origin.y, absoluteX, absoluteY, items: [], files, dropMetadata });
    },
    /** Figma closing the plugin. */
    close() { events.get('close')?.(); },
    /** The plugin window gains focus (the person came back from the browser). */
    focusWindow() { windowListeners.get('focus')?.({ type: 'focus' }); },
    /** The page is shown or hidden (document.visibilityState), with its visibilitychange event. */
    setVisibility(value) { document.visibilityState = value; documentListeners.get('visibilitychange')?.({ type: 'visibilitychange' }); },
    /** Fires the current page's nodechange listeners. */
    nodeChange(nodeChanges) { for (const listener of [...figma.currentPage.listeners]) listener({ nodeChanges }); },
    /** Switches to a new page holding `nodes` (plain specs), as Figma's currentpagechange. */
    changePage(nodes = []) { figma.currentPage = makePage(nodes.map(spec => makeNode(spec))); events.get('currentpagechange')(); return figma.currentPage; },
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
    /**
     * Types `next` into the connection form and submits it. The console knows a typed token's organization and app
     * (GET /api/token), as a real console knows its own tokens; the organization and app fields are used only when the
     * form shows them (an older console).
     */
    saveConnection(next) {
      element('origin').value = next.origin;
      element('org-id').value = next.orgId;
      element('app-id').value = next.appId;
      element('token').value = next.token;
      if (next.token) identities.set(next.token.trim(), { orgId: next.orgId, appId: next.appId, workspaceName: next.workspaceName ?? null, appName: next.appName ?? null, scopes: ['draft'] });
      element('connection-form').dispatch('submit');
    },
  };
}
