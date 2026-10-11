// The Send tab: the selection, the placement and cell pickers, the ratio gate, Send, Sync, and the file link.
import {
  DRAFT_MAY_HAVE_ARRIVED, appearanceLabel, aspectMismatch, aspectRatioDifference, buildDraftBody, bytesToBase64, cellOptions, chooseExportSettings,
  consoleLink, environmentLabel, mapHttpError, mapNetworkError, mapTimeoutError, parseDraftResponse, parsePngDimensions, ratioLabel, sizeLabel,
  validateBinding,
} from '../shared/index.js';
import type { Appearance, CellBinding, Connection, DraftResult, Placement } from '../shared/index.js';
import type { MainMessage } from '../shared/protocol.js';
import { announceError, clearError, element, errorText, flushRender, inField, post, scheduleRender, setStatus, setUnavailable, showError, toast } from './dom.js';
import { send } from './http.js';
import { actionsBlocked, hasCurrentSelection, nextRequestId, readProblem, state } from './state.js';
import type { ReadProblem } from './state.js';

const placementPicker = element<HTMLSelectElement>('placement');
const statePicker = element<HTMLSelectElement>('state');
const appearancePicker = element<HTMLSelectElement>('appearance');
const armPicker = element<HTMLSelectElement>('arm');
const sendButton = element<HTMLButtonElement>('send');
const syncButton = element<HTMLButtonElement>('sync');
const matchRatioButton = element<HTMLButtonElement>('match-ratio');
const sendProblem = element('send-problem');
const CHOOSE_PLACEMENT = 'Choose placement…';

let pending: { id: number; connection: Connection; placement: Placement; bind: CellBinding; rebind: boolean; result: DraftResult | null } | null = null;
// The request id of the last Match ratio, so its error is shown.
let pendingMatch: number | null = null;
// The request id of the file link being saved.
let pendingFile: number | null = null;
let selectionIdentity = '';
// The connection generation the placement picker was filled for; a choice never carries over to another connection.
let pickerGeneration: number | null = null;

export function clearRememberedSelection(): void {
  state.selection = { ...state.selection, remembered: null };
  state.selectionGeneration = null;
  selectionIdentity = '';
}
function chosenPlacement(): Placement | undefined { return state.placements.find(item => item.key === placementPicker.value); }
function chosenBinding(placement: Placement): CellBinding {
  return validateBinding(placement, {
    slotKey: placement.key, state: statePicker.value || null,
    appearance: (appearancePicker.value || null) as CellBinding['appearance'], arm: armPicker.value || null,
  });
}
function rememberedBinding(): { placement: Placement; bind: CellBinding } | null {
  if (!hasCurrentSelection()) return null;
  const target = state.selection.remembered;
  if (!target) return null;
  const placement = state.placements.find(item => item.key === target.placementKey);
  if (!placement) return null;
  try {
    return { placement, bind: validateBinding(placement, { slotKey: target.placementKey, state: target.state, appearance: target.appearance, arm: target.arm }) };
  } catch { return null; }
}
function setOptions(picker: HTMLSelectElement, values: (string | null)[], label: (value: string | null) => string): void {
  picker.replaceChildren(...values.map(value => new Option(label(value), value ?? '')));
}
function updateCellPickers(bind?: CellBinding): void {
  const placement = chosenPlacement();
  const options = placement ? cellOptions(placement) : { states: [null], appearances: [null], arms: [null] };
  setOptions(statePicker, options.states, value => value ?? (placement?.defaultState ? `Default (${placement.defaultState})` : 'Default'));
  setOptions(appearancePicker, options.appearances, value => appearanceLabel(value as Appearance | null));
  setOptions(armPicker, options.arms, value => value ?? 'Control');
  if (bind) {
    statePicker.value = bind.state ?? '';
    appearancePicker.value = bind.appearance ?? '';
    armPicker.value = bind.arm ?? '';
  }
  element('state-label').hidden = options.states.length <= 1;
  element('appearance-label').hidden = options.appearances.length <= 1;
  element('arm-label').hidden = options.arms.length <= 1;
  scheduleRender();
}
function selectRemembered(): void {
  const target = rememberedBinding();
  if (target) { placementPicker.value = target.placement.key; updateCellPickers(target.bind); }
}

