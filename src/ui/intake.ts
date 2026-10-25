import { assetsPath, baseCoordinate, insertRendition, parseAssetPage, parsePlacements, tokenRefused, TOKEN_NO_LONGER_ACCEPTED } from '../shared/index.js';
import type { Connection, LibraryAsset, Placement } from '../shared/index.js';
import { markConnected, needsAttention } from './connection.js';
import { beginArtworkRead, catalogDraftStatus, revealPlacement, reviewSendArtwork, selectUploadedImage, showInsertError } from './insert.js';
import { showPlacements } from './send.js';
import { clearError, element, errorText, onImagesHandoff, reloadConnection, scheduleRender, setBusy, setStatus, setUnavailable, showError } from './dom.js';
import { readFailure, send } from './http.js';
import { actionsBlocked, state } from './state.js';
import { releaseListImages, thumbnailFrame } from './thumbnails.js';

let pending: { generation: number; kind: 'images' | 'placements' | 'open' } | null = null;
type Uploads = { generation: number; config: Connection; attention: number; since?: string; until?: string; cursor: string | null;
  items: LibraryAsset[]; fresh: string[]; pages: number; checked: boolean; unavailable: boolean; limited: boolean };
let uploads: Uploads | null = null;
let uploadRendered = '';
const query = () => element<HTMLInputElement>('insert-search').value;
const currentUploads = (value = uploads) => value !== null && value.generation === state.connectionGeneration
  && value.config === state.connection && value.attention === state.attentionCount && !state.connectionChanging;
const imageView = () => state.prefs.tab === 'insert' && state.prefs.browse === 'images';
const unsupported = 'Added images can’t be identified with this console. Use Refresh to browse the library.';

async function uploadPage(config: Connection, generation: number, path: string, valid: () => boolean) {
  const result = await send(config, { path, channel: 'uploads', retry: false });
  if (!valid() || result.kind === 'aborted') return null;
  if (result.status !== 200) {
    if (tokenRefused(result.status, result.payload)) {
      if (config.method === 'browser' && await reloadConnection(generation)) return null;
      if (!valid()) return null;
      needsAttention({ text: TOKEN_NO_LONGER_ACCEPTED, field: 'token' }, true);
      showInsertError(TOKEN_NO_LONGER_ACCEPTED);
    }
    throw new Error(readFailure(result, config, 'insert'));
  }
  return parseAssetPage(result.payload);
}

async function prepareUploads(): Promise<boolean> {
  const config = state.connection, generation = state.connectionGeneration;
  if (!config || generation === null || !current() || actionsBlocked() || pending?.generation === generation) return false;
  const operation = { generation, kind: 'open' as const }, attention = state.attentionCount, tab = state.prefs.tab, browse = state.prefs.browse;
  pending = operation;
  const valid = () => pending === operation && config === state.connection && current() && generation === state.connectionGeneration
    && attention === state.attentionCount && tab === state.prefs.tab && browse === state.prefs.browse;
  clearError(); scheduleRender();
  try {
    const page = await uploadPage(config, generation, assetsPath({ limit: 1 }), valid);
    if (!page || !valid()) return false;
    uploads = { config, generation, attention, since: page.checkedAt, cursor: null, items: [], fresh: [], pages: 0, checked: false, unavailable: false, limited: false };
    return true;
  } catch (error) {
    if (valid()) showError(errorText(error), { label: 'Try again', run: () => element('images-upload').click() });
    return false;
  } finally {
    if (pending === operation) { pending = null; scheduleRender(); }
  }
}

