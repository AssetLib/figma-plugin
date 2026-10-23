// The reviewed selection is sent sequentially. Each row keeps its own receipt; uncertain writes are never retried.
import { aspectMismatch, aspectRatioDifference, buildDraftBody, bytesToBase64, consoleLink, consoleReviewLink, findCell, mapHttpError,
  mapNetworkError, mapTimeoutError, parseArtwork, parseDraftResponse, parsePngDimensions, sameCoordinate,
  validateBinding, MAX_EXPORT_EDGE, EXPORT_FAILED, DRAFT_MAY_HAVE_ARRIVED, TOKEN_NO_LONGER_ACCEPTED, reconnectText, refusalCode, tokenRefused, validUuid } from '../shared/index.js';
import type { CellBinding, Connection, DraftResult, Placement } from '../shared/index.js';
import { CONNECTION_REPLACED } from '../shared/protocol.js';
import type { MainMessage, SelectionState, SendNode } from '../shared/protocol.js';
import { clearError, element, errorText, post, reloadConnection, scheduleRender, setStatus, setUnavailable, showError, toast } from './dom.js';
import { send } from './http.js';
import { actionsBlocked, hasCurrentSelection, nextRequestId, state } from './state.js';

type Status = 'ready' | 'sending' | 'sent' | 'failed' | 'unknown' | 'partial' | 'conflict';
export type SendRow = SendNode & { target: CellBinding | null; included: boolean; status: Status; detail: string;
  receipt?: CellBinding; expected?: string | null; review?: string | null; reviewing?: boolean; assetId?: string; saving?: number; saveError?: string };
type Run = { rows: SendRow[]; connection: Connection; generation: number; fileKey: string; selectionIds: string[]; stopped: boolean; index: number };
type Operation = { id: number; run: Run; row: SendRow; placement: Placement; bind: CellBinding; uploaded: boolean; result?: DraftResult };
let rows: SendRow[] = [];
let activeId: string | null = null;
let run: Run | null = null;
let pending: Operation | null = null;
let selectionKey = '';
let latest: SelectionState | null = null;
let generation: number | null = null;
let choose: () => void = () => {};
let needFile: () => void = () => {};
let setupReady: () => boolean = () => true;
let artworkChanged: () => void = () => {};
let refused: (text?: string) => void = () => {};
let reconnect: () => void = () => {};
let beginArtworkRead: () => number = () => 0;
let reviewArtwork: (payload: unknown, generation: number, from: number, attention: number) => void = () => {};
let snapshot: (key: string, cell: CellBinding) => { assetId: string | null } | null = () => null;

