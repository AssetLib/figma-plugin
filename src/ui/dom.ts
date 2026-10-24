import type { DropMetadata, MainMessage, UiMessage } from '../shared/protocol.js';
import { consoleLink, isConsoleLink, type ConsoleSection } from '../shared/links.js';
import { nextRequestId, state } from './state.js';

export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}

/** Navigation follows the current app and disappears while a replacement connection is being saved. */
export function renderConsoleLink(id: string, section: ConsoleSection | null): void {
  const link = element<HTMLAnchorElement>(id);
  link.hidden = !section || !state.connection || state.connectionGeneration === null || state.connectionChanging;
  bindConsoleLink(link, link.hidden ? null : consoleLink(state.connection!, section!));
}

let consolePage: { id: number; generation: number } | null = null;
/** Keep a normal link, but open through Figma: iframe popup navigation is not reliable on every host. */
export function bindConsoleLink(link: HTMLAnchorElement, url: string | null): void {
  const generation = state.connectionGeneration;
  if (url && generation !== null && !state.connectionChanging && isConsoleLink(url, state.connection)) link.setAttribute('href', url);
  else link.removeAttribute('href');
  link.onclick = event => {
    event.preventDefault();
    if (generation === null || generation !== state.connectionGeneration || state.connectionChanging
      || link.getAttribute('href') !== url || !isConsoleLink(url, state.connection)) return;
    consolePage = { id: nextRequestId(), generation };
    post({ type: 'open-console-page', requestId: consolePage.id, connectionGeneration: generation, url });
  };
}
export function failConsolePage(id: number): boolean {
  if (consolePage?.id !== id) return false;
  const current = consolePage.generation === state.connectionGeneration;
  consolePage = null;
  if (current) showError('Figma couldn’t open this page. Try the link again.');
  return true;
}

export function post(message: UiMessage): void { parent.postMessage({ pluginMessage: message }, '*'); }
/** The modifier of Figma's shortcuts here: Cmd on Apple platforms, Ctrl elsewhere (where Ctrl+F moves the caret on a Mac). */
export const COMMAND = /Mac|iPhone|iPad/.test(navigator.platform) ? 'Cmd' : 'Ctrl';
/**
 * A row or tile dropped outside the plugin window: Figma turns `pluginDrop` into a drop event for main at that point on
 * the canvas (the coordinates are the drag's, relative to this window), carrying `dropMetadata`.
 */
export function postDrop(drop: { clientX: number; clientY: number; files: File[]; dropMetadata: DropMetadata }): void {
  parent.postMessage({ pluginDrop: drop }, '*');
}
// Main's answers to reload-connection, by request id.
const reloads = new Map<number, (adopted: boolean) => void>();
/**
 * The console refused this window's browser connection (of `generation`): another plugin window may have saved a newer
 * one on this device, ending this one, and main then makes that one this window's (its connection message comes first).
 * Resolves true when the connection changed meanwhile, so the caller drops what it would have said and offered.
 */
export async function reloadConnection(generation: number | null): Promise<boolean> {
  if (generation === null || generation !== state.connectionGeneration) return true;
  if (state.connection?.method !== 'browser') return false;
  const requestId = nextRequestId();
  const adopted = await new Promise<boolean>(resolve => { reloads.set(requestId, resolve); post({ type: 'reload-connection', requestId, connectionGeneration: generation }); });
  return adopted || generation !== state.connectionGeneration;
}
/** Main's `adopted` for a reload-connection; false when it answers another request. */
export function reloaded(message: Extract<MainMessage, { type: 'adopted' }>): boolean {
  const resolve = reloads.get(message.requestId);
  reloads.delete(message.requestId);
  resolve?.(message.adopted);
  return Boolean(resolve);
}
/** The status live region (visually hidden): progress, results, and every toast's words. */
export function setStatus(text: string): void { element('status').textContent = text; }
/** The text as a sentence: trimmed, and ending in a full stop unless it ends in other punctuation. */
export const sentence = (text: string): string => /[.!?]$/.test(text.trim()) ? text.trim() : `${text.trim()}.`;
/** The alert live region (visually hidden): every error, wherever it is shown, is announced here once. */
export function announceError(text: string): void { element('alert').textContent = text; }
/** A Figma toast for a finished operation, mirrored in the status region. */
export function toast(text: string, button?: { text: string; url: string }): void {
  setStatus(text);
  post({ type: 'notify', text, ...(button ? { button } : {}) });
}
/** The one action an error line may offer (Refresh, after an image was removed), run from its button. */
export type ErrorAction = { label: string; run: () => void };
let errorAction: ErrorAction | null = null;

export function clearError(): void {
  const error = element('error');
  const button = element('error-action');
  // A focused error or its button that hides would drop focus to the page; the next render moves it to a control instead.
  if (document.activeElement === error || document.activeElement === button) scheduleRender();
  element('error-box').hidden = true;
  error.hidden = true;
  error.textContent = '';
  button.hidden = true;
  errorAction = null;
}
/** A text field, select, or editable area: the person is typing or choosing there, so nothing else takes focus from it. */
export function inField(item: Element | null): boolean {
  const tag = item?.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || (item as HTMLElement | null)?.isContentEditable === true;
}
/**
 * Shows the error in the fixed line above the footer, where it can be seen: scrolled into view and focused. An error
 * that arrives while the person works in a field (a token, a file link, a search) never takes focus from it or scrolls
 * it out of view; the alert region announces it either way. `action` adds the one button that helps.
 */
