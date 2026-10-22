import type { Connection, TokenIdentity } from './types.js';
import { isRecord, validFileKey, validSha256, validUuid } from './validation.js';

export const PRODUCTION_ORIGIN = 'https://console.assetlib.dev';
export const STAGING_ORIGIN = 'https://assetlib-billing-staging.vercel.app';
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
  if (origin !== PRODUCTION_ORIGIN && origin !== STAGING_ORIGIN && origin !== DEVELOPMENT_ORIGIN) {
    throw fieldError('Choose a listed Assetlib console.', 'origin');
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
  // The names only label the connection; an unusable one is dropped, never an error. So are a browser connection's
  // labels: who approved it, and its request's code.
  const workspaceName = labelName(value.workspaceName);
  const appName = labelName(value.appName);
  const browser = value.method === 'browser';
  const connectedAs = typeof value.connectedAs === 'string' && EMAIL.test(value.connectedAs) ? value.connectedAs : undefined;
  const pairing = typeof value.pairing === 'string' && USER_CODE.test(value.pairing) ? value.pairing : undefined;
  return { origin, orgId, appId, token, ...(workspaceName ? { workspaceName } : {}), ...(appName ? { appName } : {}),
    ...(browser ? { method: 'browser' as const } : {}), ...(connectedAs ? { connectedAs } : {}), ...(pairing ? { pairing } : {}) };
}

const EMAIL = /^[^\s@]{1,64}@[^\s@]{1,189}$/;
// A connection request's code: 8 letters a person can't misread, without the hyphen the wire puts after 4.
const USER_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{8}$/;
const READ_KEY = /^alr_[A-Za-z0-9_-]{43}$/;
const WRITE_KEY = /^alw_[A-Za-z0-9_-]{43}$/;
const WIRE_CODE = /^[BCDFGHJKLMNPQRSTVWXZ]{4}-[BCDFGHJKLMNPQRSTVWXZ]{4}$/;

/** A read key (the plugin polls with it) as the console mints it. */
export function validReadKey(value: unknown): value is string { return typeof value === 'string' && READ_KEY.test(value); }
/** A write key (the browser page approves with it) as the console mints it. */
export function validWriteKey(value: unknown): value is string { return typeof value === 'string' && WRITE_KEY.test(value); }
/** A request's code as stored: 8 letters without the hyphen. */
export function validUserCode(value: unknown): value is string { return typeof value === 'string' && USER_CODE.test(value); }
/** A stored code as people read it: the hyphen after 4. */
export function formatUserCode(code: string): string { return `${code.slice(0, 4)}-${code.slice(4)}`; }

/** The plugin-facing connection request routes on a console origin: start (POST), claim, cancel, and DELETE current. */
export function pairingUrl(origin: string, route: 'start' | 'claim' | 'cancel' | 'current'): string {
  return `${normalizeConsoleOrigin(origin)}/api/plugin-connections${route === 'start' ? '' : `/${route}`}`;
}

export type PairingStart = { readKey: string; writeKey: string; userCode: string; expiresIn: number; interval: number };

/** The answer to a started request (201), or an error when it is not one. `userCode` loses its hyphen. */
export function parsePairingStart(value: unknown): PairingStart {
  if (!isRecord(value) || !validReadKey(value.readKey) || !validWriteKey(value.writeKey) || typeof value.userCode !== 'string' || !WIRE_CODE.test(value.userCode)
    || !Number.isInteger(value.expiresIn) || (value.expiresIn as number) < 1 || (value.expiresIn as number) > 900 || !validInterval(value.interval)) {
    throw new Error('The console sent an answer the plugin can’t read. Try again.');
  }
  return { readKey: value.readKey, writeKey: value.writeKey, userCode: value.userCode.replace('-', ''), expiresIn: value.expiresIn as number, interval: value.interval };
}

/** Seconds between polls, as the console stores them per request. */
export function validInterval(value: unknown): value is number { return Number.isInteger(value) && (value as number) >= 2 && (value as number) <= 30; }

/** What a claim gave the plugin. The console sends no origin: the plugin uses the one it started on. */
export type ClaimedConnection = Pick<Connection, 'orgId' | 'appId' | 'token' | 'workspaceName' | 'appName' | 'connectedAs'>;
export type ClaimAnswer =
  | { status: 'pending' | 'slow_down'; interval: number | null }
  | { status: 'connected'; connection: ClaimedConnection }
  | { status: 'denied' | 'expired' | 'cancelled' | 'claimed' };

/**
 * A claim's answer about the request: 200 pending or connected, 410 with how it ended, or 429 slow_down. Null for any
 * other answer (a rate limit, a malformed key, a server error), which the poller handles by its status. A 200 it can't
 * read throws.
 */
