// A local, bounded preview of the active reviewed layer. It never enters Send's export or upload pipeline.
import { parsePngDimensions } from '../shared/index.js';
import { MAX_SEND_NODES } from '../shared/protocol.js';
import type { UiMessage } from '../shared/protocol.js';
import { currentSelectionRevision, sendReason, sendSnapshot } from './selection.js';
import { main, post } from './state.js';

type Request = Extract<UiMessage, { type: 'preview-selection' }>;
let waiting: Request | null = null;
let running = false;

export async function previewSelection(request: Request): Promise<void> {
  waiting = request;
  if (running) return;
  running = true;
  try {
    while (waiting) {
      const next = waiting; waiting = null;
      let bytes: Uint8Array | null = null;
      try {
        const page = figma.currentPage;
        const node = page.selection.find(item => item.id === next.nodeId);
        const current = () => Boolean(main.connection && main.connectionGeneration === next.connectionGeneration
          && currentSelectionRevision() === next.revision && figma.currentPage === page && !node?.removed
          && page.selection.length <= MAX_SEND_NODES && page.selection.some(item => item === node));
        if (node && current() && !sendReason(node) && !main.exporting && !main.importing) {
          const before = sendSnapshot(node);
          const result = await node.exportAsync({ format: 'PNG', useAbsoluteBounds: true,
            constraint: { type: 'SCALE', value: Math.min(1, 256 / Math.max(node.width, node.height)) } });
          const size = result.byteLength <= 262144 ? parsePngDimensions(result) : null;
          if (size && Math.max(size.width, size.height) <= 256 && current() && before === sendSnapshot(node)) bytes = result;
        }
      } catch { /* A preview failure is local to the comparison and never prevents an explicit Send. */ }
      post({ ...next, type: 'selection-preview', bytes });
    }
  } finally { running = false; }
}
