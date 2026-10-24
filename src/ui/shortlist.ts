import { aspectMismatch, insertRendition, sizeLabel } from '../shared/index.js';
import type { LibraryAsset } from '../shared/index.js';
import { element, scheduleRender, setStatus, setUnavailable } from './dom.js';
import { retryFailedThumbnails } from './thumbnails.js';
import { openInspection } from './inspector.js';
import { actionsBlocked, NEW_FRAME, state } from './state.js';

let items: LibraryAsset[] = [], revision = 0, rendered = '';
export function shortlistAsset(id: string): LibraryAsset | null { return items.find(item => item.id === id) ?? null; }
export function resetShortlist(): void { items = []; revision += 1; }
export function updateShortlist(assets: LibraryAsset[]): void {
  for (const asset of assets) {
    const index = items.findIndex(item => item.id === asset.id);
    if (index >= 0 && JSON.stringify(items[index]) !== JSON.stringify(asset)) { items[index] = asset; revision += 1; }
  }
}
function available(): boolean {
  return Boolean(state.connection && state.connectionGeneration !== null && state.prefs.tab === 'insert' && state.prefs.browse === 'images' && !actionsBlocked());
}
function remove(asset: LibraryAsset): void {
  if (!available() || !shortlistAsset(asset.id)) return;
  items = items.filter(item => item.id !== asset.id); revision += 1; scheduleRender();
}
export function renderShortlist(selected: LibraryAsset | null): void {
  element('image-shortlist').hidden = !state.connection || state.prefs.browse !== 'images';
  const included = selected && shortlistAsset(selected.id);
  element('shortlist-add').textContent = included ? 'Remove from compare' : 'Add to compare';
  setUnavailable(element('shortlist-add'), !available() || !selected || (!included && items.length === 3));
  element('shortlist-compare').textContent = `Compare (${items.length}/3)`;
  setUnavailable(element('shortlist-compare'), !available() || items.length < 2);
  element('shortlist-clear').hidden = !items.length;
  const key = JSON.stringify(items);
  if (key !== rendered) {
    rendered = key;
    const epoch = revision;
    element('shortlist-names').replaceChildren(...items.map(asset => {
      const button = document.createElement('button'); button.type = 'button'; button.className = 'secondary small';
      button.textContent = `${asset.name || 'Untitled image'} ×`; button.title = `Remove ${asset.name || 'Untitled image'} from compare`;
      button.setAttribute('aria-label', button.title); button.addEventListener('click', () => { if (epoch === revision) remove(asset); }); return button;
    }));
  }
  for (const button of Array.from(element('shortlist-names').children)) setUnavailable(button as HTMLElement, !available());
  setUnavailable(element('shortlist-clear'), !available());
}
export function initShortlist(selected: () => LibraryAsset | null, choose: (id: string) => void): void {
  element('shortlist-add').addEventListener('click', () => {
    const asset = selected();
    if (!available() || !asset) return;
    const existing = shortlistAsset(asset.id);
    if (existing) remove(existing);
    else if (items.length < 3) { items.push(asset); revision += 1; setStatus(`${asset.name || 'Image'} added to compare.`); scheduleRender(); }
  });
  element('shortlist-clear').addEventListener('click', () => { if (available()) { resetShortlist(); scheduleRender(); } });
  element('shortlist-compare').addEventListener('click', () => {
    if (!available() || items.length < 2) return;
    const candidates = [...items], epoch = revision, generation = state.connectionGeneration, selection = state.selection.revision;
    const target = state.selection.insertTarget ?? NEW_FRAME;
    const current = () => available() && revision === epoch && state.connectionGeneration === generation && state.selection.revision === selection;
    openInspection({ current, returnTo: element('shortlist-compare'), target: target.mode === 'fill' || target.mode === 'replace' ? state.selection.fillPreview ?? { reason: 'Select the layer again to check its paint settings.' } : undefined,
      refresh: () => { retryFailedThumbnails(); scheduleRender(); },
      usable: index => Boolean(insertRendition(candidates[index]!)),
      use: index => { if (current()) { choose(candidates[index]!.id); setStatus('Image selected. Choose Insert or Fill when ready.'); } },
      items: () => candidates.map(asset => {
        let compatibility = 'New Figma layer · original aspect ratio';
        if (target.mode === 'into') compatibility = `Figma container: ${target.name ?? 'selection'} · image fits inside`;
        else if (target.mode !== 'new') {
          compatibility = target.count > 1 ? `Fill ${target.count} Figma layers · each keeps its size; cropping may differ`
            : `Figma target: ${target.name ?? 'selection'}${target.containerWidth && target.containerHeight ? ` · ${sizeLabel({ width: target.containerWidth, height: target.containerHeight })} · ${aspectMismatch(asset, { width: target.containerWidth, height: target.containerHeight }) ? 'different aspect ratio; fill may crop' : 'matching aspect ratio'}` : ''}`;
        }
        if (!insertRendition(asset)) compatibility = 'No image version Figma can insert. Choose another image.';
        return { label: asset.name || 'Untitled image', caption: compatibility, asset, source: asset, sourceLabel: 'Source' };
      }),
    });
  });
}
