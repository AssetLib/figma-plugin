// The UI iframe: routes main's messages to the Send, Insert, Sync bar, connection, and Connect modules, renders them
// once per frame, and resizes the window from its grip.
import { TOKEN_NO_LONGER_ACCEPTED, clampWindow } from '../shared/index.js';
import type { MainMessage } from '../shared/protocol.js';
import { adopted, applyPairing, connectFocus, failOpenPage, hintOfCurrent, initConnect, releaseHeld, renderConnect, saveRefused, startConnect, turned } from './connect.js';
import { applyConnection, failConnection, initConnection, loadPlacements, needsAttention, openSettings, problemInSettings, renderConnection } from './connection.js';
import { COMMAND, arrowKeys, element, failConsolePage, inField, post, reloaded, rovingStops, scheduleRender, setRenderer, setStatus, showError } from './dom.js';
import { acceptFileLinks, failFileScan, focusFile } from './infile.js';
import { abortAll } from './http.js';
import {
  applyPreferences, beginArtworkRead, connectionKept, draftArtState, draftSnapshot, dropped, ensureArtwork, enterInsert, failDrop, failInsert, focusSearch, initInsert, inserted, listUnavailable, renderInsertBar, restoreBrowseScroll,
  noteLinkSeen, refreshArtworkIfStale, renderInsertControls, renderList, renderSendCurrent, reviewSendArtwork, resetInsert, rowFor, savePreferences, sendImpact,
} from './insert.js';
import { applyFileUrl, applySelection, choiceSaved, failSend, fileMismatch, fileSaved, initSend, presentSendProblem, remembered, renderSend, sendExport, sendHidden } from './send.js';
import { initPlacementPicker, placementSearchChanged, renderPlacementPicker } from './send-picker.js';
import { acceptSelectionPreview, initSendPreview, renderSendPreview } from './send-preview.js';
import { actionsBlocked, state } from './state.js';
import { initInspector, renderInspection } from './inspector.js';
import { initIntake, renderIntake } from './intake.js';
import { renderSendConflicts } from './send-conflicts.js';
import { initSyncBar, launched, renderSyncBar, syncFromKeyboard } from './syncbar.js';
import type { ReadFailure } from './state.js';

const app = element('app');
const tabSend = element<HTMLButtonElement>('tab-send');
const tabInsert = element<HTMLButtonElement>('tab-insert');
const searchInput = element<HTMLInputElement>('insert-search');
let menuCommand: 'insert' | 'send' | 'sync' | null = null;

function render(): void {
  // Until main's first connection message (which also brings the preferences) the connection is unknown, not absent:
  // the page stays as ui.html draws it, so a render then (the window sizing, a font loading) never shows the first-run
  // screen, which would leave the connection settings open over the saved connection.
  if (!state.preferencesLoaded) return;
  // A Connect request's connection, held while a Send, Sync, or Insert ran, is saved once it ended.
  releaseHeld();
  const { tab } = state.prefs;
  // Without a connection there is only the first-run screen: no tabs, no lists, no footers.
  const firstRun = !state.connection;
  app.setAttribute('data-view', firstRun ? 'first-run' : 'shell');
  tabSend.setAttribute('aria-selected', String(tab === 'send'));
  tabInsert.setAttribute('aria-selected', String(tab === 'insert'));
  rovingStops([tabInsert, tabSend]);
  element('panel-send').hidden = firstRun || tab !== 'send';
  element('panel-insert').hidden = firstRun || tab !== 'insert';
  element('send-bar').hidden = firstRun || tab !== 'send' || sendHidden();
  renderConnection();
  renderConnect();
  renderSend(problemInSettings());
  renderSendCurrent();
  renderSendPreview();
  renderSendConflicts();
  renderPlacementPicker();
  renderInsertControls();
  renderInsertBar();
  renderSyncBar();
  renderInspection();
  renderIntake();
  restoreBrowseScroll();
}
setRenderer({
  render, renderList, twin: rowFor,
  // A control that disappears hands focus to a Connect request's block, or on the first-run screen to Connect to
  // Assetlib (the token field once that form is chosen), else the search field on Insert, else the current tab, never
  // to the page.
  fallback: () => connectFocus()
    ?? (state.prefs.tab === 'insert' && !searchInput.disabled ? searchInput : state.prefs.tab === 'insert' ? tabInsert : tabSend),
});

