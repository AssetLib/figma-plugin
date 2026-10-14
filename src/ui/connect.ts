// One-click Connect: the plugin starts a connection request, main opens the console's connect page in the browser, and
// the plugin polls until the person approves there; the console then issues this plugin a draft-only token of its own,
// saved as a browser connection. The token form (connection.ts) stays the secondary path. Every request goes through
// http.ts (pairingRequest); the write key stays in memory, and main keeps only the read key (assetlib.pairing.v1), so a
// reopened plugin resumes the request. Plugin windows share that record, and ask main for the turn before each poll.
import { DEVELOPMENT_ORIGIN, DEVICE_STORAGE, PRODUCTION_ORIGIN, formatUserCode, mapHttpError, mapNetworkError, normalizeConsoleOrigin, pairingUrl, parseClaim, parsePairingStart, validUuid } from '../shared/index.js';
import type { ClaimAnswer, ClaimedConnection, Connection, PairingHint, PairingRecord, PairingStart } from '../shared/index.js';
import {
  OLDER_CONSOLE_CONNECT, OPEN_PAGE_FAILED, PAIRING_BUSY, PAIRING_CANCELLED, PAIRING_DENIED, PAIRING_EXPIRED, PAIRING_FAILED, PAIRING_REUSED, PAIRING_UNREACHABLE,
} from '../shared/protocol.js';
import type { MainMessage } from '../shared/protocol.js';
import { chooseToken, closeSettings, revealOrigin, saveConnection, tokenFormShown } from './connection.js';
import { announceError, element, flushRender, post, scheduleRender, setBusy, setStatus, setUnavailable } from './dom.js';
import { abortPairing, consoleAnswers, pairingRequest, revokeConnection } from './http.js';
import { nextRequestId, state } from './state.js';

type Phase = 'idle' | 'starting' | 'waiting' | 'saving' | 'ended';
type EndKind = 'denied' | 'expired' | 'cancelled' | 'reused' | 'older' | 'unreachable' | 'busy' | 'error';

// What each end says. A request that ended as it may (declined, expired, cancelled, used, an older console) is a
// neutral step; one that couldn't run is an error.
const ENDED: Record<EndKind, string> = { denied: PAIRING_DENIED, expired: PAIRING_EXPIRED, cancelled: PAIRING_CANCELLED, reused: PAIRING_REUSED,
  older: OLDER_CONSOLE_CONNECT, unreachable: PAIRING_UNREACHABLE, busy: PAIRING_BUSY, error: PAIRING_FAILED };
const NEUTRAL: readonly EndKind[] = ['denied', 'expired', 'cancelled', 'reused', 'older'];
// A poll that got no answer, or a server error, waits longer each time (seconds).
const BACKOFF = [2, 4, 8, 15];

const settings = element<HTMLDetailsElement>('settings');
const originSelect = element<HTMLSelectElement>('origin');
const tokenInput = element<HTMLInputElement>('token');
const block = element('pairing');
const connectButton = element<HTMLButtonElement>('connect-browser');
const useTokenButton = element<HTMLButtonElement>('use-token');
const switchButton = element<HTMLButtonElement>('switch-workspace');
const openButton = element<HTMLButtonElement>('pairing-open');
const checkButton = element<HTMLButtonElement>('pairing-check');
const cancelButton = element<HTMLButtonElement>('pairing-cancel');
const note = element('pairing-note');

