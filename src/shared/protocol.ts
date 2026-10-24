import type {
  CanvasTarget, CellBinding, Connection, EnvironmentName, ExportSettings, InsertLink, InsertMode, NodeSelection, PairingHint, PairingRecord, Placement,
  Preferences,
} from './index.js';
import { isRecord, validArm, validFileKey, validNodeId, validPlacementKey, validState, validUuid } from './validation.js';

/**
 * Where an insert goes: a new frame (centered in the view, or right of the selection), a child of the container
 * selected, or the selected layers filled (a fill of one linked layer replaces its image). Main checks that `into` and
 * `fill` still name the selection.
 */
export type InsertDestination = { kind: 'new' } | { kind: 'into'; nodeId: string } | { kind: 'fill'; nodeIds: string[] };

export type RememberedTarget = {
  // null when a pluginData link names the cell but no file key is known yet.
  fileKey: string | null;
  nodeId: string;
  placementKey: string;
  state: CellBinding['state'];
  appearance: CellBinding['appearance'];
  arm: CellBinding['arm'];
  // Set only for a target derived from an inserted frame's link; null for client storage targets.
  insertedFrom: { environment: EnvironmentName; assetId: string } | null;
};

/**
 * The selected layer's own link (pluginData `assetlib.link.v1`), as main read it: `linked`, written on this layer for the
 * connected app; `copy`, written for this app on another layer (a Cmd+D copy keeps the data, not the node id); or `other`,
 * written for another console app, which also names that app (its origin, the legacy host as production, and IDs).
 */
export type SelectedLink = InsertLink & { kind: 'linked' | 'copy' | 'other'; image: boolean; children: number;
  origin?: string; orgId?: string; appId?: string };

export type FileLink = InsertLink & {
  nodeId: string; sourceNodeId: string; name: string; pageId: string; pageName: string; frameId: string | null; frameName: string | null;
  kind: 'linked' | 'copy'; image: boolean; children: number;
  /** An instance, which reads its main component's link and follows that main. */
  instance: boolean;
};
export type FileLinks = { type: 'file-links'; connectionGeneration: number; scope: 'page' | 'file'; pageCount: number;
  currentPageId: string; fileKey: string | null; fileName: string; entries: FileLink[]; truncated: boolean; complete: boolean; requestId?: number };

/**
 * Where `fileKey` came from: Figma itself (`figma`), the identity saved in this document (`document`), or a link pasted
 * this session that the document couldn't keep (`session`, a view-only file). `name` is the file name the identity was
 * saved with; empty for `figma`.
 */
export type FileState = { source: 'figma' | 'document' | 'session' | null; name: string };

export type SelectionState = {
  revision?: number;
  node: NodeSelection | null;
  reason: string | null;
  fileKey: string | null;
  remembered: RememberedTarget | null;
  // What Insert does with this selection, which labels its button.
  insertTarget: CanvasTarget;
  // One selected layer's link, or null (optional: a selection without them reads as null).
  link?: SelectedLink | null;
  file?: FileState;
  sendNodes?: SendNode[];
  selectionIds?: string[];
  truncated?: boolean;
  choice?: RememberedTarget | null;
};

export type SendNode = { node: NodeSelection; reason: string | null; remembered: RememberedTarget | null;
  link: SelectedLink | null; choice?: RememberedTarget | null };

export const MAX_SEND_NODES = 50;

