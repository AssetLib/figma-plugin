// The Send tab: the selection, the placement and cell pickers, the ratio gate, Send, and the file link; and Sync, which
// the Sync bar (syncbar.ts) shows on both tabs from what `syncBar()` says about the selection.
import {
  MAX_EXPORT_EDGE, EXPORT_FAILED, DRAFT_MAY_HAVE_ARRIVED, TOKEN_NO_LONGER_ACCEPTED, appearanceLabel, aspectMismatch, aspectRatioDifference, buildDraftBody, bytesToBase64, cellOptions, chooseExportSettings,
  consoleLink, environmentLabel, mapHttpError, mapNetworkError, mapTimeoutError, matchedHeight, parseDraftResponse, parsePngDimensions, ratioLabel, ratioName,
  reconnectText, refusalCode, sameCoordinate, sizeLabel, tokenRefused, validUuid, validateBinding,
} from '../shared/index.js';
import type { Appearance, CellBinding, CellCoordinate, Connection, DraftResult, EnvironmentName, InsertLink, PairingHint, Placement } from '../shared/index.js';
import { CONNECTION_REPLACED } from '../shared/protocol.js';
import type { MainMessage, RememberedTarget } from '../shared/protocol.js';
import {
  COMMAND, announceError, clearError, element, errorText, flushRender, inField, post, reloadConnection, scheduleRender, sentence, setBusy, setStatus, setUnavailable,
  showError, toast,
} from './dom.js';
import { send } from './http.js';
import { actionsBlocked, hasCurrentSelection, nextRequestId, readProblem, state } from './state.js';
import type { ReadProblem } from './state.js';

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

let pending: { id: number; connection: Connection; generation: number | null; placement: Placement; bind: CellBinding; rebind: boolean; plain: boolean; result: DraftResult | null } | null = null;
// The request id of the last Match ratio, so its error is shown.
let pendingMatch: number | null = null;
// The file link being saved: its request id and the link, for Use anyway.
let pendingFile: { id: number; url: string } | null = null;
// The file link form shows: a Send or Sync found no file key, or Change was chosen.
let fileAsked = false;
// The Send or Sync that asked for the file link, which runs once the file is linked if the layer is still selected.
let afterFile: { rebind: boolean; nodeId: string; plain: boolean; generation: number | null } | null = null;
// Main said the pasted link names another file; Use anyway saves it regardless.
let mismatch: { url: string; slug: string; name: string } | null = null;
// Leaves the Send tab in front (main.ts), for the file link a Sync from the Insert tab asks for.
let showSend: () => void = () => {};
// Connect again (connect.ts, through main.ts): a refused saved connection is approved again in the browser.
let reconnect: () => void = () => {};
let refused: () => void = () => {};
let artworkChanged: () => void = () => {};
let draftArtState: (key: string, cell: CellCoordinate) => 'own' | 'inherits' | 'empty' | null = () => null;
let selectionIdentity = '';
// The layer's size and why it can't be sent: Fits this layer follows them (a resize or Match ratio keeps the identity).
let selectionShape = '';
// Send here is an explicit upload even when that empty cell is the layer's current link.
let explicitSend = false;
// The connection generation the placement picker was filled for; a choice never carries over to another connection.
let pickerGeneration: number | null = null;

