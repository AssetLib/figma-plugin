import {
  ENVIRONMENTS, GONE_IMAGE, apiUrl, artworkAsset, aspectRatioDifference, assetsUrl, baseCoordinate, buildDraftBody, bytesToBase64, cellOptions,
  chooseExportSettings, defaultPreferences, encodeBase64, environmentLabel, findCell, insertRendition, insertUnavailable, layerName,
  mapHttpError, mapNetworkError, parseArtwork, parseAssetPage, parseDraftResponse, parsePlacements, parsePngDimensions, parsePreferences,
  pngSize, renditionUrl, thumbnailRendition, tokenPrefix, validateBinding, validateConnection,
} from './shared/index.js';
import type {
  Appearance, ArtworkResponse, CellBinding, CellCoordinate, Connection, DraftResult, EnvironmentName, InsertLink, LibraryAsset,
  Placement, PlacementArtwork, RenditionInfo,
} from './shared/index.js';
import type { MainMessage, SelectionState, UiMessage } from './shared/protocol.js';
import { webpToPng } from './image.js';

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}
const settings = element<HTMLDetailsElement>('settings');
const origin = element<HTMLSelectElement>('origin');
const orgId = element<HTMLInputElement>('org-id');
const appId = element<HTMLInputElement>('app-id');
const token = element<HTMLInputElement>('token');
const placementPicker = element<HTMLSelectElement>('placement');
const statePicker = element<HTMLSelectElement>('state');
const appearancePicker = element<HTMLSelectElement>('appearance');
const armPicker = element<HTMLSelectElement>('arm');
const sendButton = element<HTMLButtonElement>('send');
const syncButton = element<HTMLButtonElement>('sync');
let connection: Connection | null = null;
// No selection reply is trusted while a connection save awaits acknowledgement.
let connectionGeneration: number | null = null;
let selectionGeneration: number | null = null;
let placements: Placement[] = [];
let selection: SelectionState = { node: null, reason: 'Select one node.', fileKey: null, remembered: null };
let busy = false;
let sequence = 0;
let selectionIdentity = '';
let pending: { id: number; connection: Connection; placement: Placement; bind: CellBinding; rebind: boolean } | null = null;

// Insert. Preferences apply from the first connection message only; everything else resets on every connection message.
const tabSend = element<HTMLButtonElement>('tab-send');
const tabInsert = element<HTMLButtonElement>('tab-insert');
const searchInput = element<HTMLInputElement>('insert-search');
const scalePicker = element<HTMLSelectElement>('insert-scale');
const insertStatePicker = element<HTMLSelectElement>('insert-state');
const insertAppearancePicker = element<HTMLSelectElement>('insert-appearance');
const insertArmPicker = element<HTMLSelectElement>('insert-arm');
const insertButton = element<HTMLButtonElement>('insert');
const insertThumb = element<HTMLImageElement>('insert-thumb');
const insertBar = element('insert-bar');
const LEGACY_IMAGE = 'This image predates renditions. Upload it again in the console to use it in Figma.';
const UNEXPECTED_IMAGE = 'The console returned an unexpected image. Refresh and try again.';
let preferencesLoaded = false;
let { tab, browse, environment, scale } = defaultPreferences();
let artwork: ArtworkResponse | null = null;
let artworkGeneration: number | null = null;
let images: { items: LibraryAsset[]; nextCursor: string | null; q: string } | null = null;
let selected: { kind: 'placement'; key: string; cell: CellCoordinate } | { kind: 'image'; assetId: string } | null = null;
// sha256 → data: URL for this connection generation, at most 200 (oldest dropped first).
const thumbnails = new Map<string, string>();
let pendingInsert: { id: number; generation: number; environment: EnvironmentName | null } | null = null;
// Set by a successful placements read in this generation: a later network failure on an Insert read then means an older console.
let placementsLoaded = false;
let loading: 'placements' | 'images' | null = null;
let loadFailed = false;
let searchTimer: number | null = null;
let previewNote = '';
let rows = new Map<string, HTMLElement>();
let messagesDocked = false;

