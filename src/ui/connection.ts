// The connection: the first-run screen and the account panel (the connection settings, opened from the account chip),
// the token form and its GET /api/token step, the connection test, Disconnect, and the chip's label.
import {
  OLDER_CONSOLE, TOKEN_REFUSED, TOKEN_SCOPE, checkTokenFormat, connectionErrorField, connectionLabel, consoleLink, fieldError, normalizeConsoleOrigin,
  parsePlacements, parseTokenIdentity, PRODUCTION_ORIGIN, tokenPrefix, validateConnection,
} from '../shared/index.js';
import type { Connection, Placement } from '../shared/index.js';
import { DISCONNECTED } from '../shared/protocol.js';
import type { MainMessage } from '../shared/protocol.js';
import { announceError, clearError, element, errorText, flushRender, inField, post, scheduleRender, setBusy, setStatus, setUnavailable } from './dom.js';
import { identify, readFailure, send } from './http.js';
import type { HttpResult } from './http.js';
import { clearPlacements, clearRememberedSelection, showPlacements } from './send.js';
import { actionsBlocked, nextRequestId, state } from './state.js';
import type { ReadFailure } from './state.js';

const settings = element<HTMLDetailsElement>('settings');
const settingsSummary = element('settings-summary');
const origin = element<HTMLSelectElement>('origin');
const orgId = element<HTMLInputElement>('org-id');
const appId = element<HTMLInputElement>('app-id');
const token = element<HTMLInputElement>('token');
const idFields = element('id-fields');
const connectButton = element<HTMLButtonElement>('connect');
const disconnectButton = element<HTMLButtonElement>('disconnect');
const connectionError = element('connection-error');
const connectionForm = element('connection-form');
const updateButton = element<HTMLButtonElement>('update-token');
const fields = { origin, orgId, appId, token } as const;

// The save-connection request awaiting main; its error belongs under the token field. If main refuses it, the
// connection it would have replaced stands, so the generation and placements set aside for it, and the token typed
// for it, come back.
let pendingConnection: { id: number; generation: number | null; placements: Placement[]; token: string } | null = null;
// The clear-connection request (Disconnect) awaiting main.
let pendingDisconnect: number | null = null;
// Each GET /api/token the form starts; a newer one, or a connection change, makes an older answer stale.
let identifyTicket = 0;
// The console (its origin) that answered GET /api/token with 404 or without CORS in this session: it needs the
// organization and app IDs, so the form shows them and uses them while that console is chosen. Disconnect forgets it.
// `idsUnsure`: the answer was a network failure, which an older console's missing CORS headers and a dropped connection
// look the same as, so a Connect with the ID fields empty asks GET /api/token again.
let idsOrigin: string | null = null;
let idsUnsure = false;
// With a working connection the account panel is a menu; Update token (or a token that needs attention) shows the form.
let formOpened = false;
// A connection the person saved in this session: when its test passes, a toast says so.
let announceConnected = false;
// The connection whose names GET /api/token gave this session (its origin, IDs, and token): asked once per connection.
let namesAsked = '';
// The names this session last posted for a connection (its key and names): main may drop them (a Disconnect or save
// began meanwhile), so the same connection coming back with other names is asked again.
let namesPosted: { key: string; workspaceName: string | null; appName: string } | null = null;
const namesKey = (connection: Connection) => [connection.origin, connection.orgId, connection.appId, connection.token].join('\n');
// True from a failed read until a successful one: the chip shows a warning.
let attention = false;
// 'read' for why a read failed (the connection test, or a refused token), which a later successful read clears; 'form'
// for an entry the person must fix.
let connectionErrorKind: 'read' | 'form' | null = null;
// The generation whose placements reloadPlacements is reading, and when a failed reload may try again.
let reloadingPlacements: number | null = null;
let placementsRetryAt = 0;
// What had focus when a connection test started, or the field a connection error focused. A settings field focused
// since then is the person's work in progress; the field they submitted from, or one this code focused, is not.
let focusMark: Element | null = null;