async function checkUploads(more = false): Promise<void> {
  const receipt = uploads;
  if (!receipt?.since || !currentUploads(receipt) || !imageView() || actionsBlocked() || state.ops.loadingList
    || pending?.generation === receipt.generation || receipt.items.length >= 120 || more && (!receipt.cursor || receipt.pages >= 5)) return;
  const { config, generation } = receipt, q = query(), operation = { generation, kind: 'images' as const };
  pending = operation;
  const valid = () => pending === operation && uploads === receipt && currentUploads(receipt) && imageView() && q === query() && !actionsBlocked();
  clearError(); setStatus(''); scheduleRender();
  try {
    const page = await uploadPage(config, generation, assetsPath({ limit: 24, since: receipt.since,
      ...(more ? { cursor: receipt.cursor!, until: receipt.until } : {}) }), valid);
    if (!page || !valid()) return;
    if (!page.checkedAt) throw new Error(unsupported);
    if (more && (page.checkedAt !== receipt.until || page.nextCursor && page.nextCursor === receipt.cursor))
      throw new Error('The upload check changed. Check for uploaded images again.');
    const items = new Map(receipt.items.map(item => [item.id, item]));
    let limited = receipt.limited;
    for (const item of page.assets) {
      if (items.has(item.id) || items.size < 120) items.set(item.id, item);
      else limited = true;
    }
    const fresh = new Set(more ? receipt.fresh : []), ordered = new Map<string, LibraryAsset>(more ? receipt.items.map(item => [item.id, item]) : []);
    for (const item of page.assets) if (items.has(item.id)) { fresh.add(item.id); ordered.set(item.id, item); }
    for (const item of items.values()) if (!ordered.has(item.id)) ordered.set(item.id, item);
    uploads = { ...receipt, items: [...ordered.values()], fresh: [...fresh], cursor: page.nextCursor, until: page.checkedAt, pages: more ? receipt.pages + 1 : 1,
      checked: true, unavailable: receipt.unavailable || Boolean(page.unavailable), limited };
    markConnected(); setStatus(uploadSummary(uploads));
  } catch (error) { if (valid()) showError(errorText(error)); }
  finally { if (pending === operation) { pending = null; scheduleRender(); } }
}

function uploadSummary(receipt: Uploads): string {
  const prior = receipt.items.length - receipt.fresh.length;
  return `${receipt.items.length ? `${receipt.items.length} image${receipt.items.length === 1 ? '' : 's'} loaded${prior ? `; ${prior} kept from earlier checks` : ''}.` : receipt.unavailable ? 'Image details unavailable.' : receipt.cursor ? 'No images loaded on this page.' : 'No images added in this check.'}${receipt.cursor || receipt.limited ? ' More may be available.' : ''}${receipt.unavailable ? ' Some image details could not be read.' : ''}`;
}

function renderUploads(): void {
  const receipt = currentUploads() ? uploads : null, visible = Boolean(receipt && imageView());
  element('images-return').hidden = !visible;
  element('images-check-note').textContent = !receipt?.since ? unsupported : 'Checks all Images in this app; your search and shape filter stay applied below.';
  const opening = pending?.generation === state.connectionGeneration && pending.kind === 'open';
  setBusy(element('images-upload'), opening ? 'Preparing…' : 'Upload images…', opening);
  setUnavailable(element('images-upload'), opening || actionsBlocked());
  setUnavailable(element('images-check'), !visible || !receipt?.since || receipt.items.length >= 120 || actionsBlocked() || Boolean(state.ops.loadingList) || pending?.generation === state.connectionGeneration);
  const review = element('image-arrivals'), list = element('image-arrivals-list');
  review.hidden = !visible || !receipt?.checked;
  const key = review.hidden ? '' : JSON.stringify([receipt, actionsBlocked(), state.ops.loadingList]);
  if (key !== uploadRendered) {
    uploadRendered = key;
    const scroll = element('list-region').scrollTop;
    releaseListImages(list); list.replaceChildren();
    if (key && receipt) {
      element('image-arrivals-note').textContent = uploadSummary(receipt);
      for (const asset of receipt.items) {
        const row = document.createElement('div'), name = document.createElement('span'), button = document.createElement('button');
        row.className = 'upload-row'; name.className = 'meta'; name.textContent = asset.name || 'Untitled image';
        button.type = 'button'; button.className = 'text-action'; button.textContent = 'Select image';
        const prior = !receipt.fresh.includes(asset.id), blocked = prior || !insertRendition(asset);
        if (blocked) name.textContent += prior ? ' · Not checked in latest results' : ' · No insertable version';
        setUnavailable(button, blocked || actionsBlocked() || Boolean(state.ops.loadingList));
        button.addEventListener('click', () => {
          if (uploads !== receipt || !currentUploads(receipt) || !imageView() || blocked || actionsBlocked() || state.ops.loadingList) return;
          selectUploadedImage(asset);
        });
        row.append(thumbnailFrame(asset, false, asset, list, { width: 40, height: 32 }), name, button); list.append(row);
      }
    }
    element('list-region').scrollTop = scroll;
  }
  const more = element('image-arrivals-more');
  const focused = document.activeElement === more;
  more.hidden = review.hidden || !receipt?.cursor || receipt.pages >= 5 || receipt.items.length >= 120;
  if (more.hidden && focused) element('images-check').focus({ preventScroll: true });
  setUnavailable(more, actionsBlocked() || Boolean(state.ops.loadingList) || pending?.generation === state.connectionGeneration);
  element('image-arrivals-limit').hidden = review.hidden || !(receipt?.limited || receipt!.items.length >= 120 || receipt?.cursor && receipt.pages >= 5);
}
let baseline: { generation: number; placements: Placement[] } | null = null;
let catalogResult: { generation: number; attention: number; text: string; added: Placement[]; from: number; placements: Placement[] } | null = null;
let showInsert: () => void = () => {};
let shown = 20;
const rendered = new Map<string, string>();
const catalogButtons = ['insert-catalog-check', 'send-catalog-check'];
const current = () => state.connection !== null && state.connectionGeneration !== null && !state.connectionChanging;