const pairing = {
  phase: 'idle' as Phase,
  origin: PRODUCTION_ORIGIN,
  readKey: '',
  // The browser page's key: in memory only, so a resumed request can't open the page again.
  writeKey: null as string | null,
  userCode: '',
  // Local epoch ms: the console's expiresIn from when its answer arrived (a plugin window can't read the Date header).
  deadline: 0,
  interval: 2,
  lastSentAt: 0,
  timer: null as number | null,
  countdown: null as number | null,
  inFlight: false,
  failures: 0,
  hint: null as PairingHint | null,
  ended: null as EndKind | null,
  // Resumed from main's record when the plugin opened: the browser tab is the one opened before.
  resumed: false,
  // What the panel says about the request (how it ended, or a browser that didn't open), and its tone; `noteSeen` once
  // it showed in the open settings, so it goes when they close.
  note: '',
  noteKind: 'info' as 'info' | 'error',
  noteSeen: false,
  // Every start, Cancel, and end moves it on, so an answer for an earlier request is dropped.
  ticket: 0,
  openRequest: null as number | null,
  adoptRequest: null as number | null,
  saveRequest: null as number | null,
  saving: null as Connection | null,
  // Connect again from a view opened the settings to show the request; Cancel closes them again.
  openedSettings: false,
  startedFromView: false,
};
// Workspaces this page's linked layers name (main's connection message), while there is no connection.
let hints: PairingHint[] = [];
// The claim-turn awaiting main's answer.
let turnRequest: { id: number; resolve: (turn: Extract<MainMessage, { type: 'turn' }>) => void } | null = null;
// An approved connection's save, or a claimed request's adopt-connection, waiting for a Send, Sync, or Insert to end
// (releaseHeld): switching the connection under it would drop its draft or send it with a token just ended.
let held: (() => void) | null = null;
// Cancels asking main first whether another window saved the request's connection, by request id: /cancel follows only
// if none did.
const cancelling = new Map<number, { origin: string; readKey: string }>();

/** The connected app, so Connect again offers its workspace first; null unless its IDs are UUIDs. */
export function hintOfCurrent(): PairingHint | null {
  const connection = state.connection;
  return connection && validUuid(connection.orgId) && validUuid(connection.appId) ? { origin: connection.origin, orgId: connection.orgId, appId: connection.appId } : null;
}

function chosenOrigin(): string {
  try { return normalizeConsoleOrigin(originSelect.value); } catch { return PRODUCTION_ORIGIN; }
}
function record(): PairingRecord {
  const { origin, readKey, userCode, deadline, interval } = pairing;
  return { v: 1, origin, readKey, userCode, deadline, interval };
}
/** True when focus is in the connection settings, or nowhere: the person is following the request there. */
function followed(): boolean {
  const active = document.activeElement;
  return !active || active === document.body || settings.contains(active);
}
function clearTimer(): void {
  if (pairing.timer !== null) window.clearTimeout(pairing.timer);
  pairing.timer = null;
}
function stopTimers(): void {
  clearTimer();
  if (pairing.countdown !== null) window.clearTimeout(pairing.countdown);
  pairing.countdown = null;
}
/** The next poll, after `ms` (never past the deadline, which the poll then ends). Never two, never while one runs. */
function schedule(ms: number): void {
  clearTimer();
  if (pairing.phase !== 'waiting' || pairing.inFlight) return;
  pairing.timer = window.setTimeout(() => { pairing.timer = null; void poll(); }, Math.min(ms, Math.max(0, pairing.deadline - Date.now())));
}
/** The countdown in the waiting line, renewed every 15 s. */
function countdown(): void {
  if (pairing.countdown !== null) window.clearTimeout(pairing.countdown);
  pairing.countdown = window.setTimeout(() => {
    pairing.countdown = null;
    if (pairing.phase !== 'waiting') return;
    scheduleRender();
    countdown();
  }, 15000);
}
/** Tells the console the request is over (fire and forget): a pending one is cancelled, and a token claimed from it ends. */
function cancelOnConsole(origin: string, readKey: string): void {
  void pairingRequest(pairingUrl(origin, 'cancel'), { method: 'POST', bearer: readKey }, false);
}

/**
 * Connect to Assetlib (and Switch workspace, Connect again, the Sync bar's Switch workspace): starts a request on the
 * chosen console, offering a workspace to preselect (`hint`, else one this page's links name), keeps its read key with
 * main, and asks main to open the console's connect page. Never `ops.connecting`: Insert and Send keep working while it waits.
 */
