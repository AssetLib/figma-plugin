import type {
  Appearance, ArtworkCell, ArtworkResponse, AssetPage, CanvasTarget, CellArtwork, Connection, EnvironmentName, InsertLink,
  LibraryAsset, Placement, PlacementArtwork, Preferences, RenditionInfo, StoredLink,
} from './types.js';
import { LEGACY_PRODUCTION_ORIGIN, PRODUCTION_ORIGIN } from './connection.js';
import { ratioName } from './export.js';
import { parsePlacements } from './placements.js';
import { boundedString, isRecord, validArm, validNodeId, validPlacementKey, validSha256, validState, validUuid } from './validation.js';

// Below the hosted function response limit; renditions are at most 2048 px, which a transcoded PNG keeps.
export const MAX_INSERT_DOWNLOAD = 4 * 1024 * 1024;
// figma.createImage accepts at most 4096 px on each side.
export const MAX_INSERT_PIXELS = 4096;
export const MAX_ARTWORK_CELLS = 240;
// Previews are cached as base64 data: URLs, so a version larger than this is not previewed.
export const MAX_PREVIEW_BYTES = 512 * 1024;
export const ENVIRONMENTS: readonly EnvironmentName[] = ['draft', 'staging', 'production'];
export type CellCoordinate = Pick<ArtworkCell, 'state' | 'appearance' | 'arm'>;

const invalidArtwork = 'The console sent placement artwork the plugin can’t read. Refresh and try again.';
const mimes = ['image/webp', 'image/png', 'image/svg+xml'];
const appearanceValue = (value: unknown): value is Appearance => value === 'light' || value === 'dark';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function environmentLabel(environment: EnvironmentName): string {
  return environment === 'draft' ? 'Draft' : environment === 'staging' ? 'Staging' : 'Production';
}

/** An appearance as people read it: Any, Light, or Dark. */
export function appearanceLabel(appearance: Appearance | null): string {
  return appearance === 'light' ? 'Light' : appearance === 'dark' ? 'Dark' : 'Any';
}

/** A placement row's meta line: "3:4 · 2 states · light/dark · arm b", naming only what it declares. */
export function placementMeta(placement: Pick<Placement, 'width' | 'height' | 'states' | 'variants'>): string {
  const parts = [ratioName(placement.width, placement.height)];
  if (placement.states?.length) parts.push(`${placement.states.length} state${placement.states.length === 1 ? '' : 's'}`);
  const appearances = placement.variants?.appearance ?? [];
  if (appearances.length) parts.push(appearances.join('/'));
  const arms = placement.variants?.arm ?? [];
  if (arms.length) parts.push(`arm${arms.length === 1 ? '' : 's'} ${arms.join(', ')}`);
  return parts.join(' · ');
}

function parseRendition(value: unknown): RenditionInfo | null {
  if (!isRecord(value) || !validSha256(value.sha256) || typeof value.mime !== 'string' || !mimes.includes(value.mime)
    || !count(value.bytes) || !count(value.width) || !count(value.height)) return null;
  return { sha256: value.sha256, mime: value.mime as RenditionInfo['mime'], bytes: value.bytes, width: value.width, height: value.height };
}

/** One library image, or null when its shape is invalid. A rendition in an unknown shape or format is skipped. */
export function parseLibraryAsset(value: unknown): LibraryAsset | null {
  if (!isRecord(value) || !validUuid(value.id) || typeof value.name !== 'string' || value.name.length > 1000
    || !count(value.width) || !count(value.height) || !Array.isArray(value.renditions)
    || (value.processingIntent !== undefined && value.processingIntent !== null && value.processingIntent !== 'photo' && value.processingIntent !== 'artwork')) return null;
  return {
    id: value.id, name: value.name, width: value.width, height: value.height,
    processingIntent: (value.processingIntent ?? null) as LibraryAsset['processingIntent'],
    renditions: value.renditions.map(parseRendition).filter((item): item is RenditionInfo => item !== null),
  };
}

export function parseAssetPage(value: unknown): AssetPage {
  if (!isRecord(value) || !Array.isArray(value.assets) || (value.nextCursor !== null && !validUuid(value.nextCursor))) {
    throw new Error('The console sent an image list the plugin can’t read. Refresh and try again.');
  }
  return { assets: value.assets.map(parseLibraryAsset).filter((item): item is LibraryAsset => item !== null), nextCursor: value.nextCursor };
}

function parsePublished(value: unknown): ArtworkResponse['environments']['staging'] {
  if (value === null) return null;
  if (!isRecord(value) || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 0
    || !boundedString(value.createdAt, 64)) throw new Error(invalidArtwork);
  return { sequence: value.sequence, createdAt: value.createdAt };
}