/** A console origin for a link, or production while the field holds something else. */
function chosenOrigin(): string {
  try { return normalizeConsoleOrigin(origin.value); } catch { return PRODUCTION_ORIGIN; }
}
/** True while the chosen console is one that needs the organization and app IDs. */
function idsShown(): boolean { return idsOrigin !== null && idsOrigin === chosenOrigin(); }
/** The app by name, else by the start of its ID (a console that can't name a token's app). */
function appShortName(connection: Connection): string {
  return connection.appName ?? `App ${connection.appId.length > 12 ? `${connection.appId.slice(0, 8)}…` : connection.appId}`;
}
/** Who a toast says the plugin connected to: the names when the console gave them (the app's alone when both don't fit
 * a toast's 100 characters), never two raw IDs. */
function connectedTo(connection: Connection): string {
  if (!connection.appName) return 'Assetlib';
  const label = connectionLabel(connection);
  return `Connected to ${label}`.length <= 100 ? label : connection.appName;
}

// The chip's shortened workspace name, sized to its text (fitWorkspace); `key` names what its room depends on, and
// `hidden` is true when not one character of it fits beside the app's name.
let workspaceFit = { key: '', maxWidth: '', hidden: false };
// The chip's font (ui.html): until it has loaded, the name is measured in a fallback, so it is fitted again after.
const CHIP_FONT = '500 11px "Instrument Sans"';

/**
 * A shortened workspace name ends in an ellipsis, but its box keeps the room the grid gave it, so up to a glyph's width
 * would sit unused before the "·" and the spaces either side of it would differ. This sizes the box to the shortened
 * text. The room depends on the chip's cap (320 px, or what the window leaves beside the tabs), the app's name, the
 * warning glyph, and the font, so it is measured again only when one of those changes (or until the chip has a box: the
 * first run hides it, and a narrow window hides the workspace).
 */
function fitWorkspace(workspace: HTMLElement, separator: HTMLElement, key: string): void {
  if (workspaceFit.key !== key) {
    const room = workspace.getBoundingClientRect().width;
    const text = workspace.firstChild;
    if (!text || text.nodeType !== Node.TEXT_NODE) return;
    let maxWidth = '';
    let hidden = false;
    if (workspace.scrollWidth > workspace.clientWidth) {
      // Chrome keeps the longest start of the name that fits with the ellipsis; measure both as laid out.
      const range = document.createRange();
      const mark = workspace.appendChild(document.createTextNode('…'));
      range.selectNodeContents(mark);
      const ellipsis = range.getBoundingClientRect().width;
      mark.remove();
      const start = (end: number) => { range.setStart(text, 0); range.setEnd(text, end); return range.getBoundingClientRect().width; };
      let low = 0;
      let high = text.textContent?.length ?? 0;
      while (low < high) {
        const middle = Math.ceil((low + high) / 2);
        if (start(middle) + ellipsis <= room) low = middle; else high = middle - 1;
      }
      // Half a pixel spare, so rounding never drops the last glyph that fits. Not one character: the app's name keeps
      // the chip, as in a narrow window, with no "·" left beside it.
      if (low === 0) hidden = true;
      else maxWidth = `${(start(low) + ellipsis + 0.5).toFixed(2)}px`;
    }
    if (!room && !hidden) return;
    workspaceFit = { key, maxWidth, hidden };
  }
  workspace.style.maxWidth = workspaceFit.maxWidth;
  workspace.hidden = workspaceFit.hidden;
  separator.hidden = workspaceFit.hidden;
}

/**
 * True while the open connection settings say why a read failed, under the token field. The views (the Insert list, the
 * Send form) then say nothing of their own about it, so the failure is said once.
 */
export function problemInSettings(): boolean { return settings.open && connectionErrorKind === 'read'; }

