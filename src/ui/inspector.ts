import { sizeLabel, thumbnailRendition } from '../shared/index.js';
import type { LibraryAsset } from '../shared/index.js';
import { arrowKeys, element, rovingStops, scheduleRender, setUnavailable } from './dom.js';
import { actionsBlocked } from './state.js';
import { showThumbnail } from './thumbnails.js';

export type InspectionItem = {
  label: string; caption: string; sourceLabel: string; source?: { width: number; height: number };
  reference?: { width: number; height: number }; asset?: LibraryAsset | null; src?: string; limit?: number;
};
type Inspection = {
  items: () => InspectionItem[]; current: () => boolean; returnTo: HTMLElement;
  closed?: () => void; refresh?: () => void; use?: (index: number) => void; usable?: (index: number) => boolean;
};
const dialog = element('artwork-inspector');
const names = ['layer', 'draft', 'third'];
const sides = names.map(name => element<HTMLButtonElement>(`inspect-${name}`));
const panels = names.map(name => element(`inspect-${name}-panel`));
const images = names.map(name => element<HTMLImageElement>(`inspect-${name}-image`));
const backgrounds = ['transparent', 'light', 'dark'].map(name => element<HTMLButtonElement>(`inspect-${name}`));
const scales = ['fit', 'pixels'].map(name => element<HTMLButtonElement>(`inspect-${name}`));
let session: Inspection | null = null;
let side = 0, background = 0, pixels = false;
const unavailable = new Set<string>();