/** The connection test's placements, for the Send picker. Nothing is chosen until the person or a remembered target chooses. */
export function showPlacements(list: Placement[]): void {
  state.placements = list;
  state.placementsLoaded = true;
  const chosen = pickerGeneration === state.connectionGeneration ? placementPicker.value : '';
  pickerGeneration = state.connectionGeneration;
  placementPicker.replaceChildren(...(list.length
    ? [new Option(CHOOSE_PLACEMENT, ''), ...list.map(item => new Option(`${item.key} · ${item.width} × ${item.height}`, item.key))]
    : [new Option('No placements yet', '')]));
  // A placement chosen before the list reloaded on this connection stays chosen while it exists.
  if (list.some(item => item.key === chosen)) placementPicker.value = chosen;
  updateCellPickers();
  selectRemembered();
}
/** No placements, with `text` in the picker saying why. */
export function clearPlacements(text: string): void {
  state.placements = [];
  placementPicker.replaceChildren(new Option(text, ''));
  updateCellPickers();
}

/** "Exports 1170 × 2534 PNG": the PNG's size, from the export constraint and the node's own ratio. */
function exportDescription(placement: Placement): string {
  const node = state.selection.node;
  if (!node) return '';
  const { constraint } = chooseExportSettings(node, placement);
  const width = constraint.type === 'WIDTH' ? constraint.value : Math.round((constraint.value * node.width) / node.height);
  const height = constraint.type === 'HEIGHT' ? constraint.value : Math.round((constraint.value * node.height) / node.width);
  return `Exports ${width} × ${height} PNG`;
}
/** True when the selected node's ratio is more than 2% off this placement's, which blocks Send or Sync to it. */
function ratioBlocks(placement: Placement | undefined): placement is Placement {
  const { node, reason } = state.selection;
  return Boolean(placement && node && !reason && aspectMismatch(node, placement));
}
function ratioText(placement: Placement, forSend: boolean): string {
  const node = state.selection.node!;
  return forSend
    ? `This frame is ${sizeLabel(node)}. ${placement.key} needs ${ratioLabel(placement)} (${placement.width} × ${placement.height}). Resize the frame or match the ratio.`
    : `This frame is ${sizeLabel(node)}. ${placement.key} needs ${ratioLabel(placement)}.`;
}
/** The placement the ratio callout and Match ratio act on: the chosen one, else the remembered one Sync would use. */
function ratioGate(): { placement: Placement; text: string } | null {
  const chosen = chosenPlacement();
  if (ratioBlocks(chosen)) return { placement: chosen, text: ratioText(chosen, true) };
  const target = rememberedBinding()?.placement;
  return ratioBlocks(target) ? { placement: target, text: ratioText(target, false) } : null;
}
/** A connection, a current selection of one exportable node, a file key, and nothing else running. */
function sendReady(): boolean {
  const { node, reason, fileKey } = state.selection;
  return Boolean(state.connection && hasCurrentSelection() && node && !reason && fileKey && !actionsBlocked());
}
/**
 * The placement Send (or Sync, with `rebind`) would use now, or null while its button is unavailable. The render and
 * the click handler both ask, so a click on an unavailable button does nothing, as on a disabled one.
 */
function actionPlacement(rebind: boolean): Placement | null {
  if (!sendReady()) return null;
  const placement = rebind ? rememberedBinding()?.placement : chosenPlacement();
  // A ratio more than 2% off the placement's cannot be sent: the console would get art that does not fit.
  return placement && !ratioBlocks(placement) ? placement : null;
}
function bindingLabel(bind: CellBinding): string {
  return [bind.slotKey, bind.arm ?? 'Control', appearanceLabel(bind.appearance), bind.state ?? 'default state'].join(' · ');
}

/**
 * Why Send has no placements (the connection test failed), with Try again or Update token, unless the open connection
 * settings say it under the token field (`inSettings`).
 */
