// The Sync bar, pinned above the footer on both tabs whenever the selected layer is linked or remembered: what it is
// linked to and Sync to draft, or why it can't sync (a ratio that's off, a placement that's gone, a Cmd+D copy, another
// app's link) with the one action that helps. Opened from a layer's Sync to Assetlib button, the plugin focuses it.
import { consoleLink } from '../shared/index.js';
import { startConnect } from './connect.js';
import { element, flushRender, setBusy, setUnavailable } from './dom.js';
import { linkedArt, otherCell } from './insert.js';
import { announceSyncTarget, beginSync, matchRatio, otherDeclaredCell, prefillSend, sendElsewhere, sendOtherCell, sendRatioPlacement, syncAvailable, syncBar } from './send.js';
import type { SyncBar } from './send.js';
import { actionsBlocked, state } from './state.js';
import { showThumbnail } from './thumbnails.js';

const bar = element('selection-bar');
const syncButton = element<HTMLButtonElement>('sync');
const matchButton = element<HTMLButtonElement>('sync-match');
const sendButton = element<HTMLButtonElement>('sync-send');
const switchButton = element<HTMLButtonElement>('sync-switch');
const consoleAnchor = element<HTMLAnchorElement>('sync-console');
const thumb = element<HTMLImageElement>('sync-thumb');

let shown: SyncBar | null = null;
// Opened from the Sync to Assetlib button: the bar takes focus once the selection is reported.
let focusOnLaunch = false;
let showSend: () => void = () => {};

export function renderSyncBar(): void {
  shown = syncBar();
  bar.hidden = !shown;
  const linked = shown?.kind === 'linked' ? shown : null;
  // The chosen placement's ratio is Send's callout; the bar says it only for another placement, or on Insert.
  const ratio = linked?.ratio && !(state.prefs.tab === 'send' && linked.placement && sendRatioPlacement()?.key === linked.placement.key) ? linked.ratio : null;
  // The title says what the layer is linked to, in one line; why it can't sync is the meta's sentence, on up to two.
  const title = !shown ? '' : shown.kind === 'linked' || shown.kind === 'removed' ? `Linked to ${shown.key}` : shown.kind === 'copy' ? 'Copy of a linked frame'
    : 'Linked to another workspace';
  const meta = !shown ? '' : shown.kind === 'linked' ? ratio ?? shown.meta : shown.kind === 'copy' ? `Copies aren’t linked. Send it to a cell of ${shown.key}.`
    : shown.kind === 'removed' ? `This ${shown.cell ? 'cell' : 'placement'} no longer exists in this app.`
      : shown.hint ? 'Switch to that workspace to sync it.' : 'Connect to that workspace to sync it.';
  element('sync-title').textContent = title;
  element('sync-meta').textContent = meta;
  element('sync-meta').hidden = !meta;
  // The whole of what a narrow window shortens, on hover.
  bar.title = linked ? `${linked.detail}${ratio ? ` ${ratio}` : ''} Sync updates Draft only; publishing stays in the console.` : [title, meta].filter(Boolean).join(' ');
  const art = linked ? linkedArt(linked.key, linked.cell, linked.assetId) : shown?.kind === 'copy' ? linkedArt(shown.key, shown.link, shown.link.assetId) : null;
  showThumbnail(thumb, bar.hidden ? null : art);
  // No image to show (another workspace's link, a removed placement, art not loaded yet): no empty square that reads as a broken one.
  element('sync-preview').hidden = !art;
  syncButton.hidden = !linked;
  setBusy(syncButton, state.ops.syncing ? 'Syncing…' : 'Sync to draft', state.ops.syncing);
  setUnavailable(syncButton, !syncAvailable());
  // One ink primary in view: on Insert, the footer's Insert while something is chosen; while the ratio blocks Sync, Match
  // ratio, the one action that helps.
  const footer = state.prefs.tab === 'insert' && !element('insert-bar').hidden;
  const recovering = state.tokenRefused && element<HTMLDetailsElement>('settings').open && !state.pairingActive;
  syncButton.className = footer || ratio || recovering || sendOtherCell() ? 'secondary' : 'primary';
  matchButton.className = ratio && !footer && !recovering && !sendOtherCell() ? 'primary small' : 'secondary small';
  matchButton.hidden = !ratio;
  setUnavailable(matchButton, actionsBlocked());
  sendButton.hidden = shown?.kind !== 'copy' && shown?.kind !== 'removed';
  sendButton.textContent = shown?.kind === 'copy' ? 'Send…' : 'Send elsewhere…';
  // Another app on this console: Connect, offering that workspace first.
  switchButton.hidden = !(shown?.kind === 'other' && shown.hint);
  consoleAnchor.hidden = !(linked?.assetId && state.connection) || Boolean(ratio);
  if (linked?.assetId && state.connection) consoleAnchor.href = consoleLink(state.connection, 'images', linked.assetId);
  if (focusOnLaunch && state.connectionGeneration !== null) {
    // Without a connection (the first-run screen) there is nothing to focus.
    if (!state.connection) focusOnLaunch = false;
    else if (state.selectionGeneration === state.connectionGeneration) {
      focusOnLaunch = false;
      if (shown) ([syncButton, sendButton, matchButton, switchButton].find(button => !button.hidden) ?? bar).focus();
    }
  }
}

/** The plugin opened from a linked layer's Sync to Assetlib button. It focuses the bar; it never syncs by itself. */
export function launched(): void { focusOnLaunch = true; }

/** Cmd+Enter (Ctrl+Enter off Apple platforms): Sync while the bar offers it. False when the bar doesn't, so the key is left alone. */
export function syncFromKeyboard(): boolean {
  if (!shown || shown.kind !== 'linked' || bar.hidden) return false;
  if (sendOtherCell()) { announceSyncTarget(); return true; }
  if (syncAvailable()) beginSync();
  return true;
}

export function initSyncBar(actions: { showSend: () => void }): void {
  showSend = actions.showSend;
  syncButton.addEventListener('click', () => beginSync());
  matchButton.addEventListener('click', () => { if (shown?.kind === 'linked' && shown.placement && !actionsBlocked()) matchRatio(shown.placement); });
  switchButton.addEventListener('click', () => { if (shown?.kind === 'other' && shown.hint) void startConnect(shown.hint); });
  // A copy prefers another cell without its own Draft art; a removed target needs a placement chosen by the person.
  sendButton.addEventListener('click', () => {
    const current = shown;
    if (current?.kind === 'copy') {
      const cell = otherCell(current.key, current.link) ?? otherDeclaredCell(state.placements.find(item => item.key === current.key), current.link) ?? current.link;
      prefillSend({ placementKey: current.key, ...cell });
    } else if (current?.kind === 'removed') sendElsewhere();
    else return;
    showSend();
    flushRender();
    element(current.kind === 'copy' ? ['state', 'appearance', 'arm'].find(id => !element(`${id}-label`).hidden) ?? 'send' : 'placement').focus();
  });
}
