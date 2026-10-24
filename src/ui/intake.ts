import { parsePlacements, tokenRefused, TOKEN_NO_LONGER_ACCEPTED } from '../shared/index.js';
import { markConnected, needsAttention } from './connection.js';
import { checkImages, ensureArtwork, showInsertError } from './insert.js';
import { showPlacements } from './send.js';
import { clearError, element, errorText, reloadConnection, scheduleRender, setBusy, setStatus, setUnavailable, showError } from './dom.js';
import { readFailure, send } from './http.js';
import { actionsBlocked, state } from './state.js';

let pending: { generation: number; kind: 'images' | 'placements' } | null = null;
let catalogResult: { generation: number; attention: number; text: string } | null = null;
const catalogButtons = ['insert-catalog-check', 'send-catalog-check'];
const current = () => state.connection !== null && state.connectionGeneration !== null && !state.connectionChanging;

export function renderIntake(): void {
  for (const view of ['insert', 'send']) {
    const result = element(`${view}-catalog-result`);
    result.hidden = !current() || catalogResult?.generation !== state.connectionGeneration || catalogResult?.attention !== state.attentionCount
      || view === 'insert' && state.prefs.browse !== 'placements';
    result.textContent = result.hidden ? '' : catalogResult!.text;
  }
  const images = current() && state.prefs.browse === 'images' && state.imagesOpened === state.connectionGeneration;
  element('images-return').hidden = !images;
  const q = element<HTMLInputElement>('insert-search').value.trim().slice(0, 120);
  element('images-check-note').textContent = q ? `Search “${q}” stays applied and may hide uploaded images.` : 'After uploading in the console, check this library.';
  element('insert-catalog-check').hidden = !current() || state.prefs.browse !== 'placements'
    || element('insert-empty-link').hidden || element('insert-empty-link').textContent !== 'Set up app catalog';
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
  const operation = { generation, kind }, attention = state.attentionCount, tab = state.prefs.tab;
  pending = operation;
  if (kind === 'placements') catalogResult = null;
  const valid = () => pending === operation && generation === state.connectionGeneration && !state.connectionChanging && attention === state.attentionCount;
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
      const placements = parsePlacements(result.payload);
      showPlacements(placements);
      markConnected();
      ensureArtwork(true);
      text = placements.length ? `${placements.length} placement${placements.length === 1 ? '' : 's'} available. Choose a destination, then Send when ready.`
        : 'No placements yet. Sync the app catalog, then check again.';
      catalogResult = { generation, attention, text };
    }
    if (valid() && state.prefs.tab === tab && text) setStatus(text);
  } catch (error) {
    if (valid() && state.prefs.tab === tab) showError(errorText(error));
  } finally {
    if (pending === operation) { pending = null; scheduleRender(); }
  }
}

export function initIntake(): void {
  element('images-check').addEventListener('click', () => { void check('images'); });
  for (const id of catalogButtons) element(id).addEventListener('click', () => { void check('placements'); });
}