function post(message: UiMessage): void { parent.postMessage({ pluginMessage: message }, '*'); }
function setStatus(text: string): void { element('status').textContent = text; }
function clearError(): void { element('error').hidden = true; element('error').textContent = ''; }
function showError(message: string): void { element('error').textContent = message; element('error').hidden = false; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'The action could not be completed.'; }
function setBusy(value: boolean): void { busy = value; render(); }
function hasCurrentSelection(): boolean {
  return connectionGeneration !== null && selectionGeneration === connectionGeneration;
}
function clearRememberedSelection(): void {
  selection = { ...selection, remembered: null };
  selectionGeneration = null;
  selectionIdentity = '';
}
function chosenPlacement(): Placement | undefined { return placements.find(item => item.key === placementPicker.value); }
function chosenBinding(placement: Placement): CellBinding {
  return validateBinding(placement, {
    slotKey: placement.key, state: statePicker.value || null,
    appearance: (appearancePicker.value || null) as CellBinding['appearance'], arm: armPicker.value || null,
  });
}
function rememberedBinding(): { placement: Placement; bind: CellBinding } | null {
  if (!hasCurrentSelection()) return null;
  const target = selection.remembered;
  if (!target) return null;
  const placement = placements.find(item => item.key === target.placementKey);
  if (!placement) return null;
  try {
    return { placement, bind: validateBinding(placement, { slotKey: target.placementKey, state: target.state, appearance: target.appearance, arm: target.arm }) };
  } catch { return null; }
}
function setOptions(picker: HTMLSelectElement, values: (string | null)[], defaultLabel: string): void {
  picker.replaceChildren(...values.map(value => new Option(value ?? defaultLabel, value ?? '')));
}
function updateCellPickers(bind?: CellBinding): void {
  const placement = chosenPlacement();
  const options = placement ? cellOptions(placement) : { states: [null], appearances: [null], arms: [null] };
  setOptions(statePicker, options.states, placement?.defaultState ? `Default (${placement.defaultState})` : 'Default');
  setOptions(appearancePicker, options.appearances, 'Any');
  setOptions(armPicker, options.arms, 'Control');
  if (bind) {
    statePicker.value = bind.state ?? '';
    appearancePicker.value = bind.appearance ?? '';
    armPicker.value = bind.arm ?? '';
  }
  element('state-label').hidden = options.states.length <= 1;
  element('appearance-label').hidden = options.appearances.length <= 1;
  element('arm-label').hidden = options.arms.length <= 1;
  render();
}
function selectRemembered(): void {
  const target = rememberedBinding();
  if (target) { placementPicker.value = target.placement.key; updateCellPickers(target.bind); }
}
function exportDescription(placement: Placement): string {
  if (!selection.node) return '';
  const settings = chooseExportSettings(selection.node, placement);
  return `PNG · ${settings.constraint.type.toLowerCase()} ${settings.constraint.value}px · placement ${placement.width} × ${placement.height}`;
}
function aspectWarning(placement: Placement): string {
  if (!selection.node) return '';
  const difference = aspectRatioDifference(selection.node, placement);
  return difference > 0.02 ? `Aspect ratios differ by ${(difference * 100).toFixed(1)}%. The PNG keeps the node’s aspect ratio; check its fit in the placement.` : '';
}
function render(): void {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('input, select, button').forEach(control => { control.disabled = busy; });
  const node = selection.node;
  element('selection-name').textContent = node?.name ?? selection.reason ?? 'Select one node.';
  element('selection-meta').textContent = node ? `${node.type} · ${node.width.toFixed(1)} × ${node.height.toFixed(1)} · ${node.id}${selection.reason ? ` · ${selection.reason}` : ''}` : '';
  element('file-fallback').hidden = Boolean(selection.fileKey);
  placementPicker.disabled = busy || placements.length === 0;
  const placement = chosenPlacement();
  const ready = Boolean(connection && hasCurrentSelection() && node && !selection.reason && selection.fileKey && !busy);
  sendButton.disabled = !ready || !placement;
  const validArea = node && !selection.reason;
  element('export-note').textContent = placement && validArea ? exportDescription(placement) : '';
  const warning = placement && validArea ? aspectWarning(placement) : '';
  element('aspect-warning').textContent = warning;
  element('aspect-warning').hidden = !warning;
  const remembered = selection.remembered;
  const target = rememberedBinding();
  // A remembered target makes Sync the expected action.
  syncButton.className = target ? 'primary' : '';
  sendButton.className = target ? '' : 'primary';
  syncButton.hidden = !remembered;
  syncButton.textContent = remembered ? `Sync to ${remembered.placementKey}` : '';
  syncButton.disabled = !ready || !target;
  element('sync-note').hidden = !remembered;
  // The export line and aspect warning above already describe the chosen placement, so the note repeats them only for another one.
  const other = Boolean(validArea && target && target.placement.key !== placement?.key);
  element('sync-note').textContent = !remembered ? '' : !target
    ? 'The remembered placement or cell is unavailable. Test the connection to refresh, or choose a new placement and send.'
    : [`${bindingLabel(target.bind)}.`, remembered.insertedFrom
      ? `Inserted from ${environmentLabel(remembered.insertedFrom.environment)}. Sync sends this layer to that cell and replaces draft references to this layer’s earlier sends, if any.`
      : 'Sync replaces every draft reference to the previous export of this node in this app.',
    other ? `${exportDescription(target.placement)}.` : '', other ? aspectWarning(target.placement) : ''].filter(Boolean).join(' ');
  renderInsertControls();
  renderInsertBar();
}