function onConnection(message: Extract<MainMessage, { type: 'connection' }>): void {
  // A connection change ends every request in flight: lists, previews, downloads, and drafts.
  abortAll();
  applyConnection(message);
  applyFileUrl(message.savedFileUrl);
  applyPreferences(message.preferences);
  resetInsert();
  // A Connect request's connection arrived, or main holds a request to resume.
  applyPairing(message);
  if (!state.connection) {
    state.ops.connecting = false;
    runMenuCommand();
    scheduleRender();
    return;
  }
  testConnection();
  // After the test started (ops.connecting), so the command's tab waits for it instead of loading its own lists.
  runMenuCommand();
}
/** Main sends launch before the saved preferences; the requested tab applies once they and the connection arrived. */
function runMenuCommand(): void {
  if (menuCommand) { const command = menuCommand; menuCommand = null; launch(command); }
}

/** The connection test (reading Send's placements), then the Insert list; Send's Try again runs it again. */
function testConnection(): void {
  const generation = state.connectionGeneration;
  void loadPlacements().then(failure => {
    if (generation !== state.connectionGeneration) return;
    if (state.placementsLoaded) { enterInsert(); ensureArtwork(); } else testFailed(failure);
  });
}

/**
 * The connection test failed, and it is said once: under the token field while the settings are open (connection.ts),
 * else by the view in front, which announces it and takes focus unless the person is in a field. The Insert list and the
 * Send form each keep it for when they show; nothing opens by itself.
 */
function testFailed(failure: ReadFailure | null): void {
  const inFront = !problemInSettings();
  listUnavailable(failure, inFront && state.prefs.tab === 'insert');
  if (inFront && state.prefs.tab === 'send') presentSendProblem();
}

function onError(message: Extract<MainMessage, { type: 'error' }>): void {
  const id = message.requestId;
  // An error ends only the operation it names. One without a request id leaves running work alone.
  if (id === undefined) { showError(message.message); return; }
  // A reply for an operation that already ended matches nothing and is dropped.
  // A refused connection save leaves the connection as it was; the Insert list picks up what the wait dropped.
  if (failConnection(id, message.message)) { connectionKept(); saveRefused(id); return; }
  if (failFileScan(id, message.message)) return;
  if (failOpenPage(id)) return;
  if (failConsolePage(id)) return;
  if (failSend(id, message.message)) return;
  if (failInsert(id, message.message)) return;
  failDrop(id, message.message);
}

window.onmessage = (event: MessageEvent<{ pluginMessage?: MainMessage }>) => {
  // Figma posts plugin messages from its top window, not from the iframe's direct parent (a shim iframe).
  if (event.source !== parent && event.source !== top) return;
  const message = event.data?.pluginMessage;
  if (!message) return;
  switch (message.type) {
    case 'connection': onConnection(message); break;
    case 'selection':
      applySelection(message);
      if (message.connectionGeneration === state.connectionGeneration) noteLinkSeen();
      break;
    case 'file-links': acceptFileLinks(message); break;
    case 'selection-preview': acceptSelectionPreview(message); break;
    case 'file-saved': fileSaved(message); break;
    case 'send-choice-saved': choiceSaved(message); break;
    case 'file-mismatch': fileMismatch(message); break;
    case 'launch': launch(message.command); break;
    case 'exported': void sendExport(message); break;
    case 'remembered': remembered(message); break;
    case 'inserted': inserted(message); break;
    case 'dropped': dropped(message); break;
    case 'adopted': if (!reloaded(message)) adopted(message); break;
    case 'turn': turned(message); break;
    case 'error': onError(message); break;
  }
};

function setTab(next: typeof state.prefs.tab): void {
  if (state.prefs.tab === next) return;
  state.prefs.tab = next;
  // A running operation keeps its status line.
  if (!actionsBlocked()) setStatus('');
  savePreferences();
  scheduleRender();
  enterInsert();
  if (next === 'send') ensureArtwork();
}
function launch(command: Extract<MainMessage, { type: 'launch' }>['command']): void {
  if (!state.preferencesLoaded) { menuCommand = command; return; }
  if (command === 'sync') { launched(); return; }
  setTab(command);
  if (command === 'insert' && state.connection) focusSearch();
}
tabSend.addEventListener('click', () => setTab('send'));
tabInsert.addEventListener('click', () => setTab('insert'));
// ← and → (Home and End) move between the tabs and show the one they reach.
arrowKeys(element('tabs'), [tabInsert, tabSend], 'tabs');
// / (outside a field) or Cmd+F focuses the search, from either tab. Off Apple platforms it is Ctrl+F; on them Ctrl+F moves the caret.
// Cmd+Enter (Ctrl+Enter) syncs while the Sync bar offers it, except in the connection settings, where Enter connects.
document.addEventListener('keydown', event => {
  if (event.defaultPrevented || !state.connection || event.altKey) return;
  const command = event[COMMAND === 'Cmd' ? 'metaKey' : 'ctrlKey'] && !event.shiftKey;
  if (command && event.key === 'Enter' && !element('settings').contains(event.target as Node | null) && syncFromKeyboard()) {
    event.preventDefault();
    return;
  }
  // A keydown from autofill can lack a key.
  const find = command && String(event.key).toLowerCase() === 'f';
  const slash = event.key === '/' && !event.metaKey && !event.ctrlKey && !inField(event.target as Element | null);
  if (!find && !slash) return;
  event.preventDefault();
  setTab('insert');
  focusSearch();
});

