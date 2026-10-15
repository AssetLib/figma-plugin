// The description and documentation link on a component inserted from a placement. Figma's MCP server passes both to
// coding agents as instructions to follow. Figma's design-to-code skill tells agents to download every image except
// data-supplied imagery and exact codebase matches, so the description claims both: an agent building the screen
// renders the placement through its accessor and downloads the art only as a new key's bundled fallback. Anyone with the file can read them: they never hold the token. The key is the only text
// from the console, so it must match the catalog's key grammar; anything else gets no marker, so a console response
// can never put its own words into instructions an agent follows.
import { LEGACY_PRODUCTION_ORIGIN, PRODUCTION_ORIGIN } from './connection.js';
import { consoleLink } from './links.js';
import type { Connection } from './types.js';
import { validPlacementKey } from './validation.js';

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
  const description = `Assetlib placement ${key} (${size.width} × ${size.height}). This image is data-supplied: it can change after the app is released. `
    + `Its exact codebase match is the accessor generated for ${key} from assetlib.catalog.json, which carries the bundled fallback, `
    + 'so render it with that accessor instead of a downloaded file. '
    + `If ${key} isn’t in the catalog, add it there in the same change and download this image as its bundled fallback.`;
  let documentationUrl: string | null = null;
  // No link for an origin the plugin can't connect to, or IDs consoleLink refuses (the same rules as before).
  try { documentationUrl = consoleLink({ origin: connection.origin === LEGACY_PRODUCTION_ORIGIN ? PRODUCTION_ORIGIN : connection.origin,
    orgId: connection.orgId, appId: connection.appId }, 'placements'); } catch { /* description only */ }
  return { description, documentationUrl };
}