function parseCellArtwork(value: unknown, cell: CellCoordinate): CellArtwork | null {
  if (value === null) return null;
  if (!isRecord(value) || !validUuid(value.assetId) || !isRecord(value.via)) throw new Error(invalidArtwork);
  const { arm, appearance } = value.via;
  // A cell resolves to its own family, its arm's Any, Control's appearance, or the base.
  if ((arm !== null && arm !== cell.arm) || (appearance !== null && appearance !== cell.appearance)) throw new Error(invalidArtwork);
  return { assetId: value.assetId, via: { arm: arm as string | null, appearance: appearance as Appearance | null } };
}

function parseCell(placement: Placement, value: unknown): ArtworkCell {
  if (!isRecord(value)) throw new Error(invalidArtwork);
  const { state, appearance, arm } = value;
  // Stateful placements list explicit states only; null is the default only for stateless ones.
  const stateOk = placement.states ? validState(state) && placement.states.includes(state) : state === null;
  const appearanceOk = appearance === null || (appearanceValue(appearance) && (placement.variants?.appearance ?? []).includes(appearance));
  const armOk = arm === null || (validArm(arm) && (placement.variants?.arm ?? []).includes(arm));
  if (!stateOk || !appearanceOk || !armOk) throw new Error(invalidArtwork);
  const cell = { state: state as string | null, appearance: appearance as Appearance | null, arm: arm as string | null };
  return { ...cell, draft: parseCellArtwork(value.draft, cell), staging: parseCellArtwork(value.staging, cell), production: parseCellArtwork(value.production, cell) };
}

/** Validates every placement contract and cell coordinate; an image with an invalid shape is dropped, not fatal. */
export function parseArtwork(value: unknown): ArtworkResponse {
  if (!isRecord(value) || !isRecord(value.environments) || !Array.isArray(value.placements) || !isRecord(value.assets)) throw new Error(invalidArtwork);
  const environments = { staging: parsePublished(value.environments.staging), production: parsePublished(value.environments.production) };
  const raw = value.placements as unknown[];
  const placements = parsePlacements({ placements: raw }).map((placement, index): PlacementArtwork => {
    const cells = (raw[index] as Record<string, unknown>).cells;
    if (!Array.isArray(cells) || cells.length > MAX_ARTWORK_CELLS) throw new Error(invalidArtwork);
    const seen = new Set<string>();
    return { ...placement, cells: cells.map(item => {
      const cell = parseCell(placement, item);
      const key = JSON.stringify([cell.state, cell.appearance, cell.arm]);
      if (seen.has(key)) throw new Error(invalidArtwork);
      seen.add(key);
      return cell;
    }) };
  });
  const assets: Record<string, LibraryAsset> = {};
  for (const [id, item] of Object.entries(value.assets)) {
    const asset = parseLibraryAsset(item);
    // Keys are validated uuids, so they can never name an Object.prototype member.
    if (asset && asset.id === id) assets[id] = asset;
  }
  return { environments, placements, assets };
}

/** The asset an artwork cell names, if the console returned it. */
export function artworkAsset(artwork: Pick<ArtworkResponse, 'assets'>, art: CellArtwork | null): LibraryAsset | null {
  return art && Object.prototype.hasOwnProperty.call(artwork.assets, art.assetId) ? artwork.assets[art.assetId]! : null;
}

/** A PNG or WebP Figma can take, within the download cap. */
function insertable(item: RenditionInfo): boolean {
  return (item.mime === 'image/png' || item.mime === 'image/webp') && item.bytes <= MAX_INSERT_DOWNLOAD
    && item.width <= MAX_INSERT_PIXELS && item.height <= MAX_INSERT_PIXELS;
}

/** The largest PNG or WebP Figma can take within the download cap; PNG wins ties. New frames use it. */
export function insertRendition(asset: Pick<LibraryAsset, 'renditions'>): RenditionInfo | null {
  let best: RenditionInfo | null = null;
  for (const item of asset.renditions) {
    if (!insertable(item)) continue;
    const area = item.width * item.height;
    const bestArea = best ? best.width * best.height : -1;
    if (area > bestArea || (area === bestArea && item.mime === 'image/png' && best?.mime !== 'image/png')) best = item;
  }
  return best;
}

/**
 * For a fill or a replace: the smallest PNG or WebP at least three times as wide as the image is drawn (PNG wins ties),
 * enough for a @3x screen without downloading more than the layer shows; never wider than the original; else the
 * largest (`insertRendition`). A fill covers its layer, so a layer proportionally taller than the art draws it wider
 * than the layer: `max(width, height × art width / art height)`.
 */
