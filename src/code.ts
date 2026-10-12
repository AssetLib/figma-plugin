// The main thread in Figma's sandbox: routes the UI's messages, keeps the connection, exports for Send, and watches the
// selection. Selection reporting is in main/selection.ts, and Insert and drops on the canvas in main/insert.ts.
import {
  CONNECT_PAGE_REFUSED, DEVICE_STORAGE, MAX_IMAGE_BYTES, SELECTION_CHANGED, chooseExportSettings, clampWindow, connectPageUrl, defaultPreferences, defaultWindowSize,
  isConnectPageUrl, isConsoleLink, layerName, linkNamesFile, loadSavedConnection, mapHttpError, matchedHeight, parseFileLink, parsePlacements, parsePreferences,
  validateBinding, validateConnection, validateInsertLink,
} from './shared/index.js';
import type { Connection, InsertLink, Preferences } from './shared/index.js';
import { DISCONNECTED, DISCONNECTED_BROWSER, DISCONNECTED_LOCAL, messageRequestId, parseUiMessage, toastText } from './shared/protocol.js';
import type { UiMessage } from './shared/protocol.js';
import { currentFileKey, linkFile } from './main/identity.js';
import { discardDrops, discardPlaceholder, drop, dropPending, insert, renameRelinked, retireUndo, retireUndoOnEdit, writeMarker } from './main/insert.js';
import { clearPairing, loadPairing, pageHints, parsePairing, savePairing } from './main/pairing.js';
import { describeNode, nodeLink, reportSelection, selectedNode, storeTarget, writeLink } from './main/selection.js';
import type { StoredTarget } from './main/selection.js';
import { SELECTION_MOVED, main, post } from './main/state.js';

const CONNECTION_KEY = 'assetlib.connection.v1';
const FILE_URL_KEY = 'assetlib.file-url.v1';
const PREFERENCES_KEY = 'assetlib.preferences.v1';
let savedFileUrl = '';
let preferences: Preferences = defaultPreferences();
// An export waiting for its draft: the connection, the target to remember, the layer, and its placement's declared size.
// name: the layer name Insert gives the bound cell, which a layer still named for its old placement takes.
type Exported = { config: Connection; target: StoredTarget; node: SceneNode; frame: { width: number; height: number }; name: string };
const exported = new Map<number, Exported>();
// This window's own writes of the saved connection (a save, Disconnect, and Disconnect's Undo): how many started, and how
// many still run. A save-names that began before one, or runs beside one, writes nothing, so it never undoes it.
const writes = { started: 0, running: 0 };
async function writeConnection(write: () => Promise<void>): Promise<void> {
  writes.started += 1;
  writes.running += 1;
  try { await write(); } finally { writes.running -= 1; }
}

const initialized = (async () => {
  let stored: unknown;
  try {
    stored = await figma.clientStorage.getAsync(CONNECTION_KEY);
    if (stored) main.connection = loadSavedConnection(stored);
  } catch { main.connection = null; }
  if (main.connection && main.connection.origin !== (stored as Connection).origin) {
    // Persist the moved origin; if this fails, the same move repeats on the next load.
    try { await figma.clientStorage.setAsync(CONNECTION_KEY, main.connection); } catch { /* keep the loaded connection */ }
  }
  try {
    const stored: unknown = await figma.clientStorage.getAsync(FILE_URL_KEY);
    if (typeof stored === 'string') { parseFileLink(stored); savedFileUrl = stored; }
  } catch { savedFileUrl = ''; }
  try { preferences = parsePreferences(await figma.clientStorage.getAsync(PREFERENCES_KEY)); }
  catch { preferences = defaultPreferences(); }
  main.pairing = await loadPairing();
  // The connection saved from this request is here: the save finished, and the record outlived it.
  if (main.pairing && main.connection?.pairing === main.pairing.userCode) await clearPairing(main.pairing.userCode);
})();