// Every message that main can refuse carries a requestId, and main's error names it, so an error ends only that operation.
export type UiMessage =
  | { type: 'init' }
  | { type: 'preview-selection'; requestId: number; connectionGeneration: number; revision: number; nodeId: string; large?: boolean }
  | { type: 'scan-file'; requestId: number; allPages: boolean }
  | { type: 'select-node'; requestId: number; nodeId: string }
  | { type: 'save-connection'; requestId: number; connection: Connection }
  // `force`: Use anyway, after main said the link names another file (`file-mismatch`).
  | { type: 'save-file-url'; requestId: number; url: string; force?: boolean }
  | { type: 'export'; requestId: number; node: NodeSelection; fileKey: string; placement: Placement; bind: CellBinding; rebind: boolean;
    connectionGeneration?: number; selectionIds?: string[] }
  | { type: 'save-send-choice'; requestId: number; connectionGeneration: number; fileKey: string; nodeId: string;
    placementKey: string; state: CellBinding['state']; appearance: CellBinding['appearance']; arm: CellBinding['arm'] }
  // `assetId`: the image the draft put in the cell, which the layer's link then names; null when the draft wasn't bound.
  | { type: 'remember'; requestId: number; assetId?: string | null }
  // `drop` names a drop main answered with `dropped`: the target is then that drop's placeholder or image frame.
  // `update` keeps the linked cell and environment, only while the layer still shows the image `from` names.
  | { type: 'insert'; requestId: number; connectionGeneration: number; bytes: Uint8Array; name: string;
    frame: { width: number; height: number }; scale: 1 | 2 | 3; link: InsertLink | null; target: InsertDestination; drop?: number; update?: { from: string } }
  // A drop's image never came (its download failed, or the UI gave up waiting): main removes the placeholder it made
  // for it, and only that. Never refused.
  | { type: 'discard-placeholder'; nodeId: string }
  | { type: 'save-preferences'; preferences: Preferences }
  // Keeps the node's width and sets its height to the placement's ratio (width and height are the placement's).
  | { type: 'match-ratio'; requestId: number; nodeId: string; width: number; height: number }
  // Forgets the saved connection on this device (Disconnect). A pasted token keeps working until an owner revokes it; a
  // browser connection's token was ended first (`revoked`), unless the console couldn't be reached; also true for a refused pasted token.
  | { type: 'clear-connection'; requestId: number; revoked?: boolean }
  // One-click Connect: main opens the console's connect page for this write key, built from a fixed map (connectPageUrl).
  | { type: 'open-connect-page'; requestId: number; origin: string; writeKey: string }
  | { type: 'open-console-page'; requestId: number; connectionGeneration: number; url: string }
  // The request waiting for approval, kept so a reopened plugin resumes it (and this window keeps the turn to ask about
  // it), and forgotten once it ends, unless another window's request replaced it. Never refused.
  | { type: 'save-pairing'; pairing: PairingRecord }
  | { type: 'clear-pairing'; userCode: string }
  // The console said this request was claimed already (or Cancel, `once`: read once): main looks for the connection
  // another window saved from it. Always answered with `adopted`.
  | { type: 'adopt-connection'; requestId: number; userCode: string; once?: boolean }
  // Before a poll: whether this window may ask the console now (`interval`, the console's latest). Always answered with `turn`.
  | { type: 'claim-turn'; requestId: number; userCode: string; interval: number }
  // The console refused this window's browser connection: main adopts the connection saved on this device now, on the
  // same console, if another window replaced this one there. Always answered with `adopted`.
  | { type: 'reload-connection'; requestId: number; connectionGeneration: number }
  // A Figma toast for a finished operation. Main shortens the text to 100 characters and opens only a console link
  // for the connected app from the button.
  | { type: 'notify'; text: string; button?: NotifyButton }
  // The grip asks for a window size (at most one a frame); main clamps it (`clampWindow`) and resizes. Never refused.
  | { type: 'resize'; width: number; height: number }
  // A double-click on the grip: main resizes to the default for the canvas now (`defaultWindowSize`). Never refused.
  | { type: 'reset-size' }
  // The names GET /api/token gave the connection again (renamed, or saved before the console named apps). Main saves
  // them only for that connection and generation, and changes nothing else. Never refused.
  | { type: 'save-names'; connectionGeneration: number; orgId: string; appId: string; workspaceName: string | null; appName: string };

export type NotifyButton = { text: string; url: string };

export type MainMessage =
  | FileLinks
  // `pairing`: a Connect request waiting for approval (resumed by the UI); `hints`: workspaces linked on this page, while
  // there is no connection. `replaced`: after this window's save, the browser connection the device held before it,
  // which another window may have saved, so the UI ends its token too.
  | { type: 'connection'; connectionGeneration: number; connection: Connection | null; savedFileUrl: string; preferences: Preferences;
    pairing: PairingRecord | null; hints: PairingHint[]; replaced?: { origin: string; token: string } }
  // Whether a connection saved on this device by another window (from a claimed request, or replacing a refused one)
  // was found and is now this window's.
  | { type: 'adopted'; requestId: number; adopted: boolean }
  // Ask the console now (`poll`), not before `after` ms (`wait`: another window asked within the interval), or not at
  // all (`adopted`: another window saved the request's connection, which is this window's now).
  | { type: 'turn'; requestId: number; turn: 'poll' | 'wait' | 'adopted'; after: number }
  | { type: 'selection'; connectionGeneration: number; selection: SelectionState }
  | { type: 'selection-preview'; requestId: number; connectionGeneration: number; revision: number; nodeId: string; large?: boolean; bytes: Uint8Array | null }
  // `session`: the document couldn't keep the key (a view-only file), so it lasts until the plugin closes.
  | { type: 'file-saved'; requestId: number; fileKey: string; session: boolean }
  // The pasted link's file name (`slug`) isn't this file's (`name`); nothing was saved.
  | { type: 'file-mismatch'; requestId: number; slug: string; name: string }
  // The plugin was opened from a linked layer's Sync to Assetlib button in the properties panel.
  | { type: 'launch'; command: 'sync' | 'insert' | 'send' }
  | { type: 'exported'; requestId: number; node: NodeSelection; fileKey: string; settings: ExportSettings; bytes: Uint8Array }
  | { type: 'remembered'; requestId: number }
  | { type: 'send-choice-saved'; requestId: number }
  // `node` is the new frame, or the first layer filled; `notice` is main's toast, which the UI repeats in its status region.
  | { type: 'inserted'; requestId: number; connectionGeneration: number; node: NodeSelection; linked: boolean; mode: InsertMode; notice: string }
  // Main answered a drop: `nodeId` is the placeholder it made, or the image frame the drop landed on, which the UI fills.
  | { type: 'dropped'; dropId: number; nodeId: string; connectionGeneration: number }
  | { type: 'error'; message: string; requestId?: number };

