// The Insert tab: placements by screen and the image library, the cell strip and file inventory, Insert, and dragging rows and tiles onto the canvas.
import {
  ENVIRONMENTS, GONE_IMAGE, TOKEN_NO_LONGER_ACCEPTED, appearanceLabel, artworkAsset, assetsPath, baseCoordinate, changedArt, consoleLink,
  environmentLabel, fillRendition, findCell, insideInstance, insertSize, insertRendition, isReconnectText, layerName, parseArtwork, parseAssetPage, parsePreferences, placementMarker,
  placementMeta, pngSize, reconnectText, refusalCode, renditionPath, sameCoordinate, tokenRefused,
} from '../shared/index.js';
import type {
  ArtworkResponse, CanvasTarget, CellArtwork, CellCoordinate, Connection, EnvironmentName, InsertLink, LibraryAsset, PlacementArtwork, Preferences, RenditionInfo,
} from '../shared/index.js';
import type { InsertDestination, MainMessage, SelectedLink, UiMessage } from '../shared/protocol.js';
import { webpToPng } from '../image.js';
import { renderCells } from './cells.js';
import { cellAxes, fileRows, fileTag, renderFileScope, requestFileScan, resetFile, selectFileNode } from './infile.js';
import { hintOfCurrent, startConnect } from './connect.js';
import { markConnected, needsAttention, openSettings, problemInSettings } from './connection.js';
import {
  announceError, arrowKeys, clearError, element, errorText, flushRender, inField, keyOf, post, postDrop, preferFocus, reloadConnection, rovingStops,
  scheduleRender, sentence, setBusy, setStatus, setUnavailable, showError,
} from './dom.js';
import { readFailure, send } from './http.js';
import type { HttpResult } from './http.js';
import { bindingLabel, prefillSend, sendChoice, syncBar } from './send.js';
import { NEW_FRAME, actionsBlocked, hasCurrentSelection, nextRequestId, readProblem, refusedToken, state } from './state.js';
import type { ReadFailure } from './state.js';
import { releaseListImages, resetThumbnails, retryFailedThumbnails, showThumbnail, thumbnailFrame } from './thumbnails.js';

const searchInput = element<HTMLInputElement>('insert-search');
const searchClear = element<HTMLButtonElement>('search-clear');
const insertButton = element<HTMLButtonElement>('insert');
const insertNewButton = element<HTMLButtonElement>('insert-new');
const insertThumb = element<HTMLImageElement>('insert-thumb');
const insertBar = element('insert-bar');
const hintBar = element('hint-bar');
const emptyState = element('insert-empty');
const scaleButtons = [element<HTMLButtonElement>('scale-1'), element<HTMLButtonElement>('scale-2'), element<HTMLButtonElement>('scale-3')] as const;
const browseButtons = [element<HTMLButtonElement>('browse-placements'), element<HTMLButtonElement>('browse-images'), element<HTMLButtonElement>('browse-file')] as const;
const environmentButtons = ENVIRONMENTS.map(name => element<HTMLButtonElement>(`env-${name}`));
// Below 400 px wide (ui.html) the radios give way to this dropdown; both show the same choice.
const environmentSelect = element<HTMLSelectElement>('env-select');
const GUIDE_URL = 'https://www.assetlib.dev/guide';
const NEEDS_UPLOAD = 'This image has no version Figma can use. Upload it again in the Assetlib console.';
const TOO_LARGE = 'Too large for Figma. Every version is over 4 MiB.';
const UNEXPECTED_IMAGE = 'The console sent an unexpected image. Refresh and try again.';
const CONVERTING = 'Converting to PNG…';
// A drag's data type: no field in the panel takes it, so a drop back inside the panel changes nothing.
const DRAG_TYPE = 'application/x-assetlib-item';
// Figma calls main's drop handler at once, so its reply comes at once; a drag that ended off the canvas gets none.
const DROP_REPLY_MS = 5000;
// A finished download is kept this long, so a drop, another drag, or an Insert of the same version reuses it.
const DOWNLOAD_KEEP_MS = 60000;

/**
 * What the list region shows in place of rows or tiles: a sentence, an optional headline, and at most one action.
 * `connection` marks a failed connection test or a refused token: the open connection settings say that one under the
 * token field, so the list steps aside while they are open.
 */
type ListState = {
  title?: string; text: string; action: 'clear' | 'retry' | 'token' | 'reconnect' | 'send' | 'link' | null; link?: { text: string; href: string }; connection?: boolean;
};

// Everything here resets on every connection message.
let artwork: ArtworkResponse | null = null;
let artworkGeneration: number | null = null;
// Only this window's clock: a request must start at or after we first saw the selected layer's current link.
let artworkFrom: number | null = null;
const seenLinks = new Map<string, number>();
const checkedLinks = new Set<string>();
// A full Refresh abandoned for Images must still reload when Placements next shows, without losing the bar's preview.
let artworkListStale = false;
let quietTicket = 0;
let quietLoading = false;
let quietFrom: number | null = null;
// A Send or Sync that finishes during a full load still needs a read made after its draft was bound.
let artworkRefreshPending = false;
// A focus or visibility refresh waits a minute after the last artwork request finished, even when it failed.
let artworkFinishedAt: number | null = null;
let images: { items: LibraryAsset[]; nextCursor: string | null; q: string } | null = null;
// A row's placement and the cell its strip shows, or a tile's image.
type Choice = { kind: 'placement'; key: string; cell: CellCoordinate } | { kind: 'image'; assetId: string } | { kind: 'file'; nodeId: string };
let selected: Choice | null = null;
let pendingInsert: { id: number; generation: number; kind: 'insert' | 'update' } | null = null;
let pendingReveal: { key: string; cell: CellCoordinate; environment: EnvironmentName } | null = null;
// Insert downloads by version (sha256), as PNG bytes: null when a connection change abandoned it. `status` is the Insert
// waiting on one, which hears when it converts a WebP; `converting` while it does.
type Download = { generation: number; bytes: Promise<Uint8Array | null>; status?: (text: string) => void; converting: boolean };
let downloads = new Map<string, Download>();
// The row or tile being dragged, and its download, which a drop uses.
type Dragged = { generation: number; target: InsertTarget; scale: 1 | 2 | 3; bytes: Promise<Uint8Array | null> };
let dragging: Dragged | null = null;
// A drop posted to Figma: waiting for main's `dropped` (no nodeId yet, with a timer), then for its download.
let pendingDrop: (Dragged & { id: number; timer: number; nodeId: string | null }) | null = null;
// The search the list loading now (state.ops.loadingList) loads, and a ticket that a newer list load (which aborts
// this one) replaces.
let loadingQuery = '';
let listTicket = 0;
// Why the list in view could not load; shown in its place until the next load starts.
let listError: ListState | null = null;
// What the last list rebuild left in place of rows (an empty, no-results, or failed state); each render shows it.
let listState: ListState | null = null;
// A Refresh, search, or Load more asked for while a connection save waited; it runs if main refuses the save.
let listDeferred = false;
let searchTimer: number | null = null;
// The rows or tiles in view, in list order, by placement key or asset id, and the lower-case names type-ahead matches.
let rows = new Map<string, HTMLElement>();
let rowNames = new Map<string, string>();
// The row or tile holding the list's one tab stop: the last one focused or chosen.
let activeKey: string | null = null;
// The chosen row whose `draggable` follows the footer's picked cell, so it can follow its base cell again once unchosen.
let dragFollows: string | null = null;
// Type-ahead: the letters typed less than half a second apart, and when the last one came.
let typed = { text: '', at: 0 };