export function parseClaim(status: number, value: unknown): ClaimAnswer | null {
  const body = isRecord(value) ? value : {};
  if (status === 410) {
    const ended = body.status;
    // Unknown keys answer expired, so an unexpected word is read as that too.
    return { status: ended === 'denied' || ended === 'cancelled' || ended === 'claimed' ? ended : 'expired' };
  }
  if (status === 429) return body.status === 'slow_down' ? { status: 'slow_down', interval: validInterval(body.interval) ? body.interval : null } : null;
  if (status !== 200) return null;
  if (body.status === 'pending') return { status: 'pending', interval: validInterval(body.interval) ? body.interval : null };
  const connection = body.connection;
  if (body.status !== 'connected' || !isRecord(connection) || !validUuid(connection.orgId) || !validUuid(connection.appId)
    || typeof connection.token !== 'string' || !TOKEN_FORMAT.test(connection.token)) {
    throw new Error('The console sent an answer the plugin can’t read. Try again.');
  }
  const workspaceName = labelName(connection.workspaceName);
  const appName = labelName(connection.appName);
  const connectedAs = typeof connection.connectedAs === 'string' && EMAIL.test(connection.connectedAs) ? connection.connectedAs : undefined;
  return { status: 'connected', connection: { orgId: connection.orgId, appId: connection.appId, token: connection.token,
    ...(workspaceName ? { workspaceName } : {}), ...(appName ? { appName } : {}), ...(connectedAs ? { connectedAs } : {}) } };
}

// The console mints app tokens as alk_ and 43 base64url characters.
const TOKEN_FORMAT = /^alk_[A-Za-z0-9_-]{43}$/;

/** A token typed into the form. Saved connections are not checked again, so an older save keeps loading. */
export function checkTokenFormat(token: string): string {
  const value = token.trim();
  if (!TOKEN_FORMAT.test(value)) throw fieldError(value.startsWith('figd_')
    ? 'That’s a Figma token. Paste an Assetlib Draft token instead; it starts with alk_.'
    : value.startsWith('alk_') ? 'That doesn’t look like a whole Assetlib token. Draft tokens are alk_ and 43 more characters.'
      : 'That doesn’t look like an Assetlib token. Draft tokens start with alk_.', 'token');
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
// a rendition, and POST drafts and figma/inventory. Nothing can reach a publish or release route.
const APP_PATH = /^(?:placements|placements\/artwork|drafts|figma\/inventory|assets(?:\?[\w.~%&=!*'()-]*)?|assets\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\/renditions\/[0-9a-f]{64})$/;

/** The URL for an allowed app route; anything else throws. */
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

/**
 * A Figma design file's link: its file key, and the file's name as the link spells it (its slug), which may be empty. A
 * branch's link (`/design/{key}/branch/{branchKey}/{name}`) names the branch, a file of its own.
 */
export function parseFileLink(value: string): { fileKey: string; slug: string } {
  // Do not depend on the browser URL global: this helper also runs in Figma's sandbox.
  const input = value.trim();
  const host = /^https:\/\/(?:www\.)?figma\.com\//i.exec(input);
  if (!host) throw new Error(FILE_LINK_INVALID);
  const match = /^(?:file|design)\/([^/?#]+)(?:\/branch\/([^/?#]+))?(?:\/([^/?#]*)[^?#]*)?(?:\?[^#]*)?(?:#.*)?$/.exec(input.slice(host[0].length));
  const fileKey = match?.[2] ?? match?.[1];
  if (!match || !validFileKey(match[1]) || !validFileKey(fileKey)) throw new Error(FILE_LINK_INVALID);
  let slug = match[3] ?? '';
  try { slug = decodeURIComponent(slug); } catch { /* compared as written */ }
  return { fileKey, slug };
}

/**
 * A file name or a link's slug reduced so the two compare: lower case, with one "-" for each run of spaces and
 * punctuation. Letters of every script and digits stay, so a name with no Latin letters still compares; a name of
 * spaces and punctuation alone reduces to "".
 */
export function slugify(value: string): string {
  return value.toLowerCase().replace(/[\s!-\/:-@\[-`{-~\u00a0-\u00bf\u2000-\u206f\u3000-\u303f]+/g, '-').replace(/^-+|-+$/g, '');
}

/**
 * True only when the link names this file. A link without a name, or a name that reduces to nothing, can't be checked,
 * so it is not a match: the person confirms it (Use anyway), as for another file's link.
 */
export function linkNamesFile(slug: string, fileName: string): boolean {
  const link = slugify(slug);
  return link !== '' && link === slugify(fileName);
}

/**
 * The document's identity, saved on the document root (`assetlib.file.v1`) so everyone who opens the file shares it:
 * Figma's own file key (`figma`), or one taken from a pasted link (`link`); `name` is the file's name when it was saved.
 */
export interface FileIdentity { v: 1; fileKey: string; source: 'figma' | 'link'; savedAt: string; name: string }

/** Reads `assetlib.file.v1`. Never throws: an unreadable identity is none. */
export function parseFileIdentity(raw: string): FileIdentity | null {
  if (typeof raw !== 'string' || !raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!isRecord(value) || value.v !== 1 || !validFileKey(value.fileKey) || (value.source !== 'figma' && value.source !== 'link')
      || typeof value.savedAt !== 'string') return null;
    return { v: 1, fileKey: value.fileKey, source: value.source, savedAt: value.savedAt, name: typeof value.name === 'string' ? value.name.slice(0, 200) : '' };
  } catch { return null; }
}
