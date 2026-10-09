import type { Connection } from './types.js';
import { validFileKey } from './validation.js';

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

export function apiUrl(connection: Pick<Connection, 'origin' | 'orgId' | 'appId'>, endpoint: 'placements' | 'drafts'): string {
  return `${normalizeConsoleOrigin(connection.origin)}/api/apps/${encodeURIComponent(connection.orgId)}/${encodeURIComponent(connection.appId)}/${endpoint}`;
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
