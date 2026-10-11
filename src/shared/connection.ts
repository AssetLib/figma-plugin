import type { Connection, TokenIdentity } from './types.js';
import { isRecord, validFileKey, validSha256, validUuid } from './validation.js';

export const PRODUCTION_ORIGIN = 'https://console.assetlib.dev';
export const DEVELOPMENT_ORIGIN = 'http://localhost:3100';
// The console's earlier production host. It still accepts app tokens, so a
// connection saved with it moves to PRODUCTION_ORIGIN on load with the same token.
export const LEGACY_PRODUCTION_ORIGIN = 'https://assetlib-console.vercel.app';

function trimOrigin(value: string): string { return value.trim().replace(/\/$/, ''); }

export type ConnectionField = 'origin' | 'orgId' | 'appId' | 'token';
// A validation error names its field, so the connection form can mark and focus it.
export function fieldError(message: string, field: ConnectionField): Error { return Object.assign(new Error(message), { field }); }

/** The connection field a validation error names, or null for any other error. */
export function connectionErrorField(error: unknown): ConnectionField | null {
  const field = error instanceof Error ? (error as Error & { field?: unknown }).field : undefined;
  return field === 'origin' || field === 'orgId' || field === 'appId' || field === 'token' ? field : null;
}

export function normalizeConsoleOrigin(value: string): string {
  const origin = trimOrigin(value);
  if (origin !== PRODUCTION_ORIGIN && origin !== DEVELOPMENT_ORIGIN) {
    throw fieldError(`Choose ${PRODUCTION_ORIGIN} or ${DEVELOPMENT_ORIGIN} as the console.`, 'origin');
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

/** A workspace or app name for a label: control characters stripped, at most 200 characters, or undefined. */
function labelName(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const name = Array.from(value.replace(/[\u0000-\u001f\u007f-\u009f]/g, '').trim()).slice(0, 200).join('').trim();
  return name || undefined;
}

export function validateConnection(value: Connection): Connection {
  const origin = normalizeConsoleOrigin(value.origin);
  const orgId = value.orgId.trim();
  const appId = value.appId.trim();
  const token = value.token.trim();
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(orgId)) throw fieldError('Enter the organization ID from Settings › General in the Assetlib console.', 'orgId');
  if (!/^[A-Za-z0-9_-]{1,128}$/.test(appId)) throw fieldError('Enter the app ID from Settings › General in the Assetlib console.', 'appId');
  if (!token || /\s/.test(token)) throw fieldError('Paste a Draft token from Settings › Tokens in the Assetlib console.', 'token');
  // The names only label the connection; an unusable one is dropped, never an error.
  const workspaceName = labelName(value.workspaceName);
  const appName = labelName(value.appName);
  return { origin, orgId, appId, token, ...(workspaceName ? { workspaceName } : {}), ...(appName ? { appName } : {}) };
}

// The console mints app tokens as alk_ and 43 base64url characters.
const TOKEN_FORMAT = /^alk_[A-Za-z0-9_-]{43}$/;

/** A token typed into the form. Saved connections are not checked again, so an older save keeps loading. */
export function checkTokenFormat(token: string): string {
  const value = token.trim();
  if (!TOKEN_FORMAT.test(value)) throw fieldError('That doesn’t look like an Assetlib token. Tokens start with alk_.', 'token');
  return value;
}

/** GET /api/token on a console origin: the one route outside an app, which tells a token its own organization and app. */
export function tokenUrl(origin: string): string {
  return `${normalizeConsoleOrigin(origin)}/api/token`;
}

/** The answer to GET /api/token, or an error when it is not one. */
export function parseTokenIdentity(value: unknown): TokenIdentity {
  const id = (item: unknown): item is string => typeof item === 'string' && /^[A-Za-z0-9_-]{1,128}$/.test(item);
  if (!isRecord(value) || !id(value.orgId) || !id(value.appId) || !Array.isArray(value.scopes)) {
    throw new Error('The console sent an answer the plugin can’t read. Try again.');
  }
  return {
    orgId: value.orgId, appId: value.appId,
    workspaceName: labelName(value.workspaceName) ?? null, appName: labelName(value.appName) ?? null,
    scopes: value.scopes.filter((scope): scope is 'declare' | 'draft' => scope === 'declare' || scope === 'draft'),
  };
}

/** How the plugin names a connection: "Workspace · App" when the console said, else the IDs. */
export function connectionLabel(connection: Pick<Connection, 'orgId' | 'appId' | 'workspaceName' | 'appName'>): string {
  if (connection.workspaceName && connection.appName) return `${connection.workspaceName} · ${connection.appName}`;
  return connection.appName ?? `${connection.orgId} · ${connection.appId}`;
}

type AppRoute = Pick<Connection, 'origin' | 'orgId' | 'appId'>;
function appBase(connection: AppRoute): string {
  return `${normalizeConsoleOrigin(connection.origin)}/api/apps/${encodeURIComponent(connection.orgId)}/${encodeURIComponent(connection.appId)}`;
}

// The only routes the plugin calls under /api/apps/{orgId}/{appId}/: GET placements, placements/artwork, assets, and
// a rendition, and POST drafts. Every request goes through appUrl, so nothing can reach a publish or release route.
const APP_PATH = /^(?:placements|placements\/artwork|drafts|assets(?:\?[\w.~%&=!*'()-]*)?|assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/renditions\/[0-9a-f]{64})$/;

/** The URL for one of the five app routes; anything else throws. */
export function appUrl(connection: AppRoute, path: string): string {
  if (!APP_PATH.test(path)) throw new Error('The plugin tried to call a console route it does not use. Reopen the plugin and try again.');
  return `${appBase(connection)}/${path}`;
}

export function apiUrl(connection: AppRoute, endpoint: 'placements' | 'drafts' | 'placements/artwork'): string {
  return appUrl(connection, endpoint);
}

/** The image library page's path. No URL global: query values are encoded by hand. */
export function assetsPath(query: { cursor?: string; limit?: number; q?: string } = {}): string {
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
  return `assets${params.length ? `?${params.join('&')}` : ''}`;
}

export function assetsUrl(connection: AppRoute, query: { cursor?: string; limit?: number; q?: string } = {}): string {
  return appUrl(connection, assetsPath(query));
}

/** Rendition bytes' path. Built only from a validated asset id and hash, never from a URL in a response. */
export function renditionPath(assetId: string, sha256: string): string {
  if (!validUuid(assetId) || !validSha256(sha256)) throw new Error('The console returned an invalid image reference. Refresh and try again.');
  return `assets/${assetId.toLowerCase()}/renditions/${sha256}`;
}

export function renditionUrl(connection: AppRoute, assetId: string, sha256: string): string {
  return appUrl(connection, renditionPath(assetId, sha256));
}

export function tokenPrefix(token: string): string {
  const value = token.trim();
  // Always conceal a suffix, even when an invalid short token was entered.
  return value ? `${value.slice(0, Math.min(8, Math.max(0, value.length - 4)))}…` : '';
}

// A file link the plugin can't use: not Figma's, or not a design file's.
export const FILE_LINK_INVALID = 'That isn’t a link to a Figma design file. In Figma, press Cmd+L to copy this file’s link, then paste it here.';

export function parseFileKey(value: string): string {
  // Do not depend on the browser URL global: this helper also runs in Figma's sandbox.
  const input = value.trim();
  const host = /^https:\/\/(?:www\.)?figma\.com\//i.exec(input);
  if (!host) throw new Error(FILE_LINK_INVALID);
  const match = /^(?:file|design)\/([^/?#]+)(?:\/[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/.exec(input.slice(host[0].length));
  if (!match || !validFileKey(match[1])) throw new Error(FILE_LINK_INVALID);
  return match[1];
}
