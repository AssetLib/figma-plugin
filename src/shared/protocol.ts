import type { CellBinding, Connection, ExportSettings, NodeSelection, Placement } from './index.js';

export type RememberedTarget = {
  fileKey: string;
  nodeId: string;
  placementKey: string;
  state: CellBinding['state'];
  appearance: CellBinding['appearance'];
  arm: CellBinding['arm'];
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
  | { type: 'remember'; requestId: number };

export type MainMessage =
  | { type: 'connection'; connectionGeneration: number; connection: Connection | null; savedFileUrl: string }
  | { type: 'selection'; connectionGeneration: number; selection: SelectionState }
  | { type: 'file-saved'; fileKey: string }
  | { type: 'exported'; requestId: number; node: NodeSelection; fileKey: string; settings: ExportSettings; bytes: Uint8Array }
  | { type: 'remembered'; requestId: number }
  | { type: 'error'; message: string; requestId?: number };
