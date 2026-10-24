import { baseCoordinate, parsePlacements, tokenRefused, TOKEN_NO_LONGER_ACCEPTED } from '../shared/index.js';
import type { Placement } from '../shared/index.js';
import { markConnected, needsAttention } from './connection.js';
import { beginArtworkRead, catalogDraftStatus, checkImages, revealPlacement, reviewSendArtwork, showInsertError } from './insert.js';
import { showPlacements } from './send.js';
import { clearError, element, errorText, reloadConnection, scheduleRender, setBusy, setStatus, setUnavailable, showError } from './dom.js';
import { readFailure, send } from './http.js';
import { actionsBlocked, state } from './state.js';

let pending: { generation: number; kind: 'images' | 'placements' } | null = null;
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
  const images = current() && state.prefs.browse === 'images' && state.imagesOpened === state.connectionGeneration;
  element('images-return').hidden = !images;
  const q = element<HTMLInputElement>('insert-search').value.trim().slice(0, 120);
  element('images-check-note').textContent = q ? `Search “${q}” stays applied and may hide uploaded images.` : 'After uploading in the console, check this library.';
  for (const id of ['images-check', ...catalogButtons]) {
    const kind = id === 'images-check' ? 'images' : 'placements';
    const busy = pending?.generation === state.connectionGeneration && pending.kind === kind;
    setBusy(element(id), busy ? 'Checking…' : kind === 'images' ? 'Check for uploaded images' : 'Check for placements', busy);
    setUnavailable(element(id), !current() || actionsBlocked() || state.ops.loadingList !== null || pending?.generation === state.connectionGeneration);
  }
}

async function check(kind: 'images' | 'placements'): Promise<void> {
  const config = state.connection, generation = state.connectionGeneration;
  if (!config || generation === null || state.connectionChanging || actionsBlocked() || state.ops.loadingList || pending?.generation === generation) return;
  if (kind === 'images' && (state.imagesOpened !== generation || state.prefs.browse !== 'images' || state.prefs.tab !== 'insert')) return;
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
    if (kind === 'images') text = await checkImages();
    else {
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
  element('images-check').addEventListener('click', () => { void check('images'); });
  for (const id of catalogButtons) element(id).addEventListener('click', () => { void check('placements'); });
  for (const view of ['insert', 'send']) element(`${view}-catalog-more`).addEventListener('click', () => { shown += 20; scheduleRender(); });
}