/** The last file link pasted on this device, to fill in the field, only when its name matches this file's. */
function fileUrlForThisFile(): string {
  try { return savedFileUrl && linkNamesFile(parseFileLink(savedFileUrl).slug, figma.root.name) ? savedFileUrl : ''; } catch { return ''; }
}
function postConnection(): void {
  post({ type: 'connection', connectionGeneration: main.connectionGeneration, connection: main.connection, savedFileUrl: fileUrlForThisFile(), preferences,
    pairing: main.pairing, hints: main.connection ? [] : pageHints() });
}

/** The one way main opens a page in the browser: a console link (a toast's button) or the connect page, checked first. */
function openUrl(url: string): void {
  figma.openExternal(url);
}

/**
 * A sent layer names the cell its draft now shows, as inserted art does, so Sync finds it on every device and for every
 * teammate connected to the app, and it gets the Sync to Assetlib button; a component's marker names that placement too.
 * One undo step of its own. A layer Figma keeps no data on (inside an instance), or a draft that wasn't bound, stays as
 * it was; this device's target still applies.
 */
function linkSent(pending: Exported, assetId: string | null): void {
  if (assetId === null || pending.node.removed) return;
  const { placementKey, state, appearance, arm } = pending.target;
  let link: InsertLink;
  try { link = validateInsertLink({ placementKey, state, appearance, arm, environment: 'draft', assetId }); } catch { return; }
  // A fill's Undo would take back the link instead of the fill.
  retireUndo();
  const previous = nodeLink(pending.node, pending.config);
  if (!writeLink(pending.node, pending.config, link)) return;
  writeMarker(pending.node, pending.config, placementKey, pending.frame);
  renameRelinked(pending.node, previous, pending.name);
  commitOwnStep();
}

/** Ends a plugin edit as an undo step of its own, unless a drop's placeholder waits: that drop's insert commits both. */
function commitOwnStep(): void {
  if (!dropPending()) figma.commitUndo();
}