function sendProblemShown(inSettings: boolean): ReadProblem | null {
  return state.connection && state.testFailure && !inSettings ? readProblem(state.testFailure) : null;
}
let problemShown = false;

export function renderSend(inSettings: boolean): void {
  const problem = sendProblemShown(inSettings);
  problemShown = Boolean(problem);
  sendProblem.hidden = !problem;
  element('send-problem-text').textContent = problem?.text ?? '';
  element('send-retry').hidden = problem?.action !== 'retry';
  element('send-token').hidden = problem?.action !== 'token';
  setUnavailable(element('send-retry'), actionsBlocked());
  const { selection } = state;
  const node = selection.node;
  element('selection-name').textContent = node && !selection.reason ? node.name : selection.reason ?? node?.name ?? 'Select a frame or layer to send.';
  // Whole pixels, and no node ID or type: what a designer reads off the canvas.
  element('selection-meta').textContent = node && !selection.reason ? `${Math.round(node.width)} × ${Math.round(node.height)}` : '';
  element('file-fallback').hidden = Boolean(selection.fileKey);
  placementPicker.disabled = state.placements.length === 0;
  const placement = chosenPlacement();
  setUnavailable(sendButton, !actionPlacement(false));
  const validArea = node && !selection.reason;
  element('export-note').textContent = placement && validArea ? exportDescription(placement) : '';
  const gate = ratioGate();
  element('aspect-text').textContent = gate?.text ?? '';
  element('aspect-warning').hidden = !gate;
  setUnavailable(matchRatioButton, actionsBlocked());
  const remembered = selection.remembered;
  const target = rememberedBinding();
  // A remembered target makes Sync the expected action.
  syncButton.className = target ? 'primary' : 'secondary';
  sendButton.className = target ? 'secondary' : 'primary';
  syncButton.hidden = !remembered;
  syncButton.textContent = state.ops.syncing ? 'Syncing…' : remembered ? `Sync to ${remembered.placementKey}` : '';
  sendButton.textContent = state.ops.sending ? 'Sending…' : 'Send to draft';
  setUnavailable(syncButton, !actionPlacement(true));
  element('sync-note').hidden = !remembered;
  // The export line and ratio callout above already describe the chosen placement, so the note repeats them only for another one.
  const other = Boolean(validArea && target && target.placement.key !== placement?.key);
  // The callout names one placement; when both are off, the note names Sync's.
  const otherRatio = other && target && gate?.placement !== target.placement && ratioBlocks(target.placement) ? ratioText(target.placement, false) : '';
  element('sync-note').textContent = !remembered ? '' : !target
    ? 'The remembered placement or cell is unavailable. Test the connection to refresh, or choose a new placement and send.'
    : [`${bindingLabel(target.bind)}.`, remembered.insertedFrom
      ? `Inserted from ${environmentLabel(remembered.insertedFrom.environment)}. Sync sends this layer to that cell and replaces draft references to this layer’s earlier sends, if any.`
      : 'Sync replaces every draft reference to the previous export of this layer in this app.',
    other ? `${exportDescription(target.placement)}.` : '', otherRatio].filter(Boolean).join(' ');
}

/** The connection test failed with Send in front: the form says why, announces it, and takes focus unless the person is in a field. */
export function presentSendProblem(): void {
  flushRender();
  if (!problemShown) return;
  announceError(element('send-problem-text').textContent ?? '');
  if (inField(document.activeElement)) return;
  sendProblem.focus({ preventScroll: true });
  sendProblem.scrollIntoView({ block: 'nearest' });
}

/** Main's selection report, for the current connection only. */
export function applySelection(message: Extract<MainMessage, { type: 'selection' }>): void {
  if (message.connectionGeneration !== state.connectionGeneration) return;
  state.selectionGeneration = message.connectionGeneration;
  state.selection = message.selection;
  const { selection } = state;
  const identity = JSON.stringify([selection.fileKey, selection.node?.id, selection.remembered]);
  if (identity !== selectionIdentity) { selectionIdentity = identity; selectRemembered(); }
  scheduleRender();
}

export function applyFileUrl(url: string): void { element<HTMLInputElement>('file-url').value = url; }

