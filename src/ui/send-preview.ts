import { bytesToBase64, pngSize } from '../shared/index.js';
import type { MainMessage } from '../shared/protocol.js';
import { element, post, scheduleRender, setUnavailable } from './dom.js';
import { sendPlacementPreview } from './insert.js';
import { sendChoice } from './send.js';
import { closeInspection, openInspection } from './inspector.js';
import { activeSendRow } from './send-queue.js';
import { actionsBlocked, hasCurrentSelection, nextRequestId, state } from './state.js';

const image = element<HTMLImageElement>('send-layer-thumb');
let key = '';
let requestId: number | null = null;
let requested = false;
let expanded = false;
function ownerKey(): string { return `${state.connectionGeneration}:${state.selection.revision}:${activeSendRow()?.node.id}`; }

export function renderSendPreview(): void {
  const row = activeSendRow();
  const visible = state.prefs.tab === 'send' && hasCurrentSelection() && Boolean(state.connection && row && !row.reason);
  element('send-comparison').hidden = !visible;
  element('send-preview-enlarge').hidden = !visible;
  setUnavailable(element('send-preview-enlarge'), actionsBlocked());
  const nextKey = visible ? `${state.connectionGeneration}:${state.selection.revision}:${row!.node.id}` : '';
  if (nextKey !== key) {
    if (expanded) closeInspection();
    key = nextKey; requestId = null; requested = false; image.removeAttribute('src');
    element('send-layer-status').textContent = 'Preview not loaded';
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
  if (valid) image.src = `data:image/png;base64,${bytesToBase64(message.bytes!)}`;
  else image.removeAttribute('src');
  element('send-layer-status').textContent = valid ? 'Local preview' : 'Preview unavailable';
  scheduleRender();
}

function refreshPreview(): void {
  if (actionsBlocked() || requestId !== null) return;
  requested = false; image.removeAttribute('src'); scheduleRender();
}
export function initSendPreview(): void {
  element('send-preview-enlarge').addEventListener('click', () => {
    if (actionsBlocked() || state.prefs.tab !== 'send' || !hasCurrentSelection() || !state.connection || !activeSendRow() || activeSendRow()!.reason) return;
    expanded = true; requested = false; requestId = null;
    renderSendPreview();
    const owner = ownerKey();
    openInspection({
      current: () => expanded && state.prefs.tab === 'send' && hasCurrentSelection() && ownerKey() === owner,
      returnTo: element('send-preview-enlarge'), refresh: refreshPreview,
      closed: () => { expanded = false; requestId = null; requested = false; },
      items: () => {
        const choice = sendChoice(), preview = choice && sendPlacementPreview(choice.placementKey, choice.cell);
        const reference = state.placements.find(item => item.key === choice?.placementKey);
        return [
          { label: 'Figma layer', caption: `${image.alt} · ${element('send-layer-status').textContent}`, src: image.getAttribute('src') ?? undefined,
            source: activeSendRow()?.node, sourceLabel: 'Figma layer', reference, limit: 1024 },
          { label: 'Current Draft', caption: `${choice ? `${choice.placementKey} · ` : ''}${preview?.caption ?? 'Choose a destination to compare Draft artwork.'}`,
            asset: preview?.asset, source: preview?.asset ?? undefined, sourceLabel: 'Draft source', reference },
        ];
      },
    });
  });
  element('send-preview-refresh').addEventListener('click', refreshPreview);
}