async function request(config: Connection, endpoint: 'placements' | 'drafts', body?: unknown): Promise<{ status: number; payload: unknown }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(apiUrl(config, endpoint), {
      method: body === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${config.token}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      credentials: 'omit', redirect: 'error', signal: controller.signal,
    });
    const payload: unknown = await response.json().catch(() => null);
    return { status: response.status, payload };
  } catch {
    throw new Error(`${mapNetworkError(config.origin)}${endpoint === 'drafts' ? ' The request may have reached the console. Check the draft before retrying.' : ''}`);
  } finally { window.clearTimeout(timeout); }
}
async function loadPlacements(): Promise<void> {
  if (!connection) return;
  const config = connection;
  const generation = connectionGeneration;
  clearError();
  setStatus('Testing connection…');
  setBusy(true);
  try {
    const response = await request(config, 'placements');
    if (generation !== connectionGeneration) return;
    if (response.status !== 200) throw new Error(mapHttpError(response.status, response.payload));
    placements = parsePlacements(response.payload);
    placementsLoaded = true;
    placementPicker.replaceChildren(...(placements.length
      ? placements.map(item => new Option(`${item.key} · ${item.screen} · ${item.width} × ${item.height}`, item.key))
      : [new Option('No placements in this app yet', '')]));
    updateCellPickers();
    selectRemembered();
    element('connection-label').textContent = '· connected';
    settings.open = false;
    setStatus(placements.length ? `Connected. ${placements.length} placement${placements.length === 1 ? '' : 's'} available.` : 'Connected. Create a placement in the console, then test again.');
  } catch (error) {
    if (generation !== connectionGeneration) return;
    placements = [];
    placementPicker.replaceChildren(new Option('Test your connection to load placements', ''));
    updateCellPickers();
    element('connection-label').textContent = '· needs attention';
    settings.open = true;
    setStatus('');
    showError(errorText(error));
  } finally { if (generation === connectionGeneration) setBusy(false); }
}
function bindingLabel(bind: CellBinding): string {
  return [bind.slotKey, bind.arm ?? 'Control', bind.appearance ?? 'Any', bind.state ?? 'default state'].join(' · ');
}
function showResult(result: DraftResult, config: Connection, rebind: boolean): void {
  const container = element('result');
  container.replaceChildren();
  const title = document.createElement('h2');
  title.textContent = `Draft created · ${result.asset.width} × ${result.asset.height}`;
  const name = document.createElement('p'); name.textContent = result.asset.name;
  const bound = document.createElement('p');
  bound.textContent = result.bound ? `Bound to ${bindingLabel(result.bound)}.` : 'Artwork created; it was not bound to the selected cell.';
  container.append(title, name, bound);
  if (result.bindError) {
    const error = document.createElement('p'); error.className = 'notice'; error.textContent = result.bindError; container.append(error);
  }
  if (rebind || result.rebound.length) {
    const summary = document.createElement('p'); summary.textContent = `${result.rebound.length} draft reference${result.rebound.length === 1 ? '' : 's'} rebound.`; container.append(summary);
    if (result.rebound.length) {
      const list = document.createElement('ul');
      for (const cell of result.rebound) { const item = document.createElement('li'); item.textContent = bindingLabel(cell); list.append(item); }
      container.append(list);
    }
  }
  const link = document.createElement('a'); link.href = config.origin; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.textContent = 'Open Assetlib console'; container.append(link);
  container.hidden = false;
}
function beginSend(rebind: boolean): void {
  if (busy || !connection || !hasCurrentSelection() || !selection.node || !selection.fileKey || selection.reason) return;
  clearError();
  try {
    const remembered = rebind ? rememberedBinding() : null;
    const placement = rebind ? remembered?.placement : chosenPlacement();
    if (!placement) throw new Error('Choose an available placement first.');
    const bind = remembered?.bind ?? chosenBinding(placement);
    pending = { id: ++sequence, connection: { ...connection }, placement, bind, rebind };
    element('result').hidden = true;
    setBusy(true);
    setStatus('Exporting selected artwork…');
    post({ type: 'export', requestId: pending.id, node: selection.node, fileKey: selection.fileKey, placement, bind, rebind });
  } catch (error) { pending = null; setBusy(false); showError(errorText(error)); }
}
async function sendExport(message: Extract<MainMessage, { type: 'exported' }>): Promise<void> {
  const operation = pending;
  if (!operation || operation.id !== message.requestId) return;
  try {
    const bytes = new Uint8Array(message.bytes);
    const dimensions = parsePngDimensions(bytes);
    const difference = aspectRatioDifference(dimensions, operation.placement);
    if (difference > 0.02) {
      throw new Error(`The exported PNG (${dimensions.width} × ${dimensions.height}) differs from the placement (${operation.placement.width} × ${operation.placement.height}) aspect ratio by ${(difference * 100).toFixed(1)}%, more than 2%. Adjust the artwork or choose a matching placement before sending. Nothing was uploaded.`);
    }
    setStatus('Sending PNG to the draft…');
    const body = buildDraftBody({ node: message.node, fileKey: message.fileKey, placement: operation.placement, bind: operation.bind,
      bytesBase64: bytesToBase64(bytes), settings: message.settings, rebind: operation.rebind });
    const response = await request(operation.connection, 'drafts', body);
    if (response.status !== 201 && response.status !== 409) throw new Error(mapHttpError(response.status, response.payload));
    let result: DraftResult;
    try { result = parseDraftResponse(response.payload); }
    catch {
      if (response.status === 409) throw new Error(mapHttpError(409, response.payload));
      throw new Error('The console accepted the export but returned an unreadable result. Check the draft in the console before retrying.');
    }
    showResult(result, operation.connection, operation.rebind);
    setStatus(result.bindError ? 'Artwork created with a binding conflict. Saving sync target…' : 'Draft saved. Saving sync target…');
    post({ type: 'remember', requestId: operation.id });
  } catch (error) { pending = null; setBusy(false); setStatus(''); showError(errorText(error)); }
}

// ---- Insert ----
function needsAttention(): void { element('connection-label').textContent = '· needs attention'; settings.open = true; }
/** The Insert footer is sticky, so status and errors move into it while it shows; ids, roles and live regions stay the same. */
function placeMessages(docked: boolean): void {
  if (docked === messagesDocked) return;
  messagesDocked = docked;
  element(docked ? 'insert-messages' : 'messages').append(element('status'), element('error'));
}
function mediaType(value: string): string { return value.split(';')[0]!.trim().toLowerCase(); }
function currentQuery(): string { return searchInput.value.trim().slice(0, 120); }
function savePreferences(): void {
  if (preferencesLoaded) post({ type: 'save-preferences', preferences: { tab, browse, environment, scale } });
}
function published(name: EnvironmentName): boolean { return name === 'draft' || Boolean(artwork?.environments[name]); }
// A remembered environment with nothing published shows draft, without forgetting the choice.
function shownEnvironment(): EnvironmentName { return artwork && !published(environment) ? 'draft' : environment; }
const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function shortDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${months[date.getMonth()]} ${date.getDate()}${date.getFullYear() === new Date().getFullYear() ? '' : `, ${date.getFullYear()}`}`;
}
function environmentNote(): string {
  if (previewNote) return previewNote;
  if (browse !== 'placements' || !artwork) return '';
  const shown = shownEnvironment();
  if (shown !== environment) return `Nothing is published to ${environment} yet.`;
  const meta = shown === 'draft' ? null : artwork.environments[shown];
  if (!meta) return 'Draft · what Send and Sync update';
  return [environmentLabel(shown), `release ${meta.sequence}`, shortDate(meta.createdAt)].filter(Boolean).join(' · ');
}

async function requestJson(config: Connection, url: string): Promise<{ status: number; payload: unknown }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${config.token}` }, credentials: 'omit', redirect: 'error', signal: controller.signal });
    return { status: response.status, payload: await response.json().catch(() => null) };
  } finally { window.clearTimeout(timeout); }
}
async function requestBytes(config: Connection, url: string, expected: number): Promise<{ status: number; contentType: string; bytes: Uint8Array<ArrayBuffer>; payload: unknown }> {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(url, { method: 'GET', headers: { Authorization: `Bearer ${config.token}` }, credentials: 'omit', redirect: 'error', signal: controller.signal });
    if (response.status !== 200) return { status: response.status, contentType: '', bytes: new Uint8Array(0), payload: await response.json().catch(() => null) };
    // Content-Type and Content-Length are CORS-safelisted, so the iframe can read them. A body longer than the listed
    // version is refused before it is read; the empty result then fails the caller's length check.
    const length = response.headers.get('content-length');
    if (length !== null && Number(length) > expected) { controller.abort(); return { status: 200, contentType: '', bytes: new Uint8Array(0), payload: null }; }
    return { status: 200, contentType: response.headers.get('content-type') ?? '', bytes: new Uint8Array(await response.arrayBuffer()), payload: null };
  } finally { window.clearTimeout(timeout); }
}

