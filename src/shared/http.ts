// Request timing and retry rules for the UI's console calls. Pure, so they are tested without a browser.

const MIB = 1024 * 1024;
// A read gets 20 s and a draft upload 30 s, each plus 15 s per MiB it carries.
export const GET_TIMEOUT_MS = 20000;
export const POST_TIMEOUT_MS = 30000;
export const TIMEOUT_MS_PER_MIB = 15000;
// A GET is tried again after 1 s, then 4 s.
export const RETRY_DELAYS_MS: readonly number[] = [1000, 4000];
// A 429 is retried only when the console asks for at most this long a wait.
export const MAX_RETRY_AFTER_SECONDS = 30;

/**
 * How long one attempt may take, in whole seconds so the timeout message is exact. `bytes` is the body sent, or for
 * a download the size the console listed. A DELETE (ending a Figma connection) is timed as a GET.
 */
export function requestTimeoutMs(method: 'GET' | 'POST' | 'DELETE', bytes = 0): number {
  const base = method === 'POST' ? POST_TIMEOUT_MS : GET_TIMEOUT_MS;
  return base + Math.round((TIMEOUT_MS_PER_MIB / 1000) * (Math.max(0, bytes) / MIB)) * 1000;
}

/** A Retry-After header in seconds: delta-seconds or an HTTP date. Null when absent or unreadable. */
export function parseRetryAfter(value: string | null, now: number): number | null {
  if (value === null) return null;
  const text = value.trim();
  if (/^\d{1,9}$/.test(text)) return Number(text);
  // An HTTP date names its day and month; anything else (a negative number, say) is not one.
  if (!/[A-Za-z]{3}/.test(text)) return null;
  const date = Date.parse(text);
  return Number.isNaN(date) ? null : Math.max(0, Math.ceil((date - now) / 1000));
}

export type RetryOutcome = { kind: 'ok' | 'http' | 'timeout' | 'network' | 'aborted'; status: number; retryAfter: number | null };

/**
 * The wait before trying a GET again, or null to stop. A network error, 502, 503, or 504 is tried twice more, after
 * 1 s and 4 s (longer if Retry-After asks); a 429 only when Retry-After asks. A Retry-After over 30 s stops the retries
 * for any status. A timeout already waited, so it is not retried.
 */
export function retryDelayMs(outcome: RetryOutcome, attempt: number): number | null {
  const backoff = RETRY_DELAYS_MS[attempt];
  if (backoff === undefined) return null;
  const asked = outcome.retryAfter;
  if (asked !== null && asked > MAX_RETRY_AFTER_SECONDS) return null;
  if (outcome.kind === 'network') return backoff;
  if (outcome.kind !== 'http') return null;
  if (outcome.status === 502 || outcome.status === 503 || outcome.status === 504) return Math.max(backoff, (asked ?? 0) * 1000);
  if (outcome.status === 429 && asked !== null) return Math.max(1, asked) * 1000;
  return null;
}
