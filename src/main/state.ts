// What the main thread's modules share: the connection, its generation, a Connect request, and the insert and export guards. The file key
// is identity.ts's.
import type { Connection, PairingRecord } from '../shared/index.js';
import type { MainMessage } from '../shared/protocol.js';

// pluginData on an inserted, filled, replaced, or sent layer: the cell its image came from, never the token.
export const LINK_KEY = 'assetlib.link.v1';
// A message named layers that are no longer the selection (Match ratio, Insert into, Fill, Replace).
export const SELECTION_MOVED = 'The selection changed. Check it and try again.';

export const main = {
  connection: null as Connection | null,
  connectionGeneration: 0,
  // A one-click Connect request waiting for approval (assetlib.pairing.v1), until it ends.
  pairing: null as PairingRecord | null,
  // Mutually exclusive: main refuses an insert during an export and an export during an insert.
  scanAllPages: figma.root.children.length === 1,
  exporting: false,
  importing: false,
};

export function post(message: MainMessage): void { figma.ui.postMessage(message); }