function decoded(image: HTMLImageElement, item: InspectionItem): boolean {
  return Boolean(image.getAttribute('src') && image.complete && image.naturalWidth > 0 && Math.max(image.naturalWidth, image.naturalHeight) <= (item.limit ?? 2048) && (!image.currentSrc || image.currentSrc === image.src));
}
export function closeInspection(): void {
  const previous = session;
  session = null; dialog.hidden = true; element('app').inert = false;
  for (const image of images) showThumbnail(image, null);
  previous?.closed?.(); previous?.returnTo.focus(); scheduleRender();
}
export function openInspection(next: Inspection): void {
  if (actionsBlocked() || !next.current()) return;
  if (session) closeInspection();
  session = next; side = 0; pixels = false; unavailable.clear();
  renderInspection(); sides[0]!.focus();
}
export function renderInspection(): void {
  if (session && !session.current()) closeInspection();
  dialog.hidden = !session; element('app').inert = Boolean(session);
  if (!session) return;
  const items = session.items().slice(0, 3);
  if (!items.length) { closeInspection(); return; }
  side = Math.min(side, items.length - 1);
  items.forEach((item, index) => {
    const image = images[index]!;
    const blocked = unavailable.has(item.asset?.id ?? item.src ?? '');
    if (item.src && !blocked) {
      if (image.src !== item.src) image.src = item.src;
    } else showThumbnail(image, blocked ? null : item.asset ?? null, false, true);
    image.alt = item.label;
  });
  sides.forEach((button, index) => {
    const item = items[index];
    button.hidden = !item; button.textContent = item?.label ?? ''; button.title = item?.label ?? '';
    button.setAttribute('aria-pressed', String(side === index));
    panels[index]!.hidden = side !== index;
    panels[index]!.setAttribute('aria-label', `${item?.label ?? ''} preview, scroll at 100%`);
    panels[index]!.setAttribute('data-background', ['transparent', 'light', 'dark'][background]!);
    panels[index]!.setAttribute('data-pixels', String(pixels)); panels[index]!.tabIndex = pixels && side === index ? 0 : -1;
    if (!item) showThumbnail(images[index]!, null);
  });
  const item = items[side]!, shown = images[side]!;
  element('inspect-caption').textContent = item.caption + (item.asset && !shown.getAttribute('data-sha') ? ' · Preview unavailable' : '');
  const loaded = decoded(shown, item);
  element('inspect-size').textContent = [item.source ? `${item.sourceLabel} ${sizeLabel(item.source)}` : '', item.reference ? `Placement reference ${sizeLabel(item.reference)}` : '', loaded ? `Preview ${shown.naturalWidth} × ${shown.naturalHeight} px${pixels ? ' · 100%' : ' · Fit'}` : 'Preview not loaded'].filter(Boolean).join(' · ');
  backgrounds.forEach((button, index) => button.setAttribute('aria-checked', String(background === index)));
  scales.forEach((button, index) => button.setAttribute('aria-checked', String(pixels === Boolean(index))));
  rovingStops(backgrounds); rovingStops(scales);
  element('inspect-refresh').hidden = !session.refresh;
  element('inspect-use').hidden = !session.use;
  setUnavailable(element('inspect-use'), actionsBlocked() || !loaded || session.usable?.(side) === false);
  element('inspect-help').textContent = `100% shows preview pixels, not app size. ← → compares artwork. Esc returns to ${session.use ? 'Images' : 'Send'}.`;
}
export function initInspector(): void {
  element('inspect-close').addEventListener('click', closeInspection);
  images.forEach((image, index) => image.addEventListener('load', () => {
    const item = session?.current() && session.items()[index];
    if (!item || !image.getAttribute('src') || !image.complete || (image.currentSrc && image.currentSrc !== image.src)) return;
    if (item.src && image.src !== item.src || item.asset && thumbnailRendition(item.asset, true)?.sha256 !== image.getAttribute('data-sha')) return;
    if (Math.max(image.naturalWidth, image.naturalHeight) > (item.limit ?? 2048)) {
      unavailable.add(item.asset?.id ?? item.src ?? ''); image.removeAttribute('src');
    }
    renderInspection();
  }));
  images.forEach((image, index) => image.addEventListener('error', () => {
    const item = session?.current() && session.items()[index];
    if (!item || !image.getAttribute('src') || image.currentSrc && image.currentSrc !== image.src) return;
    if (item.src && image.src !== item.src || item.asset && thumbnailRendition(item.asset, true)?.sha256 !== image.getAttribute('data-sha')) return;
    unavailable.add(item.asset?.id ?? item.src ?? ''); image.removeAttribute('src'); renderInspection();
  }));
  backgrounds.forEach((button, index) => button.addEventListener('click', () => { background = index; renderInspection(); }));
  scales.forEach((button, index) => button.addEventListener('click', () => { pixels = Boolean(index); renderInspection(); }));
  arrowKeys(element('inspect-backgrounds'), backgrounds, 'radios'); arrowKeys(element('inspect-scales'), scales, 'radios');
  sides.forEach((button, index) => button.addEventListener('click', () => { side = index; renderInspection(); }));
  element('inspect-refresh').addEventListener('click', () => { if (session?.current() && !actionsBlocked()) { unavailable.clear(); session.refresh?.(); renderInspection(); } });
  element('inspect-use').addEventListener('click', () => {
    if (!session?.current() || actionsBlocked() || !decoded(images[side]!, session.items()[side]!) || session.usable?.(side) === false) return;
    session.use?.(side); closeInspection();
  });
  dialog.addEventListener('keydown', event => {
    if (event.defaultPrevented || !session) return;
    if (event.key === 'Escape') { event.preventDefault(); closeInspection(); }
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      if (pixels && panels.includes(document.activeElement as HTMLElement)) return;
      event.preventDefault(); const count = session.items().length;
      side = (side + (event.key === 'ArrowLeft' ? count - 1 : 1)) % count; renderInspection(); sides[side]!.focus();
    } else if (event.key === 'Tab') {
      const controls = [...sides, element('inspect-refresh'), element('inspect-use'), element('inspect-close'), ...backgrounds, ...scales, panels[side]!].filter(control => !control.hidden && !(control as HTMLButtonElement).disabled && control.tabIndex !== -1);
      event.preventDefault(); controls[(controls.indexOf(document.activeElement as HTMLElement) + (event.shiftKey ? controls.length - 1 : 1)) % controls.length]!.focus();
    } else if (event.metaKey || event.ctrlKey || event.key === '/') event.preventDefault();
  });
}
