// Links into the Assetlib console. They open in the browser (a navigation, never a request with the token) and are
// built only from validated IDs on the connected console's origin; main opens nothing else from a toast.
import { normalizeConsoleOrigin } from './connection.js';
import type { Connection } from './types.js';
import { validUuid } from './validation.js';

export type ConsoleSection = 'overview' | 'placements' | 'images' | 'releases';
const SECTIONS: readonly ConsoleSection[] = ['overview', 'placements', 'images', 'releases'];
const ID = /^[A-Za-z0-9_-]{1,128}$/;

/** `{origin}/w/{orgId}/{appId}/{section}`, plus an image's uuid for `images`. Throws on anything else. */
export function consoleLink(connection: Pick<Connection, 'origin' | 'orgId' | 'appId'>, section: ConsoleSection, imageId?: string): string {
  const origin = normalizeConsoleOrigin(connection.origin);
  if (!ID.test(connection.orgId) || !ID.test(connection.appId) || !SECTIONS.includes(section)) throw new Error('This console link is not valid.');
  if (imageId !== undefined && (section !== 'images' || !validUuid(imageId))) throw new Error('This console link is not valid.');
  return `${origin}/w/${connection.orgId}/${connection.appId}/${section}${imageId ? `/${imageId.toLowerCase()}` : ''}`;
}

/** True only for a link consoleLink could have built for this connection. */
export function isConsoleLink(url: unknown, connection: Pick<Connection, 'origin' | 'orgId' | 'appId'> | null): url is string {
  if (typeof url !== 'string' || !connection) return false;
  const prefix = `${connection.origin}/w/${connection.orgId}/${connection.appId}/`;
  if (!url.startsWith(prefix)) return false;
  const [section, imageId, ...rest] = url.slice(prefix.length).split('/');
  if (rest.length || !SECTIONS.includes(section as ConsoleSection)) return false;
  try { return consoleLink(connection, section as ConsoleSection, imageId) === url; } catch { return false; }
}