export async function startConnect(hint?: PairingHint | null): Promise<void> {
  // A request runs already: Connect again shows it (the settings may have been closed since).
  if (pairing.phase === 'starting' || pairing.phase === 'waiting' || pairing.phase === 'saving') { showRequest(); return; }
  if (state.ops.connecting) return;
  const origin = chosenOrigin();
  if (origin === DEVELOPMENT_ORIGIN) revealOrigin();
  const chosen = hint?.origin === origin ? hint : hints.find(item => item.origin === origin) ?? null;
  const ticket = ++pairing.ticket;
  Object.assign(pairing, { phase: 'starting', origin, hint: chosen, ended: null, note: '', readKey: '', writeKey: null, userCode: '', resumed: false, failures: 0 });
  // Connect again from a view: the request shows in the connection settings.
  pairing.openedSettings = Boolean(state.connection) && !settings.open;
  pairing.startedFromView = pairing.openedSettings || !followed();
  settings.open = true;
  setStatus('Connecting…');
  scheduleRender();
  const body = JSON.stringify({ client: 'figma', ...(chosen ? { hint: { orgId: chosen.orgId, appId: chosen.appId } } : {}) });
  const result = await pairingRequest(pairingUrl(origin, 'start'), { method: 'POST', body });
  if (ticket !== pairing.ticket || result.kind === 'aborted') return;
  if (result.kind === 'ok' && result.status === 201) {
    let started: PairingStart;
    try { started = parsePairingStart(result.payload); } catch { end('error'); return; }
    const now = Date.now();
    Object.assign(pairing, { readKey: started.readKey, writeKey: started.writeKey, userCode: started.userCode, interval: started.interval,
      deadline: now + started.expiresIn * 1000, lastSentAt: now });
    post({ type: 'save-pairing', pairing: record() });
    openPage();
    wait();
    return;
  }
  // A console from before one-click Connect lacks the route and its CORS headers, so its start gets no answer the plugin
  // can read, as without a network: GET /api/token, which it answers with them, tells the two apart. (One answering 404 is older too.)
  if (result.kind === 'network') {
    const older = await consoleAnswers(origin);
    if (ticket === pairing.ticket) end(older ? 'older' : 'unreachable', !older && origin === DEVELOPMENT_ORIGIN ? mapNetworkError(origin) : undefined);
  } else if (result.kind === 'http' && result.status === 404) end('older');
  else if (result.kind === 'timeout') end('unreachable', origin === DEVELOPMENT_ORIGIN ? mapNetworkError(origin) : undefined);
  else if (result.status === 429) end('busy');
  else end('error', mapHttpError(result.status, result.payload));
}

/** Waiting for approval: polls every `interval` seconds, the first after one interval (or at once for a resumed request). */
function wait(): void {
  pairing.phase = 'waiting';
  state.pairingActive = true;
  const focus = followed() || pairing.startedFromView;
  setStatus(`Approve in your browser. The code is ${[...pairing.userCode].join(' ')}.`);
  countdown();
  scheduleRender();
  if (focus) { flushRender(); checkButton.focus({ preventScroll: true }); }
  if (pairing.resumed) pollIfDue(); else schedule(pairing.interval * 1000);
}

/** Main's record of a request this device waits for (the plugin was closed while it waited): it carries on. */
function resume(saved: PairingRecord): void {
  if (saved.origin === DEVELOPMENT_ORIGIN) revealOrigin();
  ++pairing.ticket;
  Object.assign(pairing, { origin: saved.origin, readKey: saved.readKey, writeKey: null, userCode: saved.userCode, deadline: saved.deadline,
    interval: saved.interval, lastSentAt: 0, failures: 0, hint: null, ended: null, note: '', resumed: true });
  pairing.openedSettings = Boolean(state.connection) && !settings.open;
  settings.open = true;
  wait();
}