export function fillRendition(asset: Pick<LibraryAsset, 'renditions' | 'width' | 'height'>, targetWidth: number, targetHeight = 0): RenditionInfo | null {
  const positive = (value: number) => Number.isFinite(value) && value > 0 ? value : 0;
  const drawn = Math.max(positive(targetWidth), asset.height > 0 ? positive(targetHeight) * asset.width / asset.height : 0);
  const need = Math.min(3 * drawn, asset.width);
  let best: RenditionInfo | null = null;
  for (const item of asset.renditions) {
    if (!insertable(item) || item.width < need) continue;
    if (!best || item.width < best.width || (item.width === best.width && item.mime === 'image/png' && best.mime !== 'image/png')) best = item;
  }
  return best ?? insertRendition(asset);
}

/** One selected layer, as main describes it to `classifyInsertTarget`. */
export interface InsertCandidate {
  id: string;
  name: string;
  type: string;
  width: number;
  height: number;
  /** How many children it has; 0 for a layer that can't have any. */
  children: number;
  /** It carries an `assetlib.link.v1` for its own id in the connected app (read for a single layer only). */
  linked: boolean;
  /** It shows an image: at least one IMAGE paint is not hidden. */
  image: boolean;
  /** It is a component or sits inside a component, a component set, or an instance (read for a single layer only). */
  inComponent?: boolean;
  skipInstance?: boolean;
  placementMain?: { id: string; name: string; width: number; height: number; image: boolean; remote: boolean;
    link?: NonNullable<CanvasTarget['mainLink']> };
}

// Layers a fill paints: shapes, and frames, components, and instances without children (an inserted image, say).
const SHAPES = ['RECTANGLE', 'ELLIPSE', 'POLYGON', 'STAR', 'VECTOR', 'BOOLEAN_OPERATION'];
const FRAMES = ['FRAME', 'COMPONENT', 'INSTANCE'];

/** A layer inside an instance (its id joins ids with `;`): it can be filled, but takes no children and no plugin data. */
export function insideInstance(id: string): boolean { return id.includes(';'); }

function fillable(node: InsertCandidate): boolean {
  return SHAPES.includes(node.type) || (FRAMES.includes(node.type) && node.children === 0);
}

/**
 * What Insert does with the selection: a matching linked shape, frame, component, or instance showing an image is replaced; a frame or
 * component with children (never an instance or anything inside one, which Figma gives no new children) receives a
 * child, noting a container that is or sits in a component, where placement art can't go; shapes and empty frames are
 * filled, other layers skipped; with nothing to replace, fill, or insert into, a new frame.
 */
export function classifyInsertTarget(nodes: InsertCandidate[]): CanvasTarget {
  const named = (node: InsertCandidate) => node.name.trim() || 'this layer';
  if (nodes.length === 1) {
    const node = nodes[0]!;
    if (node.placementMain) {
      const main = node.placementMain;
      if (main.remote) return { mode: 'new', label: 'Insert', count: 0, nodeIds: [], beside: true, lockedMain: main.name };
      return { mode: main.image ? 'replace' : 'fill', label: main.image ? 'Replace in component' : 'Fill component',
        count: 1, nodeIds: [main.id], name: main.name, containerWidth: main.width, containerHeight: main.height,
        mainOf: { instanceId: node.id, instanceName: node.name }, ...(main.link ? { mainLink: main.link } : {}) };
    }
    // A linked layer whose image can be swapped. A sent text, group, or line carries a link too, but takes no image.
    if (!node.skipInstance && node.linked && node.image && (SHAPES.includes(node.type) || FRAMES.includes(node.type))) {
      return { mode: 'replace', label: 'Replace image', count: 1, nodeIds: [node.id], name: named(node), containerWidth: node.width, containerHeight: node.height };
    }
    if ((node.type === 'FRAME' || node.type === 'COMPONENT') && node.children > 0 && !insideInstance(node.id)) {
      return { mode: 'into', label: `Insert into ${named(node)}`, count: 1, nodeIds: [node.id], name: named(node), containerWidth: node.width, containerHeight: node.height,
        ...(node.inComponent ? { insideComponent: true as const } : {}) };
    }
  }
  const skippedInstances = nodes.filter(node => node.placementMain || node.skipInstance).length;
  const layers = nodes.filter(node => !node.placementMain && !node.skipInstance && fillable(node));
  const skipped = nodes.length - layers.length - skippedInstances;
  const skips = { ...(skippedInstances ? { skippedInstances } : {}), ...(skipped ? { skipped } : {}) };
  if (!layers.length) return { mode: 'new', label: 'Insert', count: 0, nodeIds: [], ...(skippedInstances ? { skippedInstances } : {}), ...(nodes.length ? { beside: true as const } : {}) };
  const one = layers.length === 1 ? layers[0]! : null;
  return { mode: 'fill', label: one ? `Fill ${named(one)}` : `Fill ${layers.length} layers`, count: layers.length, nodeIds: layers.map(node => node.id),
    ...(one ? { name: named(one) } : {}), ...skips, containerWidth: Math.max(...layers.map(node => node.width)), containerHeight: Math.max(...layers.map(node => node.height)) };
}

