import { isRecord } from './validation.js';

function consoleMessage(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const key of ['bindError', 'message', 'error']) {
    const value = payload[key];
    if (typeof value === 'string' && value.trim()) return value;
    if (isRecord(value) && typeof value.message === 'string' && value.message.trim()) return value.message;
  }
  return null;
}

export function mapHttpError(status: number, payload: unknown): string {
  if (status === 401) return 'The token was not accepted. Paste a current app-scoped draft token from the console Tokens panel.';
  if (status === 403) return 'This token does not allow drafts for this app. Create a token with the draft scope and check the organization and app ids.';
  if (status === 413) return 'The export is too large. Use a smaller export constraint or a placement with smaller canvas dimensions, then try again.';
  if (status === 409) return consoleMessage(payload) ?? 'The console could not bind this draft. Check the placement and selected cell.';
  if (status === 429) return 'The console is receiving too many requests. Wait a moment, then try again.';
  return consoleMessage(payload) ?? `The console returned HTTP ${status}. Try again or check the console.`;
}

export function mapNetworkError(origin: string): string {
  return `Could not reach ${origin}. Check the connection and that this origin is allowed by the plugin manifest.`;
}