async function poll(): Promise<void> {
  clearTimer();
  if (pairing.phase !== 'waiting' || pairing.inFlight) return;
  const now = Date.now();
  // Past its deadline the console has ended it: nothing to ask.
  if (now >= pairing.deadline) { end('expired'); return; }
  const ticket = pairing.ticket;
  const { origin, readKey } = pairing;
  pairing.inFlight = true;
  pairing.lastSentAt = now;
  // Another plugin window may hold this request too: one asks at a time, and one that saved its connection hands it over.
  const turn = await new Promise<Extract<MainMessage, { type: 'turn' }>>(resolve => {
    turnRequest = { id: nextRequestId(), resolve };
    post({ type: 'claim-turn', requestId: turnRequest.id, userCode: pairing.userCode, interval: pairing.interval });
  });
  if (ticket !== pairing.ticket) return;
  if (turn.turn !== 'poll') {
    pairing.inFlight = false;
    if (turn.turn === 'adopted') connected(); else schedule(turn.after);
    return;
  }
  const result = await pairingRequest(pairingUrl(origin, 'claim'), { method: 'POST', bearer: readKey });
  if (ticket !== pairing.ticket) return;
  pairing.inFlight = false;
  if (result.kind === 'aborted') return;
  if (result.kind === 'network' || result.kind === 'timeout' || result.status >= 500) {
    pairing.failures += 1;
    schedule(BACKOFF[Math.min(pairing.failures, BACKOFF.length) - 1]! * 1000);
    return;
  }
  let answer: ClaimAnswer | null;
  // An answer it can't read may have carried a token: the console ends the request, and with it any token it issued.
  try { answer = parseClaim(result.status, result.payload); } catch { cancelOnConsole(origin, readKey); end('error'); return; }
  if (!answer) {
    // The console's rate limit: as long as it asks, at least the interval. A 401 is a key it can't read.
    if (result.status === 429) schedule(Math.max(pairing.interval, result.retryAfter ?? 5) * 1000);
    else end('error');
    return;
  }
  switch (answer.status) {
    case 'pending':
      pairing.interval = answer.interval ?? pairing.interval;
      pairing.failures = 0;
      schedule(pairing.interval * 1000);
      break;
    // Asked too soon: the console's interval for this request, which grew.
    case 'slow_down':
      pairing.interval = answer.interval ?? Math.min(pairing.interval + 5, 30);
      schedule(pairing.interval * 1000);
      break;
    case 'connected': finish(answer.connection); break;
    case 'claimed': adopt(); break;
    default: end(answer.status);
  }
}

/** A focus or visibility change, as the person comes back from the browser: a poll now, if one is due. */
function pollIfDue(): void {
  if (pairing.phase !== 'waiting' || pairing.inFlight) return;
  if (Date.now() - pairing.lastSentAt >= pairing.interval * 1000) void poll();
}
/** Check now: a poll now, if one is due, else as soon as one is (sooner than a backoff or a rate limit's wait). */
function checkNow(): void {
  if (pairing.phase !== 'waiting' || pairing.inFlight) return;
  const left = pairing.interval * 1000 - (Date.now() - pairing.lastSentAt);
  if (left <= 0) void poll(); else schedule(left);
}

/** Approved: the token the console issued is saved as a browser connection, with the names it gave. */
function finish(claimed: ClaimedConnection): void {
  const next: Connection = { origin: pairing.origin, ...claimed, method: 'browser', pairing: pairing.userCode };
  pairing.saving = next;
  hold(() => { pairing.saveRequest = saveConnection(next); });
}

/**
 * The console says the request was claimed already: by another window of the plugin (they share client storage), or by
 * this one before its answer was lost. Main looks for the connection saved from it.
 */
function adopt(): void {
  hold(() => {
    pairing.adoptRequest = nextRequestId();
    post({ type: 'adopt-connection', requestId: pairing.adoptRequest, userCode: pairing.userCode });
  });
}