// Thumbnails: the smallest WebP (else PNG) as a data: URL, since <img> cannot send the bearer header.
const thumbnailWaiting = new Map<string, Set<HTMLImageElement>>();
const thumbnailJobs = new WeakMap<Element, { assetId: string; rendition: RenditionInfo }>();
const thumbnailRequested = new Set<string>();
const thumbnailFailed = new Set<string>();
// The images inside the current rows and tiles, so a rebuild can stop observing them.
let listImages: HTMLImageElement[] = [];
let thumbnailQueue: { assetId: string; rendition: RenditionInfo }[] = [];
let thumbnailsActive = 0;
let thumbnailsPaused = false;
let thumbnailEpoch = 0;
let thumbnailObserver: IntersectionObserver | null = null;
function resetThumbnails(): void {
  thumbnails.clear(); thumbnailWaiting.clear(); thumbnailRequested.clear(); thumbnailFailed.clear(); thumbnailQueue = []; listImages = [];
  thumbnailsActive = 0; thumbnailsPaused = false; thumbnailEpoch += 1; previewNote = '';
  thumbnailObserver?.disconnect(); thumbnailObserver = null;
}
function showThumbnail(img: HTMLImageElement, asset: LibraryAsset | null): void {
  const rendition = asset ? thumbnailRendition(asset) : null;
  // data-sha="" marks an image with no preview at all (ui.html labels it); a failed preview stays a blank placeholder.
  if (!asset || !rendition) { img.setAttribute('data-sha', ''); img.removeAttribute('src'); return; }
  if (img.getAttribute('data-sha') === rendition.sha256 && img.src) return;
  img.setAttribute('data-sha', rendition.sha256);
  const cached = thumbnails.get(rendition.sha256);
  if (cached) { img.src = cached; return; }
  img.removeAttribute('src');
  if (thumbnailFailed.has(rendition.sha256)) return;
  const waiting = thumbnailWaiting.get(rendition.sha256) ?? new Set<HTMLImageElement>();
  waiting.add(img);
  thumbnailWaiting.set(rendition.sha256, waiting);
  queueThumbnail(img, { assetId: asset.id, rendition });
}
function queueThumbnail(img: HTMLImageElement, job: { assetId: string; rendition: RenditionInfo }): void {
  if (typeof IntersectionObserver !== 'function') { requestThumbnail(job); return; }
  if (!thumbnailObserver) {
    thumbnailObserver = new IntersectionObserver(entries => {
      for (const entry of entries) {
        const next = thumbnailJobs.get(entry.target);
        if (!entry.isIntersecting || !next) continue;
        thumbnailObserver?.unobserve(entry.target);
        requestThumbnail(next);
      }
    });
  }
  thumbnailJobs.set(img, job);
  thumbnailObserver.observe(img);
}
function requestThumbnail(job: { assetId: string; rendition: RenditionInfo }): void {
  if (thumbnailRequested.has(job.rendition.sha256)) return;
  thumbnailRequested.add(job.rendition.sha256);
  thumbnailQueue.push(job);
  pumpThumbnails();
}
function pumpThumbnails(): void {
  while (!thumbnailsPaused && thumbnailsActive < 3 && thumbnailQueue.length) {
    const job = thumbnailQueue.shift()!;
    const epoch = thumbnailEpoch;
    thumbnailsActive += 1;
    void loadThumbnail(job, epoch).finally(() => {
      if (epoch !== thumbnailEpoch) return;
      thumbnailsActive -= 1;
      pumpThumbnails();
    });
  }
}
async function loadThumbnail(job: { assetId: string; rendition: RenditionInfo }, epoch: number): Promise<void> {
  const config = connection;
  if (!config) return;
  const { sha256, mime, bytes } = job.rendition;
  let response: Awaited<ReturnType<typeof requestBytes>> | null;
  try { response = await requestBytes(config, renditionUrl(config, job.assetId, sha256), bytes); } catch { response = null; }
  if (epoch !== thumbnailEpoch) return;
  if (!response) { failThumbnail(sha256); return; }
  if (response.status === 429) {
    thumbnailQueue.unshift(job);
    if (thumbnailsPaused) return;
    thumbnailsPaused = true;
    previewNote = 'Previews paused: too many requests. They resume shortly.';
    render();
    window.setTimeout(() => {
      if (epoch !== thumbnailEpoch) return;
      thumbnailsPaused = false; previewNote = ''; render(); pumpThumbnails();
    }, 15000);
    return;
  }
  // Any other failure leaves the neutral placeholder; previews never use the error line.
  if (response.status !== 200 || mediaType(response.contentType) !== mime || response.bytes.byteLength !== bytes) { failThumbnail(sha256); return; }
  const url = `data:${mime};base64,${encodeBase64(response.bytes)}`;
  // An evicted preview can be fetched again if a row shows it later.
  if (thumbnails.size >= 200) { const oldest = thumbnails.keys().next().value!; thumbnails.delete(oldest); thumbnailRequested.delete(oldest); }
  thumbnails.set(sha256, url);
  for (const img of thumbnailWaiting.get(sha256) ?? []) if (img.getAttribute('data-sha') === sha256) img.src = url;
  thumbnailWaiting.delete(sha256);
}
function failThumbnail(sha256: string): void { thumbnailFailed.add(sha256); thumbnailWaiting.delete(sha256); }
function thumbnailFrame(asset: LibraryAsset | null): HTMLElement {
  const frame = document.createElement('span');
  frame.className = 'thumb';
  const img = document.createElement('img');
  img.alt = '';
  frame.append(img);
  listImages.push(img);
  showThumbnail(img, asset);
  return frame;
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
  title: string; meta: string; note: string; name: string; asset: LibraryAsset | null; ready: boolean;
  frame: { width: number; height: number }; link: InsertLink | null;
};
function insertTarget(): InsertTarget | null {
  if (selected?.kind === 'placement') {
    const placement = selectedPlacement();
    if (!placement || !artwork) return null;
    const cell = selected.cell;
    const shown = shownEnvironment();
    const label = environmentLabel(shown);
    const art = findCell(placement, cell)?.[shown] ?? null;
    const asset = artworkAsset(artwork, art);
    const target: InsertTarget = { title: placement.key, meta: `${label} · Not set`, note: `Not set in ${label}. Choose another cell or environment.`,
      name: layerName(placement, cell), asset, ready: false, frame: { width: placement.width, height: placement.height }, link: null };
    if (!art) return target;
    if (!asset) return { ...target, meta: `${label} · Unavailable`, note: 'This image is not available. Choose Refresh, or another cell or environment.' };
    // The link names the picked cell, never the family it inherits from, so a Sync never touches the base art.
    const inherited = art.via.arm !== cell.arm || art.via.appearance !== cell.appearance;
    const family = `${art.via.arm ?? 'Control'} · ${art.via.appearance ?? 'Any'}`;
    // Sync always writes the picked cell's draft, whichever environment the art came from.
    return { ...target, ready: asset.renditions.length > 0,
      meta: `${label} · ${asset.name || 'Untitled image'} · ${insertSize(target.frame)}${inherited ? ` · Inherits ${family}` : ''}`,
      note: !asset.renditions.length ? LEGACY_IMAGE : inherited ? `Linked. Sync on the Send tab gives this cell its own draft art; ${family} stays unchanged.`
        : 'Linked. Sync on the Send tab puts edits in this cell’s draft.',
      link: { placementKey: placement.key, state: cell.state, appearance: cell.appearance, arm: cell.arm, environment: shown, assetId: art.assetId } };
  }
  const asset = selectedImage();
  if (!asset) return null;
  return { title: asset.name || 'Untitled image', meta: insertSize(asset), asset, ready: asset.renditions.length > 0,
    note: asset.renditions.length ? 'Not linked to a placement. Use Send to put edits in one.' : LEGACY_IMAGE,
    name: asset.name || 'Assetlib image', frame: { width: asset.width, height: asset.height }, link: null };
}
/** Pixels, plus the frame size in Figma when Insert at divides it (rounded as main rounds it). */
function insertSize(frame: { width: number; height: number }): string {
  const side = (value: number) => Math.round((value / scale) * 100) / 100;
  return `${frame.width} × ${frame.height}${scale === 1 ? '' : ` → ${side(frame.width)} × ${side(frame.height)}`}`;
}
function distinct<T>(values: T[]): T[] { return values.filter((value, index) => values.indexOf(value) === index); }
function buildInsertPickers(placement: PlacementArtwork, cell: CellCoordinate): void {
  const states = distinct(placement.cells.map(item => item.state));
  const appearances = distinct(placement.cells.map(item => item.appearance));
  const arms = distinct(placement.cells.map(item => item.arm));
  insertStatePicker.replaceChildren(...states.map(state => new Option(state === null ? 'Default' : state === placement.defaultState ? `${state} (default)` : state, state ?? '')));
  insertAppearancePicker.replaceChildren(...appearances.map(value => new Option(value ?? 'Any', value ?? '')));
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
  if (busy || !placement) return;
  selected = { kind: 'placement', key, cell: baseCoordinate(placement) };
  buildInsertPickers(placement, selected.cell);
  selectionChanged(key);
}
function selectImage(assetId: string): void {
  if (busy || !images?.items.some(item => item.id === assetId)) return;
  selected = { kind: 'image', assetId };
  selectionChanged(assetId);
}
function selectionChanged(id: string): void {
  updatePressed();
  // Messages about the previous choice no longer apply.
  setStatus(''); clearError();
  render();
  // The footer grows with a selection; keep the chosen row clear of it.
  rows.get(id)?.scrollIntoView({ block: 'nearest' });
}
function rowTag(placement: PlacementArtwork): string {
  const base = findCell(placement, baseCoordinate(placement));
  const shown = shownEnvironment();
  const art = base?.[shown] ?? null;
  if (!art) return 'Not set';
  const asset = artworkAsset(artwork!, art);
  if (!asset) return 'Unavailable';
  if (!asset.renditions.length) return 'Re-upload needed';
  if (shown !== 'draft' || !artwork?.environments.production) return '';
  if (!base?.production) return 'Not in production';
  return base.production.assetId !== art.assetId ? 'Differs from production' : '';
}
function placementRow(placement: PlacementArtwork): HTMLElement {
  const row = document.createElement('button');
  row.type = 'button';
  row.className = 'placement';
  row.setAttribute('data-key', placement.key);
  const text = document.createElement('span');
  const key = document.createElement('span'); key.className = 'key'; key.textContent = placement.key;
  const size = document.createElement('span'); size.className = 'size'; size.textContent = `${placement.width} × ${placement.height}`;
  text.append(key, size);
  row.append(thumbnailFrame(artworkAsset(artwork!, findCell(placement, baseCoordinate(placement))?.[shownEnvironment()] ?? null)), text);
  const tag = rowTag(placement);
  if (tag) { const chip = document.createElement('span'); chip.className = 'tag'; chip.textContent = tag; row.append(chip); }
  row.addEventListener('click', () => selectPlacement(placement.key));
  rows.set(placement.key, row);
  return row;
}
function imageTile(asset: LibraryAsset): HTMLElement {
  const tile = document.createElement('button');
  tile.type = 'button';
  tile.className = 'tile';
  tile.setAttribute('data-asset-id', asset.id);
  const name = document.createElement('span'); name.className = 'name'; name.textContent = asset.name || 'Untitled image';
  const size = document.createElement('span'); size.className = 'size'; size.textContent = `${asset.width} × ${asset.height}`;
  tile.append(thumbnailFrame(asset), name, size);
  tile.addEventListener('click', () => selectImage(asset.id));
  rows.set(asset.id, tile);
  return tile;
}
/** Rebuilds the list or grid; selection changes only update aria-pressed, so focus stays on the row. */
function renderList(): void {
  rows = new Map();
  // The rows are rebuilt, so their images stop waiting for previews.
  for (const img of listImages) { thumbnailObserver?.unobserve(img); for (const waiting of thumbnailWaiting.values()) waiting.delete(img); }
  listImages = [];
  const list = element('insert-list');
  const grid = element('image-grid');
  list.hidden = browse !== 'placements';
  grid.hidden = browse !== 'images';
  const query = currentQuery().toLowerCase();
  let empty = '';
  let clear = false;
  const listChildren: HTMLElement[] = [];
  const gridChildren: HTMLElement[] = [];
  if (!connection) empty = 'Connect to your app to browse its artwork.';
  else if (browse === 'placements') {
    if (!artwork) empty = loading === 'placements' ? 'Loading placements…' : loadFailed ? 'Could not load placements. Choose Refresh to try again.' : '';
    else if (!artwork.placements.length) empty = 'No placements yet. Placements come from your app’s code. Ask an engineer to register a build.';
    else {
      const matches = artwork.placements.filter(item => !query || item.key.toLowerCase().includes(query) || item.screen.toLowerCase().includes(query));
      if (!matches.length) { empty = 'No placements match. Try another key or screen.'; clear = true; }
      const screens = distinct(matches.map(item => item.screen));
      for (const screen of screens) {
        const header = document.createElement('p');
        header.className = 'group';
        header.textContent = screen;
        listChildren.push(header, ...matches.filter(item => item.screen === screen).map(placementRow));
      }
    }
  } else if (!images) empty = loading === 'images' ? 'Loading images…' : loadFailed ? 'Could not load images. Choose Refresh to try again.' : '';
  else if (!images.items.length && images.q) { empty = 'No images match. Try another name.'; clear = true; }
  else if (!images.items.length) empty = 'No images in this app yet. Upload one in the console, or send artwork from the Send tab.';
  else gridChildren.push(...images.items.map(imageTile));
  list.replaceChildren(...listChildren);
  grid.replaceChildren(...gridChildren);
  updatePressed();
  element('insert-empty').hidden = !empty;
  element('insert-empty-text').textContent = empty;
  element('insert-clear').hidden = !clear;
  element('images-more').hidden = browse !== 'images' || !images?.nextCursor;
}
function renderInsertControls(): void {
  tabSend.setAttribute('aria-selected', String(tab === 'send'));
  tabInsert.setAttribute('aria-selected', String(tab === 'insert'));
  element('panel-send').hidden = tab !== 'send';
  element('panel-insert').hidden = tab !== 'insert';
  element('browse-placements').setAttribute('aria-checked', String(browse === 'placements'));
  element('browse-images').setAttribute('aria-checked', String(browse === 'images'));
  // Typing stays possible while a list loads; the search runs when it finishes.
  searchInput.disabled = !connection;
  searchInput.placeholder = browse === 'placements' ? 'Search by key or screen' : 'Search images by name';
  searchInput.setAttribute('aria-label', browse === 'placements' ? 'Search placements by key or screen' : 'Search images by name');
  element('env-group').hidden = browse !== 'placements';
  const shown = shownEnvironment();
  for (const name of ENVIRONMENTS) {
    const button = element<HTMLButtonElement>(`env-${name}`);
    button.setAttribute('aria-checked', String(shown === name));
    button.disabled = busy || !artwork || !published(name);
    button.title = artwork && !published(name) ? `Nothing is published to ${name} yet.` : '';
  }
  element<HTMLButtonElement>('insert-refresh').disabled = busy || !connection;
  element('env-note').textContent = environmentNote();
}
function renderInsertBar(): void {
  const target = insertTarget();
  showThumbnail(insertThumb, target?.asset ?? null);
  const items = browse === 'placements' ? artwork?.placements.length : images?.items.length;
  // No footer while there is nothing to insert; one hint line until something is chosen.
  insertBar.hidden = !connection || (!items && !target);
  element('insert-title').textContent = target?.title ?? (browse === 'placements' ? 'Choose a placement to insert.' : 'Choose an image to insert.');
  element('insert-meta').textContent = target?.meta ?? '';
  element('insert-note').textContent = target?.note ?? '';
  for (const id of ['insert-preview', 'insert-meta', 'insert', 'insert-note']) element(id).hidden = !target;
  if (selected?.kind !== 'placement') {
    for (const id of ['insert-state-label', 'insert-appearance-label', 'insert-arm-label']) element(id).hidden = true;
  }
  insertButton.textContent = target ? `Insert ${target.name}` : 'Insert';
  insertButton.disabled = busy || !connection || !target?.ready || pendingInsert !== null;
  placeMessages(tab === 'insert' && !insertBar.hidden);
  // Keyboard focus and scrollIntoView keep rows clear of the sticky footer (WCAG 2.4.11).
  const root = document.documentElement;
  if (root) root.style.scrollPaddingBottom = `${messagesDocked ? insertBar.offsetHeight + 8 : 0}px`;
}

