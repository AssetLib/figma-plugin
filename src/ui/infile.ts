// Local document inventory and its file-status words; no HTTP calls.
import { appearanceLabel, changedArt, environmentLabel, findCell } from '../shared/index.js';
import type { ArtworkResponse, CellCoordinate, Placement } from '../shared/index.js';
import type { FileLink, FileLinks } from '../shared/protocol.js';
import { element, post, scheduleRender, showError } from './dom.js';
import { nextRequestId, state } from './state.js';
import { thumbnailFrame } from './thumbnails.js';

export type FileTag = { word: string; title: string; style?: string };
export function cellAxes(placement: Placement, cell: CellCoordinate): string {
  return [placement.states?.length ? cell.state ?? placement.defaultState ?? 'Default' : null,
    placement.variants?.appearance?.length ? appearanceLabel(cell.appearance) : null,
    placement.variants?.arm?.length ? cell.arm ? `arm ${cell.arm}` : 'Control' : null].filter(value => value !== null).join(' · ');
}
export function fileTag(key: string, artwork: ArtworkResponse | null): FileTag | null {
  const index = state.fileLinks;
  if (!index) return null;
  const where = index.scope === 'page' ? 'on this page' : 'in this file';
  const presence = index.scope === 'page' ? 'On this page' : 'In this file';
  const entries = index.entries.filter(entry => entry.placementKey === key);
  if (!entries.length) return { word: `Not ${where}`, title: `No layer ${where} uses this placement yet.`, style: 'quiet' };
  const linked = entries.filter(entry => entry.kind === 'linked');
  const behind = artwork ? linked.filter(entry => changedArt(artwork, entry)) : [];
  if (behind.length) return { word: `${behind.length} behind`, style: 'behind', title: `${behind.length} linked layer${behind.length === 1 ? '' : 's'} ${where} show older art than ${[...new Set(behind.map(entry => environmentLabel(entry.environment)))].join(', ')} has now. Select one and choose Update.` };
  return artwork && linked.length ? { word: `${presence} · current`, title: `Every linked layer ${where} shows the current art.` }
    : { word: presence, title: `${entries.length} layer${entries.length === 1 ? '' : 's'} ${where} use this placement.` };
}
let scan: number | null = null, selectionRequest: number | null = null, all = false, lastFocus = -Infinity;
export function requestFileScan(allPages = false): void {
  if (!state.connection || state.connectionGeneration === null || (scan !== null && !allPages)) return;
  scan = nextRequestId(); all = allPages;
  post({ type: 'scan-file', requestId: scan, allPages });
  scheduleRender();
}
export function acceptFileLinks(message: FileLinks): void {
  if (message.connectionGeneration !== state.connectionGeneration) return;
  state.fileLinks = message;
  if (message.requestId === scan) { scan = null; all = false; }
  scheduleRender(true);
}
export function failFileScan(id: number, message: string): boolean {
  if (id !== scan && id !== selectionRequest) return false;
  if (id === scan) { scan = null; all = false; }
  if (id === selectionRequest) selectionRequest = null;
  showError(message); scheduleRender(); return true;
}
export function selectFileNode(nodeId: string): void {
  selectionRequest = nextRequestId();
  post({ type: 'select-node', requestId: selectionRequest, nodeId });
}
export function resetFile(): void { state.fileLinks = null; scan = null; selectionRequest = null; all = false; lastFocus = -Infinity; }
export function focusFile(): void {
  if (state.prefs.tab !== 'insert' || state.prefs.browse !== 'file' || Date.now() - lastFocus < 2000) return;
  lastFocus = Date.now(); requestFileScan();
}
export function renderFileScope(): void {
  const index = state.fileLinks;
  element('file-scope').hidden = state.prefs.browse !== 'file' || index?.scope !== 'page' || index.pageCount <= 1;
  const button = element('file-all');
  button.textContent = all ? 'Loading pages…' : 'Include all pages';
  if (all) button.setAttribute('aria-busy', 'true'); else button.removeAttribute('aria-busy');
}
function node(tag: 'span' | 'div' | 'p', className: string, text = ''): HTMLElement {
  const item = document.createElement(tag); item.className = className; item.textContent = text; return item;
}
export function fileRows(query: string, artwork: ArtworkResponse | null, wire: (row: HTMLElement, entry: FileLink) => void): HTMLElement[] {
  const index = state.fileLinks;
  if (!index) return [];
  const entries = index.entries.filter(entry => [entry.name, entry.placementKey, entry.frameName ?? ''].some(value => value.toLowerCase().includes(query.toLowerCase())));
  const groups = new Map<string, { title: string; entries: FileLink[] }>();
  for (const entry of entries) {
    const key = `${entry.pageId}/${entry.frameId ?? ''}`;
    let group = groups.get(key);
    if (!group) {
      const frame = entry.frameName ?? entry.pageName;
      group = { title: index.scope === 'file' && index.pageCount > 1 && entry.frameName ? `${entry.pageName} › ${frame}` : frame, entries: [] };
      groups.set(key, group);
    }
    group.entries.push(entry);
  }
  return [...groups.values()].map((data, i) => {
    const group = node('div', 'file-group'), header = node('p', 'group', data.title);
    header.id = `file-group-${i}`; header.setAttribute('aria-hidden', 'true'); header.setAttribute('role', 'presentation');
    group.setAttribute('role', 'group'); group.setAttribute('aria-labelledby', header.id); group.append(header);
    for (const entry of data.entries) {
      const placement = artwork?.placements.find(item => item.key === entry.placementKey);
      const cell = placement ? findCell(placement, entry) : null;
      const asset = artwork?.assets[entry.assetId] ?? null;
      const row = node('div', 'placement file-row'); row.setAttribute('data-key', entry.nodeId);
      const box = node('span', 'thumb-box'); box.append(thumbnailFrame(asset, !asset, placement ?? asset ?? { width: 1, height: 1 }));
      const text = node('span', 'row-text');
      const meta = [entry.placementKey, placement ? cellAxes(placement, entry) : [entry.state, entry.appearance && appearanceLabel(entry.appearance), entry.arm].filter(Boolean).join(' · '), environmentLabel(entry.environment)].filter(Boolean).join(' · ');
      text.append(node('span', 'name', entry.name), node('span', 'meta', meta)); row.append(box, text); row.title = `${entry.name} · ${meta}`;
      if (artwork) {
        const word = !cell ? 'Removed' : entry.kind === 'copy' ? 'Copy' : changedArt(artwork, entry) ? 'Behind' : 'Current';
        const chip = node('span', word === 'Behind' ? 'tag behind' : 'tag', word);
        if (word === 'Copy') chip.title = 'A copy of a linked layer. Copies aren’t linked; select it and Send it to a cell to link it.';
        row.append(chip);
      }
      wire(row, entry); group.append(row);
    }
    return group;
  });
}
