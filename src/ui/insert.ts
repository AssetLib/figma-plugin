// The Insert tab: placements by screen and the image library, the cell pickers, and Insert.
import {
  ENVIRONMENTS, GONE_IMAGE, TOKEN_REFUSED, appearanceLabel, artworkAsset, assetsPath, baseCoordinate, consoleLink,
  environmentLabel, findCell, insertRendition, insertUnavailable, layerName, parseArtwork, parseAssetPage, parsePreferences, placementMeta, pngSize,
  renditionPath,
} from '../shared/index.js';
import type {
  Appearance, ArtworkResponse, CellCoordinate, Connection, EnvironmentName, InsertLink, LibraryAsset, PlacementArtwork, Preferences,
} from '../shared/index.js';
import type { MainMessage } from '../shared/protocol.js';
import { webpToPng } from '../image.js';
import { markConnected, needsAttention, openSettings, problemInSettings } from './connection.js';
import { announceError, clearError, element, errorText, flushRender, inField, post, preferFocus, scheduleRender, setStatus, setUnavailable, showError } from './dom.js';
import { readFailure, send } from './http.js';
import type { HttpResult } from './http.js';
import { actionsBlocked, hasCurrentSelection, nextRequestId, readProblem, state } from './state.js';
import type { ReadFailure } from './state.js';
import { releaseListImages, resetThumbnails, retryFailedThumbnails, showThumbnail, thumbnailFrame } from './thumbnails.js';

const searchInput = element<HTMLInputElement>('insert-search');
const searchClear = element<HTMLButtonElement>('search-clear');
const insertStatePicker = element<HTMLSelectElement>('insert-state');
const insertAppearancePicker = element<HTMLSelectElement>('insert-appearance');
const insertArmPicker = element<HTMLSelectElement>('insert-arm');
const insertButton = element<HTMLButtonElement>('insert');
const insertThumb = element<HTMLImageElement>('insert-thumb');
const insertBar = element('insert-bar');
const emptyState = element('insert-empty');
const scaleButtons = [element<HTMLButtonElement>('scale-1'), element<HTMLButtonElement>('scale-2'), element<HTMLButtonElement>('scale-3')] as const;
const GUIDE_URL = 'https://www.assetlib.dev/guide';
const NEEDS_UPLOAD = 'This image has no version Figma can use. Upload it again in the Assetlib console.';
const TOO_LARGE = 'Too large for Figma. Every version is over 4 MiB.';
const UNEXPECTED_IMAGE = 'The console sent an unexpected image. Refresh and try again.';

/**
 * What the list region shows in place of rows or tiles: a sentence, an optional headline, and at most one action.
 * `connection` marks a failed connection test or a refused token: the open connection settings say that one under the
 * token field, so the list steps aside while they are open.
 */
type ListState = {
  title?: string; text: string; action: 'clear' | 'retry' | 'token' | 'send' | 'link' | null; link?: { text: string; href: string }; connection?: boolean;
};