function mediaType(value: string): string { return value.split(';')[0]!.trim().toLowerCase(); }
function currentQuery(): string { return searchInput.value.trim().slice(0, 120); }
export function savePreferences(): void {
  if (state.preferencesLoaded) post({ type: 'save-preferences', preferences: { ...state.prefs } });
}
/** The first connection message's preferences; later ones keep what this run chose. */
export function applyPreferences(preferences: Preferences): void {
  if (state.preferencesLoaded) return;
  state.preferencesLoaded = true;
  state.prefs = parsePreferences(preferences);
}
function published(name: EnvironmentName): boolean { return name === 'draft' || Boolean(artwork?.environments[name]); }
// A remembered environment with nothing published shows draft, without forgetting the choice.
function shownEnvironment(): EnvironmentName {
  const preferred = state.prefs.environmentChosen ? state.prefs.environment : 'production';
  return artwork && !published(preferred) ? 'draft' : preferred;
}
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${months[date.getMonth()]} ${date.getDate()}${date.getFullYear() === new Date().getFullYear() ? '' : `, ${date.getFullYear()}`}`;
}
/** Each environment's tooltip: what it is, and its release when one is published. */
function environmentTitle(name: EnvironmentName): string {
  if (name === 'draft') return 'Draft: unpublished art. Send and Sync change Draft; your app gets it only after someone publishes.';
  if (artwork && !published(name)) return `Nothing published to ${environmentLabel(name)} yet.`;
  const meta = artwork?.environments[name];
  const release = meta ? ` Release ${meta.sequence}${shortDate(meta.createdAt) ? `, ${shortDate(meta.createdAt)}` : ''}.` : '';
  return `${environmentLabel(name)}: the release published ${name === 'staging' ? 'for testing' : 'to your app’s users'}.${release}`;
}
function environmentNote(): string {
  if (state.previewNote) return state.previewNote;
  if (state.prefs.browse !== 'placements' || !artwork || !state.prefs.environmentChosen) return '';
  const shown = shownEnvironment();
  return shown === state.prefs.environment ? '' : `Nothing is published to ${environmentLabel(state.prefs.environment)} yet, so Draft is shown.`;
}

function selectedPlacement(current = selected): PlacementArtwork | null {
  return current?.kind === 'placement' ? artwork?.placements.find(item => item.key === current.key) ?? null : null;
}
function selectedImage(current = selected): LibraryAsset | null {
  return current?.kind === 'image' ? images?.items.find(item => item.id === current.assetId) ?? null : null;
}
type InsertTarget = {
  title: string; meta: string; note: string; noteLink: string | null; name: string; asset: LibraryAsset | null; ready: boolean;
  frame: { width: number; height: number }; link: InsertLink | null;
  // A cell with nothing in this environment: the footer shows the row's empty slot, not a preview.
  empty: boolean;
  // Placement art with a marker, which main inserts as a component.
  component: boolean;
};
/** What Insert does with the canvas selection, as main last reported it: a new frame until it has. */
function reportedTarget(): CanvasTarget {
  return hasCurrentSelection() ? state.selection.insertTarget ?? NEW_FRAME : NEW_FRAME;
}
/** Into a component, or a frame inside one: Figma puts no component there, so placement art goes beside it. */
function besideComponent(canvas: CanvasTarget, target: InsertTarget | null): boolean {
  return canvas.mode === 'into' && canvas.insideComponent === true && target?.component === true;
}
/** What Insert does with this choice and the canvas selection. */
function canvasTarget(target: InsertTarget | null): CanvasTarget {
  const canvas = reportedTarget();
  return besideComponent(canvas, target) ? { ...NEW_FRAME, beside: true } : canvas;
}
/** A fill or a replace keeps the layer's size, so Insert at does not apply. */
function filling(canvas: CanvasTarget): boolean { return canvas.mode === 'fill' || canvas.mode === 'replace'; }
/** The actual new or fitted size; fill and replace keep the layer's dimensions. */
function scaledSize(frame: { width: number; height: number }, component = false): string {
  const reported = reportedTarget();
  const canvas = reported.mode === 'into' && reported.insideComponent && component ? NEW_FRAME : reported;
  if (filling(canvas)) return '';
  const container = canvas.mode === 'into' ? { width: canvas.containerWidth ?? 0, height: canvas.containerHeight ?? 0 } : null;
  const size = insertSize(frame, state.prefs.scale, container);
  return `→ ${size.width} × ${size.height}`;
}
/** The destination and link effects, before any width or component limitation. */
function modeNote(canvas: CanvasTarget, target: InsertTarget): string {
  const label = (link: Pick<InsertLink, 'placementKey' | 'state' | 'appearance' | 'arm'>) => bindingLabel({ ...link, slotKey: link.placementKey });
  const cell = target.link ? label(target.link) : null;
  const old = state.selection.link?.kind === 'linked' ? state.selection.link : null;
  let note = '';
  if (canvas.mainOf) {
    const previous = canvas.mainLink;
    const placement = previous && state.placements.find(item => item.key === previous.placementKey);
    const same = !target.link || (previous && target.link.placementKey === previous.placementKey && placement && sameCoordinate(placement, target.link, previous));
    note = `Changes the main component “${canvas.name}”, so every instance follows. Filling only this instance would stop it following.`
      + (previous ? (same ? ` It stays linked to ${label(previous)}.` : ` It relinks from ${label(previous)} to ${cell}.`) : cell ? ` It links to ${cell}.` : '');
  } else if (canvas.lockedMain) note = `This is an instance of “${canvas.lockedMain}” from a library. Change its image in the library file, or insert a new layer beside it.`;
  else if (canvas.mode === 'replace' && old) {
    const placement = state.placements.find(item => item.key === old.placementKey);
    const same = !target.link || (target.link.placementKey === old.placementKey && placement && sameCoordinate(placement, target.link, old));
    note = same ? `Replaces the image in ${canvas.name}. It stays linked to ${label(old)}.`
      : `Replaces the image in ${canvas.name} and relinks it from ${label(old)} to ${cell}.`;
  } else if (canvas.mode === 'fill') {
    const linked = cell ? canvas.nodeIds.filter(id => !insideInstance(id)).length : 0;
    note = canvas.count === 1 ? `Puts this image in ${canvas.name}${linked ? ` and links it to ${cell}` : ''}. Its size and position stay.`
      : `Puts this image in ${canvas.count} layers${linked ? ` and links ${linked === canvas.count ? 'each' : linked} to ${cell}` : ''}.`;
    if (canvas.skipped) note += canvas.skipped === 1 ? ' 1 other selected layer can’t show an image and stays as it is.'
      : ` ${canvas.skipped} other selected layers can’t show an image and stay as they are.`;
  } else if (canvas.mode === 'into') note = `Adds a new layer inside ${canvas.name}.`;
  else if (canvas.beside) note = 'Adds a new layer beside the selection.';
  if (canvas.skippedInstances) note += ` ${canvas.skippedInstances} instance${canvas.skippedInstances === 1 ? '' : 's'} of Assetlib placements stay as they are, so they keep following their main component.`;
  return note;
}

/** Why an image can't be inserted, with a console link to it, or null when it can. */
function blocked(asset: LibraryAsset, connection: Connection | null): { note: string; link: string | null } | null {
  if (insertRendition(asset)) return null;
  const link = connection ? consoleLink(connection, 'images', asset.id) : null;
  return { note: asset.renditions.length ? TOO_LARGE : NEEDS_UPLOAD, link };
}
/** What Insert (or a drag) would insert for this choice: the chosen row's, unless another is named. */
function insertTarget(choice = selected): InsertTarget | null {
  if (choice?.kind === 'placement') {
    const placement = selectedPlacement(choice);
    if (!placement || !artwork) return null;
    const cell = choice.cell;
    const shown = shownEnvironment();
    const label = environmentLabel(shown);
    const art = findCell(placement, cell)?.[shown] ?? null;
    const asset = artworkAsset(artwork, art);
    const frame = { width: placement.width, height: placement.height };
    const component = Boolean(state.connection && placementMarker(state.connection, placement.key, frame));
    const size = scaledSize(frame, component);
    const parts = [size, label, cellAxes(placement, cell)].filter(Boolean);
    const target: InsertTarget = { title: placement.key, meta: parts.join(' · '), note: shown === 'draft' ? 'No image in Draft for this cell yet.'
      : `No image in ${label} for this cell. Sending puts it in Draft.`,
      noteLink: null, name: layerName(placement, cell), asset, ready: false, frame, link: null, empty: !art,
      component };
    if (!art) return target;
    if (!asset) return { ...target, note: 'The console didn’t return this image. Refresh to try again.' };
    // The link names the picked cell, never the family it inherits from, so a Sync never touches the base art.
    const inherited = art.via.arm !== cell.arm || art.via.appearance !== cell.appearance;
    const meta = inherited ? `${target.meta} · inherits ${art.via.arm ?? 'Control'} · ${appearanceLabel(art.via.appearance)} art` : target.meta;
    const stop = blocked(asset, state.connection);
    return { ...target, meta, ready: !stop, note: stop?.note ?? '', noteLink: stop?.link ?? null,
      link: { placementKey: placement.key, state: cell.state, appearance: cell.appearance, arm: cell.arm, environment: shown, assetId: art.assetId } };
  }
  const asset = selectedImage(choice);
  if (!asset) return null;
  const frame = { width: asset.width, height: asset.height };
  const stop = blocked(asset, state.connection);
  return { title: asset.name || 'Untitled image', meta: [`${asset.width} × ${asset.height}`, scaledSize(frame)].filter(Boolean).join(' '), asset,
    ready: !stop, note: stop?.note ?? '', noteLink: stop?.link ?? null, name: asset.name || 'Assetlib image', frame, link: null, empty: false, component: false };
}
function distinct<T>(values: T[]): T[] { return values.filter((value, index) => values.indexOf(value) === index); }
function selectedKey(): string | null { return selected?.kind === 'placement' ? selected.key : selected?.kind === 'image' ? selected.assetId : selected?.kind === 'file' ? selected.nodeId : null; }
/** A row's or tile's choice: the chosen one with the cell its strip shows, else its base cell. */
function choiceFor(key: string): Choice | null {
  if (selectedKey() === key) return selected;
  if (state.prefs.browse === 'images') return { kind: 'image', assetId: key };
  const placement = artwork?.placements.find(item => item.key === key);
  return placement ? { kind: 'placement', key, cell: baseCoordinate(placement) } : null;
}
/** A row or tile drags onto the canvas when Insert could insert it: connected, with a version Figma can take. */
function canDrag(target: InsertTarget | null): boolean { return Boolean(state.connection && target?.ready); }
/**
 * Marks the chosen row (aria-selected) and gives the list its one tab stop (a roving tabindex): the row last focused or
 * chosen, else the chosen one, else the first. Arrow keys move between the rows.
 */
function updateSelected(): void {
  const key = selectedKey();
  const stop = [activeKey, key].find(id => id !== null && rows.has(id)) ?? rows.keys().next().value ?? null;
  for (const [id, row] of rows) {
    row.setAttribute('aria-selected', String(id === key));
    row.setAttribute('tabindex', id === stop ? '0' : '-1');
  }
}
function firstCell(placement: PlacementArtwork): CellCoordinate {
  const base = baseCoordinate(placement), cell = findCell(placement, base) ?? placement.cells[0];
  return cell ? { state: cell.state, appearance: cell.appearance, arm: cell.arm } : base;
}
function selectPlacement(key: string): void {
  const placement = artwork?.placements.find(item => item.key === key);
  if (!placement) return;
  activeKey = key;
  // Choosing the chosen row again keeps the cell picked in the footer, so Enter and double-click insert what it shows.
  if (selected?.kind !== 'placement' || selected.key !== key) {
    selected = { kind: 'placement', key, cell: firstCell(placement) };
  }
  selectionChanged(key);
}
function selectImage(assetId: string): void {
  if (!images?.items.some(item => item.id === assetId)) return;
  activeKey = assetId;
  selected = { kind: 'image', assetId };
  selectionChanged(assetId);
}
function choose(key: string): void {
  if (state.prefs.browse === 'placements') selectPlacement(key);
  else if (state.prefs.browse === 'images') selectImage(key);
  else { selected = { kind: 'file', nodeId: key }; activeKey = key; selectionChanged(key); }
}
function selectionChanged(id: string): void {
  updateSelected();
  // Messages about the previous choice no longer apply; a running operation keeps its status.
  if (!actionsBlocked()) setStatus('');
  clearError();
  // The footer appears with a selection and the list gets shorter; render it now so the chosen row stays in view.
  scheduleRender();
  flushRender();
  rows.get(id)?.scrollIntoView({ block: 'nearest' });
}
type Tag = { word: string; title: string; blocking: boolean };
/** Own art has exactly this cell's family; inherited art is present but belongs to another family. */
function owns(art: CellArtwork | null, cell: CellCoordinate): boolean {
  return art !== null && art.via.arm === cell.arm && art.via.appearance === cell.appearance;
}
/** Only artwork from this connection may describe a destination or linked layer. */
function currentPlacement(key: string): PlacementArtwork | null {
  return artworkGeneration === state.connectionGeneration ? artwork?.placements.find(item => item.key === key) ?? null : null;
}
function currentCell(key: string, coordinate: CellCoordinate) {
  const placement = currentPlacement(key);
  return placement ? findCell(placement, coordinate) : null;
}
function axesLabel(placement: PlacementArtwork, cell: CellCoordinate): string {
  return [cell.arm, cell.appearance ?? (cell.arm ? 'Any' : null), placement.states && cell.state !== placement.defaultState ? cell.state : null]
    .filter(part => part !== null).join(' · ') || 'Any';
}
function listed(items: string[]): string { return [...items.slice(0, 6), ...(items.length > 6 ? [`and ${items.length - 6} more`] : [])].join(', '); }
/** A row's tag: a word in meta, or a warning glyph when Insert cannot use the base art. */
function rowTag(placement: PlacementArtwork): Tag | null {
  const base = findCell(placement, baseCoordinate(placement));
  const shown = shownEnvironment();
  const art = base?.[shown] ?? null;
  if (!art || !artwork) return { word: 'Not set', title: `No image in ${environmentLabel(shown)} for this cell.`, blocking: false };
  const asset = artworkAsset(artwork, art);
  if (!asset) return { word: 'Unavailable', title: 'The console didn’t return this image. Refresh to try again.', blocking: true };
  if (!asset.renditions.length) return { word: 'Needs re-upload', title: 'Upload it again in the Assetlib console to use it in Figma.', blocking: true };
  if (shown === 'draft' && artwork.environments.production) {
    const own = placement.cells.filter(cell => owns(cell.draft, cell));
    if (own.some(cell => !cell.production)) return { word: 'New in Draft', title: 'Draft has art that isn’t in Production yet. It goes out when someone publishes.', blocking: false };
    const changed = own.filter(cell => cell.draft!.assetId !== cell.production?.assetId);
    if (changed.length) return { word: 'Changed in Draft', title: `Draft differs from Production in ${changed.length} cell${changed.length === 1 ? '' : 's'}: ${listed(changed.map(cell => axesLabel(placement, cell)))}`, blocking: false };
  }
  const inherited = placement.cells.filter(cell => cell !== base && cell[shown] !== null && !owns(cell[shown], cell));
  return inherited.length ? { word: `${inherited.length} of ${placement.cells.length} inherit`,
    title: `These cells show other cells’ art: ${listed(inherited.map(cell => axesLabel(placement, cell) + ' → ' + axesLabel(placement, { ...cell, ...cell[shown]!.via })))}`, blocking: false } : null;
}
/** Prefer another cell without its own Draft art, including one showing inherited art. */
export function otherCell(key: string, cell: CellCoordinate): CellCoordinate | null {
  const placement = currentPlacement(key);
  const others = placement?.cells.filter(item => !sameCoordinate(placement, item, cell)) ?? [];
  return others.find(item => !owns(item.draft, item)) ?? others[0] ?? null;
}

/** Draft availability for Send's picker labels; no suffix until this connection's artwork is known. */
export function draftArtState(key: string, coordinate: CellCoordinate): 'own' | 'inherits' | 'empty' | null {
  const cell = currentCell(key, coordinate);
  return !cell ? null : !cell.draft ? 'empty' : owns(cell.draft, cell) ? 'own' : 'inherits';
}

/** The chosen Send cell's current Draft art, loaded whenever the form shows it. */
export function renderSendCurrent(): void {
  const choice = sendChoice();
  const cell = choice && currentCell(choice.placementKey, choice.cell);
  const current = element('send-current');
  current.hidden = state.prefs.tab !== 'send' || !state.connection || !cell;
  const art = cell?.draft ?? null;
  element('send-current-preview').className = art ? 'thumb' : 'thumb slot';
  element('send-current-text').textContent = !art ? 'Nothing in Draft yet' : owns(art, cell!) ? 'Now in Draft'
    : `Now in Draft: inherits ${art.via.arm ?? 'Control'} · ${appearanceLabel(art.via.appearance)} art`;
  showThumbnail(element<HTMLImageElement>('send-current-thumb'), current.hidden || !artwork ? null : artworkAsset(artwork, art));
}

/** New list content, with text assigned as text rather than parsed as markup. */
function makeNode<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ''): HTMLElementTagNameMap[K] {
  const item = document.createElement(tag);
  item.className = className;
  item.textContent = text;
  return item;
}
/** Rows and tiles share their listbox role, choice and drag handlers, and lookup entries. */
function wireItem(item: HTMLElement, key: string, name: string, choose: (key: string) => void): HTMLElement {
  item.setAttribute('role', 'option');
  item.addEventListener('click', () => choose(key));
  item.addEventListener('dblclick', () => insertFrom(key));
  item.draggable = canDrag(insertTarget(choiceFor(key)));
  item.addEventListener('dragstart', event => dragStart(event, key));
  item.addEventListener('dragend', dragEnd);
  rows.set(key, item);
  rowNames.set(key, name.toLowerCase());
  return item;
}
/** The declared size, as people read it: a reference that fixes the ratio, not the pixels to draw. */
function referenceSize(placement: Pick<PlacementArtwork, 'width' | 'height'>): string { return `reference ${placement.width} × ${placement.height}`; }
function placementRow(placement: PlacementArtwork, current: ArtworkResponse): HTMLElement {
  const row = makeNode('div', 'placement');
  row.setAttribute('data-key', placement.key);
  const text = makeNode('span', 'row-text');
  const name = placement.key.slice(placement.key.lastIndexOf('.') + 1);
  const key = makeNode('span', 'name', name);
  const meta = placementMeta(placement);
  text.append(key, makeNode('span', 'meta compact-meta', [name !== placement.key ? placement.key : '', meta].filter(Boolean).join(' · ')),
    makeNode('span', 'meta wide-key', name !== placement.key ? placement.key : ''));
  const art = findCell(placement, baseCoordinate(placement))?.[shownEnvironment()] ?? null;
  const box = makeNode('span', 'thumb-box'); box.append(thumbnailFrame(artworkAsset(current, art), !art, placement));
  row.append(box, text, makeNode('span', 'meta wide-meta', meta));
  const draft = rowTag(placement);
  row.title = [placement.key, meta, referenceSize(placement), draft?.title].filter(Boolean).join(' · ');
  const tag = draft?.blocking ? { ...draft, style: 'blocking' } : fileTag(placement.key, artwork);
  if (tag) {
    const chip = makeNode('span', `tag ${tag.style ?? ''}`, tag.word);
    chip.title = tag.title;
    row.append(chip);
  }
  return wireItem(row, placement.key, placement.key, selectPlacement);
}
function imageTile(asset: LibraryAsset): HTMLElement {
  const tile = makeNode('div', 'tile');
  tile.setAttribute('data-asset-id', asset.id);
  const kind = asset.processingIntent === 'photo' ? 'Photo' : 'Artwork';
  tile.title = `${asset.name || 'Untitled image'} · ${asset.width} × ${asset.height} · ${kind}`;
  const name = makeNode('span', 'name');
  // A name breaks after its separators (travel.coast.|background, hero_dark_|final) before anywhere else.
  for (const [index, part] of (asset.name || 'Untitled image').split(/(?<=[._-])/).entries()) {
    if (index) name.append(document.createElement('wbr'));
    name.append(part);
  }
  const size = makeNode('span', 'size', `${asset.width} × ${asset.height}`);
  tile.append(thumbnailFrame(asset), name, size);
  return wireItem(tile, asset.id, asset.name || 'Untitled image', selectImage);
}
/** Grey blocks where rows or tiles will be, while the list loads (no shimmer), and the words a screen reader finds there. */
function skeletons(kind: 'placements' | 'images'): HTMLElement[] {
  const words = makeNode('p', 'visually-hidden', kind === 'placements' ? 'Loading placements' : 'Loading images');
  return [words, ...Array.from({ length: kind === 'placements' ? 6 : 9 }, () => {
    const item = makeNode('div', kind === 'placements' ? 'placement skeleton' : 'tile skeleton');
    item.setAttribute('aria-hidden', 'true');
    const block = makeNode('span', 'block');
    if (kind === 'images') { item.append(block); return item; }
    const lines = makeNode('span', 'lines');
    const first = makeNode('span', 'bar');
    const second = makeNode('span', 'bar');
    lines.append(first, second);
    item.append(block, lines);
    return item;
  })];
}
/** The rebuilt row or tile for a key, so focus can follow it through a rebuild. */
export function rowFor(key: string): HTMLElement | null { return rows.get(key) ?? null; }

/** The image the Sync bar shows for a linked layer: its link's image, else its cell's art in that environment. */
export function linkedArt(placementKey: string, cell: CellCoordinate, assetId: string | null, environment: EnvironmentName = 'draft'): LibraryAsset | null {
  if (!artwork || artworkGeneration !== state.connectionGeneration) return null;
  if (assetId && artwork.assets[assetId]) return artwork.assets[assetId] ?? null;
  return artworkAsset(artwork, currentCell(placementKey, cell)?.[environment] ?? null);
}

/** The layer's own link only when Sync follows that same cell on this device. */
function currentLink(): SelectedLink | null {
  if (!hasCurrentSelection()) return null;
  const { link, remembered } = state.selection;
  const placement = link && state.placements.find(item => item.key === link.placementKey);
  if (link?.kind !== 'linked' || !remembered || !placement || link.placementKey !== remembered.placementKey
    || !sameCoordinate(placement, link, remembered)) return null;
  return link;
}
function seenKey(link: InsertLink): string { return `${state.selection.node?.id}|${link.assetId}|${link.environment}`; }
function artworkCurrentFor(link: InsertLink): boolean {
  const seen = seenLinks.get(seenKey(link));
  return artworkFrom !== null && seen !== undefined && artworkFrom >= seen;
}
/** Called once for each current-generation selection; reselecting a link never changes its first observation. */
export function noteLinkSeen(): void {
  const { link, node } = state.selection;
  if (!hasCurrentSelection() || !node || link?.kind !== 'linked') return;
  const key = seenKey(link);
  if (!seenLinks.has(key)) {
    seenLinks.set(key, Date.now());
    if (seenLinks.size > 500) {
      const oldest = seenLinks.keys().next().value!;
      seenLinks.delete(oldest); checkedLinks.delete(oldest);
    }
  }
  if (!artworkCurrentFor(link) && !checkedLinks.has(key) && !state.ops.connecting) {
    checkedLinks.add(key);
    if (quietFrom === null || quietFrom < seenLinks.get(key)!) ensureArtwork(true);
  }
  scheduleRender();
}
function artworkRequested(from: number): void {
  for (const [key, seen] of seenLinks) if (from >= seen) checkedLinks.add(key);
}
/** A read that ended unseen (aborted, superseded, or another generation's) leaves its links to be read again. */
function artworkDropped(): void {
  for (const [key, seen] of seenLinks) if (artworkFrom === null || seen > artworkFrom) checkedLinks.delete(key);
  noteLinkSeen();
}
/** New art for an image-only layer in the environment its link names. */
export function linkUpdate(): { art: CellArtwork; asset: LibraryAsset; environment: EnvironmentName; placement: PlacementArtwork } | null {
  const link = currentLink();
  const target = state.selection.insertTarget;
  if (!link?.image || link.children !== 0 || target?.mode !== 'replace' || target.nodeIds?.length !== 1 || target.nodeIds[0] !== state.selection.node?.id
    || !artwork || artworkGeneration !== state.connectionGeneration || !artworkCurrentFor(link)) return null;
  const art = changedArt(artwork, link);
  const asset = artworkAsset(artwork, art);
  const placement = artwork.placements.find(item => item.key === link.placementKey);
  return art && asset && placement ? { art, asset, environment: link.environment, placement } : null;
}
/** A cell with no art says so; a sent layer with contents can only replace different Draft art by syncing. */
export function linkArtworkMeta(link: SelectedLink): string | null {
  if (!artworkCurrentFor(link)) return null;
  const cell = currentCell(link.placementKey, link);
  if (!cell) return null;
  const art = cell[link.environment];
  if (!art) return `${environmentLabel(link.environment)} no longer has art for this cell.`;
  return link.environment === 'draft' && (!link.image || link.children > 0) && art.assetId !== link.assetId
    ? 'Draft has different art now. Sync replaces it with this layer.' : null;
}
/** Where this layer's image is published, with Production taking precedence over Staging and Draft. */
export function linkStatus(link: InsertLink, coordinate: CellCoordinate = link): string | null {
  if (!artworkCurrentFor(link)) return null;
  const cell = currentCell(link.placementKey, coordinate);
  if (!cell) return null;
  if (cell.production?.assetId === link.assetId && artwork?.environments.production) return `in Production (release ${artwork.environments.production.sequence})`;
  if (cell.staging?.assetId === link.assetId) return 'in Staging, not in Production';
  return cell.draft?.assetId === link.assetId ? 'in Draft, not published' : null;
}
/** Only artwork supplies a placement page's id; before it loads, the bar keeps the image page. */
export function slotIdOf(key: string): string | null {
  return currentPlacement(key)?.slotId ?? null;
}

/** Reveal the linked cell in Insert; a pending reveal is completed once its artwork arrives. */
export function revealPlacement(key: string, cell: CellCoordinate, environment: EnvironmentName): void {
  setBrowse('placements');
  if (!artwork || artworkGeneration !== state.connectionGeneration || state.ops.loadingList === 'placements') {
    pendingReveal = { key, cell, environment };
    enterInsert();
    return;
  }
  pendingReveal = null;
  const placement = artwork.placements.find(item => item.key === key);
  if (!placement) return;
  const query = currentQuery().toLowerCase();
  if (query && !key.toLowerCase().includes(query) && !placement.screen.toLowerCase().includes(query)) clearSearch();
  setEnvironment(environment, true);
  const shownCell = findCell(placement, cell) ? { ...cell, state: cell.state ?? placement.defaultState } : firstCell(placement);
  selected = { kind: 'placement', key, cell: shownCell };
  activeKey = key;
  scheduleRender(true);
  flushRender();
  const row = rows.get(key);
  row?.scrollIntoView({ block: 'nearest' });
  row?.focus({ preventScroll: true });
}

/** The list's state, unless the open connection settings already say it under the token field. */
function renderEmpty(current: ListState | null): void {
  const empty = current?.connection && problemInSettings() ? null : current;
  emptyState.hidden = !empty;
  const title = element('insert-empty-title');
  title.hidden = !empty?.title;
  title.textContent = empty?.title ?? '';
  element('insert-empty-text').textContent = empty?.text ?? '';
  element('insert-clear').hidden = empty?.action !== 'clear';
  for (const id of ['insert-retry', 'insert-token', 'insert-go-send']) element(id).className = syncBar() === null ? 'primary' : 'secondary';
  element('insert-retry').hidden = empty?.action !== 'retry';
  // With the settings open, the token field is on screen already. A browser connection is made again, never with a token.
  const tokenAction = element('insert-token');
  tokenAction.hidden = empty?.action !== 'reconnect' && (empty?.action !== 'token' || element<HTMLDetailsElement>('settings').open);
  tokenAction.textContent = empty?.action === 'reconnect' ? 'Connect again' : 'Update token';
  element('insert-go-send').hidden = empty?.action !== 'send';
  const link = element<HTMLAnchorElement>('insert-empty-link');
  link.hidden = empty?.action !== 'link' || !empty.link;
  link.textContent = empty?.link?.text ?? '';
  if (empty?.link) link.href = empty.link.href;
}

/**
 * Rebuilds the list or grid, a listbox with one tab stop while it has rows or tiles (placements in a group per screen);
 * selection changes only update aria-selected, so focus stays on the row.
 */
export function renderList(): void {
  rows = new Map();
  rowNames = new Map();
  releaseListImages();
  const { browse } = state.prefs;
  const list = element('insert-list');
  const grid = element('image-grid');
  list.hidden = browse === 'images';
  grid.hidden = browse !== 'images';
  const query = currentQuery();
  const lower = query.toLowerCase();
  let empty: ListState | null = null;
  const listChildren: HTMLElement[] = [];
  const gridChildren: HTMLElement[] = [];
  // The connection test runs before any list loads, so it counts as loading too.
  const loading = (kind: 'placements' | 'images') => state.ops.loadingList === kind || (state.ops.connecting && !listError)
    || (kind === 'placements' && quietLoading && !artwork);
  if (!state.connection) empty = { text: 'Connect to Assetlib to browse your app’s images.', action: null };
  else if (browse === 'placements') {
    const current = artwork;
    if (loading('placements')) listChildren.push(...skeletons('placements'));
    else if (!current) empty = listError;
    else if (!current.placements.length) {
      empty = { title: 'No placements yet', text: 'Placements come from your app’s code. When an engineer adds one and runs assetlib sync, or someone requests one in the console, it appears here.',
        action: 'link', link: { text: 'Read the guide', href: GUIDE_URL } };
    } else {
      const matches = current.placements.filter(item => !lower || item.key.toLowerCase().includes(lower) || item.screen.toLowerCase().includes(lower));
      if (!matches.length) empty = { text: `No placements match “${query}”.`, action: 'clear' };
      const screens = distinct(matches.map(item => item.screen));
      screens.forEach((screen, index) => {
        // Each screen is a group of options named by its header, which stays in view while its rows scroll.
        const header = makeNode('p', 'group', screen);
        header.id = `insert-group-${index}`;
        header.setAttribute('role', 'presentation');
        // It names the group (aria-labelledby reads a hidden element too), so it isn't read again as text inside it.
        header.setAttribute('aria-hidden', 'true');
        const group = document.createElement('div');
        group.setAttribute('role', 'group');
        group.setAttribute('aria-labelledby', header.id);
        group.append(header, ...matches.filter(item => item.screen === screen).map(item => placementRow(item, current)));
        listChildren.push(group);
      });
    }
  } else if (browse === 'file') {
    listChildren.push(...fileRows(query, artwork, (row, entry) => {
      row.setAttribute('role', 'option');
      row.addEventListener('click', () => { choose(entry.nodeId); selectFileNode(entry.nodeId); });
      row.addEventListener('dblclick', () => { choose(entry.nodeId); selectFileNode(entry.nodeId); });
      rows.set(entry.nodeId, row); rowNames.set(entry.nodeId, entry.name.toLowerCase());
    }));
    if (!rows.size) empty = query ? { text: `No layers match “${query}”.`, action: 'clear' }
      : { title: `Nothing from Assetlib ${state.fileLinks?.scope === 'file' ? 'in this file' : 'on this page'} yet.`, text: 'Insert a placement from Placements, or drag one onto the canvas.', action: null };
  } else if (!images) {
    if (loading('images')) gridChildren.push(...skeletons('images'));
    else empty = listError;
  } else if (!images.items.length && images.q) empty = { text: `No images match “${images.q}”.`, action: 'clear' };
  else if (!images.items.length) {
    empty = { title: 'No images yet', text: 'Upload images in the Assetlib console, or send a frame from Figma.', action: 'link',
      link: { text: 'Open console', href: consoleLink(state.connection, 'images') } };
  } else gridChildren.push(...images.items.map(imageTile));
  list.replaceChildren(...listChildren);
  grid.replaceChildren(...gridChildren);
  // A listbox only while it holds options; loading, it holds skeletons and the words a screen reader finds there.
  for (const [box, label, shows] of [[list, browse === 'file' ? 'In this file' : 'Placements', browse !== 'images'], [grid, 'Images', browse === 'images']] as const) {
    if (shows && rows.size) { box.setAttribute('role', 'listbox'); box.setAttribute('aria-label', label); }
    else { box.removeAttribute('role'); box.removeAttribute('aria-label'); }
  }
  updateSelected();
  listState = empty;
  renderEmpty(listState);
  renderIntro();
  element('images-more').hidden = browse !== 'images' || !images?.nextCursor;
}

function renderIntro(): void {
  element('intro').hidden = !state.connection || state.prefs.tab !== 'insert' || state.prefs.browse !== 'placements'
    || !artwork?.placements.length || state.prefs.introSeen === true || listError !== null || listState !== null;
}

export function renderInsertControls(): void {
  const { browse } = state.prefs;
  element('browse-placements').setAttribute('aria-checked', String(browse === 'placements'));
  element('browse-images').setAttribute('aria-checked', String(browse === 'images'));
  element('browse-file').setAttribute('aria-checked', String(browse === 'file'));
  renderFileScope();
  rovingStops(browseButtons);
  // Typing stays possible while a list loads; a new search replaces the load.
  searchInput.disabled = !state.connection;
  const label = browse === 'placements' ? 'Search placements or screens' : browse === 'file' ? 'Search layers or placements' : 'Search images';
  searchInput.placeholder = label;
  searchInput.setAttribute('aria-label', label);
  searchClear.hidden = !searchInput.value;
  element('env-group').hidden = browse !== 'placements';
  environmentSelect.hidden = browse !== 'placements';
  const shown = shownEnvironment();
  // An environment chosen while the artwork loaded may turn out to have nothing published: focus moves to the one shown.
  const focusedEnvironment = environmentButtons.find(button => button === document.activeElement);
  for (const name of ENVIRONMENTS) {
    const button = element<HTMLButtonElement>(`env-${name}`);
    button.setAttribute('aria-checked', String(shown === name));
    // Live while the list loads; only an environment with nothing published is off.
    button.disabled = !state.connection || Boolean(artwork && !published(name));
    button.title = environmentTitle(name);
    const option = element<HTMLOptionElement>(`env-option-${name}`);
    option.disabled = Boolean(artwork && !published(name));
    option.title = button.title;
  }
  rovingStops(environmentButtons);
  if (focusedEnvironment?.disabled) element(`env-${shown}`).focus({ preventScroll: true });
  environmentSelect.disabled = !state.connection;
  environmentSelect.value = shown;
  environmentSelect.title = environmentTitle(shown);
  const refresh = element<HTMLButtonElement>('insert-refresh');
  refresh.disabled = !state.connection;
  refresh.setAttribute('data-busy', String(state.ops.loadingList !== null));
  const note = environmentNote();
  element('env-note').textContent = note;
  element('env-note').hidden = !note;
  for (const [id, kind] of [['insert-list', 'placements'], ['image-grid', 'images']] as const) {
    if (state.ops.loadingList === kind) element(id).setAttribute('aria-busy', 'true'); else element(id).removeAttribute('aria-busy');
  }
  // Opening or closing the connection settings shows or hides a failure the settings say instead.
  renderEmpty(listState);
  renderIntro();
}
export function renderInsertBar(): void {
  const target = insertTarget();
  // The footer shows only with something chosen to insert.
  insertBar.hidden = !state.connection || state.prefs.tab !== 'insert' || !target;
  showThumbnail(insertThumb, insertBar.hidden ? null : target?.asset ?? null);
  // A cell with nothing in this environment is the row's empty slot here too.
  element('insert-preview').className = target?.empty ? 'thumb slot' : 'thumb';
  element('insert-title').textContent = target?.title ?? '';
  // Placement art: the reference size, secondary to the ratio a row shows.
  const chosen = selectedPlacement();
  element('insert-title').title = chosen ? `${chosen.key} · ${referenceSize(chosen)}` : '';
  element('insert-meta').textContent = target?.meta ?? '';
  // The whole line on hover, for a narrow window that shortens it.
  element('insert-meta').title = target?.meta ?? '';
  const canvas = canvasTarget(target);
  const reported = reportedTarget();
  const beside = besideComponent(reported, target) ? `Figma doesn’t put components inside components, so this goes beside ${reported.name ?? 'the selection'}.` : '';
  const note = target?.note || (target?.ready ? [modeNote(canvas, target), beside].filter(Boolean).join(' ') : '');
  element('insert-note').textContent = note;
  element('insert-note').hidden = !note;
  element('insert-send-here').hidden = !target?.empty || !hasCurrentSelection() || !state.selection.node || Boolean(state.selection.reason);
  setUnavailable(element('insert-send-here'), actionsBlocked());
  const noteLink = element<HTMLAnchorElement>('insert-note-link');
  noteLink.hidden = !target?.noteLink;
  if (target?.noteLink) noteLink.href = target.noteLink;
  renderCells(selectedPlacement(), selected?.kind === 'placement' ? selected.cell : null, shownEnvironment(), artwork,
    cell => { if (selected?.kind === 'placement') { selected = { ...selected, cell }; scheduleRender(); flushRender(); } },
    () => { if (selected?.kind === 'placement') insertFrom(selected.key); });
  scaleButtons.forEach((button, index) => button.setAttribute('aria-checked', String(state.prefs.scale === index + 1)));
  rovingStops(scaleButtons);
  // The selection decides the action: Insert, Insert into, Fill, or Replace image; a fill keeps the layer's size, and
  // what can't be inserted has no size to choose.
  element('scale-group').hidden = canvas.mode !== 'new' || !target?.ready;
  insertButton.className = state.tokenRefused && element<HTMLDetailsElement>('settings').open && !state.pairingActive ? 'secondary' : 'primary';
  const inserting = state.ops.inserting && !isUpdating();
  setBusy(insertButton, inserting ? 'Inserting…' : canvas.label, inserting);
  // The whole label on hover, for a layer name the button shortens.
  insertButton.title = canvas.mode === 'new' ? '' : canvas.label;
  insertNewButton.hidden = canvas.mode === 'new';
  const unavailable = actionsBlocked() || !state.connection || !target?.ready || pendingInsert !== null;
  setUnavailable(insertButton, unavailable);
  setUnavailable(insertNewButton, unavailable);
  // The chosen row drags the cell its strip shows; the row chosen before drags its base cell again.
  const key = selectedKey();
  if (dragFollows !== null && dragFollows !== key) {
    const before = rows.get(dragFollows);
    if (before) before.draggable = canDrag(insertTarget(choiceFor(dragFollows)));
  }
  dragFollows = key;
  const row = key === null ? undefined : rows.get(key);
  if (row) row.draggable = canDrag(target);
  // How to insert, until the first insert or until closed; the footer takes its place while something is chosen.
  // The Sync bar, when it shows, is what the selection is about.
  hintBar.hidden = state.prefs.browse === 'file' || !state.connection || state.prefs.tab !== 'insert' || !insertBar.hidden || state.prefs.hintSeen === true || rows.size === 0
    || syncBar() !== null || !element('intro').hidden;
}

/** Opens the Insert tab's list for this connection, unless it is loaded or loading. Waits for the connection test. */
export function enterInsert(): void {
  if (state.prefs.tab !== 'insert' || !state.connection || state.connectionGeneration === null || state.ops.connecting) return;
  if (state.prefs.browse === 'placements') {
    if ((artworkGeneration !== state.connectionGeneration || artworkListStale) && !quietLoading && state.ops.loadingList !== 'placements') void loadArtwork();
  } else if (state.prefs.browse === 'file') requestFileScan();
  else if (state.ops.loadingList !== 'images' && (!images || images.q !== currentQuery())) void loadImages(true);
  ensureArtwork();
}

/** Artwork belongs to both tabs and to the Sync bar, independently of an Images list load. */
export function ensureArtwork(force = false): void {
  if (!state.connection || state.connectionGeneration === null || state.ops.connecting) return;
  if (state.ops.loadingList === 'placements') { if (force) artworkRefreshPending = true; return; }
  if (!force && (artworkGeneration === state.connectionGeneration || quietLoading)) return;
  artworkRefreshPending = false;
  void loadArtworkQuietly();
}
/** Focus and visibility refresh quietly at most once a minute after a completed load. */
export function refreshArtworkIfStale(): void {
  if (quietLoading || state.ops.loadingList === 'placements' || (artworkFinishedAt !== null && Date.now() - artworkFinishedAt < 60000)) return;
  ensureArtwork(true);
}
function acceptArtwork(payload: unknown, generation: number, from: number, attention: number): void {
  artwork = parseArtwork(payload);
  artworkGeneration = generation;
  artworkFrom = from;
  artworkListStale = false;
  const placement = selectedPlacement();
  if (selected?.kind === 'placement') {
    if (!placement) selected = null;
    else {
      const cell = findCell(placement, selected.cell) ? { ...selected.cell, state: selected.cell.state ?? placement.defaultState } : firstCell(placement);
      selected = { ...selected, cell };
    }
  }
  if (attention === state.attentionCount) markConnected();
}
function finishReveal(): void {
  const reveal = pendingReveal;
  pendingReveal = null;
  const shown = syncBar();
  if (!reveal || !artwork || artworkGeneration !== state.connectionGeneration || state.prefs.tab !== 'insert' || state.prefs.browse !== 'placements'
    || (shown?.kind !== 'linked' && shown?.kind !== 'copy') || shown.key !== reveal.key) return;
  revealPlacement(reveal.key, reveal.cell, reveal.environment);
}
async function loadArtworkQuietly(): Promise<void> {
  const config = state.connection;
  const generation = state.connectionGeneration;
  if (!config || generation === null) return;
  const ticket = ++quietTicket;
  quietLoading = true;
  const from = Date.now(), attention = state.attentionCount;
  quietFrom = from;
  artworkRequested(from);
  let dropped = false;
  try {
    const result = await send(config, { path: 'placements/artwork', retry: false, channel: 'artwork' });
    if (generation !== state.connectionGeneration || ticket !== quietTicket || result.kind === 'aborted') { dropped = true; return; }
    if (result.status !== 200) {
      if (await replacedElsewhere(config, generation, result)) return;
      if (tokenRefused(result.status, result.payload)) needsAttention({ text: TOKEN_NO_LONGER_ACCEPTED, field: 'token' }, true);
      return;
    }
    acceptArtwork(result.payload, generation, from, attention);
    scheduleRender(true);
  } catch { /* A quiet reload keeps the artwork already shown and never uses the error line. */ }
  finally {
    if (ticket === quietTicket) {
      quietLoading = false;
      quietFrom = null;
      if (generation === state.connectionGeneration) artworkFinishedAt = Date.now();
      if (!artwork) {
        scheduleRender(true);
        // The person opened Placements while its first quiet read waited. A normal list load can now show a failure;
        // a failed full load keeps its own notice, so this does not turn into an automatic retry loop.
        if (generation === state.connectionGeneration && !state.ops.connecting && !listError
          && state.prefs.tab === 'insert' && state.prefs.browse === 'placements' && state.ops.loadingList !== 'placements') void loadArtwork();
      }
      // A full load that runs (or just started) finishes a pending reveal itself.
      if (generation === state.connectionGeneration && state.ops.loadingList !== 'placements') finishReveal();
    }
    if (dropped) artworkDropped();
  }
}

/**
 * A list read failed: its state replaces the list, the alert region announces it, and focus moves to it unless the
 * person is in a field. A refused token the open settings already say (needsAttention) is left to them.
 */
function showListError(failure: ReadFailure): void {
  listError = { ...readProblem(failure, state.connection?.method), connection: refusedToken(failure) };
  presentListError();
}
function presentListError(): void {
  scheduleRender(true);
  if (!listError || (listError.connection && problemInSettings())) return;
  announceError(listError.text);
  if (inField(document.activeElement)) return;
  flushRender();
  emptyState.focus({ preventScroll: true });
  emptyState.scrollIntoView({ block: 'nearest' });
}
function readFailureOf(result: HttpResult, text: string): ReadFailure {
  const code = refusalCode(result.payload);
  return { kind: result.kind === 'ok' || result.kind === 'aborted' ? 'http' : result.kind, status: result.status, text, ...(code ? { code } : {}) };
}
/**
 * The connection test failed, so the list says why and waits for its action. `present`, when the Insert tab is in
 * front: the list announces it and takes focus, as any failed list does (unless the open settings say it).
 */
export function listUnavailable(failure: ReadFailure | null, present: boolean): void {
  listError = { ...readProblem(failure, state.connection?.method), connection: true };
  if (present) presentListError(); else scheduleRender(true);
}
function startList(kind: 'placements' | 'images', query = ''): number {
  listTicket += 1;
  state.ops.loadingList = kind;
  loadingQuery = query;
  listError = null;
  clearError();
  return listTicket;
}
function endList(ticket: number, generation: number): void {
  if (generation !== state.connectionGeneration || ticket !== listTicket) return;
  state.ops.loadingList = null;
  scheduleRender(true);
}
/**
 * Main refused a connection save, so the connection stands. A list load that finished while the save waited was dropped
 * as another generation's and left the list loading, and a Refresh, search, or Load more asked for meanwhile never
 * started: the list in view loads again, as Refresh would (a load still running is replaced). Otherwise the rows and the
 * choice stay, and a view opened meanwhile loads what it lacks.
 */
export function connectionKept(): void {
  const refresh = listDeferred || state.ops.loadingList !== null;
  listDeferred = false;
  if (state.ops.loadingList !== null) {
    state.ops.loadingList = null; loadingQuery = ''; listTicket += 1;
    // Placements that never arrived load when the Insert tab next shows them.
    if (!artwork) artworkGeneration = null;
    scheduleRender(true);
  }
  if (refresh && state.prefs.tab === 'insert') {
    if (state.prefs.browse === 'file') requestFileScan();
    else if (state.prefs.browse === 'placements') void loadArtwork(); else void loadImages(true);
  } else enterInsert();
  ensureArtwork(artworkRefreshPending);
}
async function loadArtwork(): Promise<void> {
  const config = state.connection;
  const generation = state.connectionGeneration;
  if (!config) return;
  // Only a connection save in progress leaves a connection without a generation.
  if (generation === null) { listDeferred = true; return; }
  const ticket = startList('placements');
  // The full load supersedes a quiet one, but the Sync bar keeps the artwork already shown while it refreshes.
  const artworkTicket = ++quietTicket;
  quietLoading = false;
  quietFrom = null;
  artworkListStale = true;
  scheduleRender(true);
  const from = Date.now(), attention = state.attentionCount;
  artworkRequested(from);
  try {
    // A new list load or a connection change aborts this one; whoever replaced it owns the list.
    const result = await send(config, { path: 'placements/artwork', channel: 'list' });
    if (generation !== state.connectionGeneration || ticket !== listTicket || result.kind === 'aborted') { artworkDropped(); return; }
    if (result.status !== 200) {
      if (await replacedElsewhere(config, generation, result)) return;
      if (tokenRefused(result.status, result.payload)) needsAttention({ text: TOKEN_NO_LONGER_ACCEPTED, field: 'token' }, true);
      const failure = readFailureOf(result, readFailure(result, config, 'insert'));
      artwork = null;
      artworkGeneration = null;
      artworkFrom = null;
      if (selected?.kind === 'placement') selected = null;
      showListError(failure);
      return;
    }
    acceptArtwork(result.payload, generation, from, attention);
  } catch (error) {
    if (generation !== state.connectionGeneration || ticket !== listTicket) return;
    artwork = null;
    artworkGeneration = null;
    artworkFrom = null;
    if (selected?.kind === 'placement') selected = null;
    showListError({ kind: 'invalid', status: 200, text: errorText(error) });
  } finally {
    if (generation === state.connectionGeneration && artworkTicket === quietTicket) artworkFinishedAt = Date.now();
    endList(ticket, generation);
    if (generation === state.connectionGeneration && ticket === listTicket) finishReveal();
    if (generation === state.connectionGeneration && artworkTicket === quietTicket && artworkRefreshPending) ensureArtwork(true);
  }
}
async function loadImages(reset: boolean): Promise<void> {
  const config = state.connection;
  const generation = state.connectionGeneration;
  if (!config) return;
  if (generation === null) { listDeferred = true; return; }
  // Load more waits for the page already loading; a new search or Refresh replaces it.
  if (!reset && state.ops.loadingList === 'images') return;
  const previous = images;
  const q = reset ? currentQuery() : previous?.q ?? '';
  const cursor = reset ? undefined : previous?.nextCursor ?? undefined;
  if (!reset && !cursor) return;
  const ticket = startList('images', q);
  if (reset) { images = null; if (selected?.kind === 'image') selected = null; }
  scheduleRender(true);
  let failure: ReadFailure | null = null;
  try {
    const result = await send(config, { path: assetsPath({ limit: 24, cursor, q: q || undefined }), channel: 'list' });
    if (generation !== state.connectionGeneration || ticket !== listTicket || result.kind === 'aborted') return;
    if (result.status !== 200) {
      if (await replacedElsewhere(config, generation, result)) return;
      if (tokenRefused(result.status, result.payload)) needsAttention({ text: TOKEN_NO_LONGER_ACCEPTED, field: 'token' }, true);
      failure = readFailureOf(result, readFailure(result, config, 'insert'));
      throw new Error(failure.text);
    }
    const page = parseAssetPage(result.payload);
    const added = previous && !reset ? page.assets.filter(asset => !previous.items.some(item => item.id === asset.id)) : page.assets;
    images = { items: previous && !reset ? [...previous.items, ...added] : added, nextCursor: page.nextCursor, q };
    markConnected();
    // On the last page Load more hides; focus moves to the first new image rather than the page.
    if (!reset && added[0]) preferFocus(added[0].id);
  } catch (error) {
    if (generation !== state.connectionGeneration || ticket !== listTicket) return;
    // A failed Load more keeps the pages already shown, and says so in the error line.
    if (!reset) {
      images = previous;
      // A browser connection the console refused offers Connect again there too.
      showInsertError(failure && refusedToken(failure) ? config.method === 'browser' ? reconnectText(failure.code) : TOKEN_NO_LONGER_ACCEPTED : errorText(error));
    }
    else showListError(failure ?? { kind: 'invalid', status: 200, text: errorText(error) });
  } finally { endList(ticket, generation); }
}
function searchImages(): void {
  searchTimer = null;
  if (state.prefs.browse !== 'images' || !state.connection) return;
  const q = currentQuery();
  // A search for something else replaces the load in flight.
  if (state.ops.loadingList === 'images' ? loadingQuery !== q : !images || images.q !== q) void loadImages(true);
}
/**
 * A browser connection the console refused: true when another plugin window replaced it on this device and this window
 * now uses that one (reloadConnection), so the read is dropped quietly and the new connection's lists load.
 */
async function replacedElsewhere(config: Connection, generation: number, result: HttpResult): Promise<boolean> {
  return config.method === 'browser' && tokenRefused(result.status, result.payload) && await reloadConnection(generation);
}
/** Downloads a version and checks it, as PNG bytes (a WebP is converted); null when a connection change abandoned it. */
async function fetchPng(config: Connection, generation: number, asset: LibraryAsset, rendition: RenditionInfo,
  converting: () => void): Promise<Uint8Array | null> {
  const result = await send(config, { path: renditionPath(asset.id, rendition.sha256), bytes: rendition.bytes });
  if (generation !== state.connectionGeneration || result.kind === 'aborted') return null;
  if (result.status !== 200) {
    if (await replacedElsewhere(config, generation, result)) return null;
    const refused = tokenRefused(result.status, result.payload);
    if (refused) needsAttention(null, true);
    // A browser connection the console refused is made again (showInsertError offers Connect again).
    if (refused) throw new Error(config.method === 'browser' ? reconnectText(refusalCode(result.payload)) : TOKEN_NO_LONGER_ACCEPTED);
    // This console listed the image, so a 404 means the image went away, not that the console lacks Insert.
    throw new Error(result.kind === 'http' && result.status === 404 ? GONE_IMAGE : readFailure(result, config, 'insert'));
  }
  if (mediaType(result.contentType) !== rendition.mime || result.bytes.byteLength !== rendition.bytes) throw new Error(UNEXPECTED_IMAGE);
  markConnected();
  let bytes = result.bytes;
  if (rendition.mime === 'image/webp') {
    converting();
    try { bytes = await webpToPng(bytes); }
    catch { throw new Error('Figma couldn’t use this WebP image. Try again, or download it from the console.'); }
    if (generation !== state.connectionGeneration) return null;
  }
  const size = pngSize(bytes);
  if (!size || size.width !== rendition.width || size.height !== rendition.height) throw new Error(UNEXPECTED_IMAGE);
  return bytes;
}
/**
 * The insert download of a version: a drag starts it, and its drop, another drag, or an Insert reuses it while it runs
 * and for a minute after (at most three are kept). A failed one is forgotten, so the next try downloads again.
 */
function download(config: Connection, generation: number, asset: LibraryAsset, rendition: RenditionInfo, status?: (text: string) => void): Promise<Uint8Array | null> {
  for (const [sha, item] of downloads) if (item.generation !== generation) downloads.delete(sha);
  const cached = downloads.get(rendition.sha256);
  if (cached) {
    // An Insert that reuses a drag's download still says when it converts.
    if (status) { cached.status = status; if (cached.converting) status(CONVERTING); }
    return cached.bytes;
  }
  const entry: Download = { generation, status, converting: false,
    bytes: fetchPng(config, generation, asset, rendition, () => { entry.converting = true; entry.status?.(CONVERTING); }) };
  downloads.set(rendition.sha256, entry);
  while (downloads.size > 3) downloads.delete(downloads.keys().next().value!);
  const forget = () => { if (downloads.get(rendition.sha256) === entry) downloads.delete(rendition.sha256); };
  entry.bytes.then(bytes => { entry.converting = false; if (bytes) window.setTimeout(forget, DOWNLOAD_KEEP_MS); else forget(); }, forget);
  return entry.bytes;
}

/**
 * Insert, Insert into, Fill, or Replace image, as the canvas selection decides when it is chosen (main refuses it if the
 * selection changes during the download); `asNew`, Insert as new layer. A fill downloads only what the layer needs.
 */
async function beginInsert(asNew = false): Promise<void> {
  const config = state.connection;
  const generation = state.connectionGeneration;
  if (!config || generation === null || actionsBlocked() || pendingInsert) return;
  const target = insertTarget();
  const asset = target?.asset;
  if (!target || !asset || !target.ready) return;
  // The size the footer showed when Insert was chosen, even if Insert at changes during the download.
  const { scale } = state.prefs;
  const canvas = asNew ? NEW_FRAME : canvasTarget(target);
  const destination: InsertDestination = canvas.mode === 'new' ? { kind: 'new' }
    : canvas.mode === 'into' ? { kind: 'into', nodeId: canvas.nodeIds[0]! } : { kind: 'fill', nodeIds: [...canvas.nodeIds] };
  clearError();
  const rendition = filling(canvas) ? fillRendition(asset, canvas.containerWidth ?? 0, canvas.containerHeight ?? 0) : insertRendition(asset);
  if (!rendition) { showError(TOO_LARGE); return; }
  return downloadInsert(config, generation, asset, rendition, 'insert',
    { name: target.name, frame: target.frame, scale, link: target.link, target: destination });
}
/** Update shares Insert's download and completion pipeline, but only its own button shows the busy state. */
export function isUpdating(): boolean { return pendingInsert?.kind === 'update'; }
export async function updateLinked(): Promise<void> {
  const config = state.connection;
  const generation = state.connectionGeneration;
  const node = state.selection.node;
  const link = currentLink();
  const update = linkUpdate();
  if (!config || generation === null || !node || !link || !update || actionsBlocked() || pendingInsert) return;
  const { asset, art, placement, environment } = update;
  const rendition = fillRendition(asset, node.width, node.height);
  if (!rendition) { showInsertError(asset.renditions.length ? TOO_LARGE : NEEDS_UPLOAD); return; }
  const name = layerName(placement, link);
  return downloadInsert(config, generation, asset, rendition, 'update', {
    name, frame: { width: placement.width, height: placement.height }, scale: 1,
    link: { placementKey: link.placementKey, state: link.state, appearance: link.appearance, arm: link.arm, environment, assetId: art.assetId },
    target: { kind: 'fill', nodeIds: [node.id] }, update: { from: link.assetId },
  });
}
/** Both image actions keep their captured destination and let the current operation alone post or report a failure. */
async function downloadInsert(config: Connection, generation: number, asset: LibraryAsset, rendition: RenditionInfo, kind: 'insert' | 'update',
  payload: Omit<Extract<UiMessage, { type: 'insert' }>, 'type' | 'requestId' | 'connectionGeneration' | 'bytes'>): Promise<void> {
  const operation = { id: nextRequestId(), generation, kind };
  pendingInsert = operation;
  state.ops.inserting = true;
  if (kind === 'update') clearError();
  setStatus(`Downloading ${payload.name}…`);
  scheduleRender();
  try {
    const bytes = await download(config, generation, asset, rendition, setStatus);
    // A connection switch drops the action quietly; the new connection owns the busy state.
    if (generation !== state.connectionGeneration || pendingInsert !== operation || !bytes) return;
    setStatus(`${kind === 'update' ? 'Updating' : 'Inserting'} ${payload.name}…`);
    post({ type: 'insert', requestId: operation.id, connectionGeneration: generation, bytes, ...payload });
  } catch (error) {
    if (generation !== state.connectionGeneration || pendingInsert !== operation) return;
    failInsert(operation.id, errorText(error));
  }
}
/**
 * An insert or a drop failed; an image removed since the list loaded offers Refresh, which brings the list up to date,
 * and a browser connection the console no longer accepts offers Connect again.
 */
function showInsertError(text: string): void {
  showError(text, text === GONE_IMAGE ? { label: 'Refresh', run: refreshList }
    : (isReconnectText(text) || text === TOKEN_NO_LONGER_ACCEPTED) ? { label: 'Connect again', run: () => { void startConnect(hintOfCurrent()); } } : undefined);
}

// ---- Drag to canvas ----
/**
 * A row or tile starts dragging when Insert could insert it now: its thumbnail is the drag image, and the insert download
 * starts (or is reused), so the image is often ready by the drop. Anything else stays put, as an unavailable Insert does.
 */
function dragStart(event: DragEvent, key: string): void {
  const config = state.connection;
  const generation = state.connectionGeneration;
  const target = insertTarget(choiceFor(key));
  const rendition = target?.asset ? insertRendition(target.asset) : null;
  const data = event.dataTransfer;
  if (!config || generation === null || !target?.asset || !target.ready || !rendition || !data || actionsBlocked() || pendingInsert || pendingDrop) {
    event.preventDefault();
    return;
  }
  data.effectAllowed = 'copy';
  data.setData(DRAG_TYPE, key);
  const thumb = rows.get(key)?.children[0] as HTMLElement | undefined;
  if (thumb) {
    const box = thumb.getBoundingClientRect();
    data.setDragImage(thumb, box.width / 2, box.height / 2);
  }
  dragging = { generation, target, scale: state.prefs.scale, bytes: download(config, generation, target.asset, rendition) };
}
/**
 * The drag ended. Inside the plugin window (Figma's check: the event's view holds no frames) nothing happens. Outside, the
 * drop goes to Figma as `pluginDrop`, and Insert waits for main's `dropped` (or its error) and then for the download.
 */
function dragEnd(event: DragEvent): void {
  const drag = dragging;
  dragging = null;
  if (!drag || !event.view || event.view.length === 0) return;
  if (drag.generation !== state.connectionGeneration || actionsBlocked() || pendingInsert || pendingDrop) return;
  const id = nextRequestId();
  const { target } = drag;
  pendingDrop = { ...drag, id, nodeId: null, timer: window.setTimeout(() => dropUnanswered(id), DROP_REPLY_MS) };
  state.ops.inserting = true;
  clearError();
  setStatus(`Inserting ${target.name}…`);
  scheduleRender();
  postDrop({ clientX: event.clientX, clientY: event.clientY, files: [],
    dropMetadata: { assetlib: 1, dropId: id, connectionGeneration: drag.generation, name: target.name, frame: target.frame, scale: drag.scale, link: target.link } });
}
/** No drop event reached main (the drag ended off the canvas): nothing was made, so the wait ends without a word. */
function dropUnanswered(id: number): void {
  if (pendingDrop?.id !== id || pendingDrop.nodeId !== null) return;
  endDrop();
  setStatus('');
}
function endDrop(): void {
  if (pendingDrop) window.clearTimeout(pendingDrop.timer);
  pendingDrop = null;
  state.ops.inserting = false;
  scheduleRender();
}
/** Main made a placeholder for the drop, or found the image frame it landed on: once downloaded, the image fills it. */
export function dropped(message: Extract<MainMessage, { type: 'dropped' }>): void {
  const drop = pendingDrop;
  if (!drop || drop.id !== message.dropId || message.connectionGeneration !== drop.generation) {
    // A drop given up on (its answer came too late): its placeholder goes.
    post({ type: 'discard-placeholder', nodeId: message.nodeId });
    return;
  }
  // Answered already.
  if (drop.nodeId !== null) return;
  window.clearTimeout(drop.timer);
  drop.nodeId = message.nodeId;
  void fillDrop(drop, message.nodeId);
}
async function fillDrop(drop: NonNullable<typeof pendingDrop>, nodeId: string): Promise<void> {
  let bytes: Uint8Array | null;
  try { bytes = await drop.bytes; } catch (error) {
    // A connection change ended the drop already, and main removed its placeholder.
    if (pendingDrop !== drop) return;
    post({ type: 'discard-placeholder', nodeId });
    endDrop();
    setStatus('');
    showInsertError(errorText(error));
    return;
  }
  if (pendingDrop !== drop) return;
  if (!bytes) { post({ type: 'discard-placeholder', nodeId }); endDrop(); setStatus(''); return; }
  pendingDrop = null;
  pendingInsert = { id: nextRequestId(), generation: drop.generation, kind: 'insert' };
  post({ type: 'insert', requestId: pendingInsert.id, connectionGeneration: drop.generation, bytes, name: drop.target.name, frame: drop.target.frame,
    scale: drop.scale, link: drop.target.link, target: { kind: 'fill', nodeIds: [nodeId] }, drop: drop.id });
}
/** Main refused the drop (a connection change, an insert running); false when the error belongs to another operation. */
export function failDrop(requestId: number, message: string): boolean {
  if (pendingDrop?.id !== requestId) return false;
  endDrop();
  setStatus('');
  showInsertError(message);
  return true;
}

/** Main inserted, filled, or replaced, and said so in a toast; the status region repeats it. */
export function inserted(message: Extract<MainMessage, { type: 'inserted' }>): void {
  const operation = pendingInsert;
  if (!operation || operation.id !== message.requestId || operation.generation !== message.connectionGeneration) return;
  pendingInsert = null;
  state.ops.inserting = false;
  setStatus(sentence(message.notice));
  // The first insert (or drop) retires the hint and intro for good.
  if (!state.prefs.hintSeen || !state.prefs.introSeen) { state.prefs.hintSeen = true; state.prefs.introSeen = true; savePreferences(); }
  scheduleRender();
}

/** Main's error for an insert; false when it belongs to another operation. */
export function failInsert(requestId: number, message: string): boolean {
  if (pendingInsert?.id !== requestId) return false;
  pendingInsert = null;
  state.ops.inserting = false;
  setStatus('');
  showInsertError(message);
  scheduleRender();
  return true;
}

export function resetInsert(): void {
  resetFile();
  artwork = null; artworkGeneration = null; images = null; selected = null; pendingInsert = null; activeKey = null; dragFollows = null;
  artworkFrom = null; quietFrom = null; seenLinks.clear(); checkedLinks.clear();
  quietTicket += 1; quietLoading = false; artworkRefreshPending = false; artworkFinishedAt = null; artworkListStale = false; pendingReveal = null;
  state.ops.loadingList = null; loadingQuery = ''; listError = null; listDeferred = false; listTicket += 1;
  state.ops.inserting = false;
  // Main removes a drop's placeholder itself when the connection changes.
  if (pendingDrop) window.clearTimeout(pendingDrop.timer);
  pendingDrop = null; dragging = null; downloads = new Map();
  if (searchTimer !== null) { window.clearTimeout(searchTimer); searchTimer = null; }
  resetThumbnails();
  scheduleRender(true);
}

function setBrowse(next: Preferences['browse']): void {
  if (state.prefs.browse === next) return;
  if (next !== 'placements') pendingReveal = null;
  state.prefs.browse = next;
  selected = null;
  activeKey = null;
  if (!actionsBlocked()) setStatus('');
  savePreferences();
  scheduleRender(true);
  enterInsert();
}
function setEnvironment(next: EnvironmentName, reveal = false): void {
  if (!reveal && artwork && !published(next)) return;
  state.prefs.environment = next;
  state.prefs.environmentChosen = true;
  savePreferences();
  scheduleRender(true);
}
function setScale(next: 1 | 2 | 3): void {
  if (state.prefs.scale === next) return;
  state.prefs.scale = next;
  savePreferences();
  scheduleRender();
}
/** Refresh, and the list's Try again: failed previews are tried again with the list. */
function refreshList(): void {
  if (!state.connection) return;
  retryFailedThumbnails();
  if (state.prefs.browse === 'file') requestFileScan();
    else if (state.prefs.browse === 'placements') void loadArtwork(); else void loadImages(true);
}
function clearSearch(): void {
  searchInput.value = '';
  if (state.prefs.browse !== 'images') scheduleRender(true); else searchImages();
  scheduleRender();
}

/** Enter or a double-click on a row or tile: choose it, then Insert; when Insert can't use it, say why (the footer shows it). */
function insertFrom(key: string): void {
  choose(key);
  if (state.prefs.browse === 'file') { selectFileNode(key); return; }
  const target = insertTarget();
  if (target && !target.ready && !actionsBlocked() && !pendingInsert) { setStatus(target.note); return; }
  void beginInsert();
}
/** Nothing chosen: the footer goes, and focus stays where it is. Not while an insert runs, whose footer says so. */
function clearSelection(): void {
  selected = null;
  updateSelected();
  if (!actionsBlocked()) setStatus('');
  clearError();
  scheduleRender();
}
/** Esc in the search or the list: clears the search, then the choice. */
function escape(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
  if (searchInput.value) { event.preventDefault(); clearSearch(); return; }
  if (selected && !state.ops.inserting) { event.preventDefault(); clearSelection(); }
}
/** `/` or Cmd+F: the search field, with its text selected so typing replaces it. */
export function focusSearch(): void {
  flushRender();
  if (searchInput.disabled) return;
  searchInput.focus();
  searchInput.select();
}
/** The grid's columns, as laid out: the tiles before the first one on a lower row. */
function columns(items: HTMLElement[]): number {
  const top = items[0]?.getBoundingClientRect().top ?? 0;
  const below = items.findIndex(item => item.getBoundingClientRect().top > top + 1);
  return below > 0 ? below : Math.max(items.length, 1);
}
/**
 * Type-ahead: the next row whose name starts with the letters typed less than half a second apart. The same letter again
 * moves on to the next row it starts; more letters keep the current row while it still matches.
 */
function typeAhead(char: string, index: number, keys: string[]): string | undefined {
  const now = Date.now();
  typed = { text: (now - typed.at < 500 ? typed.text : '') + char.toLowerCase(), at: now };
  const repeated = [...typed.text].every(letter => letter === typed.text[0]);
  const prefix = repeated ? typed.text.slice(0, 1) : typed.text;
  const start = repeated ? index + 1 : index;
  for (let step = 0; step < keys.length; step += 1) {
    const key = keys[(start + step) % keys.length]!;
    if (rowNames.get(key)?.startsWith(prefix) || (state.prefs.browse === 'placements' && key.slice(key.lastIndexOf('.') + 1).toLowerCase().startsWith(prefix))) return key;
  }
  return undefined;
}
/**
 * The list's keys, on the focused row or tile. ↑ and ↓ (in the grid ← and → too, and ↑ and ↓ by a row of tiles), Home,
 * End, and type-ahead move focus and the choice together; Space chooses the focused row; Enter inserts it.
 */
function listKeydown(event: KeyboardEvent): void {
  const keys = [...rows.keys()];
  const current = keyOf(event.target as Element | null);
  const index = current !== null && rows.get(current) === event.target ? keys.indexOf(current) : -1;
  if (index < 0 || current === null || event.altKey || event.ctrlKey || event.metaKey) return;
  const grid = state.prefs.browse === 'images';
  const last = keys.length - 1;
  let next: string | undefined;
  switch (event.key) {
    case 'ArrowDown': {
      const step = grid ? columns([...rows.values()]) : 1;
      // From the second-last row of tiles, ↓ reaches the last tile even when the row below is short.
      next = keys[index + step] ?? (Math.floor(index / step) < Math.floor(last / step) ? keys[last] : undefined);
      break;
    }
    case 'ArrowUp': next = keys[index - (grid ? columns([...rows.values()]) : 1)]; break;
    case 'ArrowRight': if (!grid) return; next = keys[index + 1]; break;
    case 'ArrowLeft': if (!grid) return; next = keys[index - 1]; break;
    case 'Home': next = keys[0]; break;
    case 'End': next = keys[last]; break;
    // A held Enter inserts once, not once per repeat.
    case 'Enter': event.preventDefault(); if (!event.repeat) insertFrom(current); return;
    case 'Escape': escape(event); return;
    default: {
      // Space inside a type-ahead is a letter of the name; otherwise it chooses the focused row.
      if (event.key === ' ' && Date.now() - typed.at >= 500) { event.preventDefault(); choose(current); return; }
      // `/` belongs to the search shortcut (main.ts).
      if (event.key.length !== 1 || event.key === '/') return;
      event.preventDefault();
      next = typeAhead(event.key, index, keys);
      if (next === undefined) return;
    }
  }
  // At either end the key does nothing, and the list does not scroll instead.
  event.preventDefault();
  const row = next === undefined ? undefined : rows.get(next);
  if (!row || next === undefined) return;
  row.focus({ preventScroll: true });
  choose(next);
  row.scrollIntoView({ block: 'nearest' });
}

export function initInsert(goToSend: () => void): void {
  element('intro-close').addEventListener('click', () => {
    state.prefs.introSeen = true;
    savePreferences();
    scheduleRender();
    searchInput.focus();
  });
  element('insert-send-here').addEventListener('click', () => {
    if (actionsBlocked() || selected?.kind !== 'placement' || !insertTarget()?.empty || !hasCurrentSelection() || !state.selection.node || state.selection.reason) return;
    const choice = { placementKey: selected.key, ...selected.cell };
    goToSend();
    prefillSend(choice, true);
    flushRender();
    element('send').focus();
  });
  element('browse-placements').addEventListener('click', () => setBrowse('placements'));
  element('browse-images').addEventListener('click', () => setBrowse('images'));
  element('browse-file').addEventListener('click', () => setBrowse('file'));
  element('file-all').addEventListener('click', () => requestFileScan(true));
  for (const name of ENVIRONMENTS) element(`env-${name}`).addEventListener('click', () => setEnvironment(name));
  scaleButtons.forEach((button, index) => button.addEventListener('click', () => setScale((index + 1) as 1 | 2 | 3)));
  // Each segmented control is a radio group with one tab stop; the arrow keys choose within it.
  arrowKeys(element('browse-group'), browseButtons, 'radios');
  arrowKeys(element('env-group'), environmentButtons, 'radios');
  environmentSelect.addEventListener('change', () => {
    setEnvironment(environmentSelect.value as EnvironmentName);
    // A choice it keeps nothing of (nothing published there) shows the current one again.
    scheduleRender();
  });
  // The window crossing 400 px swaps the radios and the dropdown, and Chrome drops focus from the one it hides, before
  // any resize event: focus moves to the other, never to the page.
  document.addEventListener('focusout', event => {
    const from = event.target as HTMLElement;
    if (event.relatedTarget || (from !== environmentSelect && !environmentButtons.includes(from as HTMLButtonElement))) return;
    const visible = (item: HTMLElement | undefined) => Boolean(item && typeof item.checkVisibility === 'function' && item.checkVisibility());
    const to = from === environmentSelect ? environmentButtons.find(item => item.tabIndex === 0) : environmentSelect;
    if (to && !visible(from) && visible(to)) to.focus({ preventScroll: true });
  });
  arrowKeys(element('scale-group'), scaleButtons, 'radios');
  for (const box of [element('insert-list'), element('image-grid')]) {
    box.addEventListener('keydown', listKeydown);
    // A row focused by any means holds the tab stop, so Tab leaves the list and Shift+Tab comes back to it.
    box.addEventListener('focusin', event => {
      const key = keyOf(event.target as Element | null);
      if (key !== null && key !== activeKey && rows.get(key) === event.target) { activeKey = key; updateSelected(); }
    });
  }
  searchInput.addEventListener('keydown', escape);
  searchInput.addEventListener('input', () => {
    scheduleRender();
    if (state.prefs.browse !== 'images') { scheduleRender(true); return; }
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(searchImages, 300);
  });
  element('insert-clear').addEventListener('click', clearSearch);
  searchClear.addEventListener('click', () => { clearSearch(); searchInput.focus(); });
  element('insert-refresh').addEventListener('click', refreshList);
  element('insert-retry').addEventListener('click', refreshList);
  element('insert-token').addEventListener('click', () => { if (listError?.action === 'reconnect') void startConnect(hintOfCurrent()); else openSettings(); });
  element('insert-go-send').addEventListener('click', goToSend);
  element('images-more').addEventListener('click', () => { void loadImages(false); });
  insertButton.addEventListener('click', () => { void beginInsert(); });
  insertNewButton.addEventListener('click', () => { void beginInsert(true); });
  // A held Enter or Space clicks a button once per repeat: Insert runs once.
  for (const button of [insertButton, insertNewButton]) {
    button.addEventListener('keydown', event => { if (event.repeat && (event.key === 'Enter' || event.key === ' ')) event.preventDefault(); });
  }
  element('hint-close').addEventListener('click', () => {
    state.prefs.hintSeen = true;
    savePreferences();
    scheduleRender();
  });
}
