// One-click Connect on the main thread: the request waiting for approval, kept in client storage so a reopened plugin
// resumes it, and the workspaces linked on this page, which the console may preselect. Only code.ts imports it.
import { DEVELOPMENT_ORIGIN, LEGACY_PRODUCTION_ORIGIN, PRODUCTION_ORIGIN, parseStoredLink, validInterval, validReadKey, validUserCode, validUuid } from '../shared/index.js';
import type { PairingHint, PairingRecord } from '../shared/index.js';
import { isRecord } from '../shared/validation.js';
import { LINK_KEY, main } from './state.js';

export const PAIRING_KEY = 'assetlib.pairing.v1';
// A request lives 10 minutes, and the console allows at most 15: a deadline further off than that is not one it made.
const LONGEST_MS = 15 * 60 * 1000;

/** A stored or posted request, or null: a read key, never the write key, on one of the two origins, still waiting. */
export function parsePairing(value: unknown, now = Date.now()): PairingRecord | null {
  if (!isRecord(value) || value.v !== 1 || (value.origin !== PRODUCTION_ORIGIN && value.origin !== DEVELOPMENT_ORIGIN) || !validReadKey(value.readKey)
    || !validUserCode(value.userCode) || typeof value.deadline !== 'number' || !Number.isFinite(value.deadline) || !validInterval(value.interval)) return null;
  if (value.deadline <= now || value.deadline > now + LONGEST_MS) return null;
  return { v: 1, origin: value.origin, readKey: value.readKey, userCode: value.userCode, deadline: value.deadline, interval: value.interval };
}

/** The request this device waits for, if any; an unreadable or ended one is deleted. */
export async function loadPairing(): Promise<PairingRecord | null> {
  let stored: unknown;
  try { stored = await figma.clientStorage.getAsync(PAIRING_KEY); } catch { return null; }
  const record = parsePairing(stored);
  if (!record && stored !== undefined) await forget();
  return record;
}

export async function savePairing(record: PairingRecord): Promise<void> {
  main.pairing = record;
  // A request that isn't kept still runs in this window; only a reopen can't resume it.
  try { await figma.clientStorage.setAsync(PAIRING_KEY, record); } catch { /* this window only */ }
}

/** Forgets the request with this code, once it ended (or its connection was saved); another request stays. */
export async function clearPairing(userCode: string): Promise<void> {
  if (main.pairing?.userCode !== userCode) return;
  main.pairing = null;
  await forget();
}

async function forget(): Promise<void> {
  try { await figma.clientStorage.deleteAsync(PAIRING_KEY); } catch { /* deleted on the next load */ }
}

/**
 * Up to five workspaces this page's linked layers name (the first 200 links read), on one of the two console origins
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
    if ((origin !== PRODUCTION_ORIGIN && origin !== DEVELOPMENT_ORIGIN) || !validUuid(link.orgId) || !validUuid(link.appId)) continue;
    if (hints.some(hint => hint.origin === origin && hint.orgId === link.orgId && hint.appId === link.appId)) continue;
    hints.push({ origin, orgId: link.orgId, appId: link.appId });
    if (hints.length === 5) break;
  }
  return hints;
}
