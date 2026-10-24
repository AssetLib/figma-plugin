import { bytesToBase64, pngSize } from '../shared/index.js';
import type { LibraryAsset } from '../shared/index.js';
import type { MainMessage } from '../shared/protocol.js';
import { post, scheduleRender } from './dom.js';
import { openInspection } from './inspector.js';
import { actionsBlocked, hasCurrentSelection, nextRequestId, state } from './state.js';

let pending: { id: number; generation: number; revision: number; nodeId: string; current: () => boolean } | null = null;
let src: string | undefined, status = '';

export function acceptFillPreview(message: Extract<MainMessage, { type: 'selection-preview' }>): void {
  if (!pending || !message.fill || message.requestId !== pending.id || message.connectionGeneration !== pending.generation
    || message.revision !== pending.revision || message.nodeId !== pending.nodeId || !pending.current()) return;
  pending = null;
  const size = message.bytes && message.bytes.byteLength <= 1048576 ? pngSize(message.bytes) : null;
  const valid = size && Math.max(size.width, size.height) <= 1024;
  src = valid ? `data:image/png;base64,${bytesToBase64(message.bytes!)}` : undefined;
  status = valid ? 'Local canvas preview' : 'Canvas preview unavailable. Try Refresh preview.';
  scheduleRender();
}

export function inspectFill(asset: LibraryAsset, caption: string, returnTo: HTMLElement, unchanged: () => boolean): void {
  const node = state.selection.node, target = state.selection.fillPreview, generation = state.connectionGeneration, revision = state.selection.revision;
  if (actionsBlocked() || generation === null || revision === undefined || !hasCurrentSelection()) return;
  let open = true;
  const current = () => open && hasCurrentSelection() && state.connectionGeneration === generation && state.selection.revision === revision && unchanged();
  const refresh = () => {
    if (!current() || actionsBlocked()) return;
    pending = null; src = undefined;
    if (!target || 'reason' in target || !node) { status = 'Canvas preview unavailable for this selection.'; return; }
    if (target.empty) { status = 'No visible artwork on this layer.'; return; }
    status = 'Loading canvas preview…';
    pending = { id: nextRequestId(), generation, revision, nodeId: node.id, current };
    post({ type: 'preview-selection', requestId: pending.id, connectionGeneration: generation, revision, nodeId: node.id, large: true, fill: true });
  };
  refresh();
  openInspection({ returnTo, current, compare: true, target: target ?? { reason: 'Select the layer again to check its paint settings.' }, refresh,
    closed: () => { open = false; pending = null; src = undefined; },
    items: () => [
      { label: 'On canvas now', caption: `${node?.name ?? 'Selected layers'} · ${status}`, src, source: node ?? undefined,
        sourceLabel: 'Layer bounds', limit: 1024, rendered: true, status },
      { label: 'Proposed replacement', caption, source: asset, sourceLabel: 'Source', asset },
    ],
  });
}
