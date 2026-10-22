// Scanned document links, their file-status words, and bounded metadata reports to the connected workspace.
import { appearanceLabel, changedArt, environmentLabel, findCell } from '../shared/index.js';
import type { ArtworkResponse, CellCoordinate, Placement } from '../shared/index.js';
import type { FileLink, FileLinks } from '../shared/protocol.js';
import { element, post, scheduleRender, showError } from './dom.js';
import { nextRequestId, state } from './state.js';
import { thumbnailFrame } from './thumbnails.js';
import { send } from './http.js';

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
  // Past 2000 links the scan stopped, so a placement it didn't reach may still be in the file.
  if (!entries.length && index.truncated) return null;
  if (!entries.length) return { word: `Not ${where}`, title: `No layer ${where} uses this placement yet.`, style: 'quiet' };
  const linked = entries.filter(entry => entry.kind === 'linked');
  const behind = artwork ? linked.filter(entry => changedArt(artwork, entry)) : [];
  if (behind.length) return { word: `${behind.length} behind`, style: 'behind', title: `${behind.length} linked layer${behind.length === 1 ? '' : 's'} ${where} show older art than ${[...new Set(behind.map(entry => environmentLabel(entry.environment)))].join(', ')} has now. Select one and choose Update.` };
  return { word: presence, title: artwork && linked.length
    ? `Linked environments: ${[...new Set(linked.map(entry => environmentLabel(entry.environment)))].join(', ')}.`
    : `${entries.length} layer${entries.length === 1 ? '' : 's'} ${where} use this placement.` };
}
let scan: number | null = null, selectionRequest: number | null = null, all = false, lastFocus = -Infinity;
type Report = { key: string; fileKey: string; body: string; generation: number };
const reports = new Map<string, Report>(), attempts = new Map<string, { body: string; at: number }>();
let reporting: object | null = null;
function reportFile(message: FileLinks): void {
  if (!message.fileKey || !state.connection || message.connectionGeneration !== state.connectionGeneration) return;
  const name = (value: string) => value.replace(/[\u0000-\u001f\u007f]/g, ' ').slice(0, 200).replace(/[\ud800-\udbff]$/, '');
  const key = `${message.fileKey}/${message.scope}/${message.scope === 'page' ? message.currentPageId : ''}`;
  const report = { schemaVersion: 1, file: { fileKey: message.fileKey, name: name(message.fileName) },
    scope: message.scope, currentPageId: message.currentPageId, pageCount: message.pageCount,
    complete: message.complete, truncated: message.truncated || message.entries.length > 500,
    entries: message.entries.slice(0, 500).map(({ nodeId, sourceNodeId, name: layer, pageId, pageName, frameId, frameName,
      kind, placementKey, state: cellState, appearance, arm, environment, assetId, image, children, instance }) => ({
      nodeId, sourceNodeId, name: name(layer), pageId, pageName: name(pageName), frameId, frameName: frameName === null ? null : name(frameName),
      kind, placementKey, state: cellState, appearance, arm, environment, assetId, image, children, instance,
    })) };
  let body = JSON.stringify(report);
  while (new Blob([body]).size > 1_000_000) {
    report.entries.length = Math.floor(report.entries.length * .8);
    report.truncated = true; body = JSON.stringify(report);
  }
  const last = attempts.get(key);
  // Returning to an unchanged page is reported at most once a minute; an explicit Refresh can retry immediately.
  if (message.requestId === undefined && last?.body === body && Date.now() - last.at < 60000) return;
  reports.set(key, { key, fileKey: message.fileKey, body, generation: message.connectionGeneration });
  if (reports.size > 20) reports.delete(reports.keys().next().value!);
  void sendReports();
}
async function sendReports(): Promise<void> {
  if (reporting) return;
  const ticket = {}; reporting = ticket;
  try {
    while (reports.size && reporting === ticket) {
      const report = reports.values().next().value!; reports.delete(report.key);
      const config = state.connection;
      if (!config || report.generation !== state.connectionGeneration || report.fileKey !== state.fileLinks?.fileKey) continue;
      attempts.set(report.key, { body: report.body, at: Date.now() });
      if (attempts.size > 20) attempts.delete(attempts.keys().next().value!);
      // No success or connection state is inferred from this optional report. Send/Sync retain their own results.
      try { await send(config, { path: 'figma/inventory', method: 'POST', body: report.body, retry: false, timeoutMs: 10000 }); }
      catch { /* A failed report must not strand a newer queued snapshot. */ }
    }
  } finally { if (reporting === ticket) reporting = null; }
}
export function requestFileScan(allPages = false): void {
  if (!state.connection || state.connectionGeneration === null || (scan !== null && !allPages)) return;
  scan = nextRequestId(); all = allPages;
  post({ type: 'scan-file', requestId: scan, allPages });
  scheduleRender();
}
export function acceptFileLinks(message: FileLinks): void {
  if (message.connectionGeneration !== state.connectionGeneration) {
    // Its request is over either way, so a later Refresh or focus can ask again.
    if (message.requestId === scan) { scan = null; all = false; scheduleRender(); }
    return;
  }
  state.fileLinks = message;
  reportFile(message);
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
export function resetFile(): void {
  state.fileLinks = null; scan = null; selectionRequest = null; all = false; lastFocus = -Infinity;
  reporting = null; reports.clear(); attempts.clear();
}
export function focusFile(): void {
  if (state.prefs.tab !== 'insert' || state.prefs.browse !== 'file' || Date.now() - lastFocus < 2000) return;
  lastFocus = Date.now(); requestFileScan();
}
export function renderFileScope(): void {
  const index = state.fileLinks;
  element('file-link-prompt').hidden = state.prefs.browse !== 'file' || !index || Boolean(index.fileKey);
  element('file-scope').hidden = state.prefs.browse !== 'file' || index?.scope !== 'page' || index.pageCount <= 1;
  element('file-limit').hidden = state.prefs.browse !== 'file' || !index?.truncated;
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
        const word = !cell ? 'Removed' : entry.instance ? 'Instance' : entry.kind === 'copy' ? 'Copy' : changedArt(artwork, entry) ? 'Behind' : 'Current';
        const chip = node('span', word === 'Behind' ? 'tag behind' : 'tag', word);
        if (word === 'Instance') chip.title = 'An instance of a linked component. It follows its main component, so change the main to change it.';
        if (word === 'Copy') chip.title = 'A copy of a linked layer. Copies aren’t linked; select it and Send it to a cell to link it.';
        row.append(chip);
      }
      wire(row, entry); group.append(row);
    }
    return group;
  });
}
