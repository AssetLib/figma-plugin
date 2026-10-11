import type { UiMessage } from '../shared/protocol.js';

export function element<T extends HTMLElement = HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing UI element: ${id}`);
  return found as T;
}

export function post(message: UiMessage): void { parent.postMessage({ pluginMessage: message }, '*'); }
/** The status live region (visually hidden): progress, results, and every toast's words. */
export function setStatus(text: string): void { element('status').textContent = text; }
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
export function showError(message: string, action?: ErrorAction): void {
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

function keyOf(item: Element | null): string | null {
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