/** True while a Send, Sync, or Insert runs, which a connection change would cut short. */
function operationRunning(): boolean {
  const { sending, syncing, inserting } = state.ops;
  return sending || syncing || inserting;
}
/**
 * Saving (or adopting) the request's connection, now or, while an operation runs, once it ends (releaseHeld): "Saving
 * connection…" meanwhile. Other windows keep off the request (heartbeat).
 */
function hold(run: () => void): void {
  stopTimers();
  pairing.phase = 'saving';
  if (operationRunning()) { held = run; heartbeat(); } else run();
  scheduleRender();
}
/** Held: this window keeps the request's turn (save-pairing), so no other window asks about it, finds it claimed, and ends its token. */
function heartbeat(): void {
  post({ type: 'save-pairing', pairing: record() });
  pairing.timer = window.setTimeout(() => { pairing.timer = null; if (held) heartbeat(); }, pairing.interval * 1000);
}
/** Before each render: a held save or adopt runs once the operation it waited for ended. */
export function releaseHeld(): void {
  if (!held || operationRunning()) return;
  const run = held;
  held = null;
  clearTimer();
  run();
}

/**
 * The request's connection is this window's: its block goes, and focus in it moves to the account chip (shown once the
 * shell renders), as after a token's Connect; the passing connection test then closes the settings.
 */
function connected(): void {
  const inBlock = block.contains(document.activeElement);
  reset();
  pairing.note = '';
  scheduleRender();
  if (!inBlock) return;
  flushRender();
  element('settings-summary').focus({ preventScroll: true });
}

/** Back to no request: its record goes, and so does the write key. */
function reset(): void {
  stopTimers();
  if (pairing.userCode) post({ type: 'clear-pairing', userCode: pairing.userCode });
  Object.assign(pairing, { phase: 'idle', startedFromView: false, writeKey: null, inFlight: false, saving: null, saveRequest: null, adoptRequest: null, openRequest: null });
  held = null;
  state.pairingActive = false;
}

/** The request ended without a connection: the panel says why, with what to do next. */
function end(kind: EndKind, text?: string): void {
  const focus = followed();
  ++pairing.ticket;
  reset();
  Object.assign(pairing, { phase: 'ended', ended: kind, note: text ?? ENDED[kind], noteKind: NEUTRAL.includes(kind) ? 'info' : 'error', noteSeen: false });
  if (pairing.noteKind === 'error') announceError(pairing.note); else setStatus(pairing.note);
  // An older console needs a token: the form opens at its field.
  if (kind === 'older') { chooseToken(); return; }
  scheduleRender();
  if (!focus) return;
  flushRender();
  (state.connection ? note : connectButton).focus({ preventScroll: true });
}

/**
 * Cancel: the panel goes back to where the request started. Another window may have saved the request's connection
 * already, which then becomes this one's (adopt-connection, read once); otherwise the console is told (fire and forget).
 */
function cancel(): void {
  if (pairing.phase !== 'waiting') return;
  ++pairing.ticket;
  abortPairing();
  const requestId = nextRequestId();
  cancelling.set(requestId, { origin: pairing.origin, readKey: pairing.readKey });
  post({ type: 'adopt-connection', requestId, userCode: pairing.userCode, once: true });
  reset();
  Object.assign(pairing, { ended: null, note: '' });
  setStatus('');
  if (pairing.openedSettings && state.connection) { closeSettings(); return; }
  scheduleRender();
  flushRender();
  (state.connection ? !switchButton.hidden ? switchButton
    : !element('browser-path').hidden && !connectButton.hidden ? connectButton : element('settings-summary') : connectButton).focus({ preventScroll: true });
}

function openPage(): void {
  if (!pairing.writeKey) return;
  if (pairing.note === OPEN_PAGE_FAILED) pairing.note = '';
  pairing.openRequest = nextRequestId();
  post({ type: 'open-connect-page', requestId: pairing.openRequest, origin: pairing.origin, writeKey: pairing.writeKey });
  scheduleRender();
}

