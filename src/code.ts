import {
  LEGACY_PRODUCTION_ORIGIN, MAX_IMAGE_BYTES, MAX_INSERT_PIXELS, PRODUCTION_ORIGIN, chooseExportSettings, defaultPreferences,
  environmentLabel, isUint8Array, linkMatches, loadSavedConnection, parseFileKey, parsePlacements, parsePreferences,
  parseStoredLink, pngSize, sanitizeName, validateBinding, validateConnection, validateInsertLink,
} from './shared/index.js';
import type { Connection, NodeSelection, Preferences, StoredLink } from './shared/index.js';
import type { MainMessage, RememberedTarget, UiMessage } from './shared/protocol.js';

const CONNECTION_KEY = 'assetlib.connection.v1';
const FILE_URL_KEY = 'assetlib.file-url.v1';
const PREFERENCES_KEY = 'assetlib.preferences.v1';
// pluginData on an inserted frame: the cell it came from, never the token.
const LINK_KEY = 'assetlib.link.v1';
// A transcoded 2048 px PNG fits.
const MAX_INSERT_BYTES = 24 * 1024 * 1024;
let connection: Connection | null = null;
let connectionGeneration = 0;
let savedFileUrl = '';
// Without the public file key, a saved URL must be confirmed for each run:
// node IDs and page IDs alone cannot identify a file across documents.
let fallbackFileKey: string | null = null;
let selectionRevision = 0;
let exporting = false;
let importing = false;
let preferences: Preferences = defaultPreferences();
// Client storage targets keep their original shape; insertedFrom is only ever derived from a link.
type StoredTarget = Omit<RememberedTarget, 'fileKey' | 'insertedFrom'> & { fileKey: string };
const exported = new Map<number, { storageKey: string; target: StoredTarget }>();

function post(message: MainMessage): void { figma.ui.postMessage(message); }
function currentFileKey(): string | null {
  try { return figma.fileKey || fallbackFileKey; }
  catch { return fallbackFileKey; }
}
function targetKey(config: Connection, fileKey: string, nodeId: string): string {
  return `assetlib.target.v1:${JSON.stringify([config.origin, config.orgId, config.appId, fileKey, nodeId])}`;
}
// Sync targets remembered before the console moved hosts stay keyed by the legacy origin.
function targetKeys(config: Connection, fileKey: string, nodeId: string): string[] {
  const keys = [targetKey(config, fileKey, nodeId)];
  if (config.origin === PRODUCTION_ORIGIN) keys.push(targetKey({ ...config, origin: LEGACY_PRODUCTION_ORIGIN }, fileKey, nodeId));
  return keys;
}
function selectedNode(): SceneNode | null {
  return figma.currentPage.selection.length === 1 ? figma.currentPage.selection[0] ?? null : null;
}
function describeNode(node: SceneNode): NodeSelection {
  return { id: node.id, name: node.name, width: node.width, height: node.height, type: node.type };
}
function isRemembered(value: unknown, fileKey: string, nodeId: string): value is StoredTarget {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<StoredTarget>;
  return item.fileKey === fileKey && item.nodeId === nodeId && typeof item.placementKey === 'string'
    && (item.state === null || typeof item.state === 'string')
    && (item.appearance === null || item.appearance === 'light' || item.appearance === 'dark')
    && (item.arm === null || typeof item.arm === 'string');
}
async function reportSelection(): Promise<void> {
  const revision = ++selectionRevision;
  // Client storage can resolve after a different app or token has been saved.
  const generation = connectionGeneration;
  const config = connection;
  const node = selectedNode();
  const fileKey = currentFileKey();
  let reason: string | null = null;
  let remembered: RememberedTarget | null = null;
  if (!node) reason = figma.currentPage.selection.length === 0 ? 'Select one node to send its artwork.' : 'Select just one node. Multiple selections cannot be sent together.';
  else if (node.width <= 0 || node.height <= 0) reason = 'This node has no exportable area. Select a node with a positive width and height.';
  if (node && fileKey && config) {
    try {
      for (const key of targetKeys(config, fileKey, node.id)) {
        const value: unknown = await figma.clientStorage.getAsync(key);
        if (isRemembered(value, fileKey, node.id)) { remembered = { ...value, insertedFrom: null }; break; }
      }
    } catch { /* A storage read failure must not prevent a new send. */ }
  }
  if (!remembered && node && config) {
    // An inserted frame names its cell in pluginData. A copy keeps the data but not the node id, so it is ignored.
    let raw = '';
    try { raw = node.getPluginData(LINK_KEY); } catch { raw = ''; }
    const link = parseStoredLink(raw);
    if (link && linkMatches(link, config, node.id)) remembered = { fileKey, nodeId: node.id, placementKey: link.placementKey,
      state: link.state, appearance: link.appearance, arm: link.arm, insertedFrom: { environment: link.environment, assetId: link.assetId } };
  }
  if (revision !== selectionRevision || generation !== connectionGeneration) return;
  post({ type: 'selection', connectionGeneration: generation, selection: { node: node ? describeNode(node) : null, reason, fileKey, remembered } });
}