export function renderConnection(): void {
  const connection = state.connection;
  // The first-run screen is the open settings; there is no chip to open them from.
  if (!connection && !settings.open) settings.open = true;
  const label = connection ? connectionLabel(connection) : '';
  const name = element('account-name');
  const span = (className: string, text: string) => { const item = document.createElement('span'); item.className = className; item.textContent = text; return item; };
  // Before the names: the warning glyph takes room from the workspace's name.
  element('chip-warning').hidden = !attention;
  if (connection?.workspaceName && connection.appName) {
    // A long workspace name shortens first, and a narrow window drops it (ui.html), so the app's name stays.
    // No-break spaces: a grid item drops ordinary spaces at its edges.
    const workspace = span('chip-workspace', connection.workspaceName);
    const separator = span('chip-sep', '\u00a0·\u00a0');
    name.replaceChildren(workspace, separator, span('chip-app', connection.appName));
    fitWorkspace(workspace, separator, `${connection.workspaceName}\n${connection.appName}\n${attention}\n${document.fonts?.check(CHIP_FONT)}\n${window.innerWidth}`);
  } else if (connection) {
    // Without names (a console that can't read them for a token), the chip names the app by the start of its ID.
    name.replaceChildren(span('chip-app', appShortName(connection)));
  } else name.replaceChildren(span('chip-app', 'Connection'));
  settingsSummary.title = attention ? `${label} needs attention` : label || 'Connection';
  // The panel names the app, whole (the chip may shorten it), and the workspace on the line below; without names, the
  // app as the chip does, with both IDs in full on hover.
  const title = element('account-title');
  title.textContent = connection ? appShortName(connection) : '';
  title.title = connection ? `Organization ${connection.orgId} · App ${connection.appId}` : '';
  element('token-prefix').textContent = connection
    ? [connection.workspaceName, `Connected with token ${tokenPrefix(connection.token)}`].filter(Boolean).join(' · ') : '';
  element<HTMLAnchorElement>('open-console').href = connection ? consoleLink(connection, 'overview') : `${chosenOrigin()}/`;
  element<HTMLAnchorElement>('first-run-console').href = `${chosenOrigin()}/`;
  idFields.hidden = !idsShown();
  // The account's own controls exist only with a connection (ui.html also hides the account block on the first run).
  disconnectButton.hidden = !connection;
  element('open-console').hidden = !connection;
  // A working connection's panel is a menu: the form shows on the first run, when the connection needs attention or the
  // form has something to say, after Update token, and while it holds a typed token.
  const form = !connection || attention || formOpened || connectionErrorKind !== null || idsShown() || Boolean(token.value);
  connectionForm.hidden = !form;
  updateButton.hidden = !connection || form;
  // One primary per view: Connect is the first run's primary, and the account panel's while the connection needs
  // attention; otherwise the footer's Insert or Send is, and the form's button is secondary.
  connectButton.className = !connection || attention ? 'primary wide' : 'secondary wide';
  setBusy(connectButton, state.ops.connecting ? 'Connecting…' : connection && !attention ? 'Save token' : 'Connect', state.ops.connecting);
  setUnavailable(connectButton, actionsBlocked());
  setUnavailable(disconnectButton, actionsBlocked() || pendingDisconnect !== null);
}

function markFocus(): void { focusMark = document.activeElement; }

/**
 * True while the person works in the connection settings: they moved to one of its fields since the test started, typed
 * a token, or changed an entry from the saved connection. Closing them then would take the field and their unsaved edit
 * away.
 */
function settingsInUse(): boolean {
  const active = document.activeElement;
  if (active && active !== focusMark && inField(active) && settings.contains(active)) return true;
  const saved = state.connection;
  return Boolean(token.value.trim()) || !saved || origin.value !== saved.origin || orgId.value.trim() !== saved.orgId || appId.value.trim() !== saved.appId;
}

/**
 * Closes the connection settings. Focus on a control inside them moves to their summary (the account chip), which
 * stays in view, so it never falls to the page when the controls hide.
 */
function closeSettings(): void {
  // A connection made on the first-run screen shows the chip only once the shell renders, so render first.
  flushRender();
  const active = document.activeElement;
  if (active && active !== settingsSummary && settings.contains(active)) settingsSummary.focus({ preventScroll: true });
  settings.open = false;
  // A read failure the settings were saying goes back to the view.
  scheduleRender();
}

/**
 * The person asked to fix the token (Update token): the settings open with the token field focused, and why the read
 * failed, if one did, shows under it (the view's own copy steps aside).
 */
export function openSettings(): void {
  settings.open = true;
  formOpened = true;
  // The form shows before its field takes focus.
  scheduleRender();
  flushRender();
  token.focus();
  token.scrollIntoView({ block: 'nearest' });
  scheduleRender();
}

function clearConnectionError(): void {
  connectionErrorKind = null;
  connectionError.hidden = true;
  connectionError.textContent = '';
  connectionError.className = 'error';
  for (const field of Object.values(fields)) field.removeAttribute('aria-invalid');
}