export function clearRememberedSelection(): void {
  state.selection = { ...state.selection, remembered: null };
  state.selectionGeneration = null;
  selectionIdentity = '';
  explicitSend = false;
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
function pickedDiffers(): boolean {
  const remembered = rememberedBinding();
  const placement = chosenPlacement();
  if (!remembered || !placementPicker.value) return false;
  try { return !placement || !sameCell(chosenBinding(placement), remembered.bind); } catch { return true; }
}
export function sendHidden(): boolean { return !explicitSend && rememberedBinding() !== null && !pickedDiffers(); }
export function sendOtherCell(): boolean { return state.prefs.tab === 'send' && (explicitSend || pickedDiffers()); }
export function announceSyncTarget(): void {
  const remembered = rememberedBinding();
  const placement = chosenPlacement();
  if (!actionsBlocked() && remembered && placement) {
    try { setStatus(`${COMMAND}+Enter syncs ${bindingLabel(remembered.bind)}. Choose Send to draft to send to ${bindingLabel(chosenBinding(placement))}.`); } catch { /* invalid picker */ }
  }
}
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
  const target = rememberedBinding();
  if (target) { placementPicker.value = target.placement.key; updateCellPickers(target.bind); }
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
  const node = hasCurrentSelection() && !state.selection.reason ? state.selection.node : null;
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
/** No placements, with `text` in the picker saying why. */
export function clearPlacements(text: string): void {
  state.placements = [];
  placementSearch.value = '';
  placementPicker.replaceChildren(new Option(text, ''));
  updateCellPickers();
}

/** The largest PNG this layer may export, before its raster density or byte limit lowers it. */
function exportDescription(placement: Placement): string {
  const node = state.selection.node;
  if (!node) return '';
  const { constraint } = chooseExportSettings(node, placement);
  const width = constraint.type === 'WIDTH' ? constraint.value : Math.round((constraint.value * node.width) / node.height);
  const height = constraint.type === 'HEIGHT' ? constraint.value : Math.round((constraint.value * node.height) / node.width);
  return `Exports up to ${width} × ${height} PNG, ${3 * Math.max(node.width, node.height) > MAX_EXPORT_EDGE - 1 ? 'the largest size Assetlib keeps' : '3× this layer'}.`;
}
/** True when the selected node's ratio is more than 2% off this placement's, which blocks Send or Sync to it. */
function ratioBlocks(placement: Placement | undefined | null): placement is Placement {
  const { node, reason } = state.selection;
  return Boolean(placement && node && !reason && aspectMismatch(node, placement));
}
/** Why the ratio blocks Send (the callout) or Sync (the bar, which also says what Match ratio makes of the layer). */
function ratioText(placement: Placement, forSend: boolean): string {
  const node = state.selection.node!;
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
function sendReady(): boolean {
  const { node, reason } = state.selection;
  return Boolean(state.connection && hasCurrentSelection() && node && !reason && !actionsBlocked());
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
/** A cell as people read it: its placement and the axes the placement declares (all of them while its declaration is unknown). */
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
    const detail = target ? `${bindingLabel(target.bind)}. Sync sends this layer to that cell in Draft and replaces draft references to its earlier sends.` : meta;
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
export function syncAvailable(): boolean { return actionPlacement(true) !== null; }
export function beginSync(): void { beginSend(true); }

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
  explicitSend = explicit;
  placementSearch.value = ''; buildPlacementOptions();
  placementPicker.value = placement.key;
  let bind: CellBinding | undefined;
  try { bind = validateBinding(placement, { slotKey: placement.key, state: link.state, appearance: link.appearance, arm: link.arm }); } catch { bind = undefined; }
  updateCellPickers(bind);
}
/** A removed target's Send elsewhere…: nothing chosen, so the person picks a placement. */
export function sendElsewhere(): void {
  explicitSend = false;
  placementPicker.value = '';
  updateCellPickers();
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
  const node = selection.node;
  element('selection-name').textContent = node && !selection.reason ? node.name : selection.reason ?? node?.name ?? 'Select a frame or layer to send.';
  // Without a layer to send, the card is a dashed slot saying why, not a filled card that reads as an input.
  element('selection-card').className = node && !selection.reason ? 'selection-card' : 'selection-card empty';
  // Whole pixels, and no node ID or type: what a designer reads off the canvas.
  element('selection-meta').textContent = node && !selection.reason ? `${Math.round(node.width)} × ${Math.round(node.height)}` : '';
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
  placementPicker.disabled = state.placements.length === 0;
  const placement = chosenPlacement();
  setUnavailable(sendButton, !actionPlacement(false));
  const validArea = node && !selection.reason;
  // The chosen placement's ratio; the Sync bar says Sync's, when it is another.
  const gate = sendRatioPlacement();
  // The export's size only when it can be sent: next to the ratio callout it would contradict it.
  element('export-note').textContent = placement && validArea && !gate ? exportDescription(placement) : '';
  element('aspect-text').textContent = gate ? ratioText(gate, true) : '';
  element('aspect-warning').hidden = !gate;
  setUnavailable(matchRatioButton, actionsBlocked());
  // A usable link or remembered target makes the Sync bar's Sync the expected action.
  sendButton.className = sendHidden() || state.testFailure !== null || state.tokenRefused ? 'secondary' : 'primary';
  const plain = element('send-plain');
  const plainBusy = state.ops.sending && pending?.plain === true;
  plain.hidden = !sendHidden() && !plainBusy;
  setUnavailable(plain, !plainBusy && !actionPlacement(false));
  let pickedLabel = '';
  try { if (placement) pickedLabel = bindingLabel(chosenBinding(placement)); } catch { /* a stale picker has no valid cell to name */ }
  plain.title = pickedLabel ? `Uploads this layer to ${pickedLabel}’s draft without replacing your earlier sends in other cells.` : '';
  const relink = element('send-relink');
  relink.hidden = !pickedDiffers() || Boolean(gate) || !pickedLabel;
  relink.textContent = !relink.hidden ? `Sends this layer to the draft of ${pickedLabel} and links it there. Until then it stays linked to ${bindingLabel(rememberedBinding()!.bind)}.` : '';
  const sending = state.ops.sending && !plainBusy;
  setBusy(sendButton, sending ? 'Sending…' : 'Send to draft', sending);
  setBusy(plain, plainBusy ? 'Sending…' : 'Send as a new image instead', plainBusy);
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
  const { selection } = state;
  const identity = JSON.stringify([selection.fileKey, selection.node?.id, selection.remembered]);
  const shape = JSON.stringify([selection.node?.width, selection.node?.height, selection.reason]);
  if (identity !== selectionIdentity) { selectionIdentity = identity; selectionShape = shape; explicitSend = false; placementSearch.value = ''; if (state.placementsLoaded) buildPlacementOptions(); selectRemembered(); }
  else if (shape !== selectionShape) { selectionShape = shape; if (state.placementsLoaded) buildPlacementOptions(); }
  scheduleRender();
}

export function applyFileUrl(url: string): void { element<HTMLInputElement>('file-url').value = url; }

const sameCell = (a: CellBinding, b: CellBinding) => a.slotKey === b.slotKey
  && sameCoordinate(state.placements.find(item => item.key === a.slotKey) ?? { defaultState: null }, a, b);
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
  text.textContent = summary;
  if (done) parts.push(text, link('View in console', consoleLink(config, 'releases')));
  else {
    // The problem and where to check it, in one callout.
    const notice = document.createElement('div');
    notice.className = 'notice';
    notice.append(text, link('Open image in console', imageLink(config, result.asset.id)));
    parts.push(notice);
  }
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
  explicitSend = false;
  state.ops.sending = false;
  state.ops.syncing = false;
  scheduleRender();
}

/**
 * No file key yet: the Send tab asks for the file's link, once per document, and the Send or Sync runs when it is linked.
 * Figma gives only private and development plugins the file key, so a Community plugin asks here.
 */
function askForFile(rebind: boolean, nodeId: string, plain: boolean): void {
  fileAsked = true;
  afterFile = { rebind, nodeId, plain, generation: state.connectionGeneration };
  showSend();
  scheduleRender();
  flushRender();
  fileUrl.focus();
  setStatus('Link this file once so Assetlib can trace art back to it.');
}

function beginSend(rebind: boolean, plain = false): void {
  const { node, fileKey } = state.selection;
  // An unavailable button (aria-disabled keeps it clickable) does nothing; its look and the ratio callout say why.
  const placement = actionPlacement(rebind);
  if (!placement || !state.connection || !node) return;
  if (!fileKey) { askForFile(rebind, node.id, plain); return; }
  clearError();
  try {
    const remembered = rebind ? rememberedBinding() : null;
    const bind = remembered?.bind ?? chosenBinding(placement);
    pending = { id: nextRequestId(), connection: { ...state.connection }, generation: state.connectionGeneration, placement, bind, rebind, plain, result: null };
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
    if (Math.max(dimensions.width, dimensions.height) > MAX_EXPORT_EDGE) throw new Error(EXPORT_FAILED);
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
    if (operation.connection.method === 'browser' && result.kind === 'http' && tokenRefused(result.status, result.payload)) {
      // The console refused the token, so the draft wasn't saved: the browser connection is made again, unless another
      // plugin window replaced it on this device, which this window uses now.
      const replaced = await reloadConnection(operation.generation);
      if (pending !== operation) return;
      endSend(); setStatus('');
      if (replaced) showError(CONNECTION_REPLACED);
      else showError(reconnectText(refusalCode(result.payload)), { label: 'Connect again', run: reconnect });
      return;
    }
    if (result.kind === 'http' && tokenRefused(result.status, result.payload) && operation.connection.method !== 'browser') {
      endSend(); setStatus(''); refused();
      showError(TOKEN_NO_LONGER_ACCEPTED, { label: 'Connect again', run: reconnect }); return;
    }
    if (result.status !== 201 && result.status !== 409) throw new Error(mapHttpError(result.status, result.payload));
    let draft: DraftResult;
    try { draft = parseDraftResponse(result.payload); }
    catch {
      if (result.status === 409) throw new Error(mapHttpError(409, result.payload));
      throw new Error('Assetlib accepted the image but sent an answer the plugin can’t read. Check the console before sending again.');
    }
    operation.result = draft;
    setStatus(showResult(draft, operation.connection, operation.bind));
    // The layer's link names the image the draft now shows in its cell, when the draft was put there.
    post({ type: 'remember', requestId: operation.id, assetId: draft.bound && !draft.bindError ? draft.asset.id : null });
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
  artworkChanged();
  const key = draft.bound.slotKey;
  toast(operation.rebind ? `Synced ${key} to draft` : `Sent to ${key} draft`, { text: 'Review', url: consoleLink(operation.connection, 'releases') });
}

/** Main saved the file link (in the document, or for this session): the Send or Sync that asked for it runs now. */
export function fileSaved(message: Extract<MainMessage, { type: 'file-saved' }>): void {
  if (message.requestId !== pendingFile?.id) return;
  pendingFile = null;
  fileAsked = false;
  mismatch = null;
  const next = afterFile;
  afterFile = null;
  // Main reports the selection with it next; the key is known now, so the waiting action needn't wait for that.
  if (hasCurrentSelection()) state.selection = { ...state.selection, fileKey: message.fileKey };
  // A running operation keeps the status line.
  if (!actionsBlocked()) setStatus(message.session ? VIEW_ONLY : 'File linked.');
  const inForm = element('file-fallback').contains(document.activeElement);
  scheduleRender();
  flushRender();
  // The form is gone: focus goes back to the action that asked for it, or to the file line.
  if (inForm) element(next ? (next.rebind ? 'sync' : sendHidden() ? 'send-plain' : 'send') : 'file-change').focus();
  if (next && next.generation === state.connectionGeneration && state.selection.node?.id === next.nodeId) beginSend(next.rebind, next.plain);
}

/** Main found that the link names another file: the form says so, and Use anyway saves it regardless. */
export function fileMismatch(message: Extract<MainMessage, { type: 'file-mismatch' }>): void {
  const pending = pendingFile;
  if (!pending || message.requestId !== pending.id) return;
  mismatch = { url: pending.url, slug: message.slug, name: message.name };
  pendingFile = null;
  if (!actionsBlocked()) setStatus('');
  scheduleRender();
  flushRender();
  announceError(element('file-mismatch').textContent ?? '');
}

function saveFileUrl(url: string, force: boolean): void {
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
  if (!pending || requestId !== pending.id) return false;
  endSend(); setStatus(''); showError(message);
  return true;
}

export function initSend(actions: { refused: () => void; retry: () => void; updateToken: () => void; reconnect: () => void; showSend: () => void; artworkChanged: () => void;
  draftArtState: typeof draftArtState }): void {
  showSend = actions.showSend;
  reconnect = actions.reconnect;
  refused = actions.refused;
  artworkChanged = actions.artworkChanged;
  draftArtState = actions.draftArtState;
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
  fileUrl.addEventListener('input', () => { if (mismatch) { mismatch = null; fileUrl.removeAttribute('aria-invalid'); scheduleRender(); } });
  // Change: paste this file's own link, as a duplicated file needs to (it keeps its original's until then).
  element('file-change').addEventListener('click', () => {
    fileAsked = true;
    afterFile = null;
    scheduleRender();
    flushRender();
    fileUrl.focus();
  });
  element('file-link-prompt').addEventListener('click', () => {
    if (actionsBlocked()) return;
    // This action records inventory only, including when a previous Send was waiting for a link.
    afterFile = null;
    fileAsked = true;
    showSend();
    scheduleRender(); flushRender(); fileUrl.focus();
    setStatus('Link this file to show its scanned layers in the console.');
  });
  placementSearch.addEventListener('input', () => { buildPlacementOptions(); scheduleRender(); });
  placementPicker.addEventListener('change', () => { explicitSend = false; buildPlacementOptions(); updateCellPickers(); });
  sendButton.addEventListener('click', () => beginSend(false));
  element('send-plain').addEventListener('click', () => beginSend(false, true));
  for (const picker of [statePicker, appearancePicker, armPicker]) picker.addEventListener('change', () => { explicitSend = false; scheduleRender(); });
  matchRatioButton.addEventListener('click', () => { const placement = sendRatioPlacement(); if (placement) matchRatio(placement); });
}
