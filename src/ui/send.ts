// The Send tab: the selection, the placement and cell pickers, the ratio gate, Send, and the file link; and Sync, which
// the Sync bar (syncbar.ts) shows on both tabs from what `syncBar()` says about the selection.
import {
  MAX_EXPORT_EDGE, appearanceLabel, aspectMismatch, cellOptions, chooseExportSettings, environmentLabel, matchedHeight,
  parseFileLink, ratioLabel, ratioName, sameCoordinate, sizeLabel, validUuid, validateBinding,
} from '../shared/index.js';
import type { Appearance, CellBinding, CellCoordinate, EnvironmentName, InsertLink, PairingHint, Placement } from '../shared/index.js';
import type { MainMessage, RememberedTarget } from '../shared/protocol.js';
import { announceError, clearError, element, flushRender, inField, post, scheduleRender, setStatus, setUnavailable, showError } from './dom.js';
import { actionsBlocked, hasCurrentSelection, nextRequestId, readProblem, state } from './state.js';
import type { ReadProblem } from './state.js';
import { activeSendRow, initQueue, queueChoice, queueError, queueExport, queueRemembered, queueSelection, renderQueue,
  resetQueue, saveQueueChoices, sendRows, sendSelection } from './send-queue.js';
export { choiceSaved } from './send-queue.js';

const placementPicker = element<HTMLSelectElement>('placement');
const placementSearch = element<HTMLInputElement>('placement-search');
const statePicker = element<HTMLSelectElement>('state');
const appearancePicker = element<HTMLSelectElement>('appearance');
const armPicker = element<HTMLSelectElement>('arm');
const sendButton = element<HTMLButtonElement>('send');
const matchRatioButton = element<HTMLButtonElement>('match-ratio');
const sendProblem = element('send-problem');
const fileUrl = element<HTMLInputElement>('file-url');
const CHOOSE_PLACEMENT = 'Choose placement…';
export const VIEW_ONLY = 'This file is view-only, so the link lasts until you close the plugin.';

let pendingMatch: number | null = null;
let pendingFile: { id: number; url: string } | null = null;
let fileAsked = false;
let mismatch: { url: string; slug: string; name: string } | null = null;
let showSend: () => void = () => {};
let draftArtState: (key: string, cell: CellCoordinate) => 'own' | 'inherits' | 'empty' | null = () => null;
let pickerGeneration: number | null = null;
let pickerNode: string | null = null;
let fileTimer: number | null = null;
let lastSavedFileUrl = '';

