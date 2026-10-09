export type Appearance = 'light' | 'dark';

export interface Variants {
  appearance?: Appearance[];
  arm?: string[];
}

export interface Placement {
  key: string;
  screen: string;
  width: number;
  height: number;
  states: string[] | null;
  defaultState: string | null;
  variants: Variants | null;
  origin: 'console' | 'declared';
}

export interface CellBinding {
  slotKey: string;
  state: string | null;
  appearance: Appearance | null;
  arm: string | null;
}

export interface NodeSelection {
  id: string;
  name: string;
  width: number;
  height: number;
  type: string;
}

export interface ExportSettings {
  format: 'PNG';
  constraint: { type: 'WIDTH' | 'HEIGHT'; value: number };
}

export interface Connection {
  origin: string;
  orgId: string;
  appId: string;
  token: string;
}

export interface DraftBody {
  schemaVersion: 1;
  name: string;
  mime: 'image/png';
  imageBase64: string;
  source: {
    provider: 'figma';
    fileKey: string;
    nodeId: string;
    nodeName: string;
    versionId: null;
    export: ExportSettings;
  };
  bind: CellBinding;
  rebind: boolean;
}

export interface DraftResult {
  asset: { id: string; name: string; width: number; height: number; sha256: string; renditions: number };
  previous: { assetId: string; boundTo: CellBinding[] } | null;
  bound: CellBinding | null;
  bindError: string | null;
  rebound: CellBinding[];
}