/**
 * A console without GET /api/token (it answers 404, or without CORS headers) needs the organization and app IDs. That
 * is the next step, not a mistake: the ID fields show under a neutral notice in place of the error, no field is marked
 * invalid, the status region says it, and the organization ID field takes focus.
 */
function askForIds(unsure: boolean): void {
  clearConnectionError();
  connectionErrorKind = 'form';
  idsOrigin = chosenOrigin();
  idsUnsure = unsure;
  idFields.hidden = false;
  connectionError.className = 'info';
  connectionError.textContent = OLDER_CONSOLE;
  connectionError.hidden = false;
  setStatus(OLDER_CONSOLE);
  settings.open = true;
  orgId.focus();
  focusMark = orgId;
  connectionError.scrollIntoView({ block: 'nearest' });
}

/**
 * A connection error sits under the token field in the open settings. `field` names the input at fault: it gets the
 * invalid border, and focus unless the error arrived on its own (a failed connection test) while the person is in a
 * field, such as a search, a file link, or another connection field: that field keeps focus and every keystroke and is
 * scrolled back into view, and the alert region announces the error. A form error answers the person's own submit, so
 * it always focuses the field at fault. Network and server errors name no field, since the entries may be right.
 */
function showConnectionError(message: string, field: keyof typeof fields | null, kind: 'read' | 'form'): void {
  const active = document.activeElement as HTMLElement | null;
  clearConnectionError();
  connectionErrorKind = kind;
  connectionError.textContent = message;
  connectionError.hidden = false;
  // The ID fields show only for an older console; an error in one of them shows them.
  if (field === 'orgId' || field === 'appId') { idsOrigin = chosenOrigin(); idsUnsure = false; }
  idFields.hidden = !idsShown();
  const input = field ? fields[field] : null;
  input?.setAttribute('aria-invalid', 'true');
  // A read failure waits here for the settings: with them closed, the view in front says it (main.ts, insert.ts).
  if (kind === 'read' && !settings.open) return;
  announceError(message);
  settings.open = true;
  const keepFocus = kind === 'read' && inField(active);
  // A field focused here is not the person's work in progress (settingsInUse).
  if (input && !keepFocus) { input.focus(); focusMark = input; }
  connectionError.scrollIntoView({ block: 'nearest' });
  if (keepFocus && active) active.scrollIntoView({ block: 'nearest' });
}

/**
 * A failed authenticated read: the chip shows a warning. Nothing opens by itself; the failure is said where it happened
 * (the Insert list, the Send form, or the error line). `problem` is why, for the token field: it shows there when the
 * settings are open (now, or once the person opens them), and the view's own copy then steps aside.
 */
export function needsAttention(problem?: { text: string; field: 'token' | null }): void {
  state.attentionCount += 1;
  attention = true;
  element('connection-label').textContent = 'Needs attention';
  if (problem) showConnectionError(problem.text, problem.field, 'read');
  scheduleRender();
}

/** Any successful authenticated read: the connection works, so a stale "needs attention" and its error go. */
export function markConnected(): void {
  // Send has no placements yet: load them first, and that read's success comes back here.
  if (!state.placementsLoaded) { void reloadPlacements(); return; }
  attention = false;
  state.testFailure = null;
  element('connection-label').textContent = 'Connected';
  if (connectionErrorKind === 'read') clearConnectionError();
  scheduleRender();
}

function failureOf(result: HttpResult, text: string): ReadFailure {
  return { kind: result.kind === 'ok' || result.kind === 'aborted' ? 'http' : result.kind, status: result.status, text };
}

/**
 * The saved connection's names, asked again once a session (GET /api/token, tried once): a connection saved before the
 * console named apps, or a workspace or app renamed since, shows today's names, and main saves them. Any failure, a
 * console without names, or an answer about another app changes nothing and says nothing.
 */
