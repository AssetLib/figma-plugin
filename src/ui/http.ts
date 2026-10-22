// Every console request goes through this module: send() for the app routes, identify() for GET /api/token,
// which tells a pasted token its own organization and app, consoleAnswers() for the same route without a token, and
// pairingRequest() and revokeConnection() for one-click Connect's routes. The bearer token goes only to the chosen
// origin, never with cookies, never following a redirect, with a timeout, GET retries, and aborts on supersession or a
// connection change.
import { appUrl, mapHttpError, mapNetworkError, mapTimeoutError, pairingUrl, parseRetryAfter, requestTimeoutMs, retryDelayMs, tokenUrl } from '../shared/index.js';
import type { Connection } from '../shared/index.js';

export type HttpResult = {
  // ok: a 2xx answer. http: any other status. timeout: no answer in time. network: no answer at all (or CORS).
  // aborted: replaced by a newer request on its channel, or ended by a connection change; callers drop it quietly.
  kind: 'ok' | 'http' | 'timeout' | 'network' | 'aborted';
  status: number;
  payload: unknown;
  // The body of a 200 answer to a request with `bytes`; empty otherwise.
  bytes: Uint8Array<ArrayBuffer>;
  contentType: string;
  // Seconds, from Retry-After, when the console sends and exposes it.
  retryAfter: number | null;
  timeoutSeconds: number;
};

export type HttpOptions = {
  // A route under /api/apps/{orgId}/{appId}/; appUrl refuses any other. identify() names its own route.
  path: string;
  method?: 'GET' | 'POST' | 'DELETE';
  // JSON.
  body?: string;
  timeoutMs?: number;
  // GETs retry unless this is false; POSTs never retry.
  retry?: boolean;
  // A new request on a channel aborts the one before it (a list or search that has been replaced).
  channel?: 'list' | 'artwork';
  // For a download: the size the console listed. A 200 body is read as bytes, and one whose Content-Length is larger is refused unread.
  bytes?: number;
};

const active = new Set<AbortController>();
const channels = new Map<string, AbortController>();
const EMPTY = new Uint8Array(0);

/** A connection change: every request in flight stops. */
export function abortAll(): void {
  for (const controller of active) controller.abort();
  active.clear();
  channels.clear();
}

export async function send(config: Connection, options: HttpOptions): Promise<HttpResult> {
  return request(appUrl(config, options.path), config.token, options);
}

/**
 * GET /api/token on `origin` with a token the person pasted: its organization, app, names, and scopes. Tried once, so
 * the form answers at once; an older console answers 404, or without CORS headers (a network error here).
 */
export async function identify(origin: string, token: string): Promise<HttpResult> {
  return request(tokenUrl(origin), token, { path: 'token', retry: false });
}

// One-click Connect's requests: their own set, so a connection change (abortAll) never stops a request being polled or
// a token being ended; Cancel stops them (abortPairing).
const pairingActive = new Set<AbortController>();
// The connection request routes answer at once: 10 s, tried once. The poll loop (connect.ts) owns the retries.
const PAIRING_TIMEOUT_MS = 10000;

/** Cancel: the request being started or polled stops. */
export function abortPairing(): void {
  for (const controller of pairingActive) controller.abort();
  pairingActive.clear();
}

/**
 * A connection request route (pairingUrl): start (no Authorization), or claim and cancel with the request's read key
 * as the bearer. Never cookies, never a redirect, 10 s, never retried.
 */
export async function pairingRequest(url: string, options: { method: 'POST' | 'DELETE'; bearer?: string; body?: string }, abortable = true): Promise<HttpResult> {
  const init: RequestInit = {
    method: options.method,
    headers: { ...(options.bearer ? { Authorization: `Bearer ${options.bearer}` } : {}), ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: options.body }),
    credentials: 'omit', redirect: 'error',
  };
  const controller = new AbortController();
  if (abortable) pairingActive.add(controller);
  try { return await attemptOnce(url, init, controller, PAIRING_TIMEOUT_MS, undefined); }
  finally { pairingActive.delete(controller); }
}

/**
 * GET /api/token without a token, after a connection request got no answer: true when the console answers it at all (an
 * older console answers 401 with CORS headers, where its missing connection routes have none), false for no network.
 */
export async function consoleAnswers(origin: string): Promise<boolean> {
  const result = await attemptOnce(tokenUrl(origin), { method: 'GET', credentials: 'omit', redirect: 'error' }, new AbortController(), PAIRING_TIMEOUT_MS, undefined);
  return result.kind === 'ok' || result.kind === 'http';
}

