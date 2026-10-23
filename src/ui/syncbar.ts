// Linked artwork context on Insert. Outgoing actions open Send's destination review.
import { consoleLink, environmentLabel } from '../shared/index.js';
import { startConnect } from './connect.js';
import { element, flushRender, setBusy, setUnavailable } from './dom.js';
import { isUpdating, linkedArt, linkArtworkMeta, linkStatus, linkUpdate, otherCell, revealPlacement, slotIdOf, updateLinked } from './insert.js';
import { matchRatio, otherDeclaredCell, prefillSend, sendElsewhere, syncBar } from './send.js';
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
// Relaunch opens Send; focus follows once this connection's selection is reported.
let focusOnLaunch = false;
let showSend: () => void = () => {};
let showInsert: () => void = () => {};

export function renderSyncBar(): void {
  shown = syncBar();
  bar.hidden = !shown || state.prefs.tab === 'send';
  if (focusOnLaunch && state.connectionGeneration !== null) {
    if (!state.connection) focusOnLaunch = false;
    else if (state.selectionGeneration === state.connectionGeneration) {
      focusOnLaunch = false;
      element('send').focus();
    }
  }
  if (bar.hidden) return;
  const linked = shown?.kind === 'linked' ? shown : null;
  const ratio = linked?.ratio ?? null;
  const update = linked ? linkUpdate() : null;
  const link = linked?.assetId && state.selection.link?.kind === 'linked' ? state.selection.link : null;
  const artMeta = link ? linkArtworkMeta(link) : null;
  const status = link && linked ? linkStatus(link, linked.cell) : null;
  // The title says what the layer is linked to, in one line; why it can't sync is the meta's sentence, on up to two.
  const title = !shown ? '' : shown.kind === 'linked' || shown.kind === 'removed' ? `Linked to ${shown.key}` : shown.kind === 'copy' ? 'Copy of a linked frame'
    : 'Linked to another workspace';
  const meta = !shown ? '' : shown.kind === 'linked' ? ratio ?? (update ? `${environmentLabel(update.environment)} has different art now` : artMeta ?? (status ? [shown.axes, status].filter(Boolean).join(' · ') : shown.meta)) : shown.kind === 'copy' ? `Copies aren’t linked. Send it to a cell of ${shown.key}.`
    : shown.kind === 'removed' ? `This ${shown.cell ? 'cell' : 'placement'} no longer exists in this app.`
      : shown.hint ? 'Switch to that workspace to send it.' : 'Connect to that workspace to send it.';
  titleButton.textContent = title;
  const revealKey = shown?.kind === 'linked' || shown?.kind === 'copy' ? shown.key : null;
  titleButton.disabled = !revealKey || !state.placements.some(item => item.key === revealKey);
  titleButton.title = !titleButton.disabled && shown && 'key' in shown ? `Show ${shown.key} in the Insert list` : '';
  element('sync-meta').textContent = meta;
  element('sync-meta').hidden = !meta;
  // The whole of what a narrow window shortens, on hover.
  bar.title = update ? `Update Figma layer replaces this layer’s image with ${environmentLabel(update.environment)} artwork. Send to draft opens the outgoing destination for review.`
    : linked ? `${linked.detail}${meta ? ` ${meta}` : ''} Send to draft opens the destination for review.` : [title, meta].filter(Boolean).join(' ');
  bar.setAttribute('data-compact', String(Boolean(linked && !ratio && !artMeta)));
  const art = update?.asset ?? (linked ? linkedArt(linked.key, linked.cell, linked.assetId, linked.environment) : shown?.kind === 'copy' ? linkedArt(shown.key, shown.link, shown.link.assetId, shown.link.environment) : null);
  showThumbnail(thumb, bar.hidden ? null : art);
  // No image to show (another workspace's link, a removed placement, art not loaded yet): no empty square that reads as a broken one.
  element('sync-preview').hidden = !art;
  syncButton.hidden = !linked;
  setBusy(syncButton, 'Send to draft', false);
  setUnavailable(syncButton, actionsBlocked());
  syncButton.title = 'Review the selected layer and its draft destination.';
  updateButton.hidden = !update;
  setBusy(updateButton, isUpdating() ? 'Updating Figma layer…' : 'Update Figma layer', isUpdating());
  updateButton.title = update ? `Replace this Figma layer’s image with ${environmentLabel(update.environment)} artwork. Its crop, size, and position stay the same.` : '';
  setUnavailable(updateButton, !update || actionsBlocked());
  const footer = !element('insert-bar').hidden;
  const recovering = state.tokenRefused && element<HTMLDetailsElement>('settings').open && !state.pairingActive;
  syncButton.className = footer || linked?.ratio || update || recovering ? 'secondary' : 'primary';
  updateButton.className = update && !linked?.ratio ? 'primary small' : 'secondary small';
  if (update) {
    element('insert').className = 'secondary';
  }
  matchButton.className = ratio && (update || (!footer && !recovering)) ? 'primary small' : 'secondary small';
  matchButton.hidden = !ratio;
  setUnavailable(matchButton, actionsBlocked());
  sendButton.hidden = shown?.kind !== 'copy' && shown?.kind !== 'removed';
  sendButton.textContent = shown?.kind === 'copy' ? 'Send…' : 'Send elsewhere…';
  // Another app on this console: Connect, offering that workspace first.
  switchButton.hidden = !(shown?.kind === 'other' && shown.hint);
  const slotId = linked ? slotIdOf(linked.key) : null;
  consoleAnchor.hidden = !(linked && (slotId || linked.assetId) && state.connection) || Boolean(linked?.ratio || update);
  if (linked && state.connection && (slotId || linked.assetId)) consoleAnchor.href = slotId ? consoleLink(state.connection, 'placements', slotId) : consoleLink(state.connection, 'images', linked.assetId!);
}

/** A layer relaunch opens its review; it never sends by itself. */
export function launched(): void { focusOnLaunch = true; showSend(); }

/** On Send the shortcut activates its visible action. On Insert it opens review first. */
export function syncFromKeyboard(): boolean {
  if (state.prefs.tab === 'send' && state.connection) {
    element<HTMLButtonElement>('send').click();
    return true;
  }
  if (!shown || shown.kind !== 'linked' || bar.hidden) return false;
  if (!actionsBlocked()) reviewSend();
  return true;
}

function reviewSend(): void {
  showSend();
  flushRender();
  element('send').focus();
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
  syncButton.addEventListener('click', () => { if (!actionsBlocked()) reviewSend(); });
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
    element(current.kind === 'copy' ? ['state', 'appearance', 'arm'].find(id => !element(`${id}-label`).hidden) ?? 'send' : 'placement-toggle').focus();
  });
}
