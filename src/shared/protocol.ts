import type { CellBinding, Connection, EnvironmentName, ExportSettings, InsertLink, NodeSelection, Placement, Preferences } from './index.js';
import { isRecord } from './validation.js';

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

export type SelectionState = {
  node: NodeSelection | null;
  reason: string | null;
  fileKey: string | null;
  remembered: RememberedTarget | null;
};

// Every message that main can refuse carries a requestId, and main's error names it, so an error ends only that operation.
export type UiMessage =
  | { type: 'init' }
  | { type: 'save-connection'; requestId: number; connection: Connection }
  | { type: 'save-file-url'; requestId: number; url: string }
  | { type: 'export'; requestId: number; node: NodeSelection; fileKey: string; placement: Placement; bind: CellBinding; rebind: boolean }
  | { type: 'remember'; requestId: number }
  | { type: 'insert'; requestId: number; connectionGeneration: number; bytes: Uint8Array; name: string;
    frame: { width: number; height: number }; scale: 1 | 2 | 3; link: InsertLink | null }
  | { type: 'save-preferences'; preferences: Preferences }
  // Keeps the node's width and sets its height to the placement's ratio (width and height are the placement's).
  | { type: 'match-ratio'; requestId: number; nodeId: string; width: number; height: number }
  // Forgets the saved connection on this device (Disconnect). The token itself keeps working until an owner revokes it.
  | { type: 'clear-connection'; requestId: number }
  // A Figma toast for a finished operation. Main shortens the text to 100 characters and opens only a console link
  // for the connected app from the button.
  | { type: 'notify'; text: string; button?: NotifyButton };

export type NotifyButton = { text: string; url: string };

export type MainMessage =
  | { type: 'connection'; connectionGeneration: number; connection: Connection | null; savedFileUrl: string; preferences: Preferences }
  | { type: 'selection'; connectionGeneration: number; selection: SelectionState }
  | { type: 'file-saved'; requestId: number; fileKey: string }
  | { type: 'exported'; requestId: number; node: NodeSelection; fileKey: string; settings: ExportSettings; bytes: Uint8Array }
  | { type: 'remembered'; requestId: number }
  | { type: 'inserted'; requestId: number; connectionGeneration: number; node: NodeSelection; linked: boolean }
  | { type: 'error'; message: string; requestId?: number };

// Main's toast after Disconnect; the UI announces the same words.
export const DISCONNECTED = 'Disconnected. The token still works elsewhere until an owner revokes it.';

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
      case 'save-connection': return requestId(m.requestId) && isRecord(m.connection)
        && text(m.connection.origin) && text(m.connection.orgId) && text(m.connection.appId) && text(m.connection.token);
      case 'save-file-url': return requestId(m.requestId) && text(m.url);
      case 'export': return requestId(m.requestId) && isRecord(m.node) && text(m.node.id) && text(m.node.name) && text(m.node.type)
        && size(m.node.width) && size(m.node.height) && text(m.fileKey) && isRecord(m.placement) && isRecord(m.bind) && typeof m.rebind === 'boolean';
      case 'remember': return requestId(m.requestId);
      // The bytes, frame, and scale have their own messages in main.
      case 'insert': return requestId(m.requestId) && typeof m.connectionGeneration === 'number' && Number.isSafeInteger(m.connectionGeneration)
        && text(m.name) && (m.link === null || isRecord(m.link));
      case 'save-preferences': return 'preferences' in m;
      case 'match-ratio': return requestId(m.requestId) && text(m.nodeId) && size(m.width) && size(m.height);
      case 'clear-connection': return requestId(m.requestId);
      case 'notify': return text(m.text) && (m.button === undefined || (isRecord(m.button) && text(m.button.text) && text(m.button.url)));
      default: return false;
    }
  })();
  if (!ok) throw new Error(UNREADABLE_MESSAGE);
  return value as UiMessage;
}