function enterInsert(): void {
  if (tab !== 'insert' || busy || !connection || connectionGeneration === null) return;
  if (browse === 'placements' && artworkGeneration !== connectionGeneration) void loadArtwork();
  else if (browse === 'images' && (!images || images.q !== currentQuery())) void loadImages(true);
}
async function loadArtwork(): Promise<void> {
  if (busy || !connection || connectionGeneration === null) return;
  const config = connection;
  const generation = connectionGeneration;
  clearError();
  loading = 'placements';
  loadFailed = false;
  artwork = null;
  setBusy(true);
  renderList();
  try {
    let response: { status: number; payload: unknown };
    // An older console answers the unknown route without CORS headers, which the iframe sees as a network error.
    try { response = await requestJson(config, apiUrl(config, 'placements/artwork')); }
    catch { throw new Error(placementsLoaded ? insertUnavailable(config.origin) : mapNetworkError(config.origin)); }
    if (generation !== connectionGeneration) return;
    if (response.status !== 200) {
      if (response.status === 401) needsAttention();
      throw new Error(mapHttpError(response.status, response.payload, 'insert'));
    }
    artwork = parseArtwork(response.payload);
    artworkGeneration = generation;
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
    if (generation !== connectionGeneration) return;
    artwork = null;
    artworkGeneration = null;
    loadFailed = true;
    if (selected?.kind === 'placement') selected = null;
    showError(errorText(error));
  } finally {
    if (generation === connectionGeneration) { loading = null; setBusy(false); renderList(); }
  }
}
async function loadImages(reset: boolean): Promise<void> {
  if (busy || !connection || connectionGeneration === null) return;
  const previous = images;
  const q = reset ? currentQuery() : previous?.q ?? '';
  const cursor = reset ? undefined : previous?.nextCursor ?? undefined;
  if (!reset && !cursor) return;
  const config = connection;
  const generation = connectionGeneration;
  clearError();
  loading = 'images';
  loadFailed = false;
  if (reset) { images = null; if (selected?.kind === 'image') selected = null; }
  setBusy(true);
  renderList();
  try {
    const url = assetsUrl(config, { limit: 24, cursor, q: q || undefined });
    let response: { status: number; payload: unknown };
    try { response = await requestJson(config, url); }
    catch { throw new Error(placementsLoaded ? insertUnavailable(config.origin) : mapNetworkError(config.origin)); }
    if (generation !== connectionGeneration) return;
    if (response.status !== 200) {
      if (response.status === 401) needsAttention();
      throw new Error(mapHttpError(response.status, response.payload, 'insert'));
    }
    const page = parseAssetPage(response.payload);
    const items = previous && !reset ? [...previous.items, ...page.assets.filter(asset => !previous.items.some(item => item.id === asset.id))] : page.assets;
    images = { items, nextCursor: page.nextCursor, q };
  } catch (error) {
    if (generation !== connectionGeneration) return;
    // A failed Load more keeps the pages already shown.
    if (reset) loadFailed = true; else images = previous;
    showError(errorText(error));
  } finally {
    if (generation === connectionGeneration) { loading = null; setBusy(false); renderList(); }
  }
}
function searchImages(): void {
  searchTimer = null;
  if (browse !== 'images' || !connection) return;
  if (busy) { searchTimer = window.setTimeout(searchImages, 300); return; }
  if (!images || images.q !== currentQuery()) void loadImages(true);
}
async function beginInsert(): Promise<void> {
  if (busy || !connection || connectionGeneration === null || pendingInsert) return;
  const target = insertTarget();
  const asset = target?.asset;
  if (!target || !asset) return;
  const config = connection;
  const generation = connectionGeneration;
  clearError();
  const rendition = insertRendition(asset);
  if (!rendition) {
    showError(asset.renditions.length === 0 ? LEGACY_IMAGE
      : 'This image is larger than 4 MiB in every version, so it cannot be inserted here. Download it from the console.');
    return;
  }
  setBusy(true);
  setStatus(`Downloading ${target.name}…`);
  try {
    const url = renditionUrl(config, asset.id, rendition.sha256);
    let response: Awaited<ReturnType<typeof requestBytes>>;
    try { response = await requestBytes(config, url, rendition.bytes); }
    catch { throw new Error(mapNetworkError(config.origin)); }
    if (generation !== connectionGeneration) return;
    if (response.status !== 200) {
      if (response.status === 401) needsAttention();
      // This console listed the image, so a 404 means the image went away, not that the console lacks Insert.
      throw new Error(response.status === 404 ? GONE_IMAGE : mapHttpError(response.status, response.payload, 'insert'));
    }
    if (mediaType(response.contentType) !== rendition.mime || response.bytes.byteLength !== rendition.bytes) throw new Error(UNEXPECTED_IMAGE);
    let bytes = response.bytes;
    if (rendition.mime === 'image/webp') {
      setStatus('Converting to PNG…');
      try { bytes = await webpToPng(bytes); }
      catch { throw new Error('Could not convert this WebP image to PNG for Figma. Try again, or download it from the console.'); }
      if (generation !== connectionGeneration) return;
    }
    const size = pngSize(bytes);
    if (!size || size.width !== rendition.width || size.height !== rendition.height) throw new Error(UNEXPECTED_IMAGE);
    pendingInsert = { id: ++sequence, generation, environment: target.link?.environment ?? null };
    setStatus(`Inserting ${target.name}…`);
    post({ type: 'insert', requestId: pendingInsert.id, connectionGeneration: generation, bytes, name: target.name, frame: target.frame, scale, link: target.link });
  } catch (error) {
    // A connection switch drops this insert quietly; the new connection owns the busy state.
    if (generation !== connectionGeneration) return;
    pendingInsert = null; setBusy(false); setStatus(''); showError(errorText(error));
  }
}
function resetInsert(): void {
  artwork = null; artworkGeneration = null; images = null; selected = null; pendingInsert = null;
  placementsLoaded = false; loading = null; loadFailed = false;
  if (searchTimer !== null) { window.clearTimeout(searchTimer); searchTimer = null; }
  resetThumbnails();
  renderList();
}

