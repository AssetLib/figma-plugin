// The UI iframe: routes main's messages to the Send, Insert, and connection modules, and renders them once per frame.
import type { MainMessage } from '../shared/protocol.js';
import { applyConnection, failConnection, initConnection, loadPlacements, openSettings, problemInSettings, renderConnection } from './connection.js';
import { element, post, scheduleRender, setRenderer, setStatus, showError } from './dom.js';
import { abortAll } from './http.js';
import {
  applyPreferences, connectionKept, enterInsert, failInsert, initInsert, inserted, listUnavailable, renderInsertBar, renderInsertControls, renderList, resetInsert,
  rowFor, savePreferences,
} from './insert.js';
import { applyFileUrl, applySelection, failSend, fileSaved, initSend, presentSendProblem, remembered, renderSend, sendExport } from './send.js';
import { actionsBlocked, state } from './state.js';
import type { ReadFailure } from './state.js';

const app = element('app');
const tabSend = element<HTMLButtonElement>('tab-send');
const tabInsert = element<HTMLButtonElement>('tab-insert');
const searchInput = element<HTMLInputElement>('insert-search');
const tokenInput = element<HTMLInputElement>('token');

function render(): void {
  const { tab } = state.prefs;
  // Without a connection there is only the first-run screen: no tabs, no lists, no footers.
  const firstRun = !state.connection;
  app.setAttribute('data-view', firstRun ? 'first-run' : 'shell');
  tabSend.setAttribute('aria-selected', String(tab === 'send'));
  tabInsert.setAttribute('aria-selected', String(tab === 'insert'));
  element('panel-send').hidden = firstRun || tab !== 'send';
  element('panel-insert').hidden = firstRun || tab !== 'insert';
  element('send-bar').hidden = firstRun || tab !== 'send';
  renderConnection();
  renderSend(problemInSettings());
  renderInsertControls();
  renderInsertBar();
}
setRenderer({
  render, renderList, twin: rowFor,
  // A control that disappears hands focus to the token field on the first-run screen, the search field on Insert, else
  // the current tab, never to the page.
  fallback: () => !state.connection ? tokenInput
    : state.prefs.tab === 'insert' && !searchInput.disabled ? searchInput : state.prefs.tab === 'insert' ? tabInsert : tabSend,
});

function onConnection(message: Extract<MainMessage, { type: 'connection' }>): void {
  // A connection change ends every request in flight: lists, previews, downloads, and drafts.
  abortAll();
  applyConnection(message);
  applyFileUrl(message.savedFileUrl);
  applyPreferences(message.preferences);
  resetInsert();
  if (!state.connection) {
    state.ops.connecting = false;
    scheduleRender();
    return;
  }
  testConnection();
}

/** The connection test (reading Send's placements), then the Insert list; Send's Try again runs it again. */
function testConnection(): void {
  const generation = state.connectionGeneration;
  void loadPlacements().then(failure => {
    if (generation !== state.connectionGeneration) return;
    if (state.placementsLoaded) enterInsert(); else testFailed(failure);
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
  if (failConnection(id, message.message)) { connectionKept(); return; }
  if (failSend(id, message.message)) return;
  failInsert(id, message.message);
}

window.onmessage = (event: MessageEvent<{ pluginMessage?: MainMessage }>) => {
  // Figma posts plugin messages from its top window, not from the iframe's direct parent (a shim iframe).
  if (event.source !== parent && event.source !== top) return;
  const message = event.data?.pluginMessage;
  if (!message) return;
  switch (message.type) {
    case 'connection': onConnection(message); break;
    case 'selection': applySelection(message); break;
    case 'file-saved': fileSaved(message); break;
    case 'exported': void sendExport(message); break;
    case 'remembered': remembered(message); break;
    case 'inserted': inserted(message); break;
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
}
tabSend.addEventListener('click', () => setTab('send'));
tabInsert.addEventListener('click', () => setTab('insert'));
initConnection();
initSend({ retry: () => { if (!actionsBlocked()) testConnection(); }, updateToken: openSettings });
initInsert(() => { setTab('send'); tabSend.focus(); });
post({ type: 'init' });
