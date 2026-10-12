import { DEVELOPMENT_ORIGIN } from './connection.js';
import { isRecord } from './validation.js';

// What the plugin tells people when something fails: one plain sentence about what happened, then what to do next.
// Developer detail (HTTP codes, manifests, PNG chunks) stays out of it.

function consoleMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const key of ['bindError', 'message', 'error']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (isRecord(value) && typeof value.message === 'string' && value.message.trim()) return value.message;
  }
  return null;
}

// A console without the Insert routes answers 404. (One without their CORS headers looks like a network failure, which is
// said as one: the hosted console and the local one serve them.)
export const MISSING_INSERT = 'This console doesn’t support Insert yet. Send still works.';

// A rendition that disappears between the listing and the download; the console itself supports Insert.
export const GONE_IMAGE = 'This image was removed. Refresh to update the list.';

// A token the console refused (401) or no longer honours (403 for a revoked token, unlike a missing scope).
export const TOKEN_REFUSED = 'Assetlib didn’t accept this token. It may have been revoked. Create a new one in Settings › Tokens.';
// A token without the draft scope (a declare token for CI).
export const TOKEN_SCOPE = 'This token can’t send drafts. Create a token with Draft permission.';
// GET /api/token answered 404, or without CORS: a console from before it identified tokens.
export const OLDER_CONSOLE = 'This console also needs the organization and app IDs. Find them in Settings › General.';
// A read refused after the connection worked: in place of the Insert list.
export const TOKEN_NO_LONGER_ACCEPTED = 'Assetlib no longer accepts this token. Paste a new one.';
// The selected layer, its size, or the file changed between the export and the upload.
export const SELECTION_CHANGED = 'The selection changed while sending. Check it and send again.';
// Main could not write to figma.clientStorage.
export const DEVICE_STORAGE = 'Figma couldn’t save this on your device. Try again.';
export const BUSY = 'Assetlib is busy. Try again in a minute.';
// An export Assetlib can't take, whichever limit it met: 4 MiB of PNG, Vercel's 4.5 MB request (a base64 PNG over about
// 3.37 MB), or the console's 413. Every PNG under 3.3 MB fits, so the one number says what to aim for.
export const EXPORT_TOO_LARGE = 'This export is too large for Assetlib (over 3.3 MB as a PNG). Reduce its detail or size and try again.';

export function serverError(status: number): string {
  return `Assetlib had a problem (${status}). Try again in a minute.`;
}

/**
 * The console refused the token itself: a 401, or a 403 that isn't about its scope (revoked, or no longer authorized).
 * The console's 403 for a token without the scope is the one that says "scope".
 */
export function tokenRefused(status: number, payload: unknown): boolean {
  return status === 401 || (status === 403 && !/\bscope\b/i.test(consoleMessage(payload) ?? ''));
}

/** Why the console refused a Figma connection's token (its 403 says, in `code`), or null for any other refusal. */
export function refusalCode(payload: unknown): 'revoked' | 'member' | 'expired' | null {
  const code = isRecord(payload) ? payload.code : null;
  return code === 'revoked' || code === 'member' || code === 'expired' ? code : null;
}

// A browser connection the console no longer accepts: why, and that Connect again makes a new one. Never the token form.
export const RECONNECT_REVOKED = 'This Figma connection was ended. Connect again to keep working.';
export const RECONNECT_MEMBER = 'Your role no longer allows sending drafts. Ask a workspace owner, then connect again.';
export const RECONNECT_EXPIRED = 'This Figma connection expired. Connect again to keep working.';
export const RECONNECT_REFUSED = 'Assetlib no longer accepts this connection. Connect again.';

export function reconnectText(code: string | null | undefined): string {
  return code === 'revoked' ? RECONNECT_REVOKED : code === 'member' ? RECONNECT_MEMBER : code === 'expired' ? RECONNECT_EXPIRED : RECONNECT_REFUSED;
}
export function isReconnectText(text: string): boolean {
  return [RECONNECT_REVOKED, RECONNECT_MEMBER, RECONNECT_EXPIRED, RECONNECT_REFUSED].includes(text);
}

export function mapHttpError(status: number, payload: unknown, action: 'send' | 'insert' = 'send'): string {
  if (tokenRefused(status, payload)) return TOKEN_REFUSED;
  if (status === 403 && action === 'insert') return 'This token can’t read this app’s images. Create a token with Draft permission.';
  if (status === 403) return TOKEN_SCOPE;
  if (status === 404 && action === 'insert') return MISSING_INSERT;
  if (status === 413) return EXPORT_TOO_LARGE;
  if (status === 409) return consoleMessage(payload) ?? 'Assetlib couldn’t put this image in the chosen cell. Check the placement and try again.';
  if (status === 429) return BUSY;
  if (status >= 500) return serverError(status);
  return consoleMessage(payload) ?? serverError(status);
}

/** No answer at all. Production says so plainly; the local console is named, since it may simply not be running. */
export function mapNetworkError(origin: string): string {
  return origin === DEVELOPMENT_ORIGIN
    ? 'Can’t reach the console at localhost:3100. Check that it’s running.'
    : 'Can’t reach Assetlib. Check your internet connection.';
}

// A draft request that failed in transit may still have been saved.
export const DRAFT_MAY_HAVE_ARRIVED = 'It may have arrived anyway, so check the console before sending again.';

/** A request that got no answer in time. A draft may have arrived anyway, so it is not simply retried. */
export function mapTimeoutError(seconds: number, action: 'read' | 'send' = 'read'): string {
  return `Assetlib didn’t answer within ${seconds} seconds. ${action === 'send' ? DRAFT_MAY_HAVE_ARRIVED : 'Try again.'}`;
}
