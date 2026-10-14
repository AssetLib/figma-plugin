// The Sync bar, pinned above the footer on both tabs whenever the selected layer is linked or remembered: what it is
// linked to and Sync to draft, or why it can't sync (a ratio that's off, a placement that's gone, a Cmd+D copy, another
// app's link) with the one action that helps. Opened from a layer's Sync to Assetlib button, the plugin focuses it.
import { consoleLink, environmentLabel } from '../shared/index.js';
import { startConnect } from './connect.js';
import { element, flushRender, setBusy, setStatus, setUnavailable } from './dom.js';
import { isUpdating, linkedArt, linkArtworkMeta, linkStatus, linkUpdate, otherCell, revealPlacement, slotIdOf, updateLinked } from './insert.js';
import { announceSyncTarget, beginSync, matchRatio, otherDeclaredCell, prefillSend, sendElsewhere, sendOtherCell, sendRatioPlacement, syncAvailable, syncBar } from './send.js';
import type { SyncBar } from './send.js';
import { actionsBlocked, state } from './state.js';
import { showThumbnail } from './thumbnails.js';

const bar = element('selection-bar');
const syncButton = element<HTMLButtonElement>('sync');
const updateButton = element<HTMLButtonElement>('sync-update');
const titleButton = element<HTMLButtonElement>('sync-title');
const matchButton = element<HTMLButtonElement>('sync-match');
const sendButton = element<HTMLButtonElement>('sync-send');
const switchButton = element<HTMLButtonElement>('sync-switch');
const consoleAnchor = element<HTMLAnchorElement>('sync-console');
const thumb = element<HTMLImageElement>('sync-thumb');

let shown: SyncBar | null = null;
// Opened from the Sync to Assetlib button: the bar takes focus once the selection is reported.
let focusOnLaunch = false;
let showSend: () => void = () => {};
let showInsert: () => void = () => {};

