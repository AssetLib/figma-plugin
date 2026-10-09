import {
  MAX_IMAGE_BYTES, chooseExportSettings, parseFileKey, parsePlacements,
  validateBinding, validateConnection,
} from './shared/index.js';
import type { Connection, NodeSelection } from './shared/index.js';
import type { MainMessage, RememberedTarget, UiMessage } from './shared/protocol.js';

const CONNECTION_KEY = 'assetlib.connection.v1';
const FILE_URL_KEY = 'assetlib.file-url.v1';
let connection: Connection | null = null;
let connectionGeneration = 0;
let savedFileUrl = '';
// Without the public file key, a saved URL must be confirmed for each run:
// node IDs and page IDs alone cannot identify a file across documents.
let fallbackFileKey: string | null = null;
let selectionRevision = 0;
let exporting = false;
const exported = new Map<number, { storageKey: string; target: RememberedTarget }>();

function post(message: MainMessage): void { figma.ui.postMessage(message); }
function currentFileKey(): string | null {
  try { return figma.fileKey || fallbackFileKey; }
  catch { return fallbackFileKey; }
}
function targetKey(config: Connection, fileKey: string, nodeId: string): string {
  return `assetlib.target.v1:${JSON.stringify([config.origin, config.orgId, config.appId, fileKey, nodeId])}`;
}
function selectedNode(): SceneNode | null {
  return figma.currentPage.selection.length === 1 ? figma.currentPage.selection[0] ?? null : null;
}
function describeNode(node: SceneNode): NodeSelection {
  return { id: node.id, name: node.name, width: node.width, height: node.height, type: node.type };
}
function isRemembered(value: unknown, fileKey: string, nodeId: string): value is RememberedTarget {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<RememberedTarget>;
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
      const value: unknown = await figma.clientStorage.getAsync(targetKey(config, fileKey, node.id));
      if (isRemembered(value, fileKey, node.id)) remembered = value;
    } catch { /* A storage read failure must not prevent a new send. */ }
  }
  if (revision !== selectionRevision || generation !== connectionGeneration) return;
  post({ type: 'selection', connectionGeneration: generation, selection: { node: node ? describeNode(node) : null, reason, fileKey, remembered } });
}

const initialized = (async () => {
  try {
    const stored: unknown = await figma.clientStorage.getAsync(CONNECTION_KEY);
    if (stored) connection = validateConnection(stored as Connection);
  } catch { connection = null; }
  try {
    const stored: unknown = await figma.clientStorage.getAsync(FILE_URL_KEY);
    if (typeof stored === 'string') { parseFileKey(stored); savedFileUrl = stored; }
  } catch { savedFileUrl = ''; }
})();

async function handleMessage(message: UiMessage): Promise<void> {
  await initialized;
  switch (message.type) {
    case 'init':
      post({ type: 'connection', connectionGeneration, connection, savedFileUrl });
      await reportSelection();
      break;
    case 'save-connection': {
      const next = validateConnection(message.connection);
      try { await figma.clientStorage.setAsync(CONNECTION_KEY, next); }
      catch { throw new Error('Could not save the connection in Figma. Please try again.'); }
      connection = next;
      connectionGeneration += 1;
      post({ type: 'connection', connectionGeneration, connection, savedFileUrl });
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
      if (exporting) throw new Error('An export is already in progress.');
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