/** The smallest WebP by area, else the smallest PNG, within the preview byte cap. */
export function thumbnailRendition(asset: Pick<LibraryAsset, 'renditions'>): RenditionInfo | null {
  for (const mime of ['image/webp', 'image/png']) {
    const candidates = asset.renditions.filter(item => item.mime === mime && item.bytes <= MAX_PREVIEW_BYTES);
    if (candidates.length) return candidates.reduce((a, b) => b.width * b.height < a.width * a.height ? b : a);
  }
  return null;
}

/** An omitted state names the placement's default state, including in links written by Send. */
export function sameCoordinate(placement: Pick<Placement, 'defaultState'>, a: CellCoordinate, b: CellCoordinate): boolean {
  return (a.state ?? placement.defaultState) === (b.state ?? placement.defaultState) && a.appearance === b.appearance && a.arm === b.arm;
}

export function findCell(placement: Pick<PlacementArtwork, 'cells' | 'defaultState'>, coordinate: CellCoordinate): ArtworkCell | null {
  return placement.cells.find(cell => sameCoordinate(placement, cell, coordinate)) ?? null;
}

/** The linked cell's current art in its environment, when it differs from the layer's, inherited art included. */
export function changedArt(artwork: ArtworkResponse, link: InsertLink): CellArtwork | null {
  const placement = artwork.placements.find(item => item.key === link.placementKey);
  const art = placement ? findCell(placement, link)?.[link.environment] ?? null : null;
  return art && art.assetId !== link.assetId ? art : null;
}

/** The base cell: Control, Any, and the default state. */
export function baseCoordinate(placement: Pick<Placement, 'defaultState'>): CellCoordinate {
  return { state: placement.defaultState, appearance: null, arm: null };
}

function limit(value: string, maximum: number): string {
  return Array.from(value).slice(0, maximum).join('');
}

/** The key plus the cell's arm, appearance, and a non-default state, joined with ` · `. */
export function layerName(placement: Pick<Placement, 'key' | 'states' | 'defaultState'>, coordinate: CellCoordinate): string {
  const state = placement.states && coordinate.state !== placement.defaultState ? coordinate.state : null;
  return limit([placement.key, coordinate.arm, coordinate.appearance, state].filter(part => part !== null).join(' · '), 200);
}

/** A layer name Figma can show: control characters stripped, at most 200 characters. */
export function sanitizeName(value: unknown): string {
  const name = typeof value === 'string' ? limit(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim(), 200).trim() : '';
  return name || 'Assetlib image';
}

export function validateInsertLink(value: unknown): InsertLink {
  // The key reaches the layer's relaunch text, its name, and toasts, so it must be in the catalog's grammar, as the console's are.
  if (!isRecord(value) || !validPlacementKey(value.placementKey)
    || (value.state !== null && !validState(value.state))
    || (value.appearance !== null && !appearanceValue(value.appearance))
    || (value.arm !== null && !validArm(value.arm))
    || typeof value.environment !== 'string' || !ENVIRONMENTS.includes(value.environment as EnvironmentName)
    || !validUuid(value.assetId)) throw new Error('The inserted image’s placement link is invalid. Choose the image again.');
  return { placementKey: value.placementKey, state: value.state as string | null, appearance: value.appearance as Appearance | null,
    arm: value.arm as string | null, environment: value.environment as EnvironmentName, assetId: value.assetId };
}

/** Reads pluginData `assetlib.link.v1`. Never throws: an unreadable link is no link. */
export function parseStoredLink(raw: string): StoredLink | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.v !== 1 || typeof value.origin !== 'string'
      || typeof value.orgId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.orgId)
      || typeof value.appId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(value.appId)
      || !validNodeId(value.nodeId) || !boundedString(value.insertedAt, 64)) return null;
    return { ...validateInsertLink(value), v: 1, origin: value.origin, orgId: value.orgId, appId: value.appId, nodeId: value.nodeId, insertedAt: value.insertedAt };
  } catch { return null; }
}