/** Main's connection message: the request's connection was saved, or main holds a request to resume. */
export function applyPairing(message: Extract<MainMessage, { type: 'connection' }>): void {
  hints = message.hints ?? [];
  if (hints.some(hint => hint.origin === DEVELOPMENT_ORIGIN)) revealOrigin();
  const saving = pairing.saving;
  // Saved (connection.ts ends a browser token it replaced). The connection test then says Connected.
  if (pairing.phase === 'saving' && saving && message.connection?.token === saving.token) { connected(); return; }
  if (pairing.phase === 'idle' && message.pairing) resume(message.pairing);
}

/** Main's answer to adopt-connection: another window's connection is this one's now, or the request was used elsewhere. */
export function adopted(message: Extract<MainMessage, { type: 'adopted' }>): void {
  const cancelled = cancelling.get(message.requestId);
  if (cancelled) {
    cancelling.delete(message.requestId);
    if (!message.adopted) cancelOnConsole(cancelled.origin, cancelled.readKey);
    return;
  }
  if (message.requestId !== pairing.adoptRequest) return;
  // The connection arrived with main's connection message; the other window said Connected.
  if (message.adopted) { connected(); return; }
  // Nobody on this device has it: the console ends the token it issued.
  cancelOnConsole(pairing.origin, pairing.readKey);
  end('reused');
}

/** Main's answer to claim-turn, for the poll waiting on it. */
export function turned(message: Extract<MainMessage, { type: 'turn' }>): void {
  if (message.requestId !== turnRequest?.id) return;
  const { resolve } = turnRequest;
  turnRequest = null;
  resolve(message);
}

/** Connect again while a request runs: the settings open on it (Cancel closes them again), at its Check now. */
function showRequest(): void {
  if (state.connection && !settings.open) pairing.openedSettings = true;
  settings.open = true;
  scheduleRender();
  flushRender();
  connectFocus()?.focus({ preventScroll: true });
}

/** Main couldn't open the browser (an error for open-connect-page); false when the error is another operation's. */
export function failOpenPage(requestId: number): boolean {
  if (requestId !== pairing.openRequest) return false;
  pairing.openRequest = null;
  if (pairing.phase !== 'waiting') return true;
  Object.assign(pairing, { note: OPEN_PAGE_FAILED, noteKind: 'error', noteSeen: false });
  announceError(OPEN_PAGE_FAILED);
  scheduleRender();
  return true;
}

/** Main refused to save the request's connection; false when the error is another operation's. Its token ends. */
export function saveRefused(requestId: number): boolean {
  const saving = pairing.saving;
  if (requestId !== pairing.saveRequest || !saving) return false;
  void revokeConnection(saving.origin, saving.token);
  end('error', DEVICE_STORAGE);
  return true;
}

/** Where focus goes when the focused control hides: in the request's block, or on the first run its path; else null. */
export function connectFocus(): HTMLElement | null {
  if (pairing.phase === 'starting') return !element('browser-path').hidden && !connectButton.hidden ? connectButton : block;
  if (state.pairingActive) return pairing.phase === 'waiting' ? checkButton : block;
  if (state.connection) return null;
  return tokenFormShown() ? tokenInput : connectButton;
}

function waitingLine(): string {
  const minutes = Math.floor((pairing.deadline - Date.now()) / 60000);
  return `Waiting for approval · expires in ${minutes >= 1 ? `${minutes} min` : 'less than a minute'}`;
}