export function initQueue(actions: { choose: () => void; needFile: () => void; setupReady: () => boolean; artworkChanged: () => void; refused: (text?: string) => void; reconnect: () => void; reviewArtwork: typeof reviewArtwork; beginArtworkRead: () => number; snapshot: typeof snapshot }): void {
  ({ choose, needFile, setupReady, artworkChanged, refused, reconnect, reviewArtwork, beginArtworkRead, snapshot } = actions);
  element('send-next-issue').addEventListener('click', () => {
    if (actionsBlocked()) return;
    const start = rows.findIndex(row => row.node.id === activeId);
    const next = [...rows.slice(start + 1), ...rows.slice(0, start + 1)].find(needsAttention);
    if (!next) return;
    activeId = next.node.id; choose(); scheduleRender();
    const view = rowElements.get(next.node.id);
    view?.name.focus(); view?.root.scrollIntoView({ block: 'nearest' });
    setStatus(`${next.node.name}: ${problem(next) ?? next.saveError ?? next.detail}`);
  });
}
export function activeSendRow(): SendRow | null { return rows.find(row => row.node.id === activeId) ?? rows[0] ?? null; }
export function sendRows(): readonly SendRow[] { return rows; }
function keyOf(selection: SelectionState): string {
  return JSON.stringify([selection.fileKey, [...(selection.selectionIds ?? (selection.node ? [selection.node.id] : []))].sort()]);
}
function targetOf(item: SendNode): CellBinding | null {
  const target = item.choice ?? item.remembered;
  return target ? { slotKey: target.placementKey, state: target.state, appearance: target.appearance, arm: target.arm } : null;
}
function sameTarget(a: CellBinding | null, b: CellBinding | null): boolean {
  return Boolean(a && b && a.slotKey === b.slotKey && sameCoordinate(state.placements.find(p => p.key === a.slotKey) ?? { defaultState: null }, a, b));
}
function seedExpected(row: SendRow): void {
  if (!row.target || row.expected !== undefined) return;
  const link = row.link;
  if (link?.kind === 'linked' && link.environment === 'draft' && sameTarget(row.target, { slotKey: link.placementKey, ...link })) row.expected = link.assetId;
  else {
    const current = snapshot(row.target.slotKey, row.target);
    if (current) row.expected = current.assetId;
  }
}
function selectionRows(selection: SelectionState): SendNode[] {
  return selection.sendNodes ?? (selection.node ? [{ node: selection.node, reason: selection.reason, remembered: selection.remembered, link: selection.link ?? null, choice: selection.choice }] : []);
}
export function queueSelection(selection: SelectionState): void {
  const nextKey = keyOf(selection);
  if (generation !== state.connectionGeneration) resetQueue();
  generation = state.connectionGeneration;
  latest = selection;
  if (run && nextKey !== selectionKey) {
    run.stopped = true;
    for (const row of run.rows.slice(run.index)) { row.status = 'failed'; row.detail = 'Not sent. The selection changed.'; }
    return;
  }
  const same = nextKey === selectionKey || (selectionKey === JSON.stringify([null, [...(selection.selectionIds ?? (selection.node ? [selection.node.id] : []))].sort()]));
  const previous = new Map(rows.map(row => [row.node.id, row]));
  rows = selectionRows(selection).map(item => {
    const old = same ? previous.get(item.node.id) : undefined;
    if (old) {
      // Receipts describe the last operation. Figma cannot report every nested artwork edit.
      const nextTarget = targetOf(item);
      if (!run && old.saving === undefined && !sameTarget(targetOf(old), nextTarget) && (targetOf(old) || nextTarget)) {
        old.target = nextTarget; old.expected = undefined; old.review = undefined; old.status = 'ready'; old.detail = ''; old.assetId = undefined;
      }
      Object.assign(old, item);
      return old;
    }
    const row: SendRow = { ...item, target: targetOf(item), included: true, status: 'ready', detail: '' };
    seedExpected(row);
    return row;
  });
  selectionKey = nextKey;
  if (!rows.some(row => row.node.id === activeId)) activeId = rows[0]?.node.id ?? null;
  choose();
}
export function resetQueue(): void {
  if (run) run.stopped = true;
  pending = null; run = null; rows = []; activeId = null; selectionKey = ''; latest = null; generation = null;
  rowElements.clear(); state.ops.sending = false; state.ops.syncing = false;
}
function saveChoice(row: SendRow): void {
  if (!row.target || !state.selection.fileKey || state.connectionGeneration === null || !hasCurrentSelection()) return;
  const requestId = nextRequestId();
  row.saving = requestId; row.saveError = undefined;
  post({ type: 'save-send-choice', requestId, connectionGeneration: state.connectionGeneration, fileKey: state.selection.fileKey,
    nodeId: row.node.id, placementKey: row.target.slotKey, state: row.target.state, appearance: row.target.appearance, arm: row.target.arm });
}
export function queueChoice(target: CellBinding | null): void {
  const row = activeSendRow();
  if (!row || actionsBlocked()) return;
  if (!sameTarget(row.target, target)) {
    row.target = target; row.expected = undefined; row.review = undefined; row.status = 'ready'; row.detail = ''; row.assetId = undefined;
    seedExpected(row); saveChoice(row);
  }
  scheduleRender();
}
export function saveQueueChoices(): void { for (const row of rows) saveChoice(row); }
export function choiceSaved(message: Extract<MainMessage, { type: 'send-choice-saved' }>): void {
  for (const row of rows) if (row.saving === message.requestId) row.saving = undefined;
  scheduleRender();
}
function validTarget(row: SendRow): { placement: Placement; bind: CellBinding } | null {
  const placement = state.placements.find(item => item.key === row.target?.slotKey);
  if (!placement || !row.target) return null;
  try { return { placement, bind: validateBinding(placement, row.target) }; } catch { return null; }
}
function destination(row: SendRow): string {
  const t = row.target;
  return t ? [t.slotKey, t.state, t.appearance, t.arm].filter(Boolean).join(' · ') : 'Choose a destination';
}
function problem(row: SendRow): string | null {
  if (!row.included) return null;
  if (row.reason) return row.reason;
  const target = validTarget(row);
  if (!target) return row.target ? 'This destination is no longer available. Choose another.' : 'Choose a destination.';
  if (aspectMismatch(row.node, target.placement)) return 'The layer and destination need the same aspect ratio.';
  if (rows.some(other => other !== row && other.included && sameTarget(row.target, other.target))) return 'Another layer uses this destination. Choose a different cell or skip one.';
  return null;
}
function candidates(): SendRow[] {
  const included = rows.filter(row => row.included);
  return included.every(row => row.status === 'sent') ? included : included.filter(row => row.status === 'ready' || row.status === 'failed');
}
function needsAttention(row: SendRow): boolean {
  return row.included && Boolean(problem(row) || row.saveError || ['conflict', 'failed', 'partial', 'unknown'].includes(row.status));
}
export function queueAvailable(): boolean {
  return Boolean(state.connection && hasCurrentSelection() && setupReady() && !actionsBlocked() && !state.tokenRefused && !state.selection.truncated
    && !rows.some(row => row.included && (problem(row) || row.saving !== undefined)) && candidates().length);
}
const rowElements = new Map<string, { root: HTMLElement; name: HTMLButtonElement; meta: HTMLElement; status: HTMLElement; skip: HTMLButtonElement; retry: HTMLButtonElement; review: HTMLButtonElement; console: HTMLAnchorElement }>();
function button(text: string, click: () => void): HTMLButtonElement {
  const item = document.createElement('button'); item.type = 'button'; item.className = 'text-action'; item.textContent = text;
  item.addEventListener('click', click); return item;
}
async function recoverReviewConnection(config: Connection, generation: number, payload: unknown): Promise<void> {
  const replaced = config.method === 'browser' && await reloadConnection(generation);
  if (replaced) { showError(CONNECTION_REPLACED); return; }
  if (generation !== state.connectionGeneration) return;
  const message = config.method === 'browser' ? reconnectText(refusalCode(payload)) : TOKEN_NO_LONGER_ACCEPTED;
  refused(message); showError(message, { label: 'Connect again', run: reconnect });
}
async function retryReview(row: SendRow): Promise<void> {
  if (actionsBlocked() || row.reviewing || !row.target || !state.connection || state.connectionGeneration === null) return;
  const target = { ...row.target }, config = { ...state.connection }, generation = state.connectionGeneration;
  const from = beginArtworkRead(), attention = state.attentionCount;
  row.reviewing = true; row.detail = 'Checking the current draft…'; scheduleRender();
  try {
    const response = await send(config, { path: 'placements/artwork', retry: false });
    if (generation !== state.connectionGeneration || !rows.includes(row) || !sameTarget(target, row.target)) return;
    if (tokenRefused(response.status, response.payload)) {
      row.detail = 'Connect again to review the current draft.';
      await recoverReviewConnection(config, generation, response.payload); return;
    }
    if (response.kind !== 'ok') throw new Error('Couldn’t load the current draft. Try again to review it.');
    const artwork = parseArtwork(response.payload);
    reviewArtwork(response.payload, generation, from, attention);
    const placement = artwork.placements.find(item => item.key === target.slotKey);
    const cell = placement && findCell(placement, target);
    if (!cell) { row.status = 'failed'; row.detail = 'This destination is no longer available. Choose another.'; return; }
    row.review = cell.draft?.assetId ?? null; row.detail = 'Draft changed. Review before replacing it.';
  } catch (error) {
    if (generation === state.connectionGeneration && rows.includes(row)) row.detail = errorText(error);
  } finally {
    row.reviewing = false;
    if (generation === state.connectionGeneration && rows.includes(row)) { setStatus(row.detail); scheduleRender(); }
  }
}
export function renderQueue(): void {
  const list = element('send-items');
  list.hidden = !rows.length;
  const issues = rows.filter(needsAttention).length;
  element('send-attention-bar').hidden = rows.length < 2;
  element('send-attention').textContent = `Needs attention (${issues})`;
  element('send-next-issue').hidden = !issues;
  setUnavailable(element('send-next-issue'), actionsBlocked());
  for (const row of rows) {
    seedExpected(row);
    let view = rowElements.get(row.node.id);
    if (!view) {
      const root = document.createElement('div'); root.className = 'send-row'; root.setAttribute('role', 'listitem'); root.setAttribute('data-node-id', row.node.id);
      const header = document.createElement('div'); header.className = 'send-row-header';
      const get = () => rows.find(item => item.node.id === row.node.id);
      const select = () => { if (actionsBlocked()) return; activeId = row.node.id; choose(); scheduleRender(); };
      const name = button('', select); name.setAttribute('aria-label', `Choose destination for ${row.node.name}`);
      const meta = document.createElement('div'); meta.className = 'send-row-meta';
      const status = document.createElement('div'); status.className = 'send-row-status';
      const actions = document.createElement('div'); actions.className = 'send-row-actions';
      const skip = button('Skip', () => { const current = get(); if (!current || actionsBlocked()) return; current.included = !current.included; scheduleRender(); });
      const retry = button('Send again', () => { const current = get(); if (!current || actionsBlocked()) return; current.status = 'ready'; current.detail = ''; scheduleRender(); });
      const review = button('Review', select);
      const console = document.createElement('a'); console.textContent = 'View in console'; console.className = 'text-action'; console.target = '_blank'; console.rel = 'noopener noreferrer';
      header.append(name); actions.append(skip, retry, review, console); root.append(header, meta, status, actions);
      view = { root, name, meta, status, skip, retry, review, console }; rowElements.set(row.node.id, view);
    }
    view.root.setAttribute('data-state', row.included ? row.status : 'skipped');
    view.root.setAttribute('aria-current', String(activeId === row.node.id));
    view.name.textContent = row.node.name; view.name.setAttribute('aria-label', `Choose destination for ${row.node.name}`); view.name.setAttribute('aria-pressed', String(activeId === row.node.id));
    view.meta.textContent = `${Math.round(row.node.width)} × ${Math.round(row.node.height)} → ${destination(row)}`;
    view.status.textContent = !row.included ? 'Skipped' : problem(row) ?? ((row.saving ? 'Saving destination…' : row.saveError ?? row.detail) || 'Ready to send');
    view.skip.textContent = row.included ? 'Skip' : 'Include';
    view.retry.hidden = row.status !== 'sent' && row.status !== 'failed';
    view.retry.textContent = row.status === 'sent' ? 'Send again' : 'Retry';
    view.review.hidden = row.status !== 'conflict';
    view.console.hidden = !row.assetId && row.status !== 'unknown';
    if (state.connection) view.console.href = consoleLink(state.connection, row.assetId ? 'images' : 'releases', validUuid(row.assetId) ? row.assetId : undefined);
    for (const control of [view.name, view.skip, view.retry, view.review]) setUnavailable(control, actionsBlocked());
  }
  const nodes = rows.map(row => rowElements.get(row.node.id)!.root);
  if (nodes.length !== list.children.length || nodes.some((node, index) => list.children[index] !== node)) list.replaceChildren(...nodes);
  const row = activeSendRow();
  const review = element('send-review');
  review.hidden = !row?.included || row.status !== 'conflict';
  if (row?.status === 'conflict' && review.getAttribute('data-row') !== `${row.node.id}:${destination(row)}:${row.review}:${Boolean(row.reviewing)}`) {
    review.setAttribute('data-row', `${row.node.id}:${destination(row)}:${row.review}:${Boolean(row.reviewing)}`);
    const text = document.createElement('p'); text.textContent = 'Draft artwork changed since this layer’s last send or your review. Review the current draft shown here, then choose whether to replace it.';
    const reviewedAsset = row.review;
    const replace = button('Use this layer instead', () => {
      const current = activeSendRow();
      if (actionsBlocked() || !current || current.node.id !== row.node.id || current.status !== 'conflict'
        || current.review === undefined || current.review !== reviewedAsset) return;
      current.expected = current.review; current.status = 'ready'; current.detail = 'Replacement reviewed. Ready to send.'; current.review = undefined;
      scheduleRender();
    });
    setUnavailable(replace, reviewedAsset === undefined);
    const skip = button('Skip this layer', () => {
      const current = activeSendRow();
      if (!actionsBlocked() && current?.node.id === row.node.id) { current.included = false; scheduleRender(); }
    });
    const retry = button(row.reviewing ? 'Checking…' : 'Retry review', () => {
      const current = activeSendRow();
      if (current?.node.id === row.node.id) void retryReview(current);
    });
    retry.hidden = reviewedAsset !== undefined;
    setUnavailable(retry, Boolean(row.reviewing));
    review.replaceChildren(text, replace, retry, skip);
  }
  const ready = candidates().length;
  element('send').textContent = run ? `Sending ${Math.min(run.index, run.rows.length)} of ${run.rows.length}…` : ready > 1 ? `Send ${ready} layers to draft` : 'Send to draft';
  setUnavailable(element('send'), !queueAvailable());
  if (run) element('send').setAttribute('aria-busy', 'true'); else element('send').removeAttribute('aria-busy');
}
function finishRun(): void {
  const completed = run;
  if (!completed) return;
  pending = null; run = null; state.ops.sending = false;
  const sent = completed.rows.filter(row => row.status === 'sent').length;
  const message = `${sent} of ${completed.rows.length} layer${completed.rows.length === 1 ? '' : 's'} sent to draft.`;
  setStatus(message);
  const result = element('result'); const summary = document.createElement('p'); summary.textContent = `${message} Publish from the console when ready.`;
  const details = document.createElement('ul');
  for (const row of completed.rows) { const item = document.createElement('li'); item.textContent = `${row.node.name} → ${destination(row)}: ${row.detail || row.status}`; details.append(item); }
  const link = document.createElement('a'); link.className = 'text-action'; link.target = '_blank'; link.rel = 'noopener noreferrer'; link.href = consoleReviewLink(completed.connection, completed.rows.flatMap(row => row.status === 'sent' && row.receipt ? [{ key: row.receipt.slotKey, ...(row.receipt.state ? { state: row.receipt.state } : {}), ...(row.receipt.appearance ? { appearance: row.receipt.appearance } : {}), ...(row.receipt.arm ? { arm: row.receipt.arm } : {}) }] : [])); link.textContent = sent ? 'Review these drafts' : 'Open releases in console';
  result.replaceChildren(summary, details, link); result.hidden = false;
  if (sent) { artworkChanged(); toast(message, { text: 'Review', url: link.href }); }
  if (latest && keyOf(latest) !== selectionKey) queueSelection(latest);
  scheduleRender();
}
async function checkDrafts(current: Run): Promise<boolean> {
  const from = beginArtworkRead(), attention = state.attentionCount;
  const response = await send(current.connection, { path: 'placements/artwork', retry: false });
  if (run !== current || current.stopped) return false;
  if (tokenRefused(response.status, response.payload)) {
    current.stopped = true;
    const replaced = current.connection.method === 'browser' && await reloadConnection(current.generation);
    if (run !== current) { if (replaced) showError(CONNECTION_REPLACED); return false; }
    const message = current.connection.method === 'browser' ? reconnectText(refusalCode(response.payload)) : TOKEN_NO_LONGER_ACCEPTED;
    for (const row of current.rows) { row.status = 'failed'; row.detail = message; }
    finishRun(); refused(message); showError(message, { label: 'Connect again', run: reconnect });
    return false;
  }
  if (response.kind !== 'ok') throw new Error('Couldn’t check the current drafts. Try again before sending.');
  const artwork = parseArtwork(response.payload);
  reviewArtwork(response.payload, current.generation, from, attention);
  for (const row of current.rows) {
    const target = validTarget(row);
    const placement = artwork.placements.find(item => item.key === target?.bind.slotKey);
    const cell = placement && target ? findCell(placement, target.bind) : null;
    if (!cell) { row.status = 'failed'; row.detail = 'This destination is no longer available. Choose another.'; continue; }
    const observed = cell.draft?.assetId ?? null;
    if (row.expected !== undefined && row.expected !== observed) {
      row.status = 'conflict'; row.review = observed; row.detail = 'Draft changed. Review before replacing it.';
    } else row.expected = observed;
  }
  return true;
}
export async function sendSelection(): Promise<void> {
  if (!queueAvailable() || !state.connection || state.connectionGeneration === null) return;
  if (!state.selection.fileKey) { needFile(); return; }
  clearError();
  const current: Run = { rows: candidates(), connection: { ...state.connection }, generation: state.connectionGeneration, fileKey: state.selection.fileKey,
    selectionIds: [...(state.selection.selectionIds ?? rows.map(row => row.node.id))].sort(), stopped: false, index: 0 };
  run = current; state.ops.sending = true; element('result').hidden = true; setStatus('Checking current drafts…'); scheduleRender();
  try {
    if (await checkDrafts(current)) nextItem();
    else if (run === current) finishRun();
  } catch (error) {
    if (run !== current) return;
    for (const row of current.rows) { row.status = 'failed'; row.detail = errorText(error); }
    finishRun(); showError(errorText(error));
  }
}
function nextItem(): void {
  const current = run;
  if (!current) return;
  if (current.stopped || current.generation !== state.connectionGeneration || current.index >= current.rows.length) {
    for (const row of current.rows.slice(current.index)) { row.status = 'failed'; row.detail = 'Not sent. Review the selection and connection, then try again.'; }
    finishRun(); return;
  }
  const row = current.rows[current.index++]!;
  if (row.status === 'conflict' || (row.status === 'failed' && row.detail.startsWith('This destination'))) { nextItem(); return; }
  const target = validTarget(row);
  if (!target) { row.status = 'failed'; row.detail = 'Choose a valid destination.'; nextItem(); return; }
  pending = { id: nextRequestId(), run: current, row, ...target, uploaded: false };
  row.status = 'sending'; row.detail = 'Exporting…';
  post({ type: 'export', requestId: pending.id, node: row.node, fileKey: current.fileKey, placement: target.placement,
    bind: target.bind, rebind: false, connectionGeneration: current.generation, selectionIds: current.selectionIds });
  scheduleRender();
}
function complete(operation: Operation, status: Status, detail: string): void {
  operation.row.status = status; operation.row.detail = detail;
  if (pending !== operation) return;
  pending = null; scheduleRender(); nextItem();
}
export async function queueExport(message: Extract<MainMessage, { type: 'exported' }>): Promise<void> {
  const operation = pending;
  if (!operation || operation.id !== message.requestId) return;
  const { row, run: current } = operation;
  if (current.stopped || current.generation !== state.connectionGeneration) { complete(operation, 'failed', 'Not sent. The selection or connection changed.'); return; }
  try {
    const bytes = new Uint8Array(message.bytes);
    const dimensions = parsePngDimensions(bytes);
    if (Math.max(dimensions.width, dimensions.height) > MAX_EXPORT_EDGE) throw new Error(EXPORT_FAILED);
    if (aspectRatioDifference(dimensions, operation.placement) > 0.02) throw new Error('The exported image has a different aspect ratio. Nothing was sent.');
    const body = buildDraftBody({ node: message.node, fileKey: message.fileKey, placement: operation.placement, bind: operation.bind,
      bytesBase64: bytesToBase64(bytes), settings: message.settings, rebind: false, expectedAssetId: row.expected ?? null });
    row.detail = 'Sending…'; scheduleRender();
    operation.uploaded = true;
    const response = await send(current.connection, { path: 'drafts', method: 'POST', body: JSON.stringify(body) });
    if (pending !== operation) return;
    if (response.kind === 'timeout' || response.kind === 'network' || response.kind === 'aborted') {
      const reason = response.kind === 'timeout' ? mapTimeoutError(response.timeoutSeconds, 'send') : response.kind === 'network' ? mapNetworkError(current.connection.origin) : 'The connection changed.';
      complete(operation, 'unknown', `${reason} ${DRAFT_MAY_HAVE_ARRIVED}`); return;
    }
    const payload = response.payload as { code?: string } | null;
    if (response.status === 409 && payload?.code === 'draft_changed') {
      row.expected = undefined;
      // Fetch the replacement to review. Failure leaves no replacement action enabled.
      row.review = undefined;
      const from = beginArtworkRead(), attention = state.attentionCount;
      const fresh = await send(current.connection, { path: 'placements/artwork', retry: false });
      if (pending !== operation) return;
      if (tokenRefused(fresh.status, fresh.payload)) {
        current.stopped = true;
        complete(operation, 'conflict', 'Draft changed. Connect again to review it.');
        await recoverReviewConnection(current.connection, current.generation, fresh.payload); return;
      }
      if (fresh.kind === 'ok') {
        const art = parseArtwork(fresh.payload); reviewArtwork(fresh.payload, current.generation, from, attention); const placement = art.placements.find(item => item.key === operation.bind.slotKey);
        const cell = placement && findCell(placement, operation.bind); row.review = cell ? cell.draft?.assetId ?? null : undefined;
      }
      artworkChanged(); complete(operation, 'conflict', 'Draft changed. Nothing was uploaded. Review before replacing it.'); return;
    }
    if (tokenRefused(response.status, response.payload)) {
      current.stopped = true;
      if (current.connection.method === 'browser') {
        const replaced = await reloadConnection(current.generation);
        if (pending !== operation) return;
        complete(operation, 'failed', 'Not sent. Connect again to continue.');
        if (replaced) showError(CONNECTION_REPLACED);
        else { const message = reconnectText(refusalCode(response.payload)); refused(message); showError(message, { label: 'Connect again', run: reconnect }); }
      } else {
        complete(operation, 'failed', TOKEN_NO_LONGER_ACCEPTED); refused();
        showError(TOKEN_NO_LONGER_ACCEPTED, { label: 'Connect again', run: reconnect });
      }
      return;
    }
    if (response.status !== 201 && response.status !== 409) {
      complete(operation, response.status >= 500 ? 'unknown' : 'failed', mapHttpError(response.status, response.payload) + (response.status >= 500 ? ` ${DRAFT_MAY_HAVE_ARRIVED}` : '')); return;
    }
    let draft: DraftResult;
    try { draft = parseDraftResponse(response.payload); }
    catch { complete(operation, 'unknown', 'The console may have accepted this image. Check it before sending again.'); return; }
    operation.result = draft; row.assetId = draft.asset.id;
    if (!draft.bound || draft.bindError) {
      complete(operation, 'partial', `Uploaded but not assigned. ${draft.bindError ?? 'Check the image in the console before sending again.'}`); return;
    }
    row.receipt = { ...draft.bound };
    row.expected = draft.asset.id;
    post({ type: 'remember', requestId: operation.id, assetId: draft.asset.id });
  } catch (error) {
    if (pending === operation) complete(operation, operation.uploaded ? 'unknown' : 'failed', errorText(error));
  }
}
export function queueRemembered(message: Extract<MainMessage, { type: 'remembered' }>): void {
  if (pending?.id === message.requestId) complete(pending, 'sent', 'Sent to draft.');
}
export function queueError(requestId: number, message: string): boolean {
  for (const row of rows) if (row.saving === requestId) { row.saving = undefined; row.saveError = 'Destination couldn’t be saved on this device. It will still be used for this send.'; scheduleRender(); return true; }
  if (pending?.id !== requestId) return false;
  complete(pending, pending.result ? 'sent' : 'failed', pending.result ? `Sent to draft. The layer’s link couldn’t be saved: ${message}` : message);
  return true;
}