async function refreshNames(config: Connection, generation: number): Promise<void> {
  const ticket = identifyTicket;
  // A Disconnect, a save, or a pasted token waiting for its answer replaces this connection (a connection change also
  // aborts the request): its names would only write it back. It may come back (Undo, a refused save), so its next
  // passing test asks again.
  const askAgain = () => { if (namesAsked === namesKey(config)) namesAsked = ''; };
  let result: HttpResult;
  try { result = await identify(config.origin, config.token); } catch { return; }
  if (result.kind === 'aborted') { askAgain(); return; }
  if (result.status !== 200) return;
  if (generation !== state.connectionGeneration || ticket !== identifyTicket || pendingDisconnect !== null || pendingConnection !== null
    || state.connection === null || namesKey(state.connection) !== namesKey(config)) { askAgain(); return; }
  let identity: ReturnType<typeof parseTokenIdentity>;
  try { identity = parseTokenIdentity(result.payload); } catch { return; }
  const { workspaceName, appName } = identity;
  const current = state.connection;
  if (identity.orgId !== config.orgId || identity.appId !== config.appId || !appName) return;
  if ((current.workspaceName ?? null) === workspaceName && current.appName === appName) return;
  const { origin, orgId, appId, token } = current;
  state.connection = { origin, orgId, appId, token, ...(workspaceName ? { workspaceName } : {}), appName };
  namesPosted = { key: namesKey(config), workspaceName, appName };
  post({ type: 'save-names', connectionGeneration: generation, orgId, appId, workspaceName, appName });
  scheduleRender();
}

/**
 * The connection test: reads placements for Send, and says whether the connection works. Resolves with why it failed,
 * so the Insert list can say the same, or null.
 */
export async function loadPlacements(): Promise<ReadFailure | null> {
  const config = state.connection;
  const generation = state.connectionGeneration;
  if (!config) return null;
  clearError();
  clearConnectionError();
  setStatus('Testing connection…');
  state.ops.connecting = true;
  markFocus();
  scheduleRender();
  let failure: ReadFailure | null = null;
  try {
    const result = await send(config, { path: 'placements' });
    if (generation !== state.connectionGeneration || result.kind === 'aborted') return null;
    if (result.status !== 200) {
      failure = failureOf(result, readFailure(result, config));
      throw new Error(failure.text);
    }
    try { showPlacements(parsePlacements(result.payload)); }
    catch (error) { failure = { kind: 'invalid', status: 200, text: errorText(error) }; throw error; }
    markConnected();
    if (generation !== null && namesAsked !== namesKey(config)) { namesAsked = namesKey(config); void refreshNames(config, generation); }
    // The test passed, so the settings close, unless the person is working in them (the fields stay live while it runs).
    if (!settingsInUse()) closeSettings();
    const count = state.placements.length;
    const available = count ? `${count} placement${count === 1 ? '' : 's'} available.` : 'No placements yet. Placements come from your app’s code.';
    if (announceConnected) {
      announceConnected = false;
      const label = connectedTo(config);
      post({ type: 'notify', text: `Connected to ${label}` });
      setStatus(`Connected to ${label}. ${available}`);
    } else setStatus(`Connected. ${available}`);
    return null;
  } catch (error) {
    if (generation !== state.connectionGeneration) return null;
    announceConnected = false;
    clearPlacements('Placements didn’t load');
    setStatus('');
    failure ??= { kind: 'invalid', status: 0, text: errorText(error) };
    state.testFailure = failure;
    // A refused token is the field at fault; a network or server error leaves the entries unmarked. Said under the token
    // field when the settings are open, else by the view in front (main.ts).
    const status = failure.status;
    needsAttention({ text: errorText(error), field: status === 401 || status === 403 ? 'token' : null });
    return failure;
  } finally {
    if (generation === state.connectionGeneration) { state.ops.connecting = false; scheduleRender(); }
  }
}

/**
 * Another read succeeded after the connection test failed (the network came back, say), so Send still has no
 * placements. Reads them without the test's status or busy state; success finishes markConnected, failure changes
 * nothing and waits 15 s before another try.
 */