/**
 * What a row or tile dragged onto the canvas carries in its `pluginDrop` (Figma passes it to main's drop handler as
 * `dropMetadata`). `dropId` is a request id, so main's error for the drop names it.
 */
export type DropMetadata = { assetlib: 1; dropId: number; connectionGeneration: number; name: string; frame: { width: number; height: number };
  scale: 1 | 2 | 3; link: InsertLink | null };

// Main's toasts after Disconnect; the UI announces the same words. A browser connection's token ends with it, so it has
// no Undo; one the console couldn't be told about is ended in the console.
export const DISCONNECTED = 'Disconnected. The token still works elsewhere until an owner revokes it.';
export const DISCONNECTED_REFUSED = 'Disconnected. Assetlib had stopped accepting that token.';
export const DISCONNECTED_BROWSER = 'Disconnected. This connection was ended.';
export const DISCONNECTED_LOCAL = 'Disconnected on this device. End the connection in the console under Settings › Profile.';

// One-click Connect (ui/connect.ts): how a request that didn't connect ended, and what to do next.
export const PAIRING_DENIED = 'The request was declined in the browser. Connect again to approve it, or choose another workspace.';
export const PAIRING_EXPIRED = 'The request expired before it was approved. Connect again for a new code.';
export const PAIRING_CANCELLED = 'The request was cancelled. Connect again when you’re ready.';
export const PAIRING_REUSED = 'This request was already used, so Assetlib stopped it. Connect again.';
export const OLDER_CONSOLE_CONNECT = 'This console can’t connect from Figma yet. Use a token instead.';
export const PAIRING_UNREACHABLE = 'Assetlib couldn’t be reached. Check your internet connection, then try again.';
export const PAIRING_BUSY = 'Too many connection requests. Wait a minute and try again.';
export const PAIRING_FAILED = 'Assetlib couldn’t finish connecting. Connect again.';
// A draft refused because another plugin window replaced this window's connection on the device: this window uses that one now.
export const CONNECTION_REPLACED = 'The connection changed in another plugin window, so nothing was sent. Try again.';
export const OPEN_PAGE_FAILED = 'Figma couldn’t open your browser. Choose Open browser again.';

/** A toast's text: at most 100 characters, the last one an ellipsis when it was longer. */
export function toastText(value: string): string {
  const characters = Array.from(value.replace(/\s+/g, ' ').trim());
  return characters.length <= 100 ? characters.join('') : `${characters.slice(0, 99).join('')}…`;
}

// Shown when the UI sends main a message it cannot read; the UI never should, so there is nothing to fix but a reopen.
export const UNREADABLE_MESSAGE = 'The plugin hit an unexpected problem. Close and reopen it, then try again.';

const requestId = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;
const text = (value: unknown): value is string => typeof value === 'string';
const size = (value: unknown): value is number => typeof value === 'number';
const generation = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
const selectionIds = (value: unknown): value is string[] => Array.isArray(value) && value.length > 0 && value.length <= MAX_SEND_NODES
  && value.every(validNodeId) && new Set(value).size === value.length;
const destination = (value: unknown): value is InsertDestination => isRecord(value) && (value.kind === 'new'
  || (value.kind === 'into' && text(value.nodeId))
  || (value.kind === 'fill' && Array.isArray(value.nodeIds) && value.nodeIds.length > 0 && value.nodeIds.every(text)));

/** The request id of a message from the UI, if it names a valid one, so main's error can name it too. */
export function messageRequestId(value: unknown): number | undefined {
  return isRecord(value) && requestId(value.requestId) ? value.requestId : undefined;
}

/**
 * Checks the shape of a message from the UI before main acts on it, so a malformed one gets a plain error instead of
 * a script error. Main still validates values (connections, placements, sizes, image bytes, links) with their own messages.
 */
