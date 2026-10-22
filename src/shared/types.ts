export type Appearance = 'light' | 'dark';

export interface Variants {
  appearance?: Appearance[];
  arm?: string[];
}

export interface Placement {
  key: string;
  slotId?: string;
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
  // Names from GET /api/token, kept to label the connection. Optional: older saves and the ID form have none.
  workspaceName?: string;
  appName?: string;
  // How it was made: 'browser', one-click Connect, whose draft-only token the console issued to this plugin; absent (or
  // 'token') for a pasted token. A browser connection also keeps who approved it and its request's code (8 letters).
  method?: 'browser' | 'token';
  connectedAs?: string;
  pairing?: string;
}

/**
 * A one-click Connect request waiting for approval, in client storage (`assetlib.pairing.v1`) so a reopened plugin
 * resumes it. Never the write key. `deadline` is local epoch ms; `interval` the seconds between polls (2 to 30).
 * `polledAt` (local epoch ms) and `polledBy` name the plugin window that last asked the console about it (main sets them).
 */
export interface PairingRecord { v: 1; origin: string; readKey: string; userCode: string; deadline: number; interval: number; polledAt?: number; polledBy?: string }

/** A workspace the console may preselect on its connect page: a linked layer's, on one of the two console origins. */
export interface PairingHint { origin: string; orgId: string; appId: string }

/** What GET /api/token says about the presented token. Names are null while the console can't read them for a token. */
export interface TokenIdentity {
  orgId: string;
  appId: string;
  workspaceName: string | null;
  appName: string | null;
  scopes: ('declare' | 'draft')[];
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
  expectedAssetId?: string | null;
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

/** What Insert does with the canvas selection: a new frame, a child of a container, a fill, or a linked layer's image replaced. */
export type InsertMode = 'new' | 'into' | 'fill' | 'replace';

/** The selection as Insert sees it; main classifies it on every selection report (`classifyInsertTarget`). */
export interface CanvasTarget {
  mode: InsertMode;
  /** The primary button's label: "Insert", "Insert into {name}", "Fill {name}", "Fill {n} layers", or "Replace image". */
  label: string;
  /** Layers filled, 1 for into and replace, 0 for new. */
  count: number;
  /** The container (into) or the layers to fill (fill, replace); empty for new. */
  nodeIds: string[];
  /** The container's or the one layer's name. */
  name?: string;
  /** Into: the container's width. Fill and replace: the widest layer's, which sizes the download. */
  containerWidth?: number;
  /** Fill and replace: the tallest layer's height, which sizes the download for art drawn wider than its layer. */
  containerHeight?: number;
  /**
   * Into: the container is a component or sits inside one (or a component set or an instance). Figma puts no component
   * there, so placement art, a component, goes beside it; a library image, a frame, still goes in.
   */
  insideComponent?: true;
  /** Selected layers skipped by a fill because they cannot show an image. */
  skipped?: number;
  skippedInstances?: number;
  mainOf?: { instanceId: string; instanceName: string };
  mainLink?: Pick<InsertLink, 'placementKey' | 'state' | 'appearance' | 'arm'>;
  lockedMain?: string;
  /** New layer beside a selection that cannot take the image. */
  beside?: true;
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
  browse: 'placements' | 'images' | 'file';
  environment: EnvironmentName;
  environmentChosen?: true;
  scale: 1 | 2 | 3;
  // Optional, absent until set: the window size the person dragged the grip to, and whether the insert hint and intro were dismissed.
  window?: { width: number; height: number };
  hintSeen?: boolean;
  introSeen?: boolean;
}