export function showError(text: string, action?: ErrorAction): void {
  // Main's words name Figma's shortcuts as on a Mac.
  const message = text.replace(/\bCmd\+/g, `${COMMAND}+`);
  const error = element('error');
  const button = element('error-action');
  error.textContent = message;
  error.hidden = false;
  element('error-box').hidden = false;
  errorAction = action ?? null;
  button.textContent = action?.label ?? '';
  button.hidden = !action;
  announceError(message);
  error.scrollIntoView({ block: 'nearest' });
  const active = document.activeElement as HTMLElement | null;
  if (active && inField(active)) active.scrollIntoView({ block: 'nearest' });
  else error.focus({ preventScroll: true });
}
element('error-action').addEventListener('click', () => {
  const run = errorAction?.run;
  clearError();
  run?.();
});
export function errorText(error: unknown): string { return error instanceof Error ? error.message : 'The action could not be completed.'; }

/**
 * An action that can't run right now. It keeps focus and its place in the tab order (aria-disabled, not disabled),
 * so a busy plugin never drops focus to the page; its handler checks the same condition.
 */
export function setUnavailable(control: HTMLElement, unavailable: boolean): void {
  if (unavailable) control.setAttribute('aria-disabled', 'true');
  else control.removeAttribute('aria-disabled');
}
/**
 * The action this button runs is running: it says so in its label ("Inserting…"), and `aria-busy` draws a spinner and
 * keeps the ink (ui.html), so a running action never looks like an unavailable one.
 */
export function setBusy(button: HTMLElement, label: string, busy: boolean): void {
  if (button.textContent !== label) button.textContent = label;
  if (busy) button.setAttribute('aria-busy', 'true');
  else button.removeAttribute('aria-busy');
}

// ---- Keyboard ----
/**
 * The WAI-ARIA arrow keys of a tab list or a radio group: ← and → (in a radio group ↑ and ↓ too; in a tab list Home and
 * End) move to the next enabled item, wrapping, and choose it, as a click would. `rovingStops` keeps one tab stop.
 */
export function arrowKeys(container: HTMLElement, items: readonly HTMLButtonElement[], kind: 'tabs' | 'radios'): void {
  const steps: Record<string, number> = kind === 'tabs' ? { ArrowLeft: -1, ArrowRight: 1 } : { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -1, ArrowDown: 1 };
  container.addEventListener('keydown', event => {
    if (event.altKey || event.ctrlKey || event.metaKey) return;
    const enabled = items.filter(item => !item.disabled && !item.hidden);
    const index = enabled.indexOf(event.target as HTMLButtonElement);
    const step = steps[event.key];
    const next = index < 0 ? undefined : step ? enabled[(index + step + enabled.length) % enabled.length]
      : kind === 'tabs' && event.key === 'Home' ? enabled[0] : kind === 'tabs' && event.key === 'End' ? enabled[enabled.length - 1] : undefined;
    if (!next) return;
    event.preventDefault();
    next.focus();
    next.click();
  });
}
/** One tab stop per tab list or radio group: the chosen item (aria-selected or aria-checked), else the first enabled one. */
export function rovingStops(items: readonly HTMLButtonElement[]): void {
  const chosen = (item: HTMLButtonElement) => item.getAttribute('aria-checked') === 'true' || item.getAttribute('aria-selected') === 'true';
  const stop = items.find(item => chosen(item) && !item.disabled) ?? items.find(item => !item.disabled);
  for (const item of items) item.setAttribute('tabindex', item === stop ? '0' : '-1');
}

// ---- Rendering ----
// State changes ask for a render; one runs per animation frame however many asked. A list rebuild is asked for separately.
type Renderer = {
  render: () => void;
  renderList: () => void;
  // The rebuilt row or tile with this data-key or data-asset-id.
  twin: (key: string) => HTMLElement | null;
  // Where focus goes when the focused control disappears and has no twin.
  fallback: () => HTMLElement | null;
};
let renderer: Renderer | null = null;
let pending = false;
let frameId = 0;
let listDirty = false;
// A row or tile to focus if the focused control disappears in the next render (the first new image after Load more).
let preferredKey: string | null = null;

export function setRenderer(next: Renderer): void { renderer = next; }

export function scheduleRender(list = false): void {
  if (list) listDirty = true;
  if (pending) return;
  pending = true;
  frameId = requestAnimationFrame(runFrame);
}

/** Renders now, for code that must measure or scroll the result in the same task. */
export function flushRender(): void {
  if (!pending) return;
  cancelAnimationFrame(frameId);
  runFrame();
}

export function preferFocus(key: string): void { preferredKey = key; }

/** A row's placement key or a tile's asset id. */
export function keyOf(item: Element | null): string | null {
  return item?.getAttribute('data-key') ?? item?.getAttribute('data-asset-id') ?? null;
}

function usable(item: HTMLElement): boolean {
  if (item.isConnected === false || item.hidden || (item as HTMLButtonElement).disabled) return false;
  // Inside a hidden region or a closed <details>: checkVisibility sees both, client rects only the first.
  if (typeof item.checkVisibility === 'function') return item.checkVisibility();
  return typeof item.getClientRects !== 'function' || item.getClientRects().length > 0;
}

function runFrame(): void {
  if (!pending || !renderer) return;
  pending = false;
  const list = listDirty;
  listDirty = false;
  const active = document.activeElement as HTMLElement | null;
  const key = keyOf(active);
  if (list) renderer.renderList();
  renderer.render();
  const preferred = preferredKey;
  preferredKey = null;
  // Focus stays where it was. If the render removed, hid, or disabled it, it moves to the rebuilt row, else nearby.
  if (!active || active === document.body || active === document.documentElement) return;
  const now = document.activeElement as HTMLElement | null;
  if (now !== active && now && now !== document.body) return;
  if (now === active && usable(active)) return;
  const next = (key ? renderer.twin(key) : null) ?? (preferred ? renderer.twin(preferred) : null) ?? renderer.fallback();
  if (next && next !== active) next.focus({ preventScroll: true });
}
