// Links into the Assetlib console. They open in the browser (a navigation, never a request with the token) and are
// built only from validated IDs on the connected console's origin; main opens nothing else from a toast. The connect
// page, which one-click Connect opens, is built only from a fixed map and a validated write key.
import { DEVELOPMENT_ORIGIN, PRODUCTION_ORIGIN, normalizeConsoleOrigin, validWriteKey } from './connection.js';
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

// The console's /connect/figma page for each console origin. The development console signs people in on 127.0.0.1 only
// (its session routes refuse localhost), and the page is a navigation, not a request, so the manifest stays localhost.
const CONNECT_PAGES: Record<string, string> = { [PRODUCTION_ORIGIN]: 'https://console.assetlib.dev', [DEVELOPMENT_ORIGIN]: 'http://127.0.0.1:3100' };
const CONNECT_PAGE = /^(https:\/\/console\.assetlib\.dev|http:\/\/127\.0\.0\.1:3100)\/connect\/figma#alw_[A-Za-z0-9_-]{43}$/;
export const CONNECT_PAGE_REFUSED = 'The plugin can’t open that page.';

/** `{page}/connect/figma#{writeKey}` from a fixed map of the two console origins; throws on anything else. */
export function connectPageUrl(origin: unknown, writeKey: unknown): string {
  const page = typeof origin === 'string' && Object.prototype.hasOwnProperty.call(CONNECT_PAGES, origin) ? CONNECT_PAGES[origin] : undefined;
  if (!page || !validWriteKey(writeKey)) throw new Error(CONNECT_PAGE_REFUSED);
  return `${page}/connect/figma#${writeKey}`;
}

/** True only for a connect page URL connectPageUrl can build. */
export function isConnectPageUrl(url: unknown): url is string { return typeof url === 'string' && CONNECT_PAGE.test(url); }

/** True only for a link consoleLink could have built for this connection. */
export function isConsoleLink(url: unknown, connection: Pick<Connection, 'origin' | 'orgId' | 'appId'> | null): url is string {
  if (typeof url !== 'string' || !connection) return false;
  const prefix = `${connection.origin}/w/${connection.orgId}/${connection.appId}/`;
  if (!url.startsWith(prefix)) return false;
  const [section, imageId, ...rest] = url.slice(prefix.length).split('/');
  if (rest.length || !SECTIONS.includes(section as ConsoleSection)) return false;
  try { return consoleLink(connection, section as ConsoleSection, imageId) === url; } catch { return false; }
}
