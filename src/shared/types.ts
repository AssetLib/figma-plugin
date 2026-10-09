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

export interface SourceExportSettings {
  format: 'PNG';
  constraint: { type: 'WIDTH' | 'HEIGHT'; value: number };
}

export interface ExportSettings extends SourceExportSettings {
  useAbsoluteBounds: true;
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
    export: SourceExportSettings;
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

export type EnvironmentName = 'draft' | 'staging' | 'production';

// The console also sends each rendition's url and an asset's source; the plugin ignores both
// and builds rendition URLs from validated ids instead.
export interface RenditionInfo {
  sha256: string;
  mime: 'image/webp' | 'image/png' | 'image/svg+xml';
  bytes: number;
  width: number;
  height: number;
}

export interface LibraryAsset {
  id: string;
  name: string;
  width: number;
  height: number;
  processingIntent: 'photo' | 'artwork' | null;
  renditions: RenditionInfo[];
}

export interface CellArtwork {
  assetId: string;
  via: { arm: string | null; appearance: Appearance | null };
}

export interface ArtworkCell {
  state: string | null;
  appearance: Appearance | null;
  arm: string | null;
  draft: CellArtwork | null;
  staging: CellArtwork | null;
  production: CellArtwork | null;
}

export interface PlacementArtwork extends Placement {
  cells: ArtworkCell[];
}

export interface ArtworkResponse {
  environments: Record<'staging' | 'production', { sequence: number; createdAt: string } | null>;
  placements: PlacementArtwork[];
  assets: Record<string, LibraryAsset>;
}

export interface AssetPage {
  assets: LibraryAsset[];
  nextCursor: string | null;
}

export interface InsertLink {
  placementKey: string;
  state: string | null;
  appearance: Appearance | null;
  arm: string | null;
  environment: EnvironmentName;
  assetId: string;
}

/** pluginData `assetlib.link.v1` on an inserted frame. It never holds the token. */
export interface StoredLink extends InsertLink {
  v: 1;
  origin: string;
  orgId: string;
  appId: string;
  nodeId: string;
  insertedAt: string;
}

export interface Preferences {
  tab: 'send' | 'insert';
  browse: 'placements' | 'images';
  environment: EnvironmentName;
  scale: 1 | 2 | 3;
}