export function renderConnect(): void {
  const active = state.pairingActive;
  const connected = Boolean(state.connection);
  // With a connection, how a request ended goes once the person saw it and closed the settings (the first run is them).
  if (connected && pairing.note && !active) {
    if (settings.open) pairing.noteSeen = true;
    else if (pairing.noteSeen) Object.assign(pairing, { note: '', noteSeen: false, ...(pairing.phase === 'ended' ? { phase: 'idle', ended: null } : {}) });
  }
  const { phase } = pairing;
  // The request's block takes the place of the first-run copy (connection.ts hides the account's actions).
  block.hidden = !active;
  element('first-run-title').hidden = active;
  element('first-run-text').hidden = active;
  if (active) {
    const host = pairing.origin === PRODUCTION_ORIGIN ? 'console.assetlib.dev' : '127.0.0.1:3100';
    element('pairing-text').textContent = pairing.resumed ? `Approve in the ${host} tab you opened earlier, or cancel and start again.`
      : `Assetlib opened ${host} in your browser. Sign in, check that it shows this code, and approve.`;
    const code = element('pairing-code');
    code.textContent = formatUserCode(pairing.userCode);
    code.setAttribute('aria-label', `Connection code ${[...pairing.userCode].join(' ')}`);
    element('pairing-status-text').textContent = phase === 'saving' ? 'Saving connection…' : waitingLine();
    openButton.hidden = phase !== 'waiting' || !pairing.writeKey;
    checkButton.hidden = phase !== 'waiting';
    cancelButton.hidden = phase !== 'waiting';
  }
  element('pairing-spinner').hidden = phase !== 'waiting' && phase !== 'saving';
  note.hidden = !pairing.note;
  note.textContent = pairing.note;
  note.className = pairing.noteKind;
  // The browser path: Connect to Assetlib, the first run's primary (Try again after a console that couldn't be reached),
  // and Use a token instead until the token form shows. A refused pasted token offers the browser path too;
  // the account menu starts other requests.
  const unreachable = phase === 'ended' && pairing.ended === 'unreachable';
  const refusedPasted = connected && state.connection?.method !== 'browser' && state.tokenRefused;
  element('browser-path').hidden = active || (connected && !unreachable && !refusedPasted);
  // After an older console the token form is the way in, so its Connect (connection.ts) is the one primary instead.
  const older = phase === 'ended' && pairing.ended === 'older' && pairing.origin === chosenOrigin();
  connectButton.hidden = older;
  element('browser-help').hidden = older;
  const tokenPrimary = !connected && tokenFormShown() && !unreachable;
  connectButton.className = (connected && !refusedPasted) || tokenPrimary ? 'secondary wide' : 'primary wide';
  if (!connected || (refusedPasted && older)) element('connect').className = tokenPrimary || older ? 'primary wide' : 'secondary wide';
  setBusy(connectButton, phase === 'starting' ? 'Connecting…' : unreachable ? 'Try again' : 'Connect to Assetlib', phase === 'starting' && !connected);
  setUnavailable(connectButton, phase === 'starting' || state.ops.connecting);
  useTokenButton.hidden = tokenFormShown() || connected;
  switchButton.hidden = !connected || refusedPasted;
  setBusy(switchButton, phase === 'starting' ? 'Connecting…' : state.connection?.method === 'browser' ? 'Switch workspace' : 'Connect with browser', phase === 'starting');
  setUnavailable(switchButton, phase === 'starting' || state.ops.connecting);
}

export function initConnect(): void {
  // Again after an end: the same workspace is offered first.
  connectButton.addEventListener('click', () => { void startConnect(pairing.phase === 'ended' ? pairing.hint : state.connection ? hintOfCurrent() : undefined); });
  useTokenButton.addEventListener('click', chooseToken);
  switchButton.addEventListener('click', () => { void startConnect(state.connection?.method === 'browser' ? undefined : hintOfCurrent()); });
  openButton.addEventListener('click', openPage);
  checkButton.addEventListener('click', checkNow);
  cancelButton.addEventListener('click', cancel);
  // Back from the browser: Chromium runs a hidden page's timers once a minute at most, so the return itself polls.
  window.addEventListener('focus', pollIfDue);
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') pollIfDue(); });
}