// Everything here resets on every connection message.
let artwork: ArtworkResponse | null = null;
let artworkGeneration: number | null = null;
let images: { items: LibraryAsset[]; nextCursor: string | null; q: string } | null = null;
let selected: { kind: 'placement'; key: string; cell: CellCoordinate } | { kind: 'image'; assetId: string } | null = null;
let pendingInsert: { id: number; generation: number; environment: EnvironmentName | null } | null = null;
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
let rows = new Map<string, HTMLElement>();

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
function shownEnvironment(): EnvironmentName { return artwork && !published(state.prefs.environment) ? 'draft' : state.prefs.environment; }
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${months[date.getMonth()]} ${date.getDate()}${date.getFullYear() === new Date().getFullYear() ? '' : `, ${date.getFullYear()}`}`;
}
/** Each environment's tooltip: what it is, and its release when one is published. */
function environmentTitle(name: EnvironmentName): string {
  if (name === 'draft') return 'Unpublished changes. Send and Sync update Draft.';
  if (artwork && !published(name)) return `Nothing published to ${environmentLabel(name)} yet.`;
  const meta = artwork?.environments[name];
  const release = meta ? ` Release ${meta.sequence}${shortDate(meta.createdAt) ? `, ${shortDate(meta.createdAt)}` : ''}.` : '';
  return `The latest release published to ${name}.${release}`;
}
function environmentNote(): string {
  if (state.previewNote) return state.previewNote;
  if (state.prefs.browse !== 'placements' || !artwork) return '';
  const shown = shownEnvironment();
  return shown === state.prefs.environment ? '' : `Nothing is published to ${environmentLabel(state.prefs.environment)} yet, so Draft is shown.`;
}

function selectedPlacement(): PlacementArtwork | null {
  const current = selected;
  return current?.kind === 'placement' ? artwork?.placements.find(item => item.key === current.key) ?? null : null;
}
function selectedImage(): LibraryAsset | null {
  const current = selected;
  return current?.kind === 'image' ? images?.items.find(item => item.id === current.assetId) ?? null : null;
}
type InsertTarget = {
  title: string; meta: string; note: string; noteLink: string | null; name: string; asset: LibraryAsset | null; ready: boolean;
  frame: { width: number; height: number }; link: InsertLink | null;
  // A cell with nothing in this environment: the footer shows the row's empty slot, not a preview.
  empty: boolean;
};
/** The frame size in Figma when Insert at divides it (rounded as main rounds it), or nothing at 1×. */
function scaledSize(frame: { width: number; height: number }): string {
  const { scale } = state.prefs;
  const side = (value: number) => Math.round((value / scale) * 100) / 100;
  return scale === 1 ? '' : `→ ${side(frame.width)} × ${side(frame.height)}`;
}
/** Why an image can't be inserted, with a console link to it, or null when it can. */
function blocked(asset: LibraryAsset, connection: Connection | null): { note: string; link: string | null } | null {
  if (insertRendition(asset)) return null;
  const link = connection ? consoleLink(connection, 'images', asset.id) : null;
  return { note: asset.renditions.length ? TOO_LARGE : NEEDS_UPLOAD, link };
}
function insertTarget(): InsertTarget | null {
  if (selected?.kind === 'placement') {
    const placement = selectedPlacement();
    if (!placement || !artwork) return null;
    const cell = selected.cell;
    const shown = shownEnvironment();
    const label = environmentLabel(shown);
    const art = findCell(placement, cell)?.[shown] ?? null;
    const asset = artworkAsset(artwork, art);
    const frame = { width: placement.width, height: placement.height };
    // Only the axes the placement declares are named, and only those without a picker above: a picker already says it.
    const picked = pickerAxes(placement);
    const parts = [label];
    if (placement.states?.length && picked.states.length <= 1) parts.push(cell.state ?? placement.defaultState ?? 'default');
    if (placement.variants?.appearance?.length && picked.appearances.length <= 1) parts.push(appearanceLabel(cell.appearance));
    if (placement.variants?.arm?.length && picked.arms.length <= 1) parts.push(cell.arm ?? 'Control');
    const size = scaledSize(frame);
    if (size) parts.push(size);
    const target: InsertTarget = { title: placement.key, meta: parts.join(' · '), note: `No image in ${label} for this cell. Choose another cell or environment.`,
      noteLink: null, name: layerName(placement, cell), asset, ready: false, frame, link: null, empty: !art };
    if (!art) return target;
    if (!asset) return { ...target, note: 'The console didn’t return this image. Refresh to try again.' };
    // The link names the picked cell, never the family it inherits from, so a Sync never touches the base art.
    const inherited = art.via.arm !== cell.arm || art.via.appearance !== cell.appearance;
    const meta = inherited ? `${target.meta} · Uses ${art.via.arm ?? 'Control'} · ${appearanceLabel(art.via.appearance)} art` : target.meta;
    const stop = blocked(asset, state.connection);
    return { ...target, meta, ready: !stop, note: stop?.note ?? '', noteLink: stop?.link ?? null,
      link: { placementKey: placement.key, state: cell.state, appearance: cell.appearance, arm: cell.arm, environment: shown, assetId: art.assetId } };
  }
  const asset = selectedImage();
  if (!asset) return null;
  const frame = { width: asset.width, height: asset.height };
  const stop = blocked(asset, state.connection);
  return { title: asset.name || 'Untitled image', meta: [`${asset.width} × ${asset.height}`, scaledSize(frame)].filter(Boolean).join(' '), asset,
    ready: !stop, note: stop?.note ?? '', noteLink: stop?.link ?? null, name: asset.name || 'Assetlib image', frame, link: null, empty: false };
}
function distinct<T>(values: T[]): T[] { return values.filter((value, index) => values.indexOf(value) === index); }
/** Each axis's values among the placement's cells; the footer shows a picker for an axis with more than one. */
function pickerAxes(placement: PlacementArtwork): { states: (string | null)[]; appearances: (Appearance | null)[]; arms: (string | null)[] } {
  return {
    // The default state comes first.
    states: distinct(placement.cells.map(item => item.state)).sort((a, b) => Number(b === placement.defaultState) - Number(a === placement.defaultState)),
    appearances: distinct(placement.cells.map(item => item.appearance)),
    arms: distinct(placement.cells.map(item => item.arm)),
  };
}
function buildInsertPickers(placement: PlacementArtwork, cell: CellCoordinate): void {
  const { states, appearances, arms } = pickerAxes(placement);
  // The default state comes first; a label short enough that the three pickers share one row at 420 px.
  insertStatePicker.replaceChildren(...states.map(value => new Option(value ?? 'Default', value ?? '')));
  insertAppearancePicker.replaceChildren(...appearances.map(value => new Option(appearanceLabel(value), value ?? '')));
  insertArmPicker.replaceChildren(...arms.map(value => new Option(value ?? 'Control', value ?? '')));
  insertStatePicker.value = cell.state ?? '';
  insertAppearancePicker.value = cell.appearance ?? '';
  insertArmPicker.value = cell.arm ?? '';
  element('insert-state-label').hidden = states.length <= 1;
  element('insert-appearance-label').hidden = appearances.length <= 1;
  element('insert-arm-label').hidden = arms.length <= 1;
}
function pickedCell(): CellCoordinate {
  return { state: insertStatePicker.value || null, appearance: (insertAppearancePicker.value || null) as Appearance | null, arm: insertArmPicker.value || null };
}
function updatePressed(): void {
  const key = selected?.kind === 'placement' ? selected.key : selected?.kind === 'image' ? selected.assetId : null;
  for (const [id, row] of rows) row.setAttribute('aria-pressed', String(id === key));
}
function selectPlacement(key: string): void {
  const placement = artwork?.placements.find(item => item.key === key);
  if (!placement) return;
  selected = { kind: 'placement', key, cell: baseCoordinate(placement) };
  buildInsertPickers(placement, selected.cell);
  selectionChanged(key);
}
function selectImage(assetId: string): void {
  if (!images?.items.some(item => item.id === assetId)) return;
  selected = { kind: 'image', assetId };
  selectionChanged(assetId);
}
function selectionChanged(id: string): void {
  updatePressed();
  // Messages about the previous choice no longer apply; a running operation keeps its status.
  if (!actionsBlocked()) setStatus('');
  clearError();
  // The footer appears with a selection and the list gets shorter; render it now so the chosen row stays in view.
  scheduleRender();
  flushRender();
  rows.get(id)?.scrollIntoView({ block: 'nearest' });
}
type Tag = { word: string; title: string; blocking: boolean };
/** A row's tag: a word in meta with a dot, or, when Insert can't use the art, a word in text with a warning glyph. */
function rowTag(placement: PlacementArtwork): Tag | null {
  const base = findCell(placement, baseCoordinate(placement));
  const shown = shownEnvironment();
  const art = base?.[shown] ?? null;
  if (!art || !artwork) return { word: 'Not set', title: `No image in ${environmentLabel(shown)} for this cell.`, blocking: false };
  const asset = artworkAsset(artwork, art);
  if (!asset) return { word: 'Unavailable', title: 'The console didn’t return this image. Refresh to try again.', blocking: true };
  if (!asset.renditions.length) return { word: 'Needs re-upload', title: 'Upload it again in the Assetlib console to use it in Figma.', blocking: true };
  if (shown !== 'draft' || !artwork.environments.production) return null;
  if (!base?.production) return { word: 'Draft only', title: 'Production has no image here yet.', blocking: false };
  return base.production.assetId !== art.assetId ? { word: 'Changed', title: 'Draft differs from Production.', blocking: false } : null;
}
function placementRow(placement: PlacementArtwork, current: ArtworkResponse): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'placement';
  row.setAttribute('data-key', placement.key);
  const text = document.createElement('span'); text.className = 'row-text';
  const key = document.createElement('span'); key.className = 'key'; key.textContent = placement.key;
  const size = document.createElement('span'); size.className = 'size'; size.textContent = placementMeta(placement);
  text.append(key, size);
  const art = findCell(placement, baseCoordinate(placement))?.[shownEnvironment()] ?? null;
  // A cell with nothing in this environment shows an empty slot.
  row.append(thumbnailFrame(artworkAsset(current, art), !art), text);
  const tag = rowTag(placement);
  if (tag) {
    const chip = document.createElement('span');
    chip.className = tag.blocking ? 'tag blocking' : 'tag';
    chip.textContent = tag.word;
    chip.title = tag.title;
    row.append(chip);
  }
  row.addEventListener('click', () => selectPlacement(placement.key));
  rows.set(placement.key, row);
  return row;
}
function imageTile(asset: LibraryAsset): HTMLElement {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.setAttribute('data-asset-id', asset.id);
  const kind = asset.processingIntent === 'photo' ? 'Photo' : 'Artwork';
  tile.title = `${asset.name || 'Untitled image'} · ${asset.width} × ${asset.height} · ${kind}`;
  const name = document.createElement('span'); name.className = 'name'; name.textContent = asset.name || 'Untitled image';
  const size = document.createElement('span'); size.className = 'size'; size.textContent = `${asset.width} × ${asset.height}`;
  tile.append(thumbnailFrame(asset), name, size);
  tile.addEventListener('click', () => selectImage(asset.id));
  rows.set(asset.id, tile);
  return tile;
}
/** Grey blocks where rows or tiles will be, while the list loads (no shimmer), and the words a screen reader finds there. */
function skeletons(kind: 'placements' | 'images'): HTMLElement[] {
  const words = document.createElement('p');
  words.className = 'visually-hidden';
  words.textContent = kind === 'placements' ? 'Loading placements' : 'Loading images';
  return [words, ...Array.from({ length: kind === 'placements' ? 6 : 9 }, () => {
    const item = document.createElement('div');
    item.className = kind === 'placements' ? 'placement skeleton' : 'tile skeleton';
    item.setAttribute('aria-hidden', 'true');
    const block = document.createElement('span'); block.className = 'block';
    if (kind === 'images') { item.append(block); return item; }
    const lines = document.createElement('span'); lines.className = 'lines';
    const first = document.createElement('span'); first.className = 'bar';
    const second = document.createElement('span'); second.className = 'bar';
    lines.append(first, second);
    item.append(block, lines);
    return item;
  })];
}
/** The rebuilt row or tile for a key, so focus can follow it through a rebuild. */
export function rowFor(key: string): HTMLElement | null { return rows.get(key) ?? null; }

/** The list's state, unless the open connection settings already say it under the token field. */
function renderEmpty(current: ListState | null): void {
  const empty = current?.connection && problemInSettings() ? null : current;
  emptyState.hidden = !empty;
  const title = element('insert-empty-title');
  title.hidden = !empty?.title;
  title.textContent = empty?.title ?? '';
  element('insert-empty-text').textContent = empty?.text ?? '';
  element('insert-clear').hidden = empty?.action !== 'clear';
  element('insert-retry').hidden = empty?.action !== 'retry';
  // With the settings open, the token field is on screen already.
  element('insert-token').hidden = empty?.action !== 'token' || element<HTMLDetailsElement>('settings').open;
  element('insert-go-send').hidden = empty?.action !== 'send';
  const link = element<HTMLAnchorElement>('insert-empty-link');
  link.hidden = empty?.action !== 'link' || !empty.link;
  link.textContent = empty?.link?.text ?? '';
  if (empty?.link) link.href = empty.link.href;
}

/** Rebuilds the list or grid; selection changes only update aria-pressed, so focus stays on the row. */
export function renderList(): void {
  rows = new Map();
  releaseListImages();
  const { browse } = state.prefs;
  const list = element('insert-list');
  const grid = element('image-grid');
  list.hidden = browse !== 'placements';
  grid.hidden = browse !== 'images';
  const query = currentQuery();
  const lower = query.toLowerCase();
  let empty: ListState | null = null;
  const listChildren: HTMLElement[] = [];
  const gridChildren: HTMLElement[] = [];
  // The connection test runs before any list loads, so it counts as loading too.
  const loading = (kind: 'placements' | 'images') => state.ops.loadingList === kind || (state.ops.connecting && !listError);
  if (!state.connection) empty = { text: 'Connect to Assetlib to browse your app’s images.', action: null };
  else if (browse === 'placements') {
    const current = artwork;
    if (!current) {
      if (loading('placements')) listChildren.push(...skeletons('placements'));
      else empty = listError;
    } else if (!current.placements.length) {
      empty = { title: 'No placements yet', text: 'Placements come from your app’s code. When an engineer adds one and runs assetlib sync, it appears here.',
        action: 'link', link: { text: 'Read the guide', href: GUIDE_URL } };
    } else {
      const matches = current.placements.filter(item => !lower || item.key.toLowerCase().includes(lower) || item.screen.toLowerCase().includes(lower));
      if (!matches.length) empty = { text: `No placements match “${query}”.`, action: 'clear' };
      const screens = distinct(matches.map(item => item.screen));
      for (const screen of screens) {
        const header = document.createElement('p');
        header.className = 'group';
        header.textContent = screen;
        listChildren.push(header, ...matches.filter(item => item.screen === screen).map(item => placementRow(item, current)));
      }
    }
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
  updatePressed();
  listState = empty;
  renderEmpty(listState);
  element('images-more').hidden = browse !== 'images' || !images?.nextCursor;
}

export function renderInsertControls(): void {
  const { browse } = state.prefs;
  element('browse-placements').setAttribute('aria-checked', String(browse === 'placements'));
  element('browse-images').setAttribute('aria-checked', String(browse === 'images'));
  // Typing stays possible while a list loads; a new search replaces the load.
  searchInput.disabled = !state.connection;
  const label = browse === 'placements' ? 'Search placements' : 'Search images';
  searchInput.placeholder = label;
  searchInput.setAttribute('aria-label', label);
  searchClear.hidden = !searchInput.value;
  element('env-group').hidden = browse !== 'placements';
  const shown = shownEnvironment();
  for (const name of ENVIRONMENTS) {
    const button = element<HTMLButtonElement>(`env-${name}`);
    button.setAttribute('aria-checked', String(shown === name));
    // Live while the list loads; only an environment with nothing published is off.
    button.disabled = !state.connection || Boolean(artwork && !published(name));
    button.title = environmentTitle(name);
  }
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
}
export function renderInsertBar(): void {
  const target = insertTarget();
  // The footer shows only with something chosen to insert.
  insertBar.hidden = !state.connection || state.prefs.tab !== 'insert' || !target;
  showThumbnail(insertThumb, insertBar.hidden ? null : target?.asset ?? null);
  // A cell with nothing in this environment is the row's empty slot here too.
  element('insert-preview').className = target?.empty ? 'thumb slot' : 'thumb';
  element('insert-title').textContent = target?.title ?? '';
  element('insert-meta').textContent = target?.meta ?? '';
  // The whole line on hover, for a narrow window that shortens it.
  element('insert-meta').title = target?.meta ?? '';
  element('insert-note').textContent = target?.note ?? '';
  element('insert-note').hidden = !target?.note;
  const noteLink = element<HTMLAnchorElement>('insert-note-link');
  noteLink.hidden = !target?.noteLink;
  if (target?.noteLink) noteLink.href = target.noteLink;
  if (selected?.kind !== 'placement') {
    for (const id of ['insert-state-label', 'insert-appearance-label', 'insert-arm-label']) element(id).hidden = true;
  }
  scaleButtons.forEach((button, index) => button.setAttribute('aria-checked', String(state.prefs.scale === index + 1)));
  insertButton.textContent = state.ops.inserting ? 'Inserting…' : 'Insert';
  setUnavailable(insertButton, actionsBlocked() || !state.connection || !target?.ready || pendingInsert !== null);
}

/** Opens the Insert tab's list for this connection, unless it is loaded or loading. Waits for the connection test. */
export function enterInsert(): void {
  if (state.prefs.tab !== 'insert' || !state.connection || state.connectionGeneration === null || state.ops.connecting) return;
  if (state.prefs.browse === 'placements') {
    if (artworkGeneration !== state.connectionGeneration && state.ops.loadingList !== 'placements') void loadArtwork();
  } else if (state.ops.loadingList !== 'images' && (!images || images.q !== currentQuery())) void loadImages(true);
}

/**
 * A list read failed: its state replaces the list, the alert region announces it, and focus moves to it unless the
 * person is in a field. A refused token the open settings already say (needsAttention) is left to them.
 */
function showListError(failure: ReadFailure): void {
  listError = { ...readProblem(failure), connection: failure.kind === 'http' && failure.status === 401 };
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
  return { kind: result.kind === 'ok' || result.kind === 'aborted' ? 'http' : result.kind, status: result.status, text };
}
/**
 * The connection test failed, so the list says why and waits for its action. `present`, when the Insert tab is in
 * front: the list announces it and takes focus, as any failed list does (unless the open settings say it).
 */
export function listUnavailable(failure: ReadFailure | null, present: boolean): void {
  listError = { ...readProblem(failure), connection: true };
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
    if (state.prefs.browse === 'placements') void loadArtwork(); else void loadImages(true);
  } else enterInsert();
}
async function loadArtwork(): Promise<void> {
  const config = state.connection;
  const generation = state.connectionGeneration;
  if (!config) return;
  // Only a connection save in progress leaves a connection without a generation.
  if (generation === null) { listDeferred = true; return; }
  const ticket = startList('placements');
  // Until this load lands the placements are missing, so a load cancelled by an Images load or a connection change
  // loads again when Placements next shows.
  artwork = null;
  artworkGeneration = null;
  scheduleRender(true);
  try {
    // A new list load or a connection change aborts this one; whoever replaced it owns the list.
    const result = await send(config, { path: 'placements/artwork', channel: 'list' });
    if (generation !== state.connectionGeneration || ticket !== listTicket || result.kind === 'aborted') return;
    if (result.status !== 200) {
      if (result.status === 401) needsAttention({ text: TOKEN_REFUSED, field: 'token' });
      // An older console answers the unknown route without CORS headers, which the iframe sees as a network error.
      const failure = readFailureOf(result, readFailure(result, config, 'insert', state.placementsLoaded ? insertUnavailable(config.origin) : undefined));
      artwork = null;
      artworkGeneration = null;
      if (selected?.kind === 'placement') selected = null;
      showListError(failure);
      return;
    }
    artwork = parseArtwork(result.payload);
    artworkGeneration = generation;
    markConnected();
    const placement = selectedPlacement();
    if (selected?.kind === 'placement') {
      if (!placement) selected = null;
      else {
        const cell = findCell(placement, selected.cell) ? selected.cell : baseCoordinate(placement);
        selected = { ...selected, cell };
        buildInsertPickers(placement, cell);
      }
    }
  } catch (error) {
    if (generation !== state.connectionGeneration || ticket !== listTicket) return;
    artwork = null;
    artworkGeneration = null;
    if (selected?.kind === 'placement') selected = null;
    showListError({ kind: 'invalid', status: 200, text: errorText(error) });
  } finally { endList(ticket, generation); }
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
      if (result.status === 401) needsAttention({ text: TOKEN_REFUSED, field: 'token' });
      failure = readFailureOf(result, readFailure(result, config, 'insert', state.placementsLoaded ? insertUnavailable(config.origin) : undefined));
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
    if (!reset) { images = previous; showError(errorText(error)); }
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
async function beginInsert(): Promise<void> {
  const config = state.connection;
  const generation = state.connectionGeneration;
  if (!config || generation === null || actionsBlocked() || pendingInsert) return;
  const target = insertTarget();
  const asset = target?.asset;
  if (!target || !asset || !target.ready) return;
  // The size the footer showed when Insert was chosen, even if Insert at changes during the download.
  const { scale } = state.prefs;
  clearError();
  const rendition = insertRendition(asset);
  if (!rendition) { showError(TOO_LARGE); return; }
  state.ops.inserting = true;
  setStatus(`Downloading ${target.name}…`);
  scheduleRender();
  try {
    const result = await send(config, { path: renditionPath(asset.id, rendition.sha256), bytes: rendition.bytes });
    // A connection switch drops this insert quietly; the new connection owns the busy state.
    if (generation !== state.connectionGeneration || result.kind === 'aborted') return;
    if (result.status !== 200) {
      if (result.status === 401) needsAttention();
      // This console listed the image, so a 404 means the image went away, not that the console lacks Insert.
      throw new Error(result.kind === 'http' && result.status === 404 ? GONE_IMAGE : readFailure(result, config, 'insert'));
    }
    if (mediaType(result.contentType) !== rendition.mime || result.bytes.byteLength !== rendition.bytes) throw new Error(UNEXPECTED_IMAGE);
    markConnected();
    let bytes = result.bytes;
    if (rendition.mime === 'image/webp') {
      setStatus('Converting to PNG…');
      try { bytes = await webpToPng(bytes); }
      catch { throw new Error('Figma couldn’t use this WebP image. Try again, or download it from the console.'); }
      if (generation !== state.connectionGeneration) return;
    }
    const size = pngSize(bytes);
    if (!size || size.width !== rendition.width || size.height !== rendition.height) throw new Error(UNEXPECTED_IMAGE);
    pendingInsert = { id: nextRequestId(), generation, environment: target.link?.environment ?? null };
    setStatus(`Inserting ${target.name}…`);
    post({ type: 'insert', requestId: pendingInsert.id, connectionGeneration: generation, bytes, name: target.name, frame: target.frame, scale, link: target.link });
  } catch (error) {
    if (generation !== state.connectionGeneration) return;
    pendingInsert = null;
    state.ops.inserting = false;
    setStatus('');
    const text = errorText(error);
    // An image removed since the list loaded: Refresh brings the list up to date.
    showError(text, text === GONE_IMAGE ? { label: 'Refresh', run: refreshList } : undefined);
    scheduleRender();
  }
}

/** Main inserted the frame, and said so in a toast; the status region repeats it. */
export function inserted(message: Extract<MainMessage, { type: 'inserted' }>): void {
  const operation = pendingInsert;
  if (!operation || operation.id !== message.requestId || operation.generation !== message.connectionGeneration) return;
  pendingInsert = null;
  state.ops.inserting = false;
  const fileKnown = hasCurrentSelection() && Boolean(state.selection.fileKey);
  setStatus(message.linked && operation.environment
    ? `Inserted ${message.node.name} from ${environmentLabel(operation.environment)}.${fileKnown ? '' : ' Paste this file’s link on the Send tab to enable Sync.'}`
    : `Inserted ${message.node.name}.`);
  scheduleRender();
}

/** Main's error for an insert; false when it belongs to another operation. */
export function failInsert(requestId: number, message: string): boolean {
  if (pendingInsert?.id !== requestId) return false;
  pendingInsert = null;
  state.ops.inserting = false;
  setStatus('');
  showError(message);
  scheduleRender();
  return true;
}

export function resetInsert(): void {
  artwork = null; artworkGeneration = null; images = null; selected = null; pendingInsert = null;
  state.ops.loadingList = null; loadingQuery = ''; listError = null; listDeferred = false; listTicket += 1;
  state.ops.inserting = false;
  if (searchTimer !== null) { window.clearTimeout(searchTimer); searchTimer = null; }
  resetThumbnails();
  scheduleRender(true);
}

function setBrowse(next: Preferences['browse']): void {
  if (state.prefs.browse === next) return;
  state.prefs.browse = next;
  selected = null;
  if (!actionsBlocked()) setStatus('');
  savePreferences();
  scheduleRender(true);
  enterInsert();
}
function setEnvironment(next: EnvironmentName): void {
  // Before the artwork loads, the choice is kept for when it does.
  if (artwork ? !published(next) || shownEnvironment() === next : state.prefs.environment === next) return;
  state.prefs.environment = next;
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
  if (state.prefs.browse === 'placements') void loadArtwork(); else void loadImages(true);
}
function clearSearch(): void {
  searchInput.value = '';
  if (state.prefs.browse === 'placements') scheduleRender(true); else searchImages();
  scheduleRender();
}

export function initInsert(goToSend: () => void): void {
  element('browse-placements').addEventListener('click', () => setBrowse('placements'));
  element('browse-images').addEventListener('click', () => setBrowse('images'));
  for (const name of ENVIRONMENTS) element(`env-${name}`).addEventListener('click', () => setEnvironment(name));
  scaleButtons.forEach((button, index) => button.addEventListener('click', () => setScale((index + 1) as 1 | 2 | 3)));
  searchInput.addEventListener('input', () => {
    scheduleRender();
    if (state.prefs.browse === 'placements') { scheduleRender(true); return; }
    if (searchTimer !== null) window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(searchImages, 300);
  });
  element('insert-clear').addEventListener('click', clearSearch);
  searchClear.addEventListener('click', () => { clearSearch(); searchInput.focus(); });
  element('insert-refresh').addEventListener('click', refreshList);
  element('insert-retry').addEventListener('click', refreshList);
  element('insert-token').addEventListener('click', openSettings);
  element('insert-go-send').addEventListener('click', goToSend);
  element('images-more').addEventListener('click', () => { void loadImages(false); });
  for (const picker of [insertStatePicker, insertAppearancePicker, insertArmPicker]) {
    picker.addEventListener('change', () => {
      if (selected?.kind !== 'placement') return;
      selected = { ...selected, cell: pickedCell() };
      scheduleRender();
    });
  }
  insertButton.addEventListener('click', () => { void beginInsert(); });
}