const sameCell = (a: CellBinding, b: CellBinding) => a.slotKey === b.slotKey && a.state === b.state && a.appearance === b.appearance && a.arm === b.arm;
const sentence = (text: string) => /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
function link(text: string, href: string): HTMLAnchorElement {
  const anchor = document.createElement('a');
  anchor.className = 'text-action';
  anchor.href = href; anchor.target = '_blank'; anchor.rel = 'noopener noreferrer'; anchor.textContent = text;
  return anchor;
}
function imageLink(config: Connection, assetId: string): string {
  try { return consoleLink(config, 'images', assetId); } catch { return consoleLink(config, 'images'); }
}

/** The inline result under the form; returns its first sentence, which the status region announces. */
function showResult(result: DraftResult, config: Connection, bind: CellBinding): string {
  const container = element('result');
  const parts: HTMLElement[] = [];
  const done = Boolean(result.bound && !result.bindError);
  // HTTP 409 (or a draft that was not bound) still created the image: say so, and where to check it.
  const summary = done ? 'Draft updated. Publish it from the console when it’s ready.'
    : result.bindError ? `The image was uploaded, but Assetlib couldn’t put it in ${bind.slotKey}: ${sentence(result.bindError)} Check the console before sending again.`
      : `The image was uploaded, but Assetlib didn’t put it in ${bind.slotKey}. Check the console before sending again.`;
  const text = document.createElement('p');
  text.className = done ? '' : 'notice';
  text.textContent = summary;
  parts.push(text, done ? link('View in console', consoleLink(config, 'releases')) : link('Open image in console', imageLink(config, result.asset.id)));
  const others = result.rebound.filter(cell => !sameCell(cell, result.bound ?? bind));
  if (others.length) {
    const also = document.createElement('p');
    also.textContent = `Also updated ${others.length} other draft cell${others.length === 1 ? '' : 's'} that used this layer’s earlier art.`;
    const details = document.createElement('details');
    const label = document.createElement('summary');
    label.className = 'text-action';
    label.textContent = 'Details';
    const list = document.createElement('ul');
    for (const cell of others) { const item = document.createElement('li'); item.textContent = bindingLabel(cell); list.append(item); }
    details.append(label, list);
    parts.push(also, details);
  }
  container.replaceChildren(...parts);
  container.hidden = false;
  return summary;
}

function endSend(): void {
  pending = null;
  state.ops.sending = false;
  state.ops.syncing = false;
  scheduleRender();
}

function beginSend(rebind: boolean): void {
  const { node, fileKey } = state.selection;
  // An unavailable button (aria-disabled keeps it clickable) does nothing; its look and the ratio callout say why.
  const placement = actionPlacement(rebind);
  if (!placement || !state.connection || !node || !fileKey) return;
  clearError();
  try {
    const remembered = rebind ? rememberedBinding() : null;
    const bind = remembered?.bind ?? chosenBinding(placement);
    pending = { id: nextRequestId(), connection: { ...state.connection }, placement, bind, rebind, result: null };
    element('result').hidden = true;
    state.ops[rebind ? 'syncing' : 'sending'] = true;
    setStatus('Exporting selected artwork…');
    post({ type: 'export', requestId: pending.id, node, fileKey, placement, bind, rebind });
    scheduleRender();
  } catch (error) { endSend(); showError(errorText(error)); }
}