/** Ends a browser connection's token in the console (DELETE /api/plugin-connections/current). Cancel never stops it. */
export async function revokeConnection(origin: string, token: string): Promise<HttpResult> {
  return pairingRequest(pairingUrl(origin, 'current'), { method: 'DELETE', bearer: token }, false);
}

async function request(url: string, token: string, options: HttpOptions): Promise<HttpResult> {
  const method = options.method ?? 'GET';
  const timeoutMs = options.timeoutMs ?? requestTimeoutMs(method, options.body?.length ?? options.bytes ?? 0);
  const init: RequestInit = {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(options.body === undefined ? {} : { 'Content-Type': 'application/json' }) },
    ...(options.body === undefined ? {} : { body: options.body }),
    credentials: 'omit', redirect: 'error',
  };
  const controller = new AbortController();
  active.add(controller);
  if (options.channel) {
    channels.get(options.channel)?.abort();
    channels.set(options.channel, controller);
  }
  const retry = method === 'GET' && options.retry !== false;
  try {
    for (let attempt = 0; ; attempt += 1) {
      const result = await attemptOnce(url, init, controller, timeoutMs, options.bytes);
      const delay = retry ? retryDelayMs(result, attempt) : null;
      if (delay === null) return result;
      if (!(await wait(delay, controller.signal))) return { ...result, kind: 'aborted' };
    }
  } finally {
    active.delete(controller);
    if (options.channel && channels.get(options.channel) === controller) channels.delete(options.channel);
  }
}

async function attemptOnce(url: string, init: RequestInit, controller: AbortController, timeoutMs: number, expected: number | undefined): Promise<HttpResult> {
  const base: HttpResult = { kind: 'network', status: 0, payload: null, bytes: EMPTY, contentType: '', retryAfter: null, timeoutSeconds: Math.ceil(timeoutMs / 1000) };
  let timedOut = false;
  const timer = window.setTimeout(() => { timedOut = true; controller.abort(); }, timeoutMs);
  try {
    if (controller.signal.aborted) throw new Error('aborted');
    const response = await fetch(url, { ...init, signal: controller.signal });
    const status = response.status;
    const kind = status >= 200 && status < 300 ? 'ok' : 'http';
    // Content-Type and Content-Length are CORS-safelisted; Retry-After is read only when the console exposes it.
    const contentType = response.headers.get('content-type') ?? '';
    const retryAfter = parseRetryAfter(response.headers.get('retry-after'), Date.now());
    if (expected !== undefined && status === 200) {
      const length = response.headers.get('content-length');
      // A body longer than the listed version is refused before it is read; the empty result fails the caller's length check.
      if (length !== null && Number(length) > expected) {
        controller.abort();
        return { ...base, kind, status, retryAfter };
      }
      const bytes = new Uint8Array(await response.arrayBuffer());
      return { ...base, kind, status, bytes, contentType, retryAfter };
    }
    const payload: unknown = await response.json().catch(() => null);
    // A body cut short by a timeout or abort is not an answer.
    if (controller.signal.aborted) throw new Error('aborted');
    return { ...base, kind, status, payload, contentType, retryAfter };
  } catch {
    return { ...base, kind: timedOut ? 'timeout' : controller.signal.aborted ? 'aborted' : 'network' };
  } finally { window.clearTimeout(timer); }
}

/** Waits between attempts; false when the request was aborted meanwhile. */
function wait(ms: number, signal: AbortSignal): Promise<boolean> {
  return new Promise(resolve => {
    if (signal.aborted) { resolve(false); return; }
    const done = (waited: boolean) => { window.clearTimeout(timer); signal.removeEventListener('abort', onAbort); resolve(waited); };
    const onAbort = () => done(false);
    const timer = window.setTimeout(() => done(true), ms);
    signal.addEventListener('abort', onAbort);
  });
}

/**
 * What to tell the person about a failed read: a timeout, an unreachable console (`network` replaces the default when
 * the caller knows more), or the console's answer.
 */
export function readFailure(result: HttpResult, config: Connection, action: 'send' | 'insert' = 'send', network?: string): string {
  if (result.kind === 'timeout') return mapTimeoutError(result.timeoutSeconds);
  if (result.kind === 'network') return network ?? mapNetworkError(config.origin);
  return mapHttpError(result.status, result.payload, action);
}
