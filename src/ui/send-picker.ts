// Visual choices use Send's existing destination state; browsing never saves a choice or starts an upload.
import { aspectMismatch, baseCoordinate, ratioName } from '../shared/index.js';
import { arrowKeys, element, rovingStops, scheduleRender } from './dom.js';
import { sendPlacementPreview } from './insert.js';
import { chooseSendPlacement, clearPlacementSearch, sendChoice } from './send.js';
import { activeSendRow } from './send-queue.js';
import { state } from './state.js';
import { releaseListImages, thumbnailFrame } from './thumbnails.js';

const picker = element<HTMLSelectElement>('placement');
const toggle = element<HTMLButtonElement>('placement-toggle');
const search = element<HTMLInputElement>('placement-search');
const panel = element('placement-panel');
const list = element('placement-options');
let open = false;
let owner = '';
let query = '';
let signature = '';
let options: HTMLElement[] = [];
let filter: 'all' | 'fit' | 'empty' = 'all';
const filters = ['all', 'fit', 'empty'] as const;
const filterButtons = filters.map(name => element<HTMLButtonElement>(`placement-filter-${name}`));

function close(): void { open = false; scheduleRender(); toggle.focus(); }
function focusOption(index: number): void {
  const item = options[Math.max(0, Math.min(options.length - 1, index))];
  if (!item) return;
  for (const option of options) option.tabIndex = option === item ? 0 : -1;
  item.focus(); item.scrollIntoView({ block: 'nearest' });
}
function node(tag: 'span' | 'div', className: string, text = ''): HTMLElement {
  const result = document.createElement(tag); result.className = className; result.textContent = text; return result;
}

