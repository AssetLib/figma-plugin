import { sha256 } from '@noble/hashes/sha256';
import type { Connection } from './types.js';

export function sha256Hex(input: string): string {
  return Array.from(sha256(input), byte => byte.toString(16).padStart(2, '0')).join('');
}

/** Stable cache ownership only; no credentials or artwork enter the browsing record. */
export function browseScope(connection: Connection): string {
  return sha256Hex(JSON.stringify([connection.origin, connection.orgId, connection.appId, connection.token]));
}