const initialized = (async () => {
  let stored: unknown;
  try {
    stored = await figma.clientStorage.getAsync(CONNECTION_KEY);
    if (stored) connection = loadSavedConnection(stored);
  } catch { connection = null; }
  if (connection && connection.origin !== (stored as Connection).origin) {
    // Persist the moved origin; if this fails, the same move repeats on the next load.
    try { await figma.clientStorage.setAsync(CONNECTION_KEY, connection); } catch { /* keep the loaded connection */ }
  }
  try {
    const stored: unknown = await figma.clientStorage.getAsync(FILE_URL_KEY);
    if (typeof stored === 'string') { parseFileKey(stored); savedFileUrl = stored; }
  } catch { savedFileUrl = ''; }
  try { preferences = parsePreferences(await figma.clientStorage.getAsync(PREFERENCES_KEY)); }
  catch { preferences = defaultPreferences(); }
})();

async function handleMessage(message: UiMessage): Promise<void> {
  await initialized;
  switch (message.type) {
    case 'init':
      post({ type: 'connection', connectionGeneration, connection, savedFileUrl, preferences });
      await reportSelection();
      break;
    case 'save-connection': {
      const next = validateConnection(message.connection);
      try { await figma.clientStorage.setAsync(CONNECTION_KEY, next); }
      catch { throw new Error('Could not save the connection in Figma. Please try again.'); }
      connection = next;
      connectionGeneration += 1;
      post({ type: 'connection', connectionGeneration, connection, savedFileUrl, preferences });
      await reportSelection();
      break;
    }
    case 'save-file-url': {
      const fileKey = parseFileKey(message.url);
      try { await figma.clientStorage.setAsync(FILE_URL_KEY, message.url); }
      catch { throw new Error('Could not save the file URL in Figma. Please try again.'); }
      fallbackFileKey = fileKey;
      savedFileUrl = message.url;
      post({ type: 'file-saved', fileKey });
      await reportSelection();
      break;
    }
    case 'export': {
      if (exporting || importing) throw new Error('An export is already in progress.');
      if (!connection) throw new Error('Save and test your connection first.');
      const node = selectedNode();
      const fileKey = currentFileKey();
      if (!node || node.id !== message.node.id || fileKey !== message.fileKey) throw new Error('The selection or file changed. Review the selection and send again.');
      if (node.width !== message.node.width || node.height !== message.node.height || node.name !== message.node.name) {
        await reportSelection();
        throw new Error('The artwork changed. Review its updated dimensions and aspect ratio before sending again.');
      }
      const placement = parsePlacements({ placements: [message.placement] })[0]!;
      const bind = validateBinding(placement, message.bind);
      const snapshot = describeNode(node);
      const settings = chooseExportSettings(snapshot, placement);
      exporting = true;
      let bytes: Uint8Array;
      try { bytes = await node.exportAsync(settings); }
      catch { throw new Error('Figma could not export this node as PNG. Check the node and try again.'); }
      finally { exporting = false; }
      if (node.removed || node.width !== snapshot.width || node.height !== snapshot.height || node.name !== snapshot.name) {
        await reportSelection();
        throw new Error('The artwork changed during export. Review the selection and send again.');
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('The export is too large (over 4 MiB). Try a placement with a smaller export constraint.');
      exported.clear();
      exported.set(message.requestId, {
        storageKey: targetKey(connection, fileKey, snapshot.id),
        target: { fileKey, nodeId: snapshot.id, placementKey: bind.slotKey, state: bind.state, appearance: bind.appearance, arm: bind.arm },
      });
      post({ type: 'exported', requestId: message.requestId, node: snapshot, fileKey, settings, bytes });
      break;
    }
    case 'remember': {
      const pending = exported.get(message.requestId);
      if (!pending) throw new Error('The draft was sent, but its sync target is no longer available.');
      try { await figma.clientStorage.setAsync(pending.storageKey, pending.target); }
      catch { throw new Error('The draft was sent, but Figma could not save its sync target. Send again to remember it.'); }
      exported.delete(message.requestId);
      post({ type: 'remembered', requestId: message.requestId });
      await reportSelection();
      break;
    }
    case 'save-preferences': {
      // A convenience only: nothing is posted, and a storage failure is ignored.
      preferences = parsePreferences(message.preferences);
      try { await figma.clientStorage.setAsync(PREFERENCES_KEY, preferences); } catch { /* keep the in-memory value */ }
      break;
    }
    case 'insert': {
      if (importing || exporting) throw new Error('An image is already being inserted or exported.');
      if (!connection || message.connectionGeneration !== connectionGeneration) throw new Error('The connection changed. Choose the image again.');
      const { bytes, frame, scale } = message;
      if (!isUint8Array(bytes) || bytes.byteLength === 0 || bytes.byteLength > MAX_INSERT_BYTES) throw new Error('The console returned an image Figma cannot use. Refresh and try again.');
      const size = pngSize(bytes);
      if (!size || size.width > MAX_INSERT_PIXELS || size.height > MAX_INSERT_PIXELS) throw new Error('The console returned an image Figma cannot use. Refresh and try again.');
      if (![1, 2, 3].includes(scale) || !frame || typeof frame !== 'object' || !Number.isInteger(frame.width) || !Number.isInteger(frame.height)
        || frame.width < 1 || frame.height < 1 || frame.width > MAX_INSERT_PIXELS || frame.height > MAX_INSERT_PIXELS) throw new Error('Choose a valid size.');
      const link = message.link ? validateInsertLink(message.link) : null;
      const name = sanitizeName(message.name);
      importing = true;
      try {
        let image: Image;
        try { image = figma.createImage(bytes); } catch { throw new Error('Figma could not read this image. Refresh and try again.'); }
        const width = Math.round((frame.width / scale) * 100) / 100;
        const height = Math.round((frame.height / scale) * 100) / 100;
        // A frame, not a rectangle: designers can add layers inside without changing the node id.
        const node = figma.createFrame();
        node.name = name;
        node.resize(width, height);
        node.fills = [{ type: 'IMAGE', imageHash: image.hash, scaleMode: 'FILL' }];
        node.clipsContent = true;
        const center = figma.viewport.center;
        node.x = Math.round(center.x - width / 2);
        node.y = Math.round(center.y - height / 2);
        if (link) {
          const stored: StoredLink = { v: 1, origin: connection.origin, orgId: connection.orgId, appId: connection.appId,
            ...link, nodeId: node.id, insertedAt: new Date().toISOString() };
          node.setPluginData(LINK_KEY, JSON.stringify(stored));
        }
        // Select only after the link is written, so the selection report finds it.
        figma.currentPage.selection = [node];
        const bounds = figma.viewport.bounds;
        if (node.x < bounds.x || node.y < bounds.y || node.x + width > bounds.x + bounds.width || node.y + height > bounds.y + bounds.height) {
          figma.viewport.scrollAndZoomIntoView([node]);
        }
        figma.notify(link ? `Inserted ${name} from ${environmentLabel(link.environment)}` : `Inserted ${name}`);
        post({ type: 'inserted', requestId: message.requestId, connectionGeneration, node: describeNode(node), linked: Boolean(link) });
      } finally { importing = false; }
      // selectionchange is asynchronous and coalesced; report the new selection now.
      await reportSelection();
      break;
    }
  }
}

figma.showUI(__html__, { width: 420, height: 720, themeColors: true });
figma.ui.onmessage = (message: UiMessage) => {
  if (!message || typeof message !== 'object' || typeof message.type !== 'string') return;
  void handleMessage(message).catch((error: unknown) => {
    post({ type: 'error', message: error instanceof Error ? error.message : 'The plugin could not complete that action.', ...('requestId' in message ? { requestId: message.requestId } : {}) });
  });
};
figma.on('selectionchange', () => { void initialized.then(reportSelection); });
figma.on('currentpagechange', () => { void initialized.then(reportSelection); });
