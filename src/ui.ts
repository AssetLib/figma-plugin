import {
  apiUrl, aspectRatioDifference, buildDraftBody, bytesToBase64, cellOptions,
  chooseExportSettings, mapHttpError, mapNetworkError, parseDraftResponse,
  parsePlacements, tokenPrefix, validateBinding, validateConnection,
} from './shared/index.js';
import type { CellBinding, Connection, DraftResult, Placement } from './shared/index.js';
import type { MainMessage, SelectionState, UiMessage } from './shared/protocol.js';

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
let placements: Placement[] = [];
let selection: SelectionState = { node: null, reason: 'Select one node.', fileKey: null, remembered: null };
let busy = false;
let sequence = 0;
let selectionIdentity = '';
let pending: { id: number; connection: Connection; placement: Placement; bind: CellBinding; rebind: boolean } | null = null;

function post(message: UiMessage): void { parent.postMessage({ pluginMessage: message }, '*'); }
function setStatus(text: string): void { element('status').textContent = text; }
function clearError(): void { element('error').hidden = true; element('error').textContent = ''; }
function showError(message: string): void { element('error').textContent = message; element('error').hidden = false; }
function errorText(error: unknown): string { return error instanceof Error ? error.message : 'The action could not be completed.'; }
function setBusy(value: boolean): void { busy = value; render(); }
function chosenPlacement(): Placement | undefined { return placements.find(item => item.key === placementPicker.value); }
function chosenBinding(placement: Placement): CellBinding {
  return validateBinding(placement, {
    slotKey: placement.key, state: statePicker.value || null,
    appearance: (appearancePicker.value || null) as CellBinding['appearance'], arm: armPicker.value || null,
  });
}
function rememberedBinding(): { placement: Placement; bind: CellBinding } | null {
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
  const ready = Boolean(connection && node && !selection.reason && selection.fileKey && !busy);
  sendButton.disabled = !ready || !placement;
  const validArea = node && !selection.reason;
  element('export-note').textContent = placement && validArea ? exportDescription(placement) : '';
  const warning = placement && validArea ? aspectWarning(placement) : '';
  element('aspect-warning').textContent = warning;
  element('aspect-warning').hidden = !warning;
  const remembered = selection.remembered;
  const target = rememberedBinding();
  syncButton.hidden = !remembered;
  syncButton.textContent = remembered ? `Sync to ${remembered.placementKey}` : '';
  syncButton.disabled = !ready || !target;
  element('sync-note').hidden = !remembered;
  element('sync-note').textContent = !remembered ? '' : !target
    ? 'The remembered placement or cell is unavailable. Test the connection to refresh, or choose a new placement and send.'
    : `${bindingLabel(target.bind)}. Sync replaces every draft reference to the previous export of this node in this app.${validArea ? ` ${exportDescription(target.placement)}. ${aspectWarning(target.placement)}` : ''}`;
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
  clearError();
  setStatus('Testing connection…');
  setBusy(true);
  try {
    const response = await request(connection, 'placements');
    if (response.status !== 200) throw new Error(mapHttpError(response.status, response.payload));
    placements = parsePlacements(response.payload);
    placementPicker.replaceChildren(...(placements.length
      ? placements.map(item => new Option(`${item.key} · ${item.screen} · ${item.width} × ${item.height}`, item.key))
      : [new Option('No placements in this app yet', '')]));
    updateCellPickers();
    selectRemembered();
    element('connection-label').textContent = '· connected';
    settings.open = false;
    setStatus(placements.length ? `Connected. ${placements.length} placement${placements.length === 1 ? '' : 's'} available.` : 'Connected. Create a placement in the console, then test again.');
  } catch (error) {
    placements = [];
    placementPicker.replaceChildren(new Option('Test your connection to load placements', ''));
    updateCellPickers();
    element('connection-label').textContent = '· needs attention';
    settings.open = true;
    setStatus('');
    showError(errorText(error));
  } finally { setBusy(false); }
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
  if (busy || !connection || !selection.node || !selection.fileKey || selection.reason) return;
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
    setStatus('Sending PNG to the draft…');
    const body = buildDraftBody({ node: message.node, fileKey: message.fileKey, placement: operation.placement, bind: operation.bind,
      bytesBase64: bytesToBase64(new Uint8Array(message.bytes)), settings: message.settings, rebind: operation.rebind });
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

window.onmessage = (event: MessageEvent<{ pluginMessage?: MainMessage }>) => {
  if (event.source !== parent) return;
  const message = event.data?.pluginMessage;
  if (!message) return;
  switch (message.type) {
    case 'connection':
      connection = message.connection;
      token.value = '';
      if (connection) {
        origin.value = connection.origin; orgId.value = connection.orgId; appId.value = connection.appId;
        element('token-prefix').textContent = `Saved token: ${tokenPrefix(connection.token)}. Leave blank to keep it for this app.`;
      }
      element<HTMLInputElement>('file-url').value = message.savedFileUrl;
      if (connection) void loadPlacements(); else { setBusy(false); setStatus('Connect to your app to get started.'); }
      break;
    case 'selection': {
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
    case 'error':
      if (message.requestId !== undefined && message.requestId !== pending?.id) break;
      pending = null; setBusy(false); setStatus(''); showError(message.message); break;
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
post({ type: 'init' });
