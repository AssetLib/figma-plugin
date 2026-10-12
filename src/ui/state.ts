import { MISSING_INSERT, TOKEN_NO_LONGER_ACCEPTED, TOKEN_REFUSED, defaultPreferences, reconnectText } from '../shared/index.js';
import type { CanvasTarget, Connection, Placement, Preferences } from '../shared/index.js';
import type { SelectionState } from '../shared/protocol.js';

/**
 * What is running. Each operation makes unavailable only the actions it conflicts with (Connect, Send, Sync, Insert,
 * Match ratio); the lists, search, tabs, and environment control stay live throughout. `loadingList` names the Insert
 * list loading now, which is aria-busy while it does.
 */
export type Ops = { connecting: boolean; sending: boolean; syncing: boolean; inserting: boolean; loadingList: 'placements' | 'images' | null };

/**
 * Why a read failed, for the state shown in place of the Insert list. `invalid` is an answer that could not be parsed.
 * `code`: why the console refused a Figma connection's token (refusalCode).
 */
export type ReadFailure = { kind: 'http' | 'timeout' | 'network' | 'invalid'; status: number; text: string; code?: string };

/**
 * What a view says about a failed read, in place of what it could not load, and the one action that helps. A browser
 * connection the console refused offers Connect again (`reconnect`), never the token form.
 */
export type ReadProblem = { text: string; action: 'retry' | 'token' | 'send' | 'reconnect' };
/** The console refused the token itself (a 401, or a revoked token's 403), not only what it may read. */
export function refusedToken(failure: ReadFailure): boolean {
  return failure.kind === 'http' && (failure.status === 401 || failure.text === TOKEN_REFUSED);
}
export function readProblem(failure: ReadFailure | null, method?: Connection['method']): ReadProblem {
  if (!failure) return { text: 'Assetlib couldn’t load this list. Try again.', action: 'retry' };
  if (refusedToken(failure)) return method === 'browser' ? { text: reconnectText(failure.code), action: 'reconnect' } : { text: TOKEN_NO_LONGER_ACCEPTED, action: 'token' };
  if (failure.kind === 'http' && failure.status === 403) return { text: failure.text, action: method === 'browser' ? 'reconnect' : 'token' };
  if (failure.text === MISSING_INSERT) return { text: failure.text, action: 'send' };
  return { text: failure.text, action: 'retry' };
}

/** Insert with nothing selected, or before main reports the selection: a new frame. */
export const NEW_FRAME: CanvasTarget = { mode: 'new', label: 'Insert', count: 0, nodeIds: [] };

// State more than one module reads. Each module keeps the rest to itself.
export const state = {
  connection: null as Connection | null,
  // Null while a connection save awaits main's acknowledgement, so no selection reply is trusted meanwhile.
  connectionGeneration: null as number | null,
  selectionGeneration: null as number | null,
  selection: { node: null, reason: 'Select a frame or layer to send.', fileKey: null, remembered: null, insertTarget: NEW_FRAME } as SelectionState,
  // The Send tab's placements, from the connection test.
  placements: [] as Placement[],
  // Set by a successful placements read in this generation: Send has its placements.
  placementsLoaded: false,
  // Why this generation's connection test failed, until a read succeeds: Send says it in place of its placements.
  testFailure: null as ReadFailure | null,
  // Counts failed authenticated reads, so a preview or reload that started before one cannot mark the connection good.
  attentionCount: 0,
  // Preferences apply from the first connection message only.
  preferencesLoaded: false,
  prefs: defaultPreferences() as Preferences,
  // Replaces the environment note while previews are paused.
  previewNote: '',
  ops: { connecting: false, sending: false, syncing: false, inserting: false, loadingList: null } as Ops,
  // A one-click Connect request waits for approval, or its connection is being saved: its block shows in the
  // connection settings (connect.ts), in place of the first-run copy or the account's actions.
  pairingActive: false,
  sequence: 0,
};

export function nextRequestId(): number {
  state.sequence += 1;
  return state.sequence;
}

/** True while an operation runs that Connect, Send, Sync, Insert, and Match ratio must wait for. Loading a list is not one. */
export function actionsBlocked(): boolean {
  const { connecting, sending, syncing, inserting } = state.ops;
  return connecting || sending || syncing || inserting;
}

export function hasCurrentSelection(): boolean {
  return state.connectionGeneration !== null && state.selectionGeneration === state.connectionGeneration;
}