/** A link written for this console app (the legacy host is production). */
export function linkInApp(link: StoredLink, connection: Pick<Connection, 'origin' | 'orgId' | 'appId'>): boolean {
  const origin = link.origin === LEGACY_PRODUCTION_ORIGIN ? PRODUCTION_ORIGIN : link.origin;
  return origin === connection.origin && link.orgId === connection.orgId && link.appId === connection.appId;
}

/** A link applies only to the node it was written on (not a Cmd+D copy) and to the same console app. */
export function linkMatches(link: StoredLink, connection: Pick<Connection, 'origin' | 'orgId' | 'appId'>, nodeId: string): boolean {
  return linkInApp(link, connection) && link.nodeId === nodeId;
}

/**
 * The description under a linked layer's **Sync to Assetlib** button in Figma's properties panel: its cell (the axes it
 * names) and where its art came from. Figma shows about three lines and refuses more than 1000 characters; a link's key,
 * state, and arm are short, so this stays well under.
 */
export function syncDescription(link: Pick<InsertLink, 'placementKey' | 'state' | 'appearance' | 'arm' | 'environment'>): string {
  const cell = [link.placementKey, link.state, link.appearance ? appearanceLabel(link.appearance) : null, link.arm].filter(part => part !== null).join(' · ');
  return `${cell}, from ${environmentLabel(link.environment)}. Sync sends edits to its draft.`;
}

/** The plugin opens on Insert: its library is the first thing people look for. */
export function defaultPreferences(): Preferences {
  return { tab: 'insert', browse: 'placements', environment: 'production', scale: 1 };
}

// The window sizes the grip can drag the plugin to; a saved size outside them is ignored.
export const WINDOW_LIMITS = { minWidth: 320, maxWidth: 900, minHeight: 480, maxHeight: 1000 } as const;

/** A size the grip asks for, in whole pixels within the limits. */
export function clampWindow(width: number, height: number): { width: number; height: number } {
  const clamp = (value: number, min: number, max: number) => Math.min(max, Math.max(min, Math.round(value)));
  return { width: clamp(width, WINDOW_LIMITS.minWidth, WINDOW_LIMITS.maxWidth), height: clamp(height, WINDOW_LIMITS.minHeight, WINDOW_LIMITS.maxHeight) };
}

/**
 * The window before the person sizes it: 420 wide, and the canvas's height on screen less 64 px, from 480 to 720, so it
 * fits a 13-inch laptop's canvas and never covers more of a large one than it did. An unknown canvas height gives 720.
 */
export function defaultWindowSize(canvasHeight: number): { width: number; height: number } {
  const height = Number.isFinite(canvasHeight) ? Math.round(canvasHeight) - 64 : 720;
  return { width: 420, height: Math.min(720, Math.max(WINDOW_LIMITS.minHeight, height)) };
}

/** Each invalid or missing field falls back to its default; the optional fields are left out unless valid. */
export function parsePreferences(value: unknown): Preferences {
  const result = defaultPreferences();
  if (!isRecord(value)) return result;
  if (value.tab === 'send' || value.tab === 'insert') result.tab = value.tab;
  if (value.browse === 'placements' || value.browse === 'images' || value.browse === 'file') result.browse = value.browse;
  if (typeof value.environment === 'string' && ENVIRONMENTS.includes(value.environment as EnvironmentName)) result.environment = value.environment as EnvironmentName;
  if (value.environmentChosen === true) result.environmentChosen = true;
  if (value.scale === 1 || value.scale === 2 || value.scale === 3) result.scale = value.scale;
  const size = value.window;
  if (isRecord(size) && Number.isInteger(size.width) && Number.isInteger(size.height)) {
    const width = size.width as number;
    const height = size.height as number;
    if (width >= WINDOW_LIMITS.minWidth && width <= WINDOW_LIMITS.maxWidth && height >= WINDOW_LIMITS.minHeight && height <= WINDOW_LIMITS.maxHeight) {
      result.window = { width, height };
    }
  }
  if (typeof value.hintSeen === 'boolean') result.hintSeen = value.hintSeen;
  if (typeof value.introSeen === 'boolean') result.introSeen = value.introSeen;
  return result;
}

/** Insert fits both container dimensions without enlarging the reference; a bare canvas uses Insert at. */
export function insertSize(frame: { width: number; height: number }, scale: number, container?: { width: number; height: number } | null): { width: number; height: number } {
  const s = container && container.width > 0 && container.height > 0
    ? Math.min(1, container.width / frame.width, container.height / frame.height) : 1 / scale;
  return { width: Math.round(frame.width * s * 100) / 100, height: Math.round(frame.height * s * 100) / 100 };
}