async function handleMessage(message: UiMessage): Promise<void> {
  await initialized;
  switch (message.type) {
    case 'init':
      // Opened from a linked layer's Sync to Assetlib button: the UI focuses the Sync bar. It never syncs by itself.
      if (figma.command === 'sync') post({ type: 'launch', command: 'sync' });
      postConnection();
      await reportSelection();
      break;
    case 'save-connection': {
      const next = validateConnection(message.connection);
      try { await writeConnection(() => figma.clientStorage.setAsync(CONNECTION_KEY, next)); }
      catch { throw new Error(DEVICE_STORAGE); }
      main.connection = next;
      main.connectionGeneration += 1;
      // A drop's image from the old connection won't come.
      discardDrops();
      postConnection();
      // Saved from a Connect request: the request is done. Forgotten after the connection is written, so a save cut
      // short between the two is recognised on the next load (initialized).
      if (next.pairing) await clearPairing(next.pairing);
      await reportSelection();
      break;
    }
    case 'save-file-url': {
      const { fileKey, slug } = parseFileLink(message.url);
      // A link to another file, or one that doesn't name its file, would trace this file's art to the wrong one: say so,
      // unless the person chose Use anyway.
      if (!message.force && !linkNamesFile(slug, figma.root.name)) {
        post({ type: 'file-mismatch', requestId: message.requestId, slug, name: figma.root.name });
        break;
      }
      // A fill's Undo would take back the file link instead of the fill.
      retireUndo();
      const where = linkFile(fileKey);
      // Saved in the document: an edit of its own, so a later plugin edit's undo step never takes it back.
      if (where === 'document') commitOwnStep();
      // This device's last link fills in the field for this file next time; the document holds the key itself.
      try { await figma.clientStorage.setAsync(FILE_URL_KEY, message.url); savedFileUrl = message.url; } catch { /* not needed to send */ }
      post({ type: 'file-saved', requestId: message.requestId, fileKey, session: where === 'session' });
      await reportSelection();
      break;
    }
    case 'export': {
      if (main.exporting || main.importing || dropPending()) throw new Error('An export is already in progress.');
      const config = main.connection;
      if (!config) throw new Error('Connect to Assetlib first.');
      const node = selectedNode();
      const fileKey = currentFileKey();
      if (!node || node.id !== message.node.id || fileKey !== message.fileKey) throw new Error(SELECTION_CHANGED);
      if (node.width !== message.node.width || node.height !== message.node.height || node.name !== message.node.name) {
        await reportSelection();
        throw new Error(SELECTION_CHANGED);
      }
      const placement = parsePlacements({ placements: [message.placement] })[0]!;
      const bind = validateBinding(placement, message.bind);
      const snapshot = describeNode(node);
      const settings = chooseExportSettings(snapshot, placement);
      main.exporting = true;
      let bytes: Uint8Array;
      try { bytes = await node.exportAsync(settings); }
      catch { throw new Error('Figma couldn’t export this layer. Try again, or flatten it first.'); }
      finally { main.exporting = false; }
      if (node.removed || node.width !== snapshot.width || node.height !== snapshot.height || node.name !== snapshot.name) {
        await reportSelection();
        throw new Error(SELECTION_CHANGED);
      }
      if (bytes.byteLength > MAX_IMAGE_BYTES) throw new Error(mapHttpError(413, null));
      exported.clear();
      exported.set(message.requestId, {
        config, node, frame: { width: placement.width, height: placement.height }, name: layerName(placement, bind),
        target: { fileKey, nodeId: snapshot.id, placementKey: bind.slotKey, state: bind.state, appearance: bind.appearance, arm: bind.arm },
      });
      post({ type: 'exported', requestId: message.requestId, node: snapshot, fileKey, settings, bytes });
      break;
    }
    case 'remember': {
      const pending = exported.get(message.requestId);
      if (!pending) throw new Error('The draft was sent, but its sync target is no longer available.');
      try { await storeTarget(pending.config, pending.target); }
      catch { throw new Error('The draft was sent, but Figma couldn’t save its sync target on your device. Send again to remember it.'); }
      exported.delete(message.requestId);
      linkSent(pending, message.assetId ?? null);
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
    case 'insert':
      await insert(message);
      break;
    case 'discard-placeholder':
      discardPlaceholder(message.nodeId);
      break;
    case 'clear-connection': {
      // Disconnect: this device forgets the token. A pasted token keeps working elsewhere until an owner revokes it in
      // the console; a browser connection's token was ended first (`revoked`), unless the console couldn't be reached.
      const previous = main.connection;
      try { await writeConnection(() => figma.clientStorage.deleteAsync(CONNECTION_KEY)); }
      catch { throw new Error(DEVICE_STORAGE); }
      main.connection = null;
      main.connectionGeneration += 1;
      discardDrops();
      postConnection();
      // A browser connection's token is ended, so there is nothing to put back. Only an owner can create another pasted
      // token, so that toast can put this one back while nothing else was saved.
      if (previous?.method === 'browser') figma.notify(message.revoked ? DISCONNECTED_BROWSER : DISCONNECTED_LOCAL);
      else figma.notify(DISCONNECTED, previous ? { timeout: 6000, button: { text: 'Undo', action: () => { void reconnect(previous); } } } : undefined);
      await reportSelection();
      break;
    }
    case 'open-connect-page': {
      // Only the console's connect page for one of the two origins, never a URL the UI built.
      const url = connectPageUrl(message.origin, message.writeKey);
      if (!isConnectPageUrl(url)) throw new Error(CONNECT_PAGE_REFUSED);
      openUrl(url);
      break;
    }
    case 'save-pairing': {
      const record = parsePairing(message.pairing);
      if (record) await savePairing(record);
      break;
    }
    case 'clear-pairing':
      await clearPairing(message.userCode);
      break;
    case 'adopt-connection':
      post({ type: 'adopted', requestId: message.requestId, adopted: await adopt(message.userCode) });
      break;
    case 'notify': {
      const { button } = message;
      // Only a link into the connected app's console; any other button is dropped, and the toast still shows.
      const action = button && isConsoleLink(button.url, main.connection) ? { text: toastText(button.text).slice(0, 24), action: () => { openUrl(button.url); } } : null;
      figma.notify(toastText(message.text), action ? { button: action } : undefined);
      break;
    }
    case 'resize': {
      const { width, height } = clampWindow(message.width, message.height);
      resizeWindow(width, height);
      break;
    }
    case 'reset-size': {
      const { width, height } = defaultWindow();
      resizeWindow(width, height);
      break;
    }
    case 'save-names': {
      // Only the names, and only for the connection the UI asked about; the generation stays, so nothing reloads.
      const config = main.connection;
      const started = writes.started;
      const current = () => writes.running === 0 && writes.started === started && main.connection === config
        && message.connectionGeneration === main.connectionGeneration;
      if (!config || !current() || message.orgId !== config.orgId || message.appId !== config.appId) break;
      const { origin, orgId, appId, token, workspaceName: _workspace, ...rest } = config;
      // Everything else about the connection (how it was made, who approved it) stays.
      const named = validateConnection({ ...rest, origin, orgId, appId, token, ...(message.workspaceName ? { workspaceName: message.workspaceName } : {}), appName: message.appName });
      // Client storage is shared by every window of the plugin: one in another file may have saved another connection,
      // or forgotten this one, since this one opened. Only this same connection is written over.
      let stored: Connection | null = null;
      try { const saved: unknown = await figma.clientStorage.getAsync(CONNECTION_KEY); stored = saved ? loadSavedConnection(saved) : null; } catch { stored = null; }
      if (!current()) break;
      main.connection = named;
      if (stored?.origin !== origin || stored.orgId !== orgId || stored.appId !== appId || stored.token !== token) break;
      // Unsaved, the names still show until the plugin closes.
      try { await figma.clientStorage.setAsync(CONNECTION_KEY, named); } catch { /* this session only */ }
      break;
    }
    case 'match-ratio': {
      if (main.exporting || main.importing || dropPending()) throw new Error('Wait for the current export or insert to finish, then match the ratio.');
      const node = selectedNode();
      if (!node || node.id !== message.nodeId) throw new Error(SELECTION_MOVED);
      const placement = { width: message.width, height: message.height };
      if (![placement.width, placement.height].every(value => typeof value === 'number' && Number.isFinite(value) && value > 0)) throw new Error('Choose a valid placement.');
      if (!('resize' in node) || node.width <= 0) throw new Error('Figma can’t resize this layer. Resize it on the canvas, then send.');
      const width = node.width;
      const height = matchedHeight(width, placement);
      const sizing = 'layoutSizingVertical' in node ? node.layoutSizingVertical : null;
      // A fill's Undo would now take back the resize instead.
      retireUndo();
      try {
        // A hug or fill height would undo the resize; matching the ratio needs a fixed height.
        if ('layoutSizingVertical' in node && sizing !== 'FIXED') node.layoutSizingVertical = 'FIXED';
        node.resize(width, height);
      } catch {
        // Leave the layer as it was: put back the hug or fill height fixed for the resize.
        try { if ('layoutSizingVertical' in node && sizing && node.layoutSizingVertical !== sizing) node.layoutSizingVertical = sizing; } catch { /* already as it was, or gone */ }
        throw new Error('Figma couldn’t resize this layer. Resize it on the canvas, then send.');
      }
      // One undo step for the resize. Every other plugin edit commits its own, so nothing earlier joins it.
      figma.commitUndo();
      await reportSelection();
      break;
    }
  }
}

/**
 * A request this window polled was claimed already: by another window of the plugin (they share client storage), or by
 * this one before its answer was lost. The connection saved from it, found now or within 3 s, becomes this window's.
 */
async function adopt(userCode: string): Promise<boolean> {
  if (main.connection?.pairing === userCode) return true;
  for (const wait of [0, 1000, 2000]) {
    if (wait) await new Promise(resolve => setTimeout(resolve, wait));
    let stored: Connection | null = null;
    try { const saved: unknown = await figma.clientStorage.getAsync(CONNECTION_KEY); stored = saved ? loadSavedConnection(saved) : null; } catch { stored = null; }
    if (main.connection?.pairing === userCode) return true;
    if (stored?.pairing !== userCode) continue;
    main.connection = stored;
    main.connectionGeneration += 1;
    discardDrops();
    await clearPairing(userCode);
    postConnection();
    await reportSelection();
    return true;
  }
  return false;
}

/** Disconnect's Undo: the connection comes back, unless another was saved meanwhile. */
async function reconnect(previous: Connection): Promise<void> {
  await initialized;
  if (main.connection) return;
  try { await writeConnection(() => figma.clientStorage.setAsync(CONNECTION_KEY, previous)); }
  catch { figma.notify(DEVICE_STORAGE); return; }
  if (main.connection) return;
  main.connection = previous;
  main.connectionGeneration += 1;
  postConnection();
  await reportSelection();
}

/** The default window for the canvas as it is on screen now (its height in canvas units times the zoom). */
function defaultWindow(): { width: number; height: number } {
  let canvasHeight = Number.NaN;
  try { canvasHeight = figma.viewport.bounds.height * figma.viewport.zoom; } catch { /* the default's own height */ }
  return defaultWindowSize(canvasHeight);
}
function resizeWindow(width: number, height: number): void {
  // A convenience only: a size Figma refuses leaves the window as it is.
  try { figma.ui.resize(width, height); } catch { /* keep the current size */ }
}

// The window opens hidden, then shows at the size the person last dragged it to, or the default for this canvas, once
// the preferences are read; the UI loads meanwhile.
figma.showUI(__html__, { width: 420, height: 720, themeColors: true, visible: false });
const showWindow = () => {
  try {
    const { width, height } = preferences.window ?? defaultWindow();
    resizeWindow(width, height);
  } finally { figma.ui.show(); }
};
// Shown whatever happens: a window left hidden would look as if the plugin never opened.
void initialized.then(showWindow, showWindow);
figma.ui.onmessage = (value: unknown) => {
  // Anything but an object (a null pluginMessage, say) is not for this handler.
  if (!value || typeof value !== 'object') return;
  // The error names the request it ends, when the message named a valid one, so the UI ends only that operation.
  const requestId = messageRequestId(value);
  const fail = (error: unknown) => post({ type: 'error', message: error instanceof Error ? error.message : 'The plugin could not complete that action.',
    ...(requestId === undefined ? {} : { requestId }) });
  let message: UiMessage;
  try { message = parseUiMessage(value); } catch (error) { fail(error); return; }
  void handleMessage(message).catch(error => {
    fail(error);
    // The UI set its selection aside for the new connection; the old one stands, so it gets the selection again.
    if (message.type === 'save-connection') void reportSelection();
  });
};
// A row or tile dragged out of the panel arrives as a drop; any other drop (a file from the desktop) is Figma's.
// Figma's samples return nothing for a drop they leave alone; only false stops Figma's own handling.
figma.on('drop', drop as (event: DropEvent) => boolean);
// A placeholder whose image is still downloading would stay grey and named "· loading".
figma.on('close', discardDrops);
figma.on('selectionchange', () => {
  // A fill's Undo is for the layers it filled, while they are what the person is looking at.
  retireUndo();
  void initialized.then(reportSelection);
});

// A resize or rename on the canvas fires no selectionchange, so the selected node's changes are watched on its page,
// as are edits to the layers a fill's Undo would take back.
let nodeChangeTimer: ReturnType<typeof setTimeout> | null = null;
let watchedPage: PageNode | null = null;
function onNodeChange(event: NodeChangeEvent): void {
  retireUndoOnEdit(event);
  if (nodeChangeTimer !== null) return;
  const node = selectedNode();
  if (!node || !event.nodeChanges.some(change => change.type === 'PROPERTY_CHANGE' && change.id === node.id)) return;
  // A drag resizes many times a second; one report per 150 ms keeps the size current.
  nodeChangeTimer = setTimeout(() => { nodeChangeTimer = null; void initialized.then(reportSelection); }, 150);
}
function watchCurrentPage(): void {
  // A page that was just deleted may throw here; that must not stop the new page being watched.
  try { watchedPage?.off('nodechange', onNodeChange); } catch { /* its listener went with it */ }
  try {
    watchedPage = figma.currentPage;
    watchedPage.on('nodechange', onNodeChange);
  } catch { watchedPage = null; /* Sizes then refresh on the next selection change. */ }
}
watchCurrentPage();
figma.on('currentpagechange', () => {
  // The filled layers are out of sight, and edits on the new page aren't watched for the toast.
  retireUndo();
  watchCurrentPage();
  void initialized.then(reportSelection);
});
