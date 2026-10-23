import { bytesToBase64, pngSize } from '../shared/index.js';
import type { MainMessage } from '../shared/protocol.js';
import { element, post, scheduleRender, setUnavailable } from './dom.js';
import { sendPlacementPreview } from './insert.js';
import { sendChoice } from './send.js';
import { showThumbnail } from './thumbnails.js';
import { activeSendRow } from './send-queue.js';
import { actionsBlocked, hasCurrentSelection, nextRequestId, state } from './state.js';

const image = element<HTMLImageElement>('send-layer-thumb');
let key = '';
let requestId: number | null = null;
let requested = false;
let expanded = false;
let side = 0;
const dialog = element('artwork-inspector');
const sides = [element('inspect-layer'), element('inspect-draft')];
function closeInspector(): void {
  expanded = false; dialog.hidden = true;
  showThumbnail(element<HTMLImageElement>('inspect-draft-image'), null);
  element('inspect-layer-image').removeAttribute('src'); element('app').inert = false;
  requestId = null; requested = false;
  element('send-preview-enlarge').focus(); scheduleRender();
}
function renderInspector(): void {
  dialog.hidden = !expanded;
  element('app').inert = expanded;
  if (!expanded) return;
  const choice = sendChoice();
  const preview = choice && sendPlacementPreview(choice.placementKey, choice.cell);
  const local = element<HTMLImageElement>('inspect-layer-image');
  if (image.getAttribute('src')) local.src = image.src; else local.removeAttribute('src');
  local.alt = image.alt;
  const draft = element<HTMLImageElement>('inspect-draft-image');
  showThumbnail(draft, preview?.asset ?? null, false, true);
  draft.alt = choice?.placementKey ?? '';
  sides.forEach((button, index) => { button.setAttribute('aria-pressed', String(side === index)); });
  element('inspect-layer-panel').hidden = side !== 0;
  element('inspect-draft-panel').hidden = side !== 1;
  element('inspect-caption').textContent = side === 0 ? `${image.alt} · ${element('send-layer-status').textContent}` : `${choice ? `${choice.placementKey} · ` : ''}${preview?.caption ?? 'Choose a destination to compare Draft artwork.'}${preview?.asset && !draft.getAttribute('data-sha') ? ' · Preview unavailable' : ''}`;
}

export function renderSendPreview(): void {
  const row = activeSendRow();
  const visible = state.prefs.tab === 'send' && hasCurrentSelection() && Boolean(state.connection && row && !row.reason);
  element('send-comparison').hidden = !visible;
  element('send-preview-enlarge').hidden = !visible;
  setUnavailable(element('send-preview-enlarge'), actionsBlocked());
  const nextKey = visible ? `${state.connectionGeneration}:${state.selection.revision}:${row!.node.id}` : '';
  if (nextKey !== key) {
    if (expanded) closeInspector();
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
  renderInspector();
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

export function initSendPreview(): void {
  element('send-preview-enlarge').addEventListener('click', () => {
    if (actionsBlocked() || state.prefs.tab !== 'send' || !hasCurrentSelection() || !state.connection || !activeSendRow() || activeSendRow()!.reason) return;
    expanded = true; side = 0; requested = false; requestId = null;
    renderSendPreview(); sides[0]!.focus();
  });
  element('inspect-close').addEventListener('click', closeInspector);
  sides.forEach((button, index) => button.addEventListener('click', () => { side = index; renderInspector(); }));
  dialog.addEventListener('keydown', event => {
    if (event.key === 'Escape') { event.preventDefault(); closeInspector(); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      event.preventDefault(); side = 1 - side; renderInspector(); sides[side]!.focus();
    } else if (event.key === 'Tab') {
      const controls = [...sides, element('inspect-refresh'), element('inspect-close')];
      event.preventDefault(); controls[(controls.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]!.focus();
    } else if (event.metaKey || event.ctrlKey || event.key === '/') event.preventDefault();
  });
  for (const id of ['send-preview-refresh', 'inspect-refresh']) element(id).addEventListener('click', () => {
    if (actionsBlocked() || requestId !== null) return;
    requested = false; image.removeAttribute('src'); scheduleRender();
  });
}
