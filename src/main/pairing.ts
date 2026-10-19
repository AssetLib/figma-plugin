// One-click Connect on the main thread: the request waiting for approval, kept in client storage so a reopened plugin
// resumes it, and the workspaces linked on this page, which the console may preselect. Only code.ts imports it.
import { DEVELOPMENT_ORIGIN, LEGACY_PRODUCTION_ORIGIN, PRODUCTION_ORIGIN, STAGING_ORIGIN, parseStoredLink, validInterval, validReadKey, validUserCode, validUuid } from '../shared/index.js';
import type { PairingHint, PairingRecord } from '../shared/index.js';
import { isRecord } from '../shared/validation.js';
import { LINK_KEY, main } from './state.js';

export const PAIRING_KEY = 'assetlib.pairing.v1';
// A request lives 10 minutes, and the console allows at most 15: a deadline further off than that is not one it made.
const LONGEST_MS = 15 * 60 * 1000;
// This window of the plugin, in the request's record (`polledBy`), which every window shares.
const WINDOW = Math.random().toString(36).slice(2, 10);

/** A stored or posted request, or null: a read key, never the write key, on one of the allowed origins, still waiting. */
export function parsePairing(value: unknown, now = Date.now()): PairingRecord | null {
  if (!isRecord(value) || value.v !== 1 || (value.origin !== PRODUCTION_ORIGIN && value.origin !== STAGING_ORIGIN && value.origin !== DEVELOPMENT_ORIGIN) || !validReadKey(value.readKey)
    || !validUserCode(value.userCode) || typeof value.deadline !== 'number' || !Number.isFinite(value.deadline) || !validInterval(value.interval)) return null;
  if (value.deadline <= now || value.deadline > now + LONGEST_MS) return null;
  const turn = typeof value.polledAt === 'number' && Number.isFinite(value.polledAt) && typeof value.polledBy === 'string'
    ? { polledAt: value.polledAt, polledBy: value.polledBy } : {};
  return { v: 1, origin: value.origin, readKey: value.readKey, userCode: value.userCode, deadline: value.deadline, interval: value.interval, ...turn };
}

/** The request this device waits for, if any; an unreadable or ended one is deleted (unless another window replaced it meanwhile). */
export async function loadPairing(): Promise<PairingRecord | null> {
  let stored: unknown;
  try { stored = await figma.clientStorage.getAsync(PAIRING_KEY); } catch { return null; }
  const record = parsePairing(stored);
  if (!record && stored !== undefined) await forget(current => JSON.stringify(current) === JSON.stringify(stored));
  return record;
}

/** Keeps the request, as asked about by this window now: it holds the turn (takeTurn). */
export async function savePairing(record: PairingRecord): Promise<void> {
  main.pairing = { ...record, polledAt: Date.now(), polledBy: WINDOW };
  // A request that isn't kept still runs in this window; only a reopen can't resume it.
  try { await figma.clientStorage.setAsync(PAIRING_KEY, main.pairing); } catch { /* this window only */ }
}

/**
 * Every plugin window holding a request may ask the console about it. The one that asked within the request's interval
 * keeps the turn (two asking in turns would each be told to slow down), so another waits for it to pass, plus a second
 * (`after`), and takes the turn when that window stops asking (it closed, or its timers slept). A record that ended or
 * was replaced elsewhere leaves the console to say how the request ended.
 */
export async function takeTurn(userCode: string, interval: number): Promise<{ turn: 'poll' | 'wait'; after: number }> {
  let stored: PairingRecord | null = null;
  try { stored = parsePairing(await figma.clientStorage.getAsync(PAIRING_KEY)); } catch { /* ask the console */ }
  if (stored?.userCode !== userCode) return { turn: 'poll', after: 0 };
  const due = (stored.polledAt ?? 0) + stored.interval * 1000 - 500 - Date.now();
  if (stored.polledBy !== WINDOW && due > 0) return { turn: 'wait', after: due + 1000 };
  await savePairing({ ...stored, interval: validInterval(interval) ? interval : stored.interval });
  return { turn: 'poll', after: 0 };
}

/** Forgets the request with this code, once it ended (or its connection was saved); another request stays, even another window's. */
export async function clearPairing(userCode: string): Promise<void> {
  if (main.pairing?.userCode !== userCode) return;
  main.pairing = null;
  await forget(current => isRecord(current) && current.userCode === userCode);
}

/** Deletes the stored request when `matches` it as it is now: another window may have saved a newer one since. */
async function forget(matches: (stored: unknown) => boolean): Promise<void> {
  try { if (matches(await figma.clientStorage.getAsync(PAIRING_KEY))) await figma.clientStorage.deleteAsync(PAIRING_KEY); }
  catch { /* deleted on the next load */ }
}

/**
 * Up to five workspaces this page's linked layers name (the first 200 links read), on one of the allowed console origins
 * (the legacy host as production) and by UUID, so the connect page can preselect the one the person works in.
 */
export function pageHints(): PairingHint[] {
  let nodes: readonly SceneNode[];
  try { nodes = figma.currentPage.findAllWithCriteria({ pluginData: { keys: [LINK_KEY] } }); } catch { return []; }
  const hints: PairingHint[] = [];
  for (const node of nodes.slice(0, 200)) {
    let raw = '';
    try { raw = node.getPluginData(LINK_KEY); } catch { continue; }
    const link = parseStoredLink(raw);
    if (!link) continue;
    const origin = link.origin === LEGACY_PRODUCTION_ORIGIN ? PRODUCTION_ORIGIN : link.origin;
    if ((origin !== PRODUCTION_ORIGIN && origin !== STAGING_ORIGIN && origin !== DEVELOPMENT_ORIGIN) || !validUuid(link.orgId) || !validUuid(link.appId)) continue;
    if (hints.some(hint => hint.origin === origin && hint.orgId === link.orgId && hint.appId === link.appId)) continue;
    hints.push({ origin, orgId: link.orgId, appId: link.appId });
    if (hints.length === 5) break;
  }
  return hints;
}
