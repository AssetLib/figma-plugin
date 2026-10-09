import type { CellBinding, Connection, EnvironmentName, ExportSettings, InsertLink, NodeSelection, Placement, Preferences } from './index.js';

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

export type UiMessage =
  | { type: 'init' }
  | { type: 'save-connection'; connection: Connection }
  | { type: 'save-file-url'; url: string }
  | { type: 'export'; requestId: number; node: NodeSelection; fileKey: string; placement: Placement; bind: CellBinding; rebind: boolean }
  | { type: 'remember'; requestId: number }
  | { type: 'insert'; requestId: number; connectionGeneration: number; bytes: Uint8Array; name: string;
    frame: { width: number; height: number }; scale: 1 | 2 | 3; link: InsertLink | null }
  | { type: 'save-preferences'; preferences: Preferences };

export type MainMessage =
  | { type: 'connection'; connectionGeneration: number; connection: Connection | null; savedFileUrl: string; preferences: Preferences }
  | { type: 'selection'; connectionGeneration: number; selection: SelectionState }
  | { type: 'file-saved'; fileKey: string }
  | { type: 'exported'; requestId: number; node: NodeSelection; fileKey: string; settings: ExportSettings; bytes: Uint8Array }
  | { type: 'remembered'; requestId: number }
  | { type: 'inserted'; requestId: number; connectionGeneration: number; node: NodeSelection; linked: boolean }
  | { type: 'error'; message: string; requestId?: number };
