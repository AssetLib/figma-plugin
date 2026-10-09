import type {
  Appearance, ArtworkCell, ArtworkResponse, AssetPage, CellArtwork, Connection, EnvironmentName, InsertLink,
  LibraryAsset, Placement, PlacementArtwork, Preferences, RenditionInfo, StoredLink,
} from './types.js';
import { LEGACY_PRODUCTION_ORIGIN, PRODUCTION_ORIGIN } from './connection.js';
import { parsePlacements } from './placements.js';
import { boundedString, isRecord, validArm, validNodeId, validSha256, validState, validUuid } from './validation.js';

// Below the hosted function response limit; renditions are at most 2048 px, which a transcoded PNG keeps.
export const MAX_INSERT_DOWNLOAD = 4 * 1024 * 1024;
// figma.createImage accepts at most 4096 px on each side.
export const MAX_INSERT_PIXELS = 4096;
export const MAX_ARTWORK_CELLS = 240;
// Previews are cached as base64 data: URLs, so a version larger than this is not previewed.
export const MAX_PREVIEW_BYTES = 512 * 1024;
export const ENVIRONMENTS: readonly EnvironmentName[] = ['draft', 'staging', 'production'];
export type CellCoordinate = Pick<ArtworkCell, 'state' | 'appearance' | 'arm'>;

const invalidArtwork = 'The console returned invalid placement artwork. Refresh, or update the console.';
const mimes = ['image/webp', 'image/png', 'image/svg+xml'];
const appearanceValue = (value: unknown): value is Appearance => value === 'light' || value === 'dark';
const count = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

export function environmentLabel(environment: EnvironmentName): string {
  return environment === 'draft' ? 'Draft' : environment === 'staging' ? 'Staging' : 'Production';
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
    throw new Error('The console returned an invalid image list. Refresh, or update the console.');
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

/** The largest PNG or WebP Figma can take within the download cap; PNG wins ties. */
export function insertRendition(asset: Pick<LibraryAsset, 'renditions'>): RenditionInfo | null {
  let best: RenditionInfo | null = null;
  for (const item of asset.renditions) {
    if ((item.mime !== 'image/png' && item.mime !== 'image/webp') || item.bytes > MAX_INSERT_DOWNLOAD
      || item.width > MAX_INSERT_PIXELS || item.height > MAX_INSERT_PIXELS) continue;
    const area = item.width * item.height;
    const bestArea = best ? best.width * best.height : -1;
    if (area > bestArea || (area === bestArea && item.mime === 'image/png' && best?.mime !== 'image/png')) best = item;
  }
  return best;
}

/** The smallest WebP by area, else the smallest PNG, within the preview byte cap. */
export function thumbnailRendition(asset: Pick<LibraryAsset, 'renditions'>): RenditionInfo | null {
  for (const mime of ['image/webp', 'image/png']) {
    const candidates = asset.renditions.filter(item => item.mime === mime && item.bytes <= MAX_PREVIEW_BYTES);
    if (candidates.length) return candidates.reduce((a, b) => b.width * b.height < a.width * a.height ? b : a);
  }
  return null;
}

export function findCell(placement: Pick<PlacementArtwork, 'cells'>, coordinate: CellCoordinate): ArtworkCell | null {
  return placement.cells.find(cell => cell.state === coordinate.state && cell.appearance === coordinate.appearance && cell.arm === coordinate.arm) ?? null;
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
  if (!isRecord(value) || !boundedString(value.placementKey, 120)
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

/** A link applies only to the node it was written on (not a Cmd+D copy) and to the same console app. */
export function linkMatches(link: StoredLink, connection: Pick<Connection, 'origin' | 'orgId' | 'appId'>, nodeId: string): boolean {
  const origin = link.origin === LEGACY_PRODUCTION_ORIGIN ? PRODUCTION_ORIGIN : link.origin;
  return origin === connection.origin && link.orgId === connection.orgId && link.appId === connection.appId && link.nodeId === nodeId;
}

export function defaultPreferences(): Preferences {
  return { tab: 'send', browse: 'placements', environment: 'draft', scale: 1 };
}

/** Each invalid or missing field falls back to its default. */
export function parsePreferences(value: unknown): Preferences {
  const result = defaultPreferences();
  if (!isRecord(value)) return result;
  if (value.tab === 'send' || value.tab === 'insert') result.tab = value.tab;
  if (value.browse === 'placements' || value.browse === 'images') result.browse = value.browse;
  if (typeof value.environment === 'string' && ENVIRONMENTS.includes(value.environment as EnvironmentName)) result.environment = value.environment as EnvironmentName;
  if (value.scale === 1 || value.scale === 2 || value.scale === 3) result.scale = value.scale;
  return result;
}