async function reloadPlacements(): Promise<void> {
  const config = state.connection;
  const generation = state.connectionGeneration;
  if (!config || generation === null || reloadingPlacements === generation || Date.now() < placementsRetryAt) return;
  reloadingPlacements = generation;
  const attentionAt = state.attentionCount;
  try {
    // Tried once: the 15 s wait below is this read's own retry rule.
    const result = await send(config, { path: 'placements', retry: false });
    if (generation !== state.connectionGeneration || result.kind === 'aborted') return;
    if (result.status !== 200) throw new Error(readFailure(result, config));
    showPlacements(parsePlacements(result.payload));
    // A read that failed meanwhile keeps its "needs attention".
    if (attentionAt === state.attentionCount) markConnected();
  } catch {
    if (generation === state.connectionGeneration) placementsRetryAt = Date.now() + 15000;
  } finally { if (reloadingPlacements === generation) reloadingPlacements = null; }
}

/** Main's `connection` message: the saved connection, or none, and a new generation. */
export function applyConnection(message: Extract<MainMessage, { type: 'connection' }>): void {
  pendingConnection = null;
  // A token being identified for the connection this replaces is no longer wanted.
  identifyTicket += 1;
  clearRememberedSelection();
  state.connection = message.connection;
  state.connectionGeneration = message.connectionGeneration;
  const back = message.connection;
  if (back && namesPosted?.key === namesKey(back) && namesAsked === namesPosted.key
    && ((back.workspaceName ?? null) !== namesPosted.workspaceName || back.appName !== namesPosted.appName)) namesAsked = '';
  state.placements = [];
  state.placementsLoaded = false;
  state.testFailure = null;
  placementsRetryAt = 0;
  attention = false;
  element('connection-label').textContent = '';
  token.value = '';
  const { connection } = state;
  if (connection) {
    origin.value = connection.origin; orgId.value = connection.orgId; appId.value = connection.appId;
  } else {
    // Disconnected: the first-run screen, with nothing left from the connection, not even an older console's ID fields.
    announceConnected = false;
    idsOrigin = null;
    idsUnsure = false;
    orgId.value = ''; appId.value = '';
    if (pendingDisconnect !== null) { pendingDisconnect = null; setStatus(DISCONNECTED); }
  }
  scheduleRender();
}

/**
 * Main's error for a save-connection or clear-connection request; false when the error belongs to another operation.
 * For a refused save, main kept the connection it had, so its generation and placements come back and the typed token
 * stays in the field. Main reports the selection again after the error; the caller restarts a list load that ended
 * unseen meanwhile. The error stays under the token field.
 */
export function failConnection(requestId: number, message: string): boolean {
  if (requestId === pendingDisconnect) {
    pendingDisconnect = null;
    showConnectionError(message, null, 'form');
    scheduleRender();
    return true;
  }
  const refused = pendingConnection;
  if (refused?.id !== requestId) return false;
  pendingConnection = null;
  announceConnected = false;
  state.connectionGeneration = refused.generation;
  state.placements = refused.placements;
  if (!token.value) token.value = refused.token;
  state.ops.connecting = false;
  setStatus('');
  showConnectionError(message, null, 'form');
  scheduleRender();
  return true;
}

/** Asks main to save the connection, setting aside what it replaces until main answers. */
function save(next: Connection, typed: string): void {
  token.value = '';
  clearRememberedSelection();
  pendingConnection = { id: nextRequestId(), generation: state.connectionGeneration, placements: state.placements, token: typed };
  state.connectionGeneration = null;
  state.placements = [];
  state.ops.connecting = true;
  announceConnected = true;
  setStatus('Saving connection…');
  post({ type: 'save-connection', requestId: pendingConnection.id, connection: next });
  scheduleRender();
}

/**
 * GET /api/token for a pasted token: the organization and app it belongs to, so nobody copies IDs. Resolves with the
 * connection to save, or null when it showed why not (or a newer request or a connection change replaced it).
 */