/**
 * The grip in the bottom-right corner. A drag asks main for the size under the pointer, at most once a frame (main
 * clamps it again and resizes); letting go saves the size the drag ended at, if it changed; a double-click asks for the
 * default size and forgets the saved one. Pointer capture keeps the drag going outside the window as it grows.
 */
const grip = element('resize-grip');
type Size = { width: number; height: number };
let resizing: { pointerId: number; dx: number; dy: number; start: string; posted: string; size: Size | null; queued: boolean; frame: number } | null = null;
const sizeKey = (size: Size) => `${size.width}×${size.height}`;
function postSize(drag: NonNullable<typeof resizing>): void {
  if (!drag.size || sizeKey(drag.size) === drag.posted) return;
  drag.posted = sizeKey(drag.size);
  post({ type: 'resize', ...drag.size });
}
grip.addEventListener('pointerdown', event => {
  if (event.button !== 0 || resizing) return;
  // Focus stays where it was, and no text is selected.
  event.preventDefault();
  grip.setPointerCapture(event.pointerId);
  // The pointer keeps its offset from the window's corner, so the window doesn't jump to it.
  const start = sizeKey({ width: window.innerWidth, height: window.innerHeight });
  resizing = { pointerId: event.pointerId, dx: window.innerWidth - event.clientX, dy: window.innerHeight - event.clientY, start, posted: start, size: null, queued: false, frame: 0 };
});
grip.addEventListener('mousedown', event => event.preventDefault());
grip.addEventListener('pointermove', event => {
  const drag = resizing;
  if (!drag || event.pointerId !== drag.pointerId) return;
  drag.size = clampWindow(event.clientX + drag.dx, event.clientY + drag.dy);
  if (drag.queued) return;
  drag.queued = true;
  drag.frame = requestAnimationFrame(() => {
    drag.queued = false;
    postSize(drag);
  });
});
function endResize(event: PointerEvent): void {
  const drag = resizing;
  if (!drag || event.pointerId !== drag.pointerId) return;
  resizing = null;
  if (drag.queued) cancelAnimationFrame(drag.frame);
  if (grip.hasPointerCapture(event.pointerId)) grip.releasePointerCapture(event.pointerId);
  // The last size the pointer asked for, if its frame hadn't come yet.
  postSize(drag);
  if (!drag.size || sizeKey(drag.size) === drag.start) return;
  state.prefs.window = drag.size;
  savePreferences();
}
grip.addEventListener('pointerup', endResize);
grip.addEventListener('pointercancel', endResize);
grip.addEventListener('lostpointercapture', endResize);
grip.addEventListener('dblclick', event => {
  event.preventDefault();
  delete state.prefs.window;
  savePreferences();
  post({ type: 'reset-size' });
});
// A new width can show or hide parts of the top bar (the chip's workspace name), which the render measures.
window.addEventListener('resize', () => scheduleRender());
window.addEventListener('focus', refreshArtworkIfStale);
window.addEventListener('focus', focusFile);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refreshArtworkIfStale(); });

// Figma's Copy link shortcut, as this platform spells it.
element('copy-link-key').textContent = `${COMMAND}+L`;
initConnection();
initIntake(() => setTab('insert'));
initConnect();
const showSend = () => setTab('send');
initPlacementPicker();
initSendPreview();
initInspector();
initSend({ placementSearchChanged, refused: (text = TOKEN_NO_LONGER_ACCEPTED) => needsAttention({ text, field: 'token' }, true), retry: () => { if (!actionsBlocked()) testConnection(); }, updateToken: openSettings, reconnect: () => { void startConnect(hintOfCurrent()); }, showSend, artworkChanged: () => ensureArtwork(true), draftArtState, draftSnapshot, impactSnapshot: (key, cell) => sendImpact(key, cell)?.fingerprint ?? null, reviewArtwork: reviewSendArtwork, beginArtworkRead });
initSyncBar({ showSend, showInsert: () => setTab('insert') });
initInsert(() => { setTab('send'); tabSend.focus(); });
post({ type: 'init' });
