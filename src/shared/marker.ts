// The description and documentation link on a component inserted from a placement. Figma's MCP server passes both to
// coding agents as instructions to follow, so an agent building the screen uses the placement instead of exporting
// the art as a static file. Anyone with the file can read them: they never hold the token. The key is the only text
// from the console, so it must match the catalog's key grammar; anything else gets no marker, so a console response
// can never put its own words into instructions an agent follows.
import { LEGACY_PRODUCTION_ORIGIN, PRODUCTION_ORIGIN, normalizeConsoleOrigin } from './connection.js';
import type { Connection } from './types.js';
import { validPlacementKey } from './validation.js';

const ID = /^[A-Za-z0-9_-]{1,128}$/;

export interface PlacementMarker {
  description: string;
  /** The app's placements page in the console, or null when the connection does not name a valid one. */
  documentationUrl: string | null;
}

/** True for a component description `placementMarker` wrote, which a fill or replace may rewrite; a designer's own is kept. */
export function isPlacementMarker(description: string): boolean {
  return typeof description === 'string' && description.startsWith('Assetlib placement ');
}

/** Null for a key outside the catalog's grammar or a size that is not two positive integers. */
export function placementMarker(connection: Pick<Connection, 'origin' | 'orgId' | 'appId'>, key: string,
  size: { width: number; height: number }): PlacementMarker | null {
  if (!validPlacementKey(key) || ![size.width, size.height].every(value => Number.isSafeInteger(value) && value > 0)) return null;
  const description = `Assetlib placement ${key} (${size.width} × ${size.height}). This image can change after the app is released, `
    + 'so don’t export it as a static file. '
    + `In code, use the accessor generated for ${key} from assetlib.catalog.json, which carries the bundled fallback. `
    + `If ${key} isn’t in the catalog, add it there with a fallback image in the same change.`;
  let documentationUrl: string | null = null;
  try {
    const origin = normalizeConsoleOrigin(connection.origin === LEGACY_PRODUCTION_ORIGIN ? PRODUCTION_ORIGIN : connection.origin);
    if (ID.test(connection.orgId) && ID.test(connection.appId)) documentationUrl = `${origin}/w/${connection.orgId}/${connection.appId}/placements`;
  } catch { /* no link for an origin the plugin cannot connect to */ }
  return { description, documentationUrl };
}