window.onmessage = (event: MessageEvent<{ pluginMessage?: MainMessage }>) => {
  // Figma posts plugin messages from its top window, not from the iframe's direct parent (a shim iframe).
  if (event.source !== parent && event.source !== top) return;
  const message = event.data?.pluginMessage;
  if (!message) return;
  switch (message.type) {
    case 'connection':
      clearRememberedSelection();
      connection = message.connection;
      connectionGeneration = message.connectionGeneration;
      placements = [];
      token.value = '';
      if (connection) {
        origin.value = connection.origin; orgId.value = connection.orgId; appId.value = connection.appId;
        element('token-prefix').textContent = `Saved token: ${tokenPrefix(connection.token)}. Leave blank to keep it for this app.`;
      }
      element<HTMLInputElement>('file-url').value = message.savedFileUrl;
      if (!preferencesLoaded) {
        preferencesLoaded = true;
        ({ tab, browse, environment, scale } = parsePreferences(message.preferences));
        scalePicker.value = String(scale);
      }
      resetInsert();
      if (connection) {
        const generation = message.connectionGeneration;
        // A failed placements read already explains itself; the Insert list waits for Refresh.
        void loadPlacements().then(() => {
          if (generation !== connectionGeneration) return;
          if (placementsLoaded) enterInsert(); else { loadFailed = true; renderList(); }
        });
      } else { setBusy(false); setStatus('Connect to your app to get started.'); }
      break;
    case 'selection': {
      if (message.connectionGeneration !== connectionGeneration) break;
      selectionGeneration = message.connectionGeneration;
      selection = message.selection;
      const identity = JSON.stringify([selection.fileKey, selection.node?.id, selection.remembered]);
      if (identity !== selectionIdentity) { selectionIdentity = identity; selectRemembered(); }
      render();
      break;
    }
    case 'file-saved': setBusy(false); setStatus('File URL saved for this session.'); break;
    case 'exported': void sendExport(message); break;
    case 'remembered':
      if (pending?.id === message.requestId) { pending = null; setBusy(false); setStatus('Sync target saved. Review the draft in the console.'); }
      break;
    case 'inserted': {
      const operation = pendingInsert;
      if (!operation || operation.id !== message.requestId || operation.generation !== message.connectionGeneration) break;
      pendingInsert = null;
      setBusy(false);
      const fileKnown = hasCurrentSelection() && Boolean(selection.fileKey);
      setStatus(message.linked && operation.environment
        ? `Inserted ${message.node.name} from ${environmentLabel(operation.environment)}. Edit it, then use Sync on the Send tab.${fileKnown ? '' : ' Confirm the file URL on the Send tab to enable Sync.'}`
        : `Inserted ${message.node.name}.`);
      break;
    }
    case 'error':
      if (message.requestId !== undefined && message.requestId !== pending?.id && message.requestId !== pendingInsert?.id) break;
      pending = null; pendingInsert = null; setBusy(false); setStatus(''); showError(message.message); break;
  }
};
element<HTMLFormElement>('connection-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy) return;
  clearError();
  try {
    const sameApp = connection && connection.origin === origin.value && connection.orgId === orgId.value.trim() && connection.appId === appId.value.trim();
    const next = validateConnection({ origin: origin.value, orgId: orgId.value, appId: appId.value, token: token.value.trim() || (sameApp ? connection?.token ?? '' : '') });
    token.value = '';
    clearRememberedSelection();
    connectionGeneration = null;
    placements = [];
    setBusy(true); setStatus('Saving connection…');
    post({ type: 'save-connection', connection: next });
  } catch (error) { showError(errorText(error)); }
});
element<HTMLFormElement>('file-form').addEventListener('submit', event => {
  event.preventDefault();
  if (busy) return;
  clearError(); setBusy(true); setStatus('Saving file URL…');
  post({ type: 'save-file-url', url: element<HTMLInputElement>('file-url').value });
});
placementPicker.addEventListener('change', () => updateCellPickers());
sendButton.addEventListener('click', () => beginSend(false));
syncButton.addEventListener('click', () => beginSend(true));
function setTab(next: typeof tab): void {
  if (busy || tab === next) return;
  tab = next;
  setStatus('');
  savePreferences();
  render();
  enterInsert();
}
function setBrowse(next: typeof browse): void {
  if (busy || browse === next) return;
  browse = next;
  selected = null;
  setStatus('');
  savePreferences();
  renderList();
  render();
  enterInsert();
}
function setEnvironment(next: EnvironmentName): void {
  if (busy || !artwork || !published(next) || shownEnvironment() === next) return;
  environment = next;
  savePreferences();
  renderList();
  render();
}
tabSend.addEventListener('click', () => setTab('send'));
tabInsert.addEventListener('click', () => setTab('insert'));
element('browse-placements').addEventListener('click', () => setBrowse('placements'));
element('browse-images').addEventListener('click', () => setBrowse('images'));
for (const name of ENVIRONMENTS) element(`env-${name}`).addEventListener('click', () => setEnvironment(name));
scalePicker.addEventListener('change', () => {
  const value = Number(scalePicker.value);
  if (value !== 1 && value !== 2 && value !== 3) { scalePicker.value = String(scale); return; }
  scale = value;
  savePreferences();
  render();
});
searchInput.addEventListener('input', () => {
  if (browse === 'placements') { renderList(); return; }
  if (searchTimer !== null) window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(searchImages, 300);
});
element('insert-clear').addEventListener('click', () => {
  searchInput.value = '';
  if (browse === 'placements') renderList(); else searchImages();
});
element('insert-refresh').addEventListener('click', () => {
  if (busy || !connection) return;
  if (browse === 'placements') void loadArtwork(); else void loadImages(true);
});
element('images-more').addEventListener('click', () => { void loadImages(false); });
for (const picker of [insertStatePicker, insertAppearancePicker, insertArmPicker]) {
  picker.addEventListener('change', () => {
    if (selected?.kind !== 'placement') return;
    selected = { ...selected, cell: pickedCell() };
    render();
  });
}
insertButton.addEventListener('click', () => { void beginInsert(); });
post({ type: 'init' });