/** Main exported the node: check the PNG, then post it to the draft. */
export async function sendExport(message: Extract<MainMessage, { type: 'exported' }>): Promise<void> {
  const operation = pending;
  if (!operation || operation.id !== message.requestId) return;
  try {
    const bytes = new Uint8Array(message.bytes);
    // An unreadable PNG says Figma's export failed (EXPORT_FAILED).
    const dimensions = parsePngDimensions(bytes);
    const difference = aspectRatioDifference(dimensions, operation.placement);
    if (difference > 0.02) {
      throw new Error(`The exported PNG is ${dimensions.width} × ${dimensions.height}, ${(difference * 100).toFixed(1)}% off ${operation.placement.key}’s ${ratioLabel(operation.placement)} ratio. Nothing was uploaded. Resize the frame or match the ratio.`);
    }
    setStatus('Sending PNG to the draft…');
    const body = buildDraftBody({ node: message.node, fileKey: message.fileKey, placement: operation.placement, bind: operation.bind,
      bytesBase64: bytesToBase64(bytes), settings: message.settings, rebind: operation.rebind });
    // Never retried: a draft that timed out or lost its connection may still have been saved.
    const result = await send(operation.connection, { path: 'drafts', method: 'POST', body: JSON.stringify(body) });
    if (pending !== operation) return;
    if (result.kind === 'aborted') { endSend(); setStatus(''); return; }
    if (result.kind === 'timeout') throw new Error(mapTimeoutError(result.timeoutSeconds, 'send'));
    if (result.kind === 'network') throw new Error(`${mapNetworkError(operation.connection.origin)} ${DRAFT_MAY_HAVE_ARRIVED}`);
    if (result.status !== 201 && result.status !== 409) throw new Error(mapHttpError(result.status, result.payload));
    let draft: DraftResult;
    try { draft = parseDraftResponse(result.payload); }
    catch {
      if (result.status === 409) throw new Error(mapHttpError(409, result.payload));
      throw new Error('Assetlib accepted the image but sent an answer the plugin can’t read. Check the console before sending again.');
    }
    operation.result = draft;
    setStatus(showResult(draft, operation.connection, operation.bind));
    post({ type: 'remember', requestId: operation.id });
  } catch (error) {
    if (pending !== operation) return;
    endSend(); setStatus(''); showError(errorText(error));
  }
}

/** Main saved the sync target: the send is done, and a toast says where it went. */
export function remembered(message: Extract<MainMessage, { type: 'remembered' }>): void {
  const operation = pending;
  if (operation?.id !== message.requestId) return;
  endSend();
  const draft = operation.result;
  if (!draft?.bound || draft.bindError) return;
  const key = draft.bound.slotKey;
  toast(operation.rebind ? `Synced ${key} to draft` : `Sent to ${key} draft`, { text: 'Review', url: consoleLink(operation.connection, 'releases') });
}

export function fileSaved(message: Extract<MainMessage, { type: 'file-saved' }>): void {
  if (message.requestId !== pendingFile) return;
  pendingFile = null;
  // A running operation keeps the status line; the file form hiding says the same.
  if (!actionsBlocked()) setStatus('File linked for this session.');
}

/** Main's error for a Send, Sync, Match ratio, or file link request; false when it belongs to another operation. */
export function failSend(requestId: number, message: string): boolean {
  if (requestId === pendingMatch) { pendingMatch = null; showError(message); return true; }
  if (requestId === pendingFile) {
    pendingFile = null;
    if (!actionsBlocked()) setStatus('');
    showError(message);
    return true;
  }
  if (!pending || requestId !== pending.id) return false;
  endSend(); setStatus(''); showError(message);
  return true;
}

export function initSend(actions: { retry: () => void; updateToken: () => void }): void {
  element('send-retry').addEventListener('click', () => { if (!actionsBlocked()) actions.retry(); });
  element('send-token').addEventListener('click', actions.updateToken);
  element<HTMLFormElement>('file-form').addEventListener('submit', event => {
    event.preventDefault();
    clearError();
    if (!actionsBlocked()) setStatus('Linking file…');
    pendingFile = nextRequestId();
    post({ type: 'save-file-url', requestId: pendingFile, url: element<HTMLInputElement>('file-url').value });
  });
  placementPicker.addEventListener('change', () => updateCellPickers());
  sendButton.addEventListener('click', () => beginSend(false));
  syncButton.addEventListener('click', () => beginSend(true));
  matchRatioButton.addEventListener('click', () => {
    const gate = ratioGate();
    const node = state.selection.node;
    if (actionsBlocked() || !gate || !hasCurrentSelection() || !node) return;
    clearError();
    pendingMatch = nextRequestId();
    // Main keeps the width, sets the height to the placement's ratio, and reports the new size.
    post({ type: 'match-ratio', requestId: pendingMatch, nodeId: node.id, width: gate.placement.width, height: gate.placement.height });
  });
}