export function renderIntake(): void {
  if (current() && state.placementsLoaded && baseline?.generation !== state.connectionGeneration)
    baseline = { generation: state.connectionGeneration!, placements: state.placements };
  for (const view of ['insert', 'send']) {
    const result = element(`${view}-catalog-result`);
    result.hidden = !current() || catalogResult?.generation !== state.connectionGeneration || catalogResult?.attention !== state.attentionCount
      || catalogResult?.placements !== state.placements || view === 'insert' && state.prefs.browse !== 'placements';
    result.textContent = result.hidden ? '' : catalogResult!.text;
    const review = element(`${view}-catalog-arrivals`), list = element(`${view}-catalog-added`);
    review.hidden = result.hidden || !catalogResult?.added.length;
    const receipt = catalogResult;
    const key = review.hidden ? '' : JSON.stringify([receipt, shown, receipt!.added.slice(0, shown).map(item => catalogDraftStatus(item, receipt!.from)), actionsBlocked()]);
    if (rendered.get(view) !== key) {
      rendered.set(view, key); list.replaceChildren();
      if (key && receipt) {
        element(`${view}-catalog-summary`).textContent = `Review ${receipt.added.length} new placement${receipt.added.length === 1 ? '' : 's'}`;
        for (const item of receipt.added.slice(0, shown)) {
          const row = document.createElement('div'), label = document.createElement('p'), button = document.createElement('button');
          label.textContent = `${item.key} · ${catalogDraftStatus(item, receipt.from)}`; label.className = 'meta';
          button.type = 'button'; button.className = 'text-action'; button.textContent = 'Review in Insert';
          setUnavailable(button, actionsBlocked() || catalogDraftStatus(item, receipt.from) === 'Draft artwork not checked');
          button.addEventListener('click', () => {
            if (catalogResult !== receipt || receipt.placements !== state.placements || receipt.generation !== state.connectionGeneration || receipt.attention !== state.attentionCount
              || actionsBlocked() || catalogDraftStatus(item, receipt.from) === 'Draft artwork not checked') return;
            showInsert(); revealPlacement(item.key, baseCoordinate(item), 'draft');
          });
          row.append(label, button); list.append(row);
        }
      }
    }
    element(`${view}-catalog-more`).hidden = review.hidden || shown >= (receipt?.added.length ?? 0);
    element(`${view}-catalog-tools`).hidden = !current() || !state.placementsLoaded || view === 'insert' && state.prefs.browse !== 'placements';
  }
  for (const id of ['images-check', ...catalogButtons]) {
    const kind = id === 'images-check' ? 'images' : 'placements';
    const busy = pending?.generation === state.connectionGeneration && pending.kind === kind;
    setBusy(element(id), busy ? 'Checking…' : kind === 'images' ? 'Check for uploaded images' : 'Check for placements', busy);
    setUnavailable(element(id), !current() || actionsBlocked() || state.ops.loadingList !== null || pending?.generation === state.connectionGeneration);
  }
  renderUploads();
}