async function identifyToken(chosen: string, value: string): Promise<Connection | null> {
  const ticket = ++identifyTicket;
  state.ops.connecting = true;
  setStatus('Connecting…');
  scheduleRender();
  const result = await identify(chosen, value);
  // Whoever replaced this request owns the busy state.
  if (ticket !== identifyTicket || result.kind === 'aborted') return null;
  state.ops.connecting = false;
  scheduleRender();
  try {
    if (result.status === 200) {
      const identity = parseTokenIdentity(result.payload);
      // This console names a token's app, so it needs no IDs after all.
      if (idsOrigin === chosen) { idsOrigin = null; idsUnsure = false; }
      if (!identity.scopes.includes('draft')) throw fieldError(TOKEN_SCOPE, 'token');
      const identified: Connection = { origin: chosen, orgId: identity.orgId, appId: identity.appId, token: value,
        ...(identity.workspaceName ? { workspaceName: identity.workspaceName } : {}), ...(identity.appName ? { appName: identity.appName } : {}) };
      // Its names are today's; the passing test need not ask again.
      namesAsked = namesKey(identified);
      return identified;
    }
    // A console from before GET /api/token answers 404, or nothing a cross-origin page can read: it needs the IDs.
    if (result.kind === 'network' || (result.kind === 'http' && result.status === 404)) { askForIds(result.kind === 'network'); return null; }
    // A revoked token answers 403 here, as an unknown one answers 401.
    if (result.status === 401 || result.status === 403) throw fieldError(TOKEN_REFUSED, 'token');
    throw new Error(readFailure(result, { origin: chosen, orgId: '', appId: '', token: '' }));
  } catch (error) {
    setStatus('');
    showConnectionError(errorText(error), connectionErrorField(error), 'form');
    return null;
  }
}

/** Connect: a pasted token is identified with GET /api/token; a blank one tests the saved connection again. */
async function submit(): Promise<void> {
  if (actionsBlocked()) return;
  // The form stays in view while what it started runs.
  formOpened = true;
  clearError();
  clearConnectionError();
  const current = state.connection;
  const typed = token.value.trim();
  let next: Connection | null;
  try {
    const chosen = normalizeConsoleOrigin(origin.value);
    if (typed) checkTokenFormat(typed);
    // After a network failure the IDs may not be needed after all: with their fields empty, the token is asked about again.
    const askAgain = idsUnsure && Boolean(typed) && !orgId.value.trim() && !appId.value.trim();
    if (idsShown() && !askAgain) {
      // An older console: the organization and app come from the form.
      const sameApp = current && current.origin === chosen && current.orgId === orgId.value.trim() && current.appId === appId.value.trim();
      next = validateConnection({ ...(sameApp && !typed ? current : {}), origin: chosen, orgId: orgId.value, appId: appId.value, token: typed || (sameApp ? current.token : '') });
      // This console just said it can't name a token's app; its passing test need not ask.
      namesAsked = namesKey(next);
    } else if (!typed) {
      // Nothing pasted: test the saved connection again, when it is on this console.
      if (!current || current.origin !== chosen) throw fieldError('Paste a Draft token from Settings › Tokens in the Assetlib console.', 'token');
      next = { ...current };
    } else next = await identifyToken(chosen, typed);
  } catch (error) { showConnectionError(errorText(error), connectionErrorField(error) ?? 'token', 'form'); return; }
  if (next) save(next, typed);
}

export function initConnection(): void {
  // The chip's workspace name is fitted with the font's measures (fitWorkspace), so fit it again once a font loads.
  document.fonts?.addEventListener('loadingdone', () => scheduleRender());
  element<HTMLFormElement>('connection-form').addEventListener('submit', event => {
    event.preventDefault();
    void submit();
  });
  updateButton.addEventListener('click', () => {
    formOpened = true;
    scheduleRender();
    flushRender();
    token.focus();
  });
  disconnectButton.addEventListener('click', () => {
    if (actionsBlocked() || !state.connection || pendingDisconnect !== null) return;
    clearConnectionError();
    pendingDisconnect = nextRequestId();
    post({ type: 'clear-connection', requestId: pendingDisconnect });
    scheduleRender();
  });
  // Choosing another console: the ID fields show only for one that needs them, and an answer about the other is stale.
  origin.addEventListener('change', () => {
    if (connectionErrorKind === 'form') clearConnectionError();
    scheduleRender();
  });
  // Opening or closing the settings moves a read failure between the token field and the view; closed, the menu is a
  // menu again next time.
  settings.addEventListener('toggle', () => {
    if (!settings.open) formOpened = false;
    scheduleRender();
  });
  // Esc closes the open settings (not the first-run screen, which is all there is), and focus returns to the chip.
  settings.addEventListener('keydown', event => {
    if ((event as KeyboardEvent).key !== 'Escape' || !state.connection || !settings.open) return;
    event.preventDefault();
    closeSettings();
  });
}
