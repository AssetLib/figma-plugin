import { bytesToBase64, pngSize } from '../shared/index.js';
import type { MainMessage } from '../shared/protocol.js';
import { element, post, scheduleRender, setUnavailable } from './dom.js';
import { sendPlacementPreview } from './insert.js';
import { sendChoice } from './send.js';
import { closeInspection, openInspection } from './inspector.js';
import { activateSendRow, activeSendRow, sendRows } from './send-queue.js';
import { releaseThumbnail, showThumbnail } from './thumbnails.js';
import { actionsBlocked, hasCurrentSelection, nextRequestId, state } from './state.js';

const image = element<HTMLImageElement>('send-layer-thumb');
let key = '';
let requestId: number | null = null;
let requested = false;
let expanded = false;
let cacheOwner = '';
const previews = new Map<string, string>();
const rowPreviews = new WeakMap<Element, { root: HTMLElement; local: HTMLImageElement; draft: HTMLImageElement; caption: HTMLElement; inspect: HTMLButtonElement; owner: string }>();
let batchRoots: Element[] = [];
function renderBatchPreviews(): void {
  const list = element('send-items'), rows = sendRows();
  for (const root of batchRoots) if (!list.contains(root)) { const view = rowPreviews.get(root); if (view) releaseThumbnail(view.draft, list); }
  batchRoots = Array.from(list.children);
  for (const root of Array.from(list.children)) {
    const row = rows.find(item => item.node.id === root.getAttribute('data-node-id'));
    if (!row) continue;
    let view = rowPreviews.get(root);
    if (!view) {
      const pair = document.createElement('div'); pair.className = 'send-row-visuals';
      const images = ['Incoming layer', 'Current Draft'].map(label => {
        const item = document.createElement('div'), caption = document.createElement('p'), frame = document.createElement('span'), img = document.createElement('img');
        caption.className = 'meta'; caption.textContent = label; frame.className = 'thumb'; img.alt = label; img.draggable = false;
        frame.append(img); item.append(caption, frame); pair.append(item); return img;
      });
      const caption = document.createElement('p'); caption.className = 'meta';
      const inspect = document.createElement('button'); inspect.type = 'button'; inspect.className = 'text-action'; inspect.textContent = 'Inspect';
      inspect.addEventListener('click', () => {
        if (!list.contains(root) || view!.owner !== `${state.connectionGeneration}:${state.selection.revision}` || !activateSendRow(row.node.id)) return;
        inspectSendPreview(inspect);
      });
      pair.append(caption, inspect); root.append(pair);
      view = { root: pair, local: images[0]!, draft: images[1]!, caption, inspect, owner: '' }; rowPreviews.set(root, view);
    }
    view.owner = cacheOwner;
    view.root.hidden = rows.length < 2 || state.prefs.tab !== 'send' || !hasCurrentSelection();
    const src = !view.root.hidden && localPreviewFor(row.node.id);
    if (src) view.local.src = src; else view.local.removeAttribute('src');
    const draft = row.target && sendPlacementPreview(row.target.slotKey, row.target, true);
    if (view.root.hidden) releaseThumbnail(view.draft, list); else showThumbnail(view.draft, draft?.asset ?? null, list);
    view.caption.textContent = `${src ? 'Local preview' : row.reason ? 'Layer preview unavailable' : 'Inspect to preview layer'} · ${draft?.caption ?? 'Choose a destination'}`;
    view.inspect.setAttribute('aria-label', `Inspect ${row.node.name}`);
    setUnavailable(view.inspect, actionsBlocked() || Boolean(row.reason));
  }
}
export function localPreviewFor(nodeId: string): string | null {
  return cacheOwner === `${state.connectionGeneration}:${state.selection.revision}` ? previews.get(nodeId) ?? null : null;
}
function ownerKey(): string { return `${state.connectionGeneration}:${state.selection.revision}:${activeSendRow()?.node.id}`; }