export function renderPlacementPicker(): void {
  const row = activeSendRow();
  const currentOwner = `${state.connectionGeneration}:${row?.node.id ?? ''}`;
  if (currentOwner !== owner) filter = 'all';
  if (currentOwner !== owner || state.prefs.tab !== 'send' || !state.connection || picker.disabled) open = false;
  owner = currentOwner; query = search.value;
  toggle.disabled = picker.disabled;
  const choice = sendChoice();
  toggle.textContent = choice?.placementKey ?? picker.options[0]?.textContent ?? 'Choose placement…';
  toggle.title = toggle.textContent;
  toggle.setAttribute('aria-expanded', String(open));
  panel.hidden = !open;
  if (!open) {
    releaseListImages(list); list.replaceChildren(); options = []; signature = ''; return;
  }
  const candidateKeys = Array.from(picker.options).map(option => option.value).filter(Boolean);
  const candidates = candidateKeys.flatMap(key => {
    const placement = state.placements.find(item => item.key === key);
    if (!placement) return [];
    const preview = sendPlacementPreview(key, choice?.placementKey === key ? choice.cell : baseCoordinate(placement));
    const matches = !query.trim() || `${key} ${placement.screen}`.toLowerCase().includes(query.trim().toLowerCase());
    const fit = row && !row.reason ? aspectMismatch(row.node, placement) ? 'Different ratio' : 'Fits this layer' : '';
    return [{ placement, preview, matches, fit }];
  });
  const searched = candidates.filter(item => item.matches);
  const unknown = searched.some(item => item.preview.caption === 'Draft artwork not loaded');
  if (unknown && filter === 'empty') filter = 'all';
  const counts = [searched.length, searched.filter(item => item.fit === 'Fits this layer').length, searched.filter(item => item.preview.empty).length];
  const labels = ['All', 'Fits this layer', 'No Draft artwork'];
  filterButtons.forEach((button, index) => {
    button.textContent = `${labels[index]} (${index === 2 && unknown ? '…' : counts[index]})`;
    button.disabled = picker.disabled || (index === 2 && unknown) || (index === 1 && (!row || Boolean(row.reason)));
    button.setAttribute('aria-checked', String(filter === filters[index]));
  });
  rovingStops(filterButtons);
  for (const item of candidates) item.matches = item.matches && (filter === 'all' || (filter === 'fit' ? item.fit === 'Fits this layer' : item.preview.empty));
  const visible = candidates.filter(item => item.matches || item.placement.key === choice?.placementKey);
  element('placement-empty').hidden = candidates.some(item => item.matches);
  element('placement-clear').hidden = !query && filter === 'all';
  element('placement-clear').textContent = filter === 'all' ? 'Clear search' : 'Clear filters';
  const nextSignature = JSON.stringify([owner, query, filter, choice, visible.map(({ placement: p, preview, fit }) => [p.key, p.screen, p.width, p.height, preview.caption, preview.asset?.id, preview.asset?.renditions.map(item => item.sha256), fit])]);
  if (signature === nextSignature) return;
  signature = nextSignature;
  const focused = options.find(item => item === document.activeElement)?.getAttribute('data-key');
  releaseListImages(list); options = [];
  const groups = new Map<string, HTMLElement>();
  for (const { placement, preview, matches, fit } of visible) {
    const heading = fit === 'Fits this layer' ? fit : placement.screen;
    let group = groups.get(heading);
    if (!group) {
      group = node('div', ''); group.setAttribute('role', 'group'); group.setAttribute('aria-label', heading);
      const title = node('div', 'group', heading); title.setAttribute('aria-hidden', 'true'); group.append(title); groups.set(heading, group);
    }
    const option = node('div', 'placement-option');
    option.setAttribute('role', 'option'); option.setAttribute('data-key', placement.key);
    option.setAttribute('aria-selected', String(choice?.placementKey === placement.key));
    const box = node('span', 'thumb-box'); box.append(thumbnailFrame(preview.asset, preview.empty, placement, list, { width: 72, height: 56 }));
    const copy = node('span', 'placement-option-copy');
    const title = `${placement.key}${matches ? '' : ' (current choice)'}`;
    const meta = [placement.screen, ratioName(placement.width, placement.height), fit].filter(Boolean).join(' · ');
    copy.append(node('span', 'title', title), node('span', 'meta', meta), node('span', 'meta', preview.caption));
    option.append(box, copy); option.title = `${title} · ${meta} · ${preview.caption}`;
    option.setAttribute('aria-label', option.title);
    option.tabIndex = choice?.placementKey === placement.key || (!choice && options.length === 0) ? 0 : -1;
    option.addEventListener('click', () => { if (picker.disabled) return; open = false; chooseSendPlacement(placement.key); scheduleRender(); toggle.focus(); });
    option.addEventListener('keydown', event => {
      if (picker.disabled) return;
      const index = options.indexOf(option);
      if (['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
        event.preventDefault(); focusOption(event.key === 'Home' ? 0 : event.key === 'End' ? options.length - 1 : index + (event.key === 'ArrowDown' ? 1 : -1));
      } else if ((event.key === 'Enter' || event.key === ' ') && !event.repeat && !event.metaKey && !event.ctrlKey && !event.altKey) { event.preventDefault(); option.click(); }
      else if (event.key === 'Escape') { event.preventDefault(); close(); }
    });
    group.append(option); options.push(option);
  }
  list.replaceChildren(...groups.values());
  if (focused) focusOption(options.findIndex(item => item.getAttribute('data-key') === focused));
}

export function placementSearchChanged(): void { if (!picker.disabled) open = true; }

export function initPlacementPicker(): void {
  toggle.addEventListener('click', () => { if (picker.disabled) return; open = !open; scheduleRender(); });
  toggle.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && !picker.disabled) { event.preventDefault(); open = true; renderPlacementPicker(); focusOption(0); }
    else if (event.key === 'Escape' && open) { event.preventDefault(); close(); }
  });
  search.addEventListener('keydown', event => {
    if (event.key === 'ArrowDown' && !picker.disabled) { event.preventDefault(); open = true; renderPlacementPicker(); focusOption(0); }
    else if (event.key === 'Escape' && open) { event.preventDefault(); close(); }
  });
  filterButtons.forEach((button, index) => {
    button.addEventListener('click', () => { if (button.disabled) return; filter = filters[index]!; scheduleRender(); });
  });
  arrowKeys(element('placement-filters'), filterButtons, 'radios');
  element('placement-clear').addEventListener('click', () => { filter = 'all'; clearPlacementSearch(); search.focus(); });
}