export function renderSyncBar(): void {
  shown = syncBar();
  bar.hidden = !shown;
  const linked = shown?.kind === 'linked' ? shown : null;
  // The chosen placement's ratio is Send's callout; the bar says it only for another placement, or on Insert.
  const ratio = linked?.ratio && !(state.prefs.tab === 'send' && linked.placement && sendRatioPlacement()?.key === linked.placement.key) ? linked.ratio : null;
  const update = linked ? linkUpdate() : null;
  const link = linked?.assetId && state.selection.link?.kind === 'linked' ? state.selection.link : null;
  const artMeta = link ? linkArtworkMeta(link) : null;
  const status = link && linked ? linkStatus(link, linked.cell) : null;
  // The title says what the layer is linked to, in one line; why it can't sync is the meta's sentence, on up to two.
  const title = !shown ? '' : shown.kind === 'linked' || shown.kind === 'removed' ? `Linked to ${shown.key}` : shown.kind === 'copy' ? 'Copy of a linked frame'
    : 'Linked to another workspace';
  const meta = !shown ? '' : shown.kind === 'linked' ? ratio ?? (update ? `${environmentLabel(update.environment)} has different art now` : artMeta ?? (status ? [shown.axes, status].filter(Boolean).join(' · ') : shown.meta)) : shown.kind === 'copy' ? `Copies aren’t linked. Send it to a cell of ${shown.key}.`
    : shown.kind === 'removed' ? `This ${shown.cell ? 'cell' : 'placement'} no longer exists in this app.`
      : shown.hint ? 'Switch to that workspace to sync it.' : 'Connect to that workspace to sync it.';
  titleButton.textContent = title;
  const revealKey = shown?.kind === 'linked' || shown?.kind === 'copy' ? shown.key : null;
  titleButton.disabled = !revealKey || !state.placements.some(item => item.key === revealKey);
  titleButton.title = !titleButton.disabled && shown && 'key' in shown ? `Show ${shown.key} in the Insert list` : '';
  element('sync-meta').textContent = meta;
  element('sync-meta').hidden = !meta;
  // The whole of what a narrow window shortens, on hover.
  bar.title = update ? `Update puts this ${environmentLabel(update.environment)} art in the layer. Sync updates Draft only; publishing stays in the console.`
    : linked ? `${linked.detail}${meta ? ` ${meta}` : ''} Sync updates Draft only; publishing stays in the console.` : [title, meta].filter(Boolean).join(' ');
  bar.setAttribute('data-compact', String(Boolean(linked && !ratio && !artMeta)));
  const art = update?.asset ?? (linked ? linkedArt(linked.key, linked.cell, linked.assetId, linked.environment) : shown?.kind === 'copy' ? linkedArt(shown.key, shown.link, shown.link.assetId, shown.link.environment) : null);
  showThumbnail(thumb, bar.hidden ? null : art);
  // No image to show (another workspace's link, a removed placement, art not loaded yet): no empty square that reads as a broken one.
  element('sync-preview').hidden = !art;
  syncButton.hidden = !linked;
  setBusy(syncButton, state.ops.syncing ? 'Syncing…' : 'Sync to draft', state.ops.syncing);
  setUnavailable(syncButton, !syncAvailable());
  syncButton.title = update ? 'Sync replaces Draft’s art for this cell with this layer.' : '';
  updateButton.hidden = !update;
  setBusy(updateButton, isUpdating() ? 'Updating…' : 'Update', isUpdating());
  setUnavailable(updateButton, !update || actionsBlocked());
  // One ink primary in view: on Insert, the footer's Insert while something is chosen; while the ratio blocks Sync, Match
  // ratio, the one action that helps.
  const footer = state.prefs.tab === 'insert' && !element('insert-bar').hidden;
  const recovering = state.tokenRefused && element<HTMLDetailsElement>('settings').open && !state.pairingActive;
  syncButton.className = footer || linked?.ratio || update || recovering || sendOtherCell() ? 'secondary' : 'primary';
  updateButton.className = update && !linked?.ratio ? 'primary small' : 'secondary small';
  element('match-ratio').className = update && linked?.ratio && !ratio ? 'primary small' : 'secondary small';
  if (update) {
    element('insert').className = 'secondary';
    element('send').className = 'secondary';
  }
  matchButton.className = ratio && (update || (!footer && !recovering && !sendOtherCell())) ? 'primary small' : 'secondary small';
  matchButton.hidden = !ratio;
  setUnavailable(matchButton, actionsBlocked());
  sendButton.hidden = shown?.kind !== 'copy' && shown?.kind !== 'removed';
  sendButton.textContent = shown?.kind === 'copy' ? 'Send…' : 'Send elsewhere…';
  // Another app on this console: Connect, offering that workspace first.
  switchButton.hidden = !(shown?.kind === 'other' && shown.hint);
  const slotId = linked ? slotIdOf(linked.key) : null;
  consoleAnchor.hidden = !(linked && (slotId || linked.assetId) && state.connection) || Boolean(linked?.ratio || update);
  if (linked && state.connection && (slotId || linked.assetId)) consoleAnchor.href = slotId ? consoleLink(state.connection, 'placements', slotId) : consoleLink(state.connection, 'images', linked.assetId!);
  if (focusOnLaunch && state.connectionGeneration !== null) {
    // Without a connection (the first-run screen) there is nothing to focus.
    if (!state.connection) focusOnLaunch = false;
    else if (state.selectionGeneration === state.connectionGeneration) {
      focusOnLaunch = false;
      if (shown) ([matchButton, updateButton, syncButton, sendButton, switchButton].find(button => !button.hidden) ?? bar).focus();
    }
  }
}

/** The plugin opened from a linked layer's Sync to Assetlib button. It focuses the bar; it never syncs by itself. */
export function launched(): void { focusOnLaunch = true; }

/** Cmd+Enter (Ctrl+Enter off Apple platforms): Sync while the bar offers it. False when the bar doesn't, so the key is left alone. */
export function syncFromKeyboard(): boolean {
  if (!shown || shown.kind !== 'linked' || bar.hidden) return false;
  if (linkUpdate()) { setStatus('Update first, or choose Sync to draft to replace Draft’s art with this layer.'); return true; }
  if (sendOtherCell()) { announceSyncTarget(); return true; }
  if (syncAvailable()) beginSync();
  return true;
}

export function initSyncBar(actions: { showSend: () => void; showInsert: () => void }): void {
  showSend = actions.showSend;
  showInsert = actions.showInsert;
  titleButton.addEventListener('click', () => {
    if (titleButton.disabled) return;
    const current = shown;
    if (current?.kind !== 'linked' && current?.kind !== 'copy') return;
    showInsert();
    revealPlacement(current.key, current.kind === 'linked' ? current.cell : current.link, current.kind === 'linked' ? current.environment : current.link.environment);
  });
  updateButton.addEventListener('click', () => { void updateLinked(); });
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