export function renderSendPreview(): void {
  const epoch = `${state.connectionGeneration}:${state.selection.revision}`;
  if (cacheOwner !== epoch) { previews.clear(); cacheOwner = epoch; }
  renderBatchPreviews();
  const row = activeSendRow();
  const visible = state.prefs.tab === 'send' && hasCurrentSelection() && Boolean(state.connection && row && !row.reason);
  element('send-comparison').hidden = !visible;
  element('send-preview-enlarge').hidden = !visible;
  setUnavailable(element('send-preview-enlarge'), actionsBlocked());
  const nextKey = visible ? `${state.connectionGeneration}:${state.selection.revision}:${row!.node.id}` : '';
  if (nextKey !== key) {
    if (expanded) closeInspection();
    key = nextKey; requestId = null; requested = false; image.removeAttribute('src');
    const cached = !expanded && row && localPreviewFor(row.node.id);
    if (cached) { image.src = cached; requested = true; }
    element('send-layer-status').textContent = cached ? 'Local preview' : 'Preview not loaded';
  }
  if (!visible) return;
  image.alt = row!.node.name;
  element('send-layer-name').textContent = row!.node.name;
  element('send-comparison-empty').hidden = !element('send-current').hidden;
  setUnavailable(element('send-preview-refresh'), actionsBlocked() || requestId !== null);
  if (!requested && !actionsBlocked() && typeof state.selection.revision === 'number') {
    requested = true; requestId = nextRequestId();
    element('send-layer-status').textContent = 'Loading preview…';
    post({ type: 'preview-selection', requestId, connectionGeneration: state.connectionGeneration!, revision: state.selection.revision, nodeId: row!.node.id, ...(expanded ? { large: true } : {}) });
  }
}

export function acceptSelectionPreview(message: Extract<MainMessage, { type: 'selection-preview' }>): void {
  if (message.requestId !== requestId || state.connectionGeneration !== message.connectionGeneration
    || state.selection.revision !== message.revision || activeSendRow()?.node.id !== message.nodeId || state.prefs.tab !== 'send') return;
  requestId = null;
  const size = message.bytes && message.bytes.byteLength <= (expanded ? 1048576 : 262144) ? pngSize(message.bytes) : null;
  const valid = size && Math.max(size.width, size.height) <= (expanded ? 1024 : 256);
  if (valid) {
    image.src = `data:image/png;base64,${bytesToBase64(message.bytes!)}`;
    if (!expanded) {
      previews.set(message.nodeId, image.src);
      if (previews.size > 8) previews.delete(previews.keys().next().value!);
    }
  }
  else image.removeAttribute('src');
  element('send-layer-status').textContent = valid ? 'Local preview' : 'Preview unavailable';
  scheduleRender();
}

function refreshPreview(): void {
  if (actionsBlocked() || requestId !== null) return;
  const row = activeSendRow(); if (row) previews.delete(row.node.id);
  requested = false; image.removeAttribute('src'); scheduleRender();
}
export function inspectSendPreview(returnTo = element('send-preview-enlarge')): void {
    if (actionsBlocked() || state.prefs.tab !== 'send' || !hasCurrentSelection() || !state.connection || !activeSendRow() || activeSendRow()!.reason) return;
    expanded = true; requested = false; requestId = null;
    renderSendPreview();
    const owner = ownerKey();
    openInspection({
      current: () => expanded && state.prefs.tab === 'send' && hasCurrentSelection() && ownerKey() === owner,
      returnTo, refresh: refreshPreview,
      closed: () => { expanded = false; requestId = null; requested = false; },
      items: () => {
        const choice = sendChoice(), preview = choice && sendPlacementPreview(choice.placementKey, choice.cell, true);
        const reference = state.placements.find(item => item.key === choice?.placementKey);
        return [
          { label: 'Figma layer', caption: `${image.alt} · ${element('send-layer-status').textContent}`, src: image.getAttribute('src') ?? undefined,
            source: activeSendRow()?.node, sourceLabel: 'Figma layer', reference, limit: 1024 },
          { label: 'Current Draft', caption: `${choice ? `${choice.placementKey} · ` : ''}${preview?.caption ?? 'Choose a destination to compare Draft artwork.'}`,
            asset: preview?.asset, source: preview?.asset ?? undefined, sourceLabel: 'Draft source', reference },
        ];
      },
    });
}
export function initSendPreview(): void {
  element('send-preview-enlarge').addEventListener('click', () => inspectSendPreview());
  element('send-preview-refresh').addEventListener('click', refreshPreview);
}