export function clearRememberedSelection(): void {
  state.selection = { ...state.selection, remembered: null };
  state.selectionGeneration = null;
  resetQueue();
  pickerNode = null;
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
/** An empty placement picker does not ask to move the layer's link. */
export function sendHidden(): boolean { return false; }
export function sendOtherCell(): boolean { return state.prefs.tab === 'send'; }
export function announceSyncTarget(): void {}
export function otherDeclaredCell(placement: Placement | undefined, cell: Pick<CellBinding, 'state' | 'appearance' | 'arm'>): Pick<CellBinding, 'state' | 'appearance' | 'arm'> | null {
  if (!placement) return null;
  const options = cellOptions(placement);
  for (const state of options.states) for (const appearance of options.appearances) for (const arm of options.arms) {
    if (!sameCoordinate(placement, { state, appearance, arm }, cell)) return { state, appearance, arm };
  }
  return null;
}
function setOptions(picker: HTMLSelectElement, values: (string | null)[]): void {
  picker.replaceChildren(...values.map(value => new Option('', value ?? '')));
}
function updateCellPickers(bind?: CellBinding): void {
  const placement = chosenPlacement();
  const options = placement ? cellOptions(placement) : { states: [null], appearances: [null], arms: [null] };
  setOptions(statePicker, options.states);
  setOptions(appearancePicker, options.appearances);
  setOptions(armPicker, options.arms);
  if (bind) {
    statePicker.value = bind.state ?? '';
    appearancePicker.value = bind.appearance ?? '';
    armPicker.value = bind.arm ?? '';
  }
  element('state-label').hidden = options.states.length <= 1;
  element('appearance-label').hidden = options.appearances.length <= 1;
  element('arm-label').hidden = options.arms.length <= 1;
  labelCellPickers();
  scheduleRender();
}
/** Each option describes the Draft cell it would choose with the other two pickers kept as they are. */
function labelCellPickers(): void {
  const placement = chosenPlacement();
  if (!placement) return;
  const cell: CellCoordinate = { state: statePicker.value || null, appearance: (appearancePicker.value || null) as Appearance | null, arm: armPicker.value || null };
  for (const [axis, picker] of [['state', statePicker], ['appearance', appearancePicker], ['arm', armPicker]] as const) {
    for (const option of Array.from(picker.options)) {
      const value = option.value || null;
      const art = draftArtState(placement.key, { ...cell, [axis]: value });
      const label = axis === 'state' ? value ?? (placement.defaultState ? `Default (${placement.defaultState})` : 'Default')
        : axis === 'appearance' ? appearanceLabel(value as Appearance | null) : value ?? 'Control';
      option.textContent = label + (art === 'empty' ? ' (not set)' : art === 'inherits' ? ' (inherits)' : '');
    }
  }
}

/** The current Send destination, for the preview owned by Insert's artwork and thumbnail modules. */
export function sendChoice(): { placementKey: string; cell: CellCoordinate } | null {
  const placement = chosenPlacement();
  if (!placement) return null;
  try {
    return { placementKey: placement.key, cell: chosenBinding(placement) };
  } catch { return null; }
}
function selectRemembered(): void {
  const target = activeSendRow()?.target;
  placementPicker.value = target?.slotKey ?? '';
  updateCellPickers(target ?? undefined);
}
function selectRow(): void {
  if (!state.placementsLoaded) return;
  const node = activeSendRow()?.node.id ?? null;
  if (node !== pickerNode) placementSearch.value = '';
  pickerNode = node;
  buildPlacementOptions();
  selectRemembered();
}
function savePicker(): void {
  const placement = chosenPlacement();
  try { queueChoice(placement ? chosenBinding(placement) : null); } catch { queueChoice(null); }
}
/** The connection test's placements, for the Send picker. Nothing is chosen until the person or a remembered target chooses. */
export function showPlacements(list: Placement[]): void {
  state.placements = list;
  state.placementsLoaded = true;
  const chosen = pickerGeneration === state.connectionGeneration ? placementPicker.value : '';
  if (pickerGeneration !== state.connectionGeneration) placementSearch.value = '';
  pickerGeneration = state.connectionGeneration;
  buildPlacementOptions();
  // A placement chosen before the list reloaded on this connection stays chosen while it exists.
  if (list.some(item => item.key === chosen)) placementPicker.value = chosen;
  updateCellPickers();
  selectRemembered();
}
function buildPlacementOptions(): void {
  const chosen = placementPicker.value;
  const query = placementSearch.value.trim().toLowerCase();
  let matches = 0;
  const groups = new Map<string, HTMLOptGroupElement>();
  const fits = document.createElement('optgroup');
  fits.label = 'Fits this layer';
  const row = activeSendRow();
  const node = hasCurrentSelection() && !row?.reason ? row?.node : null;
  for (const item of state.placements) {
    const matchesQuery = !query || `${item.key} ${item.screen}`.toLowerCase().includes(query);
    if (!matchesQuery && item.key !== chosen) continue;
    if (matchesQuery) matches++;
    let group = groups.get(item.screen);
    if (!group) { group = document.createElement('optgroup'); group.label = item.screen; groups.set(item.screen, group); }
    // The ratio is what a frame must match; the reference size is secondary detail, on hover.
    const option = new Option(`${item.key} · ${ratioName(item.width, item.height)}`, item.key);
    option.title = `${item.key} · reference ${item.width} × ${item.height}`;
    (node && !aspectMismatch(node, item) ? fits : group).append(option);
    if (!matchesQuery) option.textContent += ' (current choice)';
  }
  placementPicker.replaceChildren(new Option(!state.placements.length ? 'No placements yet' : !matches ? 'No matching placements' : CHOOSE_PLACEMENT, ''),
    ...(fits.children.length ? [fits] : []), ...[...groups.values()].filter(group => group.children.length));
  if (state.placements.some(item => item.key === chosen)) placementPicker.value = chosen;
}
/** The visual picker shares the existing destination and cell-saving path. */
export function chooseSendPlacement(key: string): void {
  if (placementPicker.disabled || actionsBlocked() || !state.placements.some(item => item.key === key) || placementPicker.value === key) return;
  placementPicker.value = key;
  buildPlacementOptions(); updateCellPickers(); savePicker();
}
export function clearPlacementSearch(): void {
  placementSearch.value = ''; buildPlacementOptions(); scheduleRender();
}

/** No placements, with `text` in the picker saying why. */
export function clearPlacements(text: string): void {
  state.placements = [];
  placementSearch.value = '';
  placementPicker.replaceChildren(new Option(text, ''));
  updateCellPickers();
}

/** The largest PNG this layer may export, before its raster density or byte limit lowers it. */
function exportDescription(placement: Placement): string {
  const node = activeSendRow()?.node;
  if (!node) return '';
  const { constraint } = chooseExportSettings(node, placement);
  const width = constraint.type === 'WIDTH' ? constraint.value : Math.round((constraint.value * node.width) / node.height);
  const height = constraint.type === 'HEIGHT' ? constraint.value : Math.round((constraint.value * node.height) / node.width);
  return `Exports up to ${width} × ${height} PNG, ${3 * Math.max(node.width, node.height) > MAX_EXPORT_EDGE - 1 ? 'the largest size Assetlib keeps' : '3× this layer'}.`;
}
/** True when the selected node's ratio is more than 2% off this placement's, which blocks Send or Sync to it. */
function ratioBlocks(placement: Placement | undefined | null): placement is Placement {
  const { node, reason } = activeSendRow() ?? { node: null, reason: null };
  return Boolean(placement && node && !reason && aspectMismatch(node, placement));
}
/** Why the ratio blocks Send (the callout) or Sync (the bar, which also says what Match ratio makes of the layer). */
function ratioText(placement: Placement, forSend: boolean): string {
  const node = activeSendRow()!.node;
  let matched = '';
  let largeChange = false;
  try {
    const height = matchedHeight(node.width, placement);
    matched = ` Match ratio makes it ${sizeLabel({ width: node.width, height })}.`;
    largeChange = Math.abs(height - node.height) > node.height / 2;
  } catch { /* no size to name */ }
  if (forSend) return `This frame is ${sizeLabel(node)}. ${placement.key} needs ${ratioLabel(placement)} (${sizeLabel(placement)}).${matched}${largeChange ? ' Or choose a placement that fits.' : ''}`;
  return `This frame is ${sizeLabel(node)}; ${placement.key} is ${sizeLabel(placement)}.${matched}`;
}
/** The chosen placement when the layer's ratio is off from it: Send's callout says so, with Match ratio. */
export function sendRatioPlacement(): Placement | null {
  const chosen = chosenPlacement();
  return ratioBlocks(chosen) ? chosen : null;
}
/**
 * A connection, a current selection of one exportable node, and nothing else running. A missing file key doesn't wait:
 * Send or Sync asks for the file's link then (`askForFile`).
 */
export function bindingLabel(bind: CellBinding): string {
  const placement = state.placements.find(item => item.key === bind.slotKey);
  const parts = placement ? cellLabel(placement, bind)
    : [bind.state ?? 'default state', appearanceLabel(bind.appearance), bind.arm ?? 'Control'];
  return [bind.slotKey, ...parts].join(' · ');
}

/**
 * What the Sync bar says about the selected layer, or null to hide it: `linked` (a link or a target this device
 * remembered: Sync to draft, unless `ratio` is off), `removed` (that placement or cell is gone from the app), `copy` (a
 * Cmd+D copy of a linked layer), or `other` (linked to another console app).
 */
export type SyncBar =
  | { kind: 'linked'; key: string; meta: string; axes: string; environment: EnvironmentName; detail: string; placement: Placement | null; ratio: string | null; assetId: string | null;
    cell: Pick<CellBinding, 'state' | 'appearance' | 'arm'> }
  | { kind: 'removed'; key: string; cell: boolean }
  | { kind: 'copy'; key: string; link: InsertLink }
  // `hint`: that app on this console, by UUID, which Switch workspace offers first; null for another console's.
  | { kind: 'other'; hint: PairingHint | null };

/** The cell as the bar names it: the axes the placement declares, or, before the placements load, those the target sets. */
function cellLabel(placement: Placement | null, cell: Pick<RememberedTarget, 'state' | 'appearance' | 'arm'>): string[] {
  if (!placement) return [cell.state, cell.appearance ? appearanceLabel(cell.appearance) : null, cell.arm].filter((part): part is string => part !== null);
  const parts: string[] = [];
  if (placement.states?.length) parts.push(cell.state ?? placement.defaultState ?? 'default');
  if (placement.variants?.appearance?.length) parts.push(appearanceLabel(cell.appearance));
  if (placement.variants?.arm?.length) parts.push(cell.arm ?? 'Control');
  return parts;
}

export function syncBar(): SyncBar | null {
  if (!state.connection || !hasCurrentSelection()) return null;
  const { remembered, link } = state.selection;
  if (remembered) {
    const key = remembered.placementKey;
    const target = rememberedBinding();
    if (!target && state.placementsLoaded) {
      return { kind: 'removed', key, cell: state.placements.some(item => item.key === key) };
    }
    const placement = target?.placement ?? null;
    const sameCell = link?.kind === 'linked' && link.placementKey === key && sameCoordinate(placement ?? { defaultState: null }, link, remembered);
    const environment = sameCell ? link.environment : remembered.insertedFrom?.environment ?? 'draft';
    const meta = [...cellLabel(placement, remembered), remembered.insertedFrom ? `${environmentLabel(environment)} art` : 'sent to Draft'].join(' · ');
    const detail = target ? `${bindingLabel(target.bind)}. Send reviews this layer and updates only its selected draft destination.` : meta;
    // Open in console names the image the layer's own link names, when that link is to this cell.
    return { kind: 'linked', key, meta, axes: cellLabel(placement, remembered).join(' · '), environment, detail, placement, ratio: ratioBlocks(placement) ? ratioText(placement, false) : null,
      assetId: sameCell ? link.assetId : null, cell: { state: remembered.state, appearance: remembered.appearance, arm: remembered.arm } };
  }
  if (link?.kind === 'copy') return { kind: 'copy', key: link.placementKey, link };
  if (link?.kind === 'other') {
    const { origin, orgId, appId } = link;
    const hint = origin === state.connection.origin && validUuid(orgId) && validUuid(appId) ? { origin, orgId, appId } : null;
    return { kind: 'other', hint };
  }
  return null;
}
/** Sync can run now: the bar's button is available. */
export function syncAvailable(): boolean { return Boolean(rememberedBinding() && hasCurrentSelection() && !actionsBlocked()); }
export function beginSync(): void { showSend(); }

/** Match ratio for this placement: main keeps the width, sets the height to the placement's ratio, and reports the new size. */
export function matchRatio(placement: Placement): void {
  const node = state.selection.node;
  if (actionsBlocked() || !hasCurrentSelection() || !node) return;
  clearError();
  pendingMatch = nextRequestId();
  post({ type: 'match-ratio', requestId: pendingMatch, nodeId: node.id, width: placement.width, height: placement.height });
}

/** Choose the copy's destination, for a Send without rebind. */
export function prefillSend(link: Pick<InsertLink, 'placementKey' | 'state' | 'appearance' | 'arm'>, explicit = false): void {
  const placement = state.placements.find(item => item.key === link.placementKey);
  if (!placement) return;
  void explicit;
  placementSearch.value = ''; buildPlacementOptions();
  placementPicker.value = placement.key;
  let bind: CellBinding | undefined;
  try { bind = validateBinding(placement, { slotKey: placement.key, state: link.state, appearance: link.appearance, arm: link.arm }); } catch { bind = undefined; }
  updateCellPickers(bind);
  savePicker();
}
/** A removed target's Send elsewhere…: nothing chosen, so the person picks a placement. */
export function sendElsewhere(): void {
  placementPicker.value = '';
  updateCellPickers();
  savePicker();
}

/**
 * Why Send has no placements (the connection test failed), with Try again or Update token, unless the open connection
 * settings say it under the token field (`inSettings`). A retest keeps the notice until it has an answer.
 */
function sendProblemShown(inSettings: boolean): ReadProblem | null {
  return state.connection && state.testFailure && state.connectionGeneration !== null && !state.connectionChanging && !inSettings ? readProblem(state.testFailure, state.connection.method) : null;
}
let problemShown = false;

export function renderSend(inSettings: boolean): void {
  labelCellPickers();
  const problem = sendProblemShown(inSettings);
  problemShown = Boolean(problem);
  sendProblem.hidden = !problem;
  element('send-problem-text').textContent = problem?.text ?? '';
  element('send-retry').hidden = problem?.action !== 'retry';
  // A browser connection is made again (Connect again), never with a token.
  element('send-token').hidden = problem?.action !== 'token' && problem?.action !== 'reconnect';
  element('send-token').textContent = problem?.action === 'reconnect' ? 'Connect again' : 'Update token';
  setUnavailable(element('send-retry'), actionsBlocked());
  const { selection } = state;
  const row = activeSendRow();
  const node = row?.node;
  const reason = row?.reason ?? selection.reason;
  const count = sendRows().length;
  element('selection-name').textContent = selection.truncated ? 'Select up to 50 layers to send together.' : count > 1 ? `${count} layers selected` : node && !reason ? node.name : reason ?? node?.name ?? 'Select a frame or layer to send.';
  // Without a layer to send, the card is a dashed slot saying why, not a filled card that reads as an input.
  element('selection-card').className = node && !row?.reason ? 'selection-card' : 'selection-card empty';
  // Whole pixels, and no node ID or type: what a designer reads off the canvas.
  element('selection-meta').textContent = node && !row?.reason ? `${Math.round(node.width)} × ${Math.round(node.height)}` : '';
  // The file link, asked for at the first Send or Sync without a file key; once linked, the file it names, with Change.
  const file = hasCurrentSelection() ? selection.file : undefined;
  element('file-fallback').hidden = !fileAsked;
  element('file-mismatch-box').hidden = !mismatch;
  element('file-mismatch').textContent = !mismatch ? ''
    : mismatch.slug ? `This link is for “${mismatch.slug}”, but this file is “${mismatch.name}”. Paste this file’s link.`
      : `This link doesn’t name its file, so Assetlib can’t check that it’s “${mismatch.name}”. Paste this file’s link.`;
  if (mismatch) fileUrl.setAttribute('aria-invalid', 'true'); else fileUrl.removeAttribute('aria-invalid');
  setUnavailable(element('file-anyway'), pendingFile !== null);
  const linked = Boolean(selection.fileKey && (file?.source === 'document' || file?.source === 'session'));
  element('file-line').hidden = fileAsked || !linked;
  element('file-name').textContent = `File: ${file?.name || 'this file'}`;
  element('file-session').hidden = file?.source !== 'session';
  element('file-session').textContent = file?.source === 'session' ? VIEW_ONLY : '';
  placementPicker.disabled = state.placements.length === 0 || actionsBlocked() || !row;
  placementSearch.disabled = actionsBlocked() || !row;
  for (const picker of [statePicker, appearancePicker, armPicker]) picker.disabled = actionsBlocked();
  const placement = chosenPlacement();

  const validArea = node && !row?.reason;
  // The chosen placement's ratio; the Sync bar says Sync's, when it is another.
  const gate = sendRatioPlacement();
  // The export's size only when it can be sent: next to the ratio callout it would contradict it.
  element('export-note').textContent = placement && validArea && !gate ? exportDescription(placement) : '';
  element('aspect-text').textContent = gate ? ratioText(gate, true) : '';
  element('aspect-warning').hidden = !gate;
  matchRatioButton.hidden = sendRows().length > 1;
  setUnavailable(matchRatioButton, actionsBlocked());
  sendButton.className = state.testFailure || state.tokenRefused ? 'secondary' : 'primary';
  element('send-plain').hidden = true;
  element('send-relink').hidden = true;
  renderQueue();
  // A result says where the draft went; the footnote about drafts would repeat it.
  element('send-footnote').hidden = !element('result').hidden;
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
  queueSelection(message.selection);
  scheduleRender();
}

export function applyFileUrl(url: string): void { fileUrl.value = url; lastSavedFileUrl = url; pendingFile = null; mismatch = null; fileAsked = false; if (fileTimer) window.clearTimeout(fileTimer); }
function askForFile(): void {
  fileAsked = true;
  showSend(); scheduleRender(); flushRender(); fileUrl.focus();
  setStatus('Paste this file’s link once. Then choose Send to draft.');
}
export const sendExport = queueExport;
export const remembered = queueRemembered;

/** Linking saves setup only. Sending is always a separate, explicit action. */
export function fileSaved(message: Extract<MainMessage, { type: 'file-saved' }>): void {
  if (message.requestId !== pendingFile?.id) return;
  const savedUrl = pendingFile.url;
  pendingFile = null;
  lastSavedFileUrl = savedUrl;
  if (fileUrl.value.trim() !== savedUrl) return;
  fileAsked = false;
  mismatch = null;
  if (hasCurrentSelection()) state.selection = { ...state.selection, fileKey: message.fileKey };
  if (!actionsBlocked()) setStatus(message.session ? VIEW_ONLY : 'File linked. Ready to send.');
  const inForm = element('file-fallback').contains(document.activeElement);
  saveQueueChoices(); scheduleRender(); flushRender();
  if (inForm) sendButton.focus();
}

/** Main found that the link names another file: the form says so, and Use anyway saves it regardless. */
export function fileMismatch(message: Extract<MainMessage, { type: 'file-mismatch' }>): void {
  const pending = pendingFile;
  if (!pending || message.requestId !== pending.id) return;
  if (fileUrl.value.trim() !== pending.url) { pendingFile = null; return; }
  mismatch = { url: pending.url, slug: message.slug, name: message.name };
  pendingFile = null;
  if (!actionsBlocked()) setStatus('');
  scheduleRender();
  flushRender();
  announceError(element('file-mismatch').textContent ?? '');
}

function saveFileUrl(url: string, force: boolean): void {
  if (actionsBlocked()) return;
  clearError();
  if (!actionsBlocked()) setStatus('Linking file…');
  pendingFile = { id: nextRequestId(), url };
  post({ type: 'save-file-url', requestId: pendingFile.id, url, ...(force ? { force } : {}) });
  scheduleRender();
}

/** Main's error for a Send, Sync, Match ratio, or file link request; false when it belongs to another operation. */
export function failSend(requestId: number, message: string): boolean {
  if (requestId === pendingMatch) { pendingMatch = null; showError(message); return true; }
  if (requestId === pendingFile?.id) {
    pendingFile = null;
    if (!actionsBlocked()) setStatus('');
    showError(message);
    return true;
  }
  return queueError(requestId, message);
}

export function initSend(actions: { refused: (text?: string) => void; retry: () => void; updateToken: () => void; reconnect: () => void; showSend: () => void; artworkChanged: () => void;
  placementSearchChanged: () => void; draftArtState: typeof draftArtState; draftSnapshot: (key: string, cell: CellBinding) => { assetId: string | null } | null; reviewArtwork: (payload: unknown, generation: number, from: number, attention: number) => void; beginArtworkRead: () => number }): void {
  showSend = actions.showSend;
  draftArtState = actions.draftArtState;
  initQueue({ choose: selectRow, needFile: askForFile, setupReady: () => pendingFile === null && mismatch === null
    && (!fileAsked || Boolean(state.selection.fileKey && fileUrl.value.trim() === lastSavedFileUrl)), artworkChanged: actions.artworkChanged, refused: actions.refused, reconnect: actions.reconnect, reviewArtwork: actions.reviewArtwork, beginArtworkRead: actions.beginArtworkRead, snapshot: actions.draftSnapshot });
  element('send-retry').addEventListener('click', () => { if (!actionsBlocked()) actions.retry(); });
  element('send-token').addEventListener('click', () => {
    if (sendProblemShown(false)?.action === 'reconnect') actions.reconnect(); else actions.updateToken();
  });
  element<HTMLFormElement>('file-form').addEventListener('submit', event => {
    event.preventDefault();
    mismatch = null;
    saveFileUrl(fileUrl.value, false);
  });
  element('file-anyway').addEventListener('click', () => { if (mismatch && pendingFile === null) saveFileUrl(mismatch.url, true); });
  // An edited link is not the one the warning was about: Use anyway goes until it is linked again.
  fileUrl.addEventListener('input', () => {
    mismatch = null; fileUrl.removeAttribute('aria-invalid');
    if (fileTimer) window.clearTimeout(fileTimer);
    fileTimer = window.setTimeout(() => {
      fileTimer = null;
      const url = fileUrl.value.trim();
      if (!url || url === lastSavedFileUrl || pendingFile?.url === url || actionsBlocked()) return;
      try { parseFileLink(url); saveFileUrl(url, false); } catch { /* The user is still typing an incomplete link. */ }
    }, 350);
    scheduleRender();
  });
  // Change: paste this file's own link, as a duplicated file needs to (it keeps its original's until then).
  element('file-change').addEventListener('click', () => {
    fileAsked = true;
    scheduleRender();
    flushRender();
    fileUrl.focus();
  });
  element('file-link-prompt').addEventListener('click', () => {
    if (actionsBlocked()) return;
    // This action records inventory only, including when a previous Send was waiting for a link.
    fileAsked = true;
    showSend();
    scheduleRender(); flushRender(); fileUrl.focus();
    setStatus('Link this file to show its scanned layers in the console.');
  });
  placementSearch.addEventListener('input', () => { buildPlacementOptions(); actions.placementSearchChanged(); scheduleRender(); });
  placementPicker.addEventListener('change', () => { if (actionsBlocked()) return; buildPlacementOptions(); updateCellPickers(); savePicker(); });
  sendButton.addEventListener('click', () => { savePicker(); void sendSelection(); });
  element('send-plain').addEventListener('click', () => { void sendSelection(); });
  for (const picker of [statePicker, appearancePicker, armPicker]) picker.addEventListener('change', savePicker);
  matchRatioButton.addEventListener('click', () => { const placement = sendRatioPlacement(); if (placement) matchRatio(placement); });
}