export function parseUiMessage(value: unknown): UiMessage {
  if (!isRecord(value) || !text(value.type)) throw new Error(UNREADABLE_MESSAGE);
  const m = value;
  const ok = (() => {
    switch (m.type) {
      case 'init': return true;
      case 'preview-selection': return requestId(m.requestId) && generation(m.connectionGeneration) && generation(m.revision) && validNodeId(m.nodeId) && (m.large === undefined || typeof m.large === 'boolean');
      case 'save-connection': return requestId(m.requestId) && isRecord(m.connection)
        && text(m.connection.origin) && text(m.connection.orgId) && text(m.connection.appId) && text(m.connection.token);
      case 'scan-file': return requestId(m.requestId) && typeof m.allPages === 'boolean';
      case 'select-node': return requestId(m.requestId) && validNodeId(m.nodeId);
      case 'save-file-url': return requestId(m.requestId) && text(m.url) && (m.force === undefined || typeof m.force === 'boolean');
      case 'export': return requestId(m.requestId) && isRecord(m.node) && text(m.node.id) && text(m.node.name) && text(m.node.type)
        && size(m.node.width) && size(m.node.height) && text(m.fileKey) && isRecord(m.placement) && isRecord(m.bind) && typeof m.rebind === 'boolean'
        && (m.connectionGeneration === undefined || generation(m.connectionGeneration)) && (m.selectionIds === undefined || selectionIds(m.selectionIds));
      case 'save-send-choice': return requestId(m.requestId) && generation(m.connectionGeneration) && validFileKey(m.fileKey)
        && validNodeId(m.nodeId) && validPlacementKey(m.placementKey) && (m.state === null || validState(m.state))
        && (m.appearance === null || m.appearance === 'light' || m.appearance === 'dark') && (m.arm === null || validArm(m.arm));
      case 'remember': return requestId(m.requestId) && (m.assetId === undefined || m.assetId === null || text(m.assetId));
      // The bytes, frame, and scale have their own messages in main.
      case 'insert': return requestId(m.requestId) && typeof m.connectionGeneration === 'number' && Number.isSafeInteger(m.connectionGeneration)
        && text(m.name) && (m.link === null || isRecord(m.link)) && destination(m.target) && (m.drop === undefined || requestId(m.drop))
        && (m.update === undefined || (isRecord(m.update) && validUuid(m.update.from)));
      case 'discard-placeholder': return text(m.nodeId);
      case 'save-preferences': return 'preferences' in m;
      case 'match-ratio': return requestId(m.requestId) && text(m.nodeId) && size(m.width) && size(m.height);
      case 'clear-connection': return requestId(m.requestId) && (m.revoked === undefined || typeof m.revoked === 'boolean');
      case 'open-connect-page': return requestId(m.requestId) && text(m.origin) && text(m.writeKey);
      case 'open-console-page': return requestId(m.requestId) && generation(m.connectionGeneration) && text(m.url);
      // Main checks the record's values itself.
      case 'save-pairing': return isRecord(m.pairing);
      case 'clear-pairing': return text(m.userCode);
      case 'adopt-connection': return requestId(m.requestId) && text(m.userCode) && (m.once === undefined || typeof m.once === 'boolean');
      case 'claim-turn': return requestId(m.requestId) && text(m.userCode) && size(m.interval);
      case 'reload-connection': return requestId(m.requestId) && typeof m.connectionGeneration === 'number' && Number.isSafeInteger(m.connectionGeneration);
      case 'notify': return text(m.text) && (m.button === undefined || (isRecord(m.button) && text(m.button.text) && text(m.button.url)));
      case 'resize': return Number.isFinite(m.width) && Number.isFinite(m.height);
      case 'reset-size': return true;
      case 'save-names': return typeof m.connectionGeneration === 'number' && Number.isSafeInteger(m.connectionGeneration) && text(m.orgId)
        && text(m.appId) && (m.workspaceName === null || text(m.workspaceName)) && text(m.appName);
      default: return false;
    }
  })();
  if (!ok) throw new Error(UNREADABLE_MESSAGE);
  return value as UiMessage;
}

/** True for a drop that came from this plugin's UI; any other (a file from the desktop, say) is Figma's to handle. */
export function isAssetlibDrop(value: unknown): boolean {
  return isRecord(value) && value.assetlib === 1;
}

/** The drop's request id, if it names a valid one, so main's error for the drop can name it too. */
export function dropRequestId(value: unknown): number | undefined {
  return isRecord(value) && requestId(value.dropId) ? value.dropId : undefined;
}

/** Checks the shape of an Assetlib drop's metadata, as `parseUiMessage` does for messages; main checks the values. */
export function parseDropMetadata(value: unknown): DropMetadata {
  if (!isRecord(value) || value.assetlib !== 1 || !requestId(value.dropId) || typeof value.connectionGeneration !== 'number'
    || !Number.isSafeInteger(value.connectionGeneration) || !text(value.name) || !isRecord(value.frame) || !size(value.frame.width) || !size(value.frame.height)
    || !size(value.scale) || (value.link !== null && !isRecord(value.link))) throw new Error(UNREADABLE_MESSAGE);
  return value as DropMetadata;
}
