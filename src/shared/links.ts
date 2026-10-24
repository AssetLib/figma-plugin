// Links into the Assetlib console. They open in the browser (a navigation, never a request with the token) and are
// built only from validated IDs on the connected console's page origin; main opens nothing else from a toast. The connect
// page, which one-click Connect opens, is built only from the same fixed map and a validated write key.
import { DEVELOPMENT_ORIGIN, PRODUCTION_ORIGIN, STAGING_ORIGIN, normalizeConsoleOrigin, validWriteKey } from './connection.js';
import type { Connection } from './types.js';
import { isRecord, validArm, validPlacementKey, validState, validUuid } from './validation.js';

export type ConsoleSection = 'overview' | 'placements' | 'images' | 'releases' | 'settings/connect';
const SECTIONS: readonly ConsoleSection[] = ['overview', 'placements', 'images', 'releases', 'settings/connect'];
const ID = /^[A-Za-z0-9_-]{1,128}$/;

// Each console's pages, by its origin. The development console signs people in on 127.0.0.1 only (its session routes
// refuse localhost), and a page is a navigation, not a request, so the manifest and every request stay on localhost.
const PAGE_ORIGINS: Record<string, string> = { [PRODUCTION_ORIGIN]: PRODUCTION_ORIGIN, [STAGING_ORIGIN]: STAGING_ORIGIN, [DEVELOPMENT_ORIGIN]: 'http://127.0.0.1:3100' };
/** The origin a console's pages open on; throws for any origin but the allowed consoles. */
export function consolePageOrigin(origin: string): string { return PAGE_ORIGINS[normalizeConsoleOrigin(origin)]!; }

/** `{page origin}/w/{orgId}/{appId}/{section}`, plus an image's or placement's uuid. Throws on anything else. */
export function consoleLink(connection: Pick<Connection, 'origin' | 'orgId' | 'appId'>, section: ConsoleSection, itemId?: string): string {
  const origin = consolePageOrigin(connection.origin);
  if (!ID.test(connection.orgId) || !ID.test(connection.appId) || !SECTIONS.includes(section)) throw new Error('This console link is not valid.');
  if (itemId !== undefined && ((section !== 'images' && section !== 'placements') || !validUuid(itemId))) throw new Error('This console link is not valid.');
  return `${origin}/w/${connection.orgId}/${connection.appId}/${section}${itemId ? `/${itemId.toLowerCase()}` : ''}`;
}

export type ReviewTarget = { key: string; state?: string; appearance?: 'light' | 'dark'; arm?: string };
/** Bounded navigation context only. It never grants authority or selects a publish scope. */
export function reviewTargets(value: unknown): ReviewTarget[] | null {
  if (!Array.isArray(value) || value.length < 1 || value.length > 50) return null;
  const targets: ReviewTarget[] = [], seen = new Set<string>();
  for (const item of value) {
    if (!isRecord(item) || Object.values(item).some(value => typeof value === 'string' && value !== value.trim()) || Object.keys(item).some(key => !['key', 'state', 'appearance', 'arm'].includes(key))
      || !validPlacementKey(item.key) || ('state' in item && !validState(item.state))
      || ('arm' in item && !validArm(item.arm)) || ('appearance' in item && item.appearance !== 'light' && item.appearance !== 'dark')) return null;
    const target: ReviewTarget = { key: item.key, ...(item.state ? { state: item.state as string } : {}),
      ...(item.appearance ? { appearance: item.appearance as 'light' | 'dark' } : {}), ...(item.arm ? { arm: item.arm as string } : {}) };
    const id = JSON.stringify(target);
    if (!seen.has(id)) { seen.add(id); targets.push(target); }
  }
  return targets;
}
export function consoleReviewLink(connection: Pick<Connection, 'origin' | 'orgId' | 'appId'>, value: unknown): string {
  const base = consoleLink(connection, 'releases');
  const targets = reviewTargets(value);
  const encoded = targets && encodeURIComponent(JSON.stringify(targets));
  return encoded && encoded.length <= 32768 ? `${base}#review=${encoded}` : base;
}

const CONNECT_PAGE = /^(https:\/\/console\.assetlib\.dev|https:\/\/assetlib-billing-staging\.vercel\.app|http:\/\/127\.0\.0\.1:3100)\/connect\/figma#alw_[A-Za-z0-9_-]{43}$/;
export const CONNECT_PAGE_REFUSED = 'The plugin can’t open that page.';

/** `{page}/connect/figma#{writeKey}` from a fixed map of the allowed console origins; throws on anything else. */
export function connectPageUrl(origin: unknown, writeKey: unknown): string {
  const page = typeof origin === 'string' && Object.prototype.hasOwnProperty.call(PAGE_ORIGINS, origin) ? PAGE_ORIGINS[origin] : undefined;
  if (!page || !validWriteKey(writeKey)) throw new Error(CONNECT_PAGE_REFUSED);
  return `${page}/connect/figma#${writeKey}`;
}

/** True only for a connect page URL connectPageUrl can build. */
export function isConnectPageUrl(url: unknown): url is string { return typeof url === 'string' && CONNECT_PAGE.test(url); }

/** True only for a link consoleLink could have built for this connection. */
export function isConsoleLink(url: unknown, connection: Pick<Connection, 'origin' | 'orgId' | 'appId'> | null): url is string {
  if (typeof url !== 'string' || !connection) return false;
  let prefix: string; try { prefix = `${consolePageOrigin(connection.origin)}/w/${connection.orgId}/${connection.appId}/`; } catch { return false; }
  if (!url.startsWith(prefix)) return false;
  if (url === `${prefix}settings/connect`) {
    try { return consoleLink(connection, 'settings/connect') === url; } catch { return false; }
  }
  const review = `${prefix}releases#review=`;
  if (url.startsWith(review)) {
    const encoded = url.slice(review.length);
    if (!encoded || encoded.length > 32768) return false;
    try { return consoleReviewLink(connection, JSON.parse(decodeURIComponent(encoded))) === url; } catch { return false; }
  }
  const [section, itemId, ...rest] = url.slice(prefix.length).split('/');
  if (rest.length || !SECTIONS.includes(section as ConsoleSection)) return false;
  try { return consoleLink(connection, section as ConsoleSection, itemId) === url; } catch { return false; }
}
