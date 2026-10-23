import { bytesToBase64, pngSize } from '../shared/index.js';
import type { MainMessage } from '../shared/protocol.js';
import { element, post, scheduleRender, setUnavailable } from './dom.js';
import { activeSendRow } from './send-queue.js';
import { actionsBlocked, hasCurrentSelection, nextRequestId, state } from './state.js';

const image = element<HTMLImageElement>('send-layer-thumb');
let key = '';
let requestId: number | null = null;
let requested = false;

export function renderSendPreview(): void {
  const row = activeSendRow();
  const visible = state.prefs.tab === 'send' && hasCurrentSelection() && Boolean(state.connection && row && !row.reason);
  element('send-comparison').hidden = !visible;
  const nextKey = visible ? `${state.connectionGeneration}:${state.selection.revision}:${row!.node.id}` : '';
  if (nextKey !== key) {
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
    post({ type: 'preview-selection', requestId, connectionGeneration: state.connectionGeneration!, revision: state.selection.revision, nodeId: row!.node.id });
  }
}

export function acceptSelectionPreview(message: Extract<MainMessage, { type: 'selection-preview' }>): void {
  if (message.requestId !== requestId || state.connectionGeneration !== message.connectionGeneration
    || state.selection.revision !== message.revision || activeSendRow()?.node.id !== message.nodeId || state.prefs.tab !== 'send') return;
  requestId = null;
  const size = message.bytes && message.bytes.byteLength <= 262144 ? pngSize(message.bytes) : null;
  const valid = size && Math.max(size.width, size.height) <= 256;
  if (valid) image.src = `data:image/png;base64,${bytesToBase64(message.bytes!)}`;
  else image.removeAttribute('src');
  element('send-layer-status').textContent = valid ? 'Local preview' : 'Preview unavailable';
  scheduleRender();
}

export function initSendPreview(): void {
  element('send-preview-refresh').addEventListener('click', () => {
    if (actionsBlocked() || requestId !== null) return;
    requested = false; image.removeAttribute('src'); scheduleRender();
  });
}
