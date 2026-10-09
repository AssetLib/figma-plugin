import type { Connection } from './types.js';
import { validFileKey, validSha256, validUuid } from './validation.js';

export const PRODUCTION_ORIGIN = 'https://console.assetlib.dev';
export const DEVELOPMENT_ORIGIN = 'http://localhost:3100';
// The console's earlier production host. It still accepts app tokens, so a
// connection saved with it moves to PRODUCTION_ORIGIN on load with the same token.
export const LEGACY_PRODUCTION_ORIGIN = 'https://assetlib-console.vercel.app';

function trimOrigin(value: string): string { return value.trim().replace(/\/$/, ''); }

export function normalizeConsoleOrigin(value: string): string {
  const origin = trimOrigin(value);
  if (origin !== PRODUCTION_ORIGIN && origin !== DEVELOPMENT_ORIGIN) {
    throw new Error(`Use ${PRODUCTION_ORIGIN} or ${DEVELOPMENT_ORIGIN} as the console origin.`);
  }
  return origin;
}

/** Validates a connection read from client storage. A saved legacy production origin becomes PRODUCTION_ORIGIN. */
export function loadSavedConnection(value: unknown): Connection {
  if (!value || typeof value !== 'object') throw new Error('No saved connection.');
  const saved = value as Connection;
  const origin = typeof saved.origin === 'string' && trimOrigin(saved.origin) === LEGACY_PRODUCTION_ORIGIN ? PRODUCTION_ORIGIN : saved.origin;
  return validateConnection({ ...saved, origin });
}

export function validateConnection(value: Connection): Connection {
  const origin = normalizeConsoleOrigin(value.origin);
  const orgId = value.orgId.trim();
  const appId = value.appId.trim();
  const token = value.token.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(orgId)) throw new Error('Enter the organization id from the console.');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(appId)) throw new Error('Enter the app id from the console.');
  if (!token || /\s/.test(token)) throw new Error('Paste an app-scoped draft token from the console Tokens panel.');
  return { origin, orgId, appId, token };
}

type AppRoute = Pick<Connection, 'origin' | 'orgId' | 'appId'>;
function appBase(connection: AppRoute): string {
  return `${normalizeConsoleOrigin(connection.origin)}/api/apps/${encodeURIComponent(connection.orgId)}/${encodeURIComponent(connection.appId)}`;
}

export function apiUrl(connection: AppRoute, endpoint: 'placements' | 'drafts' | 'placements/artwork'): string {
  return `${appBase(connection)}/${endpoint}`;
}

/** The image library page. No URL global: query values are encoded by hand. */
export function assetsUrl(connection: AppRoute, query: { cursor?: string; limit?: number; q?: string } = {}): string {
  const params: string[] = [];
  if (query.limit !== undefined) {
    if (!Number.isInteger(query.limit) || query.limit < 1 || query.limit > 50) throw new Error('Choose between 1 and 50 images per page.');
    params.push(`limit=${query.limit}`);
  }
  if (query.cursor !== undefined) {
    if (!validUuid(query.cursor)) throw new Error('The console returned an invalid page cursor. Refresh and try again.');
    params.push(`cursor=${encodeURIComponent(query.cursor)}`);
  }
  // Image names never hold control characters, and the console refuses them in q.
  const q = query.q?.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim().slice(0, 120);
  if (q) params.push(`q=${encodeURIComponent(q)}`);
  return `${appBase(connection)}/assets${params.length ? `?${params.join('&')}` : ''}`;
}

/** Rendition bytes. Built only from a validated asset id and hash, never from a URL in a response. */
export function renditionUrl(connection: AppRoute, assetId: string, sha256: string): string {
  if (!validUuid(assetId) || !validSha256(sha256)) throw new Error('The console returned an invalid image reference. Refresh and try again.');
  return `${appBase(connection)}/assets/${assetId.toLowerCase()}/renditions/${sha256}`;
}

export function tokenPrefix(token: string): string {
  const value = token.trim();
  // Always conceal a suffix, even when an invalid short token was entered.
  return value ? `${value.slice(0, Math.min(8, Math.max(0, value.length - 4)))}…` : '';
}

export function parseFileKey(value: string): string {
  // Do not depend on the browser URL global: this helper also runs in Figma's sandbox.
  const input = value.trim();
  const host = /^https:\/\/(?:www\.)?figma\.com\//i.exec(input);
  if (!host) {
    throw new Error('Use an https://figma.com or https://www.figma.com file URL.');
  }
  const match = /^(?:file|design)\/([^/?#]+)(?:\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/.exec(input.slice(host[0].length));
  if (!match || !validFileKey(match[1])) throw new Error('The Figma URL must contain /file/<key>/ or /design/<key>/.');
  return match[1];
}