async function check(kind: 'placements'): Promise<void> {
  const config = state.connection, generation = state.connectionGeneration;
  if (!config || generation === null || state.connectionChanging || actionsBlocked() || state.ops.loadingList || pending?.generation === generation) return;
  const initialPlacements = state.placements;
  const operation = { generation, kind }, attention = state.attentionCount, tab = state.prefs.tab;
  pending = operation;
  if (kind === 'placements') catalogResult = null;
  const valid = () => pending === operation && generation === state.connectionGeneration && !state.connectionChanging && attention === state.attentionCount && (kind !== 'placements' || state.placements === initialPlacements || state.placements === catalogResult?.placements);
  clearError();
  setStatus('');
  scheduleRender();
  try {
    let text: string | undefined;
    {
      const result = await send(config, { path: 'placements', retry: false });
      if (!valid() || actionsBlocked() || result.kind === 'aborted') return;
      if (result.status !== 200) {
        if (tokenRefused(result.status, result.payload)) {
          if (config.method === 'browser' && await reloadConnection(generation)) return;
          if (!valid()) return;
          needsAttention({ text: TOKEN_NO_LONGER_ACCEPTED, field: 'token' }, true);
          showInsertError(TOKEN_NO_LONGER_ACCEPTED);
        }
        throw new Error(readFailure(result, config));
      }
      const placements = parsePlacements(result.payload), before = baseline?.generation === generation ? baseline.placements : null;
      const from = beginArtworkRead();
      const artwork = await send(config, { path: 'placements/artwork', retry: false });
      if (!valid() || actionsBlocked() || artwork.kind === 'aborted') return;
      if (artwork.status !== 200) {
        if (tokenRefused(artwork.status, artwork.payload)) {
          if (config.method === 'browser' && await reloadConnection(generation)) return;
          if (!valid()) return;
          needsAttention({ text: TOKEN_NO_LONGER_ACCEPTED, field: 'token' }, true); showInsertError(TOKEN_NO_LONGER_ACCEPTED);
        }
        throw new Error(readFailure(artwork, config));
      }
      reviewSendArtwork(artwork.payload, generation, from, attention);
      const added = before ? placements.filter(item => !before.some(old => item.slotId && old.slotId ? item.slotId === old.slotId : item.key === old.key)) : [];
      showPlacements(placements);
      markConnected();
      text = placements.length ? `${placements.length} placement${placements.length === 1 ? '' : 's'} available. Choose a destination, then Send when ready.`
        : 'No placements yet. Sync the app catalog, then check again.';
      text += before ? ` ${added.length ? `${added.length} new since the last check.` : 'No new placements since the last check.'}` : ' Catalog loaded; future checks show new arrivals.';
      baseline = { generation, placements }; shown = 20;
      catalogResult = { generation, attention, text, added, from, placements: state.placements };
    }
    if (valid() && state.prefs.tab === tab && text) setStatus(text);
  } catch (error) {
    if (valid() && state.prefs.tab === tab) showError(errorText(error));
  } finally {
    if (pending === operation) { pending = null; scheduleRender(); }
  }
}

export function initIntake(goToInsert: () => void): void {
  showInsert = goToInsert;
  onImagesHandoff(prepareUploads);
  element('images-check').addEventListener('click', () => { void checkUploads(); });
  element('image-arrivals-more').addEventListener('click', () => { void checkUploads(true); });
  for (const id of catalogButtons) element(id).addEventListener('click', () => { void check('placements'); });
  for (const view of ['insert', 'send']) element(`${view}-catalog-more`).addEventListener('click', () => { shown += 20; scheduleRender(); });
}
